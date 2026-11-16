// The Voyage difficulty curve, kept free of the generator so the page can use it too.
// Voyage: an endless run of numbered levels, the same for everyone, that get harder as you go.
// The first levels teach one piece at a time; after that, Deep Space mixes them and adds a second one.
import type { Feature, Tuning } from './generate';
import { MAX_SHOTS } from './rules';

/** The pieces Deep Space levels pick from (the same as daily levels). */
const POOL: Feature[] = ['blackhole', 'splitter', 'wormhole', 'mirrors', 'relay', 'repulsor', 'twin'];


export type VoyageSpec = {
  chapter: string;
  features: Feature[];
  tuning: Tuning;
  /**
   * How many winning shots the level should have (the solver finds up to about 30 per laser station).
   * Fewer is harder: the curve falls steadily, and rises again for the first level of a new chapter.
   */
  target: number;
  /** The aiming line reaches as far as with the long-range scanner, for free. */
  scanner: boolean;
};

export type Chapter = { name: string; from: number; to: number; feature: Feature };
/** Each chapter of three levels brings in one piece: easy, then normal, then hard. */
export const CHAPTERS: Chapter[] = [
  { name: 'First light', from: 1, to: 3, feature: 'plain' },
  { name: 'Gravity wells', from: 4, to: 6, feature: 'plain' },
  { name: 'Black holes', from: 7, to: 9, feature: 'blackhole' },
  { name: 'Bank shots', from: 10, to: 12, feature: 'mirrors' },
  { name: 'Repulsors', from: 13, to: 15, feature: 'repulsor' },
  { name: 'Wormholes', from: 16, to: 18, feature: 'wormhole' },
  { name: 'Split beams', from: 19, to: 21, feature: 'splitter' },
  { name: 'Fading light', from: 22, to: 24, feature: 'relay' },
  { name: 'Twin stations', from: 25, to: 27, feature: 'twin' },
];
/** Levels after the chapters. */
export const DEEP_SPACE = CHAPTERS[CHAPTERS.length - 1].to + 1;
/** Levels kept ready in voyage-levels.json; later ones are made the first time someone reaches them. */
export const PREBUILT = 60;

export const voyageStars = (shot: number): number => Math.max(1, MAX_SHOTS + 1 - shot);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function voyageSpec(n: number): VoyageSpec {
  const ch = CHAPTERS.find((c) => n >= c.from && n <= c.to);
  if (ch) {
    const step = n - ch.from; // 0, 1, 2 within the chapter
    return {
      chapter: ch.name,
      features: [ch.feature],
      tuning: {
        // still moons until the player knows the basics; a wide mirror for the very first levels
        orbits: n >= 13,
        mirror: n <= 3 ? [1.7, 1.9] : n <= 6 ? [1.4, 1.9] : undefined,
      },
      // each chapter starts easier than the last one ended, then tightens; the first two stay gentle
      target: Math.round(30 - (n - 1) * 0.6 - step * (n <= 6 ? 3 : 4)),
      scanner: n <= 6,
    };
  }
  // Deep Space: pieces picked from the level number, one at first, then two, smaller mirrors later on
  const h = hash(`voyage:${n}:pieces`);
  const first = POOL[h % POOL.length];
  const rest = POOL.filter((f) => f !== first);
  const two = n >= 70 || (n >= 45 && (h >>> 8) % 2 === 0);
  const features: Feature[] = two ? [first, rest[(h >>> 12) % rest.length]] : [first];
  const small = n >= 50 && (h >>> 16) % 2 === 0;
  return {
    chapter: 'Deep space',
    features,
    tuning: { orbits: true, mirror: small ? [1.1, 1.4] : undefined },
    // a slow slide from about 12 winning shots towards 4, with an easier level every 5 and a harder one too
    target: Math.max(3, Math.round(Math.max(4, 12 - (n - DEEP_SPACE) * 0.12) + (n % 5 === 1 ? 6 : n % 5 === 0 ? -3 : 0))),
    scanner: false,
  };
}

/** The chapter a level belongs to, for grouping levels on the map. */
export const chapterOf = (n: number): string => CHAPTERS.find((c) => n >= c.from && n <= c.to)?.name ?? 'Deep space';
