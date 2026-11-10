// Deterministic daily level generator. The same day string always yields the same level,
// and every generated level is checked by a solver to be winnable with a mirror bounce.
import { constrainMoon, trace, MOON_MIRROR_OFFSET, type Body, type Level, type Placement, type Rock, type Vec } from './engine';
import { puzzleNumber } from './rules';

export type Generated = { level: Level; solution: Placement; solutions: number; attempts: number };

const GIANTS = ['Kepler-b', 'Tessaly', 'Vorn', 'Halcyon', 'Mabus', 'Orrin', 'Pell', 'Saros', 'Ixion', 'Calder'];
const PLANETS = ['Nim', 'Quell', 'Rhea-4', 'Tarn', 'Ulla', 'Wex', 'Yara', 'Zeno'];
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

function buildCandidate(day: string, attempt: number): Level {
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
  if (r() < 0.55) {
    const p: Body = { x: round(between(4, 10)), z: round(-side * between(4, 12)), r: round(between(1.8, 2.4)), m: round(between(0.25, 0.42)), name: pick(PLANETS), kind: 'planet' };
    if (dist(p, giant) > giant.r + p.r + 5) bodies.push(p);
  }

  const target = { x: round(between(12, 17)), z: round(between(-12, 12)), r: 1.5 };
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
    moon: { r: 1.6, m: 0.12, name: pick(MOONS), start: { x: 0, z: 0 }, startAngle: 90 },
    mirrorHalf: 1.5,
    bounds: { x: 34, z: 26 },
  };
  const start = constrainMoon(level, { x: round(between(-10, -5)), z: round(-side * between(7, 11)) });
  level.moon.start = { x: round(start.x), z: round(start.z) };
  level.moon.startAngle = Math.floor(r() * 36) * 10;
  return level;
}

function validate(level: Level): { solution: Placement; solutions: number } | null {
  const T = level.target;
  if (dist(level.emitter, T) < 25) return null;
  for (const b of level.bodies) if (dist(b, T) < b.r + 5 || dist(b, level.emitter) < b.r + 6) return null;

  const start: Placement = { moon: level.moon.start, angle: level.moon.startAngle };
  const free = trace(level, start);
  if (free.result === 'hit') return null;
  // the unaided beam must not pass close to the beacon (otherwise gravity alone could win)
  if (Math.min(...free.pts.map((p) => dist(p, T))) < 4) return null;

  // try mirror positions along the free path
  type Hit = { s: number; a: number; placement: Placement };
  const hits: Hit[] = [];
  let travelled = 0;
  let next = 3;
  for (let i = 1; i < free.pts.length && travelled < 80; i++) {
    const p = free.pts[i], o = free.pts[i - 1];
    travelled += dist(p, o);
    if (travelled < next) continue;
    next += 0.8;
    const dir = { x: p.x - o.x, z: p.z - o.z };
    const dl = Math.hypot(dir.x, dir.z) || 1;
    for (let a = 0; a < 360; a += 4) {
      const t = (a * Math.PI) / 180;
      const n = { x: Math.cos(t), z: Math.sin(t) };
      if ((n.x * dir.x + n.z * dir.z) / dl > -0.1) continue; // mirror must face the beam
      const off = level.moon.r + MOON_MIRROR_OFFSET;
      const moon = { x: p.x - n.x * off, z: p.z - n.z * off };
      const c = constrainMoon(level, moon);
      if (dist(c, moon) > 1e-6) continue;
      const placement = { moon: { x: round(moon.x), z: round(moon.z) }, angle: a };
      const res = trace(level, placement);
      if (res.result === 'hit' && res.bounces > 0) hits.push({ s: Math.round(travelled / 0.8), a, placement });
    }
  }
  if (hits.length < 3) return null;
  // prefer a solution with neighbouring solutions, so it is not pixel-perfect
  let best: Hit | null = null;
  let bestScore = -1;
  for (const h of hits) {
    const neighbours = hits.filter((o) => Math.abs(o.s - h.s) <= 1 && Math.abs(o.a - h.a) <= 4).length;
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
  moon: { r: 1.6, m: 0.12, name: 'Io-7', start: { x: -8, z: -8 }, startAngle: 90 },
  mirrorHalf: 1.5,
  bounds: { x: 34, z: 26 },
});

export function generateLevel(day: string): Generated {
  for (let attempt = 0; attempt < 60; attempt++) {
    const level = buildCandidate(day, attempt);
    const ok = validate(level);
    if (ok) return { level, solution: ok.solution, solutions: ok.solutions, attempts: attempt + 1 };
  }
  return { level: FALLBACK_LEVEL(day), solution: { moon: { x: 10, z: 3 }, angle: 230 }, solutions: 0, attempts: 60 };
}

const cache = new Map<string, Generated>();
export function levelFor(day: string): Generated {
  let g = cache.get(day);
  if (!g) {
    g = generateLevel(day);
    cache.set(day, g);
    if (cache.size > 8) cache.delete(cache.keys().next().value as string);
  }
  return g;
}
