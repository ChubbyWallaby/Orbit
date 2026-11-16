// Server-side game service. All score-affecting decisions happen here.
import { constrainMoon, trace, withDestroyed, SATELLITE_RADIUS, type Level, type Placement, type Vec } from '@/game/engine';
import { generateLevel, type Generated } from '@/game/generate';
import { HELPER_ORDER, LAUNCH_DAY, MAX_SHOTS, puzzleNumber, scoreFor, utcDay, type HelperId } from '@/game/rules';
import { buildVoyageLevel, PREBUILT, voyageSpec, voyageStars } from '@/game/voyage';
import prebuilt from '@/game/voyage-levels.json';
import { getStore, nameKey, prevDay, type DayResult, type Play, type Streak } from './store';

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
/** `archive`: a past day, played for fun. It does not count for the leaderboards or the streak. */
export type TodayPayload = { level: Level; me: Me; archive: boolean };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Which day a request is for: today's puzzle (ranked) unless a past day is asked for. */
export function resolveDay(raw: unknown, now = currentDay()): { day: string; ranked: boolean } {
  if (raw === undefined || raw === null || raw === '' || raw === now) return { day: now, ranked: true };
  if (typeof raw !== 'string' || !DAY_RE.test(raw) || Number.isNaN(Date.parse(raw + 'T00:00:00Z'))) throw new GameError('Unknown puzzle.', 404);
  if (raw < LAUNCH_DAY) throw new GameError('Orbit started on 10 November 2026. There are no puzzles before that.', 404);
  if (raw > now) throw new GameError('That puzzle is not out yet.', 404);
  return { day: raw, ranked: false };
}

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
      const key = `level:v5:${day}`; // v5: moons orbit
      const hit = await store.getCached(key);
      if (hit) return JSON.parse(hit) as Generated;
      const fresh = generateLevel(day);
      // kept for years: past days stay playable in the archive, the same as everyone played them
      await store.setCached(key, JSON.stringify(fresh), 60 * 60 * 24 * 365 * 5);
      return fresh;
    })();
    g.catch(() => memo.delete(day));
    memo.set(day, g);
    if (memo.size > 8) memo.delete(memo.keys().next().value as string);
  }
  return g;
}

const emptyPlay = (): Play => ({ shots: [], helpers: [], status: 'playing', score: 0, destroyed: [] });

/** The player's game on `day`. A play that has expired but is in the history stays finished. */
async function playFor(day: string, pid: string): Promise<Play> {
  const store = getStore();
  const play = await store.getPlay(day, pid);
  if (play.status !== 'playing' || play.shots.length) return play;
  const done = (await store.getHistory(pid, [day]))[day];
  return done ? { ...play, status: done.status, score: done.score } : play;
}

export async function today(pid: string | null, rawDay?: unknown): Promise<TodayPayload> {
  const { day, ranked } = resolveDay(rawDay);
  const { level } = await levelFor(day);
  const store = getStore();
  const play: Play = pid ? await playFor(day, pid) : emptyPlay();
  const name = pid ? await store.getName(pid) : null;
  // the streak is about today: an archive day shows the streak as it stands now
  const streak = pid ? await store.getStreak(pid, currentDay()) : { current: 0, best: 0 };
  return { level, me: { name, play, streak }, archive: !ranked };
}

