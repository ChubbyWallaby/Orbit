// Deterministic daily level generator. The same day string always yields the same level,
// and every generated level is checked by a solver to be winnable with a mirror bounce.
import { constrainMoon, trace, MOON_MIRROR_OFFSET, type Body, type Level, type Placement, type Rock, type Splitter, type Vec, type Wormhole } from './engine';
import { puzzleNumber } from './rules';

export type Generated = { level: Level; solution: Placement; solutions: number; attempts: number };

const GIANTS = ['Kepler-b', 'Tessaly', 'Vorn', 'Halcyon', 'Mabus', 'Orrin', 'Pell', 'Saros', 'Ixion', 'Calder'];
const PLANETS = ['Nim', 'Quell', 'Rhea-4', 'Tarn', 'Ulla', 'Wex', 'Yara', 'Zeno'];
const HOLES = ['Abyss', 'Erebus', 'Nyx', 'Tartarus', 'Umbra', 'Charon'];
const MOONS = ['Io-7', 'Lumen', 'Pip', 'Moro', 'Selka', 'Dace', 'Fen', 'Kiri'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.z - b.z);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export type Feature = 'plain' | 'blackhole' | 'splitter' | 'wormhole';

export function featureFor(day: string): Feature {
  const x = rng(hash(`${day}:feature`))();
  return x < 0.25 ? 'plain' : x < 0.5 ? 'blackhole' : x < 0.75 ? 'splitter' : 'wormhole';
}

function buildCandidate(day: string, attempt: number, feature: Feature): Level {
  const r = rng(hash(`${day}#${attempt}`));
  const between = (a: number, b: number) => a + (b - a) * r();
  const pick = <T,>(arr: T[]) => arr[Math.floor(r() * arr.length)];
  const side = r() < 0.5 ? -1 : 1;

  const giant: Body = { x: round(between(-3, 3)), z: round(between(-3, 3)), r: round(between(3.6, 4.6)), m: round(between(0.7, 1.05)), name: pick(GIANTS), kind: 'giant' };
  const emitter = { x: round(between(-19, -15)), z: round(side * between(5, 12)), dir: 0 };
  const toGiant = Math.atan2(giant.z - emitter.z, giant.x - emitter.x);
  // aim past the giant (on the emitter's side), so the shot misses on its own
  emitter.dir = round(toGiant - side * between(0.2, 0.45), 4);

  const bodies: Body[] = [giant];
  const target = { x: round(between(12, 17)), z: round(between(-12, 12)), r: 1.5 };
  const taken: (Vec & { r: number })[] = [{ ...giant }, { ...emitter, r: 2.5 }, { ...target, r: 4.5 }];
  const free = (q: Vec, rad: number) => taken.every((t) => dist(t, q) > t.r + rad + 3);
  const splitters: Splitter[] = [];
  const wormholes: Wormhole[] = [];

  if (r() < 0.45) {
    const p: Body = { x: round(between(4, 10)), z: round(-side * between(4, 12)), r: round(between(1.8, 2.4)), m: round(between(0.25, 0.42)), name: pick(PLANETS), kind: 'planet' };
    if (free(p, p.r)) { bodies.push(p); taken.push({ ...p }); }
  }

  const rocks: Rock[] = [];
  const facing = Math.atan2(giant.z - target.z, giant.x - target.x);
  const count = 3 + Math.floor(r() * 3);
  for (let tries = 0; tries < 24 && rocks.length < count; tries++) {
    const a = facing + between(-1.3, 1.3);
    const d = between(2.7, 3.8);
    const rock = { x: round(target.x + Math.cos(a) * d), z: round(target.z + Math.sin(a) * d), r: round(between(0.7, 1.05)) };
    if (rocks.every((o) => dist(o, rock) > o.r + rock.r + 0.5)) rocks.push(rock);
  }

  const level: Level = {
    day,
    number: puzzleNumber(day),
    emitter,
    target,
    bodies,
    rocks,
    splitters,
    wormholes,
    moon: { r: 1.6, m: 0.12, name: pick(MOONS), start: { x: 0, z: 0 }, startAngle: 90 },
    mirrorHalf: 1.5,
    bounds: { x: 34, z: 26 },
  };
  const start = constrainMoon(level, { x: round(between(-10, -5)), z: round(-side * between(7, 11)) });
  level.moon.start = { x: round(start.x), z: round(start.z) };
  level.moon.startAngle = Math.floor(r() * 36) * 10;
  if (feature !== 'plain' && !addPiece(level, feature, r, taken)) return level; // generateLevel() skips levels missing their piece
  // the new piece may sit near the moon's starting spot: move the moon clear of it
  const moved = constrainMoon(level, level.moon.start);
  level.moon.start = { x: round(moved.x), z: round(moved.z) };
  if (day >= VARIETY_FROM) addVariety(level, rng(hash(`${day}#style#${attempt}`)));
  return level;
}

