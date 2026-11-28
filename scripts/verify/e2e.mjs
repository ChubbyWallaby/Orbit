// Browser checks of the key flows, against local production builds with the in-memory store.
// Run through `npm run verify` (or `npm run verify:e2e`), which makes the two builds first:
//   .next                    the normal build, no analytics key
//   .next-verify-analytics   the same app built with a fake PostHog key pointing at a local mock
// Every check prints PASS, or FAIL with a one-line reason; the script exits 1 if any failed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { ANALYTICS_DIST, MOCK_HOST, MOCK_PORT, ROOT, assert, cleanEnv, loadPlaywright, reporter, startServer } from './lib.mjs';

const PORT = Number(process.env.VERIFY_PORT || 3301);
const PORT_PH = PORT + 1;

const APP = `http://localhost:${PORT}`;
const APP_PH = `http://localhost:${PORT_PH}`;
const NAME_RE = /^(Nova|Comet|Quasar|Pulsar|Nebula|Meteor|Photon|Zenith|Orion|Vega) \d{4,6}$/;
const voyageLevels = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/game/voyage-levels.json'), 'utf8'));
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

const { chromium, devices } = loadPlaywright();
const r = reporter();
const servers = [];
let browser;

// ---- page helpers ----

/** A brand-new visitor: fresh cookies and storage, on a phone (most players are). */
async function visitor(base, { init } = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1, baseURL: base, permissions: ['clipboard-read', 'clipboard-write'] });
  // a real phone exposes neither webdriver nor userAgentData (whose brands say HeadlessChrome here);
  // posthog-js drops every event from a browser that looks automated
  await ctx.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

const fireButton = (page) => page.getByRole('button', { name: 'Fire', exact: true });

async function openPuzzle(page, url, metaText) {
  await page.goto(url);
  await fireButton(page).waitFor({ timeout: 30000 });
  await page.locator('.meta', { hasText: metaText }).first().waitFor({ timeout: 30000 });
}

/** Turns the moon mirror with the dial (counts as aiming) and fires. Returns the server's answer. */
async function fireAt(page, angle, endpoint) {
  await page.locator('#mirror').fill(String(angle));
  const btn = fireButton(page);
  await page.waitForFunction(() => !document.querySelector('.btn.fire:disabled'));
  const respP = page.waitForResponse((x) => x.url().includes(endpoint) && x.request().method() === 'POST', { timeout: 20000 });
  await btn.click();
  const resp = await respP;
  const body = await resp.json().catch(() => ({}));
  // the beam animation runs while the button is disabled; wait for it to finish
  await page.waitForFunction(() => !document.querySelector('.btn.fire:disabled'), null, { timeout: 20000 });
  return { status: resp.status(), body, request: resp.request().postDataJSON() };
}

/**
 * Plays today's (or an archive day's) puzzle to the end with misses. A hit this early would be turned
 * away as too fast (403) without using a shot, so a different angle is tried then.
 */
async function playToEnd(page, endpoint = '/api/shot') {
  const answers = [];
  let angle = 3;
  for (let tries = 0; tries < 12; tries++) {
    angle = (angle + 47) % 360;
    const a = await fireAt(page, angle, endpoint);
    answers.push(a);
    if (a.status === 403) continue;
    assert(a.status === 200, `shot answered ${a.status}: ${a.body.error ?? ''}`);
    if (a.body.status !== 'playing') return answers;
  }
  throw new Error('the game did not finish after 12 tries');
}

const pageJson = (page, url) => page.evaluate((u) => fetch(u, { headers: { 'x-orbit-pid': localStorage.getItem('orbit:pid') ?? '' } }).then((x) => x.json()), url);

// ---- the checks ----

