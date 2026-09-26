// netpack.js — snapshot (de)serialisation shared by host and client.
// Arrays, not objects: key names would triple the packet size.
//
//  FAST (every snapshot, 20 Hz, every car):
//    [x, z, h, vx, vz, w, steer, ax, ay, rpm, gear, boost, heat, flags, slip, surf, raceDist]
//    flags = spin(4 bits) | lock<<4 | overheat<<8 | backfire<<9 | ghost<<10 | wallHit<<11
//            | braking<<12 | handbrake<<13 | throttle<<14 | nitrous<<15 | speedPad<<16
//    slip  = 4 wheels × 3 bits (0..7)       surf = 4 wheels × 4 bits (surface code; v4 has 11)
//  SLOW (every 4th snapshot, 5 Hz):
//    [lapCount, finished, dnf, finishMs, bestLap, lastLap, curMs, tyreWear, engineWear, body, wrong, stops]
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
    const flags = (s.spin & 15) | ((s.lock & 15) << 4) | (s.overheat ? 256 : 0) | (s.backfire > 0 ? 512 : 0) | (s.ghost > 0 ? 1024 : 0) | (s.wallHit > 800 ? 2048 : 0) | (s.brk > 0.3 ? 4096 : 0) | (s.hb ? 8192 : 0) | (s.thr > 0.3 ? 16384 : 0) | (s.nosOn ? 32768 : 0) | (s.padT > 0.6 ? 65536 : 0) | (s.pit ? 131072 : 0);
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
    o.pit = f & 131072 ? 1 : 0; // v5: held in the pit box
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
    return [c.lapCount, c.finished ? 1 : 0, c.dnf ? 1 : 0, n(c.finishMs), n(c.bestLap), n(c.lastLap), Math.round(cur), r(s.tyreWear, 1000), r(s.engineWear, 1000), r(s.body, 1000), c.wrongT > 1.2 ? 1 : 0, c.stops || 0];
  }

  function unpackSlow(a) {
    const n = (v) => (v < 0 ? null : v);
    return { lapCount: a[0], finished: !!a[1], dnf: !!a[2], finishMs: n(a[3]), bestLap: n(a[4]), lastLap: n(a[5]), curMs: a[6], tyreWear: a[7], engineWear: a[8], body: a[9], wrong: !!a[10], stops: a[11] || 0 };
  }

  // Full core state for reconciliation. Order = P.CORE, then fy[0..3], then hint.
  // v4.5: rounded to 1e-4. Full doubles were ~400 bytes of JSON in every
  // snapshot; rounded it's ~175, and replaying 0.3 s of physics from the
  // rounded state drifts less than 0.1 mm (measured, sliding or not).
  const q4 = (v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
  function packFull(st) {
    const out = new Array(P.CORE.length + 5);
    for (let i = 0; i < P.CORE.length; i++) out[i] = q4(st[P.CORE[i]]);
    for (let i = 0; i < 4; i++) out[P.CORE.length + i] = q4(st.fy[i]);
    out[P.CORE.length + 4] = st.hint;
    return out;
  }
  function unpackFull(a, st) {
    for (let i = 0; i < P.CORE.length; i++) st[P.CORE[i]] = a[i];
    for (let i = 0; i < 4; i++) st.fy[i] = a[P.CORE.length + i];
    st.hint = a[P.CORE.length + 4];
    return st;
  }

  // ---- v5.5.6 compact snapshots (hostrace.js, for games that say sp) -----
  // Every number above is already rounded to its own unit (cm, mrad, ...),
  // so each one goes as a whole number of those units - a zigzag varint, one
  // to three bytes for most - and the lot as base64 text. The far end divides
  // back and gets exactly the numbers the JSON carried, in well under half
  // the bytes (a car's FAST array: ~82 characters of JSON, ~36 here).
  const FAST_M = [100, 100, 1000, 100, 100, 1000, 1000, 10, 10, 100, 1, 100, 100, 1, 1, 1, 10];
  const SLOW_M = [1, 1, 1, 1, 1, 1, 1, 1000, 1000, 1000, 1, 1];
  const FULL_M = 1e4; // (packFull's q4; the hint is a whole number anyway)
  function putV(out, v) {
    let z = Number.isFinite(v) ? Math.round(v) : 0;
    z = z >= 0 ? z * 2 : -z * 2 - 1; // (arithmetic, not bit ops: odometers pass 2^31 in 1e-4 m)
    while (z >= 128) {
      out.push((z % 128) | 128);
      z = Math.floor(z / 128);
    }
    out.push(z);
  }
  function getV(b, p) {
    let z = 0, mul = 1, c;
    do {
      if (p.i >= b.length) throw new Error('short');
      c = b.charCodeAt(p.i++);
      z += (c & 127) * mul;
      mul *= 128;
    } while (c & 128);
    return z % 2 ? -(z + 1) / 2 : z / 2;
  }
  const b64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode.apply(null, bytes.slice(i, i + 4096));
    return btoa(s);
  };
  // one row of numbers in its units -> bytes (cached per snapshot by the host)
  function rowBytes(a, M) {
    const out = [];
    for (let i = 0; i < M.length; i++) putV(out, a[i] * M[i]);
    return out;
  }
  // rows: byte arrays (rowBytes) or 0 for "not this time"; one bit per row says which
  function packRows(rows) {
    const out = [];
    for (let i = 0; i < rows.length; i += 8) {
      let m = 0;
      for (let k = 0; k < 8 && i + k < rows.length; k++) if (rows[i + k]) m |= 1 << k;
      out.push(m);
    }
    for (const r of rows) if (r) for (let i = 0; i < r.length; i++) out.push(r[i]);
    return b64(out);
  }
  // -> n rows of numbers (null where the host sent none); throws on junk
  function unpackRows(str, n, M) {
    if (typeof str !== 'string' || n < 0 || n > 64) throw new Error('bad');
    const b = atob(str), p = { i: Math.ceil(n / 8) }, rows = new Array(n);
    if (b.length < p.i) throw new Error('short');
    for (let j = 0; j < n; j++) {
      if (!(b.charCodeAt(j >> 3) & (1 << (j & 7)))) {
        rows[j] = null;
        continue;
      }
      const a = new Array(M.length);
      for (let i = 0; i < M.length; i++) a[i] = getV(b, p) / M[i];
      rows[j] = a;
    }
    return rows;
  }
  // FULL core state: only when every entry is a plain number (else null: send JSON)
  function packMe(a) {
    const out = [];
    for (let i = 0; i < a.length; i++) {
      if (typeof a[i] !== 'number' || !Number.isFinite(a[i])) return null;
      putV(out, a[i] * FULL_M);
    }
    return b64(out);
  }
  function unpackMe(str, n) {
    const b = atob(str), p = { i: 0 }, a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = getV(b, p) / FULL_M;
    return a;
  }

  // ---- v5.5.6 room state as changes (game.js, for games that say sd) -----
  // diff(a, b) -> a patch that turns a copy of a into b, or undefined when
  // they are the same. Plain JSON data only (the room state is). A patch is
  //   {r: v}                 replace with v
  //   {o: {k: patch}, d: [k]} an object's (or same-length array's) changed / gone keys
  //   {x: n, a: [...]}       an array with n items gone from the front and
  //                          these added at the end (the chat log)
  const isObj = (v) => v !== null && typeof v === 'object';
  function eq(a, b) {
    if (a === b) return true;
    if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!(k in b) || !eq(a[k], b[k])) return false;
    return true;
  }
  function diff(a, b) {
    if (a === b) return undefined;
    if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return eq(a, b) ? undefined : { r: b };
    if (Array.isArray(a) && a.length !== b.length) {
      // the chat pattern: the oldest lines scrolled off, new ones on the end
      for (let x = 0; x <= a.length && a.length - x <= b.length; x++) {
        let ok = true;
        for (let i = x; i < a.length && ok; i++) ok = eq(a[i], b[i - x]);
        if (ok) return a.length - x || !b.length ? { x, a: b.slice(a.length - x) } : { r: b };
      }
      return { r: b };
    }
    let o = null, d = null;
    for (const k of Object.keys(b)) {
      const p = k in a ? diff(a[k], b[k]) : { r: b[k] };
      if (p) (o || (o = {}))[k] = p;
    }
    if (!Array.isArray(a)) for (const k of Object.keys(a)) if (!(k in b)) (d || (d = [])).push(k);
    if (!o && !d) return undefined;
    const n = {};
    if (o) n.o = o;
    if (d) n.d = d;
    return n;
  }
  // apply a patch to t (changed in place where it can be); returns the result
  function patch(t, n) {
    if (!isObj(n)) throw new Error('bad patch');
    if ('r' in n) return n.r;
    if (!isObj(t)) throw new Error('patch misses');
    if (n.x != null || n.a) {
      if (!Array.isArray(t) || n.x > t.length) throw new Error('patch misses');
      if (n.x) t.splice(0, n.x);
      if (n.a) for (const v of n.a) t.push(v);
    }
    if (n.o) for (const k in n.o) t[k] = patch(t[k], n.o[k]);
    if (n.d) for (const k of n.d) delete t[k];
    return t;
  }
  // a fingerprint of the data whatever order its keys are in: the far end
  // checks its patched copy against it, and asks for the whole thing again
  // if they differ
  function chash(v) {
    let h = 2166136261;
    const mix = (s) => {
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
    };
    const walk = (x) => {
      if (Array.isArray(x)) {
        mix('[');
        for (const y of x) walk(y);
        mix(']');
      } else if (isObj(x)) {
        mix('{');
        for (const k of Object.keys(x).sort()) {
          mix(k + ':');
          walk(x[k]);
        }
        mix('}');
      } else mix(typeof x === 'string' ? '"' + x : String(x));
      mix(',');
    };
    walk(v);
    return h >>> 0;
  }

  G.NetPack = { packFast, unpackFast, packSlow, unpackSlow, packFull, unpackFull, PH, PH_NAMES, FAST_M, SLOW_M, rowBytes, packRows, unpackRows, packMe, unpackMe, FULL_LEN: P.CORE.length + 5, diff, patch, chash };
})(window.G);
