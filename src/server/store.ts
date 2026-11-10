// Persistence for players, daily plays and leaderboards.
// Uses Upstash Redis (provisioned through the Vercel Marketplace) when its env vars are present.
// Without them, an in-memory store is used for local development and tests only.
import { Redis } from '@upstash/redis';
import type { HelperId } from '@/game/rules';

export type PlayStatus = 'playing' | 'won' | 'lost';
export type Play = { shots: string[]; helpers: HelperId[]; status: PlayStatus; score: number };
export type BoardEntry = { rank: number; name: string; score: number; games: number; you: boolean };

export interface Store {
  getName(pid: string): Promise<string | null>;
  setName(pid: string, name: string): Promise<void>;
  getPlay(day: string, pid: string): Promise<Play>;
  addHelper(day: string, pid: string, helper: HelperId): Promise<HelperId[]>;
  /** Atomically reserves the next shot. Returns the 1-based shot number. */
  reserveShot(day: string, pid: string): Promise<number>;
  recordShot(day: string, pid: string, shot: number, result: string): Promise<void>;
  /** Finishes the day once. Returns false if it was already finished. */
  finish(day: string, pid: string, status: 'won' | 'lost', score: number): Promise<boolean>;
  board(scope: 'day' | 'all', day: string, pid: string | null, limit?: number): Promise<{ top: BoardEntry[]; me: BoardEntry | null; players: number }>;
}

const DAY_TTL = 60 * 60 * 24 * 90;
const k = {
  name: (pid: string) => `orbit:player:${pid}:name`,
  play: (day: string, pid: string) => `orbit:play:${day}:${pid}`,
  shots: (day: string, pid: string) => `orbit:shots:${day}:${pid}`,
  done: (day: string, pid: string) => `orbit:done:${day}:${pid}`,
  dayBoard: (day: string) => `orbit:lb:day:${day}`,
  allBoard: 'orbit:lb:all',
  games: 'orbit:lb:games',
};

class RedisStore implements Store {
  constructor(private r: Redis) {}
  async getName(pid: string) {
    return (await this.r.get<string>(k.name(pid))) ?? null;
  }
  async setName(pid: string, name: string) {
    await this.r.set(k.name(pid), name);
  }
  async getPlay(day: string, pid: string): Promise<Play> {
    const h = await this.r.hgetall<Record<string, unknown>>(k.play(day, pid));
    const shots: string[] = [];
    for (let i = 1; i <= 3; i++) if (h?.[`shot${i}`]) shots.push(String(h[`shot${i}`]));
    const helpers = String(h?.helpers ?? '').split(',').filter(Boolean) as HelperId[];
    return { shots, helpers, status: (h?.status as PlayStatus) ?? 'playing', score: Number(h?.score ?? 0) };
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
    const p = this.r.pipeline();
    p.zadd(k.dayBoard(day), { score, member: pid });
    p.expire(k.dayBoard(day), DAY_TTL);
    p.zincrby(k.allBoard, score, pid);
    p.hincrby(k.games, pid, 1);
    await p.exec();
    return true;
  }
  async board(scope: 'day' | 'all', day: string, pid: string | null, limit = 50) {
    const key = scope === 'day' ? k.dayBoard(day) : k.allBoard;
    const [raw, players] = await Promise.all([
      this.r.zrange<(string | number)[]>(key, 0, limit - 1, { rev: true, withScores: true }),
      this.r.zcard(key),
    ]);
    const rows: { pid: string; score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) rows.push({ pid: String(raw[i]), score: Number(raw[i + 1]) });
    let me: BoardEntry | null = null;
    let myRow: { pid: string; score: number; rank: number } | null = null;
    if (pid && !rows.some((r) => r.pid === pid)) {
      const [rank, score] = await Promise.all([this.r.zrevrank(key, pid), this.r.zscore(key, pid)]);
      if (rank !== null && score !== null) myRow = { pid, score: Number(score), rank: rank + 1 };
    }
    const ids = [...rows.map((r) => r.pid), ...(myRow ? [myRow.pid] : [])];
    let names: (string | null)[] = [];
    let games: Record<string, unknown> | null = null;
    if (ids.length) {
      [names, games] = await Promise.all([this.r.mget<(string | null)[]>(...ids.map(k.name)), this.r.hmget<Record<string, unknown>>(k.games, ...ids)]);
    }
    const entry = (id: string, score: number, rank: number, idx: number): BoardEntry => ({
      rank, name: names[idx] ?? 'Unknown pilot', score, games: Number(games?.[id] ?? 0), you: id === pid,
    });
    const top = rankRows(rows).map((r, i) => entry(r.pid, r.score, r.rank, i));
    if (myRow) me = entry(myRow.pid, myRow.score, myRow.rank, ids.length - 1);
    else me = top.find((t) => t.you) ?? null;
    return { top, me, players };
  }
}

/** Standard competition ranking: equal scores share a rank (1, 2, 2, 4). */
function rankRows<T extends { score: number }>(rows: T[]): (T & { rank: number })[] {
  return rows.map((r, i) => {
    let rank = i + 1;
    while (rank > 1 && rows[rank - 2].score === r.score) rank--;
    return { ...r, rank };
  });
}

export class MemoryStore implements Store {
  names = new Map<string, string>();
  plays = new Map<string, Play>();
  shotCounters = new Map<string, number>();
  done = new Set<string>();
  dayBoards = new Map<string, Map<string, number>>();
  allBoard = new Map<string, number>();
  games = new Map<string, number>();
  async getName(pid: string) { return this.names.get(pid) ?? null; }
  async setName(pid: string, name: string) { this.names.set(pid, name); }
  private play(day: string, pid: string) {
    const key = `${day}:${pid}`;
    let p = this.plays.get(key);
    if (!p) { p = { shots: [], helpers: [], status: 'playing', score: 0 }; this.plays.set(key, p); }
    return p;
  }
  async getPlay(day: string, pid: string) { const p = this.play(day, pid); return { ...p, shots: [...p.shots], helpers: [...p.helpers] }; }
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
    return true;
  }
  async board(scope: 'day' | 'all', day: string, pid: string | null, limit = 50) {
    const m = scope === 'day' ? this.dayBoards.get(day) ?? new Map<string, number>() : this.allBoard;
    const sorted = rankRows([...m.entries()].map(([id, score]) => ({ pid: id, score })).sort((a, b) => b.score - a.score || (a.pid < b.pid ? 1 : -1)));
    const toEntry = (r: { pid: string; score: number; rank: number }): BoardEntry => ({
      rank: r.rank, name: this.names.get(r.pid) ?? 'Unknown pilot', score: r.score, games: this.games.get(r.pid) ?? 0, you: r.pid === pid,
    });
    const mine = sorted.find((r) => r.pid === pid);
    return { top: sorted.slice(0, limit).map(toEntry), me: mine ? toEntry(mine) : null, players: sorted.length };
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
