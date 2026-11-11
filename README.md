# Orbit

A daily 3D space puzzle. A station fires a laser that bends around planets. Drag the moon into the beam and turn its mirror so the light bounces into the beacon. Everyone gets the same puzzle each day (UTC), with 3 shots.

## How scoring works

- A hit on shot 1, 2 or 3 scores 1,000, 700 or 400 points.
- Helpers cost points if you win: Long-range scanner −150 (shows 20% more of the aiming line), Mirror satellite −200 (an extra mirror you place), Energized laser −200 (asteroids the beam hits explode and stay gone for your later shots). Minimum win score 50.
- Missing all three shots scores 0, and the game still counts.
- Streak: consecutive days with the beacon lit. A miss or a skipped day resets it. The leaderboard shows each pilot's best streak.

## Puzzle pieces

Most days add one special piece, placed on the laser's path: a **black hole** (strong gravity, swallows light), a **beam splitter** (splits the laser in two; either beam can win) or a **wormhole pair** (light enters one mouth and leaves the other).
- The all-time leaderboard adds up every day's points. There is also a board for today.

Every shot is checked on the server: it re-runs the physics, counts the shot, and computes the score, so the browser cannot claim a result.

## Project layout

- `src/game/engine.ts`: light-bending physics and mirror reflections, shared by browser and server
- `src/game/generate.ts`: deterministic daily level generator plus a solver that guarantees each level is winnable with a bounce
- `src/game/rules.ts`: scoring, helpers, puzzle calendar, share text
- `src/game/scene.ts`: three.js renderer
- `src/server/`: game service, Redis store, cookie-based player id
- `src/app/api/*`: `today`, `player`, `helper`, `shot`, `leaderboard`

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

## Deploying

Deploy to Vercel and add the **Upstash Redis** integration from the Vercel Marketplace. It sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which the app picks up automatically. In production the app refuses to start the leaderboard without them, rather than silently losing scores.
