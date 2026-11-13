// Persistence for players, daily plays and leaderboards.
// Uses Upstash Redis (provisioned through the Vercel Marketplace) when its env vars are present.
// Without them, an in-memory store is used for local development and tests only.
import { Redis } from '@upstash/redis';
import type { HelperId } from '@/game/rules';

export type PlayStatus = 'playing' | 'won' | 'lost';
/** `destroyed`: ids of asteroids this player blew up today with the energized laser. */
export type Play = { shots: string[]; helpers: HelperId[]; status: PlayStatus; score: number; destroyed: number[] };
export type BoardEntry = { rank: number; name: string; score: number; games: number; best: number; you: boolean };
export type Streak = { current: number; best: number };

export interface Store {
  getName(pid: string): Promise<string | null>;
  setName(pid: string, name: string): Promise<void>;
  /** Reserves `name` (case-insensitive) for `pid`. False if another player already has it. */
  claimName(pid: string, name: string): Promise<boolean>;
  /** Frees `name` if `pid` holds it. */
  releaseName(pid: string, name: string): Promise<void>;
  getPlay(day: string, pid: string): Promise<Play>;
  addHelper(day: string, pid: string, helper: HelperId): Promise<HelperId[]>;
  addDestroyed(day: string, pid: string, rocks: number[]): Promise<void>;
  /** Atomically reserves the next shot. Returns the 1-based shot number. */
  reserveShot(day: string, pid: string): Promise<number>;
  recordShot(day: string, pid: string, shot: number, result: string): Promise<void>;
  /** Finishes the day once. Returns false if it was already finished. */
  finish(day: string, pid: string, status: 'won' | 'lost', score: number): Promise<boolean>;
  /** The top 10, plus the block of 10 around `pid` when they rank lower (see `windowStart`). */
  board(scope: 'day' | 'all', day: string, pid: string | null): Promise<{ top: BoardEntry[]; around: BoardEntry[]; me: BoardEntry | null; players: number }>;
  getStreak(pid: string, day: string): Promise<Streak>;
  getCached(key: string): Promise<string | null>;
  setCached(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export const nameKey = (name: string) => name.normalize('NFKC').toLowerCase();

export function prevDay(day: string): string {
  return new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
}

type StreakRow = { current: number; best: number; last: string };
/** Streak = consecutive days with the beacon lit. A loss resets it; a skipped day breaks it. */
export function nextStreak(prev: StreakRow | null, day: string, won: boolean): StreakRow {
  const best = prev?.best ?? 0;
  if (!won) return { current: 0, best, last: day };
  const current = prev && prev.last === prevDay(day) ? prev.current + 1 : 1;
  return { current, best: Math.max(best, current), last: day };
}
/** The streak as it stands on `day`: still alive if the last win was today or yesterday. */
export function liveStreak(row: StreakRow | null, day: string): Streak {
  if (!row) return { current: 0, best: 0 };
  const alive = row.last === day || row.last === prevDay(day);
  return { current: alive ? row.current : 0, best: row.best };
}

const DAY_TTL = 60 * 60 * 24 * 90;
// Preview deployments share the production database, so they keep their data under their own
// prefix: testing a preview link never adds players or scores to the live leaderboard.
const NS = process.env.VERCEL_ENV === 'preview' ? 'orbit-preview' : 'orbit';
const k = {
  name: (pid: string) => `${NS}:player:${pid}:name`,
  play: (day: string, pid: string) => `${NS}:play:${day}:${pid}`,
  shots: (day: string, pid: string) => `${NS}:shots:${day}:${pid}`,
  done: (day: string, pid: string) => `${NS}:done:${day}:${pid}`,
  dayBoard: (day: string) => `${NS}:lb:day:${day}`,
  allBoard: `${NS}:lb:all`,
  games: `${NS}:lb:games`,
  best: `${NS}:lb:best`,
  streak: (pid: string) => `${NS}:player:${pid}:streak`,
  names: `${NS}:names`,
  cache: (key: string) => `${NS}:cache:${key}`,
};

class RedisStore implements Store {
  constructor(private r: Redis) {}
  async getName(pid: string) {
    return (await this.r.get<string>(k.name(pid))) ?? null;
  }
  async setName(pid: string, name: string) {
    await this.r.set(k.name(pid), name);
  }
  async claimName(pid: string, name: string) {
    const key = nameKey(name);
    await this.r.hsetnx(k.names, key, pid);
    return (await this.r.hget<string>(k.names, key)) === pid;
  }
  async releaseName(pid: string, name: string) {
    const key = nameKey(name);
    if ((await this.r.hget<string>(k.names, key)) === pid) await this.r.hdel(k.names, key);
  }
  async getPlay(day: string, pid: string): Promise<Play> {
    const h = await this.r.hgetall<Record<string, unknown>>(k.play(day, pid));
    const shots: string[] = [];
    for (let i = 1; i <= 3; i++) if (h?.[`shot${i}`]) shots.push(String(h[`shot${i}`]));
    const helpers = String(h?.helpers ?? '').split(',').filter(Boolean) as HelperId[];
    const destroyed = String(h?.destroyed ?? '').split(',').filter(Boolean).map(Number);
    return { shots, helpers, status: (h?.status as PlayStatus) ?? 'playing', score: Number(h?.score ?? 0), destroyed };
  }
  async addHelper(day: string, pid: string, helper: HelperId) {
    const play = await this.getPlay(day, pid);
    if (!play.helpers.includes(helper)) {
      play.helpers.push(helper);
      await this.r.hset(k.play(day, pid), { helpers: play.helpers.join(',') });
      await this.r.expire(k.play(day, pid), DAY_TTL);
    }
    return play.helpers;
  }
  async addDestroyed(day: string, pid: string, rocks: number[]) {
    const play = await this.getPlay(day, pid);
    const all = [...new Set([...play.destroyed, ...rocks])];
    await this.r.hset(k.play(day, pid), { destroyed: all.join(',') });
    await this.r.expire(k.play(day, pid), DAY_TTL);
  }
  async reserveShot(day: string, pid: string) {
    const n = await this.r.incr(k.shots(day, pid));
    if (n === 1) await this.r.expire(k.shots(day, pid), DAY_TTL);
    return n;
  }
  async recordShot(day: string, pid: string, shot: number, result: string) {
    await this.r.hset(k.play(day, pid), { [`shot${shot}`]: result });
    await this.r.expire(k.play(day, pid), DAY_TTL);
  }
  async finish(day: string, pid: string, status: 'won' | 'lost', score: number) {
    const first = await this.r.set(k.done(day, pid), 1, { nx: true, ex: DAY_TTL });
    if (first !== 'OK') return false;
    await this.r.hset(k.play(day, pid), { status, score });
    const prev = await this.streakRow(pid);
    const st = nextStreak(prev, day, status === 'won');
    const p = this.r.pipeline();
    p.hset(k.streak(pid), st);
    p.hset(k.best, { [pid]: st.best });
    p.zadd(k.dayBoard(day), { score, member: pid });
    p.expire(k.dayBoard(day), DAY_TTL);
    p.zincrby(k.allBoard, score, pid);
    p.hincrby(k.games, pid, 1);
    await p.exec();
    return true;
  }
  private async streakRow(pid: string): Promise<StreakRow | null> {
    const h = await this.r.hgetall<Record<string, unknown>>(k.streak(pid));
    return h && h.last ? { current: Number(h.current ?? 0), best: Number(h.best ?? 0), last: String(h.last) } : null;
  }
  async getStreak(pid: string, day: string) {
    return liveStreak(await this.streakRow(pid), day);
  }
  async getCached(key: string) {
    const v = await this.r.get<unknown>(k.cache(key));
    if (v === null || v === undefined) return null;
    return typeof v === 'string' ? v : JSON.stringify(v); // the client may auto-parse JSON
  }
  async setCached(key: string, value: string, ttlSeconds: number) {
    await this.r.set(k.cache(key), value, { ex: ttlSeconds });
  }
  async board(scope: 'day' | 'all', day: string, pid: string | null) {
    const key = scope === 'day' ? k.dayBoard(day) : k.allBoard;
    const [rawTop, players, myIdx] = await Promise.all([
      this.r.zrange<(string | number)[]>(key, 0, TOP - 1, { rev: true, withScores: true }),
      this.r.zcard(key),
      pid ? this.r.zrevrank(key, pid) : Promise.resolve(null),
    ]);
    const from = myIdx === null ? null : windowStart(myIdx + 1);
    const rawAround = from === null ? [] : await this.r.zrange<(string | number)[]>(key, from - 1, from + WINDOW - 2, { rev: true, withScores: true });
    const pairs = (raw: (string | number)[]) => {
      const out: { pid: string; score: number }[] = [];
      for (let i = 0; i < raw.length; i += 2) out.push({ pid: String(raw[i]), score: Number(raw[i + 1]) });
      return out;
    };
    const topRows = pairs(rawTop);
    const aroundRows = pairs(rawAround);
    const ids = [...topRows, ...aroundRows].map((r) => r.pid);
    let names: (string | null)[] = [];
    let games: Record<string, unknown> | null = null;
    let bests: Record<string, unknown> | null = null;
    if (ids.length) {
      [names, games, bests] = await Promise.all([
        this.r.mget<(string | null)[]>(...ids.map(k.name)),
        this.r.hmget<Record<string, unknown>>(k.games, ...ids),
        this.r.hmget<Record<string, unknown>>(k.best, ...ids),
      ]);
    }
    const entry = (id: string, score: number, idx: number): BoardEntry => ({
      rank: 0, name: names[idx] ?? 'Unknown pilot', score, games: Number(games?.[id] ?? 0), best: Number(bests?.[id] ?? 0), you: id === pid,
    });
    const top = rankEntries(topRows.map((r, i) => entry(r.pid, r.score, i)));
    // the window is ranked on its own, then shifted to its real place on the board
    const around = rankEntries(aroundRows.map((r, i) => entry(r.pid, r.score, topRows.length + i)))
      .map((e) => ({ ...e, rank: e.rank + (from ?? 1) - 1 }));
    const me = [...top, ...around].find((e) => e.you) ?? null;
    return { top, around, me, players };
  }
}

/** The board shows the top 10, then the block of 10 holding your rank (rank 508 shows 501 to 510). */
export const TOP = 10;
export const WINDOW = 10;
/** First rank of the block shown under the top 10 for a pilot at `rank`, or null if they are already in the top 10. */
export function windowStart(rank: number): number | null {
  if (rank <= TOP) return null;
  return Math.floor((rank - 1) / WINDOW) * WINDOW + 1;
}

/**
 * Every pilot gets their own place (1, 2, 3, 4), never a shared one.
 * Ties on points go to the pilot with fewer games played (same points in fewer games), then by name.
 */
export function rankEntries(entries: BoardEntry[]): BoardEntry[] {
  return [...entries]
    .sort((a, b) => b.score - a.score || a.games - b.games || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

export class MemoryStore implements Store {
  names = new Map<string, string>();
  plays = new Map<string, Play>();
  shotCounters = new Map<string, number>();
  done = new Set<string>();
  dayBoards = new Map<string, Map<string, number>>();
  allBoard = new Map<string, number>();
  games = new Map<string, number>();
  streaks = new Map<string, StreakRow>();
  cache = new Map<string, string>();
  async getStreak(pid: string, day: string) { return liveStreak(this.streaks.get(pid) ?? null, day); }
  async getCached(key: string) { return this.cache.get(key) ?? null; }
  async setCached(key: string, value: string) { this.cache.set(key, value); }
  async getName(pid: string) { return this.names.get(pid) ?? null; }
  async setName(pid: string, name: string) { this.names.set(pid, name); }
  claimed = new Map<string, string>();
  async claimName(pid: string, name: string) {
    const key = nameKey(name);
    if (!this.claimed.has(key)) this.claimed.set(key, pid);
    return this.claimed.get(key) === pid;
  }
  async releaseName(pid: string, name: string) {
    const key = nameKey(name);
    if (this.claimed.get(key) === pid) this.claimed.delete(key);
  }
  private play(day: string, pid: string) {
    const key = `${day}:${pid}`;
    let p = this.plays.get(key);
    if (!p) { p = { shots: [], helpers: [], status: 'playing', score: 0, destroyed: [] }; this.plays.set(key, p); }
    return p;
  }
  async getPlay(day: string, pid: string) { const p = this.play(day, pid); return { ...p, shots: [...p.shots], helpers: [...p.helpers], destroyed: [...p.destroyed] }; }
  async addDestroyed(day: string, pid: string, rocks: number[]) {
    const p = this.play(day, pid);
    p.destroyed = [...new Set([...p.destroyed, ...rocks])];
  }
  async addHelper(day: string, pid: string, helper: HelperId) {
    const p = this.play(day, pid);
    if (!p.helpers.includes(helper)) p.helpers.push(helper);
    return [...p.helpers];
  }
  async reserveShot(day: string, pid: string) {
    const key = `${day}:${pid}`;
    const n = (this.shotCounters.get(key) ?? 0) + 1;
    this.shotCounters.set(key, n);
    return n;
  }
  async recordShot(day: string, pid: string, shot: number, result: string) { this.play(day, pid).shots[shot - 1] = result; }
  async finish(day: string, pid: string, status: 'won' | 'lost', score: number) {
    const key = `${day}:${pid}`;
    if (this.done.has(key)) return false;
    this.done.add(key);
    Object.assign(this.play(day, pid), { status, score });
    if (!this.dayBoards.has(day)) this.dayBoards.set(day, new Map());
    this.dayBoards.get(day)!.set(pid, score);
    this.allBoard.set(pid, (this.allBoard.get(pid) ?? 0) + score);
    this.games.set(pid, (this.games.get(pid) ?? 0) + 1);
    this.streaks.set(pid, nextStreak(this.streaks.get(pid) ?? null, day, status === 'won'));
    return true;
  }
  async board(scope: 'day' | 'all', day: string, pid: string | null) {
    const m = scope === 'day' ? this.dayBoards.get(day) ?? new Map<string, number>() : this.allBoard;
    const ranked = rankEntries([...m.entries()].map(([id, score]): BoardEntry => ({
      rank: 0, name: this.names.get(id) ?? 'Unknown pilot', score, games: this.games.get(id) ?? 0, best: this.streaks.get(id)?.best ?? 0, you: id === pid,
    })));
    const me = ranked.find((e) => e.you) ?? null;
    const from = me ? windowStart(me.rank) : null;
    const around = from === null ? [] : ranked.slice(from - 1, from - 1 + WINDOW);
    return { top: ranked.slice(0, TOP), around, me, players: ranked.length };
  }
}

let store: Store | null = null;
export function getStore(): Store {
  if (store) return store;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    store = new RedisStore(new Redis({ url, token }));
  } else {
    if (process.env.VERCEL_ENV === 'production') {
      throw new Error('Leaderboard database is not configured: add the Upstash Redis integration to this Vercel project.');
    }
    console.warn('[orbit] No Redis env vars found, using the in-memory store (data resets on restart).');
    store = new MemoryStore();
  }
  return store;
}
export function setStoreForTests(s: Store) { store = s; }
