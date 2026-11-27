import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { bodiesAt, constrainMoon, orbitClock, previewLimit, trace, withDestroyed, type Level } from '@/game/engine';
import { generateLevel, featuresFor, FALLBACK_LEVEL, ORBIT_PERIOD } from '@/game/generate';
import { scoreFor, puzzleNumber, shareText, msUntilNextPuzzle, missText } from '@/game/rules';
import { MemoryStore, getStore as getStoreForTest, setStoreForTests, nextStreak, liveStreak, rankEntries, windowStart } from '@/server/store';
import { isJsonRequest, pickPid, pidCookieOptions } from '@/server/pid';
import { autoName, cleanName, parsePlacement, leaderboard, levelFor, setName, shoot, today, applyHelper, archive, checkClock, resolveDay, voyage, voyageShot, voyageLevelFor, GameError, VOYAGE_MIN_SOLVE_MS, CLOCK_SLACK, MIN_SOLVE_MS } from '@/server/game';
import { voyageSpec, voyageStars, PREBUILT } from '@/game/voyage';
import prebuilt from '@/game/voyage-levels.json';

const DAY = '2026-11-10';
// a fixed moment, long after any test's real clock, when the shared orbit clock reads 0
const NOW = ORBIT_PERIOD * 1000 * 10_000_000;

describe('rules', () => {
  test('score depends on shot and helpers', () => {
    expect(scoreFor(1, [])).toBe(1000);
    expect(scoreFor(2, [])).toBe(700);
    expect(scoreFor(3, ['scanner'])).toBe(250);
    expect(scoreFor(3, ['scanner', 'satellite', 'energized'])).toBe(50);
    expect(scoreFor(1, ['energized', 'energized'])).toBe(800);
    expect(scoreFor(1, ['ghost'])).toBe(700); // retired helper still scores for plays that used it
  });
  test('calendar', () => {
    expect(puzzleNumber('2026-11-10')).toBe(1);
    expect(puzzleNumber('2027-11-10')).toBe(366);
    expect(msUntilNextPuzzle(new Date('2026-11-10T23:00:00Z'))).toBe(3600000);
  });
  test('share text', () => {
    expect(shareText({ number: 4, shots: ['rock', 'hit'], score: 550, helpers: ['scanner'] })).toBe('ORBIT #4 🪐\n🟥🟩⬛  550 pts\nhelpers 📡\norbitpuzzle.com');
  });
});

describe('generator', () => {
  test('is deterministic, varied and solvable across many days', async () => {
    setStoreForTests(new MemoryStore());
    expect(JSON.stringify(generateLevel(DAY))).toBe(JSON.stringify(generateLevel(DAY)));
    const kinds = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const day = new Date(Date.UTC(2026, 10, 10 + i)).toISOString().slice(0, 10);
      await new Promise((r) => setTimeout(r, 0)); // let the test runner breathe between heavy generations
      const g = await levelFor(day);
      for (const f of featuresFor(day)) kinds.add(f);
      const start = trace(g.level, { moon: g.level.moon.start, angle: g.level.moon.startAngle });
      // the starting spot and the solution must both be accepted by the server
      expect(() => parsePlacement(g.level, { moon: g.level.moon.start, angle: g.level.moon.startAngle }, []), day).not.toThrow();
      expect(() => parsePlacement(g.level, g.solution, []), day).not.toThrow();
      expect(start.result, day).not.toBe('hit');
      const sol = trace(g.level, g.solution);
      expect(sol.result, day).toBe('hit');
      expect(sol.bounces, day).toBeGreaterThan(0);
      expect(sol.rays.find((r) => r.result === 'hit')!.pts.some((p) => p.bounce && !p.fixed), day).toBe(true);
    }
    expect([...kinds].sort()).toEqual(['blackhole', 'mirrors', 'plain', 'relay', 'repulsor', 'splitter', 'twin', 'wormhole']);
  }, 240000);
});

describe('seed secret', () => {
  test('a secret gives a different, still solvable board that the public generator cannot reproduce', () => {
    const open = generateLevel(DAY);
    const secret = generateLevel(DAY, 'test-secret');
    expect(JSON.stringify(secret.level)).not.toBe(JSON.stringify(open.level));
    expect(JSON.stringify(generateLevel(DAY, 'test-secret'))).toBe(JSON.stringify(secret));
    expect(secret.level.day).toBe(DAY);
    expect(trace(secret.level, secret.solution).result).toBe('hit');
    // the solution read from the public generator does not solve the real board
    expect(trace(secret.level, open.solution).result).not.toBe('hit');
  }, 60000);
});

describe('board variety', () => {
  test('days vary planets, gravity, stations, moons, mirrors and sides', () => {
    const seen = { giant: new Set<string>(), emitter: new Set<string>(), moon: new Set<string>(), side: new Set<string>(), mirror: new Set<string>() };
    for (let i = 1; i <= 15; i++) {
      const { level } = generateLevel(new Date(Date.UTC(2026, 10, 10 + i)).toISOString().slice(0, 10));
      const giant = level.bodies.find((b) => b.kind === 'giant' || b.kind === 'sun')!;
      seen.giant.add(String(giant.style));
      seen.emitter.add(String(level.emitter.style));
      seen.moon.add(String(level.moon.style));
      seen.side.add(level.emitter.x < 0 ? 'left' : 'right');
      seen.mirror.add(level.mirrorHalf < 1.35 ? 'small' : level.mirrorHalf > 1.65 ? 'wide' : 'normal');
    }
    expect(seen.giant.size).toBeGreaterThanOrEqual(4);
    expect(seen.emitter.size).toBe(3);
    expect(seen.moon.size).toBe(3);
    expect(seen.side.size).toBe(2);
    expect(seen.mirror.size).toBe(3);
  }, 120000);
});

