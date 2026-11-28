// `npm run verify:live`: READ-ONLY smoke checks against the live site.
// Only GET requests to /, /api/today and /api/leaderboard. It never fires a shot, sets a name or
// writes to the leaderboard. (Like any first visit, /api/today hands out a fresh player id and notes
// when that id first saw today's board; no score, name or leaderboard entry is created.)
//
//   npm run verify:live                                   # the public domain and the Vercel deployment
//   LIVE_URL=https://example.vercel.app npm run verify:live   # one or more other addresses, space-separated
//
// Prints PASS, or FAIL with a one-line reason, per check; exits 1 if any failed.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, assert, reporter } from './lib.mjs';

// the public domain, as the game itself uses it (src/game/rules.ts SITE_URL), plus the Vercel deployment
const SITE_URL = fs.readFileSync(path.join(ROOT, 'src/game/rules.ts'), 'utf8').match(/SITE_URL = '([^']+)'/)?.[1];
const DEFAULT_URLS = [SITE_URL, 'https://orbit-xi-eight-25.vercel.app'].filter(Boolean);
const urls = (process.env.LIVE_URL?.trim() ? process.env.LIVE_URL.trim().split(/\s+/) : DEFAULT_URLS).map((u) => u.replace(/\/$/, ''));
const LAUNCH_DAY = fs.readFileSync(path.join(ROOT, 'src/game/rules.ts'), 'utf8').match(/LAUNCH_DAY = '([^']+)'/)?.[1];
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
const puzzleNumber = (day) => Math.round((Date.parse(day + 'T00:00:00Z') - Date.parse(LAUNCH_DAY + 'T00:00:00Z')) / 86400000) + 1;

async function get(url) {
  // no cookies are sent: every request is a brand-new visitor
  const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'orbit-verify-live/1 (read-only smoke check)' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

const r = reporter();
for (const base of urls) {
  console.log(`\n${base}`);
  await r.check(`${base}: home page answers 200 with the game`, async () => {
    const res = await get(base + '/');
    assert(res.status === 200, `home answered ${res.status}`);
    assert(/<title>Orbit<\/title>/.test(res.text), 'home page has no <title>Orbit</title>');
  });

  await r.check(`${base}: /api/today returns today's level and a player id for a new visitor`, async () => {
    const before = utcDay();
    const res = await get(base + '/api/today');
    const after = utcDay();
    assert(res.status === 200, `/api/today answered ${res.status}${res.json?.error ? ': ' + res.json.error : ''}`);
    const j = res.json;
    assert(j?.level, '/api/today has no level');
    assert([before, after].includes(j.level.day), `/api/today serves ${j.level.day}, not today (${after})`);
    assert(j.level.number === puzzleNumber(j.level.day), `level number ${j.level.number}, expected ${puzzleNumber(j.level.day)}`);
    assert(Array.isArray(j.level.bodies) && j.level.bodies.length > 0 && j.level.emitter && j.level.target, 'the level has no bodies, station or beacon');
    assert(/^[0-9a-f-]{36}$/.test(j.pid ?? ''), `no player id for a new visitor (pid=${JSON.stringify(j.pid)})`);
    assert(j.me?.play?.shots?.length === 0 && j.me.name === null, 'a new visitor is not shown a fresh, unnamed game');
    const cookie = res.headers.get('set-cookie') ?? '';
    assert(cookie.includes(`orbit_pid=${j.pid}`), 'the player id cookie is not set to the returned id');
    assert(/Secure/i.test(cookie) && /SameSite=none/i.test(cookie) && /Partitioned/i.test(cookie), 'the player id cookie is not Secure; SameSite=None; Partitioned (embeds would lose it)');
    assert(typeof j.now === 'number' && Math.abs(j.now - Date.now()) < 60000, 'the server clock in /api/today is more than a minute off');
  });

  for (const scope of ['day', 'all', 'voyage']) {
    await r.check(`${base}: /api/leaderboard?scope=${scope} answers 200`, async () => {
      const res = await get(`${base}/api/leaderboard?scope=${scope}`);
      assert(res.status === 200, `answered ${res.status}${res.json?.error ? ': ' + res.json.error : ''}`);
      const j = res.json;
      assert(j?.scope === scope, `scope is ${j?.scope}`);
      assert(Array.isArray(j.top) && typeof j.players === 'number', 'no top list or player count');
      assert(j.top.every((e) => typeof e.name === 'string' && typeof e.score === 'number' && typeof e.rank === 'number'), 'a leaderboard row is missing its name, score or rank');
      assert(j.me === null, 'a visitor with no id is shown as on the board');
    });
  }
}
process.exit(r.summary('live checks') ? 0 : 1);
