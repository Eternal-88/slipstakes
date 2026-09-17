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
  // Visual themes. Optional: patch (meadow tint), mtn (distant mountains),
  // sea [dx, dz] (water beyond the track in that direction), rain, light
  // overrides (sunI/sunCol/hemiI/hemiSky), fog distances, tufts (grass kind).
  const THEMES = {
    harbour: { ground: 0x7cc46a, ground2: 0x5fae58, hill: 0x8fcf73, patch: 0xc9d86a, runoff: 'grass', sky: 0x9fd8ff, fog: 0xbfe6ff, trees: 'round', props: 'harbour', wall: [0xe8453c, 0xf4f1e8], sea: [0, -1], mtn: 0x7fa6a0, tufts: 'grass' },
    canyon: { ground: 0xe2a86a, ground2: 0xcf8f52, hill: 0xc9774a, patch: 0xd89858, runoff: 'sand', sky: 0xffd49a, fog: 0xffe0b8, trees: 'cactus', props: 'rocks', wall: [0xf28c28, 0xfff1d6], mtn: 0xc07a52, sunCol: 0xffe2b8, tufts: 'dry' },
    airstrip: { ground: 0x9bc76a, ground2: 0x86b85c, hill: 0xa4cf78, patch: 0xb8d470, runoff: 'grass', sky: 0xa6d4ff, fog: 0xcde8ff, trees: 'round', props: 'airstrip', wall: [0x2f6fed, 0xf4f1e8], mtn: 0x8fb09a, tufts: 'grass' },
    dustbowl: { ground: 0xd9955a, ground2: 0xc98249, hill: 0xbd7446, patch: 0xc9a35c, runoff: 'sand', sky: 0xffc98f, fog: 0xffdcb3, trees: 'cactus', props: 'stands', wall: [0xe23d6b, 0xffffff], mtn: 0xb97a56, sunCol: 0xffe0b0, tufts: 'dry' },
    rainline: { ground: 0x5d9a6a, ground2: 0x4f8a5f, hill: 0x6aa577, patch: 0x4f8f5c, runoff: 'grass', sky: 0x8fa9c4, fog: 0xa9bccf, trees: 'pine', props: 'rain', wall: [0x2fb5a8, 0xeaf2f2], mtn: 0x6d8494, rain: 1, sunI: 1.25, hemiI: 1.95, hemiSky: 0xcad6e2, fogNear: 120, fogFar: 430, tufts: 'grass' },
    pine: { ground: 0x5f9c55, ground2: 0x4d8a47, hill: 0x71ad5f, patch: 0x7aa85a, runoff: 'grass', sky: 0xa9dcff, fog: 0xcbe9ff, trees: 'pine', props: 'forest', wall: [0xf2c12e, 0x3a3a3a], mtn: 0x6f8f86, snow: 1, tufts: 'grass' },
    salt: { ground: 0xf1eadb, ground2: 0xe6dcc6, hill: 0xd9c9a8, patch: 0xece2cc, runoff: 'sand', sky: 0x9fd0ff, fog: 0xe6f2ff, trees: 'none', props: 'airstrip', wall: [0x8e44ec, 0xf6f0ff], mtn: 0x9c8fa8, snow: 1 },
    city: { ground: 0x9aa3ad, ground2: 0x8a939e, hill: 0xa7b0ba, patch: 0x949da8, runoff: 'concrete', sky: 0xb4d6ff, fog: 0xd2e5fb, trees: 'round', props: 'city', wall: [0xe8453c, 0xffffff] },
    proving: { ground: 0x8cc47a, ground2: 0x7db66c, hill: 0x9fd08a, patch: 0xa9cf7a, runoff: 'grass', sky: 0xb6dcff, fog: 0xd6ecff, trees: 'round', props: 'airstrip', wall: [0xffcc00, 0x26282e], mtn: 0x86a894, tufts: 'grass' },
    // v4 themes. hills = how steeply the ground rises away from the road.
    alpine: { ground: 0x86a86e, ground2: 0x769a60, hill: 0x9aae84, patch: 0xa9b98a, runoff: 'gravel', sky: 0x9ccfff, fog: 0xd6eaff, trees: 'pine', props: 'forest', wall: [0xdfe3e8, 0x39414d], mtn: 0x7f93a6, snow: 1, hills: 2.1, tufts: 'grass', sunI: 2.1, hemiI: 1.8 },
    coast: { ground: 0x88c46c, ground2: 0x76b25e, hill: 0x9bcf7a, patch: 0xd9d59b, runoff: 'sand', sky: 0x8fd3ff, fog: 0xcdeeff, trees: 'palm', props: 'harbour', wall: [0x19c3e6, 0xf4f1e8], sea: [1, 0], mtn: 0x86a99f, tufts: 'grass' },
    scrap: { ground: 0x8f8a7c, ground2: 0x827d70, hill: 0x9d9686, patch: 0x7c6f5c, runoff: 'concrete', sky: 0xb9c6cf, fog: 0xcfd6da, trees: 'none', props: 'scrap', wall: [0xffc400, 0x1b1d22], mtn: 0x857d78, tufts: 'dry', sunCol: 0xffe7c4 },
    dusk: { ground: 0x7d8a58, ground2: 0x6f7c4e, hill: 0x8c9563, patch: 0x9ea26c, runoff: 'concrete', sky: 0xff9e6b, fog: 0xf6b48c, trees: 'round', props: 'airstrip', wall: [0xff2d92, 0x1b1d22], mtn: 0x6b5a7a, sunCol: 0xffa060, sunI: 1.9, hemiI: 1.45, hemiSky: 0xffcfb0, fogNear: 150, fogFar: 520, tufts: 'dry' },
    // v5 themes. night: how dark it is (0 day .. 1 night: street lamps glow and
    // pool light on the road, headlights on). todTo: the time of day the race
    // ENDS at (it gets darker as the leader goes round). showers: chance of a
    // mid-race shower in Changeable weather (default 0.2). neon: signs on the
    // buildings. lamps: street lamps round the track.
    goldpass: { ground: 0x86ad68, ground2: 0x769d5a, hill: 0x9fb07e, patch: 0xc2b67c, runoff: 'gravel', sky: 0xf2b384, fog: 0xf7d6b4, trees: 'pine', props: 'forest', wall: [0xe9e4dc, 0x4a3b36], mtn: 0x8c7d98, snow: 1, hills: 1.9, tufts: 'grass', sunCol: 0xffcc92, sunI: 2.25, hemiI: 1.6, hemiSky: 0xffe8d4, fogNear: 220, fogFar: 680 },
    tour: { ground: 0x7fbf62, ground2: 0x6dae55, hill: 0x92c872, patch: 0xcfd27a, runoff: 'grass', sky: 0x94d0ff, fog: 0xcfeaff, trees: 'round', props: 'forest', wall: [0x2d7ff9, 0xf4f1e8], mtn: 0x7e9fae, tufts: 'grass', todTo: 0.55, fogNear: 200, fogFar: 640 },
    neon: { ground: 0x2c3038, ground2: 0x272a31, hill: 0x343842, patch: 0x30343c, runoff: 'concrete', sky: 0x151a3a, fog: 0x1c1a3c, trees: 'none', props: 'city', wall: [0xff2d92, 0x20232b], night: 1, neon: 1, lamps: 1, showers: 0.35, fogNear: 110, fogFar: 460 },
    endu: { ground: 0x78b862, ground2: 0x68a655, hill: 0x8cc472, patch: 0xb9cc72, runoff: 'grass', sky: 0x9cd4ff, fog: 0xd2ecff, trees: 'round', props: 'stands', wall: [0x14b8a6, 0xf4f1e8], mtn: 0x809fa8, tufts: 'grass', todTo: 1, lamps: 1, fogNear: 190, fogFar: 600 },
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
      id: 'canyon', name: 'Copper Canyon', format: 'sprint', theme: 'canyon', runoff: 6, startAt: 40, finishBack: 90,
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
      id: 'pine', name: 'Pine Ridge Rally', format: 'sprint', theme: 'pine', runoff: 5, startAt: 40, finishBack: 90,
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
    // ------------------------------------------------------------------ v4
    // Vertices may carry y (elevation, metres); hazards are listed per track
    // (see trackbuild.js _hazards): {k, at | x,z, lat, len, hw, r}.
    {
      id: 'summit', name: 'Summit Pass', format: 'sprint', theme: 'alpine', runoff: 4, startAt: 40, finishBack: 70,
      blurb: 'Mountain climb: four hairpin switchbacks up 58 m into the snow. Icy apexes, fallen rocks, and gravity fighting you all the way.',
      pts: [
        [0, -40, { w: 6.5, s: 'tarmac', kerb: 1, y: 0 }],
        [0, 100, { r: 30, y: 4 }],
        [160, 100, { r: 18, y: 14 }],
        [160, 136, { r: 18 }],
        [-20, 136, { r: 18, y: 26 }],
        [-20, 172, { r: 18 }],
        [170, 172, { r: 18, y: 38 }],
        [170, 208, { r: 18 }],
        [-10, 208, { r: 28, y: 48 }],
        [-40, 262, { r: 30 }],
        [-20, 340, { r: 35, y: 56 }],
        [60, 380, { r: 40, y: 58 }],
        [160, 392, {}],
        [250, 394, {}],
      ],
      hazards: [
        { k: 'ice', x: -20, z: 154, len: 18, hw: 5 },
        { k: 'ice', x: 170, z: 190, len: 18, hw: 5 },
        { k: 'rock', x: 90, z: 208, lat: -3.4, r: 1.0 },
        { k: 'rock', x: -30, z: 300, lat: 3.4, r: 1.1 },
      ],
    },
    {
      // (finishBack 260: cars cross the line at ~60 m/s and need the room to stop)
      id: 'coast', name: 'Coastal Highway', format: 'sprint', theme: 'coast', runoff: 8, startAt: 40, finishBack: 260,
      blurb: 'Three kilometres of seaside highway: flat-out sweepers over rolling crests. Slipstream heaven — and four speed pads.',
      pts: [
        [0, -40, { w: 8, s: 'tarmac', kerb: 1, y: 0 }],
        [0, 300, { r: 220, y: 2 }],
        [60, 620, { r: 260, y: 8 }],
        [20, 980, { r: 240, y: 14 }],
        [-60, 1300, { r: 120, y: 5 }],
        [-20, 1650, { r: 260, y: 9 }],
        [60, 1980, { r: 220, y: 16 }],
        [30, 2300, { r: 300, y: 10 }],
        [0, 2640, { y: 3 }],
        [0, 2960, {}],
      ],
      hazards: [
        { k: 'boost', at: 430, lat: 3 },
        { k: 'boost', at: 1180, lat: -3 },
        { k: 'boost', at: 1900, lat: 3 },
        { k: 'boost', at: 2450, lat: -3 },
      ],
    },
    {
      // (2 laps: at 3 the traps ground a third of the field into DNFs)
      id: 'scrap', name: 'Scrapyard Gauntlet', format: 'circuit', laps: 2, theme: 'scrap', runoff: 5,
      blurb: 'Traps everywhere: oil slicks, a mud pit, barrel stacks in the racing line — and boost pads if you can find a clean line to them.',
      pts: [
        [40, 0, { w: 7.5, s: 'tarmac', kerb: 1 }],
        [170, 0, { r: 22 }],
        [180, 70, { r: 18 }],
        [120, 90, { r: 16 }],
        [120, 150, { r: 20 }],
        [200, 160, { r: 24 }],
        [210, 240, { r: 30 }],
        [60, 250, { r: 28, s: 'dirt', kerb: 0 }],
        [-40, 230, { r: 26 }],
        [-60, 140, { r: 24, s: 'tarmac', kerb: 1 }],
        [0, 110, { r: 18 }],
        [-60, 60, { r: 20 }],
        [-20, 0, { r: 22 }],
      ],
      hazards: [
        { k: 'boost', at: 62, lat: -2.2 },
        { k: 'oil', x: 120, z: 122, lat: 1, len: 12, hw: 2.6 },
        { k: 'barrels', x: 205, z: 200, lat: -2.4, r: 0.95 },
        { k: 'mud', x: 135, z: 246, len: 26, hw: 5.5 },
        { k: 'tyres', x: 92, z: 248, lat: -2.6, r: 0.8 },
        { k: 'boost', x: -50, z: 186, lat: 2 },
        { k: 'oil', x: -30, z: 85, lat: -1.5, len: 10, hw: 2.4 },
        { k: 'barrels', at: 98, lat: 2.7, r: 0.95 },
      ],
    },
    {
      id: 'mile', name: 'Backstretch Mile', format: 'drag', theme: 'dusk', runoff: 6, startAt: 40, finishBack: 0, dragLength: 1609,
      blurb: 'A full mile at sunset, over a dip and a crest. Speed pads in the lanes and a huge slipstream: pick your lane, chase the leader.',
      pts: [
        [0, -40, { w: 15, s: 'tarmac', kerb: 0, y: 0 }],
        [0, 420, { y: 0 }],
        [0, 900, { y: -4 }],
        [0, 1400, { y: 4 }],
        [0, 1750, { y: 0 }],
        [0, 2020, {}],
      ],
      hazards: [
        { k: 'boost', at: 380, lat: 9.0, len: 8, hw: 1.6, dv: 6 },
        { k: 'boost', at: 380, lat: -1.8, len: 8, hw: 1.6, dv: 6 },
        { k: 'boost', at: 380, lat: -12.6, len: 8, hw: 1.6, dv: 6 },
        { k: 'boost', at: 780, lat: 5.4, len: 8, hw: 1.6, dv: 6 },
        { k: 'boost', at: 780, lat: -5.4, len: 8, hw: 1.6, dv: 6 },
        { k: 'boost', at: 1180, lat: 12.6, len: 8, hw: 1.6, dv: 6 },
        { k: 'boost', at: 1180, lat: 1.8, len: 8, hw: 1.6, dv: 6 },
        { k: 'boost', at: 1180, lat: -9.0, len: 8, hw: 1.6, dv: 6 },
      ],
    },

    // ------------------------------------------------------------------ v5
    // Per-vertex run-off: ro (width) and rs (surface) carry forward like w/s.
    // New hazards: water, wind, rockfall, swing (trackbuild.js _hazards).
    // pit {at, side, len}: an endurance pit box beside the main straight.
    {
      id: 'serpent', name: 'Serpent Pass', format: 'sprint', theme: 'goldpass', runoff: 5, startAt: 40, finishBack: 250, isNew: 1,
      blurb: 'The long one: a two-minute point-to-point up a mountain at golden hour. Through a ford and a rockfall gorge, up four switchbacks, over a windy icy summit and all the way down.',
      pts: [
        [0, -40, { w: 7, s: 'tarmac', kerb: 1, y: 0 }],
        [0, 260, { r: 140, y: 4 }],
        [140, 430, { r: 90, y: 8 }],
        [100, 640, { r: 120, y: 14 }],
        [100, 900, { r: 22, y: 20, w: 6.5, ro: 3.5 }],
        [340, 900, { r: 18, y: 30 }],
        [340, 940, { r: 18 }],
        [140, 940, { r: 18, y: 42 }],
        [140, 980, { r: 18 }],
        [340, 980, { r: 18, y: 54 }],
        [340, 1020, { r: 18 }],
        [140, 1020, { r: 18, y: 66 }],
        [140, 1060, { r: 18 }],
        [340, 1060, { r: 40, y: 78, w: 7, ro: 5 }],
        [480, 1110, { r: 70, y: 90 }],
        [520, 1300, { r: 80, y: 100 }],
        [420, 1480, { r: 45, y: 104 }],
        [560, 1600, { r: 40, y: 96 }],
        [480, 1760, { r: 50, y: 80 }],
        [640, 1880, { r: 70, y: 62 }],
        [700, 2100, { r: 100, y: 42 }],
        [640, 2300, { y: 30 }],
        [640, 2580, { y: 26 }],
      ],
      hazards: [
        { k: 'water', x: 70, z: 345, len: 14, hw: 9 },
        { k: 'rockfall', x: 120, z: 535, len: 150, spread: 4, every: 5, stay: 6, r: 1.1 },
        { k: 'wind', x: 500, z: 1205, len: 190, str: 6, period: 4.5 },
        { k: 'ice', x: 470, z: 1390, len: 30, hw: 5 },
        { k: 'rock', x: 520, z: 1680, lat: 3.2, r: 1.0 },
        { k: 'rock', x: 670, z: 1990, lat: -3.2, r: 1.1 },
      ],
    },
    {
      id: 'tour', name: 'Grand Tour', format: 'circuit', laps: 1, theme: 'tour', runoff: 6, isNew: 1,
      blurb: 'One lap of a 3.6 km countryside loop as evening falls: a gravel-trap S you can cut if you dare, a gusty causeway, a dirt rally stage and a ford.',
      pts: [
        [0, 0, { w: 8, s: 'tarmac', kerb: 1, y: 0 }],
        [385, 0, { r: 52 }],
        [444, 222, { r: 118, y: 4 }],
        [370, 459, { r: 44, y: 10 }],
        [474, 592, { r: 30, y: 14, ro: 15, rs: 'gravel' }],
        [414, 710, { r: 27, y: 16 }],
        [518, 814, { r: 67, y: 18, ro: 6, rs: null }],
        [474, 1051, { r: 89, y: 12 }],
        [281, 1184, { r: 37, y: 8 }],
        [104, 1125, { r: 22, y: 6, s: 'dirt', kerb: 0 }],
        [30, 1214, { r: 22, y: 10 }],
        [-118, 1154, { r: 30, y: 14 }],
        [-163, 992, { r: 37, y: 10, s: 'tarmac', kerb: 1 }],
        [-89, 873, { r: 26, y: 6 }],
        [-192, 740, { r: 44, y: 4 }],
        [-178, 518, { r: 89, y: 2 }],
        [-237, 311, { r: 33, y: 0 }],
        [-133, 192, { r: 30 }],
        [-192, 67, { r: 37 }],
        [-118, 0, { r: 30 }],
      ],
      hazards: [
        { k: 'wind', x: 496, z: 932, len: 200, str: 5.5, period: 5.5, dir: -1 },
        { k: 'boost', at: 700, lat: 2.5 },
        { k: 'water', x: -185, z: 630, len: 16, hw: 9 },
        { k: 'mud', x: 67, z: 1170, len: 14, hw: 4, lat: 1.5 },
        { k: 'boost', at: 3000, lat: -2.5 },
      ],
    },
    {
      id: 'neon', name: 'Neon Nights', format: 'circuit', laps: 2, theme: 'neon', runoff: 3.5, isNew: 1,
      blurb: 'Downtown after dark: street lamps, neon, a flooded underpass and a building site where the wrecking balls are still swinging.',
      pts: [
        [0, 0, { w: 7.5, s: 'tarmac', kerb: 1 }],
        [270, 0, { r: 24 }],
        [290, 130, { r: 30 }],
        [350, 220, { r: 24 }],
        [400, 300, { r: 30 }],
        [400, 460, { r: 16 }],
        [240, 460, { r: 14 }],
        [240, 380, { r: 14 }],
        [80, 380, { r: 18 }],
        [-60, 460, { r: 24 }],
        [-140, 340, { r: 20 }],
        [-60, 220, { r: 16 }],
        [-140, 120, { r: 18 }],
        [-80, 0, { r: 18 }],
      ],
      hazards: [
        { k: 'water', x: 400, z: 380, len: 24, hw: 9 },
        { k: 'swing', x: 160, z: 380, amp: 5.5, period: 5.2, r: 1.3 },
        { k: 'swing', x: -100, z: 280, amp: 5, period: 6.1, r: 1.3, off: 2 },
        { k: 'oil', at: 470, lat: -1.5, len: 10, hw: 2.4 },
        { k: 'boost', x: 130, z: 0, lat: 2.2 },
      ],
    },
    {
      // v5: the endurance track. Raced like any other track in the rotation,
      // but this one is a long race with fuel, tyres and pit stops.
      id: 'endu', name: 'Endurance Park', format: 'circuit', laps: 3, theme: 'endu', runoff: 7, isNew: 1,
      pit: { at: 170, side: -1, len: 70 }, endurance: 1, enduLaps: 3,
      blurb: 'The endurance race: three laps of parkland with a proper pit lane. Fuel and tyres run down, so you stop and work your pit crew. The sun goes down as you race.',
      pts: [
        [0, 0, { w: 8, s: 'tarmac', kerb: 1, y: 0 }],
        [420, 0, { r: 40 }],
        [470, 160, { r: 60, y: 3 }],
        [340, 300, { r: 90, y: 6 }],
        [420, 480, { r: 35, y: 8 }],
        [300, 560, { r: 28, y: 8 }],
        [140, 520, { r: 50, y: 5 }],
        [40, 640, { r: 70, y: 3 }],
        [-160, 600, { r: 45, y: 2 }],
        [-200, 420, { r: 80, y: 1 }],
        [-100, 260, { r: 55 }],
        [-220, 120, { r: 40 }],
        [-150, 0, { r: 35 }],
      ],
      hazards: [
        { k: 'boost', at: 860, lat: 2 },
        { k: 'oil', x: -180, z: 510, lat: 1.5, len: 10, hw: 2.4 },
      ],
    },
  ];

  // (endurance: this track is raced as an endurance race — enduLaps long, with
  //  fuel, tyre wear and a pit box at pit {at, side, len})
  // Format rotation: never the same format twice in a row, cycles all tracks.
  const ROTATION = ['harbour', 'canyon', 'quarter', 'dustbowl', 'serpent', 'rainline', 'saltflat', 'pine', 'city', 'summit', 'coast', 'scrap', 'mile', 'neon', 'tour', 'endu'];

  G.TrackDefs = { THEMES, TRACKS, ROTATION, PROVING, byId: (id) => (id === 'proving' ? PROVING : TRACKS.find((t) => t.id === id)) };
})(window.G);