describe('star systems', () => {
  test('days always have at least two gravity bodies, and some have suns and moons', () => {
    let suns = 0, moons = 0;
    for (let i = 3; i <= 17; i++) {
      const day = new Date(Date.UTC(2026, 10, 10 + i)).toISOString().slice(0, 10);
      const { level, solution } = generateLevel(day);
      const massive = level.bodies.filter((b) => b.kind !== 'moonlet');
      expect(massive.length, day).toBeGreaterThanOrEqual(2);
      expect(level.bodies.some((b) => b.kind === 'planet'), day).toBe(true);
      expect(trace(level, solution).result, day).toBe('hit');
      for (const m of level.bodies.filter((b) => b.kind === 'moonlet')) {
        expect(Math.hypot(m.x - m.orbit!.x, m.z - m.orbit!.z)).toBeCloseTo(m.orbit!.r, 1); // sits on its orbit
      }
      if (level.bodies.some((b) => b.kind === 'sun')) suns++;
      moons += level.bodies.filter((b) => b.kind === 'moonlet').length;
    }
    expect(suns).toBeGreaterThan(0);
    expect(moons).toBeGreaterThan(0);
  }, 180000);
});

describe('orbiting moons', () => {
  // beam along +x from (-20, 0); a moon orbits (0, 3) at radius 3, starting right on the beam at (0, 0)
  const moonlet = { x: 0, z: 0, r: 0.6, m: 0.05, name: 'Nim I', kind: 'moonlet' as const, orbit: { x: 0, z: 3, r: 3, laps: 4 } };
  const level: Level = {
    ...FALLBACK_LEVEL(DAY), emitter: { x: -20, z: 0, dir: 0 }, target: { x: 20, z: 0, r: 1.5 }, bodies: [moonlet], rocks: [], splitters: [], wormholes: [], orbitPeriod: 240,
  };
  const farMoon = { moon: { x: -25, z: 20 }, angle: 0 };

  test('moons go round their planet and are back at the start after a period', () => {
    expect(bodiesAt(level, 0)).toBe(level.bodies);
    const half = bodiesAt(level, 240 / 8)[0]; // half a lap
    expect(half.x).toBeCloseTo(0, 6); expect(half.z).toBeCloseTo(6, 6);
    const quarter = bodiesAt(level, 240 / 16)[0];
    expect(Math.hypot(quarter.x, quarter.z - 3)).toBeCloseTo(3, 6);
    const lap = bodiesAt(level, 240)[0];
    expect(lap.x).toBeCloseTo(0, 6); expect(lap.z).toBeCloseTo(0, 6);
    // levels without an orbit period keep their moons still
    expect(bodiesAt({ ...level, orbitPeriod: undefined }, 30)).toBe(level.bodies);
  });

  test('the shot depends on where the moon is when you fire', () => {
    expect(trace(level, { ...farMoon, t: 0 })).toMatchObject({ result: 'absorbed', hitName: 'Nim I' });
    expect(trace(level, { ...farMoon, t: 30 }).result).toBe('hit');
  });

  test('the orbit clock wraps every period, in hundredths of a second', () => {
    expect(orbitClock(level, 0)).toBe(0);
    expect(orbitClock(level, 1234567)).toBe(34.56);
    expect(orbitClock(level, 240000)).toBe(0);
    expect(orbitClock(level, 20000, 0.5)).toBe(10);
    expect(orbitClock({ ...level, orbitPeriod: undefined }, 1234567)).toBe(0);
  });

  test('nothing can be placed on an orbiting moon\'s path', () => {
    const p = constrainMoon(level, { x: 0, z: 6 }, 1);
    expect(Math.hypot(p.x, p.z - 3)).toBeGreaterThanOrEqual(3 + 0.6 + 1 + 0.4 - 1e-9);
    // a still moon only blocks the spot it sits on
    const still = { ...level, bodies: [{ ...moonlet, orbit: { x: 0, z: 3, r: 3 } }] };
    expect(constrainMoon(still, { x: 0, z: 6 }, 1)).toEqual({ x: 0, z: 6 });
  });

  test('the server checks the orbit time and traces the shot at it', () => {
    expect(parsePlacement(level, { ...farMoon, t: 30.004 }, [])).toMatchObject({ t: 30 });
    expect(parsePlacement(level, farMoon, [])).toMatchObject({ t: 0 });
    for (const t of [-1, 240, Infinity, '3']) expect(() => parsePlacement(level, { ...farMoon, t }, []), String(t)).toThrow('Invalid shot');
    // no orbits today: the time is ignored
    expect(parsePlacement({ ...level, orbitPeriod: undefined }, { ...farMoon, t: 99 }, [])).not.toHaveProperty('t');
  });

  test('daily moons orbit without changing the puzzle', () => {
    let orbiting = 0;
    for (let i = 3; i <= 17; i++) {
      const day = new Date(Date.UTC(2026, 10, 10 + i)).toISOString().slice(0, 10);
      const { level: L, solution } = generateLevel(day);
      const movers = L.bodies.filter((b) => b.orbit?.laps);
      if (!movers.length) { expect(L.orbitPeriod, day).toBeUndefined(); continue; }
      orbiting++;
      expect(L.orbitPeriod).toBe(ORBIT_PERIOD);
      for (const m of movers) expect(Math.abs(m.orbit!.laps!), day).toBeGreaterThanOrEqual(3);
      // the solved board is orbit time 0, and the start never wins on its own at any moment
      expect(trace(L, { ...solution, t: 0 }).result, day).toBe('hit');
      for (let t = 0; t < ORBIT_PERIOD; t += 7.5) {
        expect(trace(L, { moon: L.moon.start, angle: L.moon.startAngle, t }).result, `${day} t=${t}`).not.toBe('hit');
      }
      expect(() => parsePlacement(L, solution, []), day).not.toThrow();
      expect(() => parsePlacement(L, { moon: L.moon.start, angle: L.moon.startAngle }, []), day).not.toThrow();
    }
    expect(orbiting).toBeGreaterThan(0);
  }, 180000);
});

