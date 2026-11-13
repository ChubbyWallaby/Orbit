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
