# SLIPSTAKES v4.0 — "Slipstream & Chaos"

A browser multiplayer arcade racer for up to 8 players: race short tracks, win money, spend it on parts, setups and paint that change how your car drives and looks, and gamble at a side casino. Everything is session-scoped. A session of 8 races lasts roughly 50–60 minutes.

## v4.3 — "Open Rooms"

- **Server list** (`js/ui/rooms.js`, `RoomBoard` in `js/relay.js`). Every host publishes a small retained "room card" to the public MQTT brokers (`slipstakes/rooms/v1/<CODE>`), with a Last Will that wipes it if the host vanishes. The list shows fresh cards live: 🌐 Public rooms let you straight in, 🔒 Private rooms (the default) put an Accept / Decline card in front of the host. Hosts set the room name, public/private, max drivers (2–8) and bots in the lobby, and can change them mid-session from the Esc menu.
- **Host migration** (`game.js`, `HostSession.fromMigration`). The host sends its full state, seat tokens included, to the first two "heirs" (connected humans in the order they joined) every 2 s while it changes.
  - **Host drops:** the first heir rebuilds the session and hosts it under `deriveCode(roomId, epoch+1)`, a code every player can compute on their own. Everyone else rejoins that code with their seat token. The second heir takes over under the code after that if the first never shows up. A race that was running is voided, bets are refunded, and the session carries on from the garage.
  - **Host leaves on purpose:** it hands over immediately.
  - **The host's own internet dropped:** it notices it's alone, finds the new room, and rejoins as a player in its own seat.
  - **The autosave is gone.** Nothing is stored between visits.
- **Join any time.** A late joiner spectates the race in progress, races from the next one, and starts with 80% of the poorest connected driver's net worth (never below the normal $3,000).
- **Chat on every screen** (`js/ui/chat.js`). T or Enter opens it, even mid-race. Lines fade in the corner, and an unread badge counts what you missed. The host allows one line per 0.6 s per player.
- **Fixes:**
  - Test drives end when the round starts (the entry phase), not when the race does. Players used to miss the race-or-sit-out choice and the betting.
  - Name tags are drawn above the car model, so they follow hills.
  - On drag strips, bots hold their lane instead of swerving around speed pads. At 215 km/h that swerve spun the Apex on the Mile.
- **Balance pass:** see the Balance guide below.

## Balance guide (v4.3)

**What "balanced" means here.**
1. **Every car is the right pick somewhere, and no car is the right pick everywhere.** Each of the six cars wins 0–4 of the 12 tracks, and on any track the best and worst stock car are within about 8% of each other.
2. **Money buys an edge, not a win.** One part is worth roughly 1–5% on the kind of track it's made for. Every big gain carries a real cost: running costs, wear, or a track type where it hurts.
3. **Keyboard players are the baseline.** Most players are on Chromebook keyboards (all-or-nothing throttle, steering and brakes). A change that only works with a gamepad isn't balanced.
4. **Nobody is ever out of it.** Reverse-standings grid, sponsor stipends, bounty on the leader, optional catch-up, and fair late-join money.
5. **Measure, don't guess.** Time-trial every car on all 12 tracks with two drivers: the analogue bot (skill 0.95) and the keyboard proxy (the same bot squashed to key presses, `kbtt` / `T.kbLaps`).

**Where it stands (stock cars, seconds, bot driver):**

