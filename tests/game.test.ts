import { beforeEach, describe, expect, test } from 'vitest';
import { previewLimit, trace, withDestroyed, type Level } from '@/game/engine';
import { generateLevel, featureFor, FALLBACK_LEVEL, VARIETY_FROM } from '@/game/generate';
import { scoreFor, puzzleNumber, shareText, msUntilNextPuzzle } from '@/game/rules';
import { MemoryStore, setStoreForTests, nextStreak, liveStreak } from '@/server/store';
import { cleanName, parsePlacement, leaderboard, levelFor, setName, shoot, today, applyHelper, GameError } from '@/server/game';

const DAY = '2026-11-10';

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
    expect(shareText({ number: 4, shots: ['rock', 'hit'], score: 550, helpers: ['scanner'] })).toBe('ORBIT #4 🪐\n🟥🟩⬛  550 pts\nhelpers 📡');
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
      kinds.add(featureFor(day));
      const start = trace(g.level, { moon: g.level.moon.start, angle: g.level.moon.startAngle });
      // the starting spot and the solution must both be accepted by the server
      expect(() => parsePlacement(g.level, { moon: g.level.moon.start, angle: g.level.moon.startAngle }, []), day).not.toThrow();
      expect(() => parsePlacement(g.level, g.solution, []), day).not.toThrow();
      expect(start.result, day).not.toBe('hit');
      const sol = trace(g.level, g.solution);
      expect(sol.result, day).toBe('hit');
      expect(sol.bounces, day).toBeGreaterThan(0);
    }
    expect([...kinds].sort()).toEqual(['blackhole', 'plain', 'splitter', 'wormhole']);
  }, 240000);
});

