// Scoring, helpers and puzzle calendar. Shared by client and server.

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

export function shareText(opts: { number: number; shots: string[]; score: number; helpers: HelperId[]; streak?: number }): string {
  const squares = opts.shots.map((r) => (r === 'hit' ? '🟩' : '🟥')).join('') + '⬛'.repeat(MAX_SHOTS - opts.shots.length);
  const helperIcons = opts.helpers.map((h) => ({ scanner: '📡', satellite: '🛰️', energized: '💥', ghost: '👻' })[h]).join('');
  const won = opts.shots.includes('hit');
  return [
    `ORBIT #${opts.number} 🪐`,
    `${squares}  ${won ? opts.score + ' pts' : 'beacon dark'}`,
    helperIcons ? `helpers ${helperIcons}` : 'no helpers',
    ...(opts.streak && opts.streak > 1 ? [`🔥 ${opts.streak}-day streak`] : []),
    SITE_NAME, // so anyone who sees a result can click through and play
  ].join('\n');
}