async function dailyFlows() {
  const { ctx, page, errors } = await visitor(APP);
  let firstName = null, finished = false;

  await r.check('new visitor fires a shot with no name and gets a generated pilot name', async () => {
    await openPuzzle(page, '/', 'Daily #');
    assert(!(await page.locator('#pilot').count()), 'a name form was shown before the first shot');
    const a = await fireAt(page, 50, '/api/shot');
    assert(a.status === 200, `the shot was answered ${a.status}: ${a.body.error ?? ''}`);
    assert(a.body.shot === 1, `expected shot 1, got ${a.body.shot}`);
    assert(NAME_RE.test(a.body.name ?? ''), `no generated pilot name in the shot answer (got ${JSON.stringify(a.body.name)})`);
    firstName = a.body.name;
    assert(/^[0-9a-f-]{36}$/.test((await page.evaluate(() => localStorage.getItem('orbit:pid'))) ?? ''), 'no player id kept by the page');
  });

  await r.check('a finished game appears on the day leaderboard', async () => {
    assert(firstName, 'needs the first check');
    const answers = await playToEnd(page);
    assert(answers.at(-1).body.status !== 'playing', 'game not finished');
    finished = true;
    await page.locator('#resTitle').waitFor({ timeout: 15000 });
    await page.locator('.card').getByRole('button', { name: 'Leaderboard' }).click();
    await page.getByRole('tab', { name: /^Today/ }).click();
    const me = page.locator('tr.you');
    await me.waitFor({ timeout: 10000 });
    const row = await me.innerText();
    assert(row.includes(firstName), `the day board's own row reads "${row.replace(/\s+/g, ' ')}", not ${firstName}`);
    const board = await pageJson(page, '/api/leaderboard?scope=day');
    assert(board.me?.name === firstName, `the day board API has me = ${JSON.stringify(board.me)}`);
    await page.getByRole('button', { name: 'Close' }).click();
  });

  await r.check('the pilot name can be changed from the result card', async () => {
    assert(finished, 'needs a finished game');
    const fresh = 'Ace' + crypto.randomInt(1e6, 1e7);
    await page.getByRole('button', { name: 'Your result' }).click();
    await page.locator('#resTitle').waitFor();
    await page.locator('.card').getByRole('button', { name: 'Change name' }).click();
    await page.locator('#pilot').fill(fresh);
    const saved = page.waitForResponse((x) => x.url().includes('/api/player'));
    await page.getByRole('button', { name: 'Save name' }).click();
    const resp = await saved;
    assert(resp.status() === 200, `saving the name answered ${resp.status()}`);
    await page.locator('#pilot').waitFor({ state: 'detached' });
    const board = await pageJson(page, '/api/leaderboard?scope=day');
    assert(board.me?.name === fresh, `the day board still shows ${board.me?.name}, not ${fresh}`);
    await page.getByRole('button', { name: 'Your result' }).click();
    const text = await page.locator('.card').innerText();
    assert(text.includes(`On the leaderboard as ${fresh}`), 'the result card does not show the new name');
  });

  await r.check('the daily flow raised no page errors', async () => assert(!errors.length, errors[0]));
  await ctx.close();
}

async function archiveFlow() {
  await r.check('archive: a past day loads and accepts a shot', async () => {
    const { ctx, page, errors } = await visitor(APP);
    const day = utcDay(new Date(Date.now() - 86400000));
    await openPuzzle(page, `/?day=${day}`, 'Archive · Daily #');
    const a = await fireAt(page, 120, '/api/shot');
    assert(a.status === 200, `the archive shot was answered ${a.status}: ${a.body.error ?? ''}`);
    assert(a.request.day === day, `the shot was not sent for ${day} (sent ${a.request.day})`);
    assert(a.body.shot === 1 && a.body.play?.shots?.length === 1, `expected one shot used, got ${JSON.stringify(a.body.play?.shots)}`);
    // archive games are not ranked: the day board stays empty for this pilot
    const board = await pageJson(page, '/api/leaderboard?scope=day');
    assert(!board.me, 'an archive shot put the pilot on today\'s board');
    assert(!errors.length, 'page error: ' + errors[0]);
    await ctx.close();
  });
}

async function voyageFlow() {
  await r.check('voyage: level 1 loads, accepts a miss, then a real win clears it', async () => {
    const { level, solution } = voyageLevels[0];
    // start with the moon where the known solution puts it, mirror turned away
    const init = { fn: ([key, p]) => { if (!sessionStorage.getItem('verify:seeded')) { localStorage.setItem(key, p); sessionStorage.setItem('verify:seeded', '1'); } }, arg: [`orbit:placement:${level.day}`, JSON.stringify({ moon: solution.moon, angle: (solution.angle + 180) % 360, satellite: null })] };
    const { ctx, page, errors } = await visitor(APP, { init });
    const opened = Date.now();
    await openPuzzle(page, '/?voyage=1', 'Voyage · Level 1');
    const miss = await fireAt(page, (solution.angle + 180) % 360, '/api/voyage');
    assert(miss.status === 200, `the Voyage shot was answered ${miss.status}: ${miss.body.error ?? ''}`);
    assert(miss.body.status === 'playing' && miss.body.shots?.length === 1, `expected one shot and still playing, got ${JSON.stringify(miss.body.shots)}`);
    // wins sooner than 10 s after opening a level are turned away as scripts
    const wait = 10500 - (Date.now() - opened);
    if (wait > 0) await page.waitForTimeout(wait);
    const win = await fireAt(page, solution.angle, '/api/voyage');
    assert(win.status === 200, `the winning shot was answered ${win.status}: ${win.body.error ?? ''}`);
    assert(win.body.status === 'won' && win.body.unlocked === 2, `expected a win opening level 2, got ${win.body.status} / unlocked ${win.body.unlocked}`);
    await page.locator('#voyTitle', { hasText: 'Level 1 cleared' }).waitFor({ timeout: 10000 });
    assert(!errors.length, 'page error: ' + errors[0]);
    await ctx.close();
  });
}

