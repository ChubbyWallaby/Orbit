'use client';
// Product analytics with PostHog. It is on only when NEXT_PUBLIC_POSTHOG_KEY is set at build time;
// without it every call here does nothing and posthog-js is never downloaded.
//
// No cookies or browser storage are added for tracking: PostHog keeps its state in memory only.
// A returning player is recognised by the anonymous player id the game already keeps for itself
// (see pid.ts), which is used as the PostHog distinct id.
import type { PostHog, Properties } from 'posthog-js';

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() || null;
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || 'https://us.i.posthog.com';
/** Sent with every event: the PostHog project is shared with other apps. */
export const APP = 'orbit';

let ph: PostHog | null = null;
let started = false;
// calls made before posthog-js has loaded, replayed once it has
let pending: ((p: PostHog) => void)[] = [];

function run(fn: (p: PostHog) => void) {
  if (!KEY || typeof window === 'undefined') return;
  if (ph) fn(ph);
  else pending.push(fn);
}

/** Loads PostHog once. `pid` is the player id the game already stored, if any. */
export function initAnalytics(pid: string | null) {
  if (!KEY || started || typeof window === 'undefined') return;
  started = true;
  import('posthog-js').then(({ default: posthog }) => {
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
      ...(pid ? { bootstrap: { distinctID: pid, isIdentifiedID: true } } : {}),
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

/** Ties this visitor to the game's own player id, so later visits count as the same person. */
export function identifyPlayer(pid: string) {
  run((p) => { if (p.get_distinct_id() !== pid) p.identify(pid); });
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
