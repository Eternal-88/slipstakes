# SLIPSTAKES

A browser multiplayer arcade racer for up to 8 players: race short tracks, win money, spend it on parts, setups and paint that change how your car drives and looks, and gamble at a side casino. Everything is session-scoped. A session of 8 races lasts roughly 50–60 minutes.

## Running it

There's nothing to install: it's plain HTML/JS. Three.js and PeerJS load from the jsDelivr CDN, so an internet connection is needed.

- **GitHub Pages (recommended for school Chromebooks):** upload `index.html`, `js/` and `css/` to a public repo, then go to Settings → Pages and pick `main` / root. Everyone opens the same `https://NAME.github.io/REPO/` link. When you update, replace the files; a hard reload (Ctrl+Shift+R) skips the browser cache.
- **Local:** double-click `index.html`. It uses classic `<script>` tags, so it works from `file://`, unless an admin policy blocks local files.
- **Dev server:** `python tools/serve.py 8765` serves with caching disabled.

**To host:** enter your name and click **Host**, then read out the 5-letter room code. **To join:** click **Join**. Your single-player car choice and paint come with you.

### Controls

All driving keys are rebindable in **Settings → Controls**. The arrow keys always work too.

| Key | Action |
|---|---|
| W / ↑ | Throttle |
| S / ↓ | Brake; held at a standstill it reverses |
| A D / ← → | Steer (tap for small corrections) |
| Space | Handbrake |
| R | Reset to track |
| C | Cycle camera (chase / close / high / fixed-north) |
| **Esc** | **Menu: resume, restart, garage, change car, settings, controls, fullscreen, leave** |
| M | Sound on/off (off by default) |
| F3 | FPS and netcode stats |

Gamepads work too: left stick, RT/LT, A handbrake, Y reset, RB camera, Start menu. The ☰ 🔊 ⛶ buttons in the top-right corner are on every screen. When spectating, 1–8 or Tab picks a car to follow, WASD/Q/E moves a free camera, and the mouse wheel zooms.

## What's in the game

- **Main menu:** Quick race (you against 5 bots on a random track), Host / Join, Resume / Rejoin, Free practice (track picker with map thumbnails and a car picker), Garage, Casino (practice chips), Settings, How to play.
- **Garage, in 5 tabs:**
  - **Parts:** 12 slots, including Brakes, Exhaust, Engine map, Cooling and Differential. Every option lists its upside and its downside.
  - **Tuning:** a free setup sheet with tyre pressures, camber, anti-roll bars, ride height, brake bias, diff lock, final drive, wing angle and boost. The live preview car and the stat bars show the result before you press Apply.
  - **Paint:** 24 paints plus a custom colour picker, 8 liveries, an accent colour, a race number on 7-segment roundels, 5 rim styles and colours, window tint and underglow. It's free and cosmetic, with a turntable view.
  - **Car:** switch chassis. It's free before race 1; between races it's an $800 swap, and your parts move over to the new car.
  - **Service:** repairs.
- **Single-player persistence:** your single-player car, parts, setup, paint and play money are saved between visits.
- **Settings:**
  - **Graphics:** quality tier, resolution scale, shadows, particles, scenery detail, weather, FPS counter.
  - **Audio:** master, engines, effects, interface and music volumes.
  - **Controls:** key rebinding and keyboard steering speed.
  - **Camera & HUD:** camera mode, speed FOV, camera shake, km/h or mph, name tags, minimap, hints, HUD size.

### Session flow

Lobby (room code, chat, host settings) → car select → then, each race:

1. **Race or sit out.** You have 20 s to choose.
2. **Betting.** Spectators bet with odds; racers make side bets with each other.
3. **The race.** Five start lights, then GO.
4. **Results and payouts.**
5. **Intermission:** garage, standings, casino.

After the last race comes a final standings screen with awards.

## Driving model notes (new in this version)

- **ABS (every car):** the brakes hold each tyre just under its grip peak instead of locking it. Full pedal, which is all a keyboard can do, is the shortest stop, and you can still steer. Before this, a keyboard driver spent about 12 s with locked front wheels every two laps.
- **Brake temperature and fade:** every stop heats the brakes and airflow cools them. Road brakes fade by up to 40% late in a hard race. Sport pads and carbon discs have weak cold bite, and the big brake kit barely fades. The HUD has a BRAKES gauge, and the shop's Braking bar shows real cold and hot stopping distances.
- **Grip-limited steering assist:** in understeer only (body slip under 3°), steering is kept within 1.3× the front tyres' peak slip angle, so full keyboard lock stops scrubbing the fronts. Slides and handbrake turns are untouched.
- **Differentials:** the lock splits torque by wheel load; a spool also adds an understeer yaw moment.

## Architecture

