// Meta Pixel for the ad campaigns. It is on only when NEXT_PUBLIC_META_PIXEL_ID is set at build
// time; without it every call here does nothing and no Meta script is loaded.
const raw = process.env.NEXT_PUBLIC_META_PIXEL_ID?.trim();
/** Pixel ids are numeric; anything else is ignored so it can never end up as code in the page. */
export const PIXEL_ID = raw && /^\d+$/.test(raw) ? raw : null;

type Fbq = (...args: unknown[]) => void;
function fbq(...args: unknown[]) {
  if (!PIXEL_ID || typeof window === 'undefined') return;
  (window as { fbq?: Fbq }).fbq?.(...args);
}

export const pixelPageView = () => fbq('track', 'PageView');

// counted once per browser: the conversion is a new player finishing their first puzzle
const FIRST_PUZZLE_KEY = 'orbit:pixel:first-puzzle';
export function pixelFirstPuzzleFinished(mode: 'daily' | 'archive' | 'voyage') {
  if (!PIXEL_ID) return;
  try {
    if (localStorage.getItem(FIRST_PUZZLE_KEY)) return;
    localStorage.setItem(FIRST_PUZZLE_KEY, '1');
  } catch { /* storage unavailable: count it anyway */ }
  fbq('track', 'CompleteRegistration', { content_name: 'first_puzzle_finished', status: mode });
}
