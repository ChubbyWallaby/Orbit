import { beforeEach, describe, expect, test } from 'vitest';
import { trace } from '@/game/engine';
import { generateLevel, levelFor } from '@/game/generate';
import { scoreFor, puzzleNumber, shareText, msUntilNextPuzzle } from '@/game/rules';
import { MemoryStore, setStoreForTests } from '@/server/store';
import { cleanName, ghostFor, leaderboard, setName, shoot, today, applyHelper, GameError } from '@/server/game';

const DAY = '2026-11-10';

describe('rules', () => {
  test('score depends on shot and helpers', () => {
    expect(scoreFor(1, [])).toBe(1000);
    expect(scoreFor(2, [])).toBe(700);
    expect(scoreFor(3, ['scanner'])).toBe(250);
    expect(scoreFor(3, ['scanner', 'satellite', 'ghost'])).toBe(50);
    expect(scoreFor(1, ['ghost', 'ghost'])).toBe(700);
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
  test('is deterministic and solvable across many days', () => {
    expect(JSON.stringify(generateLevel(DAY))).toBe(JSON.stringify(generateLevel(DAY)));
    for (let i = 0; i < 40; i++) {
      const day = new Date(Date.UTC(2026, 10, 10 + i)).toISOString().slice(0, 10);
      const g = levelFor(day);
      const start = trace(g.level, { moon: g.level.moon.start, angle: g.level.moon.startAngle });
      expect(start.result, day).not.toBe('hit');
      const sol = trace(g.level, g.solution);
      expect(sol.result, day).toBe('hit');
      expect(sol.bounces, day).toBeGreaterThan(0);
      const gh = ghostFor(day);
      expect(Math.hypot(gh.x - g.solution.moon.x, gh.z - g.solution.moon.z)).toBeLessThan(gh.radius);
    }
  }, 120000);
});

describe('server game', () => {
  let store: MemoryStore;
  beforeEach(() => { store = new MemoryStore(); setStoreForTests(store); });
  const sol = () => levelFor(DAY).solution;
  const miss = () => ({ moon: levelFor(DAY).level.moon.start, angle: levelFor(DAY).level.moon.startAngle });

  test('names are validated', () => {
    expect(cleanName('  Nova   Pilot ')).toBe('Nova Pilot');
    expect(() => cleanName('x')).toThrow(GameError);
    expect(() => cleanName('<script>')).toThrow(GameError);
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
    await expect(applyHelper('a', 'ghost', DAY)).rejects.toThrow('already finished');
  });

  test('three misses lose with zero points and count as a game', async () => {
    await setName('b', 'Bo');
    for (let i = 0; i < 3; i++) await shoot('b', miss(), DAY);
    expect((await today('b', DAY)).me.play.status).toBe('lost');
    const lb = await leaderboard('b', 'all', DAY);
    expect(lb.me).toMatchObject({ score: 0, games: 1 });
  });

  test('satellite needs the helper and ghost is only revealed after use', async () => {
    await setName('c', 'Cy');
    const withSat = { ...miss(), satellite: { x: -20, z: -18, angle: 0 } };
    await expect(shoot('c', withSat, DAY)).rejects.toThrow('Unlock the mirror satellite');
    expect((await today('c', DAY)).ghost).toBeNull();
    const h = await applyHelper('c', 'ghost', DAY);
    expect(h.ghost).not.toBeNull();
    expect((await today('c', DAY)).ghost).not.toBeNull();
  });

  test('rejects impossible placements', async () => {
    await setName('d', 'Di');
    const g = levelFor(DAY).level.bodies[0];
    await expect(shoot('d', { moon: { x: g.x, z: g.z }, angle: 0 }, DAY)).rejects.toThrow('cannot sit');
    await expect(shoot('d', { moon: { x: 'a' }, angle: 0 }, DAY)).rejects.toThrow('Invalid shot');
  });

  test('cumulative leaderboard ranks across days and marks you', async () => {
    const day2 = '2026-11-11';
    await setName('a', 'Ana'); await setName('b', 'Bo'); await setName('c', 'Cy');
    await shoot('a', sol(), DAY); // 1000
    await shoot('b', miss(), DAY); await shoot('b', sol(), DAY); // 700
    await shoot('c', levelFor(day2).solution, day2); // 1000 on day 2
    await shoot('b', levelFor(day2).solution, day2); // b total 1700
    const all = await leaderboard('c', 'all', day2);
    // equal scores share a rank; order within a tie follows Redis (reverse member order)
    expect(all.top.map((e) => [e.rank, e.name, e.score, e.games]).sort()).toEqual([
      [1, 'Bo', 1700, 2], [2, 'Ana', 1000, 1], [2, 'Cy', 1000, 1],
    ]);
    expect(all.me).toMatchObject({ name: 'Cy', rank: 2, you: true });
    const d1 = await leaderboard(null, 'day', DAY);
    expect(d1.top.map((e) => e.name)).toEqual(['Ana', 'Bo']);
    expect(d1.me).toBeNull();
  });
});
