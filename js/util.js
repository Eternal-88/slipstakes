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
