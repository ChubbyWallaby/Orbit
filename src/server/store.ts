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
/** Server-only facts about a play, kept out of `Play` so they are never sent to the browser. */
export type ShotMeta = { seen: number | null; lastT: number | null };
/** A finished day in a player's history. */
export type DayResult = { status: 'won' | 'lost'; score: number };
/** Voyage progress: the highest level open, best stars per level, and the shots of the attempt in progress. */
/** `seen`: when the player first opened level `n`; `attempt.lastT`: the orbit time of its last shot. */
export type VoyageRow = { unlocked: number; stars: Record<number, number>; attempt: { n: number; shots: string[]; lastT?: number }; seen?: { n: number; ms: number } };
export type BoardScope = 'day' | 'all' | 'voyage';
/**
 * The Voyage board ranks by total stars, then by levels cleared, packed into one sorted-set score.
 * On that board a `BoardEntry`'s `score` is the stars and `games` the levels cleared.
 */
export const VOYAGE_SCALE = 100_000;
export const voyageBoardScore = (stars: number, cleared: number) => stars * VOYAGE_SCALE + Math.min(cleared, VOYAGE_SCALE - 1);
export const newVoyage = (): VoyageRow => ({ unlocked: 1, stars: {}, attempt: { n: 1, shots: [] } });

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
  /** `t` is the orbit time the shot was traced at, so the same frozen moment can be fired again. */
  recordShot(day: string, pid: string, shot: number, result: string, t?: number): Promise<void>;
  /** Remembers when this player first saw today's board (only the first call counts). */
  markSeen(day: string, pid: string, ms: number): Promise<void>;
  getShotMeta(day: string, pid: string): Promise<ShotMeta>;
  /**
   * Finishes the day once. Returns false if it was already finished. Only `ranked` games (today's
   * puzzle) count for the leaderboards and the streak; archive games are only kept in the history.
   */
  finish(day: string, pid: string, status: 'won' | 'lost', score: number, ranked?: boolean): Promise<boolean>;
  /** The player's finished days among `days`. */
  getHistory(pid: string, days: string[]): Promise<Record<string, DayResult>>;
  getVoyage(pid: string): Promise<VoyageRow>;
  setVoyage(pid: string, row: VoyageRow): Promise<void>;
  /** Puts a named pilot's Voyage progress on the Voyage board. */
  setVoyageScore(pid: string, stars: number, cleared: number): Promise<void>;
  /** The top 10, plus the block of 10 around `pid` when they rank lower (see `windowStart`). */
  board(scope: BoardScope, day: string, pid: string | null): Promise<{ top: BoardEntry[]; around: BoardEntry[]; me: BoardEntry | null; players: number }>;
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

