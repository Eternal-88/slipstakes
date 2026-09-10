# SLIPSTAKES

A browser multiplayer arcade racer for up to 8 players: race short tracks, win money, spend it on parts that change how your car drives, and gamble at a side casino. Everything is session-scoped and nothing persists after a session ends. A session of 8 races lasts roughly 50–60 minutes.

## Running it

There's nothing to install: it's plain HTML/JS. Three.js and PeerJS load from the jsDelivr CDN.

- **Easiest:** put the folder on any static host (GitHub Pages, Netlify, a school web share) and open `index.html`.
- **Local:** double-click `index.html`. It uses classic `<script>` tags, so it works from `file://`.
- **Dev server:** `python tools/serve.py 8765` serves with caching disabled.

**To host:** enter your name, click **Host a session**, and read out the 5-letter room code. **To join:** click **Join with a code**.
You can also try it solo: **Free practice** with bots, or the **Garage sandbox** with $25k to spend.

### Controls

| Key | Action |
|---|---|
| W / ↑ | Throttle |
| S / ↓ | Brake; held at a standstill it reverses |
| A D / ← → | Steer |
| Space | Handbrake |
| R | Reset to track |
| C | Switch camera (chase or fixed-north) |
| M | Sound on/off (off by default) |
| F3 | FPS and netcode stats |

A gamepad works too: left stick, RT/LT, and A for the handbrake. When spectating, 1–8 or Tab picks a car to follow, WASD/Q/E moves a free camera, and the wheel zooms.

## Session flow

Lobby (room code, chat, host settings: race count and bots) → car select → then, each race:

1. **Race or sit out.** You have 20 s to choose.
2. **Betting.** Sitters bet on racers at odds derived from recent form and each car's stats on *this* track. Racers can challenge each other to side bets ("I'll beat you, $500").
3. **The race.** Spectators watch live with a free camera, and their bets show on the HUD.
4. **Results and payouts:** prize, fastest lap, places gained, sponsor stipend, fuel bill, then bet settlement.
5. **Intermission:** garage, standings, and the casino.

After the last race comes a final standings screen with awards.

Formats rotate through circuit, sprint (point-to-point) and drag, with the same format never twice in a row, across 8 hand-laid tracks.

## Architecture

| Module | Role |
|---|---|
| `js/physics.js` | Vehicle model: 120 Hz fixed step, per-wheel load/grip/slip, friction circle, limited-slip diff, walls. **Heavily commented.** |
| `js/parts.js` | Cars and parts turned into physics spec, honest stat bars, interaction warnings, repair prices. |
| `js/trackbuild.js`, `js/tracks.js` | Hand-laid polygon + corner-radius definitions, turned into a Catmull-Rom spline with per-sample width, banking, surface and kerbs. O(1) nearest-point queries. |
| `js/race.js` | `RaceSim`: grid, countdown, laps, car-vs-car collisions, finishing order. Host only. |
| `js/session.js` | `HostSession`: the single authoritative session state (plain JSON, autosaved every 30 s). |
| `js/economy.js` | Payouts, odds (Plackett-Luce Monte Carlo), bets, side bets, bot shopping. |
| `js/casino.js` | Blackjack and roulette engines, host-authoritative. |
| `js/net.js` | PeerJS transport: star topology, two DataChannels per client, heartbeats, reconnects. **Heavily commented.** |
| `js/hostrace.js` | Host race loop: per-client input jitter buffer, 20 Hz snapshots. |
| `js/clientrace.js` | Client: snapshot interpolation for other cars, prediction and replay reconciliation for your own. |
| `js/game.js` | Session controller for both roles: host/join/resume/rejoin, screen sync. |
| `js/world.js`, `carmodel.js`, `trackmesh.js`, `fx.js` | Rendering: flat-shaded low-poly, instancing, adaptive quality. |

### Netcode

