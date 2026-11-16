// Server-side game service. All score-affecting decisions happen here.
import { constrainMoon, orbitClock, trace, withDestroyed, SATELLITE_RADIUS, type Level, type Placement, type Vec } from '@/game/engine';
import { generateLevel, type Generated } from '@/game/generate';
import { HELPER_ORDER, MAX_SHOTS, scoreFor, utcDay, type HelperId } from '@/game/rules';
import { getStore, nameKey, type Play, type Streak } from './store';

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
/** `now` is the server's clock, so the page can run the moons' orbit clock in step with it. */
export type TodayPayload = { level: Level; me: Me; now: number };

export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') throw new GameError('Enter a pilot name.');
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 16) throw new GameError('Pilot names need 2 to 16 characters.');
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(name)) throw new GameError('Use letters, numbers, spaces, dots, dashes or underscores.');
  return name;
}

let warnedNoSecret = false;
/** Server-only secret mixed into the level seed, so the public generator cannot be run ahead of the server. */
function seedSecret(): string {
  const s = process.env.ORBIT_SEED_SECRET ?? '';
  if (!s && process.env.VERCEL_ENV === 'production' && !warnedNoSecret) {
    warnedNoSecret = true;
    console.error('ORBIT_SEED_SECRET is not set: anyone can generate the daily level and its solution from the public source.');
  }
  return s;
}

// Each day's level is generated once, then cached in memory and in the store (generation can take seconds).
const memo = new Map<string, Promise<Generated>>();
export function levelFor(day: string): Promise<Generated> {
  let g = memo.get(day);
  if (!g) {
    g = (async () => {
      const store = getStore();
      const key = `level:v5:${day}`; // v5: moons orbit
      const hit = await store.getCached(key);
      if (hit) return JSON.parse(hit) as Generated;
      const fresh = generateLevel(day, seedSecret());
      await store.setCached(key, JSON.stringify(fresh), 60 * 60 * 24 * 30);
      return fresh;
    })();
    g.catch(() => memo.delete(day));
    memo.set(day, g);
    if (memo.size > 8) memo.delete(memo.keys().next().value as string);
  }
  return g;
}

export async function today(pid: string | null, day = currentDay(), now = Date.now()): Promise<TodayPayload> {
  const { level } = await levelFor(day);
  const store = getStore();
  const play: Play = pid ? await store.getPlay(day, pid) : { shots: [], helpers: [], status: 'playing', score: 0, destroyed: [] };
  const name = pid ? await store.getName(pid) : null;
  const streak = pid ? await store.getStreak(pid, day) : { current: 0, best: 0 };
  if (pid && play.status === 'playing') await store.markSeen(day, pid, now);
  return { level, me: { name, play, streak }, now };
}

export async function setName(pid: string, raw: unknown) {
  const name = cleanName(raw);
  const store = getStore();
  // one pilot per name, so the leaderboard never shows the same name twice
  if (!(await store.claimName(pid, name))) throw new GameError('That pilot name is already taken. Pick another one.', 409);
  const old = await store.getName(pid);
  await store.setName(pid, name);
  if (old && nameKey(old) !== nameKey(name)) await store.releaseName(pid, old);
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
  // only helpers on offer today can be picked (the retired Ghost moon is refused)
  if (typeof helper !== 'string' || !(HELPER_ORDER as string[]).includes(helper)) throw new GameError('Unknown helper.');
  const store = getStore();
  const play = await store.getPlay(day, pid);
  if (play.status !== 'playing') throw new GameError("Today's puzzle is already finished.", 409);
  const helpers = await store.addHelper(day, pid, helper as HelperId);
  return { helpers };
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
  // where the orbiting moons are: any moment is fair, since the player could wait for it
  if (!level.orbitPeriod) return { moon, angle, satellite };
  const t = p.t ?? 0;
  if (!finite(t) || t < 0 || t >= level.orbitPeriod) throw new GameError('Invalid shot.');
  return { moon, angle, satellite, t: Math.round(t * 100) / 100 };
}