// plays are kept for over a year, so past days stay marked as played in the archive
const DAY_TTL = 60 * 60 * 24 * 400;
/** Days finished before this were played before the history existed; their results are read from the plays once. */
const HISTORY_SINCE = '2026-11-24';
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
  voyageBoard: `${NS}:lb:voyage`,
  games: `${NS}:lb:games`,
  best: `${NS}:lb:best`,
  streak: (pid: string) => `${NS}:player:${pid}:streak`,
  history: (pid: string) => `${NS}:player:${pid}:history`,
  voyage: (pid: string) => `${NS}:player:${pid}:voyage`,
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
  async recordShot(day: string, pid: string, shot: number, result: string, t?: number) {
    await this.r.hset(k.play(day, pid), { [`shot${shot}`]: result, ...(t === undefined ? {} : { lastT: t }) });
    await this.r.expire(k.play(day, pid), DAY_TTL);
  }
  async markSeen(day: string, pid: string, ms: number) {
    if (await this.r.hsetnx(k.play(day, pid), 'seen', ms)) await this.r.expire(k.play(day, pid), DAY_TTL);
  }
  async getShotMeta(day: string, pid: string): Promise<ShotMeta> {
    const [seen, lastT] = await this.r.hmget<Record<string, unknown>>(k.play(day, pid), 'seen', 'lastT').then((h) => [h?.seen, h?.lastT]);
    const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
    return { seen: num(seen), lastT: num(lastT) };
  }
  async finish(day: string, pid: string, status: 'won' | 'lost', score: number, ranked = true) {
    const first = await this.r.set(k.done(day, pid), 1, { nx: true, ex: DAY_TTL });
    if (first !== 'OK') return false;
    await this.r.hset(k.play(day, pid), { status, score });
    await this.r.hset(k.history(pid), { [day]: `${status}:${score}` });
    if (!ranked) return true;
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
  async getHistory(pid: string, days: string[]) {
    const h = (await this.r.hgetall<Record<string, unknown>>(k.history(pid))) ?? {};
    const out: Record<string, DayResult> = {};
    for (const day of days) if (h[day]) out[day] = parseResult(String(h[day]));
    // days from before the history existed: look at the plays themselves, once
    const old = days.filter((d) => d < HISTORY_SINCE && !h[d]);
    if (old.length) {
      const p = this.r.pipeline();
      for (const d of old) p.hgetall(k.play(d, pid));
      const plays = (await p.exec()) as (Record<string, unknown> | null)[];
      const found: Record<string, string> = {};
      old.forEach((d, i) => {
        const st = plays[i]?.status;
        if (st === 'won' || st === 'lost') { found[d] = `${st}:${Number(plays[i]?.score ?? 0)}`; out[d] = parseResult(found[d]); }
      });
      if (Object.keys(found).length) await this.r.hset(k.history(pid), found);
    }
    return out;
  }
  async getVoyage(pid: string) {
    const v = await this.r.get<unknown>(k.voyage(pid));
    if (!v) return newVoyage();
    return { ...newVoyage(), ...(typeof v === 'string' ? JSON.parse(v) : v) } as VoyageRow;
  }
  async setVoyage(pid: string, row: VoyageRow) {
    await this.r.set(k.voyage(pid), JSON.stringify(row));
  }
  async setVoyageScore(pid: string, stars: number, cleared: number) {
    await this.r.zadd(k.voyageBoard, { score: voyageBoardScore(stars, cleared), member: pid });
  }
  async getCached(key: string) {
    const v = await this.r.get<unknown>(k.cache(key));
    if (v === null || v === undefined) return null;
    return typeof v === 'string' ? v : JSON.stringify(v); // the client may auto-parse JSON
  }
  async setCached(key: string, value: string, ttlSeconds: number) {
    await this.r.set(k.cache(key), value, { ex: ttlSeconds });
  }
  async board(scope: BoardScope, day: string, pid: string | null) {
    const voyage = scope === 'voyage';
    const key = scope === 'day' ? k.dayBoard(day) : voyage ? k.voyageBoard : k.allBoard;
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
    if (ids.length && voyage) names = await this.r.mget<(string | null)[]>(...ids.map(k.name));
    else if (ids.length) {
      [names, games, bests] = await Promise.all([
        this.r.mget<(string | null)[]>(...ids.map(k.name)),
        this.r.hmget<Record<string, unknown>>(k.games, ...ids),
        this.r.hmget<Record<string, unknown>>(k.best, ...ids),
      ]);
    }
    const entry = (id: string, score: number, idx: number): BoardEntry => voyage
      ? { ...voyageEntry(score), rank: 0, name: names[idx] ?? 'Unknown pilot', you: id === pid }
      : { rank: 0, name: names[idx] ?? 'Unknown pilot', score, games: Number(games?.[id] ?? 0), best: Number(bests?.[id] ?? 0), you: id === pid };
    const top = rankEntries(topRows.map((r, i) => entry(r.pid, r.score, i)), voyage);
    // the window is ranked on its own, then shifted to its real place on the board
    const around = rankEntries(aroundRows.map((r, i) => entry(r.pid, r.score, topRows.length + i)), voyage)
      .map((e) => ({ ...e, rank: e.rank + (from ?? 1) - 1 }));
    const me = [...top, ...around].find((e) => e.you) ?? null;
    return { top, around, me, players };
  }
}