| Track (type) | Vandal | Brick | Sting | Mule | Dune | Apex | Best |
|---|---|---|---|---|---|---|---|
| Harbour Loop (circuit) | 148.8 | 150.6 | 148.4 | 149.7 | 151.5 | **147.9** | Apex |
| Copper Canyon (sprint, dirt) | 60.4 | **59.5** | 60.1 | 61.6 | 60.7 | 61.6 | Brick |
| Airstrip Quarter (drag) | 15.3 | 16.0 | 15.3 | **14.9** | 15.4 | 15.0 | Mule |
| Dust Bowl (circuit, dirt) | 107.6 | 106.2 | 110.2 | 108.7 | **105.2** | 111.5 | Dune |
| Rainline (circuit, wet) | 184.9 | 183.7 | **182.9** | 189.5 | 189.6 | 185.3 | Sting |
| Salt Flat (drag) | 23.8 | 24.9 | 24.1 | **23.1** | 24.1 | 23.3 | Mule |
| Pine Ridge (sprint, dirt) | 73.1 | **69.4** | 74.1 | 74.6 | 69.9 | 75.3 | Brick |
| Kerbside City (circuit) | 181.5 | 183.4 | **177.2** | 184.3 | 185.7 | 179.0 | Sting |
| Summit Pass (sprint) | 67.4 | 67.3 | 67.2 | 68.0 | 69.6 | **66.7** | Apex |
| Coastal Highway (sprint) | 66.2 | 68.0 | 66.2 | 68.8 | 67.2 | **64.5** | Apex |
| Scrapyard (circuit) | 122.3 | 123.1 | **120.3** | 124.2 | 125.9 | 121.3 | Sting |
| Backstretch Mile (drag) | 38.8 | 40.9 | 39.6 | **37.4** | 40.5 | 37.6 | Mule |

Track wins: bot driver Apex 3, Mule 3, Sting 3, Brick 2, Dune 1, Vandal 0. Keyboard driver Apex 4, Sting 3, Brick 2, Dune 2, Mule 1, Vandal 0. The Vandal wins nothing but is 2nd–4th everywhere: the safe pick for a random schedule. Before this pass, the keyboard driver's two AWD cars won almost everything; the quarter mile was 15.0–15.8 s for AWD against 18.7–20.8 s for RWD.

**What changed and why (all measured):**
- **Traction control** (new, Tuning → Assists, on by default). Physics trims drive so a tyre never passes its spin point, and trims more mid-corner. Keyboard throttle had been spinning every rear-drive car. Turn it off to powerslide.
- **Apex MR:** 182 → 140 kW, $4,800 → $3,800. With traction control it won 7 of 12 tracks and every drag by 7%, which was the Mule's only job.
- **Sting:** −8% grip on dirt and −5% in the wet. It won 5 tracks, dirt and wet included.
- **Brick:** +7% on dirt (was +3%) and +8% in the wet. It won nothing.
- **Dune:** 172 → 166 kW, dirt bonus 1.14 → 1.10. The keyboard driver won 5 tracks with it.
- **Tyres:** soft +13% → +7% grip at $2,400, medium +6% → +3.5% at $1,000, wide +9% → +5% dry grip. Soft tyres used to take 8.4 s off Harbour for $1,900, against 1.2 s for a $3,200 turbo, so every build started with soft and wide.
- **Wings:** downforce 2.4 → 3.2 and 3.8 → 5.2; the full kit is $5,200. It had been buying half what a stripped interior did.
- **Big Turbo:** $5,800 → $4,200. It was barely quicker than the Street Turbo.
- **Brakes:** cold-bite penalty much smaller; Big Brake Kit 14 → 8 kg; prices $600 / $1,600 / $3,200. The honest result is that brakes don't buy lap time in these tests, because every car has ABS. They're a consistency part: stock brakes fade hard late in stop-and-go races (City reaches the maximum fade level). Letting ABS work closer to the limit was tried and rejected, because full brakes then left less grip to steer with.

**Upgrade value now** (Vandal, keyboard driver, seconds gained on Harbour / City):

| Group | Parts | Gain |
|---|---|---|
| Grip (circuits) | Medium · Soft · Wide | −2.8 / −4.8 · −7.0 / −7.8 · −3.1 / −4.7 |
| Weight (everywhere) | Stripped · Carbon · Race shell | −0.9 / −3.3 · −3.5 / −6.2 · −2.4 / −8.0 |
| Aero (fast corners) | GT Wing · Full kit | −2.1 / −2.4 · −3.7 / −2.3 |

