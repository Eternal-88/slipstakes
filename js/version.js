// version.js — the game's version and what each update brought. Shown on the
// main menu (badge + "What's new"), in the pause menu, and automatically once
// after an update.
'use strict';
(function (G) {
  G.VERSION = '5.3.2';
  G.CHANGELOG = [
    {
      v: '5.3.2', name: 'Clean Lines', items: [
        ['🧹', 'Nothing left hanging in the air', 'Every car was rebuilt as real geometry in a 3D package and measured piece against piece, which turned up a list of things floating a centimetre or two off the bodywork. The roof panel took its width from one cross-section, so on any cabin that narrows towards the back it overhung the glass by 10 cm and sat 5 cm above it — a plank laid across the roof. It follows the cabin’s own top line now, and the aerial that stood on that slab came down with it. Wipers took their height from the base of the windscreen and hung 2–3 cm in the air on every car whose cowl drops away from it; they lie on the scuttle. The pickup’s spare wheel floated 10 cm over its own bed, and the rally light bar was sitting inside the intercooler.'],
        ['🎨', 'Kit parts that stop fighting each other', 'The widebody kit drew its arch straight over the standard arch trim, and with wide tyres fitted over a second set of flares as well — three pieces cutting through one another over every wheel, with two sets of side skirts below them. The kit’s arch now replaces the lot, and its sill stops short of the arches instead of running into them. A diffuser fin standing exactly where a tail pipe comes out gets out of the way. Liveries sat as much as 3 cm off the paint, which is close enough to see; they are 5 to 11 mm now, still hundreds of times what it takes to keep them from flickering. The big aero splitter was a fixed 1.9 m plank — wider than some of the cars it was bolted to — and exhaust tips stood 16 cm proud of the bodywork.'],
        ['🌤', 'An open car with the roof properly down', 'The roadster’s cabin was lofted as a closed volume in tinted glass, which laid a dark lid over the cockpit and hid everything in it. Only the windscreen is glass now — leaning back from the scuttle to the top rail, on pillars you can see — and the seats, dash, deck and headrests hang off the screen instead of off fixed numbers, so they land in the right place whatever body they are in.'],
      ],
    },
    {
      v: '5.3.1', name: 'Overrun', items: [
        ['💨', 'Pops you can see, and that stop', 'A free-flowing exhaust now throws smoke out of the pipe on the overrun, and a bangs-and-pops map spits flame with it — visible whether or not your sound is on. The bang tune also had two faults: it fired exactly ONCE when you lifted (the test only looked at the instant the throttle shut, not at the overrun that followed) and then, once that was fixed, it never stopped. It now cracks hard as you lift and fades out over a couple of seconds, the way a real one does.'],
        ['🔧', 'Fixes', 'Wheel-arch trim is narrower, so it reads as trim rather than a slab bolted to the side. The open cockpit in the roadster — seats, floor, dash and roll hoops — is measured from the car it is in instead of fixed numbers, so nothing sinks through the deck.'],
      ],
    },
    {
      v: '5.3', name: 'Know Your Car II', items: [
        ['⚖', 'Top speed comes from the engine again', 'The final drive used to be set so every car hit its rev limiter exactly at its rated top speed. That made top speed a property of the GEARBOX and nothing else: a Big Turbo was worth literally 0 km/h, and longer gearing was the right answer on every track, which is why the final-drive slider never felt like a choice. Each car’s drag is now worked out from the speed its card claims, and top gear reaches about a tenth past it — so a standard car runs out of AIR, power buys 18 to 26 km/h, short gears cost you 14 to 32, and long gears unlock the rest only once you have the power to use it. Stock top speeds moved by less than 2%.'],
        ['⚙', 'Parts that do what they say', 'Every part on every car was measured against its own description. A kei car was being sold a Race Shell that was byte-for-byte the Carbon Panels it already had, because weight came off in flat kilos and a small car ran out of things to remove — weight is now a share of the car, scaled down for the little ones, and all four steps are real on all nine cars. The one factory-turbocharged car could not adjust its own boost, because the slider was looking at the wrong slot. An electric car was being sold a sequential gearbox for its single-speed transmission, a front-mount intercooler for an engine it does not have, and anti-lag; it is now sold none of them, and its motor packs raise its rev ceiling instead, which is the only way an EV goes faster.'],
        ['⛔', 'Brakes tell the truth', 'A brake card promising "+12% stopping power" could never deliver it: the tyre gives up before the pedal does, so every brake stopped in the same distance from cold. What they really buy is enormous and was never mentioned — road brakes go from 37 m to 49 m by the end of a race while carbon stays at 37 m. The cards now say that, and brake capacity was brought down enough that a car with sticky tyres and real downforce can genuinely run out of brake, which is the actual reason to fit bigger ones.'],
        ['💰', 'Betting is a side bet again', 'A 700 stake at the old 30x ceiling paid 21,000 against a 1,800 race win, and the surest way to it was backing YOURSELF: the book prices a driver off their car and recent results, so anyone quick in a modest car was priced as an outsider and knew it. Odds now top out at 9x (4.5x on yourself), stakes are smaller, and a best-case betting race is about 3,600. Late joiners also get a fair start: they used to be given 80% of the POOREST driver’s worth with parts valued at half, which left them unable to race anybody; now it is 85% of the middle of the field, with parts counted at what they would actually have to pay.'],
        ['🔌', 'The race-start disconnect is fixed', 'Building a track blocks a slow device for a few seconds, and both ends were reading that silence as a dead connection — so every race start risked a disconnect, a reconnect, another track build, and round again. Time spent with a frozen main thread no longer counts as silence, and a host waits 20 seconds for a slow machine instead of 10. Twenty-four seconds of deliberate freezing now survives without dropping.'],
        ['🔊', 'Sound you can tune', 'The exhaust now amplifies what the engine already IS, instead of the same multiplier on every car: a straight pipe on the V8 finds rumble, the same pipe on the three-cylinder finds rasp. And there is a Sound section in the garage — exhaust tone, what it does on the overrun (crackle, bangs and pops, a burble tune), the blow-off valve on a boosted car, a lopey idle and a hard-cut limiter. Free, cosmetic, and each one needs the hardware that would make it possible.'],
        ['🔥', 'Anti-lag bangs', 'It made flames and almost no noise, because it holds the backfire on for the whole overrun and the game only listened for the moment it started — a ten-second overrun got exactly one pop. It now cracks away for as long as it is lit, on your car and on the ones going past. Exhaust flames and shift puffs also come out of the pipes you actually fitted: side exits used to breathe fire out of a rear bumper with no pipes in it.'],
        ['🎥', 'Rev it, and a lower camera', 'Holding the throttle on the grid pegged the engine at a fixed 69% of the redline instantly and held it there. Now it winds up against its own inertia, drops back when you lift, and bounces off the limiter if you hold it — and a small engine spins up faster than a big one. There is also a Low chase camera, down near the road where you can see into the corner, and the TV cameras now work while you sit a race out or watch the betting board.'],
        ['🗺', 'See the circuit first', 'The pre-race screen draws the next track: the layout, which way round it goes, where the start line is, which parts are loose or under water, and where the pit lane is if it has one.'],
        ['🤖', 'Bots leave room', 'They could see cars in front and cars behind, but nothing ALONGSIDE, so two of them running wheel to wheel both kept pulling to the same racing line and leaned on each other the whole way down the straight. They now leave each other as much room as the road can give. Over forty races that is a sixth fewer contacts and three quarters fewer spins — and slightly quicker laps.'],
        ['🔧', 'Fixes', 'Spoilers sat on a number measured elsewhere on the car, so a ducktail or whale tail floated 43 cm above a hatchback and 58 cm above the kei car; they now sit on the bodywork, at the trailing edge of the roof where a hatchback wears one, and take their width from the car rather than a constant. The widebody kit was two plain boxes beside each wheel and is now an arch that follows the wheel and blends into the body, with a sill joining the front and rear. The Sting S was quietly the strongest car in the game once fully built, and the electric car the strongest out of the box; both are back in line.'],
      ],
    },
    {
      v: '5.2', name: 'Same Road', items: [
        ['🛰', 'Everyone is on the same road now', 'If you were the one who JOINED a room, every other car on your screen was in the past. Your own car is drawn where it will be once the host has heard from you, but the other cars could only be drawn where the host said they were a round trip ago — and then they were held back another tenth of a second on top of that, to keep them moving smoothly. Measured end to end, a car sat 2.7 m out of place on a home network, 3.6 m on Wi-Fi and 8.9 m through the backup relay — against a car 4.3 m long. That is why you could be shoved by a car that was not next to you yet, why hitting somebody back felt like driving through them, and why the whole thing looked out of sync. Every other car is now carried forward onto your own clock instead, following how fast each one is turning rather than just where it was pointing, so a car in a corner stays in the corner. The same measurement now reads 1.1 m, 1.5 m and 3.1 m. Nothing about the racing changed — the host still decides everything — you are simply being shown it on time.'],
        ['💥', 'Contact happens when you see it', 'A joiner used to slide into somebody, keep going, and then get snatched back when the host’s version of the crash finally arrived. Your own half of a bang is now worked out on your own machine as it happens, using the host’s collision maths, so you stop against the car you can actually see and the bang and the sparks land at the moment of contact. The host still has the final say and still settles who pushed whom. On a link too slow to be sure where the other cars are — the backup relay — this stays off rather than invent a crash that never happened.'],
        ['📶', 'Thirty updates a second, and a link you can read', 'The host sends the race out half again as often as it used to (a relayed room stays lower, because the public relay limits how much it will carry). And when your connection really is the problem, the HUD now says so — RELAY or SLOW LINK, with the ping — instead of leaving you to wonder why the cars feel wrong.'],
        ['🔧', 'Fixes', 'One unusually quick packet used to skew a joiner’s idea of the host clock for about five seconds, and every car on screen stuttered until it bled off; that estimate now uses a moving window. Cars are also no longer carried through a barrier while the game is working out where they went.'],
      ],
    },
    {
      v: '5.1', name: 'Know Your Car', items: [
        ['⚖', 'Every car is somebody', 'A full balance pass with one rule throughout: no car is made average. Each one is quickest somewhere and beaten somewhere else, and they are deliberately not equally easy — the Brick R and the Dune Runner are forgiving cars with a lower ceiling, the Apex MR and the Sting S ask for real skill and pay for it, and the rest sit between. Stripping weight is now capped at about a quarter of a car’s own weight, so a tiny car can no longer be turned into a 400 kg go-kart that beats everything.'],
        ['🏎', 'Muscle, roadster, hatch, truck', 'The Mule V8 has a real V8 torque curve and the top speed to go with it: nothing beats it away from a slow corner or down a long straight, and it still cannot change direction. The Sting S turns in quicker than anything else in the paddock and owns the tightest circuits. The Brick R is the car you want when the rain starts. The Dune Runner is more truck than ever — better on the loose, worse on tarmac.'],
        ['🌀', 'The Stormer keeps its own turbo', 'The Group B car no longer takes shop turbos, because bolting a bigger one on just made it the same car with more power. It has a Rally Turbo slot of its own instead: the Factory turbo, a Small Rally Turbo that spools in half a second and makes it driveable on tarmac at the cost of the top end, or a Group B Turbo with a second and a half of lag and everything at once. That is a choice about how hard you want the car to be, not a straight upgrade.'],
        ['🔋', 'A motor for the Volt', 'The electric car has a Motor and Inverter slot: a Sport Inverter or a Race Motor Pack, each one faster and each one hotter. Its motor now fades smoothly as it heats instead of doing nothing and then cutting to half power, so a long flat-out run asks you to lift early and let the brakes charge it back up.'],
        ['💰', 'Money that makes you choose', 'A race used to pay roughly what the best part in a slot costs, so everyone bought the best thing the moment they wanted it and the cheap half of the catalogue was never touched. Purses are about a third smaller, you start with less, and the big parts cost more — while sport pads, a cat-back, narrow tyres and an alloy radiator are all the price they always were. The first races are now spent on those, and a Race Shell is something you work towards. Running costs bite too: a fully built car costs more per race in fuel and wear than a mid-pack finish pays.'],
        ['⛽', 'Endurance can turn up anywhere with a pit lane', 'Endurance Park is still always the endurance race, but Harbour Loop, Dustbowl Oval, Rainline Hairpins and Grand Tour have their pit lanes back, and each one has a chance of being run as an endurance race — a long race with fuel, tyre wear and a stop. A session gets at most one surprise, and the schedule tells you which race it is before you build the car.'],
        ['🎛', 'A smaller, sharper instrument cluster', 'A proper rev counter whose shift lights ring the dial instead of taking a row above it, a bigger speed readout and gear beside it, and a boost gauge of its own instead of a seven-pixel bar — with a mark showing what the turbo could be giving you at these revs, so you can see the lag you are waiting out. An electric car gets a motor temperature dial in the same place, with the derate zone in red. The whole panel is a third shorter than it was, so there is more road to look at.'],
        ['💨', 'You can see the crosswind', 'The gusty stretches used to shove you sideways with nothing on screen to say why. Now grit blows across the road, wind socks line the whole zone, and the HUD says CROSSWIND and which way it is pushing.'],
        ['🎵', 'Music you can actually hear', 'The menu, garage and results themes were the last music left from v4. They are rewritten on eight-bar progressions with the sections, echo and pump the race songs use, and street circuits get a song of their own. The music was also mixed too quietly to hear under the engines, so it is louder by default.'],
        ['🔧', 'Fixes', 'The pit lane no longer flickers: the box, its white lines and the PIT stripe each sit at their own height instead of fighting over one. The shop shows the real weight saving for the car you are in, not a number from a different one. Bots have stopped buying parts their car cannot use.'],
      ],
    },
    {
      v: '5.0.2', name: 'Fits the screen', items: [
        ['⛽', 'Endurance lives on its own track', 'Endurance is no longer a session mode you pick. Endurance Park simply IS the endurance race: whenever it comes up in a session or a quick race, it is a three-lap run where fuel and tyres wear out and you stop in the pits. Harbour Loop, Dustbowl Oval and Grand Tour are back to normal races.'],
        ['🖥', 'A lobby that fits', 'The host lobby is three panels now — drivers, settings and chat — each scrolling on its own. A full grid of eight drivers can no longer push the settings or the Start button off the bottom of the screen.'],
        ['🌐', 'Roomier server list', 'More space inside the panel and inside every room row, so no text sits against an edge. The old Endurance filter is now "Racing now".'],
      ],
    },
    {
      v: '5.0.1', name: 'After Dark hotfix', items: [
        ['🔋', 'Volt garage fix', 'Choosing the Volt E in the garage no longer turns the screen white.'],
        ['🔊', 'Every car sounds like itself', 'Other drivers\' cars now have their own engine voices too: the Mule burbles, the Pip buzzes, the Stormer warbles and the Volt whines past, instead of every car sounding alike with only the pitch changed.'],
      ],
    },
    {
      v: '5.0', name: 'After Dark', items: [
        ['⛽', 'Endurance racing', 'Endurance Park is the endurance race: a longer run where fuel and tyres wear out, so you stop in the pit box and work your crew — choose tyres and fuel, hold to fill and let go on the line, then hit the wheel gun in the green. Your HUD tells you when to box. Bots pit too.'],
        ['🗺', 'Four new tracks', 'Serpent Pass, a true two-minute mountain sprint. Grand Tour, one long lap as evening falls. Neon Nights, downtown after dark. Endurance Park, a parkland circuit with a pit lane where the sun sets as you race.'],
        ['🌙', 'Night and weather', 'Street lamps, neon signs and headlights light the way at night. On Changeable weather a shower can start mid-race and the road turns slippery: narrow tyres and rain tyres cope best. Set the weather in the lobby or next to Quick race.'],
        ['⚠', 'New hazards', 'Falling rocks in a mountain gorge (watch for the shadow), swinging wrecking balls, gusty crosswinds, water splashes that grab your wheels, and a gravel trap you can cut across if you dare.'],
        ['🚗', 'Three new cars', 'Pip K1: a free kei car, slow on paper but light, nimble and thrifty with fuel. Volt E: electric all-wheel drive with instant torque; it gets hot on long straights and recharges under braking in endurance. Stormer B: a Group B rally legend, untouchable on loose surfaces and a handful on tarmac. Every car has a track where it shines, and some need real skill to get there.'],
        ['🤖', 'Smarter bots', 'Six difficulty levels, Rookie to Legend, for quick races and hosted rooms (the host picks). Bots take racing lines, pass on the inside, defend and sometimes make mistakes. Now and then one turns rival and goes looking for someone to bump, bot or player, and you get a warning if it\'s you.'],
        ['🔧', 'New parts and looks', 'Rain tyres, an intercooler, launch control or anti-lag, magnesium wheels, and a pit kit (a bigger fuel cell or quick-release wheels). In Paint: body kits, spoilers, exhaust tips, three new liveries and pulsing or rainbow underglow.'],
        ['🏆', 'Championships, horn and TV cameras', 'Hosts can decide the winner by championship points (25-18-15-12-10-8-6-4, +1 for the fastest lap) instead of money. Press H to honk. Press C for TV cameras that cut between trackside angles.'],
        ['🔊', 'Sound and music', 'Tyre roar and tread hiss that grow with speed, crunching gravel, splashes, breaking glass in big crashes, and sounds of each place: birds, sea, city, rain and thunder, crickets at night. Pit crews rattle their wheel guns. New race music for day, night, rally and endurance builds on the final lap, and is on by default.'],
        ['🌐', 'A cleaner server list', 'Filters, search and each room\'s status, mode and next track at a glance, and the list no longer blinks while it updates. Lobby settings are grouped and easier to read.'],
        ['🔧', 'Fixes', 'The ground no longer cuts into the road on mountain tracks. A premium car bought with sandbox money no longer carries into a hosted room.'],
      ],
    },
    {
      v: '4.5', name: 'Sound & Scale', items: [
        ['🖥', 'Fits every screen', 'The whole interface is laid out for a Chromebook screen and scales to yours: no more cut-off menus in small windows, and a HUD that isn\'t tiny on a big monitor. The minimap and speedo stay sharp at any size. New Menu size setting next to HUD size (now 70–130%).'],
        ['🔊', 'Engines with grit', 'Every engine has combustion rasp pulsed at its firing rate and an exhaust that rings at its own pitch, and idles wander like real ones. Turbos whistle with a blade overtone and sing loudest while they spool; superchargers whine locked to the crank with a rotor whirr, and hiss through the bypass valve when you lift.'],
        ['🔔', 'Sounds for the room', 'A knock and a bell when someone asks to join your private room, chimes when drivers join or leave, a fanfare for a new host, and a warning before an idle room closes. Info pop-ups blip softly.'],
        ['👋', 'Left or lost?', 'The chat now says whether a driver left the game or lost their connection (their seat is saved either way).'],
        ['📡', 'Lighter netcode', 'Snapshots are smaller (your own car\'s part is less than half the size), and a weak Wi-Fi link now skips stale packets instead of queueing them up as lag. The race loop and car sounds also create less throwaway data every frame.'],
      ],
    },
    {
      v: '4.4.2', name: 'Smooth Tow', items: [
        ['⚡', 'Smoother in a pack', 'Racing in a pack of 7 cars costs far less frame rate: name tags only update when they move, glows from distant cars are skipped, and crash sparks, thuds and exhaust crackles are capped, so a pile-up can\'t flood the screen and speakers.'],
        ['🌬', 'Slipstream you can see', 'Catch a tow and a SLIPSTREAM badge lights up at the top of the screen with how much drag you\'re saving, the screen edges glow blue, and a whoosh tells you you\'re in. The badge glows brighter at full tow: time to pull out and pass.'],
        ['⚓', 'Harbour boats', 'A boat could sit on the track at Harbour Loop. The boats are back out on the water.'],
        ['🔇', 'Stuck sound fixed', 'After a race next to a bot with a supercharger or turbo, its whine could keep playing on the main menu. It now stops with every other car sound.'],
      ],
    },
    {
      v: '4.4', name: 'Crowd Control', items: [
        ['👀', 'Spectate after the flag', 'Once you finish, the camera moves to the cars still racing: 1–8 or Tab picks one, F goes back to your own car, WASD flies a free camera.'],
        ['🤖', 'Livelier bots', '40 names (never two alike), random paint, finishes, liveries, rims and lights. Each bot has a style (grip, power, rally, lightweight, drag or all-rounder) that picks its car, what it buys between races, and sometimes a premium car.'],
        ['🔒', 'Private rooms, simpler', 'If you have the code, you walk straight in. Strangers on the server list ask first, and a private room\'s code is never shown there: the host\'s "yes" sends it, encrypted, to that player only.'],
        ['🔊', 'Sound on by default', 'Engines, tyres and music start with your first click. No more engine or brake sounds left playing in the menus or the garage between rounds.'],
        ['🎨', 'Paint camera', 'In the Paint tab, drag the car to turn it and scroll to zoom.'],
        ['⏳', 'Idle rooms close', 'A lobby that\'s never started closes after 15 minutes, and a room where nobody touches the controls for 10 minutes closes too, with a 2-minute warning.'],
        ['🏁', 'Up to 100 races', 'Sessions can now be 1–100 races long. Prize purses stop growing at 3× so late races don\'t dwarf early ones.'],
      ],
    },
    {
      v: '4.3', name: 'Open Rooms', items: [
        ['🌐', 'Server list', 'Find rooms from any classroom without passing codes around: Menu → 🌐 Server list. Hosts name their room and pick 🔒 Private (you let each new driver in) or 🌐 Public (anyone walks in), plus max drivers and bots, and can change them mid-session from the Esc menu.'],
        ['👑', 'Host migration', 'If the host drops out (or leaves), the next driver who joined takes over and everyone reconnects automatically with their car and money. A host whose internet came back rejoins in their own seat. The old autosave is gone, so nothing is stored between visits.'],
        ['🕐', 'Join any time', 'Late joiners watch the race in progress and drive from the next one, starting with 80% of the poorest driver\'s worth: enough to catch up, never enough to start ahead.'],
        ['💬', 'Chat everywhere', 'Press T or Enter on any screen, even mid-race, to chat. New lines fade in the corner, and the 💬 button counts what you missed.'],
        ['⚖', 'Balance pass', 'New traction control (Tuning → Assists, on by default): keyboard players on rear-drive cars no longer spin away 5 s off the line. Every car now wins somewhere and none wins more than a quarter of the tracks. Apex MR 140 kW and $3,800; Sting weaker on dirt and wet; Brick is the rally car; Dune toned down; tyres weaker and pricier; wings stronger; Big Turbo cheaper; brakes lose less bite when cold.'],
        ['🔧', 'Fixes', 'Test drives end when the next round starts. Name tags stay on cars over hills. Bots no longer swerve for speed pads on drag strips.'],
      ],
    },
    {
      v: '4.2', name: 'Smooth Starts', items: [
        ['🏁', 'First-race desync fixed', 'A slower device (usually a Chromebook on its first race) could freeze for a moment. Its car then carried on with the last keys pressed, straight into a wall, and everyone else\'s car jumped back if the host froze. Now the host catches up after a short freeze instead of losing time, and a bot keeps a frozen player\'s car on the road (at reduced power) until they\'re back.'],
        ['⏳', 'Everyone starts together', 'The countdown waits, up to 8 seconds, until every racer has finished loading the track. The start lights say WAITING meanwhile.'],
        ['🌙', 'Background tabs', 'A game left running in a background tab on a slow device no longer builds up a queue that held back its network messages.'],
      ],
    },
    {
      v: '4.1', name: 'School Wi-Fi', items: [
        ['🛰', 'Backup relay', 'Joining now works when two devices can\'t link directly, such as two Chromebooks on a school Wi-Fi that keeps devices apart. After about 8 seconds without a direct link, the game falls back to a relay through public servers on normal web ports. A message tells you when you\'re on it; expect a little more lag than a direct link.'],
        ['🌐', 'Rooms without matchmaking', 'If the matchmaking server is blocked, a room still opens on the relay, and joiners find it there.'],
        ['💬', 'Clearer join errors', 'A failed join now says which route was blocked and what to try next.'],
      ],
    },
    {
      v: '4.0', name: 'Slipstream & Chaos', items: [
        ['🌬', 'Slipstream', 'Tuck in behind another car to cut your drag by up to 45%: close up, pull out, slingshot past. A SLIPSTREAM meter and wind streaks show when you\'re in the tow.'],
        ['📈', 'Catch-up', 'Cars trailing the leader get extra power: Mild (up to +10%), Wild (up to +25%) or Off for pure racing. The host picks it in the lobby; quick races use your own setting.'],
        ['⚡', 'Nitrous', 'A new performance part: Street Shot (+30%) or Race Shot (+60%). Hold Shift (X or LB on a gamepad, N2O on touch). Drafting another car refills the bottle.'],
        ['🏔', '4 new maps', 'Summit Pass (a real mountain climb with icy hairpins and fallen rocks) · Coastal Highway (a 3 km sprint) · Scrapyard Gauntlet (oil, mud, barrel stacks and boost pads) · Backstretch Mile (a mile-long drag with speed pads in the lanes).'],
        ['🚙', '2 new cars', 'Dune Runner, an AWD desert truck ($2,600), and Apex MR, a mid-engine supercar ($4,800). Premium: buy one once and it\'s yours for the session.'],
        ['🎨', 'More customisation', 'Paint finishes (gloss, metallic, chrome flake, matte), headlight colours, and Fade and Flames liveries.'],
        ['🎲', 'Betting in the flow', 'Racers can back themselves, a bounty sits on the money leader\'s head, and you can go double-or-nothing on your prize after every race. You can back yourself before a quick race too.'],
        ['🗺', 'Hills & hazards', 'Tracks can now climb and dip, and gravity matters. Oil, mud, ice, speed pads and solid obstacles. Bots draft, use nitrous and dodge traps.'],
        ['🔊', 'Sound follows your mods', 'Exhaust changes the whole note (muffled / throaty with a drone / raw straight pipe), a race map crackles and bounces off the limiter, stripped cars are louder inside, sequential boxes whine, wings roar, race brakes squeal. Other cars too — and the garage has a 🔊 Listen button.'],
        ['⚖', 'Balance', 'Sprints get proper run-off after the flag and finished cars take no more damage. Drag grace scales with length. Bots got traction control and stop rear-ending each other. The Scrapyard is 2 laps.'],
      ],
    },
    {
      v: '3.2', name: 'Polish', items: [
        ['🔧', 'Car models', 'No more flickering layers; hood parts, calipers and roundels sit where they should.'],
        ['🧭', 'Minimap', 'The arrows point the way each car is facing.'],
        ['🌐', 'Joining', 'If a join stalls, the host calls the joiner back.'],
        ['🧼', 'Fresh sessions', 'Nothing is saved between visits.'],
      ],
    },
  ];
  // The "What's new" modal body (menu + pause menu).
  G.newsHtml = function (n) {
    return G.CHANGELOG.slice(0, n || 2)
      .map((c, k) => `<div class="news ${k ? 'old' : ''}"><h3>v${c.v} — ${c.name}</h3>${c.items.map(([ic, t, d]) => `<div class="news-i"><span>${ic}</span><div><b>${t}</b><p>${d}</p></div></div>`).join('')}</div>`)
      .join('');
  };
})(window.G);
