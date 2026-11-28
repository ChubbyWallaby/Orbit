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
 * The environment for local servers and builds: no Redis (so the in-memory store is used and
 * nothing can reach a real leaderboard), no analytics or pixel keys unless a check adds them.
 */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(KV_|UPSTASH_|NEXT_PUBLIC_|VERCEL)/.test(k) || k === 'ORBIT_DAY' || k === 'ORBIT_DIST_DIR') delete env[k];
  }
  return { ...env, NEXT_TELEMETRY_DISABLED: '1', ...extra };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts a process and resolves once `url` answers, or rejects with the last lines of its output. */
export async function startServer(name, cmd, args, { env, url, timeoutMs = 60000 }) {
  const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  const keep = (b) => { log = (log + b.toString()).slice(-4000); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  let exited = null;
  child.on('exit', (code) => { exited = code ?? 'signal'; });
  const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`${name} exited (${exited}) before it was ready:\n${log}`);
    try { if ((await fetch(url)).status < 500) return { stop, log: () => log }; } catch { /* not up yet */ }
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