describe('pieces', () => {
  // a bare level: beam fires along +x from (-20, 0) toward a beacon at (20, 0)
  const bare = (extra: Partial<Level>): Level => ({
    ...FALLBACK_LEVEL(DAY), emitter: { x: -20, z: 0, dir: 0 }, target: { x: 20, z: 0, r: 1.5 }, bodies: [], rocks: [], splitters: [], wormholes: [], ...extra,
  });
  const farMoon = { moon: { x: -25, z: 20 }, angle: 0 };

  test('black holes swallow light', () => {
    const res = trace(bare({ bodies: [{ x: 0, z: 0.5, r: 0.9, m: 1.5, name: 'Nyx', kind: 'blackhole' }] }), farMoon);
    expect(res).toMatchObject({ result: 'absorbed', hitName: 'Nyx' });
  });

  test('splitters create a second, reflected beam', () => {
    // normal at 135° turns the reflected copy towards +z; a beacon there is lit by the copy
    const level = bare({ target: { x: 0, z: 15, r: 1.5 }, splitters: [{ x: 0, z: 0, angle: 135, half: 1.3 }] });
    const res = trace(level, farMoon);
    expect(res.rays.length).toBe(2);
    expect(res.result).toBe('hit');
    expect(res.rays[1].start).toBeGreaterThan(15);
  });

  test('asteroids hit by the beam are reported, and destroyed ones stop blocking', () => {
    const level = bare({ rocks: [{ x: 0, z: 0, r: 1 }, { x: 5, z: 6, r: 1 }] });
    const blocked = trace(level, farMoon);
    expect(blocked).toMatchObject({ result: 'rock', rocksHit: [0] });
    const cleared = withDestroyed(level, [0]);
    expect(cleared.rocks).toEqual([{ x: 5, z: 6, r: 1, id: 1 }]);
    expect(trace(cleared, farMoon).result).toBe('hit');
  });


  test('fixed mirrors bounce the beam', () => {
    // normal at 135° turns a beam heading +x towards +z
    const level = bare({ target: { x: 0, z: 15, r: 1.5 }, mirrors: [{ x: 0, z: 0, angle: 135, half: 1.5 }] });
    const res = trace(level, farMoon);
    expect(res).toMatchObject({ result: 'hit', bounces: 1 });
    expect(res.rays.length).toBe(1);
  });

  test('a beam that fades after the relay is told so, not sent back to the relay', () => {
    const noRelay = bare({ range: 25 });
    expect(missText(noRelay, trace(noRelay, farMoon))).toBe('The light faded out. Pass the relay ring to recharge it.');
    // the ring sits early on the beam: it recharges the light, which still runs out before the beacon
    const early = bare({ range: 25, relays: [{ x: -15, z: 0, r: 1.2 }] });
    const res = trace(early, farMoon);
    expect(res.result).toBe('faded');
    expect(missText(early, res)).toBe('The relay recharged the light, but it faded again 25 units later. Bounce it towards the beacon sooner.');
  });

  test('light fades after its range, and a relay ring recharges it', () => {
    const faded = trace(bare({ range: 25 }), farMoon);
    expect(faded.result).toBe('faded');
    const f = faded.rays[0].fuel;
    expect(f[0]).toBeGreaterThan(0.9);
    expect(f[f.length - 1]).toBeLessThan(0.05);
    const relayed = trace(bare({ range: 25, relays: [{ x: -2, z: 0, r: 1.2 }] }), farMoon);
    expect(relayed.result).toBe('hit');
    expect(relayed.rays[0].pts.some((p) => p.relay)).toBe(true);
    // without a range set, light never fades
    expect(trace(bare({}), farMoon).result).toBe('hit');
  });

  test('every laser station fires, and a beam from any of them can win', () => {
    // the main station misses wide; a second station aims straight at the beacon
    const level = bare({ emitter: { x: -20, z: 15, dir: 0 }, extraEmitters: [{ x: -20, z: 0, dir: 0 }] });
    const res = trace(level, farMoon);
    expect(res.rays.map((r) => r.source)).toEqual([0, 1]);
    expect(res.rays[0].result).toBe('lost');
    expect(res).toMatchObject({ result: 'hit' });
  });

  test('the aiming line keeps going past fixed mirrors', () => {
    const level = bare({ target: { x: 0, z: 25, r: 1.5 }, mirrors: [{ x: -14, z: 0, angle: 135, half: 1.5 }] });
    const res = trace(level, farMoon);
    expect(res.rays[0].pts.some((p) => p.fixed)).toBe(true);
    expect(previewLimit(res, false)).toBe(15);
  });

  test('repulsors push light away', () => {
    // a repulsor just below the line pushes the beam up (+z), so it misses a beacon dead ahead
    const level = bare({ bodies: [{ x: 0, z: -1.5, r: 0.8, m: -1, name: 'Aegis', kind: 'repulsor' }] });
    const res = trace(level, farMoon);
    expect(res.result).not.toBe('hit');
    const end = res.rays[0].pts[res.rays[0].pts.length - 1];
    expect(end.z).toBeGreaterThan(1.5);
  });

  test('wormholes carry light to the other mouth', () => {
    const level = bare({ target: { x: 10, z: 12, r: 1.5 }, wormholes: [{ a: { x: -5, z: 0 }, b: { x: -5, z: 12 }, r: 1.1 }] });
    const res = trace(level, farMoon);
    expect(res.result).toBe('hit');
    expect(res.rays[0].pts.some((p) => p.jump)).toBe(true);
  });
});

