// Deterministic daily level generator. The same day string always yields the same level,
// and every generated level is checked by a solver to be winnable with a mirror bounce.
import { constrainMoon, trace, MOON_MIRROR_OFFSET, type Body, type FixedMirror, type Level, type Placement, type Rock, type Splitter, type Vec, type Wormhole } from './engine';
import { puzzleNumber } from './rules';

/** `solvable` lists the laser stations (0 = main) that the solver could get to the beacon. */
export type Generated = { level: Level; solution: Placement; solutions: number; attempts: number; solvable?: number[] };

const GIANTS = ['Kepler-b', 'Tessaly', 'Vorn', 'Halcyon', 'Mabus', 'Orrin', 'Pell', 'Saros', 'Ixion', 'Calder'];
const PLANETS = ['Nim', 'Quell', 'Rhea-4', 'Tarn', 'Ulla', 'Wex', 'Yara', 'Zeno'];
const HOLES = ['Abyss', 'Erebus', 'Nyx', 'Tartarus', 'Umbra', 'Charon'];
const REPULSORS = ['Aegis', 'Rebus', 'Vortan', 'Halo-9', 'Repel', 'Zephyr'];
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

export type Feature = 'plain' | 'blackhole' | 'splitter' | 'wormhole' | 'mirrors' | 'relay' | 'repulsor' | 'twin';

const NEW_POOL: Feature[] = ['blackhole', 'splitter', 'wormhole', 'mirrors', 'relay', 'repulsor', 'twin'];

/** The main special piece of the day. */
export function featureFor(day: string): Feature {
  return featuresFor(day)[0];
}

/** Every special piece of the day, main piece first: usually one, sometimes two, rarely none. */
export function featuresFor(day: string): Feature[] {
  const r = rng(hash(`${day}:features`));
  if (r() < 0.1) return ['plain'];
  const first = NEW_POOL[Math.floor(r() * NEW_POOL.length)];
  if (r() >= 0.4) return [first];
  const rest = NEW_POOL.filter((f) => f !== first);
  return [first, rest[Math.floor(r() * rest.length)]];
}

/** Relays work on the path the other pieces leave behind, so they are placed last. */
/** A second station goes in first, so other pieces can sit on either beam. */
const placementOrder = (fs: Feature[]) => {
  const rank = (f: Feature) => (f === 'twin' ? 0 : f === 'relay' ? 2 : 1);
  return [...fs].sort((a, b) => rank(a) - rank(b));
};

function buildCandidate(day: string, attempt: number, features: Feature[]): Level {
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
  const splitters: Splitter[] = [];
  const wormholes: Wormhole[] = [];

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
  addVariety(level, r);
  addSystem(level, r);
  // pieces go in after the star system is built, so they sit on the beam's real path
  for (const f of placementOrder(features)) {
    if (f === 'plain') continue;
    if (!addPiece(level, f, r, occupiedBy(level))) return level; // generateLevel() skips levels missing a piece
  }
  const c = constrainMoon(level, level.moon.start);
  level.moon.start = { x: round(c.x), z: round(c.z) };
  return level;
}

/** Everything already on the board, with its radius, for keeping new pieces apart. */
function occupiedBy(level: Level): (Vec & { r: number })[] {
  return [
    { ...level.emitter, r: 2.5 }, ...(level.extraEmitters ?? []).map((e) => ({ ...e, r: 2.5 })), { ...level.target, r: level.target.r + 3 },
    ...level.rocks.map((x) => ({ ...x, r: x.r + 0.5 })),
    ...level.bodies.map((b) => ({ ...b, r: b.r + (b.kind === 'blackhole' ? 1.5 : 0) })),
    ...level.splitters.map((sp) => ({ ...sp, r: sp.half })),
    ...level.wormholes.flatMap((w) => [{ ...w.a, r: w.r }, { ...w.b, r: w.r }]),
    ...(level.mirrors ?? []).map((m) => ({ ...m, r: m.half })),
    ...(level.relays ?? []).map((x) => ({ ...x })),
  ];
}

const SUNS = ['Helion', 'Vesta', 'Arcturo', 'Sol Minor', 'Ember', 'Lyra'];
const ROMAN = ['I', 'II', 'III'];

/**
 * Turns the board into a small star system: sometimes the giant becomes a sun, there is always at
 * least one more planet, and planets (and the giant) may get moons on a drawn orbit.
 */
