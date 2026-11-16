// Server-side game service. All score-affecting decisions happen here.
import { constrainMoon, orbitClock, trace, withDestroyed, SATELLITE_RADIUS, type Level, type Placement, type Vec } from '@/game/engine';
import { generateLevel, type Generated } from '@/game/generate';
import { HELPER_ORDER, LAUNCH_DAY, MAX_SHOTS, puzzleNumber, scoreFor, utcDay, type HelperId } from '@/game/rules';
import { buildVoyageLevel, PREBUILT, voyageSpec, voyageStars } from '@/game/voyage';
import prebuilt from '@/game/voyage-levels.json';
import { getStore, nameKey, prevDay, type DayResult, type Play, type Streak, type VoyageRow } from './store';

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
/**
 * `archive`: a past day, played for fun. It does not count for the leaderboards or the streak.
 * `now` is the server's clock, so the page can run the moons' orbit clock in step with it. */
export type TodayPayload = { level: Level; me: Me; archive: boolean; now: number };

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

export async function today(pid: string | null, rawDay?: unknown, now = Date.now()): Promise<TodayPayload> {
  const { day, ranked } = resolveDay(rawDay);
  const { level } = await levelFor(day);
  const store = getStore();
  const play: Play = pid ? await playFor(day, pid) : emptyPlay();
  const name = pid ? await store.getName(pid) : null;
  // the streak is about today: an archive day shows the streak as it stands now
  const streak = pid ? await store.getStreak(pid, currentDay()) : { current: 0, best: 0 };
  if (pid && play.status === 'playing') await store.markSeen(day, pid, now);
  return { level, me: { name, play, streak }, archive: !ranked, now };
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
  // Voyage progress made before picking a name joins the Voyage board now
  await syncVoyageScore(pid, await store.getVoyage(pid));
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
export function suspicion(proof: ShotProof, seen: number | null, now: number, minMs = MIN_SOLVE_MS): string | null {
  const moves = proof.moves;
  // the moon never starts on a winning spot, so a real win always needs at least one drag or turn
  if (typeof moves !== 'number' || !Number.isFinite(moves) || moves < 1) return 'no-aiming';
  if (seen !== null && now - seen < minMs) return 'too-fast';
  return null;
}

export const SCRIPT_MESSAGES: Record<string, string> = {
  'no-aiming': 'Shot rejected: it was not aimed on the board, so it looks like a script. Drag the moon and turn its mirror yourself, then fire.',
  'too-fast': 'Shot rejected: that was aimed faster than a pilot can, so it looks like a script. Take a moment to line it up, then fire again.',
};

export async function shoot(pidIn: string | null, raw: unknown, rawDay?: unknown, proof: ShotProof = {}, now = Date.now()) {
  const { day, ranked } = resolveDay(rawDay);
  const pid = await playerFor(pidIn, ranked);
  const store = getStore();
  const { level } = await levelFor(day);
  const play = await playFor(day, pid);
  if (play.status !== 'playing') throw new GameError(finishedText(ranked), 409);
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
  if (shot > MAX_SHOTS) throw new GameError(ranked ? 'No shots left today.' : 'No shots left on this puzzle.', 409);
  await store.recordShot(day, pid, shot, res.result, placement.t);
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
/** `now` is the server's clock, for the moons' orbit clock (as in TodayPayload). */
export type VoyagePayload = { level: Level; n: number; unlocked: number; stars: Record<number, number>; shots: string[]; info: VoyageInfo; now: number; name: string | null };

/** Voyage levels are quicker than a daily puzzle, so a win is only too fast under 10 seconds. */
export const VOYAGE_MIN_SOLVE_MS = 10_000;
const totalStars = (stars: Record<number, number>) => Object.values(stars).reduce((a, b) => a + b, 0);
/** Named pilots with progress are on the Voyage board (unnamed ones join when they pick a name). */
async function syncVoyageScore(pid: string, row: VoyageRow) {
  const store = getStore();
  if (row.unlocked > 1 && (await store.getName(pid))) await store.setVoyageScore(pid, totalStars(row.stars), row.unlocked - 1);
}

/** A Voyage level (by default the furthest one open) and the player's progress. */
export async function voyage(pid: string | null, rawN?: unknown, now = Date.now()): Promise<VoyagePayload> {
  const row = pid ? await getStore().getVoyage(pid) : null;
  const unlocked = row?.unlocked ?? 1;
  const n = voyageNumber(rawN, unlocked);
  if (n > unlocked) throw new GameError(`Clear level ${unlocked} first.`, 403);
  const { level } = await voyageLevelFor(n);
  // an attempt that ended (a hit, or every shot used) is over: the level starts fresh
  const a = row?.attempt;
  const shots = a && a.n === n && a.shots.length < MAX_SHOTS && !a.shots.includes('hit') ? a.shots : [];
  // remember when the level was first opened, to turn away wins faster than a pilot can aim
  if (pid && row && row.seen?.n !== n) await getStore().setVoyage(pid, { ...row, seen: { n, ms: now } });
  const name = pid ? await getStore().getName(pid) : null;
  return { level, n, unlocked, stars: row?.stars ?? {}, shots, info: voyageInfo(n), now, name };
}

export async function voyageShot(pidIn: string | null, rawN: unknown, raw: unknown, proof: ShotProof = {}, now = Date.now()) {
  const pid = await playerFor(pidIn, false);
  const store = getStore();
  const row = await store.getVoyage(pid);
  const n = voyageNumber(rawN, row.unlocked);
  if (n > row.unlocked) throw new GameError(`Clear level ${row.unlocked} first.`, 403);
  const { level } = await voyageLevelFor(n);
  const placement = parsePlacement(level, raw, []);
  // the same checks as today's puzzle, now that Voyage has a leaderboard
  checkClock(level, placement.t, proof.slow === true, now, row.attempt.n === n ? row.attempt.lastT ?? null : null);
  const res = trace(level, placement);
  if (res.result === 'hit') {
    const why = suspicion(proof, row.seen?.n === n ? row.seen.ms : null, now, VOYAGE_MIN_SOLVE_MS);
    if (why) {
      console.warn(`[orbit] rejected automated-looking Voyage shot: level=${n} pid=${pid} reason=${why}`);
      throw new GameError(SCRIPT_MESSAGES[why], 403);
    }
  }
  const prev = row.attempt.n === n ? row.attempt.shots : [];
  const shots = prev.length >= MAX_SHOTS || prev.includes('hit') ? [] : [...prev];
  shots.push(res.result);
  let status: Play['status'] = 'playing';
  let stars = 0;
  if (res.result === 'hit') {
    status = 'won';
    stars = voyageStars(shots.length);
    row.stars[n] = Math.max(row.stars[n] ?? 0, stars);
    row.unlocked = Math.max(row.unlocked, n + 1);
  } else if (shots.length >= MAX_SHOTS) status = 'lost';
  row.attempt = { n, shots, ...(placement.t === undefined ? {} : { lastT: placement.t }) };
  await store.setVoyage(pid, row);
  if (status === 'won') await syncVoyageScore(pid, row);
  return { result: res.result, bounces: res.bounces, hitName: res.hitName, shots, status, stars, best: row.stars[n] ?? 0, unlocked: row.unlocked, starsByLevel: row.stars };
}

export async function leaderboard(pid: string | null, scope: unknown, day = currentDay()) {
  const s = scope === 'all' ? 'all' : scope === 'voyage' ? 'voyage' : 'day';
  return { scope: s, day, ...(await getStore().board(s, day, pid)) };
}
