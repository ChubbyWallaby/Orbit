// Browser check for the PostHog tracking. Plays today's puzzle on a phone viewport (Facebook's
// in-app browser) against a production build and checks what reached the PostHog host.
//
//   node scripts/analytics-check/mock-posthog.mjs &          # stand-in PostHog host on :3999
//   NEXT_PUBLIC_POSTHOG_KEY=phc_fake NEXT_PUBLIC_POSTHOG_HOST=http://localhost:3999 npx next build && npx next start -p 3201 &
//   BASE=http://localhost:3201 EXPECT=on node scripts/analytics-check/check.mjs
//   # then build without the two variables and run with EXPECT=off: nothing may leave the site
//
// Needs Playwright (preinstalled in the dev container; otherwise `npx playwright install chromium`).
import { createRequire } from 'node:module';
// require() so a globally installed Playwright (NODE_PATH) is found too
const { chromium, devices } = createRequire(import.meta.url)('playwright');
import fs from 'node:fs';
import crypto from 'node:crypto';
const BASE = process.env.BASE, EXPECT = process.env.EXPECT;
const MOCK = import.meta.dirname + '/events.jsonl';
const fail = (m) => { console.log('FAIL:', m); process.exitCode = 1; };
(async () => {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  // a real phone in Facebook's in-app browser (most visitors), not a headless bot
  const fbUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.97;FBBV/620000000;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]';
  const ctx = await browser.newContext({ ...devices['iPhone 13'], userAgent: fbUA, deviceScaleFactor: 1, permissions: ['clipboard-read', 'clipboard-write'] });
  // iPhones expose neither webdriver nor userAgentData (whose brands say HeadlessChrome here)
  await ctx.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  });
  const events = [], external = [], phPaths = new Set();
  ctx.on('request', (r) => { const u = new URL(r.url()); if (u.hostname !== 'localhost' || u.port === '3999') external.push(r.url()); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Fire', exact: true }).waitFor({ timeout: 60000 });
  // today's flow on main: the name form first (on the play-fix branch it is skipped)
  if (await page.locator('#pilot').count()) {
    await page.locator('#pilot').fill('Tracker' + Math.floor(Math.random() * 1e6));
    await page.getByRole('button', { name: 'Start playing' }).click();
    await page.waitForTimeout(600);
  }
  for (let i = 0; i < 3; i++) {
    await page.locator('#mirror').fill(String(10 + i * 7));
    const resp = page.waitForResponse((r) => r.url().includes('/api/shot'));
    await page.getByRole('button', { name: 'Fire', exact: true }).click();
    const j = await (await resp).json();
    if (j.error) fail('shot error ' + j.error);
    if (j.status && j.status !== 'playing') break;
    await page.waitForTimeout(1500);
  }
  await page.locator('#resTitle').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Copy result' }).click();
  await page.waitForTimeout(300);
  await page.locator('.card').getByRole('button', { name: 'Leaderboard' }).click();
  await page.waitForTimeout(800);
  const pid = await page.evaluate(() => localStorage.getItem('orbit:pid'));
  const storage = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }));
  const cookies = (await ctx.cookies()).map((c) => c.name);
  // the page-leave PostHog sends on pagehide (a real navigation away did not deliver it in headless Chromium)
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
  await page.waitForTimeout(1000);
  await page.goto(BASE + '/api/leaderboard?scope=all');
  await page.waitForTimeout(1500);
  // a returning visit in the same browser: recognised by the game's own player id from the first event
  const page2 = await ctx.newPage();
  await page2.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page2.waitForTimeout(3000);
  await browser.close();

  console.log('external requests:', external.length ? [...new Set(external.map((u) => new URL(u).host))] : 'none');
  console.log('cookies:', cookies, 'localStorage:', storage.local, 'sessionStorage:', storage.session);
  if (cookies.some((c) => c !== 'orbit_pid')) fail('a cookie other than orbit_pid was set');
  if ([...storage.local, ...storage.session].some((k) => !k.startsWith('orbit:'))) fail('non-game browser storage used');
  if (EXPECT === 'off') {
    if (fs.readFileSync(MOCK, 'utf8').trim()) fail('the PostHog host received requests');
    if (external.length) fail('requests left the site without a PostHog key: ' + external.join(', '));
    else console.log('PASS: no key, nothing sent');
    return;
  }
  for (const line of fs.readFileSync(MOCK, 'utf8').split('\n').filter(Boolean)) {
    const { path, body } = JSON.parse(line); phPaths.add(path);
    if (!['/e/', '/batch/', '/i/v0/e/'].includes(path)) continue;
    try { const j = JSON.parse(body); for (const e of Array.isArray(j) ? j : j.batch ?? [j]) if (e.event) events.push(e); } catch {}
  }
  const names = events.map((e) => e.event);
  console.log('PostHog paths:', [...phPaths]);
  console.log('events:', names.join(', '));
  for (const want of ['$pageview', 'puzzle_viewed', 'name_set', 'first_shot', 'shot', 'puzzle_finished', 'result_shared', 'leaderboard_viewed', '$pageleave']) if (!names.includes(want)) fail('missing ' + want);
  if (events.some((e) => e.properties?.app !== 'orbit')) fail('event without app=orbit: ' + events.filter((e) => e.properties?.app !== 'orbit').map((e) => e.event));
  const shots = events.filter((e) => e.event === 'shot').map((e) => e.properties.attempt);
  if (shots.join() !== '1,2,3') fail('shot attempts ' + shots);
  const fin = events.find((e) => e.event === 'puzzle_finished')?.properties ?? {};
  console.log('puzzle_finished props:', { mode: fin.mode, result: fin.result, attempts: fin.attempts, time_taken_s: fin.time_taken_s, score: fin.score });
  if (fin.attempts !== 3 || typeof fin.time_taken_s !== 'number') fail('puzzle_finished props');
  // the player id is a credential: it must never reach PostHog, only its one-way hash
  const raw = fs.readFileSync(MOCK, 'utf8');
  if (raw.includes(pid)) fail('the raw player id was sent to PostHog');
  else console.log('raw player id absent from all', raw.trim().split('\n').length, 'requests to PostHog');
  const hashed = crypto.createHash('sha256').update('orbit-posthog-v1:' + pid).digest('hex');
  const after = events.filter((e) => ['first_shot', 'shot', 'puzzle_finished', 'result_shared'].includes(e.event));
  if (!after.every((e) => (e.properties.distinct_id ?? e.distinct_id) === hashed)) fail('game events not identified with the hashed player id ' + hashed + ': ' + after.map((e) => e.properties.distinct_id));
  else console.log('game events identified with the hashed player id', hashed.slice(0, 12) + '…');
  if (events.some((e) => e.event === '$autocapture' && JSON.stringify(e).includes('Tracker'))) fail('typed name captured');
  const views = events.filter((e) => e.event === '$pageview');
  console.log('second visit $pageview distinct_id:', views[1]?.properties.distinct_id);
  if (EXPECT === 'on' && views[1]?.properties.distinct_id !== crypto.createHash('sha256').update('orbit-posthog-v1:' + pid).digest('hex')) fail('returning visit not recognised');
  const leave = events.find((e) => e.event === '$pageleave')?.properties ?? {};
  console.log('$pageleave props:', { app: leave.app, prev_pageview_duration: leave.$prev_pageview_duration, distinct_id: leave.distinct_id });
  if (!process.exitCode) console.log('PASS: tracking events sent with app=orbit');
})();
