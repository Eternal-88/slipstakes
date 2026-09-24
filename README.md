# SLIPSTAKES v5.3 — "Know Your Car II"

A browser multiplayer arcade racer for up to 8 players: race short tracks, win money, spend it on parts, setups and paint that change how your car drives and looks, and gamble at a side casino. Everything is session-scoped. A session of 8 races lasts roughly 50–60 minutes.

## v5.3 — Know Your Car II

Verification-led: `tools/audit.js` (new, dev only) measures every part on every
car against its own card and went from **109 faults to 0** over 280 fits.

- **Top speed** (`parts.js`): `baseFD` put the limiter exactly at `c.vTop`, so top
  speed was a property of the gearbox alone — a Big Turbo added 0 km/h and longer
  gearing won everywhere. Each car's drag area is now DERIVED (`baseDragArea`) by
  solving drag power = stock wheel power at `c.vTop`, with `GEAR_HEAD = 1.1` of
  gearbox headroom above it. Power buys +18–26 km/h, short gears cost 14–32, long
  gears only pay once the power is there. Stock speeds moved <2%. The EV opts out
  (`cdA` + `gearHead: 1`): it is rev-limited like a real one, and `motor.revM`
  raises its ceiling. The rally car's drag is sized WITH its factory turbo.
- **Fitment**: weight is a share of the car scaled by size (a kei Race Shell was
  byte-identical to Carbon Panels); `optAllowed` blocks the sequential box,
  intercooler and anti-lag on an EV; `tuneAvailable` takes a carId so the boost
  slider reaches the rally car's bespoke turbo slot without leaking to NA cars.
- **Brakes**: capacity 1.3 g → 1.12 g so a grippy car can run out of brake (2.8 m
  cold, 23 m hot between stock and carbon); cards rewritten — they sell fade
  resistance, which is what they actually deliver.
- **Economy**: odds 30x → 9x (4.5x self-backed), `P_FLOOR` stops pricing off
  Monte-Carlo noise, stakes 700/1400 → 400/800. `lateJoinMoney` is 85% of the
  MEDIAN with parts at replacement cost (was 80% of the poorest at half price).
- **Netcode** (`net.js`): a blocked main thread is no longer read as silence
  (`STALL_MS`), and `SILENT_MS` 10 s → 20 s. Reproduced the race-start
  disconnect loop with a 7 s freeze; 24 s of freezing now survives.
- **Bots** (`bot.js`): `SIDE_ROOM` — they could see cars ahead and behind but not
  alongside. Contacts −17%, spins −73%, laps slightly quicker.
- **Sound** (`audio.js`): `modSound(parts, carId, look)` — the exhaust amplifies
  the engine's own profile (`prof.sub` vs `prof.grit`) instead of a flat
  multiplier. Anti-lag holds `backfire` HIGH, so the rising-edge test gave a whole
  overrun one pop; now it cracks repeatedly. Five cosmetic sound knobs in `LOOK`,
  gated by `soundAllowed` and enforced in `modSound` so the gate cannot be spoofed.
- **Feel**: engines free-rev on the grid against their own inertia with a limiter
  bounce (`revCut`, now in `P.CORE` — hence **PROTO 10**); Low chase camera; TV
  cameras work during sit-out and betting; exhaust VFX anchor to the fitted tips.
- **Bodywork** (`carmodel.js`): spoilers sit on the body surface (a hatch wore one
  43 cm in the air, the kei 58 cm) and take their width from the car; the widebody
  is a swept arch with a sill instead of two boxes per wheel.
- **Balance**: Sting S was 3.75 avg rank / 3 wins fully built → 5.08 / 2; the EV
  was strongest stock (4 wins) → in line.

## v5.2 — Same Road

The netcode release. Everything here is about what a JOINING player sees;
the host was always fine, which is exactly the shape of the bug.