// ---- analytics ----

function decodeBody(buf) {
  if (!buf) return '';
  let txt;
  try { txt = zlib.gunzipSync(buf).toString(); } catch { txt = buf.toString('latin1'); }
  if (txt.startsWith('data=')) try { txt += '\n' + Buffer.from(decodeURIComponent(txt.slice(5)), 'base64').toString(); } catch { /* not base64 */ }
  return txt;
}

async function analyticsOn(mockLog) {
  const { ctx, page } = await visitor(APP_PH);
  const toMock = [];
  ctx.on('request', async (req) => {
    if (new URL(req.url()).host !== MOCK_HOST) return;
    toMock.push({ url: req.url(), headers: await req.allHeaders().catch(() => req.headers()), body: decodeBody(req.postDataBuffer()) });
  });
  const typed = 'Typed' + crypto.randomInt(1e6, 1e7);
  let pid = null, events = [], logged = [], played = false;
  const readMock = () => {
    logged = fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    events = [];
    for (const l of logged) try { const j = JSON.parse(l.body); for (const e of Array.isArray(j) ? j : j.batch ?? [j]) if (e?.event) events.push(e); } catch { /* not an event batch */ }
  };
  const hashed = () => crypto.createHash('sha256').update('orbit-posthog-v1:' + pid).digest('hex');

  await r.check('analytics build: a full visit plays through (game, rename, leaderboard, leave, return)', async () => {
    await openPuzzle(page, '/', 'Daily #');
    await playToEnd(page);
    await page.locator('#resTitle').waitFor({ timeout: 15000 });
    // rename from the result card, typing into the name field (autocapture must not record it)
    await page.locator('.card').getByRole('button', { name: 'Change name' }).click();
    await page.locator('#pilot').fill(typed);
    await page.getByRole('button', { name: 'Save name' }).click();
    await page.locator('#pilot').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Leaderboard', exact: true }).click();
    await page.locator('#lbTitle').waitFor();
    await page.getByRole('button', { name: 'Close' }).click();
    pid = await page.evaluate(() => localStorage.getItem('orbit:pid'));
    assert(pid && /^[0-9a-f-]{36}$/.test(pid), 'no player id kept by the page');
    // the page leave PostHog sends on pagehide (a real navigation does not deliver it in headless Chromium)
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await page.waitForTimeout(1500);
    // a returning visit in the same browser
    const again = await ctx.newPage();
    await again.goto('/');
    await again.locator('.meta', { hasText: 'Daily #' }).first().waitFor({ timeout: 30000 });
    await again.waitForTimeout(2500); // PostHog sends in batches
    readMock();
    // control: the events really went out, and the check can read them
    assert(toMock.length > 0 && events.length > 0, 'no event reached the analytics host at all, so the analytics checks prove nothing');
    played = true;
  });

  await r.check('with a fake PostHog key, the raw player id never reaches the analytics host', async () => {
    assert(played, 'needs the full visit');
    const leaks = [
      ...toMock.filter((x) => (x.url + JSON.stringify(x.headers) + x.body).includes(pid)).map((x) => 'browser request ' + new URL(x.url).pathname),
      ...logged.filter((l) => JSON.stringify(l).includes(pid)).map((l) => 'received ' + l.path),
    ];
    assert(!leaks.length, `the raw player id was sent to the analytics host: ${leaks[0]}`);
    const game = events.filter((e) => ['first_shot', 'shot', 'puzzle_finished', 'name_set', 'leaderboard_viewed'].includes(e.event));
    assert(game.length && game.every((e) => (e.properties?.distinct_id ?? e.distinct_id) === hashed()), 'game events are not identified by the hashed player id');
  });

  await r.check('analytics: every game event arrives with app=orbit and the right details', async () => {
    assert(played, 'needs the full visit');
    const names = events.map((e) => e.event);
    for (const want of ['$pageview', 'puzzle_viewed', 'first_shot', 'shot', 'puzzle_finished', 'name_set', 'leaderboard_viewed', '$pageleave']) assert(names.includes(want), `the analytics host never got ${want} (got ${[...new Set(names)].join(', ')})`);
    const noApp = events.filter((e) => e.properties?.app !== 'orbit');
    assert(!noApp.length, 'events without app=orbit: ' + noApp.map((e) => e.event).join(', '));
    const shots = events.filter((e) => e.event === 'shot').map((e) => e.properties.attempt);
    assert(shots.join() === '1,2,3', `shot attempts were ${shots.join() || 'none'}, not 1,2,3`);
    const fin = events.find((e) => e.event === 'puzzle_finished').properties;
    assert(fin.attempts === 3 && fin.mode === 'daily' && fin.result === 'lost' && typeof fin.time_taken_s === 'number', `puzzle_finished props ${JSON.stringify({ attempts: fin.attempts, mode: fin.mode, result: fin.result, time_taken_s: fin.time_taken_s })}`);
    assert(events.find((e) => e.event === 'name_set').properties.renamed === true, 'name_set does not say it was a rename of the generated name');
  });

  await r.check('analytics: a returning visit is recognised by the same hashed id', async () => {
    assert(played, 'needs the full visit');
    const views = events.filter((e) => e.event === '$pageview');
    assert(views.length >= 2, `expected a page view for each visit, got ${views.length}`);
    const id = views.at(-1).properties?.distinct_id ?? views.at(-1).distinct_id;
    assert(id === hashed(), `the second visit's page view has distinct id ${String(id).slice(0, 16)}…, not the hashed player id`);
  });

  await r.check('analytics: a typed pilot name is never sent, and nothing else is stored', async () => {
    assert(played, 'needs the full visit');
    const withName = logged.filter((l) => JSON.stringify(l).includes(typed));
    assert(!withName.length, `the typed name reached the analytics host (${withName.map((l) => l.path).join(', ')})`);
    const cookies = (await ctx.cookies()).map((c) => c.name);
    assert(cookies.every((c) => c === 'orbit_pid'), 'a cookie other than orbit_pid was set: ' + cookies.join(', '));
    const keys = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
    assert(keys.every((k) => k.startsWith('orbit:')), 'non-game browser storage used: ' + keys.filter((k) => !k.startsWith('orbit:')).join(', '));
  });
  await ctx.close();
}

