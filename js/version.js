// version.js — the game's version and what each update brought. Shown on the
// main menu (badge + "What's new"), in the pause menu, and automatically once
// after an update.
'use strict';
(function (G) {
  G.VERSION = '4.0';
  G.CHANGELOG = [
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