- **The other cars were in the past** (`clientrace.js`, rewritten): a client
  predicts its OWN car forward to where the host will have it once it hears
  the input, but it drew every OTHER car from the newest snapshot — which
  describes the host a downlink ago — and then deliberately held them a
  further `INTERP_MS` (100 ms) in the past so it could interpolate between two
  snapshots for smooth motion. So own car and other cars were drawn a full
  round trip plus 100 ms apart. `tools/netlag.js` (new, dev only) runs the real
  `HostRace` against the real `ClientRace` over a simulated link in virtual
  time and measures the gap between where a car was drawn relative to you and
  where the host really had it: **2.74 m on a LAN, 3.63 m on Wi-Fi, 5.34 m on a
  poor link, 8.94 m through the backup relay** — a car is 4.3 m long. Remote
  cars are now dead-reckoned forward by (snapshot age + RTT) onto the client's
  own clock, integrating a constant yaw rate exactly (a cornering car holds its
  rate of turn far better than its heading, so plain velocity extrapolation
  fires cars off on the tangent), with half the reported longitudinal
  acceleration for braking, the projection clamped inside the barriers, and the
  leftover model error absorbed by an eased offset rather than a twitch.
  Same measurement after: **1.06 / 1.45 / 1.59 / 3.12 m** (60–70% better).
  Both arms are five runs in one session with the host at 30 Hz, so the old
  code is measured at the NEW snapshot rate — which flatters it, and
  understates the change rather than overstating it. Confirmed over the real
  WebRTC transport between two browser tabs at 187 ms RTT by recording the
  host's truth and the joiner's drawn positions against the shared wall clock:
  **4.71 m -> 1.88 m mean, p95 7.26 -> 3.08 m**.
- **Contact prediction** (`physics.js` `P.contact`, `race.js`, `clientrace.js`):
  the pair-resolution maths moved out of `RaceSim.collideCars` into
  `P.contact(A, B, opts)` so a client can predict its own half of a shunt with
  the host's own numbers. A client passes `onlyA` (it does not own the other
  car), `noPush` (skip the positional push-out — that is a POSITION claim
  based on a guess, and nose-to-tail running had the client shoving itself off
  a guessed overlap every tick, which reconciliation then undid: 0.4–0.7 m of
  average correction, an invisible bumper) and `minVn: 1.2` (predict a real
  bump, leave resting rub to the host). It is gated on `lead < 0.26 s`: under a
  quarter-second guess every predicted bang matched a real one; past ~0.28 s
  more than a third were phantom bangs the host never had, so a relayed player
  gets the projection and hears shunts from the host only. `filterEv` drops the
  host's duplicate when its copy arrives a round trip later.
- **30 Hz snapshots** (`hostrace.js`, `net.js`): `SNAP_EVERY` 6 -> 4. The
  snapshot rate no longer buys or costs delay (nothing is buffered in the past
  any more) — it only sets how often the client's guess is corrected. A
  relayed link is held near 22 Hz, because the public MQTT brokers rate-limit,
  and a snapshot carrying SLOW data is never the one skipped. `NetHost.route()`
  is new. Effective rate measured at 29.8 / 28.8 / 23.5 / 20.6 Hz across the
  four links — at or above the old 20 Hz everywhere.
- **Link readout** (`ui/hud.js`, `css/v5.css`): a `RELAY 420ms` / `SLOW LINK
  210ms` chip on the assist line, shown only when the link is bad enough to be
  the reason the cars feel wrong (relayed, or ping over 160 ms; red past 320).
  The line still collapses to nothing when there is nothing to say, so the
  panel stays 117 px.
- **Host-clock estimate** (`clientrace.js`): was an all-time maximum that
  leaked 1% per snapshot, so one unusually quick packet skewed it for about
  five seconds and every remote car stuttered until it bled off. Now the
  maximum over a 4 s moving window, with a fast attack and a bounded release.
- No protocol change: `PROTO` stays 9, so a v5.1 client can still play in a
  v5.2 room — it just doesn't get the fix until it reloads.

## v5.1 — Know Your Car

Balance, endurance on more tracks, a new instrument cluster and a music pass. Protocol 9: car physics and the parts catalogue changed and the schedule now carries which races are endurance races, so 5.0.x and 5.1 players cannot share a room.

- **Balance method** (`tools/balance.js`, dev only): every car is time-trialled on 15 tracks by two drivers. `ace` is a Legend bot (racing line, traction control, no mistakes). `novice` is the same bot with its traction control removed, its steering quantised to left / straight / right, its throttle and brake to on / off, and every input delayed 0.26 s. The gap between them is the car's skill ceiling, and the two rankings together are the balance target: some cars easy with a low ceiling, some hard with a high one, none average.
  Stock, ace average rank (1 = best of 9) / novice average rank: Volt 4.0 / 4.2, Stormer 4.1 / 4.6, Apex 4.5 / 7.7, Pip 4.9 / 5.3, Sting 5.1 / 6.3, Vandal 5.3 / 5.7, Mule 5.5 / 6.7, Dune 5.5 / 2.6, Brick 6.1 / 1.8. The Apex is last for a novice on 10 of 15 tracks and wins 5 for an ace; the Brick is the reverse.