function addSystem(level: Level, r: () => number) {
  const between = (a: number, b: number) => a + (b - a) * r();
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(r() * arr.length)];
  const B = level.bounds;
  const occupied = (): (Vec & { r: number })[] => [
    { ...level.emitter, r: 3 }, { ...level.target, r: level.target.r + 3 }, ...level.rocks.map((x) => ({ ...x, r: x.r + 1 })),
    ...level.bodies.map((b) => ({ ...b, r: b.r + (b.kind === 'blackhole' ? 3 : 1.5) })),
    ...level.splitters.map((sp) => ({ ...sp, r: sp.half + 1 })),
    ...level.wormholes.flatMap((w) => [{ ...w.a, r: w.r + 1 }, { ...w.b, r: w.r + 1 }]),
  ];
  const free = (p: Vec, rad: number, gap: number) =>
    Math.abs(p.x) < B.x - rad - 4 && Math.abs(p.z) < B.z - rad - 4 && occupied().every((o) => dist(o, p) > o.r + rad + gap);

  // 1. sometimes the central giant is a sun: smaller, much stronger pull, burns light
  const giant = level.bodies.find((b) => b.kind === 'giant')!;
  if (r() < 0.35) {
    Object.assign(giant, { kind: 'sun', style: 'sun', ring: false, name: pick(SUNS), r: round(between(2.6, 3.3)), m: round(between(1.4, 1.9)) });
  }

  // 2. one or two planets besides the giant or sun
  const planetCount = () => level.bodies.filter((b) => b.kind === 'planet').length;
  const wanted = r() < 0.4 ? 2 : 1;
  for (let tries = 0; tries < 40 && planetCount() < wanted; tries++) {
    const rad = round(between(1.7, 2.4));
    const p = { x: round(between(-B.x + 8, B.x - 8)), z: round(between(-B.z + 7, B.z - 7)) };
    if (!free(p, rad, 4)) continue;
    level.bodies.push({ ...p, r: rad, m: round(between(0.25, 0.45)), name: pick(PLANETS), kind: 'planet', style: pick(PLANET_STYLES) });
  }

  // 3. moons on orbits around planets and around a giant (not around suns or black holes)
  const parents = level.bodies.filter((b) => b.kind === 'planet' || b.kind === 'giant');
  for (const parent of parents) {
    const roll = r();
    const count = parent.kind === 'giant' ? (roll < 0.4 ? 1 : 0) : roll < 0.2 ? 2 : roll < 0.75 ? 1 : 0;
    const orbitR = round(parent.r + between(1.8, 2.8));
    let made = 0;
    for (let tries = 0; tries < 12 && made < count; tries++) {
      const a = between(0, Math.PI * 2);
      const rad = round(between(0.45, 0.7));
      const p = { x: round(parent.x + Math.cos(a) * orbitR), z: round(parent.z + Math.sin(a) * orbitR) };
      // keep clear of everything except its own planet
      const others = occupied().filter((o) => !(o.x === parent.x && o.z === parent.z));
      if (Math.abs(p.x) > B.x - 4 || Math.abs(p.z) > B.z - 4 || !others.every((o) => dist(o, p) > o.r + rad + 1.5)) continue;
      level.bodies.push({ ...p, r: rad, m: round(between(0.04, 0.08), 3), name: `${parent.name} ${ROMAN[made]}`, kind: 'moonlet', orbit: { x: parent.x, z: parent.z, r: orbitR } });
      made++;
    }
  }

  const c = constrainMoon(level, level.moon.start);
  level.moon.start = { x: round(c.x), z: round(c.z) };
}

const GIANT_STYLES = ['amber', 'ice', 'lava', 'toxic', 'violet'] as const;
const PLANET_STYLES = ['blue', 'rose', 'jade', 'sand'] as const;
const EMITTER_STYLES = ['station', 'dish', 'crystal'] as const;
const MOON_STYLES = ['grey', 'ice', 'rust'] as const;