describe('board variety', () => {
  test('days before the variety launch keep their exact level', () => {
    const g = generateLevel(DAY);
    expect(DAY < VARIETY_FROM).toBe(true);
    expect(g.level.emitter.style).toBeUndefined();
    expect(g.level.moon).toMatchObject({ r: 1.6, m: 0.12 });
    expect(g.level.mirrorHalf).toBe(1.5);
  });
  test('later days vary planets, gravity, stations, moons, mirrors and sides', () => {
    const seen = { giant: new Set<string>(), emitter: new Set<string>(), moon: new Set<string>(), side: new Set<string>(), mirror: new Set<string>() };
    for (let i = 1; i <= 15; i++) {
      const { level } = generateLevel(new Date(Date.UTC(2026, 10, 10 + i)).toISOString().slice(0, 10));
      const giant = level.bodies.find((b) => b.kind === 'giant')!;
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


  test('wormholes carry light to the other mouth', () => {
    const level = bare({ target: { x: 10, z: 12, r: 1.5 }, wormholes: [{ a: { x: -5, z: 0 }, b: { x: -5, z: 12 }, r: 1.1 }] });
    const res = trace(level, farMoon);
    expect(res.result).toBe('hit');
    expect(res.rays[0].pts.some((p) => p.jump)).toBe(true);
  });
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

describe('server game', () => {
  let store: MemoryStore;
  beforeEach(async () => {
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

  test('requires a name before shooting', async () => {
    await expect(shoot('a', sol(), DAY)).rejects.toThrow('Pick a pilot name');
  });

  test('win on second shot with a helper scores 700 - 150', async () => {
    await setName('a', 'Ana');
    expect((await shoot('a', miss(), DAY)).status).toBe('playing');
    await applyHelper('a', 'scanner', DAY);
    const r = await shoot('a', sol(), DAY);
    expect(r).toMatchObject({ result: 'hit', status: 'won', score: 550, shot: 2 });
    await expect(shoot('a', sol(), DAY)).rejects.toThrow('already finished');
    await expect(applyHelper('a', 'energized', DAY)).rejects.toThrow('already finished');
  });

  test('three misses lose with zero points and count as a game', async () => {
    await setName('b', 'Bo');
    for (let i = 0; i < 3; i++) await shoot('b', miss(), DAY);
    expect((await today('b', DAY)).me.play.status).toBe('lost');
    const lb = await leaderboard('b', 'all', DAY);
    expect(lb.me).toMatchObject({ score: 0, games: 1 });
  });

  test('satellite needs the helper, and the retired ghost moon is refused', async () => {
    await setName('c', 'Cy');
    const withSat = { ...miss(), satellite: { x: -20, z: -18, angle: 0 } };
    await expect(shoot('c', withSat, DAY)).rejects.toThrow('Unlock the mirror satellite');
    await expect(applyHelper('c', 'ghost', DAY)).rejects.toThrow('Unknown helper');
    expect((await applyHelper('c', 'energized', DAY)).helpers).toEqual(['energized']);
  });


  test('rejects impossible placements', async () => {
    await setName('d', 'Di');
    await expect(shoot('d', { moon: { x: giant.x, z: giant.z }, angle: 0 }, DAY)).rejects.toThrow('cannot sit');
    await expect(shoot('d', { moon: { x: 'a' }, angle: 0 }, DAY)).rejects.toThrow('Invalid shot');
  });

  test('the energized laser destroys an asteroid so the next shot gets through', async () => {
    // a custom level where an asteroid sits right in the laser's path to the beacon
    const day = '2099-01-01';
    const level: Level = { ...FALLBACK_LEVEL(day), emitter: { x: -20, z: 0, dir: 0 }, target: { x: 20, z: 0, r: 1.5 }, bodies: [], splitters: [], wormholes: [], rocks: [{ x: 0, z: 0, r: 1 }] };
    const placement = { moon: { x: -25, z: 20 }, angle: 0 };
    await store.setCached(`level:v3:${day}`, JSON.stringify({ level, solution: placement, solutions: 1, attempts: 1 }));
    await setName('e', 'Eve');
    expect((await shoot('e', placement, day)).result).toBe('rock'); // without the helper the rock survives
    expect((await shoot('e', placement, day)).result).toBe('rock');
    await applyHelper('e', 'energized', day);
    const third = await shoot('e', placement, day);
    expect(third).toMatchObject({ result: 'rock', destroyed: [0], status: 'lost' });
    expect(third.play.destroyed).toEqual([0]);
  });

  test('a destroyed asteroid lets a later shot win', async () => {
    const day = '2099-01-02';
    const level: Level = { ...FALLBACK_LEVEL(day), emitter: { x: -20, z: 0, dir: 0 }, target: { x: 20, z: 0, r: 1.5 }, bodies: [], splitters: [], wormholes: [], rocks: [{ x: 0, z: 0, r: 1 }] };
    const placement = { moon: { x: -25, z: 20 }, angle: 0 };
    await store.setCached(`level:v3:${day}`, JSON.stringify({ level, solution: placement, solutions: 1, attempts: 1 }));
    await setName('f', 'Fox');
    await applyHelper('f', 'energized', day);
    expect((await shoot('f', placement, day)).destroyed).toEqual([0]);
    expect(await shoot('f', placement, day)).toMatchObject({ result: 'hit', status: 'won', score: 700 - 200 });
  });

  test('cumulative leaderboard ranks across days and marks you', async () => {
    const day2 = '2026-11-11';
    await setName('a', 'Ana'); await setName('b', 'Bo'); await setName('c', 'Cy');
    await shoot('a', sol(), DAY); // 1000
    await shoot('b', miss(), DAY); await shoot('b', sol(), DAY); // 700
    await shoot('c', sol2, day2); // 1000 on day 2
    await shoot('b', sol2, day2); // b total 1700
    const all = await leaderboard('c', 'all', day2);
    // equal scores share a rank; order within a tie follows Redis (reverse member order)
    expect(all.top.map((e) => [e.rank, e.name, e.score, e.games]).sort()).toEqual([
      [1, 'Bo', 1700, 2], [2, 'Ana', 1000, 1], [2, 'Cy', 1000, 1],
    ]);
    expect(all.me).toMatchObject({ name: 'Cy', rank: 2, you: true });
    expect(all.top.find((e) => e.name === 'Bo')).toMatchObject({ best: 2 });
    expect((await today('b', day2)).me.streak).toEqual({ current: 2, best: 2 });
    const d1 = await leaderboard(null, 'day', DAY);
    expect(d1.top.map((e) => e.name)).toEqual(['Ana', 'Bo']);
    expect(d1.me).toBeNull();
  });
});