/** Days from this date on get varied planets, gravity, stations, moons, mirrors and board orientation. */
export const VARIETY_FROM = '2026-11-11';

const GIANT_STYLES = ['amber', 'ice', 'lava', 'toxic', 'violet'] as const;
const PLANET_STYLES = ['blue', 'rose', 'jade', 'sand'] as const;
const EMITTER_STYLES = ['station', 'dish', 'crystal'] as const;
const MOON_STYLES = ['grey', 'ice', 'rust'] as const;

/**
 * Re-skins and re-tunes a finished candidate. Uses its own random stream so the main layout
 * draws stay the same, and only runs for days from VARIETY_FROM (earlier days must not change).
 */
function addVariety(level: Level, r: () => number) {
  const between = (a: number, b: number) => a + (b - a) * r();
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(r() * arr.length)];

  // giant: look, rings and gravity class
  const giant = level.bodies.find((b) => b.kind === 'giant')!;
  giant.style = pick(GIANT_STYLES);
  giant.ring = r() < 0.6;
  const cls = r();
  const others: (Vec & { r: number })[] = [
    { ...level.emitter, r: 1.5 }, { ...level.target, r: level.target.r }, ...level.rocks,
    ...level.bodies.filter((b) => b !== giant), ...level.splitters.map((sp) => ({ ...sp, r: sp.half })),
    ...level.wormholes.flatMap((w) => [{ ...w.a, r: w.r }, { ...w.b, r: w.r }]),
  ];
  const fits = (rad: number) => others.every((o) => dist(o, giant) > o.r + rad + 1.5);
  if (cls < 0.3) { giant.r = round(between(2.8, 3.4)); giant.m = round(between(1.0, 1.3)); } // dense: small, strong pull
  else if (cls > 0.7) {
    const rad = round(between(4.8, 5.6));
    if (fits(rad)) { giant.r = rad; giant.m = round(between(0.45, 0.68)); } // puffy: big, weak pull
  }
  for (const b of level.bodies) if (b.kind === 'planet') b.style = pick(PLANET_STYLES);

  // moon and mirror
  level.moon.style = pick(MOON_STYLES);
  level.moon.r = round(between(1.25, 1.95));
  level.moon.m = round(between(0.06, 0.22), 3);
  level.mirrorHalf = round(between(1.1, 1.9));
  level.emitter.style = pick(EMITTER_STYLES);

  // board orientation: mirror and/or flip, so the laser comes from different sides
  const fx = r() < 0.5 ? -1 : 1, fz = r() < 0.5 ? -1 : 1;
  const t = (v: Vec) => { v.x = round(v.x * fx); v.z = round(v.z * fz); };
  const tAngleDeg = (a: number) => {
    const rad = Math.atan2(Math.sin((a * Math.PI) / 180) * fz, Math.cos((a * Math.PI) / 180) * fx);
    return Math.round(((rad * 180) / Math.PI + 360) % 360);
  };
  t(level.emitter);
  level.emitter.dir = round(Math.atan2(Math.sin(level.emitter.dir) * fz, Math.cos(level.emitter.dir) * fx), 4);
  t(level.target);
  level.bodies.forEach(t);
  level.rocks.forEach(t);
  for (const sp of level.splitters) { t(sp); sp.angle = tAngleDeg(sp.angle); }
  for (const w of level.wormholes) { t(w.a); t(w.b); }
  t(level.moon.start);
  level.moon.startAngle = tAngleDeg(level.moon.startAngle);
  const c = constrainMoon(level, level.moon.start);
  level.moon.start = { x: round(c.x), z: round(c.z) };
}