/**
 * Re-skins and re-tunes a finished candidate: looks, gravity, moon and mirror size, and board orientation.
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
  for (const m of level.mirrors ?? []) { t(m); m.angle = tAngleDeg(m.angle); }
  for (const x of level.relays ?? []) t(x);
  t(level.moon.start);
  level.moon.startAngle = tAngleDeg(level.moon.startAngle);
  const c = constrainMoon(level, level.moon.start);
  level.moon.start = { x: round(c.x), z: round(c.z) };
}

/** Places today's special piece on or near the unaided beam so it actually matters. */
function addPiece(level: Level, feature: Feature, r: () => number, taken: (Vec & { r: number })[]): boolean {
  const between = (a: number, b: number) => a + (b - a) * r();
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(r() * arr.length)];
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
  if (feature === 'twin') {
    // a second laser station somewhere else on the board, aimed past the giant so it misses on its own
    const giant = level.bodies.find((b) => b.kind === 'giant' || b.kind === 'sun')!;
    for (let tries = 0; tries < 40; tries++) {
      const e = { x: round(between(-level.bounds.x + 9, level.bounds.x - 9)), z: round(between(-level.bounds.z + 6, level.bounds.z - 6)), dir: 0, style: pick(EMITTER_STYLES) };
      if (dist(e, level.target) < 24 || dist(e, level.emitter) < 14 || dist(e, giant) < giant.r + 9 || !free(e, 2)) continue;
      const toGiant = Math.atan2(giant.z - e.z, giant.x - e.x);
      e.dir = round(toGiant + (r() < 0.5 ? -1 : 1) * between(0.25, 0.55), 4);
      level.extraEmitters = [...(level.extraEmitters ?? []), e];
      return true;
    }
    return false;
  }
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
    } else if (feature === 'repulsor') {
      // sits just beside the beam and shoves it away
      const off = between(2.6, 4.2);
      const rp: Body = { x: round(p.x + perp.x * off), z: round(p.z + perp.z * off), r: 0.8, m: round(-between(0.7, 1.1)), name: REPULSORS[Math.floor(r() * REPULSORS.length)], kind: 'repulsor' };
      if (free(rp, 2)) { level.bodies.push(rp); return true; }
    } else if (feature === 'mirrors') {
      // one fixed mirror on the beam turns it, a second one elsewhere can be used for a bank shot
      const off = between(-0.4, 0.4);
      const ang = (Math.atan2(dir.z, dir.x) * 180) / Math.PI + 180 + side * between(20, 60);
      const half = round(between(1.3, 1.8));
      const m: FixedMirror = { x: round(p.x + perp.x * off), z: round(p.z + perp.z * off), angle: Math.round(((ang % 360) + 360) % 360), half };
      if (!free(m, half)) continue;
      level.mirrors = [...(level.mirrors ?? []), m];
      if (r() < 0.6) {
        for (let k = 0; k < 20; k++) {
          const q: FixedMirror = { x: round(between(-level.bounds.x + 8, level.bounds.x - 8)), z: round(between(-level.bounds.z + 7, level.bounds.z - 7)), angle: Math.floor(r() * 36) * 10, half: round(between(1.3, 1.8)) };
          if (free(q, q.half) && dist(q, m) > 8) { level.mirrors.push(q); break; }
        }
      }
      return true;
    } else if (feature === 'relay') {
      // the light fades a few units after the relay would have been needed: shots must pass through it
      const d = path.dist[path.dist.length - 1];
      const at2 = at(between(7, Math.min(16, d - 2)));
      if (!at2) continue;
      const relay = { x: round(at2.p.x), z: round(at2.p.z), r: 1.2 };
      if (!free(relay, relay.r)) continue;
      const toRelay = path.dist[path.pts.findIndex((q) => dist(q, relay) < relay.r)] ?? 0;
      level.relays = [...(level.relays ?? []), relay];
      level.range = round(Math.max(toRelay + 3, between(20, 27)), 1);
      return true;
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

function validate(level: Level): { solution: Placement; solutions: number; solvable: number[] } | null {
  const T = level.target;
  if (dist(level.emitter, T) < 25) return null;
  const stations = [level.emitter, ...(level.extraEmitters ?? [])];
  for (const b of level.bodies) if (dist(b, T) < b.r + 5 || stations.some((e) => dist(b, e) < b.r + 6)) return null;

  const start: Placement = { moon: level.moon.start, angle: level.moon.startAngle };
  // the starting spot must be a legal placement (the server applies the same check)
  if (dist(constrainMoon(level, level.moon.start), level.moon.start) > 0.005) return null;
  const free = trace(level, start);
  if (free.result === 'hit') return null;
  // the unaided beam must not pass close to the beacon (otherwise gravity alone could win)
  for (const ray of free.rays) if (Math.min(...ray.pts.map((p) => dist(p, T))) < 4) return null;

  // try mirror positions along the free path
  type Hit = { s: number; a: number; placement: Placement; source: number };
  const hits: Hit[] = [];
  for (const [ri, ray] of free.rays.entries()) {
  let travelled = 0;
  let next = 3;
  let found = 0; // per beam, so a second station gets searched too
  for (let i = 1; i < ray.pts.length && travelled < 60 && found < 30; i++) {
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
      const win = res.rays.find((x) => x.result === 'hit');
      // the winning beam itself must bounce off the moon's mirror (not only fixed ones, and not a
      // second station's beam that the moon's gravity happened to bend into the beacon)
      if (win && win.pts.some((q) => q.bounce && !q.fixed) && ++found <= 30) hits.push({ s: ri * 1000 + Math.round(travelled), a, placement, source: win.source });
    }
  }
  }
  // with a relay, only shots that need it count (without it they fade out)
  if (level.relays?.length) {
    const noRelay = { ...level, relays: [] };
    hits.splice(0, hits.length, ...hits.filter((h) => trace(noRelay, h.placement).result !== 'hit'));
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
  // a fixed mirror must take part: either the free beam or the solution bounces off it
  if (level.mirrors?.length) {
    const fixedBounce = (res: ReturnType<typeof trace>) => res.rays.some((ray) => ray.pts.some((q) => q.fixed));
    if (!fixedBounce(free) && !fixedBounce(trace(level, best.placement))) return null;
  }
  return { solution: best.placement, solutions: hits.length, solvable: [...new Set(hits.map((h) => h.source))].sort() };
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

const hasFeature = (level: Level, f: Feature): boolean => {
  switch (f) {
    case 'plain': return true;
    case 'blackhole': return level.bodies.some((b) => b.kind === 'blackhole');
    case 'repulsor': return level.bodies.some((b) => b.kind === 'repulsor');
    case 'splitter': return level.splitters.length > 0;
    case 'wormhole': return level.wormholes.length > 0;
    case 'mirrors': return (level.mirrors?.length ?? 0) > 0;
    case 'twin': return (level.extraEmitters?.length ?? 0) > 0;
    case 'relay': return (level.relays?.length ?? 0) > 0 && !!level.range;
  }
};

/** Every orbiting moon is back at its start after this many seconds. */
export const ORBIT_PERIOD = 240;

/**
 * Sets the moons going round their planets, once a level is solved. Their speed comes from its own
 * random stream and orbit time 0 is the board the solver checked, so the puzzle itself is unchanged.
 * A planet's moons share one orbit, so they turn together (40 to 80 seconds a lap, either way).
 * A planet keeps still moons if their orbit would cross the solution or the moon's start, or if
 * the start could then win on its own at some moment.
 */
function addOrbits(day: string, level: Level, solution: Placement) {
  const r = rng(hash(`${day}:orbits`));
  const systems = new Map<string, Body[]>();
  for (const b of level.bodies) {
    if (b.kind !== 'moonlet' || !b.orbit) continue;
    const key = `${b.orbit.x},${b.orbit.z}`;
    systems.set(key, [...(systems.get(key) ?? []), b]);
  }
  if (!systems.size) return;
  level.orbitPeriod = ORBIT_PERIOD;
  const legal = (p: Vec) => dist(constrainMoon(level, p), p) <= 0.005;
  const moments = Array.from({ length: 16 }, (_, i) => (i * ORBIT_PERIOD) / 16);
  for (const moons of systems.values()) {
    const laps = (3 + Math.floor(r() * 4)) * (r() < 0.5 ? -1 : 1);
    for (const m of moons) m.orbit!.laps = laps;
    const c = constrainMoon(level, level.moon.start);
    const start = { x: round(c.x), z: round(c.z) };
    const ok = legal(solution.moon) && legal(start) &&
      moments.every((t) => trace(level, { moon: start, angle: level.moon.startAngle, t }).result !== 'hit');
    if (ok) level.moon.start = start;
    else for (const m of moons) delete m.orbit!.laps;
  }
  if (!level.bodies.some((b) => b.orbit?.laps)) delete level.orbitPeriod;
}

export function generateLevel(day: string): Generated {
  const features = featuresFor(day);
  for (let attempt = 0; attempt < 80; attempt++) {
    // after many failed tries, drop the second piece, then fall back to a plain level for the day
    const fs: Feature[] = attempt < 60 ? (attempt < 40 ? features : features.slice(0, 1)) : ['plain'];
    const level = buildCandidate(day, attempt, fs);
    if (!fs.every((f) => hasFeature(level, f))) continue;
    // every board has at least two gravity bodies (giant or sun, plus a planet)
    if (!level.bodies.some((b) => b.kind === 'planet')) continue;
    const ok = validate(level);
    if (ok) addOrbits(day, level, ok.solution);
    if (ok) return { level, solution: ok.solution, solutions: ok.solutions, solvable: ok.solvable, attempts: attempt + 1 };
  }
  return { level: FALLBACK_LEVEL(day), solution: { moon: { x: 10, z: 3 }, angle: 230 }, solutions: 0, attempts: 80 };
}
