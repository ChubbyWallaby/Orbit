// Scoring, helpers and puzzle calendar. Shared by client and server.
import type { Level, TraceResult } from './engine';

export const MAX_SHOTS = 3;
export const SHOT_BASE = [1000, 700, 400] as const;
export const MIN_WIN_SCORE = 50;
export const LAUNCH_DAY = '2026-11-10';
/** Public address of the game, used in shared results and link previews. */
export const SITE_URL = 'https://orbitpuzzle.com';
export const SITE_NAME = 'orbitpuzzle.com';

/** 'ghost' (Ghost moon) is retired: kept only so plays that already used it still score correctly. */
export type HelperId = 'scanner' | 'satellite' | 'energized' | 'ghost';

export const HELPERS: Record<HelperId, { name: string; cost: number; blurb: string }> = {
  scanner: { name: 'Long-range scanner', cost: 150, blurb: 'Shows 20% more of the aiming line.' },
  satellite: { name: 'Mirror satellite', cost: 200, blurb: 'Adds a free-floating mirror you can place and turn.' },
  energized: { name: 'Energized laser', cost: 200, blurb: 'Asteroids your beam hits explode and stay gone for your next shots.' },
  ghost: { name: 'Ghost moon', cost: 300, blurb: 'Retired.' },
};
/** Helpers players can pick today, in display order. */
export const HELPER_ORDER: HelperId[] = ['scanner', 'satellite', 'energized'];

export function isHelperId(x: unknown): x is HelperId {
  return typeof x === 'string' && x in HELPERS;
}

/** Score for a win on shot `shot` (1-based) with the given helpers used. */
export function scoreFor(shot: number, helpers: HelperId[]): number {
  if (shot < 1 || shot > MAX_SHOTS) return 0;
  const penalty = [...new Set(helpers)].reduce((s, h) => s + HELPERS[h].cost, 0);
  return Math.max(MIN_WIN_SCORE, SHOT_BASE[shot - 1] - penalty);
}

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function puzzleNumber(day: string): number {
  const ms = Date.parse(day + 'T00:00:00Z') - Date.parse(LAUNCH_DAY + 'T00:00:00Z');
  return Math.round(ms / 86400000) + 1;
}

export function msUntilNextPuzzle(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime();
}

/** What a shared result links to: today's puzzle, a past day, or a Voyage level. */
export type ShareTarget = { kind: 'daily' } | { kind: 'archive'; day: string } | { kind: 'voyage'; n: number };

/**
 * The link in a shared result, tagged `ref=share` so visits from shared results can be counted.
 * It opens the same puzzle: `?day=` for a past day, `?voyage=` for a Voyage level.
 */
export function shareUrl(target: ShareTarget): string {
  const q = new URLSearchParams({ ref: 'share' });
  if (target.kind === 'archive') q.set('day', target.day);
  if (target.kind === 'voyage') q.set('voyage', String(target.n));
  return `${SITE_URL}/?${q}`;
}

/**
 * `archive`: a past day played later, marked so it is not mistaken for that day's result.
 * `day` is that past day, for the link on the last line.
 */
export function shareText(opts: { number: number; shots: string[]; score: number; helpers: HelperId[]; streak?: number; archive?: boolean; day?: string }): string {
  const squares = opts.shots.map((r) => (r === 'hit' ? '🟩' : '🟥')).join('') + '⬛'.repeat(MAX_SHOTS - opts.shots.length);
  const helperIcons = opts.helpers.map((h) => ({ scanner: '📡', satellite: '🛰️', energized: '💥', ghost: '👻' })[h]).join('');
  const won = opts.shots.includes('hit');
  return [
    `ORBIT #${opts.number} 🪐${opts.archive ? ' (archive)' : ''}`,
    `${squares}  ${won ? opts.score + ' pts' : 'beacon dark'}`,
    helperIcons ? `helpers ${helperIcons}` : 'no helpers',
    ...(!opts.archive && opts.streak && opts.streak > 1 ? [`🔥 ${opts.streak}-day streak`] : []),
    // so anyone who sees a result can click through and play the same puzzle
    shareUrl(opts.archive && opts.day ? { kind: 'archive', day: opts.day } : { kind: 'daily' }),
  ].join('\n');
}

/** Share text for a cleared Voyage level. */
export function voyageShareText(n: number, stars: number): string {
  return [`ORBIT Voyage · level ${n} 🚀`, '★'.repeat(stars) + '☆'.repeat(MAX_SHOTS - stars), shareUrl({ kind: 'voyage', n })].join('\n');
}

/** Why a shot did not reach the beacon. */
export function missText(level: Level, res: Pick<TraceResult, 'result' | 'hitName' | 'rays'>): string {
  if (res.result === 'absorbed') {
    const kind = level.bodies.find((b) => b.name === res.hitName)?.kind;
    const verb = kind === 'blackhole' ? 'Swallowed by black hole' : kind === 'sun' ? 'Burned up in the sun' : kind === 'repulsor' ? 'Scattered by repulsor' : 'Pulled into';
    return `${verb} ${res.hitName}.`;
  }
  if (res.result === 'rock') return 'Blocked by the asteroid belt.';
  if (res.result === 'faded') {
    // a relay refills the range once per pass: light that went through it can still run out further on
    const relayed = res.rays.some((ray) => ray.result === 'faded' && ray.pts.some((p) => p.relay));
    if (relayed && level.range) return `The relay recharged the light, but it faded again ${Math.round(level.range)} units later. Bounce it towards the beacon sooner.`;
    return 'The light faded out. Pass the relay ring to recharge it.';
  }
  return 'Lost in deep space.';
}
