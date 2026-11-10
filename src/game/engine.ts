// Pure game logic shared by the browser (preview, animation) and the server (authoritative shots).
// Everything happens in the x/z plane; the 3D scene renders it at y = 0.

export type Vec = { x: number; z: number };
export type Body = Vec & { r: number; m: number; name: string; kind: 'giant' | 'planet' };
export type Rock = Vec & { r: number };

export type Level = {
  day: string; // UTC date, YYYY-MM-DD
  number: number; // puzzle number since launch
  emitter: Vec & { dir: number }; // dir in radians
  target: Vec & { r: number };
  bodies: Body[];
  rocks: Rock[];
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

export type TracePoint = Vec & { bounce?: boolean };
export type TraceResult = {
  pts: TracePoint[];
  result: 'hit' | 'absorbed' | 'rock' | 'lost';
  bounces: number;
  hitName: string | null;
};

export const MOON_MIRROR_OFFSET = 0.12;
export const SATELLITE_RADIUS = 0.6;

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

export function trace(level: Level, placement: Placement, maxSteps = 3600): TraceResult {
  const bodies: Body[] = [
    ...level.bodies,
    { x: placement.moon.x, z: placement.moon.z, r: level.moon.r, m: level.moon.m, name: level.moon.name, kind: 'planet' },
  ];
  const mirrors: Segment[] = [mirrorSegment(placement.moon, placement.angle, level.moon.r + MOON_MIRROR_OFFSET, level.mirrorHalf)];
  if (placement.satellite) mirrors.push(mirrorSegment(placement.satellite, placement.satellite.angle, 0, level.mirrorHalf));

  const e = level.emitter;
  let p: Vec = { x: e.x + Math.cos(e.dir) * 1.4, z: e.z + Math.sin(e.dir) * 1.4 };
  const v: Vec = { x: Math.cos(e.dir), z: Math.sin(e.dir) };
  const dt = 0.05;
  const pts: TracePoint[] = [{ ...p }];
  let bounces = 0;
  let result: TraceResult['result'] = 'lost';
  let hitName: string | null = null;
  let lastMirror = -1;
  let lastBounceStep = -99;

  for (let i = 0; i < maxSteps; i++) {
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

    let bounced = false;
    for (let mi = 0; mi < mirrors.length; mi++) {
      if (mi === lastMirror && i - lastBounceStep <= 3) continue;
      const { a, b, n } = mirrors[mi];
      const d1x = q.x - p.x, d1z = q.z - p.z, d2x = b.x - a.x, d2z = b.z - a.z;
      const den = d1x * d2z - d1z * d2x;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((a.x - p.x) * d2z - (a.z - p.z) * d2x) / den;
      const u = ((a.x - p.x) * d1z - (a.z - p.z) * d1x) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        const hx = p.x + d1x * t, hz = p.z + d1z * t;
        pts.push({ x: hx, z: hz, bounce: true });
        const dot = v.x * n.x + v.z * n.z;
        v.x -= 2 * dot * n.x;
        v.z -= 2 * dot * n.z;
        p = { x: hx + v.x * 0.02, z: hz + v.z * 0.02 };
        bounces++;
        lastMirror = mi;
        lastBounceStep = i;
        bounced = true;
        break;
      }
    }
    if (bounced) continue;

    p = q;
    if (i % 2 === 0) pts.push({ ...p });
    if (Math.hypot(p.x - level.target.x, p.z - level.target.z) < level.target.r) {
      result = 'hit';
      pts.push({ ...p });
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
      pts.push({ ...p });
      break;
    }
    if (Math.abs(p.x) > level.bounds.x + 6 || Math.abs(p.z) > level.bounds.z + 6) break;
  }
  return { pts, result, bounces, hitName };
}

/** Keeps a draggable object inside the board and out of fixed objects. Used by client and server. */
export function constrainMoon(level: Level, pos: Vec, radius = level.moon.r): Vec {
  let x = Math.max(-level.bounds.x + 3, Math.min(level.bounds.x - 3, pos.x));
  let z = Math.max(-level.bounds.z + 3, Math.min(level.bounds.z - 3, pos.z));
  const blockers = [
    ...level.bodies.map((B) => ({ x: B.x, z: B.z, r: B.r + radius + 1.2 })),
    { x: level.emitter.x, z: level.emitter.z, r: 4 },
    { x: level.target.x, z: level.target.z, r: level.target.r + radius + 1.6 },
    ...level.rocks.map((R) => ({ x: R.x, z: R.z, r: R.r + radius + 0.4 })),
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

/** How far the dashed aiming line reaches. */
export function previewCut(res: TraceResult, longRange: boolean): number {
  let len = 0;
  let seenBounces = 0;
  let limit = longRange ? 46 : 15;
  for (let i = 1; i < res.pts.length; i++) {
    const p = res.pts[i], o = res.pts[i - 1];
    len += Math.hypot(p.x - o.x, p.z - o.z);
    if (p.bounce) {
      seenBounces++;
      if (!longRange && seenBounces === 1) limit = Math.min(limit, len + 4.5);
      if (longRange && seenBounces === 2) limit = Math.min(limit, len + 8);
    }
    if (len > limit) return i;
  }
  return res.pts.length - 1;
}
