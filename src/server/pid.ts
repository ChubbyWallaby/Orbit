// Player id rules, kept free of Next.js imports so they can be unit tested.
//
// The game is also embedded in iframes on other sites (itch.io, CrazyGames). There the browser
// treats our cookie as third-party, so it has to be SameSite=None + Secure, and Partitioned so
// browsers that block ordinary third-party cookies still keep one per embedding site. Browsers
// that block even that (Safari) get the id from a header the page sends from its own storage.

export const PID_COOKIE = 'orbit_pid';
export const PID_HEADER = 'x-orbit-pid';

const PID_RE = /^[0-9a-f-]{36}$/;

export const validPid = (v: string | null | undefined): string | null => (v && PID_RE.test(v) ? v : null);

/** The cookie wins when both are present; the header is the fallback when cookies are blocked. */
export const pickPid = (cookie: string | null | undefined, header: string | null | undefined): string | null =>
  validPid(cookie) ?? validPid(header);

export function pidCookieOptions(production: boolean) {
  const base = { httpOnly: true, path: '/', maxAge: 60 * 60 * 24 * 400 } as const;
  // SameSite=None needs Secure, which needs HTTPS, so local http dev keeps the old setting.
  return production
    ? { ...base, sameSite: 'none' as const, secure: true, partitioned: true }
    : { ...base, sameSite: 'lax' as const, secure: false };
}

/**
 * Cookies now go along with cross-site requests, so a POST must be one another site cannot
 * forge: a plain HTML form cannot send application/json without the browser asking us first.
 */
export const isJsonRequest = (contentType: string | null): boolean =>
  !!contentType && contentType.split(';')[0].trim().toLowerCase() === 'application/json';