| Module | Role |
|---|---|
| `js/physics.js` | 120 Hz vehicle model: per-wheel load/grip/slip, friction circle, differential, ABS, brake heat, steering assist, walls. **Heavily commented.** |
| `js/parts.js` | Cars, 12 part slots, the setup (`TUNES`) and looks (`LOOK`), turned into a physics spec. Honest stat bars, including a braking model; warnings. |
| `js/settings.js` | Player preferences and key bindings (localStorage). |
| `js/trackbuild.js`, `js/tracks.js` | Hand-laid tracks turned into queryable splines. Themes control scenery, sea, rain, lighting and mountains. |
| `js/trackmesh.js` | Terrain with a world-space grain shader, road with a rubbered racing line, kerbs, sponsor and 3-2-1 boards, instanced scenery per theme, water, a crowd that cheers, start lights, mountains. |
| `js/carmodel.js` | Low-poly cars built from geometry only: liveries, roundels, rims, calipers, dynamic brake/reverse lights. Four wheels are drawn as one instanced mesh. |
| `js/fx.js`, `js/world.js` | Particles (normal and additive passes), skidmarks, rain; camera presets, FOV kick, shake, sky, adaptive quality governor. |
| `js/audio.js` | Synthesised engines per chassis, surfaces, crashes, UI, casino sounds and a step-sequencer for music. |
| `js/race.js`, `js/session.js`, `js/economy.js`, `js/casino.js` | Race sim, session rules, money and bets, and the tables (all host-authoritative). |
| `js/net.js`, `js/hostrace.js`, `js/clientrace.js`, `js/netpack.js` | PeerJS transport, jitter buffer, snapshots, prediction and reconciliation. |
| `js/ui/*.js` | Screens: menu, garage, lobby, prerace, intermission, casino, HUD, overlay (Esc menu and Settings). |

### Netcode

- **Host-authoritative.** Clients send 4-tick input blocks at 30 Hz, and the host consumes them through a jitter buffer.
- **Input redundancy (new):** each input packet carries the previous two blocks, so a lost packet no longer means the host applies the wrong input.
- **Snapshots:** 20 Hz. Other cars are interpolated 100 ms behind; your own car is predicted and replayed.
- **Setups and paint** travel with the race entrants, so the host and every client build identical physics.
- **Robustness:** rejoin with the same seat, host crash → Resume, a Worker ticker keeps the host alive in a hidden tab, and version-mismatch rejection (protocol 4).

## Test tools (not loaded by the game)

Load one in a running page from the dev console:

```js
var s = document.createElement('script'); s.src = 'tools/telemetry.js'; document.body.appendChild(s)
```

- `tools/telemetry.js`:
  - `T.suite()`: bot laps, skidpad tests, stat bars.
  - `T.kbSuite()`: the keyboard-proxy driver (binary throttle and brake, ramped key steering), run on seven track/car combinations.
- `tools/econ.js`: `await ECON.run({races: 8, seed: 1})`, full headless sessions with the real rules.
- `tools/casino_test.js`: `CASINO_TEST.rules()`, `.edge(200000)`, `.roulette(200000)`.
- **Network simulator:** add `?lag=100&jitter=30&loss=0.05` to a client URL.

The `builds/phase1` … `builds/phase7` folders are runnable snapshots.

## Self-evaluation (final round)

The overall score is the **lowest** category: **7/10**.

| Category | Score | Main evidence | Main gap |
|---|---|---|---|
| Car feel | 7 | A keyboard proxy with ABS never locks the fronts (was about 12 s per 2 laps). With the assist it spends 74 s off-track across 7 runs (was 102 s). Slides are unchanged: Vandal 13°, handbrake 42°. | Never driven by a human. The stock Mule still runs wide (24 s off-track in about 115 s). |
| Upgrade drama | 8 | Road brakes go from 38 m cold to 49 m hot, while the big brake kit and carbon stay at 38 m. A stiff rear bar cuts stability from 8.5 to 6.8 and spins the bot for 2.5 s. Full boost on a Street Turbo overheats in 8 s. Calipers, tips, wing angle and liveries are all visible. | Pressures and camber are subtle (±0.02 g). The straight pipe barely moves lap times. |
| Economic balance | 8 | 3 simulated sessions with the new parts: lowest cash $3,435, leader 1.24–1.33× the median. | Bot evidence only. The last-placed bot finishes at about 0.6× the median. |
| Casino balance | 9 | Blackjack edge 0.44% ± 0.26%, roulette 2.63%, all rule tests pass. Stakes are capped, with a $300 floor. | Variance can still favour a lucky player. |
| Multiplayer robustness | 7 | Over real WebRTC via PeerJS: the guest's spec matches the host's; 0.000 m correction error at 60 ± 20 ms and at 200 ms with 5% loss (with redundancy). Rejoin keeps the seat. The casino and setup changes work from a guest. | Every test ran on one machine; there's no host migration, and car-to-car contact isn't predicted. |
| Performance | 7 | 8 cars at 1366×768: 26–31 draw calls, 88–106k triangles, 0.3–0.45 ms of CPU per frame. No MSAA on the Chromebook tier; the particle pool is capped; the governor has 6 steps. | Never run on a Chromebook. GPU time is about 0.5–1.0 ms on an RTX 3070, which is an estimated 10–30 ms on integrated graphics. |
| Completeness | 8 | Every screen has a way back (Esc menu). The casino works in single-player and multiplayer; settings and rebinding apply live; there are no TODOs or stubs. | No touch controls. Spectator keys aren't rebindable. |

## Assumptions

- PeerJS's free public signalling server is used only for introductions. Some school or corporate firewalls block WebRTC entirely.
- The host is a player too; bots fill empty slots. There's no host migration: if the host's browser dies, they reopen the page and click **Resume**.
- Sound is off by default, as the original brief required. A toast says so on every visit, and M or the 🔊 button turns it on.
