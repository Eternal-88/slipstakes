// netpack.js — snapshot (de)serialisation shared by host and client.
// Arrays, not objects: key names would triple the packet size.
//
//  FAST (every snapshot, 20 Hz, every car):
//    [x, z, h, vx, vz, w, steer, ax, ay, rpm, gear, boost, heat, flags, slip, surf, raceDist]
//    flags = spin(4 bits) | lock<<4 | overheat<<8 | backfire<<9 | ghost<<10 | wallHit<<11
//            | braking<<12 | handbrake<<13 | throttle<<14 | nitrous<<15 | speedPad<<16
//    slip  = 4 wheels × 3 bits (0..7)       surf = 4 wheels × 4 bits (surface code; v4 has 11)
//  SLOW (every 4th snapshot, 5 Hz):
//    [lapCount, finished, dnf, finishMs, bestLap, lastLap, curMs, tyreWear, engineWear, body, wrong]
//  FULL (only to the owning client, every snapshot): the complete physics core
//    state of that client's car — what reconciliation rewinds to.
'use strict';
(function (G) {
  const P = G.Physics;
  const r = (v, m) => Math.round(v * m) / m;
  const PH = { grid: 0, race: 1, done: 2 };
  const PH_NAMES = ['grid', 'race', 'done'];

  function packFast(c) {
    const s = c.st;
    const flags = (s.spin & 15) | ((s.lock & 15) << 4) | (s.overheat ? 256 : 0) | (s.backfire > 0 ? 512 : 0) | (s.ghost > 0 ? 1024 : 0) | (s.wallHit > 800 ? 2048 : 0) | (s.brk > 0.3 ? 4096 : 0) | (s.hb ? 8192 : 0) | (s.thr > 0.3 ? 16384 : 0) | (s.nosOn ? 32768 : 0) | (s.padT > 0.6 ? 65536 : 0);
    let slip = 0, surf = 0;
    for (let i = 0; i < 4; i++) {
      slip |= Math.min(7, Math.round(s.slip[i] * 7)) << (i * 3);
      surf |= (s.surf[i] & 15) << (i * 4);
    }
    return [r(s.x, 100), r(s.z, 100), r(s.h, 1000), r(s.vx, 100), r(s.vz, 100), r(s.w, 1000), r(s.steer, 1000), r(s.ax, 10), r(s.ay, 10), r(s.rpm, 100), s.gear, r(s.boost, 100), r(s.heat, 100), flags, slip, surf, r(c.raceDist, 10)];
  }

  function unpackFast(a, o) {
    o = o || { slip: [0, 0, 0, 0], surf: [0, 0, 0, 0] };
    o.x = a[0]; o.z = a[1]; o.h = a[2]; o.vx = a[3]; o.vz = a[4]; o.w = a[5]; o.steer = a[6];
    o.ax = a[7]; o.ay = a[8]; o.rpm = a[9]; o.gear = a[10]; o.boost = a[11]; o.heat = a[12];
    const f = a[13];
    o.spin = f & 15; o.lock = (f >> 4) & 15; o.overheat = f & 256 ? 1 : 0; o.backfire = f & 512 ? 0.1 : 0; o.ghost = f & 1024 ? 1 : 0; o.wallHit = f & 2048 ? 1000 : 0;
    o.brk = f & 4096 ? 1 : 0; o.hb = f & 8192 ? 1 : 0; o.thr = f & 16384 ? 1 : 0; // brake lights / exhaust for remote cars
    o.nosOn = f & 32768 ? 1 : 0; o.pad = f & 65536 ? 1 : 0; // nitrous flame, speed-pad flash
    for (let i = 0; i < 4; i++) {
      o.slip[i] = ((a[14] >> (i * 3)) & 7) / 7;
      o.surf[i] = (a[15] >> (i * 4)) & 15;
    }
    o.raceDist = a[16];
    return o;
  }

  function packSlow(c, sim) {
    const s = c.st;
    let cur = 0;
    const rt = sim.raceStartT != null ? sim.t - sim.raceStartT : 0;
    if (c.finished) cur = c.finishMs;
    else if (sim.track.closed) cur = c.lapStartT != null && c.lapStartT >= 0 ? (sim.t - c.lapStartT) * 1000 : rt * 1000;
    else cur = rt * 1000;
    const n = (v) => (v == null ? -1 : Math.round(v));
    return [c.lapCount, c.finished ? 1 : 0, c.dnf ? 1 : 0, n(c.finishMs), n(c.bestLap), n(c.lastLap), Math.round(cur), r(s.tyreWear, 1000), r(s.engineWear, 1000), r(s.body, 1000), c.wrongT > 1.2 ? 1 : 0];
  }

  function unpackSlow(a) {
    const n = (v) => (v < 0 ? null : v);
    return { lapCount: a[0], finished: !!a[1], dnf: !!a[2], finishMs: n(a[3]), bestLap: n(a[4]), lastLap: n(a[5]), curMs: a[6], tyreWear: a[7], engineWear: a[8], body: a[9], wrong: !!a[10] };
  }

  // Full core state for reconciliation. Order = P.CORE, then fy[0..3], then hint.
  function packFull(st) {
    const out = new Array(P.CORE.length + 5);
    for (let i = 0; i < P.CORE.length; i++) out[i] = st[P.CORE[i]];
    for (let i = 0; i < 4; i++) out[P.CORE.length + i] = st.fy[i];
    out[P.CORE.length + 4] = st.hint;
    return out;
  }
  function unpackFull(a, st) {
    for (let i = 0; i < P.CORE.length; i++) st[P.CORE[i]] = a[i];
    for (let i = 0; i < 4; i++) st.fy[i] = a[P.CORE.length + i];
    st.hint = a[P.CORE.length + 4];
    return st;
  }

  G.NetPack = { packFast, unpackFast, packSlow, unpackSlow, packFull, unpackFull, PH, PH_NAMES };
})(window.G);