- **The host is authoritative.** Only the host's browser runs the race simulation.
- **Inputs:** clients send steer/throttle/brake as 4-tick blocks at 30 Hz. The host consumes them through a small jitter buffer at exactly the rate the client produced them.
- **Snapshots:** the host broadcasts at 20 Hz.
- **Other cars** are drawn 100 ms in the past, interpolated between snapshots.
- **Your own car** is predicted locally with the same physics, then rewound to the host's state and replayed from the unacknowledged inputs. Any visual error is smoothed over 100 ms.
- **Car-vs-car contacts** are never predicted; the host resolves them.
- **Robustness:**
  - A dropped client's car parks.
  - Rejoining with the same per-tab token restores the seat, even mid-race.
  - A host crash is recovered by **Resume hosted session**, which reclaims the same room code and voids and refunds the interrupted race.
  - The host keeps simulating even if its tab is minimised: a Web Worker timer takes over when `requestAnimationFrame` stops.

## Test tools (not loaded by the game)

- `tools/telemetry.js`: bot lap times, powerslide/handbrake/lift-off skidpad tests, stat bars, sim cost.
- `tools/econ.js`: full headless sessions with the real rules, to check nobody is eliminated and nobody runs away.
- `tools/casino_test.js`: blackjack rule proofs using a stacked shoe, a 300k-hand basic-strategy house-edge Monte Carlo, and a roulette edge check.
- `?lag=120&jitter=40&loss=0.05` on a client URL simulates a bad network.

Load a tool in a running page with the dev console:

```js
var s = document.createElement('script'); s.src = 'tools/econ.js'; document.body.appendChild(s)
```

`builds/phase1` … `builds/phase5` are the runnable snapshots taken at the end of each build phase.

## Self-evaluation (final round)

The overall score is the **lowest** category score: **7/10**.

| Category | Score | Main evidence | Main gap |
|---|---|---|---|
| Car feel | 7 | A keyboard-only test driver completes laps with 0 spins. Stock powerslide is ~9°, a handbrake flick ~40°. | Never tested by human hands. Binary-input drivers still run wide ~15–25 s per 150 s. |
| Upgrade drama | 8 | Big Turbo + Race Shell slides to 52° (stock 9°), and in a T-bone it's shoved 3.2 m/s vs 2.0 m/s and spun 41°/s vs 9°/s. Race dampers cost 9.5 s/lap on dirt. Soft tyres wear 52% per race vs 17% for hard. | Aero is only ~0.3 s on Harbour. The short-gear edge is small. |
| Economic balance | 8 | 6 simulated sessions: minimum cash $2,549, leader 1.23–1.75× the median. | Bot evidence only. The Mule is the weakest car outside drags. |
| Casino balance | 9 | Blackjack edge 0.33% and 0.51% (±0.21%), roulette 2.46% (theory 2.70%). Capped stakes, intermission only, and a repair floor. | Variance can still favour a lucky player. |
| Multiplayer robustness | 7 | Max correction 0.125 m at 200 ms RTT, 30 ms jitter and 5% loss. Rejoin, host-crash resume and seat tokens all tested. | Tested on one machine only, no host migration, contacts aren't predicted. |
| Performance | 7 | JS ≈ 0.3 ms per frame; GPU 0.41 ms at 1366×768 on an RTX 3070. GPU tier detection plus an adaptive governor. | Never run on a Chromebook. Estimated 8–16 ms per frame on integrated GPUs. |
| Completeness | 8 | Every system in the brief is exercised end to end. No TODOs or stubs. | No 3D car preview in car select, no touch controls. |

**What reaching 8 would take:**
- **Car feel:** playtests with real keyboard players, then a steering-assist tuning pass.
- **Multiplayer robustness:** a two-network test (home broadband plus a school network or phone hotspot), and ideally host migration. The autosave format already contains everything a promoted client would need.
- **Performance:** an 8-car run on a real Chromebook with the F3 overlay, then tune the "medium" profile from what it shows.

## Assumptions

- **Networking:** PeerJS's free public signalling server is used only for the introduction; racing traffic is peer-to-peer. PeerJS's default STUN/TURN config handles most NATs. Some school or corporate firewalls block WebRTC entirely. There is no server code, as the brief required.
- **Host:** the host is a player too, and bots fill empty grid slots. There is no host migration. If the host's browser dies, the host reopens the page and resumes, and clients reconnect automatically.
- **Pacing:** the tables open only during the intermission, and every stake respects a $300 repair floor.
