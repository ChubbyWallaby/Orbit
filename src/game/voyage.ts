// Builds Voyage levels. The difficulty curve itself is in voyage-spec.ts.
import { generateFrom, type Generated } from './generate';
import type { Level } from './engine';
import { CHAPTERS, voyageSpec } from './voyage-spec';

export * from './voyage-spec';

/** The level's board says which Voyage level it is. */
export function asVoyageLevel(g: Generated, n: number): Generated {
  return { ...g, level: { ...g.level, day: `voyage-${n}`, number: n, voyage: n } as Level };
}

/**
 * Builds Voyage level `n`: tries a few seeds and keeps the one whose solution count suits the level's
 * target. Takes seconds per candidate, so levels up to PREBUILT are built ahead (scripts/build-voyage.ts).
 */
export function buildVoyageLevel(n: number, candidates = 3): Generated {
  const spec = voyageSpec(n);
  const found: Generated[] = [];
  for (let k = 0; k < candidates * 3 && found.length < candidates; k++) {
    const g = generateFrom(`voyage:${n}:${k}`, spec.features, spec.tuning, true);
    if (g) found.push(g);
  }
  // a piece that would not fit any board: fall back to the usual rules, which may drop it
  if (!found.length) return asVoyageLevel(generateFrom(`voyage:${n}`, spec.features, spec.tuning), n);
  found.sort((a, b) => b.solutions - a.solutions); // easiest first
  const pick = spec.target === 'easy' ? found[0] : spec.target === 'hard' ? found[found.length - 1] : found[Math.floor(found.length / 2)];
  return asVoyageLevel(pick, n);
}

/**
 * Within each chapter, puts the boards in order from most solutions to fewest, so a chapter always
 * gets harder from its first level to its last. `levels[i]` is level i + 1.
 */
export function orderChapters(levels: Generated[]): Generated[] {
  const out = [...levels];
  for (const ch of CHAPTERS) {
    if (ch.to > out.length) break;
    const part = out.slice(ch.from - 1, ch.to).sort((a, b) => b.solutions - a.solutions);
    part.forEach((g, i) => { out[ch.from - 1 + i] = asVoyageLevel(g, ch.from + i); });
  }
  return out;
}