/** Places today's special piece on or near the unaided beam so it actually matters. */
function addPiece(level: Level, feature: Feature, r: () => number, taken: (Vec & { r: number })[]): boolean {
  const between = (a: number, b: number) => a + (b - a) * r();
  const free = (q: Vec, rad: number) =>
    taken.every((t) => dist(t, q) > t.r + rad + 2.5) && Math.abs(q.x) < level.bounds.x - 4 && Math.abs(q.z) < level.bounds.z - 4;
  const path = trace(level, { moon: level.moon.start, angle: level.moon.startAngle }).rays[0];
  const at = (d: number) => {
    const i = path.dist.findIndex((x) => x >= d);
    if (i < 1) return null;
    const p = path.pts[i], o = path.pts[i - 1];
    const l = Math.hypot(p.x - o.x, p.z - o.z) || 1;
    return { p, dir: { x: (p.x - o.x) / l, z: (p.z - o.z) / l } };
  };
  for (let tries = 0; tries < 30; tries++) {
    const spot = at(between(7, 24));
    if (!spot) continue;
    const { p, dir } = spot;
    const side = r() < 0.5 ? -1 : 1;
    const perp = { x: -dir.z * side, z: dir.x * side };
    if (feature === 'blackhole') {
      const off = between(3.2, 5.5);
      const bh: Body = { x: round(p.x + perp.x * off), z: round(p.z + perp.z * off), r: 0.9, m: round(between(1.1, 1.6)), name: HOLES[Math.floor(r() * HOLES.length)], kind: 'blackhole' };
      if (free(bh, 3)) { level.bodies.push(bh); return true; }
    } else if (feature === 'splitter') {
      const off = between(-0.5, 0.5);
      const ang = (Math.atan2(dir.z, dir.x) * 180) / Math.PI + 180 + side * between(25, 65);
      const sp: Splitter = { x: round(p.x + perp.x * off), z: round(p.z + perp.z * off), angle: Math.round(((ang % 360) + 360) % 360), half: 1.3 };
      if (free(sp, sp.half)) { level.splitters.push(sp); return true; }
    } else {
      const a = { x: round(p.x), z: round(p.z) };
      const b = { x: round(between(-6, 12)), z: round(between(-level.bounds.z + 6, level.bounds.z - 6)) };
      if (free(a, 1.1) && free(b, 1.1) && dist(a, b) > 12) { level.wormholes.push({ a, b, r: 1.1 }); return true; }
    }
  }
  return false;
}