// ---- run ----

async function main() {
  for (const dir of ['.next', ANALYTICS_DIST]) {
    if (!fs.existsSync(path.join(ROOT, dir, 'BUILD_ID'))) {
      console.log(`FAIL  e2e: no production build in ${dir}. Run npm run verify (or npm run verify:e2e), which builds it.`);
      process.exit(1);
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-verify-'));
  const mockLog = path.join(tmp, 'posthog.jsonl');
  const next = path.join(ROOT, 'node_modules/.bin/next');
  try {
    servers.push(await startServer('mock PostHog', process.execPath, [path.join(import.meta.dirname, 'mock-posthog.mjs'), mockLog, String(MOCK_PORT)], { env: cleanEnv(), url: `http://${MOCK_HOST}/ping` }));
    servers.push(await startServer('app (no analytics key)', next, ['start', '-p', String(PORT)], { env: cleanEnv(), url: APP + '/' }));
    servers.push(await startServer('app (fake analytics key)', next, ['start', '-p', String(PORT_PH)], { env: cleanEnv({ ORBIT_DIST_DIR: ANALYTICS_DIST }), url: APP_PH + '/' }));
    fs.writeFileSync(mockLog, ''); // forget the readiness ping
    // safety: both apps must be on the in-memory store, never a real Redis (e.g. from .env.local)
    // a read of the board makes each app pick its store, and say so in its log
    await Promise.all([APP, APP_PH].map((u) => fetch(u + '/api/leaderboard').catch(() => null)));
    for (let i = 0; i < 20 && !servers.slice(1).every((s) => s.memoryStore()); i++) await new Promise((res) => setTimeout(res, 100));
    for (const s of servers.slice(1)) if (!s.memoryStore()) throw new Error(`${s.name} is not using the in-memory store: a Redis URL reached it (check .env.local); stopping before any shot is fired`);
  } catch (e) {
    console.log('FAIL  e2e: could not start the local servers: ' + e.message.split('\n')[0]);
    console.log(e.message);
    for (const s of servers) s.stop();
    process.exit(1);
  }

  browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  // everything a visitor of the no-key build loads must come from the site itself
  const external = new Set();
  const watch = browser.newContext.bind(browser);
  browser.newContext = async (opts) => {
    const ctx = await watch(opts);
    if (opts?.baseURL === APP) ctx.on('request', (req) => { const u = new URL(req.url()); if (u.host !== `localhost:${PORT}`) external.add(u.host); });
    return ctx;
  };
  try {
    await dailyFlows();
    await archiveFlow();
    await voyageFlow();
    await r.check('with no analytics key, no request leaves the site', async () => {
      assert(!external.size, `requests went to ${[...external].join(', ')}`);
      const sent = fs.readFileSync(mockLog, 'utf8').trim();
      assert(!sent, 'the mock analytics host received requests from the no-key build');
    });
    await analyticsOn(mockLog);
  } finally {
    await browser.close();
    for (const s of servers) s.stop();
  }
  process.exit(r.summary('browser checks') ? 0 : 1);
}

main().catch((e) => { console.log('FAIL  e2e crashed: ' + e.message); for (const s of servers) s.stop(); process.exit(1); });