export type ArchiveDay = { day: string; number: number } & ({ status: 'open' } | DayResult);
/** Every past day, newest first, with how this player did. */
export async function archive(pid: string | null) {
  const days: string[] = [];
  for (let d = prevDay(currentDay()); d >= LAUNCH_DAY; d = prevDay(d)) days.push(d);
  const done = pid ? await getStore().getHistory(pid, days) : {};
  const list: ArchiveDay[] = days.map((day) => ({ day, number: puzzleNumber(day), ...(done[day] ?? { status: 'open' as const }) }));
  return { days: list };
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

/** Today's puzzle needs a pilot name (for the leaderboard); archive days and Voyage only need a player id. */
async function playerFor(pid: string | null, ranked: boolean) {
  if (ranked) return requirePlayer(pid);
  if (!pid) throw new GameError('Could not tell who you are. Reload the page and try again.', 401);
  return pid;
}
const finishedText = (ranked: boolean) => (ranked ? "Today's puzzle is already finished." : 'You already finished this puzzle.');

export async function applyHelper(pidIn: string | null, helper: unknown, rawDay?: unknown) {
  const { day, ranked } = resolveDay(rawDay);
  const pid = await playerFor(pidIn, ranked);
  // only helpers on offer today can be picked (the retired Ghost moon is refused)
  if (typeof helper !== 'string' || !(HELPER_ORDER as string[]).includes(helper)) throw new GameError('Unknown helper.');
  const store = getStore();
  const play = await playFor(day, pid);
  if (play.status !== 'playing') throw new GameError(finishedText(ranked), 409);
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

export async function shoot(pidIn: string | null, raw: unknown, rawDay?: unknown) {
  const { day, ranked } = resolveDay(rawDay);
  const pid = await playerFor(pidIn, ranked);
  const store = getStore();
  const { level } = await levelFor(day);
  const play = await playFor(day, pid);
  if (play.status !== 'playing') throw new GameError(finishedText(ranked), 409);
  const placement = parsePlacement(level, raw, play.helpers);
  const shot = await store.reserveShot(day, pid);
  if (shot > MAX_SHOTS) throw new GameError(ranked ? 'No shots left today.' : 'No shots left on this puzzle.', 409);
  const res = trace(withDestroyed(level, play.destroyed), placement);
  await store.recordShot(day, pid, shot, res.result);
  // the energized laser blows up every asteroid the beam hits; they stay gone for later shots
  const destroyed = play.helpers.includes('energized') ? res.rocksHit : [];
  if (destroyed.length) await store.addDestroyed(day, pid, destroyed);
  let score = 0;
  let status: Play['status'] = 'playing';
  if (res.result === 'hit') {
    score = scoreFor(shot, play.helpers);
    status = 'won';
    await store.finish(day, pid, 'won', score, ranked);
  } else if (shot === MAX_SHOTS) {
    status = 'lost';
    await store.finish(day, pid, 'lost', 0, ranked);
  }
  return { shot, result: res.result, bounces: res.bounces, hitName: res.hitName, destroyed, score, status, play: await store.getPlay(day, pid), streak: await store.getStreak(pid, currentDay()) };
}

// ---- Voyage ----

/** Voyage levels are numbered from 1 with no end. */
export function voyageNumber(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 100000) throw new GameError('Unknown level.', 404);
  return n;
}

// The first levels are built ahead (voyage-levels.json); later ones are built once, then kept in the store.
const voyageMemo = new Map<number, Promise<Generated>>();
export function voyageLevelFor(n: number): Promise<Generated> {
  if (n <= (prebuilt as unknown[]).length) return Promise.resolve((prebuilt as Generated[])[n - 1]);
  let g = voyageMemo.get(n);
  if (!g) {
    g = (async () => {
      const store = getStore();
      const key = `voyage:v1:${n}`;
      const hit = await store.getCached(key);
      if (hit) return JSON.parse(hit) as Generated;
      const fresh = buildVoyageLevel(n);
      await store.setCached(key, JSON.stringify(fresh), 60 * 60 * 24 * 365 * 5);
      return fresh;
    })();
    g.catch(() => voyageMemo.delete(n));
    voyageMemo.set(n, g);
    if (voyageMemo.size > 8) voyageMemo.delete(voyageMemo.keys().next().value as number);
  }
  return g;
}
/** Levels past the prebuilt ones that should be made before anyone gets there. */
export const voyageToWarm = (n: number) => (n + 1 > PREBUILT ? [n + 1] : []);

export type VoyageInfo = { chapter: string; scanner: boolean; pieces: string[] };
const voyageInfo = (n: number): VoyageInfo => {
  const s = voyageSpec(n);
  return { chapter: s.chapter, scanner: s.scanner, pieces: s.features.filter((f) => f !== 'plain') };
};
export type VoyagePayload = { level: Level; n: number; unlocked: number; stars: Record<number, number>; shots: string[]; info: VoyageInfo };

/** A Voyage level (by default the furthest one open) and the player's progress. */
export async function voyage(pid: string | null, rawN?: unknown): Promise<VoyagePayload> {
  const row = pid ? await getStore().getVoyage(pid) : null;
  const unlocked = row?.unlocked ?? 1;
  const n = voyageNumber(rawN, unlocked);
  if (n > unlocked) throw new GameError(`Clear level ${unlocked} first.`, 403);
  const { level } = await voyageLevelFor(n);
  // an attempt that ended (a hit, or every shot used) is over: the level starts fresh
  const a = row?.attempt;
  const shots = a && a.n === n && a.shots.length < MAX_SHOTS && !a.shots.includes('hit') ? a.shots : [];
  return { level, n, unlocked, stars: row?.stars ?? {}, shots, info: voyageInfo(n) };
}

export async function voyageShot(pidIn: string | null, rawN: unknown, raw: unknown) {
  const pid = await playerFor(pidIn, false);
  const store = getStore();
  const row = await store.getVoyage(pid);
  const n = voyageNumber(rawN, row.unlocked);
  if (n > row.unlocked) throw new GameError(`Clear level ${row.unlocked} first.`, 403);
  const { level } = await voyageLevelFor(n);
  const placement = parsePlacement(level, raw, []);
  const prev = row.attempt.n === n ? row.attempt.shots : [];
  const shots = prev.length >= MAX_SHOTS || prev.includes('hit') ? [] : [...prev];
  const res = trace(level, placement);
  shots.push(res.result);
  let status: Play['status'] = 'playing';
  let stars = 0;
  if (res.result === 'hit') {
    status = 'won';
    stars = voyageStars(shots.length);
    row.stars[n] = Math.max(row.stars[n] ?? 0, stars);
    row.unlocked = Math.max(row.unlocked, n + 1);
  } else if (shots.length >= MAX_SHOTS) status = 'lost';
  row.attempt = { n, shots };
  await store.setVoyage(pid, row);
  return { result: res.result, bounces: res.bounces, hitName: res.hitName, shots, status, stars, best: row.stars[n] ?? 0, unlocked: row.unlocked, starsByLevel: row.stars };
}

export async function leaderboard(pid: string | null, scope: unknown, day = currentDay()) {
  const s = scope === 'all' ? 'all' : 'day';
  return { scope: s, day, ...(await getStore().board(s, day, pid)) };
}
