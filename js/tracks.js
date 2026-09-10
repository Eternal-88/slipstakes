// tracks.js — hand-laid track definitions.
//
// Each track is a list of centreline vertices [x, z, attrs?] in metres.
//   attrs.r     corner radius: the vertex is a polygon corner that the builder
//               replaces with a circular arc of this radius (0 = plain spline point)
//   attrs.w     half-width of the road from this vertex on
//   attrs.s     surface from this vertex on: 'tarmac' | 'dirt' | 'wet' | 'gravel'
//   attrs.kerb  1/0 — kerbs are auto-placed on tight corners while enabled
//   attrs.bank  max banking (degrees) applied on curved sections from here on
// Attributes carry forward until changed. A Catmull-Rom spline is then run
// through the expanded points and resampled every 2 m (see trackbuild.js).
//
// Circuits: the FIRST vertex is a plain point on the main straight — the
// start/finish line sits there and the grid extends backwards around the loop.
// Open tracks (drag / point-to-point): start line at `startAt` metres, finish
// `finishBack` metres before the end; walls cap both ends.
'use strict';
(function (G) {
  const THEMES = {
    harbour: { ground: 0x7cc46a, ground2: 0x5fae58, hill: 0x8fcf73, runoff: 'grass', sky: 0x9fd8ff, fog: 0xbfe6ff, trees: 'round', props: 'harbour', wall: [0xe8453c, 0xf4f1e8] },
    canyon: { ground: 0xe2a86a, ground2: 0xcf8f52, hill: 0xc9774a, runoff: 'sand', sky: 0xffd49a, fog: 0xffe0b8, trees: 'cactus', props: 'rocks', wall: [0xf28c28, 0xfff1d6] },
    airstrip: { ground: 0x9bc76a, ground2: 0x86b85c, hill: 0xa4cf78, runoff: 'grass', sky: 0xa6d4ff, fog: 0xcde8ff, trees: 'round', props: 'airstrip', wall: [0x2f6fed, 0xf4f1e8] },
    dustbowl: { ground: 0xd9955a, ground2: 0xc98249, hill: 0xbd7446, runoff: 'sand', sky: 0xffc98f, fog: 0xffdcb3, trees: 'cactus', props: 'stands', wall: [0xe23d6b, 0xffffff] },
    rainline: { ground: 0x5d9a6a, ground2: 0x4f8a5f, hill: 0x6aa577, runoff: 'grass', sky: 0x8fa9c4, fog: 0xa9bccf, trees: 'pine', props: 'stands', wall: [0x2fb5a8, 0xeaf2f2] },
    pine: { ground: 0x5f9c55, ground2: 0x4d8a47, hill: 0x71ad5f, runoff: 'grass', sky: 0xa9dcff, fog: 0xcbe9ff, trees: 'pine', props: 'rocks', wall: [0xf2c12e, 0x3a3a3a] },
    salt: { ground: 0xf1eadb, ground2: 0xe6dcc6, hill: 0xd9c9a8, runoff: 'sand', sky: 0x9fd0ff, fog: 0xe6f2ff, trees: 'none', props: 'airstrip', wall: [0x8e44ec, 0xf6f0ff] },
    city: { ground: 0x9aa3ad, ground2: 0x8a939e, hill: 0xa7b0ba, runoff: 'concrete', sky: 0xb4d6ff, fog: 0xd2e5fb, trees: 'round', props: 'city', wall: [0xe8453c, 0xffffff] },
    proving: { ground: 0x8cc47a, ground2: 0x7db66c, hill: 0x9fd08a, runoff: 'grass', sky: 0xb6dcff, fog: 0xd6ecff, trees: 'round', props: 'airstrip', wall: [0xffcc00, 0x26282e] },
  };

  // Garage test loop (never raced): one of everything so a part's effect shows
  // up within a lap — fast sweeper, kerbed chicane, wet hairpin, dirt patch.
  const PROVING = {
    id: 'proving', name: 'Proving Ground', format: 'circuit', laps: 99, theme: 'proving', runoff: 12, hidden: true,
    blurb: 'Test loop: fast sweeper, kerbed chicane, wet hairpin, dirt patch.',
    pts: [
      [0, 0, { w: 7.5, s: 'tarmac', kerb: 1 }],
      [120, 0, { r: 45 }],
      [150, 100, { r: 30 }],
      [100, 150, { r: 16, s: 'wet' }],
      [70, 110, { r: 18, s: 'tarmac' }],
      [20, 150, { r: 22, s: 'dirt', kerb: 0 }],
      [-60, 140, { r: 28, s: 'tarmac', kerb: 1 }],
      [-80, 60, { r: 26 }],
      [-50, 0, { r: 24 }],
    ],
  };

  const TRACKS = [
    {
      id: 'harbour', name: 'Harbour Loop', format: 'circuit', laps: 3, theme: 'harbour', runoff: 10,
      blurb: 'Fast sweepers and a tight inner complex. Pure tarmac — grip builds shine.',
      pts: [
        [80, 0, { w: 7, s: 'tarmac', kerb: 1 }],
        [170, 0, { r: 32 }],
        [175, 80, { r: 18 }],
        [110, 95, { r: 16 }],
        [105, 150, { r: 22 }],
        [185, 170, { r: 24 }],
        [170, 250, { r: 34 }],
        [40, 255, { r: 26 }],
        [-40, 215, { r: 30 }],
        [-55, 90, { r: 40 }],
        [-20, 0, { r: 30 }],
      ],
    },
    {
      id: 'canyon', name: 'Copper Canyon', format: 'sprint', theme: 'canyon', runoff: 6, startAt: 40, finishBack: 45,
      blurb: 'Point-to-point: tarmac, a long dirt climb, a wet river ford, then tarmac to the flag.',
      pts: [
        [0, -40, { w: 6.5, s: 'tarmac', kerb: 1 }],
        [0, 110, { r: 35 }],
        [70, 170, { r: 30 }],
        [130, 175, { s: 'dirt', kerb: 0 }],
        [200, 185, { r: 35 }],
        [215, 280, { r: 40 }],
        [130, 320, { r: 30 }],
        [95, 400, { r: 30 }],
        [120, 440, { s: 'wet' }],
        [170, 470, { r: 25 }],
        [230, 470, { r: 20, s: 'tarmac', kerb: 1 }],
        [260, 560, { r: 40 }],
        [200, 640, { r: 30 }],
        [215, 730, { r: 30 }],
        [280, 780, {}],
        [340, 792, {}],
      ],
    },
    {
      id: 'quarter', name: 'Airstrip Quarter', format: 'drag', theme: 'airstrip', runoff: 6, startAt: 40, finishBack: 0, dragLength: 402,
      blurb: 'Quarter-mile drag. Launch and gearing decide it. Aero is dead weight.',
      pts: [
        [0, -40, { w: 15, s: 'tarmac', kerb: 0 }],
        [0, 250, {}],
        [0, 480, {}],
        [0, 720, {}],
      ],
    },
    {
      id: 'dustbowl', name: 'Dustbowl Oval', format: 'circuit', laps: 4, theme: 'dustbowl', runoff: 7,
      blurb: 'Banked dirt oval. Throttle-steer it round, flat out. Wide slicks will hate it.',
      pts: [
        [0, -50, { w: 8.5, s: 'dirt', kerb: 0, bank: 11 }],
        [100, -50, { r: 48 }],
        [100, 50, { r: 48 }],
        [-100, 50, { r: 48 }],
        [-100, -50, { r: 48 }],
      ],
    },
    {
      id: 'rainline', name: 'Rainline Hairpins', format: 'circuit', laps: 3, theme: 'rainline', runoff: 9,
      blurb: 'Two soaked hairpins and a greasy back section. Narrow tyres, soft springs.',
      pts: [
        [60, 0, { w: 7, s: 'tarmac', kerb: 1 }],
        [180, 0, { r: 20, s: 'wet' }],
        [190, 45, { r: 20 }],
        [80, 60, { r: 25, s: 'tarmac' }],
        [70, 120, { r: 25 }],
        [190, 140, { r: 22 }],
        [200, 190, { r: 22, s: 'wet' }],
        [20, 200, { r: 30 }],
        [-60, 150, { r: 25, s: 'tarmac' }],
        [-10, 100, { r: 20 }],
        [-70, 55, { r: 25 }],
        [-20, 0, { r: 25 }],
      ],
    },
    {
      id: 'pine', name: 'Pine Ridge Rally', format: 'sprint', theme: 'pine', runoff: 5, startAt: 40, finishBack: 45,
      blurb: 'Point-to-point rally stage: dirt, loose gravel, a wet gully, one tarmac road crossing.',
      pts: [
        [0, -40, { w: 6.2, s: 'dirt', kerb: 0 }],
        [0, 90, { r: 30 }],
        [-60, 150, { r: 25 }],
        [-65, 230, { r: 30 }],
        [0, 270, { r: 25, s: 'gravel' }],
        [70, 250, { r: 30 }],
        [120, 300, { r: 25, s: 'wet' }],
        [100, 370, { r: 30 }],
        [30, 390, { r: 25, s: 'dirt' }],
        [20, 470, { r: 30 }],
        [90, 510, { r: 25, s: 'tarmac', kerb: 1 }],
        [170, 500, { r: 30 }],
        [200, 570, { r: 30, s: 'dirt', kerb: 0 }],
        [150, 640, { r: 25 }],
        [170, 720, { r: 30 }],
        [240, 750, {}],
        [300, 762, {}],
      ],
    },
    {
      id: 'saltflat', name: 'Salt Flat Half-Mile', format: 'drag', theme: 'salt', runoff: 6, startAt: 40, finishBack: 0, dragLength: 804,
      blurb: 'Half-mile drag. Top speed matters here — long gears and big boost pay off.',
      pts: [
        [0, -40, { w: 15, s: 'tarmac', kerb: 0 }],
        [0, 300, {}],
        [0, 650, {}],
        [0, 900, {}],
        [0, 1160, {}],
      ],
    },
    {
      id: 'city', name: 'Kerbside City', format: 'circuit', laps: 3, theme: 'city', runoff: 3.5,
      blurb: 'Street circuit: square corners, big kerbs, walls close. Stiff springs will skip.',
      pts: [
        [40, 0, { w: 7, s: 'tarmac', kerb: 1 }],
        [140, 0, { r: 15 }],
        [140, 70, { r: 13 }],
        [90, 70, { r: 13 }],
        [90, 130, { r: 15 }],
        [170, 130, { r: 15 }],
        [170, 200, { r: 17 }],
        [-30, 200, { r: 17 }],
        [-30, 110, { r: 13 }],
        [20, 110, { r: 13 }],
        [20, 60, { r: 14 }],
        [-30, 60, { r: 14 }],
        [-30, 0, { r: 15 }],
      ],
    },
  ];

  // Format rotation: never the same format twice in a row, cycles all tracks.
  const ROTATION = ['harbour', 'canyon', 'quarter', 'dustbowl', 'rainline', 'saltflat', 'pine', 'city'];

  G.TrackDefs = { THEMES, TRACKS, ROTATION, PROVING, byId: (id) => (id === 'proving' ? PROVING : TRACKS.find((t) => t.id === id)) };
})(window.G);
