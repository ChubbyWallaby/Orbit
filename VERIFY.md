# Verification

Everything here runs automatically. Nothing needs testing by hand.

| Command | When | What it touches |
| --- | --- | --- |
| `npm run verify` | before every merge (CI runs it on each pull request) | only this machine: local builds, in-memory store, a local stand-in for PostHog |
| `npm run verify:e2e` | the builds and browser checks only (quicker while working on the UI) | same as above |
| `npm run verify:live` | after a deploy, or any time | the live site, **read-only** (GET requests only) |

Each check prints `PASS`, or `FAIL` with a one-line reason, and the command exits non-zero if anything failed. `verify` takes about 5 minutes, most of it the unit tests.

## `npm run verify`

Steps, in order (`scripts/verify/run.mjs`):

| Step | Proves |
| --- | --- |
| type check (`tsc --noEmit`) | the TypeScript compiles with `strict` on |
| lint (`eslint --max-warnings=0`) | Next.js and React lint rules pass, with no warnings |
| unit tests (`vitest run`, `tests/game.test.ts`) | scoring, the puzzle calendar and share text; the level generator is deterministic and every day is solvable; the physics of each piece (black holes, repulsors, splitters, wormholes, mirrors, relays, twin stations, orbiting moons); the server game: names, generated names, unique names, the moon-clock, aiming and too-fast script checks, helpers, archive and Voyage rules, leaderboards, streaks, the player id cookie and header |
| production build, fake analytics key | the app builds with `NEXT_PUBLIC_POSTHOG_KEY` set (a fake key, with a local mock as the PostHog host). Kept in `.next-verify-analytics/` |
| production build | `next build` succeeds as on Vercel, with no keys set. Kept in `.next/` |
| browser checks (`scripts/verify/e2e.mjs`) | the flows below, in headless Chromium on a phone-sized screen, against `next start` of both builds |

The browser checks run the production builds with no Redis variables, so the app uses its in-memory store and can never reach the real leaderboard. Every check starts as a brand-new visitor (fresh cookies and storage).

| Browser check | Proves |
| --- | --- |
| new visitor fires a shot with no name and gets a generated pilot name | the home page loads today's puzzle with no name form in the way; turning the mirror and pressing Fire is accepted by `/api/shot`; the answer carries a generated name like `Nova 4821`; the page keeps a player id |
| a finished game appears on the day leaderboard | playing all three shots (misses) finishes the game and opens the result card; the card's Leaderboard button opens the board, and the Today tab shows the pilot's own row with their generated name; `/api/leaderboard?scope=day` agrees |
| the pilot name can be changed from the result card | Your result → Change name → Save name saves the new name; the day board shows it and the result card says "On the leaderboard as …" |
| the daily flow raised no page errors | no uncaught JavaScript error during the three checks above |
| archive: a past day loads and accepts a shot | `/?day=<yesterday>` loads that day (header says Archive); a shot is sent for that day and counted; it does not put the pilot on today's board |
| voyage: level 1 loads, accepts a miss, then a real win clears it | `/?voyage=1` loads; a miss is accepted; after the 10 s minimum, the known solution (from `voyage-levels.json`) aimed with the dial wins, opens level 2 and shows "Level 1 cleared". This also proves the anti-script checks let a real win through |
| with no analytics key, no request leaves the site | across every check above (the build without a key), the browser made no request to any other host, and the mock PostHog host received nothing |
| with a fake PostHog key, the raw player id never reaches the analytics host | on the build with the key, a full daily game is played. Control first: the mock host must have received `$pageview`, `puzzle_viewed`, `first_shot` and `puzzle_finished`, otherwise the check fails as meaningless. Then: the raw player id appears in no URL, header or (decoded) body of any request to the analytics host; game events carry the one-way SHA-256 hash as the distinct id; every event has `app: "orbit"`; no cookie other than `orbit_pid` and no browser storage outside `orbit:` keys |

The mock PostHog host listens on `127.0.0.1`, a different host name from the app (`localhost`), as the real PostHog host is: browsers send cookies per host, not per port, so this keeps the `orbit_pid` cookie out of its requests exactly as in production.

Ports used: 3301 and 3302 (the two apps) and 3999 (mock PostHog). Override with `VERIFY_PORT` and `VERIFY_MOCK_PORT`. Playwright and Chromium must be installed (they are in the dev container; CI installs them).

## `npm run verify:live`

`scripts/verify/live.mjs`. Only `GET` requests, without cookies, to `https://orbitpuzzle.com` (the public domain, read from `SITE_URL` in `src/game/rules.ts`) and `https://orbit-xi-eight-25.vercel.app`. Point it elsewhere with `LIVE_URL="https://a https://b"`.

| Live check | Proves |
| --- | --- |
| home page answers 200 with the game | the site is up and serves the Orbit page |
| `/api/today` returns today's level and a player id for a new visitor | 200; the level is today's (UTC) with the right puzzle number and has bodies, a station and a beacon; a new visitor gets a valid player id, a fresh unnamed game, and the `orbit_pid` cookie set `Secure; SameSite=None; Partitioned`; the server clock is within a minute |
| `/api/leaderboard?scope=day`, `all`, `voyage` answer 200 | each board answers with its scope, a top list of rows with name, score and rank, and a player count |

It never fires a shot, helper or name, so it never writes to the leaderboard. The only thing it leaves behind is what any first visit leaves: `/api/today` hands out a new player id and notes when that id first saw today's board.

## Not covered

- **Real devices and browsers.** The browser checks use headless Chromium with an iPhone-sized screen and software WebGL. Safari, Firefox, real GPUs and touch dragging are not tested. The moon is never dragged: it is placed through the page's saved placement and aimed with the mirror dial.
- **What the 3D scene looks like.** No screenshot comparison; a broken render that still lets you fire would pass.
- **Winning today's puzzle in the browser.** The daily solution is secret, so daily browser games are three misses. Daily wins, scores and helpers are covered by the unit tests; a real browser win is covered in Voyage.
- **Helpers, practice mode and the Mirror satellite in the browser** (unit tests only).
- **Redis.** Locally the in-memory store stands in for Upstash; `RedisStore` is exercised only by the live checks, which read and never write.
- **Real PostHog and the Meta Pixel.** PostHog is a local mock (which events arrive and what they carry, not PostHog's processing). The Meta Pixel is not loaded in any check (its id is not set), so only "nothing external without keys" is checked for it.
- **Cron** (`/api/cron`), **iframe embedding** (only the cookie attributes, live), **link previews** and **orbiting moons in the browser** (Voyage level 1 has none; the moon clock is unit tested).
- **Live writes.** By design, `verify:live` cannot tell whether shots or names work in production; that is what `verify` checks before the merge.
