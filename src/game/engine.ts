// Pure game logic shared by the browser (preview, animation) and the server (authoritative shots).
// Everything happens in the x/z plane; the 3D scene renders it at y = 0.

export type Vec = { x: number; z: number };
export type BodyKind = 'giant' | 'planet' | 'blackhole';
export type Body = Vec & { r: number; m: number; name: string; kind: BodyKind };
export type Rock = Vec & { r: number };
/** A crystal that lets light through and also reflects a copy. angle = normal direction in degrees. */
export type Splitter = Vec & { angle: number; half: number };
/** Light entering one mouth leaves the other with the same direction. */
export type Wormhole = { a: Vec; b: Vec; r: number };

export type Level = {
  day: string; // UTC date, YYYY-MM-DD
  number: number; // puzzle number since launch
  emitter: Vec & { dir: number }; // dir in radians
  target: Vec & { r: number };
  bodies: Body[];
  rocks: Rock[];
  splitters: Splitter[];
  wormholes: Wormhole[];
  moon: { r: number; m: number; name: string; start: Vec; startAngle: number };
  mirrorHalf: number;
  bounds: { x: number; z: number };
};

/** angle values are in degrees, 0..359 */
export type Placement = {
  moon: Vec;
  angle: number;
  satellite?: (Vec & { angle: number }) | null;
};

/** `jump` marks the first point after a wormhole exit (no line is drawn into it). */
export type TracePoint = Vec & { bounce?: boolean; jump?: boolean };
export type Outcome = 'hit' | 'absorbed' | 'rock' | 'lost';
export type Ray = {
  pts: TracePoint[];
  /** distance travelled by light before this ray started (for animation and preview) */
  start: number;
  /** cumulative distance at each point, starting at `start` */
  dist: number[];
  result: Outcome;
  hitName: string | null;
  bounces: number;
};
export type TraceResult = {
  rays: Ray[];
  result: Outcome;
  bounces: number;
  hitName: string | null;
};

export const MOON_MIRROR_OFFSET = 0.12;
export const SATELLITE_RADIUS = 0.6;
export const MAX_RAYS = 6;

type Segment = { a: Vec; b: Vec; n: Vec };

export function mirrorSegment(center: Vec, angleDeg: number, offset: number, half: number): Segment {
  const t = (angleDeg * Math.PI) / 180;
  const n = { x: Math.cos(t), z: Math.sin(t) };
  const c = { x: center.x + n.x * offset, z: center.z + n.z * offset };
  const tan = { x: -n.z, z: n.x };
  return {
    a: { x: c.x - tan.x * half, z: c.z - tan.z * half },
    b: { x: c.x + tan.x * half, z: c.z + tan.z * half },
    n,
  };
}

/** Returns the crossing point of segment p→q with segment s, or null. */
function cross(p: Vec, q: Vec, s: Segment): Vec | null {
  const d1x = q.x - p.x, d1z = q.z - p.z, d2x = s.b.x - s.a.x, d2z = s.b.z - s.a.z;
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((s.a.x - p.x) * d2z - (s.a.z - p.z) * d2x) / den;
  const u = ((s.a.x - p.x) * d1z - (s.a.z - p.z) * d1x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: p.x + d1x * t, z: p.z + d1z * t } : null;
}

type Pending = { p: Vec; v: Vec; start: number; ignore: string | null };