const parseResult = (v: string): DayResult => {
  const [status, score] = v.split(':');
  return { status: status === 'won' ? 'won' : 'lost', score: Number(score) || 0 };
};

const voyageEntry = (packed: number) => ({ score: Math.floor(packed / VOYAGE_SCALE), games: packed % VOYAGE_SCALE, best: 0 });

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
export function rankEntries(entries: BoardEntry[], moreGamesFirst = false): BoardEntry[] {
  // on the Voyage board `games` is levels cleared, so more is better there
  return [...entries]
    .sort((a, b) => b.score - a.score || (moreGamesFirst ? b.games - a.games : a.games - b.games) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
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
  meta = new Map<string, ShotMeta>();
  private metaFor(day: string, pid: string) {
    const key = `${day}:${pid}`;
    let m = this.meta.get(key);
    if (!m) { m = { seen: null, lastT: null }; this.meta.set(key, m); }
    return m;
  }
  async recordShot(day: string, pid: string, shot: number, result: string, t?: number) {
    this.play(day, pid).shots[shot - 1] = result;
    if (t !== undefined) this.metaFor(day, pid).lastT = t;
  }
  async markSeen(day: string, pid: string, ms: number) { const m = this.metaFor(day, pid); m.seen ??= ms; }
  async getShotMeta(day: string, pid: string) { return { ...this.metaFor(day, pid) }; }
  async finish(day: string, pid: string, status: 'won' | 'lost', score: number, ranked = true) {
    const key = `${day}:${pid}`;
    if (this.done.has(key)) return false;
    this.done.add(key);
    Object.assign(this.play(day, pid), { status, score });
    if (!ranked) return true;
    if (!this.dayBoards.has(day)) this.dayBoards.set(day, new Map());
    this.dayBoards.get(day)!.set(pid, score);
    this.allBoard.set(pid, (this.allBoard.get(pid) ?? 0) + score);
    this.games.set(pid, (this.games.get(pid) ?? 0) + 1);
    this.streaks.set(pid, nextStreak(this.streaks.get(pid) ?? null, day, status === 'won'));
    return true;
  }
  async getHistory(pid: string, days: string[]) {
    const out: Record<string, DayResult> = {};
    for (const day of days) {
      const p = this.plays.get(`${day}:${pid}`);
      if (p && p.status !== 'playing') out[day] = { status: p.status, score: p.score };
    }
    return out;
  }
  voyages = new Map<string, VoyageRow>();
  async getVoyage(pid: string) { return structuredClone(this.voyages.get(pid) ?? newVoyage()); }
  async setVoyage(pid: string, row: VoyageRow) { this.voyages.set(pid, structuredClone(row)); }
  voyageBoard = new Map<string, number>();
  async setVoyageScore(pid: string, stars: number, cleared: number) { this.voyageBoard.set(pid, voyageBoardScore(stars, cleared)); }
  async board(scope: BoardScope, day: string, pid: string | null) {
    const voyage = scope === 'voyage';
    const m = scope === 'day' ? this.dayBoards.get(day) ?? new Map<string, number>() : voyage ? this.voyageBoard : this.allBoard;
    const ranked = rankEntries([...m.entries()].map(([id, score]): BoardEntry => voyage
      ? { ...voyageEntry(score), rank: 0, name: this.names.get(id) ?? 'Unknown pilot', you: id === pid }
      : { rank: 0, name: this.names.get(id) ?? 'Unknown pilot', score, games: this.games.get(id) ?? 0, best: this.streaks.get(id)?.best ?? 0, you: id === pid }), voyage);
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