- **Weight is capped by the car** (`parts.js` `STRIP_MAX` = 0.26): a strip-out takes at most about a quarter of a car's own mass. Flat kilos made the 760 kg Pip a 423 kg go-kart: with a full build it was quickest on 7 of 13 tracks, and every build converged on "buy the lightest car". `Parts.optText(carId, o)` gives the shop the real number for the car you are in.
- **Bespoke part slots**: `SLOTS` entries can carry `evOnly` or `turboOnly`, and `partAllowed` hides them on every other car (the same path `noParts` already used). `gbturbo` (Stormer): Factory / Small Rally / Group B turbo — the car's `turbo: 1` flag makes `computeSpec` take its induction from this slot, and `noParts: ['induction']` keeps shop turbos off it. `motor` (Volt): `pMul`, `heatM`, `drainM`, `kg`. Bots buy them through `BotKit.CAR_BUYS` and `Econ.BOT_PREFS`.
- **Car identities**: Mule gets `tq: {lo, hi}`, a car-level torque curve applied in `torqueAt` on top of the exhaust, plus vTop 57 → 60 (the drag king that was losing the drags). Sting: yaw inertia 0.92 → 0.85, 20 kg off, `dryBonus` 1.015. Brick: `wetBonus` 1.08 → 1.13. Dune: `looseBonus` 1.10 → 1.13, drag 1.18 → 1.23. Volt: 215 → 210 kW, 1690 → 1700 kg, vTop 55 → 51.5, `evHeat` 0.085 → 0.115.
- **EV derate** (`physics.js`): an electric motor loses power smoothly from 55% temperature (down to −45% at the top) instead of doing nothing and then dropping into the combustion limp mode. The Volt was both the quickest stock car and one of the easiest; it now has bad tracks.
- **Endurance on more tracks** (`tracks.js`, `session.js`, `race.js`): `endurance: 1` is always an endurance race (Endurance Park); `enduChance` is the odds of being run as one (Harbour 0.28 / 6 laps, Dustbowl 0.28 / 12, Rainline 0.28 / 6, Grand Tour 0.22 / 3). `Session.makeEnduPlan` rolls once per schedule and allows at most one surprise per session; the answer lives in `st.enduPlan` and every peer reads it through `RaceEnv.planned(st, i)`. Grand Tour is 3 laps rather than 2 because with two, a thirsty build ran dry before the only pit window it would ever get. `RaceEnv.CAL` is now measured for a Normal field AND a Legend one (whose bots bring turbos and drink far more) and set halfway between; `shouldPit` judges against the estimate plus 8%. Verified: 90 car-races over 5 tracks × 3 levels, 0 ticks on an empty tank, 76 of 90 exactly one stop.
- **Instrument cluster** (`ui/hud.js` `drawCluster`, 272×172): a 34-segment rev counter with the scale outside the ring, a 10-LED shift-light bar, speed, gear, and a boost dial with a red zone and a tick showing `Parts.boostAvail` at the current revs — the gap between that tick and the lit arc is the lag. EVs get motor temperature there with the derate zone marked. The boost bar has gone from the gauge column. `raceview.js` / `clientrace.js` add `ev`, `boostGain`, `redline`, `boostAvail` to the `me` payload.
- **Pit lane paint** (`trackmesh.js`): the box, its lines and the PIT stripe were all one plane 3 cm above the road, 1 cm above the run-off strip under them, and flat while the road banked. They now sit at 0.06 / 0.074 / 0.088 above `track.heightAt(i, lat)`, the same surface function the road mesh uses, and the garage roof band overlaps its bay instead of sharing a face with it.
- **Music** (`audio.js`): menu, garage and final rewritten on eight-bar progressions with `sections`, echo and pump; a new `street` song for city and scrapyard circuits (`theme.song` picks it, ahead of the night and loose rules). The music bus was 0.55 × the slider and the slider defaulted to 45: it is now 0.7 × 58, and a one-time migration lifts a saved 45 (the old default) for players who never touched it.

