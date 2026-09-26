// util.js — shared namespace, math helpers, deterministic RNG, formatting.
// Every module attaches itself to the global `G` namespace so the game runs from
// plain <script> tags (works from file:// on a locked-down Chromebook, no bundler).
'use strict';
window.G = window.G || {};

(function (G) {
  const U = {};

  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.smoothstep = (a, b, x) => {
    const t = U.clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  U.sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  U.wrapAngle = (a) => {
    a = (a + Math.PI) % (2 * Math.PI);
    if (a < 0) a += 2 * Math.PI;
    return a - Math.PI;
  };
  U.lerpAngle = (a, b, t) => a + U.wrapAngle(b - a) * t;
  // Frame-rate independent exponential smoothing.
  U.damp = (a, b, lambda, dt) => U.lerp(a, b, 1 - Math.exp(-lambda * dt));
  U.round = (v, d) => {
    const m = Math.pow(10, d);
    return Math.round(v * m) / m;
  };

  // Seeded PRNG (mulberry32). Used for scenery scatter so every peer builds the
  // identical world from the same track id.
  U.rng = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  // v5.5.6: SHA-256 (hex) of a string, synchronously. The heirs' copy of the
  // room carries each seat token as this (U.seatHash), never the token: the
  // next host can still check a returning player's token, but an heir can no
  // longer read everyone's tokens and walk into another player's seat.
  const SHA_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  U.sha256hex = (str) => {
    const msg = new TextEncoder().encode(String(str));
    const n = (msg.length + 9 + 63) >> 6, buf = new Uint8Array(n * 64);
    buf.set(msg);
    buf[msg.length] = 0x80;
    const dv = new DataView(buf.buffer), bits = msg.length * 8;
    dv.setUint32(buf.length - 4, bits >>> 0);
    dv.setUint32(buf.length - 8, Math.floor(bits / 4294967296));
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    const rotr = (x, k) => (x >>> k) | (x << (32 - k));
    for (let blk = 0; blk < n; blk++) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(blk * 64 + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15], b = W[i - 2];
        W[i] = W[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + W[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
      }
      let a = H[0], b = H[1], cc = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + W[i]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & cc) ^ (b & cc))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = cc; cc = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += cc; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    let out = '';
    for (let i = 0; i < 8; i++) out += H[i].toString(16).padStart(8, '0');
    return out;
  };
  U.seatHash = (token) => U.sha256hex('ss-seat|' + token);
  U.hashStr = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  // Deterministic, position-based bump noise in [-1, 1]. Physics uses this for
  // surface roughness so host and client prediction produce the same bumps.
  U.bump = (x, z) =>
    Math.sin(x * 1.91 + z * 0.37) * 0.55 +
    Math.sin(z * 2.63 - x * 0.71) * 0.3 +
    Math.sin((x + z) * 5.3) * 0.15;

  // Cryptographically strong randomness for casino outcomes (host only).
  U.cryptoInt = (n) => {
    const buf = new Uint32Array(1);
    const lim = Math.floor(0xffffffff / n) * n;
    let v;
    do {
      crypto.getRandomValues(buf);
      v = buf[0];
    } while (v >= lim);
    return v % n;
  };

  U.uid = (n = 10) => {
    const c = 'abcdefghijkmnopqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < n; i++) s += c[U.cryptoInt(c.length)];
    return s;
  };
  U.roomCode = () => {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 5; i++) s += c[U.cryptoInt(c.length)];
    return s;
  };

  U.fmtMoney = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  U.fmtSigned = (n) => (n >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
  U.fmtTime = (ms) => {
    if (ms == null || !isFinite(ms)) return '--:--.---';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const x = Math.floor(ms % 1000);
    return m + ':' + String(s).padStart(2, '0') + '.' + String(x).padStart(3, '0');
  };
  U.ordinal = (n) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  U.esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  U.now = () => performance.now();

  // localStorage wrappers — storage can throw (private mode, quota), never crash.
  U.store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
        return true;
      } catch (e) {
        return false;
      }
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch (e) {}
    },
  };

  U.deepClone = (o) => JSON.parse(JSON.stringify(o));

  // Tiny event emitter used by net + session layers.
  U.Emitter = class {
    constructor() {
      this._h = {};
    }
    on(ev, fn) {
      (this._h[ev] = this._h[ev] || []).push(fn);
      return () => this.off(ev, fn);
    }
    off(ev, fn) {
      const a = this._h[ev];
      if (a) this._h[ev] = a.filter((f) => f !== fn);
    }
    emit(ev, ...args) {
      const a = this._h[ev];
      if (a) for (const f of a.slice()) f(...args);
    }
  };

  G.U = U;
})(window.G);
