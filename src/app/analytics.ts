'use client';
// Product analytics with PostHog. It is on only when NEXT_PUBLIC_POSTHOG_KEY is set at build time;
// without it every call here does nothing and posthog-js is never downloaded.
//
// No cookies or browser storage are added for tracking: PostHog keeps its state in memory only.
// A returning player is recognised through the anonymous player id the game already keeps for
// itself (see pid.ts). That id is the player's credential (the server accepts it in a header), so
// it never leaves the site: PostHog gets a one-way SHA-256 hash of it instead, which is the same
// on every visit.
import type { PostHog, Properties } from 'posthog-js';

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() || null;
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || 'https://us.i.posthog.com';
/** Sent with every event: the PostHog project is shared with other apps. */
export const APP = 'orbit';

let ph: PostHog | null = null;
let started = false;
// calls made before posthog-js has loaded, replayed once it has
let pending: ((p: PostHog) => void)[] = [];

const ID_PREFIX = 'orbit-posthog-v1:';
/** The PostHog distinct id for a player: hex SHA-256 of a fixed prefix and the player id. */
export async function analyticsId(pid: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ID_PREFIX + pid));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null; // no Web Crypto (insecure context): stay anonymous rather than send the raw id
  }
}

function run(fn: (p: PostHog) => void) {
  if (!KEY || typeof window === 'undefined') return;
  if (ph) fn(ph);
  else pending.push(fn);
}

/** Loads PostHog once. `pid` is the player id the game already stored, if any. */
export function initAnalytics(pid: string | null) {
  if (!KEY || started || typeof window === 'undefined') return;
  started = true;
  Promise.all([import('posthog-js'), pid ? analyticsId(pid) : null]).then(([{ default: posthog }, id]) => {
    posthog.init(KEY, {
      api_host: HOST,
      persistence: 'memory',
      disable_persistence: true,
      disable_session_recording: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      // clicks on buttons and links only: never text typed into a field (e.g. the pilot name)
      autocapture: { dom_event_allowlist: ['click'], element_allowlist: ['a', 'button'], capture_copied_text: false },
      capture_pageview: 'history_change', // the game changes the address for past days and Voyage levels
      capture_pageleave: true, // with page views, this measures time on the page
      person_profiles: 'identified_only',
      ...(id ? { bootstrap: { distinctID: id, isIdentifiedID: true } } : {}),
      // set on every event, including the first page view sent during init
      before_send: (e) => (e ? { ...e, properties: { ...e.properties, app: APP } } : e),
    });
    posthog.register({ app: APP });
    ph = posthog;
    const queued = pending;
    pending = [];
    for (const fn of queued) fn(posthog);
  }).catch(() => { /* blocked by the browser or an extension: play goes on */ });
}

export function capture(event: AnalyticsEvent, props: Properties = {}) {
  run((p) => p.capture(event, props));
}

/** Ties this visitor to (a hash of) the game's own player id, so later visits count as the same person. */
export function identifyPlayer(pid: string) {
  if (!KEY || typeof window === 'undefined') return;
  analyticsId(pid).then((id) => { if (id) run((p) => { if (p.get_distinct_id() !== id) p.identify(id); }); });
}

export type AnalyticsEvent =
  | 'puzzle_viewed'
  | 'first_shot'
  | 'shot'
  | 'puzzle_finished'
  | 'name_set'
  | 'result_shared'
  | 'leaderboard_viewed'
  | 'helper_used'
  | 'practice_started';