- **Money** (`economy.js`, `session.js`, `parts.js` prices): a race paid roughly what the best part in a slot cost, so every build jumped straight to the top tier and the cheap half of the catalogue was dead. `PRIZES` ×≈0.7 ([1800…350]), `GROWTH` 0.06 → 0.085 (cap 3 → 3.2), `START_MONEY` 3000 → 1400, stipend / bounty / fastest lap / gain bonus / betting caps / casino caps all scaled with it, `SANDBOX_MONEY` 25000 → 60000. Only the TOP of each part ladder moved up in price (Race Shell 6000 → 8000, Big Turbo 4200 → 6000, Carbon-Ceramic 3200 → 4400, Race Dampers 2900 → 3900, Stage 2 3200 → 4400, straight pipe 1800 → 2400 …); every entry part is the price it always was. Running costs then police the top end on their own: a full build costs ~$1,260 a race in fuel and wear against a 6th place of $560–990. A podium finisher's curve is now ~$2,500 after race 1, ~$4,900 after race 3, ~$8,800 after race 6. Bots buy from the same prices and their spending reserve dropped 1500 → 900 to match.
- **Crosswind you can see** (`physics.js`, `world.js`, `ui/hud.js`, `trackmesh.js`): the gust zones pushed the car with nothing on screen to explain it. `car.gust` (m/s², + = toward the left of the road) plus the road normal are written by the physics for the picture only — never networked, and the client's own prediction computes the same numbers. The world blows `sand` and `streak` particles across the road from upwind of the camera car, the HUD shows `CROSSWIND` with the direction it is pushing (and blinks past 3.5 m/s²), a one-off banner explains it the first time a race enters a zone, and the socks now line the whole zone at ~30 m spacing instead of standing at its two ends.
- **Cluster size** (`ui/hud.js`, `css/v5.css`): the panel was 173 px tall and only 99 of that was instruments — the rest was an always-reserved empty line for the CATCH-UP / CROSSWIND chip, a two-row block of bar gauges and 20 px of padding. The chip's line collapses when empty, the gauges are four to a row and thinner, the canvas is 256×116 (was 272×172) with the gear and boost dial beside the rev counter instead of stacked, and the shift lights ring the dial. 173 → 117 px.
- **Look check** (`tools/looks.html`, dev only): a grid renderer for every appearance option and every body, plain and fully kitted. All 13 liveries, 5 kits, 4 spoilers, 5 rims, 4 tip styles, 4 finishes and 9 bodies render as the shop describes them; nothing pokes through a body and no decal is coplanar with it (every one is lifted 1–3 cm, and the game camera's near plane is 3 m, so depth precision at car range is sub-millimetre — the flicker that did exist was the pit lane's exactly-coplanar paint, fixed above).

## v5.0 — After Dark

The content update. Protocol 8: snapshots carry fuel, tyre and pit state, and race info carries weather and endurance settings, so v4.5 and v5.0 players can't share a room.