export function trace(level: Level, placement: Placement, maxSteps = 3600): TraceResult {
  const bodies: Body[] = [
    ...level.bodies,
    { x: placement.moon.x, z: placement.moon.z, r: level.moon.r, m: level.moon.m, name: level.moon.name, kind: 'planet' },
  ];
  const mirrors: Segment[] = [mirrorSegment(placement.moon, placement.angle, level.moon.r + MOON_MIRROR_OFFSET, level.mirrorHalf)];
  if (placement.satellite) mirrors.push(mirrorSegment(placement.satellite, placement.satellite.angle, 0, level.mirrorHalf));
  const splitters = (level.splitters ?? []).map((s) => mirrorSegment(s, s.angle, 0, s.half));
  const holes = level.wormholes ?? [];

  const e = level.emitter;
  const queue: Pending[] = [{
    p: { x: e.x + Math.cos(e.dir) * 1.4, z: e.z + Math.sin(e.dir) * 1.4 },
    v: { x: Math.cos(e.dir), z: Math.sin(e.dir) },
    start: 0,
    ignore: null,
  }];
  const rays: Ray[] = [];
  const dt = 0.05;

  while (queue.length && rays.length < MAX_RAYS) {
    const job = queue.shift()!;
    let p = { ...job.p };
    const v = { ...job.v };
    let travelled = job.start;
    const pts: TracePoint[] = [{ ...p }];
    const dist: number[] = [travelled];
    const push = (pt: TracePoint) => { pts.push(pt); dist.push(travelled); };
    let result: Outcome = 'lost';
    let hitName: string | null = null;
    let bounces = 0;
    // the object last interacted with is ignored for a few steps so a ray cannot re-trigger it
    let ignore: string | null = job.ignore;
    let ignoreUntil = job.ignore ? 4 : -1;

    for (let i = 0; i < maxSteps; i++) {
      if (i > ignoreUntil) ignore = null;
      let ax = 0, az = 0;
      for (const B of bodies) {
        const dx = B.x - p.x, dz = B.z - p.z, r2 = dx * dx + dz * dz + 0.25;
        const inv = B.m / (r2 * Math.sqrt(r2));
        ax += dx * inv;
        az += dz * inv;
      }
      v.x += ax * dt;
      v.z += az * dt;
      const s = Math.hypot(v.x, v.z);
      v.x /= s;
      v.z /= s;
      const q = { x: p.x + v.x * dt, z: p.z + v.z * dt };

      // mirrors reflect
      let handled = false;
      for (let mi = 0; mi < mirrors.length && !handled; mi++) {
        const id = `m${mi}`;
        if (ignore === id) continue;
        const h = cross(p, q, mirrors[mi]);
        if (!h) continue;
        travelled += Math.hypot(h.x - p.x, h.z - p.z);
        push({ ...h, bounce: true });
        const n = mirrors[mi].n, dot = v.x * n.x + v.z * n.z;
        v.x -= 2 * dot * n.x;
        v.z -= 2 * dot * n.z;
        p = { x: h.x + v.x * 0.02, z: h.z + v.z * 0.02 };
        bounces++;
        ignore = id;
        ignoreUntil = i + 4;
        handled = true;
      }
      if (handled) continue;

      // splitters pass light through and send a reflected copy
      for (let si = 0; si < splitters.length && !handled; si++) {
        const id = `s${si}`;
        if (ignore === id) continue;
        const h = cross(p, q, splitters[si]);
        if (!h) continue;
        travelled += Math.hypot(h.x - p.x, h.z - p.z);
        push({ ...h });
        const n = splitters[si].n, dot = v.x * n.x + v.z * n.z;
        const rv = { x: v.x - 2 * dot * n.x, z: v.z - 2 * dot * n.z };
        if (rays.length + queue.length + 1 < MAX_RAYS) {
          queue.push({ p: { x: h.x + rv.x * 0.02, z: h.z + rv.z * 0.02 }, v: rv, start: travelled, ignore: id });
        }
        p = { x: h.x + v.x * 0.02, z: h.z + v.z * 0.02 };
        ignore = id;
        ignoreUntil = i + 4;
        handled = true;
      }
      if (handled) continue;

      travelled += dt;
      p = q;

      // wormholes teleport
      for (let wi = 0; wi < holes.length && !handled; wi++) {
        const w = holes[wi];
        for (const [from, to, id] of [[w.a, w.b, `w${wi}a`], [w.b, w.a, `w${wi}b`]] as const) {
          if (ignore === id || Math.hypot(p.x - from.x, p.z - from.z) >= w.r) continue;
          push({ x: from.x, z: from.z });
          p = { x: to.x + v.x * (w.r + 0.15), z: to.z + v.z * (w.r + 0.15) };
          pts.push({ x: to.x, z: to.z, jump: true });
          dist.push(travelled);
          ignore = id === `w${wi}a` ? `w${wi}b` : `w${wi}a`;
          ignoreUntil = i + Math.ceil((w.r * 3) / dt);
          handled = true;
          break;
        }
      }
      if (handled) { push({ ...p }); continue; }

      if (i % 2 === 0) push({ ...p });
      if (Math.hypot(p.x - level.target.x, p.z - level.target.z) < level.target.r) {
        result = 'hit';
        push({ ...p });
        break;
      }
      let dead = false;
      for (const B of bodies) {
        if (Math.hypot(p.x - B.x, p.z - B.z) < B.r) {
          result = 'absorbed';
          hitName = B.name;
          dead = true;
          break;
        }
      }
      if (!dead) {
        for (const R of level.rocks) {
          if (Math.hypot(p.x - R.x, p.z - R.z) < R.r) {
            result = 'rock';
            dead = true;
            break;
          }
        }
      }
      if (dead) {
        push({ ...p });
        break;
      }
      if (Math.abs(p.x) > level.bounds.x + 6 || Math.abs(p.z) > level.bounds.z + 6) break;
    }
    rays.push({ pts, start: job.start, dist, result, hitName, bounces });
  }

  const winner = rays.find((r) => r.result === 'hit');
  const main = winner ?? rays[0];
  return { rays, result: main.result, bounces: main.bounces, hitName: main.hitName };
}

