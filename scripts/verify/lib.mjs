// Shared helpers for the verify scripts: starting servers, reporting checks.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../..');
/** The copy built with a fake PostHog key (see run.mjs). The normal build stays in .next. */
export const ANALYTICS_DIST = '.next-verify-analytics';
export const MOCK_PORT = Number(process.env.VERIFY_MOCK_PORT || 3999);
// a different host name from the app's (localhost), as the real PostHog host is: cookies are per host, not per port
export const MOCK_HOST = `127.0.0.1:${MOCK_PORT}`;
/** Baked into the analytics copy at build time: a key PostHog would reject, and the local mock as host. */
export const FAKE_POSTHOG = { NEXT_PUBLIC_POSTHOG_KEY: 'phc_verify_fake_key', NEXT_PUBLIC_POSTHOG_HOST: `http://${MOCK_HOST}` };

// require() so a globally installed Playwright (NODE_PATH) is found too
export const loadPlaywright = () => createRequire(import.meta.url)('playwright');

/**
 * Variables that would point a local build or server at something real. They are set to empty
 * strings, not deleted: Next.js fills in any variable that is missing from .env.local / .env, so a
 * deleted one would come straight back from the developer's real credentials. An empty one stays.
 */
export const BLANKED = [
  'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'KV_REST_API_READ_ONLY_TOKEN', 'KV_URL', 'REDIS_URL',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_POSTHOG_HOST', 'NEXT_PUBLIC_META_PIXEL_ID',
  'VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'ORBIT_DAY', 'ORBIT_DIST_DIR', 'CRON_SECRET',
];

/**
 * The environment for local servers and builds: no Redis (so the in-memory store is used and
 * nothing can reach a real leaderboard), no analytics or pixel keys unless a check adds them.
 */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(KV_|UPSTASH_|NEXT_PUBLIC_|VERCEL)/.test(k)) env[k] = '';
  for (const k of BLANKED) env[k] = '';
  return { ...env, NEXT_TELEMETRY_DISABLED: '1', ...extra };
}

/** What the app prints when it falls back to the in-memory store (src/server/store.ts). */
export const MEMORY_STORE_LINE = 'using the in-memory store';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts a process and resolves once `url` answers, or rejects with the last lines of its output. */
export async function startServer(name, cmd, args, { env, url, timeoutMs = 60000 }) {
  const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '', memoryStore = false;
  const keep = (b) => { const t = b.toString(); if (t.includes(MEMORY_STORE_LINE)) memoryStore = true; log = (log + t).slice(-4000); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  let exited = null;
  child.on('exit', (code) => { exited = code ?? 'signal'; });
  const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`${name} exited (${exited}) before it was ready:\n${log}`);
    try { if ((await fetch(url)).status < 500) return { name, stop, log: () => log, memoryStore: () => memoryStore }; } catch { /* not up yet */ }
    await sleep(300);
  }
  stop();
  throw new Error(`${name} did not answer at ${url} within ${timeoutMs / 1000}s:\n${log}`);
}

/** Collects named checks; each one passes or fails with a one-line reason. */
export function reporter() {
  const results = [];
  return {
    async check(name, fn) {
      const t0 = Date.now();
      try {
        await fn();
        results.push({ name, ok: true });
        console.log(`PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (e) {
        const reason = String(e?.message ?? e).split('\n')[0];
        results.push({ name, ok: false, reason });
        console.log(`FAIL  ${name}: ${reason}`);
      }
    },
    skip(name, reason) {
      results.push({ name, ok: false, reason: 'not run: ' + reason });
      console.log(`FAIL  ${name}: not run: ${reason}`);
    },
    summary(title) {
      const failed = results.filter((r) => !r.ok);
      console.log(`\n${title}: ${results.length - failed.length}/${results.length} passed`);
      for (const f of failed) console.log(`  FAIL ${f.name}: ${f.reason}`);
      return failed.length === 0;
    },
  };
}

export function assert(cond, message) {
  if (!cond) throw new Error(message);
}