describe('new pieces in daily levels', () => {
  test('relays are needed, fixed mirrors take part, twin stations work, and some days have two pieces', () => {
    let pairs = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const day = new Date(Date.UTC(2026, 10, 14 + i)).toISOString().slice(0, 10);
      const fs = featuresFor(day);
      if (fs.length === 2) pairs++;
      if (!fs.some((f) => f === 'relay' || f === 'mirrors' || f === 'twin')) continue;
      const { level, solution } = generateLevel(day);
      expect(trace(level, solution).result, day).toBe('hit');
      if (level.relays?.length) {
        seen.add('relay');
        expect(level.range, day).toBeGreaterThan(0);
        expect(trace({ ...level, relays: [] }, solution).result, day).not.toBe('hit');
      }
      if (level.mirrors?.length) seen.add('mirrors');
      if (level.extraEmitters?.length) seen.add('twin');
    }
    expect(pairs).toBeGreaterThan(0);
    expect([...seen].sort()).toEqual(['mirrors', 'relay', 'twin']);
  }, 240000);
});

describe('aiming line', () => {
  test('the scanner shows only 20% more of the aiming line', () => {
    const g = generateLevel(DAY);
    const res = trace(g.level, g.solution);
    const normal = previewLimit(res, false);
    expect(normal).toBeLessThanOrEqual(15);
    expect(previewLimit(res, true)).toBeCloseTo(normal * 1.2);
  });
});

describe('leaderboard ranking', () => {
  test('no shared places: ties go to fewer games, then name', () => {
    const e = (name: string, score: number, games: number) => ({ rank: 0, name, score, games, best: 0, you: false });
    const ranked = rankEntries([e('pikenoDelas', 1000, 2), e('tigas', 1700, 2), e('RidgyTortoise', 1000, 1), e('One plus 5', 1000, 1), e('cenas', 400, 1)]);
    expect(ranked.map((r) => [r.rank, r.name])).toEqual([[1, 'tigas'], [2, 'One plus 5'], [3, 'RidgyTortoise'], [4, 'pikenoDelas'], [5, 'cenas']]);
  });
});