/** Keeps a draggable object inside the board and out of fixed objects. Used by client and server. */
export function constrainMoon(level: Level, pos: Vec, radius = level.moon.r): Vec {
  let x = Math.max(-level.bounds.x + 3, Math.min(level.bounds.x - 3, pos.x));
  let z = Math.max(-level.bounds.z + 3, Math.min(level.bounds.z - 3, pos.z));
  const blockers = [
    ...level.bodies.map((B) => ({ x: B.x, z: B.z, r: B.r + radius + (B.kind === 'blackhole' ? 2.2 : 1.2) })),
    { x: level.emitter.x, z: level.emitter.z, r: 4 },
    { x: level.target.x, z: level.target.z, r: level.target.r + radius + 1.6 },
    ...level.rocks.map((R) => ({ x: R.x, z: R.z, r: R.r + radius + 0.4 })),
    ...(level.splitters ?? []).map((S) => ({ x: S.x, z: S.z, r: S.half + radius + 0.4 })),
    ...(level.wormholes ?? []).flatMap((W) => [W.a, W.b].map((m) => ({ x: m.x, z: m.z, r: W.r + radius + 0.6 }))),
  ];
  for (let k = 0; k < 4; k++) {
    for (const B of blockers) {
      let dx = x - B.x, dz = z - B.z;
      let d = Math.hypot(dx, dz);
      if (d < 1e-6) { dx = 1; dz = 0; d = 1; } // exactly on a centre: push out along +x
      if (d < B.r) {
        x = B.x + (dx / d) * B.r;
        z = B.z + (dz / d) * B.r;
      }
    }
  }
  return { x, z };
}

/** The scanner helper shows this much more of the aiming line. */
export const SCANNER_BOOST = 1.2;

/** How far (in light-travel distance from the emitter) the dashed aiming line reaches. */
export function previewLimit(res: TraceResult, scanner: boolean): number {
  // normally: 15 units, or just past the first mirror bounce if that comes sooner
  const main = res.rays[0];
  let limit = 15;
  const firstBounce = main.pts.findIndex((p, i) => i > 0 && p.bounce);
  if (firstBounce > 0) limit = Math.min(limit, main.dist[firstBounce] + 4.5);
  return scanner ? limit * SCANNER_BOOST : limit;
}

/** Index of the last point of `ray` within light-travel distance `d` (-1 if the ray starts later). */
export function indexAt(ray: Ray, d: number): number {
  if (d < ray.start) return -1;
  let lo = 0, hi = ray.dist.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ray.dist[mid] <= d) lo = mid; else hi = mid - 1;
  }
  return lo;
}