- **Power:** mostly for drags. On the quarter mile, the Street Turbo gains 1.1 s (7%), the Big Turbo 1.4 s, the Supercharger 0.8 s and nitrous 0.6 s. On tight circuits it's about zero, because traction control caps what the tyres can use.
- **Risk/reward:** Race dampers, Sequential box and Narrow tyres win on some tracks and lose on others.

**Rules for what comes next:**
- **A new car** gets one home (a track type where it's best by at most ~3%) and one real weakness. It stays within 8% of the field everywhere else and never wins more than 4 of 12 tracks. A premium car costs about 1.5 race purses and is a sidegrade, not an upgrade.
- **A new part** is worth 1–5% on its specialty, zero or less elsewhere, costs roughly $700–900 per 1% gained on its best track type, and has a downside written in the shop.
- **Tuning stays free.** It reshapes the car, it doesn't add speed.
- **After any physics, car or part change,** re-run the two 6-car × 12-track matrices and the per-part table. Commit the numbers here.
- **Watch list:**
  - soft tyres are still the best value;
  - the Vandal never wins outright;
  - the Dune is strong for keyboard drivers;
  - turbo bots are slow on tight circuits;
  - brakes only matter in long races.

## v4.2 — "Smooth Starts"

Fixes a desync that hit one or two players on the first race. The cause was a freeze (a hitch) on a slower device, and a Chromebook's first race has the most of those: cold code and first-time loads. It was measured by emulating the freezes with one host and two joiners (`js/hostrace.js` has the details):
- **Host freeze:** the host used to drop the lost time, which threw away the joiners' inputs, so a 1 s host freeze made every joiner's car jump 13.9 m. Now the host catches up by up to 1 s of real time, and sends at most one snapshot per frame.
- **Joiner freeze:** the host used to keep applying the frozen player's last input. Their car drove into walls (56% damage, 260 m lost in the test) and then teleported. Now a stand-in bot drives it at 70% throttle after 0.25 s without input.
- **Start hold:** the countdown waits, up to 8 s, until every connected human racer is sending input (they've finished building the track). The start lights say WAITING.
- **Background tabs:** the hidden-tab ticker skips pings that queued behind a slow tick. Before, the backlog delayed network messages by up to 17 s.

## v4.1 — "School Wi-Fi"

Joining works when two devices can't link directly, for example two Chromebooks on a school Wi-Fi. The game falls back to a relay through public servers; see **Backup relay** under Netcode.

## What's new in v4.0

The version is shown on the main menu, and a "What's new" panel opens once after every update (`js/version.js` holds the changelog).

- **Slipstream:** tuck in behind another car to cut your drag by up to 45%. A SLIPSTREAM meter, wind streaks and a buffeting sound show you're in the tow.
- **Catch-up:** a host setting (Off / Mild / Wild) that gives cars trailing the leader up to +10% / +25% power. Quick races use your own setting.
- **Nitrous:** a new part, Street Shot (+30%) or Race Shot (+60%). Hold Shift, X/LB on a gamepad, or N2O on touch. Drafting refills the bottle.
- **4 new maps:** Summit Pass (a 58 m mountain climb with real hills, icy hairpins and fallen rocks), Coastal Highway (a 3 km sprint), Scrapyard Gauntlet (oil, mud, barrel stacks, boost pads) and Backstretch Mile (a mile drag with lane pads).
- **2 new cars:** Dune Runner (AWD desert truck, $2,600) and Apex MR (mid-engine supercar, $4,800). Both are premium: bought once per session.
- **Customisation:** paint finishes (gloss, metallic, chrome flake, matte), headlight colours, and Fade and Flames liveries.
- **Sound that follows your mods:**
  - exhaust: stock muffled, sport throaty with a drone, straight pipe raw and burbly;
  - engine map: rougher, and Stage 2 crackles and bounces off the limiter;
  - stripped weight: louder cabin;
  - sequential box: straight-cut whine;
  - wings: wind roar;
  - race brakes: squeal.

  Other cars use theirs too, and the garage has a **🔊 Listen** rev demo.
- **Betting in the flow:** racers can back themselves, a bounty sits on the money leader, and there's double-or-nothing on your prize after each race. You can also back yourself before quick races.
- **Hills and hazards:** tracks can climb and dip with real gravity, and have oil, mud, ice, speed pads and solid obstacles. Bots draft, use nitrous, dodge traps and no longer rear-end each other.

## Running it

There's nothing to install: it's plain HTML/JS. Three.js and PeerJS load from the jsDelivr CDN, so an internet connection is needed.

- **GitHub Pages (recommended for school Chromebooks):** upload `index.html`, `js/` and `css/` to a public repo, then go to Settings → Pages and pick `main` / root. Everyone opens the same `https://NAME.github.io/REPO/` link. When you update, replace the files; a hard reload (Ctrl+Shift+R) skips the browser cache.
- **Local:** double-click `index.html`. It uses classic `<script>` tags, so it works from `file://`, unless an admin policy blocks local files.
- **Dev server:** `python tools/serve.py 8765` serves with caching disabled.

**To host:** enter your name and click **Host**, then read out the 5-letter room code, or click **🔗 Copy invite link**. A friend who opens the link gets the Join box with the code already filled in. **To join:** click **Join**; the last room code you used is remembered. Your single-player car choice and paint come with you.

In the lobby, the host can type any number of races from 1 to 30, set the bot count, and **✖ Kick** a player (they can't rejoin that room). On the final standings, the host can click **🔁 Play again** to restart in the same room: everyone keeps their car and paint and gets fresh money and parts.

### Controls

All driving keys are rebindable in **Settings → Controls**. The arrow keys always work too.

| Key | Action |
|---|---|
| W / ↑ | Throttle |
| S / ↓ | Brake; held at a standstill it reverses |
| A D / ← → | Steer (tap for small corrections) |
| Space | Handbrake |
| Shift | Nitrous (needs a Nitrous part) |
| R | Reset to track |
| C | Cycle camera (chase / close / high / fixed-north) |
| **Esc** | **Menu: resume, restart, garage, change car, settings, controls, fullscreen, leave** |
| M | Sound on/off (off by default) |
| F3 | FPS and netcode stats |

Gamepads work too: left stick, RT/LT, A handbrake, Y reset, RB camera, Start menu. **Touchscreens:** on-screen ◀ ▶, GAS, BRAKE, HANDBRAKE, reset and camera buttons appear once you touch the screen. Set them to Always or Off in Settings → Controls. The ☰ 🔊 ⛶ buttons in the top-right corner are on every screen. When spectating, 1–8 or Tab picks a car to follow, WASD/Q/E moves a free camera, and the mouse wheel zooms.

## What's in the game

- **Main menu:**
  - **Quick race:** a real 3-lap race against 5 bots on a random track. You start mid-pack; results show gaps and best laps, and the prize (1st $1,500) minus fuel goes to your garage money. Then Race again, Next track, Garage or Menu.
  - **Bot difficulty:** Easy, Normal or Hard (Hard bots also bring upgrades).
  - Host / Join, Resume / Rejoin, Free practice (track picker with map thumbnails, car picker, 🎲 Random track), Garage, Casino (practice chips), Settings, How to play.
- **Tracks and sound:** multiplayer track order is shuffled every session (every track before any repeat, never the same format twice in a row). Nearby cars can be heard: their own engines, turbo whistle or supercharger whine, Doppler as they pass, tyre squeal, backfires and crashes. Each chassis has a distinct engine note, and supercharger, street turbo and big turbo each have a distinct sound. Badly damaged cars smoke.
- **Garage, in 5 tabs:**
  - **Parts:** 12 slots, including Brakes, Exhaust, Engine map, Cooling and Differential. Every option lists its upside and its downside.
  - **Tuning:** a free setup sheet with tyre pressures, camber, anti-roll bars, ride height, brake bias, diff lock, final drive, wing angle and boost. The live preview car and the stat bars show the result before you press Apply.
  - **Paint:** 24 paints plus a custom colour picker, 8 liveries, an accent colour, a race number on 7-segment roundels, 5 rim styles and colours, window tint and underglow. It's free and cosmetic, with a turntable view.
  - **Car:** switch chassis. It's free before race 1; between races it's an $800 swap, and your parts move over to the new car.
  - **Service:** repairs.
- **Every visit starts fresh:** single-player isn't saved. Each visit starts with a stock car and $25,000; quick-race winnings carry between races within that visit only. Every new multiplayer session starts fresh too ($3,000 and stock parts each). Only settings, your name and personal-best laps are remembered. The host's 30-second autosave exists only so a crashed session can be resumed.
- **Personal bests:** practice and quick races save a best lap per track and car. It's shown on the track picker and in the drive bar, with a "NEW PERSONAL BEST" banner when you beat it.
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
- **Connecting (v3.2):**
  - **Reverse dial:** if a joiner's connection hasn't opened after 5 s, the host calls the joiner instead, and whichever direction opens first is used. This targets the "PC can join the Chromebook, but the Chromebook can't join the PC" case.
  - **Timings:** a joiner now waits 22 s, and a host gives a half-open handshake 25 s (it used to cut it at 10 s).
  - **Relays:** STUN now uses Google and Cloudflare. PeerJS's built-in TURN relays no longer exist (their DNS names don't resolve), and no free account-less TURN server is left (openrelay, freestun and anyfirewall all failed a test in Sept 2026). A real TURN account can still go in `TURN` in `js/net.js`.
  - **Backup relay (v4.1, `js/relay.js`):** for networks that block every direct path, such as a school Wi-Fi that isolates devices. The host also listens on three public MQTT brokers over secure WebSockets: shiftr.io (port 443), HiveMQ (8884) and Mosquitto (8081). A joiner that has no direct link after 8 s (or that the matchmaking server can't help) knocks on all of them, and the first broker the host answers on carries its traffic. A `RelayConn` looks like a PeerJS DataConnection, so the rest of the netcode is unchanged. The costs: 180–250 ms one way through the broker (about 350 ms round trip, measured), and the traffic is readable by anyone who guesses the topic (positions and driver names only). If the matchmaking server itself is blocked, the host opens the room on the relay alone. Test with `?forcerelay` on the joiner. broker.emqx.io was rejected because it rate-limits to about 12 messages/s.
  - **Test:** add `?forcerev=1` to a joiner's URL to exercise the reverse dial on one machine.

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

## v4 balance check (measured, not guessed)

All figures come from headless races in the browser, using the real physics and bots (`RaceSim`).

**Mechanics audit.** A Vandal with each build, driven by a good bot:

| Area | Result |
|---|---|
| Overheating | Boosted engines hit the heat limit on long straights: the Mile, the Salt Flat and Coastal Highway. Cooling parts fix it. The garage's "overheats after ~X s" matches, so cooling now matters on the long tracks. |
| Tyres | Hard tyres lose ~17% per Harbour race; soft tyres lose ~48% (about two races of life). |
| Engine | A Big Turbo held near overheat takes 6% engine wear in one race, against ~1% for stock. |
| Nitrous | Each bottle bills its $120 / $240 with the fuel. Drafting refilled a whole second bottle in one race. |
| Brakes | Road brakes reach full fade on Harbour (as in v3) and on Coast, where 60 m/s stops heat them twice as fast. That's why brake upgrades exist. |

**Do power parts pay?** Measured with the keyboard-proxy driver (`T.kbLaps`):
- Every power part gains 3–4 s on a standing start and wins every drag by 2–6 s.
- On tight circuits the flying laps are within about a second of stock.
- On Canyon (dirt), the Street Turbo is 6 s slower.

Power wins straights and grip wins corners. That's the intended trade-off, and the shop's notes say so.

**The field, v3 → v4:** the same bots and the older tracks, with catch-up off.
- Canyon respawns 9.5 → 0–1.
- Pine respawns 10.5 → 4.5–8.5.
- Every car finishes on Harbour and City.

Across the 8 twistiest tracks with mixed six-car fields, nitrous and Mild catch-up, 48 starters produced 13 respawns and 1 DNF, with 11% average body damage.

**Catch-up:**
- Mild tightens the field without extra wreckage: on Harbour, a 2.6 s spread with 1 hard hit.
- Wild is chaos by design: tighter racing and more contact.

**Found and fixed during testing:**
1. Cars crossed sprint finishes at 60 m/s with 45 m before the end wall, so run-off was lengthened. Finished cars also take no more body damage, which used to cost repair money.
2. A flat 8 s grace DNF'd the slowest car on the Mile; drag grace now scales with length.
3. Bot changes:
   - bots get traction control and a feed-forward traction limit (Big Turbo cars weaved off the drag strips);
   - they avoid rear-ending, but only when contact is imminent (a harder cap set turbo cars weaving);
   - they avoid speed pads that would fire them into a corner;
   - they give obstacles more room;
   - a lane rate-limit was tried and reverted, because it went from 13 to 69 respawns in the A/B.
4. The Scrapyard's third lap ground a third of the field into DNFs, so it's now 2 laps, and tyre stacks and barrels do 25% of wall damage.

## Self-evaluation (v3 final round)

The overall score is the **lowest** category: **7/10**.

| Category | Score | Main evidence | Main gap |
|---|---|---|---|
| Car feel | 7 | A keyboard proxy with ABS never locks the fronts (was about 12 s per 2 laps). With the assist it spends 74 s off-track across 7 runs (was 102 s). Slides are unchanged: Vandal 13°, handbrake 42°. The Mule was rebalanced (46 → 33 s off-track across 3 tracks). | Never driven by a human. The Mule is still the car most likely to run wide. |
| Upgrade drama | 8 | Road brakes go from 38 m cold to 49 m hot, while the big brake kit and carbon stay at 38 m. A stiff rear bar cuts stability from 8.5 to 6.8 and spins the bot for 2.5 s. Full boost on a Street Turbo overheats in 8 s. Calipers, tips, wing angle and liveries are all visible. | Pressures and camber are subtle (±0.02 g). The straight pipe barely moves lap times. |
| Economic balance | 8 | 3 simulated sessions with the new parts: lowest cash $3,435, leader 1.24–1.33× the median. | Bot evidence only. The last-placed bot finishes at about 0.6× the median. |
| Casino balance | 9 | Blackjack edge 0.44% ± 0.26%, roulette 2.63%, all rule tests pass. Stakes are capped, with a $300 floor. | Variance can still favour a lucky player. |
| Multiplayer robustness | 7 | Over real WebRTC via PeerJS: the guest's spec matches the host's; 0.000 m correction error at 60 ± 20 ms and at 200 ms with 5% loss (with redundancy). Rejoin keeps the seat. The casino and setup changes work from a guest. | Every test ran on one machine; there's no host migration, and car-to-car contact isn't predicted. |
| Performance | 7 | 8 cars at 1366×768: 26–31 draw calls, 88–106k triangles, 0.3–0.45 ms of CPU per frame. No MSAA on the Chromebook tier; the particle pool is capped; the governor has 6 steps. | Never run on a Chromebook. GPU time is about 0.5–1.0 ms on an RTX 3070, which is an estimated 10–30 ms on integrated graphics. |
| Completeness | 8 | Every screen has a way back (Esc menu). The casino works in single-player and multiplayer; settings and rebinding apply live; there are no TODOs or stubs. | No touch controls. Spectator keys aren't rebindable. |

## Assumptions

- PeerJS's free public signalling server is used only for introductions. Some school or corporate firewalls block WebRTC entirely; those players connect through the backup relay (public MQTT brokers) instead, with more lag. A network that also blocks those brokers can't connect.
- The host is a player too; bots fill empty slots. There's no host migration: if the host's browser dies, they reopen the page and click **Resume**.
- Sound is off by default, as the original brief required. A toast says so on every visit, and M or the 🔊 button turns it on.
