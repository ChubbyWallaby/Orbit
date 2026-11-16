# Orbit

A daily 3D space puzzle. A station fires a laser that bends around planets. Drag the moon into the beam and turn its mirror so the light bounces into the beacon. Everyone gets the same puzzle each day (UTC), with 3 shots.

## How scoring works

- A hit on shot 1, 2 or 3 scores 1,000, 700 or 400 points.
- Helpers cost points if you win: Long-range scanner −150 (shows 20% more of the aiming line), Mirror satellite −200 (an extra mirror you place), Energized laser −200 (asteroids the beam hits explode and stay gone for your later shots). Minimum win score 50.
- Missing all three shots scores 0, and the game still counts.
- Streak: consecutive days with the beacon lit. A miss or a skipped day resets it. The leaderboard shows each pilot's best streak.

## Puzzle pieces

Most days add a special piece, and some days add two. Each piece is placed so it matters for that day's beam:

- **Black hole**: strong gravity, swallows light.
- **Repulsor**: negative mass. It pushes light away instead of pulling it in.
- **Beam splitter**: splits the laser in two. Either beam can win.
- **Wormhole pair**: light enters one mouth and leaves the other, still heading the same way.
- **Fixed mirrors**: gold-framed mirrors on the board that bounce the beam, for bank shots. The aiming line keeps going past them.
- **Fading light + relay**: the light fades after a set distance. Passing through the gold relay ring gives it its full range back. The solver only accepts solutions that need the relay.
- **Twin laser stations**: a second station fires at the same moment. Any beam that reaches the beacon wins. Some days both stations can be solved, some days only one.

Small moons go round their planets on the dashed orbit ring, so the board changes while you aim: a moon can drift into the beam and swallow it, or move out of the way. All moons are back where they started every 4 minutes, and everyone sees them in the same place because they follow the clock. When you fire, the moons freeze until you move something, and the server checks the shot with the moons where they were at that moment. Nothing can be placed on a moon's orbit.

The all-time leaderboard adds up every day's points. There is also a board for today.

Every shot is checked on the server: it re-runs the physics, counts the shot, and computes the score, so the browser cannot claim a result.

Shots from scripts are turned away. The page runs the moons on the server's clock, and a shot whose moons are more than 10 seconds away from where they really are is rejected; firing again at the moment the last shot froze is still fine. A winning shot is also rejected, with a message and without using up a shot, if the page reports no drag or turn of the moon, mirror or satellite, or if it comes less than 20 seconds after the pilot first opened the day's board. Misses are never checked. This stops copy-paste solvers, not a determined cheat: the board and the physics have to reach the browser for the aiming line to work.

## More puzzles

After today's puzzle, **More puzzles** offers two ways to keep playing. Neither counts for the daily leaderboards or the streak; Voyage has a leaderboard of its own.

- **Past days**: every earlier daily puzzle, playable once each if you haven't finished it (`?day=YYYY-MM-DD`). Helpers work as usual, and the result is marked "(archive)" when shared.
- **Voyage**: numbered levels, the same for everyone, that get harder as you go (`?voyage=N`). Each level gives 3 shots; a hit earns 3, 2 or 1 stars, opens the next level, and you can retry or replay any open level. Progress is saved on the server. The **Voyage leaderboard** ranks named pilots by total stars (best run per level), then by levels cleared; stars earned before picking a name count once you pick one. Voyage wins get the same script checks as daily wins, except a win only counts as too fast under 10 seconds after opening the level.
  - Levels 1–6 are plain boards with a wide mirror and a long aiming line; moons stand still until level 13.
  - Levels 7–27 bring in one piece per chapter of three (black holes, fixed mirrors, repulsors, wormholes, splitters, fading light, twin stations).
  - Difficulty is measured by how many winning shots the solver finds (fewer is harder). Each level has a target that falls steadily from 30 at level 1 to about 6 at level 27, rising again at the start of each chapter, then slides from about 12 towards 4 in Deep Space with an easier level every five. The builder makes 5 boards per level and keeps the one closest to the target.
  - From level 28, Deep Space mixes pieces: two pieces sometimes from 45 and always from 70, and smaller mirrors from 50. It never ends.
  - Levels 1–60 are prebuilt in `src/game/voyage-levels.json` (rebuild with `npx tsx scripts/build-voyage.ts`, about 25 minutes). Later levels are generated the first time someone reaches them and kept in the store.

## Project layout

- `src/game/engine.ts`: light-bending physics and mirror reflections, shared by browser and server
- `src/game/generate.ts`: deterministic daily level generator plus a solver that guarantees each level is winnable with a bounce
- `src/game/voyage-spec.ts`, `src/game/voyage.ts`: the Voyage difficulty curve and level builder
- `src/game/rules.ts`: scoring, helpers, puzzle calendar, share text
- `src/game/scene.ts`: three.js renderer
- `src/server/`: game service, Redis store, cookie-based player id
- `src/app/api/*`: `today`, `player`, `helper`, `shot`, `leaderboard`, `archive`, `voyage`

## Running locally

```bash
npm install
npm run dev
```

Without Redis credentials the app uses an in-memory store that resets when the server restarts.

To play a different day's puzzle while testing, set `ORBIT_DAY`, for example `ORBIT_DAY=2026-11-14 npm run dev`. This is ignored in production.

```bash
npm test
```

## Embedding on game portals

`embed/index.html` is a one-page wrapper that loads orbitpuzzle.com in a full-size iframe. Zip it and upload it as an HTML5 game (itch.io: "This file will be played in the browser"). Change `ref=` in it for each portal.

Inside another site's iframe the player cookie is third-party, so in production it is set `SameSite=None; Secure; Partitioned`. Browsers that block it anyway (Safari) still work: the page keeps the player id in its storage and sends it as an `x-orbit-pid` header. Because cookies now travel with cross-site requests, the API only accepts POSTs sent as `application/json`, which another site cannot forge.

## Deploying

Set `ORBIT_SEED_SECRET` to a long random string (for example `openssl rand -hex 32`) in the Vercel project's environment variables, and keep it private. The level generator is in this public repository, so without the secret anyone could run it for any day and read the solution. Changing or removing the secret changes every board that is not already cached, so set it once and leave it.

Deploy to Vercel and add the **Upstash Redis** integration from the Vercel Marketplace. It sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which the app picks up automatically. In production the app refuses to start the leaderboard without them, rather than silently losing scores.