function validate(level: Level): { solution: Placement; solutions: number } | null {
  const T = level.target;
  if (dist(level.emitter, T) < 25) return null;
  for (const b of level.bodies) if (dist(b, T) < b.r + 5 || dist(b, level.emitter) < b.r + 6) return null;

  const start: Placement = { moon: level.moon.start, angle: level.moon.startAngle };
  // the starting spot must be a legal placement (the server applies the same check)
  if (dist(constrainMoon(level, level.moon.start), level.moon.start) > 0.005) return null;
  const free = trace(level, start);
  if (free.result === 'hit') return null;
  // the unaided beam must not pass close to the beacon (otherwise gravity alone could win)
  for (const ray of free.rays) if (Math.min(...ray.pts.map((p) => dist(p, T))) < 4) return null;

  // try mirror positions along the free path
  type Hit = { s: number; a: number; placement: Placement };
  const hits: Hit[] = [];
  for (const [ri, ray] of free.rays.entries()) {
  let travelled = 0;
  let next = 3;
  for (let i = 1; i < ray.pts.length && travelled < 60 && hits.length < 40; i++) {
    const p = ray.pts[i], o = ray.pts[i - 1];
    if (p.jump) continue;
    travelled += dist(p, o);
    if (travelled < next) continue;
    next += 1.0;
    const dir = { x: p.x - o.x, z: p.z - o.z };
    const dl = Math.hypot(dir.x, dir.z) || 1;
    for (let a = 0; a < 360; a += 5) {
      const t = (a * Math.PI) / 180;
      const n = { x: Math.cos(t), z: Math.sin(t) };
      if ((n.x * dir.x + n.z * dir.z) / dl > -0.1) continue; // mirror must face the beam
      const off = level.moon.r + MOON_MIRROR_OFFSET;
      const moon = { x: p.x - n.x * off, z: p.z - n.z * off };
      const c = constrainMoon(level, moon);
      if (dist(c, moon) > 1e-6) continue;
      const placement = { moon: { x: round(moon.x), z: round(moon.z) }, angle: a };
      const res = trace(level, placement);
      if (res.result === 'hit' && res.bounces > 0) hits.push({ s: ri * 1000 + Math.round(travelled), a, placement });
    }
  }
  }
  if (hits.length < 3) return null;
  // prefer a solution with neighbouring solutions, so it is not pixel-perfect
  let best: Hit | null = null;
  let bestScore = -1;
  for (const h of hits) {
    const neighbours = hits.filter((o) => Math.abs(o.s - h.s) <= 1 && Math.abs(o.a - h.a) <= 5).length;
    if (neighbours > bestScore) {
      bestScore = neighbours;
      best = h;
    }
  }
  if (!best || bestScore < 2) return null;
  return { solution: best.placement, solutions: hits.length };
}

export const FALLBACK_LEVEL = (day: string): Level => ({
  day,
  number: puzzleNumber(day),
  emitter: { x: -18, z: 8, dir: Math.atan2(-0.12, 1) },
  target: { x: 15, z: -9, r: 1.5 },
  bodies: [{ x: 0, z: 0, r: 4.2, m: 0.9, name: 'Kepler-b', kind: 'giant' }],
  rocks: [
    { x: 11.2, z: -5.6, r: 0.9 },
    { x: 11.6, z: -8.2, r: 1.0 },
    { x: 12.0, z: -10.9, r: 0.85 },
    { x: 13.0, z: -13.2, r: 0.9 },
  ],
  splitters: [],
  wormholes: [],
  moon: { r: 1.6, m: 0.12, name: 'Io-7', start: { x: -8, z: -8 }, startAngle: 90 },
  mirrorHalf: 1.5,
  bounds: { x: 34, z: 26 },
});

const hasFeature = (level: Level, f: Feature) =>
  f === 'plain' || (f === 'blackhole' ? level.bodies.some((b) => b.kind === 'blackhole') : f === 'splitter' ? level.splitters.length > 0 : level.wormholes.length > 0);

export function generateLevel(day: string): Generated {
  const feature = featureFor(day);
  for (let attempt = 0; attempt < 80; attempt++) {
    // after many failed tries, fall back to a plain level for the day
    const f = attempt < 60 ? feature : 'plain';
    const level = buildCandidate(day, attempt, f);
    if (!hasFeature(level, f)) continue;
    const ok = validate(level);
    if (ok) return { level, solution: ok.solution, solutions: ok.solutions, attempts: attempt + 1 };
  }
  return { level: FALLBACK_LEVEL(day), solution: { moon: { x: 10, z: 3 }, angle: 230 }, solutions: 0, attempts: 80 };
}