describe('leaderboard window', () => {
  test('the block of 10 under the top 10 holds your rank', () => {
    expect([1, 10].map(windowStart)).toEqual([null, null]);
    expect([11, 15, 20, 21, 500, 501, 508, 510].map(windowStart)).toEqual([11, 11, 11, 21, 491, 501, 501, 501]);
  });

  test('shows the top 10 and the 10 around you, not every pilot', async () => {
    const s = new MemoryStore();
    for (let i = 1; i <= 60; i++) { s.names.set(`p${i}`, `Pilot ${i}`); s.allBoard.set(`p${i}`, 10_000 - i); s.games.set(`p${i}`, 1); }
    const far = await s.board('all', DAY, 'p38');
    expect(far.top.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(far.around.map((e) => e.rank)).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
    expect(far.me).toMatchObject({ rank: 38, name: 'Pilot 38', you: true });
    expect(far.players).toBe(60);
    expect((await s.board('all', DAY, 'p4')).around).toEqual([]);
    expect((await s.board('all', DAY, null)).around).toEqual([]);
    expect((await s.board('all', DAY, 'p58')).around.map((e) => e.rank)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
  });
});

describe('streaks', () => {
  test('consecutive wins build a streak, a loss or a skipped day resets it', () => {
    let row = nextStreak(null, '2026-11-10', true);
    row = nextStreak(row, '2026-11-11', true);
    expect(row).toEqual({ current: 2, best: 2, last: '2026-11-11' });
    expect(liveStreak(row, '2026-11-12')).toEqual({ current: 2, best: 2 });
    expect(liveStreak(row, '2026-11-13')).toEqual({ current: 0, best: 2 });
    row = nextStreak(row, '2026-11-12', false);
    expect(row.current).toBe(0);
    row = nextStreak(row, '2026-11-14', true);
    expect(row).toEqual({ current: 1, best: 2, last: '2026-11-14' });
  });
});

/** Makes `day` today's puzzle, the way ORBIT_DAY does in development. */
const setToday = (day: string) => { process.env.ORBIT_DAY = day; };
afterEach(() => { delete process.env.ORBIT_DAY; });

describe('server game', () => {
  let store: MemoryStore;
  beforeEach(async () => {
    setToday(DAY);
    store = new MemoryStore(); setStoreForTests(store);
    const g = await levelFor(DAY);
    sol = () => g.solution;
    miss = () => ({ moon: g.level.moon.start, angle: g.level.moon.startAngle });
    sol2 = (await levelFor('2026-11-11')).solution;
    giant = g.level.bodies[0];
  });
  let sol: () => import('@/game/engine').Placement;
  let miss: () => import('@/game/engine').Placement;
  let sol2: import('@/game/engine').Placement;
  let giant: { x: number; z: number };
  // shots as the page sends them: aimed by hand, at a moment when the shared orbit clock reads 0
  const fire = (pid: string, p: unknown, day: string) => shoot(pid, p, day, { moves: 3 }, NOW);

  test('names are validated', () => {
    expect(cleanName('  Nova   Pilot ')).toBe('Nova Pilot');
    expect(() => cleanName('x')).toThrow(GameError);
    expect(() => cleanName('<script>')).toThrow(GameError);
  });

  test('pilot names are unique, ignoring case, and renaming frees the old name', async () => {
    await setName('a', 'Nova');
    await expect(setName('b', 'nova')).rejects.toThrow('already taken');
    expect(await setName('a', 'NOVA')).toBe('NOVA'); // the same player may change case
    await setName('a', 'Vega');
    expect(await setName('b', 'Nova')).toBe('Nova');
  });

  test('a new visitor plays without picking a name, gets a generated one, and can change it', async () => {
    expect((await today('a', DAY, NOW - MIN_SOLVE_MS)).me.name).toBeNull();
    const first = await fire('a', miss(), DAY);
    expect(first).toMatchObject({ shot: 1, status: 'playing', name: expect.stringMatching(/^[A-Z][a-z]+ \d{4}$/) });
    const auto = first.name!;
    expect(cleanName(auto)).toBe(auto);
    expect((await today('a', DAY)).me.name).toBe(auto);
    // the win counts and the generated name is on today's board
    expect(await fire('a', sol(), DAY)).toMatchObject({ result: 'hit', status: 'won', score: 700, name: auto });
    expect((await leaderboard('a', 'day', DAY)).top).toEqual([expect.objectContaining({ name: auto, score: 700, you: true })]);
    // renaming keeps the points and frees the generated name
    await setName('a', 'Ana');
    expect((await leaderboard('a', 'day', DAY)).top[0]).toMatchObject({ name: 'Ana', score: 700 });
    expect(await setName('b', auto)).toBe(auto);
    // a pilot who already has a name keeps it
    expect((await fire('b', miss(), DAY)).name).toBe(auto);
  });

  test('a helper also gives an unnamed pilot a name', async () => {
    const r = await applyHelper('a', 'scanner', DAY);
    expect(r).toMatchObject({ helpers: ['scanner'], name: expect.any(String) });
  });

  test('generated names never take a name someone already has', async () => {
    // a random source that first lands on Nova 1000, which is taken, then on Comet 1000
    const seq = [0, 0, 0, 0.1];
    let i = 0;
    const rand = () => seq[Math.min(i++, seq.length - 1)];
    await setName('x', 'nova 1000');
    expect(await autoName('a', rand)).toBe('Comet 1000');
    expect((await today('a', DAY)).me.name).toBe('Comet 1000');
  });

  test('a shot with no player id is refused', async () => {
    await expect(shoot(null, sol(), DAY, { moves: 3 }, NOW)).rejects.toMatchObject({ status: 401 });
  });

  test('unnamed pilots get the same script checks before their win counts', async () => {
    await today('a', DAY, NOW - 60_000);
    await expect(shoot('a', sol(), DAY, {}, NOW)).rejects.toThrow('looks like a script');
    await today('b', DAY, NOW - 5_000);
    await expect(shoot('b', sol(), DAY, { moves: 4 }, NOW)).rejects.toThrow('faster than a pilot');
    // neither used up a shot or reached the board
    expect((await today('a', DAY)).me.play.shots).toEqual([]);
    expect((await today('b', DAY)).me.play.shots).toEqual([]);
    expect((await leaderboard(null, 'day', DAY)).players).toBe(0);
  });

  test('win on second shot with a helper scores 700 - 150', async () => {
    await setName('a', 'Ana');
    expect((await fire('a', miss(), DAY)).status).toBe('playing');
    await applyHelper('a', 'scanner', DAY);
    const r = await fire('a', sol(), DAY);
    expect(r).toMatchObject({ result: 'hit', status: 'won', score: 550, shot: 2 });
    await expect(fire('a', sol(), DAY)).rejects.toThrow('already finished');
    await expect(applyHelper('a', 'energized', DAY)).rejects.toThrow('already finished');
  });

  test('three misses lose with zero points and count as a game', async () => {
    await setName('b', 'Bo');
    for (let i = 0; i < 3; i++) await fire('b', miss(), DAY);
    expect((await today('b', DAY)).me.play.status).toBe('lost');
    const lb = await leaderboard('b', 'all', DAY);
    expect(lb.me).toMatchObject({ score: 0, games: 1 });
  });

  test('satellite needs the helper, and the retired ghost moon is refused', async () => {
    await setName('c', 'Cy');
    const withSat = { ...miss(), satellite: { x: -20, z: -18, angle: 0 } };
    await expect(fire('c', withSat, DAY)).rejects.toThrow('Unlock the mirror satellite');
    await expect(applyHelper('c', 'ghost', DAY)).rejects.toThrow('Unknown helper');
    expect((await applyHelper('c', 'energized', DAY)).helpers).toEqual(['energized']);
  });


  test('rejects impossible placements', async () => {
    await setName('d', 'Di');
    await expect(fire('d', { moon: { x: giant.x, z: giant.z }, angle: 0 }, DAY)).rejects.toThrow('cannot sit');
    await expect(fire('d', { moon: { x: 'a' }, angle: 0 }, DAY)).rejects.toThrow('Invalid shot');
  });

  test('the energized laser destroys an asteroid so the next shot gets through', async () => {
    // a custom level where an asteroid sits right in the laser's path to the beacon
    const day = '2099-01-01';
    setToday(day);
    const level: Level = { ...FALLBACK_LEVEL(day), emitter: { x: -20, z: 0, dir: 0 }, target: { x: 20, z: 0, r: 1.5 }, bodies: [], splitters: [], wormholes: [], rocks: [{ x: 0, z: 0, r: 1 }] };
    const placement = { moon: { x: -25, z: 20 }, angle: 0 };
    await store.setCached(`level:v5:${day}`, JSON.stringify({ level, solution: placement, solutions: 1, attempts: 1 }));
    await setName('e', 'Eve');
    expect((await fire('e', placement, day)).result).toBe('rock'); // without the helper the rock survives
    expect((await fire('e', placement, day)).result).toBe('rock');
    await applyHelper('e', 'energized', day);
    const third = await fire('e', placement, day);
    expect(third).toMatchObject({ result: 'rock', destroyed: [0], status: 'lost' });
    expect(third.play.destroyed).toEqual([0]);
  });

  test('a destroyed asteroid lets a later shot win', async () => {
    const day = '2099-01-02';
    setToday(day);
    const level: Level = { ...FALLBACK_LEVEL(day), emitter: { x: -20, z: 0, dir: 0 }, target: { x: 20, z: 0, r: 1.5 }, bodies: [], splitters: [], wormholes: [], rocks: [{ x: 0, z: 0, r: 1 }] };
    const placement = { moon: { x: -25, z: 20 }, angle: 0 };
    await store.setCached(`level:v5:${day}`, JSON.stringify({ level, solution: placement, solutions: 1, attempts: 1 }));
    await setName('f', 'Fox');
    await applyHelper('f', 'energized', day);
    expect((await fire('f', placement, day)).destroyed).toEqual([0]);
    expect(await fire('f', placement, day)).toMatchObject({ result: 'hit', status: 'won', score: 700 - 200 });
  });

  test('cumulative leaderboard ranks across days and marks you', async () => {
    const day2 = '2026-11-11';
    await setName('a', 'Ana'); await setName('b', 'Bo'); await setName('c', 'Cy');
    await fire('a', sol(), DAY); // 1000
    await fire('b', miss(), DAY); await fire('b', sol(), DAY); // 700
    setToday(day2);
    await fire('c', sol2, day2); // 1000 on day 2
    await fire('b', sol2, day2); // b total 1700
    const all = await leaderboard('c', 'all', day2);
    // every pilot gets their own place; a tie on points and games goes by name
    expect(all.top.map((e) => [e.rank, e.name, e.score, e.games])).toEqual([
      [1, 'Bo', 1700, 2], [2, 'Ana', 1000, 1], [3, 'Cy', 1000, 1],
    ]);
    expect(all.me).toMatchObject({ name: 'Cy', rank: 3, you: true });
    expect(all.top.find((e) => e.name === 'Bo')).toMatchObject({ best: 2 });
    expect((await today('b', day2)).me.streak).toEqual({ current: 2, best: 2 });
    const d1 = await leaderboard(null, 'day', DAY);
    expect(d1.top.map((e) => e.name)).toEqual(['Ana', 'Bo']);
    expect(d1.me).toBeNull();
  });

  test('a scripted winning shot is rejected with a message and not counted', async () => {
    await setName('g', 'Gil');
    // no aiming on the board: the shot is turned away, and no shot is used up
    await expect(shoot('g', sol(), DAY, {}, NOW)).rejects.toThrow('looks like a script');
    await expect(shoot('g', sol(), DAY, { moves: 0 }, NOW)).rejects.toMatchObject({ status: 403 });
    // a miss is never checked, so a quick test shot still counts as a shot
    expect((await shoot('g', miss(), DAY, {}, NOW)).shot).toBe(1);
    // winning within seconds of first seeing the board is too fast to be a person
    await setName('h', 'Hal');
    await today('h', DAY, NOW - 5_000);
    await expect(shoot('h', sol(), DAY, { moves: 4 }, NOW)).rejects.toThrow('faster than a pilot');
    // a pilot who opened the board long enough ago wins as normal
    await setName('j', 'Jo');
    await today('j', DAY, NOW - MIN_SOLVE_MS);
    expect(await shoot('j', sol(), DAY, { moves: 4 }, NOW)).toMatchObject({ result: 'hit', shot: 1, score: 1000 });
  });
});

describe('scripts on a day without orbiting moons', () => {
  test("the friends' solver payload (placement only) is rejected with a message", async () => {
    setStoreForTests(new MemoryStore());
    const day = '2026-11-14'; // a past day (archive), not used by any other test
    // a straight shot that wins, on a board with no orbiting moons, so there is no moon clock to check
    const level: Level = { ...FALLBACK_LEVEL(day), emitter: { x: -20, z: 0, dir: 0 }, target: { x: 20, z: 0, r: 1.5 }, bodies: [], splitters: [], wormholes: [], rocks: [] };
    expect(level.orbitPeriod).toBeUndefined();
    const placement = { moon: { x: -25, z: 20 }, angle: 0, satellite: null };
    expect(trace(level, placement).result).toBe('hit');
    await getStoreForTest().setCached(`level:v5:${day}`, JSON.stringify({ level, solution: placement, solutions: 1, attempts: 1 }), 60);
    await setName('s', 'Scripter');
    await today('s', day, NOW - 60_000);
    // exactly what the script posts: { placement } and nothing else
    await expect(shoot('s', placement, day, {}, NOW)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('looks like a script') });
    expect((await today('s', day, NOW)).me.play.shots).toEqual([]); // no shot used up
  });
});

describe('moon clock', () => {
  const level = { ...FALLBACK_LEVEL(DAY), orbitPeriod: ORBIT_PERIOD };
  const at = (sec: number) => NOW + sec * 1000;
  test('the moons must be where the server clock has them', () => {
    expect(() => checkClock(level, 30, false, at(30), null)).not.toThrow();
    expect(() => checkClock(level, 30, false, at(30 + CLOCK_SLACK - 1), null)).not.toThrow();
    expect(() => checkClock(level, 0, false, at(90), null)).toThrow('moons have moved');
    // the clock wraps every period
    expect(() => checkClock(level, 239, false, at(242), null)).not.toThrow();
    // reduced motion runs the orbit clock at half speed
    expect(() => checkClock(level, 15, true, at(30), null)).not.toThrow();
    expect(() => checkClock(level, 15, false, at(30), null)).toThrow();
    // firing again at the frozen moment of the last shot is fine
    expect(() => checkClock(level, 0, false, at(90), 0)).not.toThrow();
    // days without orbiting moons have no clock
    expect(() => checkClock({ ...level, orbitPeriod: undefined }, undefined, false, at(90), null)).not.toThrow();
  });
  test('a shot sent with a stale moon clock is rejected', async () => {
    setStoreForTests(new MemoryStore());
    const day = '2099-02-01';
    setToday(day);
    const l: Level = { ...FALLBACK_LEVEL(day), orbitPeriod: ORBIT_PERIOD };
    await getStoreForTest().setCached(`level:v5:${day}`, JSON.stringify({ level: l, solution: { moon: { x: 10, z: 3 }, angle: 230 }, solutions: 1, attempts: 1 }), 60);
    await setName('i', 'Ivo');
    const p = { moon: l.moon.start, angle: l.moon.startAngle };
    await expect(shoot('i', p, day, { moves: 1 }, at(100))).rejects.toThrow('moons have moved'); // t defaults to 0
    expect((await shoot('i', { ...p, t: 100 }, day, { moves: 1 }, at(101))).shot).toBe(1);
  });
});

describe('archive', () => {
  let store: MemoryStore;
  // aimed (some drags and turns), long after the board was opened, at the moons' starting moment
  const aimed = (pid: string, p: unknown, day?: string) => shoot(pid, p, day, { moves: 3 }, NOW); // NOW: orbit time 0, long after the board was opened
  beforeEach(() => { store = new MemoryStore(); setStoreForTests(store); setToday('2026-11-12'); });

  test('which days can be played', () => {
    expect(resolveDay(undefined)).toEqual({ day: '2026-11-12', ranked: true });
    expect(resolveDay('2026-11-12')).toEqual({ day: '2026-11-12', ranked: true });
    expect(resolveDay('2026-11-10')).toEqual({ day: '2026-11-10', ranked: false });
    expect(() => resolveDay('2026-11-13')).toThrow('not out yet');
    expect(() => resolveDay('2026-11-09')).toThrow('no puzzles before');
    expect(() => resolveDay('../etc')).toThrow('Unknown puzzle');
  });

  test('a past day can be played once without a name, and does not touch the leaderboards or the streak', async () => {
    const g = await levelFor(DAY);
    const miss = { moon: g.level.moon.start, angle: g.level.moon.startAngle };
    expect((await today('x', DAY)).archive).toBe(true);
    expect((await aimed('x', miss, DAY)).status).toBe('playing'); // no pilot name needed
    await applyHelper('x', 'scanner', DAY);
    const r = await aimed('x', g.solution, DAY);
    expect(r).toMatchObject({ result: 'hit', status: 'won', score: 700 - 150 });
    await expect(shoot('x', g.solution, DAY)).rejects.toThrow('already finished');
    expect((await today('x', DAY)).me.play).toMatchObject({ status: 'won', score: 550 });
    expect(store.allBoard.size).toBe(0);
    expect(store.dayBoards.size).toBe(0);
    expect((await today('x')).me.streak).toEqual({ current: 0, best: 0 });
    // the archive lists past days, newest first, with this player's results
    const { days } = await archive('x');
    expect(days.map((d) => [d.day, d.number, d.status])).toEqual([['2026-11-11', 2, 'open'], ['2026-11-10', 1, 'won']]);
    expect(days[1]).toMatchObject({ score: 550 });
    expect((await archive(null)).days.every((d) => d.status === 'open')).toBe(true);
  });

  test("today's puzzle gives an unnamed pilot a name and still counts", async () => {
    const g = await levelFor('2026-11-12');
    expect(await aimed('y', g.solution)).toMatchObject({ score: 1000, name: expect.any(String) });
    expect(store.allBoard.get('y')).toBe(1000);
    expect((await archive('y')).days.some((d) => d.day === '2026-11-12')).toBe(false); // today is not in the archive
  });
});

describe('voyage', () => {
  let store: MemoryStore;
  beforeEach(() => { store = new MemoryStore(); setStoreForTests(store); });
  // an aimed shot, long after the level was opened
  const vshot = (pid: string | null, n: number, p: unknown) => voyageShot(pid, n, p, { moves: 3 }, NOW);

  test('prebuilt levels are numbered, solvable with a mirror bounce, and have their chapter piece', () => {
    const levels = prebuilt as unknown as import('@/game/generate').Generated[];
    expect(levels.length).toBe(PREBUILT);
    const has: Record<string, (l: Level) => boolean> = {
      plain: () => true,
      blackhole: (l) => l.bodies.some((b) => b.kind === 'blackhole'),
      repulsor: (l) => l.bodies.some((b) => b.kind === 'repulsor'),
      mirrors: (l) => !!l.mirrors?.length,
      wormhole: (l) => l.wormholes.length > 0,
      splitter: (l) => l.splitters.length > 0,
      relay: (l) => !!l.relays?.length,
      twin: (l) => !!l.extraEmitters?.length,
    };
    levels.forEach((g, i) => {
      const n = i + 1;
      expect(g.level).toMatchObject({ voyage: n, number: n, day: `voyage-${n}` });
      const sol = trace(g.level, g.solution);
      expect(sol.result, `level ${n}`).toBe('hit');
      expect(sol.rays.find((r) => r.result === 'hit')!.pts.some((p) => p.bounce && !p.fixed), `level ${n}`).toBe(true);
      expect(trace(g.level, { moon: g.level.moon.start, angle: g.level.moon.startAngle }).result, `level ${n}`).not.toBe('hit');
      if (n <= 27) for (const f of voyageSpec(n).features) expect(has[f](g.level), `level ${n} ${f}`).toBe(true);
      // the first levels keep their moons still
      if (n < 13) expect(g.level.orbitPeriod, `level ${n}`).toBeUndefined();
    });
  });

  test('the curve: winning shots to aim for fall steadily, and rise at each new chapter', () => {
    expect(voyageSpec(1).target).toBe(30);
    expect(voyageSpec(7).target).toBeGreaterThan(voyageSpec(6).target);
    for (const n of [8, 9, 27, 29]) expect(voyageSpec(n).target, `level ${n}`).toBeLessThan(voyageSpec(n - 1).target + 1);
    for (let n = 1; n <= 200; n++) expect(voyageSpec(n).target, `level ${n}`).toBeGreaterThanOrEqual(3);
  });

  test('the curve: one new piece per chapter, then two pieces and smaller mirrors in deep space', () => {
    expect(voyageSpec(1)).toMatchObject({ chapter: 'First light', features: ['plain'], scanner: true });
    expect(voyageSpec(7).features).toEqual(['blackhole']);
    expect(voyageSpec(27).features).toEqual(['twin']);
    expect(voyageSpec(28).chapter).toBe('Deep space');
    expect(voyageSpec(30).features).toHaveLength(1);
    for (let n = 70; n < 80; n++) expect(voyageSpec(n).features).toHaveLength(2);
    expect(voyageStars(1)).toBe(3);
    expect(voyageStars(3)).toBe(1);
  });

  test('progress: misses end an attempt, a hit earns stars and opens the next level', async () => {
    const one = await voyageLevelFor(1);
    const miss = { moon: one.level.moon.start, angle: one.level.moon.startAngle };
    expect((await voyage(null)).n).toBe(1);
    await expect(voyage('v', 2)).rejects.toThrow('Clear level 1 first');
    await expect(vshot('v', 2, one.solution)).rejects.toThrow('Clear level 1 first');
    await vshot('v', 1, miss);
    expect((await voyage('v', 1)).shots).toHaveLength(1); // an attempt in progress is kept
    await vshot('v', 1, miss);
    expect(await vshot('v', 1, miss)).toMatchObject({ status: 'lost', stars: 0, unlocked: 1 });
    expect((await voyage('v', 1)).shots).toEqual([]); // the next attempt starts fresh
    expect(await vshot('v', 1, one.solution)).toMatchObject({ result: 'hit', status: 'won', stars: 3, unlocked: 2 });
    expect((await voyage('v')).n).toBe(2); // continues at the furthest level
    // replaying for fewer stars keeps the best
    await vshot('v', 1, miss);
    await vshot('v', 1, one.solution);
    expect((await voyage('v', 1)).stars).toEqual({ 1: 3 });
    await expect(vshot(null, 1, one.solution)).rejects.toThrow('Could not tell who you are');
  });

  test('wins need aiming and time, like the daily puzzle', async () => {
    const one = await voyageLevelFor(1);
    await voyage('s', 1, NOW); // opened at NOW
    await expect(voyageShot('s', 1, one.solution, { moves: 0 }, NOW + 60_000)).rejects.toThrow('looks like a script');
    await expect(voyageShot('s', 1, one.solution, { moves: 2 }, NOW + 5_000)).rejects.toMatchObject({ status: 403 });
    expect((await voyage('s', 1)).shots).toEqual([]); // turned-away shots are not used up
    expect(await voyageShot('s', 1, one.solution, { moves: 2 }, NOW + VOYAGE_MIN_SOLVE_MS)).toMatchObject({ status: 'won', stars: 3 });
  });

  test('the Voyage board ranks named pilots by stars, then levels cleared', async () => {
    const lv = await Promise.all([1, 2, 3].map(voyageLevelFor));
    const miss = (i: number) => ({ moon: lv[i].level.moon.start, angle: lv[i].level.moon.startAngle });
    await setName('a', 'Ana'); await setName('b', 'Bo');
    // Ana: levels 1 and 2 on the first shot (6 stars)
    await vshot('a', 1, lv[0].solution); await vshot('a', 2, lv[1].solution);
    // Bo: level 1 first shot, 2 and 3 on the second shot (3 + 2 + 2 = 7 stars)
    await vshot('b', 1, lv[0].solution);
    await vshot('b', 2, miss(1)); await vshot('b', 2, lv[1].solution);
    await vshot('b', 3, miss(2)); await vshot('b', 3, lv[2].solution);
    // Cy plays without a name: not on the board until picking one
    await vshot('c', 1, lv[0].solution); await vshot('c', 2, lv[1].solution);
    let b = await leaderboard('c', 'voyage');
    expect(b.top.map((e) => [e.rank, e.name, e.score, e.games])).toEqual([[1, 'Bo', 7, 3], [2, 'Ana', 6, 2]]);
    expect(b.me).toBeNull();
    await setName('c', 'Cy');
    b = await leaderboard('c', 'voyage');
    // Cy ties Ana on stars and levels, so the name decides
    expect(b.top.map((e) => e.name)).toEqual(['Bo', 'Ana', 'Cy']);
    expect(b.me).toMatchObject({ rank: 3, score: 6, games: 2, you: true });
    // Voyage stars never reach the daily boards
    expect(store.allBoard.size).toBe(0);
  });
});


describe('player id in iframes', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  test('cookie wins, header is the fallback, junk is ignored', () => {
    expect(pickPid(A, B)).toBe(A);
    expect(pickPid(undefined, B)).toBe(B);
    expect(pickPid('nope', B)).toBe(B);
    expect(pickPid(null, 'x'.repeat(36))).toBeNull();
    expect(pickPid(null, null)).toBeNull();
  });
  test('production cookie works as a third-party cookie', () => {
    expect(pidCookieOptions(true)).toMatchObject({ sameSite: 'none', secure: true, partitioned: true, httpOnly: true });
    expect(pidCookieOptions(false)).toMatchObject({ sameSite: 'lax', secure: false });
  });
  test('only JSON posts are accepted', () => {
    expect(isJsonRequest('application/json')).toBe(true);
    expect(isJsonRequest('application/json; charset=utf-8')).toBe(true);
    expect(isJsonRequest('text/plain')).toBe(false);
    expect(isJsonRequest('application/x-www-form-urlencoded')).toBe(false);
    expect(isJsonRequest(null)).toBe(false);
  });
});