/** How far (in orbit seconds) a shot's moon clock may be from the server's: network delay and clock drift. */
export const CLOCK_SLACK = 10;
/** A win sooner than this after first seeing the board is faster than a person can aim. */
export const MIN_SOLVE_MS = 20_000;

/** The page's details about how a shot was aimed, sent alongside the placement. */
export type ShotProof = { moves?: unknown; slow?: unknown };

/**
 * The moons must be where they really are when the shot is fired: the orbit clock the page shows is
 * the server's (slowed to half for reduced motion). A shot may also repeat the frozen moment of the
 * previous shot, which the page does when you fire again without moving anything.
 */
export function checkClock(level: Level, t: number | undefined, slow: boolean, now: number, lastT: number | null) {
  const P = level.orbitPeriod;
  if (!P || t === undefined) return;
  if (lastT !== null && Math.abs(t - lastT) < 0.005) return;
  const gap = Math.abs(t - orbitClock(level, now, slow ? 0.5 : 1));
  if (Math.min(gap, P - gap) > CLOCK_SLACK) throw new GameError('The moons have moved since you aimed. Check your line and fire again.', 409);
}

/** Why a winning shot looks automated, or null. */
export function suspicion(proof: ShotProof, seen: number | null, now: number): string | null {
  const moves = proof.moves;
  // the moon never starts on a winning spot, so a real win always needs at least one drag or turn
  if (typeof moves !== 'number' || !Number.isFinite(moves) || moves < 1) return 'no-aiming';
  if (seen !== null && now - seen < MIN_SOLVE_MS) return 'too-fast';
  return null;
}

export const SCRIPT_MESSAGES: Record<string, string> = {
  'no-aiming': 'Shot rejected: it was not aimed on the board, so it looks like a script. Drag the moon and turn its mirror yourself, then fire.',
  'too-fast': 'Shot rejected: that was aimed faster than a pilot can, so it looks like a script. Take a moment to line it up, then fire again.',
};

export async function shoot(pidIn: string | null, raw: unknown, day = currentDay(), proof: ShotProof = {}, now = Date.now()) {
  const pid = await requirePlayer(pidIn);
  const store = getStore();
  const { level } = await levelFor(day);
  const play = await store.getPlay(day, pid);
  if (play.status !== 'playing') throw new GameError("Today's puzzle is already finished.", 409);
  const placement = parsePlacement(level, raw, play.helpers);
  const meta = await store.getShotMeta(day, pid);
  checkClock(level, placement.t, proof.slow === true, now, meta.lastT);
  const res = trace(withDestroyed(level, play.destroyed), placement);
  // a winning shot that looks scripted is turned away before it counts (misses are never checked)
  if (res.result === 'hit') {
    const why = suspicion(proof, meta.seen, now);
    if (why) {
      console.warn(`[orbit] rejected automated-looking shot: day=${day} pid=${pid} reason=${why}`);
      throw new GameError(SCRIPT_MESSAGES[why], 403);
    }
  }
  const shot = await store.reserveShot(day, pid);
  if (shot > MAX_SHOTS) throw new GameError('No shots left today.', 409);
  await store.recordShot(day, pid, shot, res.result, placement.t);
  // the energized laser blows up every asteroid the beam hits; they stay gone for later shots
  const destroyed = play.helpers.includes('energized') ? res.rocksHit : [];
  if (destroyed.length) await store.addDestroyed(day, pid, destroyed);
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
  return { shot, result: res.result, bounces: res.bounces, hitName: res.hitName, destroyed, score, status, play: await store.getPlay(day, pid), streak: await store.getStreak(pid, day) };
}

export async function leaderboard(pid: string | null, scope: unknown, day = currentDay()) {
  const s = scope === 'all' ? 'all' : 'day';
  return { scope: s, day, ...(await getStore().board(s, day, pid)) };
}
