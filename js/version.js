// version.js — the game's version and what each update brought. Shown on the
// main menu (badge + "What's new"), in the pause menu, and automatically once
// after an update.
'use strict';
(function (G) {
  G.VERSION = '4.4.2';
  G.CHANGELOG = [
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
