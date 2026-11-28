// `npm run verify`: every automatic check that runs without the live site, in order.
//   type check · lint · unit tests · production build (+ a copy with a fake analytics key) · browser checks
// `npm run verify:e2e` runs only the two builds and the browser checks.
// Prints one line per step and a summary; exits 1 if anything failed. See VERIFY.md.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ANALYTICS_DIST, FAKE_POSTHOG, ROOT, cleanEnv } from './lib.mjs';

const onlyE2e = process.argv.includes('--e2e');
const bin = (name) => path.join(ROOT, 'node_modules/.bin', name);
const results = [];

function step(name, cmd, args, { env = cleanEnv(), after } = {}) {
  console.log(`\n=== ${name}: ${[path.basename(cmd), ...args].join(' ')}`);
  const t0 = Date.now();
  const res = spawnSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit' });
  let ok = res.status === 0;
  let reason = ok ? '' : res.error ? res.error.message : `exited with ${res.status ?? res.signal}`;
  if (ok && after) try { after(); } catch (e) { ok = false; reason = e.message; }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push({ name, ok, reason, secs });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} (${secs}s)${ok ? '' : ': ' + reason}`);
  return ok;
}

if (!onlyE2e) {
  step('type check', bin('tsc'), ['--noEmit']);
  step('lint', bin('eslint'), ['--max-warnings=0']);
  step('unit tests', bin('vitest'), ['run']);
}
// The analytics copy is built first and moved aside (building straight into another distDir makes
// Next rewrite tsconfig.json), then the normal build goes into .next, as on Vercel.
const analyticsBuilt = step('production build, fake analytics key', bin('next'), ['build'], {
  env: cleanEnv(FAKE_POSTHOG),
  after: () => {
    fs.rmSync(path.join(ROOT, ANALYTICS_DIST), { recursive: true, force: true });
    fs.renameSync(path.join(ROOT, '.next'), path.join(ROOT, ANALYTICS_DIST));
  },
});
const built = step('production build', bin('next'), ['build']);
if (built && analyticsBuilt) step('browser checks', process.execPath, [path.join(import.meta.dirname, 'e2e.mjs')]);
else results.push({ name: 'browser checks', ok: false, reason: 'not run: a build failed', secs: '0.0' });

const failed = results.filter((r) => !r.ok);
console.log(`\nverify: ${results.length - failed.length}/${results.length} steps passed`);
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.secs}s)${r.ok ? '' : ': ' + r.reason}`);
process.exit(failed.length ? 1 : 0);
