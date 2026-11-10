// Server-side game service. All score-affecting decisions happen here.
import { constrainMoon, trace, SATELLITE_RADIUS, type Level, type Placement, type Vec } from '@/game/engine';
import { generateLevel, type Generated } from '@/game/generate';
import { HELPERS, MAX_SHOTS, scoreFor, utcDay, type HelperId } from '@/game/rules';
import { getStore, type Play, type Streak } from './store';

/** Today's UTC day. Outside production, ORBIT_DAY=YYYY-MM-DD lets you play any day for testing. */
export function currentDay(): string {
  const o = process.env.ORBIT_DAY;
  if (o && process.env.VERCEL_ENV !== 'production' && /^\d{4}-\d{2}-\d{2}$/.test(o)) return o;
  return utcDay();
}

export class GameError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export type Me = { name: string | null; play: Play; streak: Streak };
export type TodayPayload = { level: Level; me: Me; ghost: GhostHint | null };
export type GhostHint = { x: number; z: number; radius: number };

export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') throw new GameError('Enter a pilot name.');
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 16) throw new GameError('Pilot names need 2 to 16 characters.');
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(name)) throw new GameError('Use letters, numbers, spaces, dots, dashes or underscores.');
  return name;
}

// Each day's level is generated once, then cached in memory and in the store (generation can take seconds).
const memo = new Map<string, Promise<Generated>>();
export function levelFor(day: string): Promise<Generated> {
  let g = memo.get(day);
  if (!g) {
    g = (async () => {
      const store = getStore();
      const key = `level:v3:${day}`;
      const hit = await store.getCached(key);
      if (hit) return JSON.parse(hit) as Generated;
      const fresh = generateLevel(day);
      await store.setCached(key, JSON.stringify(fresh), 60 * 60 * 24 * 30);
      return fresh;
    })();
    g.catch(() => memo.delete(day));
    memo.set(day, g);
    if (memo.size > 8) memo.delete(memo.keys().next().value as string);
  }
  return g;
}

export async function ghostFor(day: string): Promise<GhostHint> {
  const { solution } = await levelFor(day);
  // offset the circle's centre a little (deterministically) so it marks an area, not the exact spot
  let h = 0;
  for (const c of day) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = (h % 360) * (Math.PI / 180);
  const d = 0.6 + ((h >> 9) % 100) / 100;
  return { x: solution.moon.x + Math.cos(a) * d, z: solution.moon.z + Math.sin(a) * d, radius: 3 };
}

export async function today(pid: string | null, day = currentDay()): Promise<TodayPayload> {
  const { level } = await levelFor(day);
  const store = getStore();
  const play: Play = pid ? await store.getPlay(day, pid) : { shots: [], helpers: [], status: 'playing', score: 0 };
  const name = pid ? await store.getName(pid) : null;
  const streak = pid ? await store.getStreak(pid, day) : { current: 0, best: 0 };
  return { level, me: { name, play, streak }, ghost: play.helpers.includes('ghost') ? await ghostFor(day) : null };
}

export async function setName(pid: string, raw: unknown) {
  const name = cleanName(raw);
  await getStore().setName(pid, name);
  return name;
}

async function requirePlayer(pid: string | null) {
  if (!pid) throw new GameError('Pick a pilot name first.', 401);
  const name = await getStore().getName(pid);
  if (!name) throw new GameError('Pick a pilot name first.', 401);
  return pid;
}

export async function applyHelper(pidIn: string | null, helper: unknown, day = currentDay()) {
  const pid = await requirePlayer(pidIn);
  if (typeof helper !== 'string' || !(helper in HELPERS)) throw new GameError('Unknown helper.');
  const store = getStore();
  const play = await store.getPlay(day, pid);
  if (play.status !== 'playing') throw new GameError("Today's puzzle is already finished.", 409);
  const helpers = await store.addHelper(day, pid, helper as HelperId);
  return { helpers, ghost: helpers.includes('ghost') ? await ghostFor(day) : null };
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.z - b.z);

export function parsePlacement(level: Level, raw: unknown, helpers: HelperId[]): Placement {
  const p = raw as Placement;
  if (!p || typeof p !== 'object' || !p.moon || !finite(p.moon.x) || !finite(p.moon.z) || !finite(p.angle)) {
    throw new GameError('Invalid shot.');
  }
  const angle = ((Math.round(p.angle) % 360) + 360) % 360;
  const moon = { x: p.moon.x, z: p.moon.z };
  if (dist(constrainMoon(level, moon), moon) > 0.01) throw new GameError('The moon cannot sit there.');
  let satellite: Placement['satellite'] = null;
  if (p.satellite) {
    if (!helpers.includes('satellite')) throw new GameError('Unlock the mirror satellite first.', 403);
    const s = p.satellite;
    if (!finite(s.x) || !finite(s.z) || !finite(s.angle)) throw new GameError('Invalid shot.');
    const pos = { x: s.x, z: s.z };
    if (dist(constrainMoon(level, pos, SATELLITE_RADIUS), pos) > 0.01 || dist(pos, moon) < level.moon.r + 1.6) {
      throw new GameError('The satellite cannot sit there.');
    }
    satellite = { ...pos, angle: ((Math.round(s.angle) % 360) + 360) % 360 };
  }
  return { moon, angle, satellite };
}

export async function shoot(pidIn: string | null, raw: unknown, day = currentDay()) {
  const pid = await requirePlayer(pidIn);
  const store = getStore();
  const { level } = await levelFor(day);
  const play = await store.getPlay(day, pid);
  if (play.status !== 'playing') throw new GameError("Today's puzzle is already finished.", 409);
  const placement = parsePlacement(level, raw, play.helpers);
  const shot = await store.reserveShot(day, pid);
  if (shot > MAX_SHOTS) throw new GameError('No shots left today.', 409);
  const res = trace(level, placement);
  await store.recordShot(day, pid, shot, res.result);
  let score = 0;
  let status: Play['status'] = 'playing';
  if (res.result === 'hit') {
    score = scoreFor(shot, play.helpers);
    status = 'won';
    await store.finish(day, pid, 'won', score);
  } else if (shot === MAX_SHOTS) {
    status = 'lost';
    await store.finish(day, pid, 'lost', 0);
  }
  return { shot, result: res.result, bounces: res.bounces, hitName: res.hitName, score, status, play: await store.getPlay(day, pid), streak: await store.getStreak(pid, day) };
}

export async function leaderboard(pid: string | null, scope: unknown, day = currentDay()) {
  const s = scope === 'all' ? 'all' : 'day';
  return { scope: s, day, ...(await getStore().board(s, day, pid)) };
}