- **Race environment** (`race.js` `RaceEnv`, `physics.js`): `P.step(..., {env})` gets `{t, wet, endu}` on the host and in each client's prediction. `t` is race time: it drives moving hazards and gusts. `wet` comes from the host's weather roll (`RaceEnv.roll`, sent in the race info) and moves grip on dry surfaces 60% of the way toward the car's own wet grip. Wide tyres aquaplane above 60% wet. The host setting is Changeable / Always dry / Rain, and Changeable rains on 20% of races (35% on Neon Nights), starting 25–60% of the way in.
- **Track features** (`trackbuild.js`, `tracks.js`): per-vertex run-off width and surface (`ro`/`rs`), a `pit` box (a concrete apron and a painted box), and new hazards. `water` is a surface. `wind` is a gusting side force zone. `rockfall` and `swing` are moving circle obstacles whose positions come from `track.dynPos(o, t)`, which physics, bots and visuals all share. Bots avoid them, and rocks show a shadow for 1.5 s before they become solid.
- **New tracks**: Serpent Pass (goldpass, 3.6 km sprint, ~2:10 fast / 2:30 Normal bots), Grand Tour (3.6 km, 1 lap, day→dusk), Neon Nights (night street circuit, 2 laps), Endurance Park (2.4 km, day→night, pit lane).
- **Time of day** (`world.js` `_atmos`): day, dusk and night palettes blended by `theme.night` or by `theme.todTo` × the leader's progress. Adds a moon, stars and wet greying. Lighting is fake (`trackmesh.js`): additive light pools under lamps, glowing lamp heads and neon as unlit geometry. Only real light: one spotlight for the camera car on themes that get dark, added at load. Headlights are an additive beam quad plus lens glows. Rain follows the camera's height.
- **Terrain under the road** (`trackmesh.js` `groundFn`): ground is capped just below the lowest nearby road out to the wall plus one terrain triangle's reach, and rises 1:1 beyond. The grid is 16k cells with no jitter near roads. Walls get stone skirts where the road stands above the ground. A checker found 0 triangles above the road on 9 tracks.
- **Endurance** (`race.js`, `ui/pit.js`) — v5.0.2: not a session mode. A track definition carries `endurance: 1` (only Endurance Park), and `session.startRace` / `App.startDrive` give that race `RaceEnv.endu(track)`; every other track is a normal race. `car.tank`, `car.tw` and `car.pit` are in `P.CORE`. Drain is calibrated per track (`RaceEnv.CAL`, a Normal field's fuel and wear per metre) so the tank lasts about 80% of the race and the tyres 70% — on the 3-lap race that means one stop, around lap 2, and no way to reach the flag without it. An empty tank gives 20% throttle, and worn tyres lose up to 25% grip. Stopping in the box under 2.2 m/s holds the car (ghosted). Bots follow `RaceEnv.shouldPit` and pit for a skill-scaled crew time. Players play the crew mini-game, send `{t:'pit'}`, and the host releases the car no sooner than `RaceEnv.pitTime` (1.2 s + fuel × 4.5 s × charge factor + tyres 3.2 s × quick-release factor). In test races (6 Normal, Hard and Legend bots) every car stopped once and none ran dry before the flag.
- **Cars** (`parts.js`, `carmodel.js`): Pip K1 (free FWD kei, fuel ×0.6), Volt E (EV: flat torque to 35% revs then constant power, one gear, no clutch slip, motor heat derate, regen and a slower charge in endurance; no induction, exhaust or nitrous parts), Stormer B (Group B: built-in turbo, loose ×1.1, dry ×0.94, tyres ×1.3). Balance brief: identities and skill ceilings rather than flat stats. In stock-car time trials by Legend-level bots, every track had a different set of leaders, and every new car was last somewhere.
- **Parts**: rain tyres; a front-mount intercooler; `aids` (launch control / anti-lag); `wheels` (magnesium); `pitkit` (fuel cell / quick-release). **Looks**: kits, spoilers, exhaust tips, tiger/chevron/bolt liveries, pulse/rainbow underglow.
- **Bots** (`bot.js`): six levels (skill range, racing-line trust, braking, mistakes, budget, premium odds, rival odds). The racing line (`track.racingLine()`) is a minimum-curvature relaxation with half-trusted curvature. Bots pass on the inside and defend. Up to two rivals a race hunt whoever is just ahead (a `rival` event warns the target). The host sets the bot level for a room. Quick-race premium cars are chosen to suit the track.
- **Session extras**: championship points (`stats.points`, lobby Winner option), horn (H; `on_horn` → sim event `horn`), TV camera mode (trackside posts every 110 m with hard cuts).
- **Audio** (`audio.js`): EV voice; 160 Hz rumble + ~1 kHz tread hiss ∝ speed; squeal stick-slip; gravel grain gate; water; glass/debris crash layers; ambience beds and one-shots per theme; hazard and pit sounds. Music: sectioned songs (intro/drop/breakdown/build), echo send, kick pump, `musicIntensity` on the final lap; race songs race / night / rally / endurance, picked by `App.raceSong`.
- **UI** (v5.0.2: the lobby is three panels — drivers / settings / chat — each capped at 92vh with its own scroll, so eight drivers can't push the Start button off screen; the server list has more padding): server list rewritten (filters with counts, search, keyed rows, status pills, mode and track, seat dots, mobile layout; the room card adds `mode`, `track`, `lvl`, `champ`); lobby settings in groups; HUD fuel gauge, pit advice strip, stop count and PIT tags; results show points and stops.

## v4.5 — Sound & Scale

- **Screen fit** (`ui.js`, `hud.js`, CSS): the interface is laid out for 1366×768 and zoomed to the screen with CSS `zoom` (menus: `--uiz` = fit × Menu size; HUD pieces: `--hud` = fit × HUD size). Fit = min(w/1366, h/768), damped to 80% above 1 and clamped 0.6–1.6. Viewport units inside zoomed boxes are written `calc(94vh / var(--uiz))`, because Chrome multiplies `vh`/`vw` by the zoom. The old max-height HUD media queries are gone. The minimap and speedo canvases are backed at HUD zoom × devicePixelRatio.
- **Engine sound** (`audio.js`): a combustion-rasp layer (looped noise, bandpassed, amplitude-gated by a sawtooth at the firing frequency, into the engine amp), a peaking filter per car (`res`) and exhaust, and idle hunt. Turbo: blade-pass overtone at 2.02×, 5.5 Hz shaft wobble, louder while boost is rising. Supercharger: crank-locked whine (crank Hz × 14, the same for every cylinder count), rotor-pulse AM, bypass whoosh on lift.
- **UI sounds**: `Audio.notify(kind)` plays `request`, `join`, `leave`, `drop`, `host`, `warn`, `notify` or `info`. Toasts take an optional sound (`UI.toast(msg, kind, snd)`), and `session.sys(text, snd)` puts a sound on a chat line that every client plays (`chat.js`).
- **Left vs lost**: a leaving client sends `{t:'bye'}` (menu or `pagehide`) before closing. The host's `session.leave()` then writes "left the game" instead of "lost connection".
- **Garbage per frame**: `RaceSim.renderState` reuses one object per car. The other-cars audio picks the 4 nearest without allocating, the own-engine sound profile is cached by build, per-particle colour arrays are constants, and the bots' `others` list is reused. In-race heap growth was 7–14 MB/s both before and after these changes (the `performance.memory` estimate is noisy), and it barely moved with audio, the audio automation calls or the sim step switched off. So most of what remains comes from rendering or the page, and these changes are hygiene, not a measured win.
- **Network**: `packFull` rounds to 1e-4 (398 → ~176 bytes per snapshot; replaying 0.3 s from the rounded state drifts under 0.1 mm). PeerJS `fast` sends are skipped while the data channel has more than 32 KB queued.

## v4.4.2 — frame rate, slipstream badge, Harbour boats

The frame rate fell from ~90 to ~20 fps near all 7 other cars on the reporter's PC, while the menu's background race stayed smooth. Measured in the preview, **main-thread JavaScript was not the difference**: a race frame surrounded by 7 cars took 0.68 ms against 0.64 ms for the menu, and the other-car audio took 0.05 ms per frame. That pointed at per-frame browser work that only the race does: `hud.js` rewrote every name tag's transform, display and opacity each frame, and `v2.css` gave the tags a 0.15 s opacity transition, so seven transitions restarted every frame. An A/B of tags on vs off (120 vs 98 fps) was taken during a load spike, so it is not a reliable figure. The fix set below was confirmed by the reporter in Chrome ("way smoother"), not by a clean measurement of each part.

What changed:
- **Name tags:** they write to the DOM only when a value actually changes (whole pixels, opacity in 0.05 steps). They use `translate3d` with `will-change` and no transition, and cars more than ~250 m away get no tag.
- **Hit events** (`race.js`): one per touching pair per 0.35 s instead of one per 120 Hz tick, so a harder new hit still gets through. The physics is unchanged.
- **Effect caps:** crash thuds at most ~11 a second (`audio.js`); other cars' exhaust crackle at most once per 0.7 s per car and once per 0.15 s overall; and at most 4 other-car contact effects drawn per frame (`raceview.js`).
- **Sound profiles:** each other car's is cached per build instead of recomputed every frame.
- **Slipstream badge** (`hud.js`, `v4.css`): the old SLIPSTREAM meter above the speedo never appeared, because its class went through `set(..., 'className')`, which writes `el.style.className`. It is replaced by a badge at the top centre (drag saved, a meter, brighter at full tow), a blue edge glow that follows the tow's strength, and a whoosh (`Audio.draftIn`) on catching one.
- **Harbour Loop boats** (`trackmesh.js`): the five boats out in the bay started from the track's bounding-box centre and then added the full shore distance, counting the centre twice, which put a boat on the road at Harbour Loop. They are now measured from the shoreline and must be on water and clear of the track.

## v4.4.1 — hotfix

`Audio.silenceOthers()` muted the other cars' engine and tyre voices but not their turbo whistle / supercharger whine (`wg`). After a race next to a boosted bot, that whine played on at its last level through the main menu (turning "Other cars" down hid it). It is now muted with the rest, and the voice's car assignment is cleared.

## v4.4 — "Crowd Control"

- **Spectate after the flag.** Once your car finishes (it cools down on autopilot), after 2 s the camera jumps to the first car still racing. 1–8 or Tab picks another car, F goes back to your own, WASD flies a free camera (`game.js` render, `RaceUI` in `lobby.js`).
- **Bot variety** (`G.BotKit` in `bot.js`):
  - 40 names, shuffled so no two bots in a room share one.
  - A fully random look: paint, finish, livery, rims, tint, lights, sometimes underglow.
  - A driving **style** (grip, power, rally, lightweight, drag, all-rounder) that picks the car and the shopping list. Bots start with a small build paid from their own money, buy along their style between races (`botsShop`), and a well-off bot may buy its style's premium car.
  - Quick-race and practice bots use the same kit; Hard bots bring bigger builds and sometimes a premium car.
- **Private rooms rethought.**
  - **Joining:** anyone with the code joins at once. A private room's server-list card never contains its code. Strangers press **🔒 Ask to join**, and the host gets a Let in / No card.
  - **The "yes" is encrypted:** it carries the code to that one player with WebCrypto ECDH P-256 + AES-GCM, because anyone can read the public brokers.
  - **Topics:** room cards are now filed under a public list id plus the host epoch (`slipstakes/rooms/v2/<lid>-<epoch>`), and requests use `slipstakes/req/v1/<lid>`. The secret room id `rid` still derives the codes after a host change.
- **Sound on by default.** Everyone gets it switched on once (`sound44` in settings); after that their choice sticks. The garage's live preview and showroom no longer drive the engine sound. Their engine and brake-squeal loops used to play through the menus and the whole between-rounds garage; the 🔊 Listen button still demos a build.
- **Paint camera.** In the Paint tab you drag the car to turn and tilt it and scroll to zoom. It turns slowly by itself until you touch it, and again 8 s after you let go (`preview.js`).
- **Idle rooms close** (`Game._idleCheck`, `Game.IDLE`). A lobby that's never started closes after 15 minutes; any room where no human has touched a control for 10 minutes closes too. Race inputs, actions, chat, joins and the host's own keys and clicks all count. Everyone gets a 2-minute warning and then a "Room closed" message. It's a real close, so nobody tries to find a new host.
- **Up to 100 races.** Prize growth (+6% a race) stops at 3×, from race 35 on.
- Protocol 7.

## v4.3 — "Open Rooms"

- **Server list** (`js/ui/rooms.js`, `RoomBoard` in `js/relay.js`). Every host publishes a small retained "room card" to the public MQTT brokers (`slipstakes/rooms/v1/<CODE>`), with a Last Will that wipes it if the host vanishes. The list shows fresh cards live: 🌐 Public rooms let you straight in, 🔒 Private rooms (the default) put an Accept / Decline card in front of the host. Hosts set the room name, public/private, max drivers (2–8) and bots in the lobby, and can change them mid-session from the Esc menu.
- **Host migration** (`game.js`, `HostSession.fromMigration`). The host sends its full state, seat tokens included, to the first two "heirs" (connected humans in the order they joined) every 2 s while it changes.
  - **Host drops:** the first heir rebuilds the session and hosts it under `deriveCode(roomId, epoch+1)`, a code every player can compute on their own. Everyone else rejoins that code with their seat token. The second heir takes over under the code after that if the first never shows up. A race that was running is voided, bets are refunded, and the session carries on from the garage.
  - **Host leaves on purpose:** it hands over immediately.
  - **The host's own internet dropped:** it notices it's alone, finds the new room, and rejoins as a player in its own seat.
  - **The autosave is gone.** Nothing is stored between visits.
- **Join any time.** A late joiner spectates the race in progress, races from the next one, and starts with 80% of the poorest connected driver's net worth (never below the normal $3,000).
- **Chat on every screen** (`js/ui/chat.js`). T or Enter opens it, even mid-race. Lines fade in the corner, and an unread badge counts what you missed. The host allows one line per 0.6 s per player.
  - v5.5 **speech to text** (`Chat.Talk`): hold V (rebindable) or tap a 🎤, speak, and the words go in as a 🎤 line. The browser's `SpeechRecognition` does the work (Chrome and Edge send the audio to their speech service), game audio ducks to 22% while listening (`Audio.duck`), and a 15 s cap means a stuck key can't leave the microphone open. Settings → Controls switches it off.
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
| H | Horn |
| T / Enter | Chat (multiplayer) |
| V (hold) | Speech to text: say it and it goes into the chat (multiplayer; Chrome or Edge) |
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
