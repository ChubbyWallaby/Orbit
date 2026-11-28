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

The browser checks run the production builds with every Redis, analytics, pixel and Vercel variable set to an empty string. They are blanked, not removed: Next.js fills in missing variables from `.env.local` and `.env`, so a removed one would come back with a developer's real credentials. As a safety check, both apps must print that they are using the in-memory store after their first request; if either does not (a Redis URL reached it), the run stops before any shot is fired. Every check starts as a brand-new visitor (fresh cookies and storage).

| Browser check | Proves |
| --- | --- |
| new visitor fires a shot with no name and gets a generated pilot name | the home page loads today's puzzle with no name form in the way; turning the mirror and pressing Fire is accepted by `/api/shot`; the answer carries a generated name like `Nova 4821`; the page keeps a player id |
| a finished game appears on the day leaderboard | playing all three shots (misses) finishes the game and opens the result card; the card's Leaderboard button opens the board, and the Today tab shows the pilot's own row with their generated name; `/api/leaderboard?scope=day` agrees |
| the pilot name can be changed from the result card | Your result → Change name → Save name saves the new name; the day board shows it and the result card says "On the leaderboard as …" |
| the daily flow raised no page errors | no uncaught JavaScript error during the three checks above |
| archive: a past day loads and accepts a shot | `/?day=<yesterday>` loads that day (header says Archive); a shot is sent for that day and counted; it does not put the pilot on today's board |
| voyage: level 1 loads, accepts a miss, then a real win clears it | `/?voyage=1` loads; a miss is accepted; after the 10 s minimum, the known solution (from `voyage-levels.json`) aimed with the dial wins, opens level 2 and shows "Level 1 cleared". This also proves the anti-script checks let a real win through |
| share: with no share sheet, Copy result copies the result with a ref=share link | in a browser without `navigator.share`, the result card's button reads Copy result (no Share button), copies exactly the text on the card, and its last line is `https://orbitpuzzle.com/?ref=share`. The game was opened from `/?ref=share`, and the address still has it |
| share: an archive result opens the share sheet with a ref=share&day= link | with a share sheet (a stand-in for the phone's), the archive day opened from `/?ref=share&day=<yesterday>` loads and plays as that day; its result card's Share button opens the sheet once with url `…/?ref=share&day=<yesterday>` and the result text (marked archive) without the link; nothing goes to the clipboard |
| share: a double tap opens one share sheet and copies nothing | a second tap while the sheet is still open (which a real browser refuses) does not open a second sheet or fall back to the clipboard |
| share: a closed share sheet does nothing; a Voyage share has a ref=share&voyage= link | Voyage opened from `/?ref=share&voyage=1`; closing the sheet (AbortError) changes nothing and does not fall back to the clipboard; sharing then sends url `…/?ref=share&voyage=1` and the stars text; the address keeps `ref=share` |
| with no analytics key, no request leaves the site | across every check above (the build without a key), the browser made no request to any other host, and the mock PostHog host received nothing |
| analytics build: a full visit plays through | on the build with the key: a daily game to the end, a rename from the result card (typing into the name field), the leaderboard, leaving the page, then a second visit in the same browser. Control: events must have reached the mock host, or every analytics check fails as meaningless |
| with a fake PostHog key, the raw player id never reaches the analytics host | the raw player id appears in no URL, header or (decoded) body of any request to the analytics host; game events (shots, finish, rename, leaderboard) carry the one-way SHA-256 hash as the distinct id |
| analytics: every game event arrives with app=orbit and the right details | `$pageview`, `puzzle_viewed`, `first_shot`, `shot`, `puzzle_finished`, `name_set`, `leaderboard_viewed` and `$pageleave` all arrive, every event has `app: "orbit"`, `shot` attempts are 1, 2, 3, `puzzle_finished` has 3 attempts, mode, result and a time taken, `name_set` says it was a rename; a closed share sheet followed by a double-tapped share sends exactly one `result_shared` (method `share`) |
| analytics: a returning visit is recognised by the same hashed id | the second visit's page view carries the same hashed id as the first visit's game |
| analytics: a typed pilot name is never sent, and nothing else is stored | the name typed into the field appears in no request to the analytics host; no cookie other than `orbit_pid` and no browser storage outside `orbit:` keys |

The mock PostHog host listens on `127.0.0.1`, a different host name from the app (`localhost`), as the real PostHog host is: browsers send cookies per host, not per port, so this keeps the `orbit_pid` cookie out of its requests exactly as in production.

Ports used: 3301 and 3302 (the two apps) and 3999 (mock PostHog). Override with `VERIFY_PORT` and `VERIFY_MOCK_PORT`. Playwright and Chromium must be installed (they are in the dev container; CI installs them).

## `npm run verify:live`

`scripts/verify/live.mjs`. Only `GET` requests, without cookies, to `https://orbitpuzzle.com` (the public domain, read from `SITE_URL` in `src/game/rules.ts`) and `https://orbit-xi-eight-25.vercel.app`. Point it elsewhere with `LIVE_URL="https://a https://b"`. Every request carries one fixed, clearly fake player id (`c0dec0de-0000-4000-8000-00000000f00d`, in the `x-orbit-pid` header the site already accepts), so runs never mint new player ids.

| Live check | Proves |
| --- | --- |
| home page answers 200 with the game | the site is up and serves the Orbit page |
| `/api/today` returns today's level and the player id | 200; the level is today's (UTC) with the right puzzle number and has bodies, a station and a beacon; the fixed player id comes back with a game and a streak, and no new cookie is set; the server clock is within a minute |
| (only with `LIVE_NEW_VISITOR=1`) `/api/today` gives a brand-new visitor a player id and cookie | a request with no id gets a fresh valid player id, a fresh unnamed game, and the `orbit_pid` cookie set `Secure; SameSite=None; Partitioned`. Off by default because it mints one new player id per address, as any first visit does |
| `/api/leaderboard?scope=day`, `all`, `voyage` answer 200 | each board answers with its scope, a top list of rows with name, score and rank, and a player count |

It never fires a shot, helper or name, so it never writes to the leaderboard. The only thing it can leave is the note `/api/today` keeps for any player id that opens a day's board (when it was first seen, used by the too-fast check): one per UTC day for the fixed id, however often the checks run, expiring after 400 days. Leaving even that out would need the server to skip the note for one public id, which would let anyone use that id to dodge the too-fast check, so it is not done.

## Not covered

- **The real share sheet.** `navigator.share` is replaced by a stand-in that records what it is given; what each phone or app does with the text and link is not tested.
- **Real devices and browsers.** The browser checks use headless Chromium with an iPhone-sized screen and software WebGL. Safari, Firefox, real GPUs and touch dragging are not tested. The moon is never dragged: it is placed through the page's saved placement and aimed with the mirror dial.
- **What the 3D scene looks like.** No screenshot comparison; a broken render that still lets you fire would pass.
- **Winning today's puzzle in the browser.** The daily solution is secret, so daily browser games are three misses. Daily wins, scores and helpers are covered by the unit tests; a real browser win is covered in Voyage.
- **Helpers, practice mode and the Mirror satellite in the browser** (unit tests only).
- **Redis.** Locally the in-memory store stands in for Upstash; `RedisStore` is exercised only by the live checks, which read and never write.
- **Real PostHog and the Meta Pixel.** PostHog is a local mock (which events arrive and what they carry, not PostHog's processing). The Meta Pixel is not loaded in any check (its id is not set), so only "nothing external without keys" is checked for it.
- **Cron** (`/api/cron`), **iframe embedding** (only the cookie attributes, live), **link previews** and **orbiting moons in the browser** (Voyage level 1 has none; the moon clock is unit tested).
- **The Voyage too-fast check for a brand-new visitor.** Found while proving the checks: `GET /api/voyage` gives no player id to a visitor who has none, so the server never notes when they opened the level, and their first Voyage win is only checked for aiming, not for time. The browser check therefore cannot show the 10 s rule working for a new visitor (the unit tests cover it for a known player). Left as is, since the anti-cheat code is out of scope here.
- **A new visitor in production, by default.** Without `LIVE_NEW_VISITOR=1` the live checks do not prove that a new visitor gets a player id and a third-party-safe cookie in production; the unit tests cover the cookie attributes and the local browser checks cover new visitors.
- **Live writes.** By design, `verify:live` cannot tell whether shots or names work in production; that is what `verify` checks before the merge.
