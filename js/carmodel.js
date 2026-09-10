// carmodel.js — low-poly cars built from lofted cross-sections, flat shaded,
// vertex-coloured (ONE shared material; body + 4 wheels = 5 draw calls a car).
//
// Detail is geometry, not textures: pillars, mirrors, door seams + handles,
// wheel arches, bumpers, skirts, diffuser, plates, wipers, antenna, exhaust
// tips, brake calipers (coloured by the brake part) behind spoked rims.
// Liveries (stripes, two-tone, roundels with 7-segment race numbers, checker
// roofs) are extra quads laid on the body surface. Installed parts are
// visible: wings, scoops, blowers, intercoolers, carbon panels, ride height,
// tyre width + compound ring, rally flaps, big exhausts, cooling ducts.
//
// Brake / reverse lights are a recorded vertex range in the body's colour
// buffer; setLights() rewrites just that range (updateRange) — no extra
// materials or draw calls for 8 cars' worth of brake lights.
'use strict';
(function (G) {
  const U = G.U;

  // Geometry builder: accumulates flat-shaded, vertex-coloured triangles. Every
  // face is wound outward by comparing its normal with an interior point, so we
  // never have to reason about winding by hand.
  class GB {
    constructor() {
      this.p = [];
      this.c = [];
    }
    get n() {
      return this.p.length / 3;
    }
    tri(a, b, c, col, ix, iy, iz) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const mx = (a[0] + b[0] + c[0]) / 3 - ix, my = (a[1] + b[1] + c[1]) / 3 - iy, mz = (a[2] + b[2] + c[2]) / 3 - iz;
      if (nx * mx + ny * my + nz * mz < 0) {
        const t = b; b = c; c = t;
      }
      this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      for (let i = 0; i < 3; i++) this.c.push(col.r, col.g, col.b);
    }
    quad(a, b, c, d, col, ix, iy, iz) {
      this.tri(a, b, c, col, ix, iy, iz);
      this.tri(a, c, d, col, ix, iy, iz);
    }
    // quad with an explicit outward normal
    quadN(a, b, c, d, col, n) {
      const mx = (a[0] + b[0] + c[0] + d[0]) / 4, my = (a[1] + b[1] + c[1] + d[1]) / 4, mz = (a[2] + b[2] + c[2] + d[2]) / 4;
      this.quad(a, b, c, d, col, mx - n[0], my - n[1], mz - n[2]);
    }
    // Axis-aligned box (optionally yaw-rotated about its centre).
    box(cx, cy, cz, sx, sy, sz, col, rotY) {
      const hx = sx / 2, hy = sy / 2, hz = sz / 2;
      const cr = Math.cos(rotY || 0), sr = Math.sin(rotY || 0);
      const P = (x, y, z) => [cx + x * cr + z * sr, cy + y, cz - x * sr + z * cr];
      const v = [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(-hx, hy, -hz), P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)];
      const f = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];
      for (const q of f) this.quad(v[q[0]], v[q[1]], v[q[2]], v[q[3]], col, cx, cy, cz);
    }
    // Beam between two points with a w (sideways) × h (up-ish) section.
    beam(a, b, w, h, col) {
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const L = Math.hypot(dx, dy, dz) || 1e-6;
      const f = [dx / L, dy / L, dz / L];
      const up = Math.abs(f[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      let r = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
      const rl = Math.hypot(r[0], r[1], r[2]) || 1;
      r = [r[0] / rl, r[1] / rl, r[2] / rl];
      const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
      const hw = w / 2, hh = h / 2;
      const P = (o, sr, su) => [o[0] + r[0] * sr * hw + u[0] * su * hh, o[1] + r[1] * sr * hw + u[1] * su * hh, o[2] + r[2] * sr * hw + u[2] * su * hh];
      const v = [P(a, -1, -1), P(a, 1, -1), P(a, 1, 1), P(a, -1, 1), P(b, -1, -1), P(b, 1, -1), P(b, 1, 1), P(b, -1, 1)];
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, cz = (a[2] + b[2]) / 2;
      const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];
      for (const q of faces) this.quad(v[q[0]], v[q[1]], v[q[2]], v[q[3]], col, cx, cy, cz);
    }
    // Flat n-gon at c in the plane (e1, e2), facing normal n.
    disc(c, e1, e2, n, r, k, col, a0) {
      const ix = c[0] - n[0], iy = c[1] - n[1], iz = c[2] - n[2];
      for (let i = 0; i < k; i++) {
        const t0 = (a0 || 0) + (i / k) * Math.PI * 2, t1 = (a0 || 0) + ((i + 1) / k) * Math.PI * 2;
        const p = (t) => [c[0] + (e1[0] * Math.cos(t) + e2[0] * Math.sin(t)) * r, c[1] + (e1[1] * Math.cos(t) + e2[1] * Math.sin(t)) * r, c[2] + (e1[2] * Math.cos(t) + e2[2] * Math.sin(t)) * r];
        this.tri(c, p(t0), p(t1), col, ix, iy, iz);
      }
    }
    // Cylinder along Z (exhaust tips): outer skin + dark bore.
    cylZ(cx, cy, cz, r, len, k, col, bore) {
      for (let i = 0; i < k; i++) {
        const a0 = (i / k) * Math.PI * 2, a1 = ((i + 1) / k) * Math.PI * 2;
        const p = (a, z) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z];
        this.quad(p(a0, cz - len / 2), p(a1, cz - len / 2), p(a1, cz + len / 2), p(a0, cz + len / 2), col, cx, cy, cz);
      }
      this.disc([cx, cy, cz - len / 2 - 0.001], [1, 0, 0], [0, 1, 0], [0, 0, -1], r * 0.75, k, bore);
    }
    // Lofted hull through hexagonal sections {z, yb, ym, yt, wb, wm, wt}.
    // colFn(e) picks the colour per edge: 0 bottom, 1/5 lower sides,
    // 2/4 upper sides, 3 top.
    loft(secs, col, colTop, skipBottom, colFn) {
      const ring = (s) => [[-s.wb, s.yb, s.z], [s.wb, s.yb, s.z], [s.wm, s.ym, s.z], [s.wt, s.yt, s.z], [-s.wt, s.yt, s.z], [-s.wm, s.ym, s.z]];
      const R = secs.map(ring);
      for (let k = 0; k < R.length - 1; k++) {
        const A = R[k], B = R[k + 1];
        const iz = (secs[k].z + secs[k + 1].z) / 2;
        const icy = (secs[k].yb + secs[k].yt + secs[k + 1].yb + secs[k + 1].yt) / 4;
        for (let e = 0; e < 6; e++) {
          if (skipBottom && e === 0) continue;
          const e2 = (e + 1) % 6;
          const c = colFn ? colFn(e) : e === 3 && colTop ? colTop : col;
          this.quad(A[e], A[e2], B[e2], B[e], c, 0, icy, iz);
        }
      }
      for (const [k, dir] of [[0, -1], [R.length - 1, 1]]) {
        const r = R[k];
        const ccy = (secs[k].yb + secs[k].yt) / 2;
        for (let e = 1; e < 5; e++) this.tri(r[0], r[e], r[e + 1], col, 0, ccy, secs[k].z - dir);
      }
    }
    // Four-sided loft (cabins, windscreens): {z, yb, yt, wb, wt}
    loft4(secs, col, colTop) {
      const ring = (s) => [[-s.wb, s.yb, s.z], [s.wb, s.yb, s.z], [s.wt, s.yt, s.z], [-s.wt, s.yt, s.z]];
      const R = secs.map(ring);
      for (let k = 0; k < R.length - 1; k++) {
        const A = R[k], B = R[k + 1];
        const iz = (secs[k].z + secs[k + 1].z) / 2;
        const iy = (secs[k].yb + secs[k + 1].yb) / 2 + 0.05;
        for (let e = 1; e < 4; e++) {
          const e2 = (e + 1) % 4;
          this.quad(A[e], A[e2], B[e2], B[e], e === 2 && colTop ? colTop : col, 0, iy, iz);
        }
      }
      for (const [k, dir] of [[0, -1], [R.length - 1, 1]]) {
        const r = R[k];
        const iy = (secs[k].yb + secs[k].yt) / 2;
        this.quad(r[0], r[1], r[2], r[3], col, 0, iy, secs[k].z - dir);
      }
    }
    // Wheel (axis X): tread with alternating block shades (so you can SEE it
    // spin), black sidewall with a compound-coloured ring, rim lip, and a rim
    // face in one of several styles. Spoked rims leave gaps showing the disc.
    wheel(radius, width, n, cols, style) {
      const hw = width / 2, R = radius;
      const tA = cols.tyre, tB = cols.tyre.clone().multiplyScalar(1.35);
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        const y0 = Math.cos(a0) * R, z0 = Math.sin(a0) * R, y1 = Math.cos(a1) * R, z1 = Math.sin(a1) * R;
        this.quad([-hw, y0, z0], [hw, y0, z0], [hw, y1, z1], [-hw, y1, z1], i % 2 ? tA : tB, 0, 0, 0);
      }
      const ring = (x, r0, r1, col, sx) => {
        for (let i = 0; i < n; i++) {
          const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
          const P = (r, a) => [x, Math.cos(a) * r, Math.sin(a) * r];
          this.quadN(P(r0, a0), P(r1, a0), P(r1, a1), P(r0, a1), col, [sx, 0, 0]);
        }
      };
      const rimDark = cols.rim.clone().multiplyScalar(0.55);
      for (const sx of [-1, 1]) {
        const x = sx * hw;
        ring(x, R * 0.8, R, cols.tyre, sx);
        ring(x * 1.002, R * 0.73, R * 0.8, cols.tyre, sx);
        ring(x * 1.004, R * 0.745, R * 0.775, cols.stripe, sx);
        ring(x * 1.0, R * 0.64, R * 0.73, cols.tyre, sx);
        ring(x * 1.01, R * 0.6, R * 0.64, cols.rim.clone().multiplyScalar(1.12), sx); // lip
        const fx = x * 0.9; // rim face slightly inset
        const nrm = [sx, 0, 0];
        const D = (r, a) => [fx, Math.cos(a) * r, Math.sin(a) * r];
        // brake disc behind the face
        this.disc([x * 0.35, 0, 0], [0, 1, 0], [0, 0, 1], nrm, R * 0.5, 10, cols.disc);
        if (style === 'dish' || style === 'rally' || style === 'turbine') {
          this.disc([fx, 0, 0], [0, 1, 0], [0, 0, 1], nrm, R * 0.6, n, style === 'turbine' ? rimDark : cols.rim);
          if (style === 'dish') {
            ring(fx * 1.002, R * 0.5, R * 0.58, rimDark, sx);
            for (let k = 0; k < 5; k++) {
              const a = (k / 5) * Math.PI * 2;
              this.disc([fx * 1.004, Math.cos(a) * R * 0.18, Math.sin(a) * R * 0.18], [0, 1, 0], [0, 0, 1], nrm, R * 0.035, 5, rimDark);
            }
          } else if (style === 'rally') {
            for (let k = 0; k < 8; k++) {
              const a = (k / 8) * Math.PI * 2;
              this.disc([fx * 1.004, Math.cos(a) * R * 0.4, Math.sin(a) * R * 0.4], [0, 1, 0], [0, 0, 1], nrm, R * 0.085, 6, cols.tyre);
            }
          } else {
            for (let k = 0; k < 12; k++) {
              const a = (k / 12) * Math.PI * 2;
              this.quadN(D(R * 0.16, a), D(R * 0.58, a + 0.18), D(R * 0.58, a + 0.36), D(R * 0.16, a + 0.12), cols.rim, nrm);
            }
          }
        } else {
          const k = style === 'mesh' ? 10 : 5;
          const w0 = style === 'mesh' ? 0.07 : 0.2, w1 = style === 'mesh' ? 0.05 : 0.13;
          for (let i = 0; i < k; i++) {
            const a = (i / k) * Math.PI * 2;
            this.quadN(D(R * 0.14, a - w0), D(R * 0.6, a - w1), D(R * 0.6, a + w1), D(R * 0.14, a + w0), cols.rim, nrm);
          }
          ring(fx, R * 0.55, R * 0.6, cols.rim, sx);
          if (style === 'mesh') ring(fx * 1.001, R * 0.3, R * 0.34, cols.rim, sx);
        }
        this.disc([fx * 1.01, 0, 0], [0, 1, 0], [0, 0, 1], nrm, R * 0.15, 6, cols.rim.clone().multiplyScalar(1.1)); // centre cap
      }
    }
    geometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
      g.computeVertexNormals(); // non-indexed => flat normals
      g.computeBoundingSphere();
      return g;
    }
  }

  const C = (hex) => new THREE.Color(hex);
  const PALETTE = [0xff3b30, 0x2f6bff, 0xffc400, 0x22c55e, 0xff2d92, 0x19c3e6, 0xff8a00, 0xa855f7];
  const COLOR_NAMES = ['Red', 'Blue', 'Yellow', 'Green', 'Pink', 'Cyan', 'Orange', 'Purple'];

  // Body section tables per body style (metres; z = forward, x = left, y = up).
  // doors: [front edge z, rear edge z]; mirrorZ: A-pillar base.
  const BODIES = {
    coupe: {
      body: [
        { z: -2.15, yb: 0.3, ym: 0.52, yt: 0.72, wb: 0.78, wm: 0.86, wt: 0.78 },
        { z: -1.95, yb: 0.24, ym: 0.55, yt: 0.84, wb: 0.82, wm: 0.93, wt: 0.84 },
        { z: -1.2, yb: 0.22, ym: 0.56, yt: 0.86, wb: 0.82, wm: 0.93, wt: 0.86 },
        { z: 0.7, yb: 0.22, ym: 0.55, yt: 0.84, wb: 0.82, wm: 0.93, wt: 0.84 },
        { z: 1.75, yb: 0.22, ym: 0.52, yt: 0.72, wb: 0.8, wm: 0.91, wt: 0.8 },
        { z: 2.15, yb: 0.26, ym: 0.44, yt: 0.56, wb: 0.76, wm: 0.85, wt: 0.7 },
      ],
      cabin: [
        { z: -1.5, yb: 0.84, yt: 0.95, wb: 0.8, wt: 0.66 },
        { z: -0.95, yb: 0.86, yt: 1.27, wb: 0.83, wt: 0.64 },
        { z: 0.05, yb: 0.86, yt: 1.29, wb: 0.83, wt: 0.64 },
        { z: 0.85, yb: 0.84, yt: 0.86, wb: 0.82, wt: 0.78 },
      ],
      roof: [-0.95, 0.05, 1.29], hood: [0.9, 2.0, 0.8], trunkZ: -1.8, trunkY: 0.85, wheelZ: [1.35, -1.25], doors: [0.72, -0.55],
    },
    hatch: {
      body: [
        { z: -2.0, yb: 0.3, ym: 0.56, yt: 0.86, wb: 0.78, wm: 0.88, wt: 0.8 },
        { z: -1.8, yb: 0.24, ym: 0.58, yt: 0.9, wb: 0.8, wm: 0.91, wt: 0.84 },
        { z: 0.6, yb: 0.24, ym: 0.58, yt: 0.9, wb: 0.8, wm: 0.91, wt: 0.84 },
        { z: 1.6, yb: 0.24, ym: 0.54, yt: 0.78, wb: 0.79, wm: 0.9, wt: 0.8 },
        { z: 2.0, yb: 0.28, ym: 0.46, yt: 0.62, wb: 0.75, wm: 0.84, wt: 0.7 },
      ],
      cabin: [
        { z: -1.98, yb: 0.88, yt: 1.3, wb: 0.82, wt: 0.66 },
        { z: -1.6, yb: 0.9, yt: 1.42, wb: 0.84, wt: 0.68 },
        { z: 0.2, yb: 0.9, yt: 1.42, wb: 0.84, wt: 0.68 },
        { z: 0.95, yb: 0.88, yt: 0.92, wb: 0.82, wt: 0.78 },
      ],
      roof: [-1.6, 0.2, 1.42], hood: [1.0, 1.9, 0.86], trunkZ: -1.95, trunkY: 1.3, wheelZ: [1.25, -1.25], doors: [0.8, -0.5],
    },
    roadster: {
      body: [
        { z: -1.95, yb: 0.28, ym: 0.48, yt: 0.66, wb: 0.74, wm: 0.84, wt: 0.74 },
        { z: -1.75, yb: 0.22, ym: 0.5, yt: 0.76, wb: 0.78, wm: 0.88, wt: 0.8 },
        { z: -0.9, yb: 0.2, ym: 0.5, yt: 0.76, wb: 0.78, wm: 0.88, wt: 0.8 },
        { z: 0.6, yb: 0.2, ym: 0.5, yt: 0.74, wb: 0.78, wm: 0.88, wt: 0.78 },
        { z: 1.6, yb: 0.2, ym: 0.46, yt: 0.64, wb: 0.76, wm: 0.86, wt: 0.72 },
        { z: 1.95, yb: 0.24, ym: 0.38, yt: 0.5, wb: 0.7, wm: 0.8, wt: 0.62 },
      ],
      cabin: [
        { z: 0.25, yb: 0.76, yt: 0.8, wb: 0.72, wt: 0.72 },
        { z: 0.45, yb: 0.76, yt: 1.08, wb: 0.72, wt: 0.66 },
        { z: 0.5, yb: 0.76, yt: 1.08, wb: 0.72, wt: 0.66 },
      ],
      cockpit: true, hood: [0.7, 1.8, 0.74], trunkZ: -1.6, trunkY: 0.77, wheelZ: [1.2, -1.2], doors: [0.3, -0.85],
    },
    muscle: {
      body: [
        { z: -2.38, yb: 0.3, ym: 0.56, yt: 0.8, wb: 0.84, wm: 0.94, wt: 0.86 },
        { z: -2.2, yb: 0.24, ym: 0.6, yt: 0.9, wb: 0.86, wm: 0.98, wt: 0.92 },
        { z: 0.4, yb: 0.24, ym: 0.62, yt: 0.92, wb: 0.86, wm: 0.98, wt: 0.92 },
        { z: 1.9, yb: 0.24, ym: 0.62, yt: 0.9, wb: 0.86, wm: 0.98, wt: 0.9 },
        { z: 2.38, yb: 0.28, ym: 0.56, yt: 0.78, wb: 0.84, wm: 0.94, wt: 0.84 },
      ],
      cabin: [
        { z: -1.95, yb: 0.9, yt: 0.96, wb: 0.86, wt: 0.72 },
        { z: -0.95, yb: 0.92, yt: 1.33, wb: 0.88, wt: 0.68 },
        { z: 0.0, yb: 0.92, yt: 1.34, wb: 0.88, wt: 0.68 },
        { z: 0.7, yb: 0.9, yt: 0.94, wb: 0.86, wt: 0.82 },
      ],
      roof: [-0.95, 0.0, 1.34], hood: [0.75, 2.3, 0.92], trunkZ: -2.05, trunkY: 0.93, wheelZ: [1.5, -1.4], doors: [0.6, -0.8],
    },
  };

  function lighten(hex, k) {
    const c = new THREE.Color(hex);
    const hsl = {};
    c.getHSL(hsl);
    c.setHSL(hsl.h, hsl.s, U.clamp(hsl.l + k, 0, 1));
    return c;
  }

  // 7-segment digits: race numbers built from quads (no textures).
  const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd' };
  function digit(gb, d, o, eu, ev, n, w, h, t, col) {
    const hw = w / 2, hh = h / 2;
    const S = { a: [[-hw, hh], [hw, hh]], b: [[hw, hh], [hw, 0]], c: [[hw, 0], [hw, -hh]], d: [[-hw, -hh], [hw, -hh]], e: [[-hw, 0], [-hw, -hh]], f: [[-hw, hh], [-hw, 0]], g: [[-hw, 0], [hw, 0]] };
    const P = (u, v, lift) => [o[0] + eu[0] * u + ev[0] * v + n[0] * lift, o[1] + eu[1] * u + ev[1] * v + n[1] * lift, o[2] + eu[2] * u + ev[2] * v + n[2] * lift];
    for (const s of SEG[d] || '') {
      const [p, q] = S[s];
      const du = q[0] - p[0], dv = q[1] - p[1];
      const l = Math.hypot(du, dv) || 1;
      const tu = (du / l) * t * 0.5, tv = (dv / l) * t * 0.5, nu = -tv, nv = tu;
      gb.quadN(P(p[0] - tu + nu, p[1] - tv + nv, 0.004), P(p[0] - tu - nu, p[1] - tv - nv, 0.004), P(q[0] + tu - nu, q[1] + tv - nv, 0.004), P(q[0] + tu + nu, q[1] + tv + nv, 0.004), col, n);
    }
  }
  function roundel(gb, num, c, eu, ev, n, size, white, black) {
    gb.disc([c[0] + n[0] * 0.002, c[1] + n[1] * 0.002, c[2] + n[2] * 0.002], eu, ev, n, size, 8, white, Math.PI / 8);
    const s = String(num);
    const w = size * (s.length > 1 ? 0.42 : 0.5), h = size * 1.05, t = size * 0.16;
    const gap = w * 1.45;
    for (let i = 0; i < s.length; i++) {
      const off = (i - (s.length - 1) / 2) * gap;
      digit(gb, +s[i], [c[0] + eu[0] * off, c[1] + eu[1] * off, c[2] + eu[2] * off], eu, ev, n, w, h, t, black);
    }
  }

  // Interpolated body section at z.
  function secAt(B, z) {
    const S = B.body;
    if (z <= S[0].z) return S[0];
    for (let k = 0; k < S.length - 1; k++) {
      const a = S[k], b = S[k + 1];
      if (z <= b.z) {
        const t = (z - a.z) / (b.z - a.z);
        const o = { z };
        for (const f of ['yb', 'ym', 'yt', 'wb', 'wm', 'wt']) o[f] = U.lerp(a[f], b[f], t);
        return o;
      }
    }
    return S[S.length - 1];
  }
  // Half-width of the body surface at height y in a section.
  function surfX(s, y) {
    if (y <= s.ym) return U.lerp(s.wb, s.wm, U.clamp((y - s.yb) / (s.ym - s.yb), 0, 1));
    return U.lerp(s.wm, s.wt, U.clamp((y - s.ym) / (s.yt - s.ym), 0, 1));
  }

  // Build a car. Returns an object the World animates.
  //   parts = installed map, look = appearance (Parts.defaultLook shape),
  //   tune = setup (only ride height + roll stiffness are visible).
  function build(carId, colorHex, parts, look, tune) {
    const car = G.Parts.CARS[carId] || G.Parts.CARS.vandal;
    const P = Object.assign({}, G.Parts.STOCK, parts || {});
    const L = Object.assign(G.Parts.defaultLook(), look || {});
    const T = G.Parts.effTune(P, tune);
    const B = BODIES[car.body];
    const paint = L.paint != null ? L.paint : colorHex;
    const body = C(paint), bodyTop = lighten(paint, 0.05);
    const acc = C(L.accent);
    const dark = C(0x1b1f27), black = C(0x121418), chrome = C(0xd5dbe2), carbon = C(0x2a2d33), white = C(0xf4f4f4), rubber = C(0x16181d);
    const glass = C(L.tint === 'clear' ? 0x6f8fae : L.tint === 'black' ? 0x0c0f14 : 0x243447);
    const light = C(0xfff4c2);
    const su = G.Parts.opt('suspension', P.suspension);
    const rideH = su.rideH + T.rideH * 0.01;
    const gb = new GB();
    const S = B.body, cab = B.cabin;
    const fz = S[S.length - 1].z, rz = S[0].z;
    const fS = S[S.length - 1], rS = S[0];
    const fy = (fS.ym + fS.yt) / 2, ry = (rS.ym + rS.yt) / 2;
    const carbonHood = P.weight === 'w2' || P.weight === 'w3';

    // ---- hull + cabin
    const two = L.livery === 'twotone';
    gb.loft(S, body, bodyTop, false, (e) => (e === 3 ? bodyTop : (e === 1 || e === 5) && two ? acc : e === 0 ? dark : body));
    gb.loft4(cab, glass);
    const pillar = L.livery === 'roof' ? acc : body;
    const c0 = cab[0], cN = cab[cab.length - 1];
    if (B.roof) {
      const [z0, z1, y] = B.roof;
      const w = cab[1].wt * 2 + 0.02;
      const roofCol = P.weight === 'w3' ? carbon : L.livery === 'roof' || L.livery === 'checker' ? acc : body;
      gb.box(0, y + 0.025, (z0 + z1) / 2, w, 0.05, z1 - z0 + 0.06, roofCol);
      if (L.livery === 'checker') {
        const nx = 6, nz = 7;
        for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
          if ((i + k) % 2) continue;
          const x0 = -w / 2 + (i * w) / nx, zz = z0 + (k * (z1 - z0)) / nz;
          gb.quadN([x0, y + 0.052, zz], [x0 + w / nx, y + 0.052, zz], [x0 + w / nx, y + 0.052, zz + (z1 - z0) / nz], [x0, y + 0.052, zz + (z1 - z0) / nz], black, [0, 1, 0]);
        }
      }
      // pillars: A (windscreen edges), C (rear window edges), B (door frame)
      const ci = cab.length - 1;
      for (const sx of [-1, 1]) {
        gb.beam([sx * (cab[ci].wt - 0.02), cab[ci].yt, cab[ci].z], [sx * (cab[ci - 1].wt - 0.02), cab[ci - 1].yt, cab[ci - 1].z], 0.08, 0.06, pillar);
        gb.beam([sx * (cab[0].wt - 0.02), cab[0].yt, cab[0].z], [sx * (cab[1].wt - 0.02), cab[1].yt, cab[1].z], 0.1, 0.06, pillar);
        const zb = B.doors[1];
        gb.beam([sx * (cab[1].wb + 0.005), cab[1].yb + 0.02, zb], [sx * (cab[1].wt + 0.005), cab[1].yt - 0.02, zb], 0.09, 0.04, pillar === body ? dark : pillar);
        // chrome belt line along the window base
        gb.beam([sx * (c0.wb + 0.01), c0.yb + 0.01, c0.z + 0.08], [sx * (cN.wb + 0.01), cN.yb + 0.01, cN.z - 0.05], 0.025, 0.025, chrome);
      }
      // antenna
      if (car.body !== 'roadster') gb.beam([-0.35, y + 0.05, z0 + 0.12], [-0.35, y + 0.45, z0 - 0.02], 0.015, 0.015, black);
    }
    if (B.cockpit) {
      gb.box(0, 0.74, -0.45, 1.2, 0.08, 1.2, dark);
      gb.box(0.3, 0.8, -0.3, 0.42, 0.14, 0.4, C(0x3a2a22)); // seats
      gb.box(-0.3, 0.8, -0.3, 0.42, 0.14, 0.4, C(0x3a2a22));
      gb.box(0.3, 0.95, -0.5, 0.42, 0.3, 0.08, C(0x3a2a22));
      gb.box(-0.3, 0.95, -0.5, 0.42, 0.3, 0.08, C(0x3a2a22));
      gb.box(0.3, 0.92, 0.12, 0.3, 0.05, 0.05, black); // steering wheel
      gb.beam([0.36, 0.76, -0.8], [0.36, 1.18, -0.82], 0.07, 0.07, chrome); // roll hoops
      gb.beam([-0.36, 0.76, -0.8], [-0.36, 1.18, -0.82], 0.07, 0.07, chrome);
      gb.beam([0.36, 1.18, -0.82], [-0.36, 1.18, -0.82], 0.07, 0.07, chrome);
      for (const sx of [-1, 1]) gb.beam([sx * cab[0].wt, cab[0].yt, cab[0].z], [sx * cab[1].wt, cab[1].yt, cab[1].z], 0.05, 0.04, dark);
      gb.beam([cab[1].wt, cab[1].yt, cab[1].z], [-cab[1].wt, cab[1].yt, cab[1].z], 0.04, 0.05, dark);
    }
    // wipers at the windscreen base
    for (const sx of [0.25, -0.2]) gb.beam([sx - 0.25, cN.yb + 0.04, cN.z - 0.08], [sx + 0.2, cN.yb + 0.08, cN.z - 0.2], 0.03, 0.02, black);

    // ---- top surface bands (stripes / carbon hood) following the body
    const topY = (z) => secAt(B, z).yt;
    const band = (z0, z1, x0, x1, col, lift) => {
      if (z1 - z0 < 0.05) return;
      const zs = [z0];
      for (const s of S) if (s.z > z0 && s.z < z1) zs.push(s.z);
      zs.push(z1);
      for (let i = 0; i < zs.length - 1; i++) {
        const za = zs[i], zb = zs[i + 1];
        const ya = topY(za) + (lift || 0.007), yb = topY(zb) + (lift || 0.007);
        gb.quadN([x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb], col, [0, 1, 0]);
      }
    };
    const hoodZ0 = B.cockpit ? cab[cab.length - 1].z + 0.05 : cN.z + 0.02;
    const zones = [[hoodZ0, fz - 0.04]];
    if (B.cockpit) zones.push([rz + 0.05, -1.08]);
    else if (c0.z - rz > 0.2) zones.push([rz + 0.05, c0.z - 0.02]);
    if (carbonHood) band(zones[0][0], zones[0][1], -0.62, 0.62, carbon, 0.005);
    const stripes = L.livery === 'stripes' || L.livery === 'race' ? [[0.09, 0.25], [-0.25, -0.09]] : L.livery === 'single' ? [[-0.2, 0.2]] : [];
    for (const [x0, x1] of stripes) {
      for (const [z0, z1] of zones) band(z0, z1, x0, x1, acc, 0.009);
      if (B.roof) {
        const [rz0, rz1, ry0] = B.roof;
        if (L.livery !== 'checker') gb.quadN([x0, ry0 + 0.052, rz0 - 0.03], [x1, ry0 + 0.052, rz0 - 0.03], [x1, ry0 + 0.052, rz1 + 0.03], [x0, ry0 + 0.052, rz1 + 0.03], acc, [0, 1, 0]);
      }
    }

    // ---- side detail: skirts, side stripe, door seams, handles, roundels
    const sideBand = (y0, y1, col, zmin, zmax, lift) => {
      const zs = [zmin];
      for (const s of S) if (s.z > zmin && s.z < zmax) zs.push(s.z);
      zs.push(zmax);
      for (const sx of [-1, 1]) {
        for (let i = 0; i < zs.length - 1; i++) {
          const A = secAt(B, zs[i]), Bq = secAt(B, zs[i + 1]);
          const o = lift || 0.006;
          const p = (s, y) => [sx * (surfX(s, y) + o), y, s.z];
          gb.quadN(p(A, y0), p(Bq, y0), p(Bq, y1), p(A, y1), col, [sx, 0, 0]);
        }
      }
    };
    const midS = secAt(B, 0);
    sideBand(midS.yb + 0.005, midS.yb + 0.075, dark, rz + 0.25, fz - 0.3); // skirts
    if (L.livery === 'side' || L.livery === 'race') {
      // runs between the wheel arches, like the real thing
      const [wf, wr] = B.wheelZ;
      for (const [a, b] of [[rz + 0.1, wr - 0.47], [wr + 0.47, wf - 0.47], [wf + 0.47, fz - 0.1]]) if (b - a > 0.1) sideBand(midS.ym + 0.03, midS.ym + (L.livery === 'side' ? 0.13 : 0.07), acc, a, b, 0.008);
    }
    const [dzF, dzR] = B.doors;
    const seam = (z) => {
      const s = secAt(B, z);
      for (const sx of [-1, 1]) {
        const p = (y, dz) => [sx * (surfX(s, y) + 0.005), y, z + dz];
        const ya = s.yb + 0.09, ym = s.ym, yt = s.yt - 0.03;
        gb.quadN(p(ya, -0.012), p(ya, 0.012), p(ym, 0.012), p(ym, -0.012), dark, [sx, 0, 0]);
        gb.quadN(p(ym, -0.012), p(ym, 0.012), p(yt, 0.012), p(yt, -0.012), dark, [sx, 0, 0]);
      }
    };
    seam(dzF);
    seam(dzR);
    const hs = secAt(B, dzR + 0.18);
    for (const sx of [-1, 1]) gb.box(sx * (surfX(hs, hs.ym + 0.09) + 0.012), hs.ym + 0.09, dzR + 0.2, 0.03, 0.035, 0.16, dark);
    if ((L.livery === 'race' || L.livery === 'side') && L.num > 0) {
      const zc = (dzF + dzR) / 2 + (car.body === 'roadster' ? 0.05 : 0);
      const s = secAt(B, zc);
      const yc = s.ym + 0.03;
      const size = Math.min(0.24, (s.yt - s.yb) * 0.42);
      roundel(gb, L.num, [surfX(s, yc) + 0.012, yc, zc], [0, 0, -1], [0, 1, 0], [1, 0, 0], size, white, black);
      roundel(gb, L.num, [-(surfX(s, yc) + 0.012), yc, zc], [0, 0, 1], [0, 1, 0], [-1, 0, 0], size, white, black);
    }
    if (L.livery === 'race' && L.num > 0) {
      if (B.roof) roundel(gb, L.num, [0, B.roof[2] + 0.056, (B.roof[0] + B.roof[1]) / 2], [-1, 0, 0], [0, 0, 1], [0, 1, 0], 0.3, white, black);
      else roundel(gb, L.num, [0, topY(1.2) + 0.012, 1.25], [-1, 0, 0], [0, 0, 1], [0, 1, 0], 0.26, white, black);
    }

    // ---- mirrors
    const mz = (B.cockpit ? cab[0].z : cN.z) - 0.1;
    const ms = secAt(B, mz);
    for (const sx of [-1, 1]) {
      const mx = sx * (surfX(ms, ms.yt) + 0.1);
      gb.beam([sx * (surfX(ms, ms.yt) - 0.02), ms.yt + 0.06, mz], [mx, ms.yt + 0.1, mz - 0.02], 0.04, 0.03, dark);
      gb.box(mx + sx * 0.03, ms.yt + 0.13, mz - 0.03, 0.14, 0.1, 0.08, L.livery === 'roof' ? acc : body);
      gb.box(mx + sx * 0.03, ms.yt + 0.13, mz - 0.075, 0.12, 0.08, 0.01, C(0x9fb4c8));
    }

    // ---- nose + tail
    const grilleW = car.body === 'muscle' ? 1.2 : 0.9;
    gb.box(0, fy - 0.14, fz - 0.025, grilleW, 0.15, 0.06, dark);
    for (let k = 0; k < 3; k++) gb.box(0, fy - 0.19 + k * 0.05, fz + 0.008, grilleW - 0.06, 0.012, 0.02, car.body === 'muscle' ? chrome : carbon);
    gb.box(0, fS.yb + 0.07, fz - 0.03, fS.wb * 2 - 0.1, 0.12, 0.08, dark); // lower bumper
    gb.box(0, fS.yb + 0.16, fz + 0.012, 0.44, 0.1, 0.02, white); // plate
    gb.box(0, fS.yb + 0.16, fz + 0.018, 0.4, 0.06, 0.01, C(0xc9d2dc));
    // headlights: bezel + lens + DRL strip
    const hlX = car.body === 'hatch' || car.body === 'muscle' ? 0.6 : 0.56;
    for (const sx of [-1, 1]) {
      gb.box(sx * hlX, fy + 0.01, fz - 0.03, 0.4, 0.14, 0.06, dark);
      gb.box(sx * hlX, fy + 0.01, fz - 0.01, 0.34, 0.1, 0.05, light);
      gb.box(sx * (hlX + 0.02), fy - 0.045, fz - 0.005, 0.28, 0.018, 0.04, white);
    }
    // rear: diffuser + fins, plate, exhaust tips, tail lights (dynamic range)
    gb.box(0, rS.yb + 0.06, rz + 0.02, rS.wb * 2 - 0.2, 0.1, 0.1, dark);
    for (const x of [-0.3, 0, 0.3]) gb.box(x, rS.yb + 0.03, rz + 0.05, 0.02, 0.09, 0.14, black);
    gb.box(0, ry - 0.14, rz - 0.012, 0.44, 0.1, 0.02, white);
    gb.box(0, ry - 0.14, rz - 0.018, 0.4, 0.06, 0.01, C(0xc9d2dc));
    const exKind = P.exhaust;
    const exR = (P.induction === 't2' ? 0.075 : P.induction === 'na' ? 0.045 : 0.06) + (exKind === 'straight' ? 0.03 : exKind === 'sport' ? 0.012 : 0);
    const exY = rS.yb + 0.08;
    const exXs = car.body === 'muscle' || P.induction !== 'na' || exKind !== 'stock' ? [0.45, -0.45] : [0.45];
    if (exKind === 'straight' && car.body !== 'muscle') exXs.splice(0, exXs.length, 0.12, -0.12); // centre-exit
    for (const x of exXs) gb.cylZ(x, exY, rz - 0.06, exR, 0.2, 8, chrome, black);
    const tailStart = gb.n;
    for (const sx of [-1, 1]) {
      gb.box(sx * 0.56, ry, rz + 0.02, 0.42, 0.12, 0.06, C(0x8a1010));
      if (car.body === 'muscle') gb.box(sx * 0.2, ry, rz + 0.02, 0.2, 0.1, 0.06, C(0x8a1010));
    }
    const tailEnd = gb.n;
    const revStart = gb.n;
    for (const sx of [-1, 1]) gb.box(sx * 0.34, ry, rz + 0.01, 0.08, 0.08, 0.06, C(0x9a9a9a));
    const revEnd = gb.n;
    gb.box(0, ry, rz + 0.005, 0.1, 0.06, 0.04, dark); // badge

    // ---- wheel arches (dark rings on the body side above each wheel)
    const tw = G.Parts.opt('width', P.width).vis;
    const wheelX = car.track / 2 + 0.06 + (tw - 1) * 0.08;
    const wheelY = 0.33 - rideH; // wheel centre in body space
    for (const wz of B.wheelZ) {
      for (const sx of [-1, 1]) {
        const K = 9;
        for (let k = 0; k < K; k++) {
          const a0 = 0.15 + (k / K) * (Math.PI - 0.3), a1 = 0.15 + ((k + 1) / K) * (Math.PI - 0.3);
          const pt = (r, a) => {
            const y = wheelY + Math.sin(a) * r, z = wz + Math.cos(a) * r;
            return [sx * (surfX(secAt(B, z), Math.max(y, secAt(B, z).yb)) + 0.004), y, z];
          };
          gb.quadN(pt(0.34, a0), pt(0.44, a0), pt(0.44, a1), pt(0.34, a1), rubber, [sx, 0, 0]);
        }
        // brake caliper, visible through the spokes
        const bc = G.Parts.opt('brakes', P.brakes).caliper;
        gb.box(sx * (wheelX + 0.02), wheelY + 0.12, wz - 0.07, 0.07, 0.15, 0.13, C(bc));
      }
    }
    // fuel cap
    const fcz = (B.wheelZ[1] + rz) / 2 + 0.1, fcs = secAt(B, fcz);
    gb.disc([-(surfX(fcs, fcs.ym + 0.12) + 0.006), fcs.ym + 0.12, fcz], [0, 1, 0], [0, 0, 1], [-1, 0, 0], 0.07, 8, dark);

    // ---- induction visuals
    const [hz0, hz1, hy] = B.hood;
    const hoodTop = (z) => topY(z);
    if (P.induction === 'sc') {
      const z = hz0 + 0.45, y = hoodTop(z);
      gb.box(0, y + 0.14, z, 0.46, 0.26, 0.6, chrome);
      gb.box(0, y + 0.3, z, 0.36, 0.08, 0.32, black);
      for (const x of [-0.12, 0, 0.12]) gb.box(x, y + 0.37, z, 0.08, 0.06, 0.28, chrome); // injector hats
    } else if (P.induction === 't1') {
      const z = (hz0 + hz1) / 2;
      gb.box(0, hoodTop(z) + 0.04, z, 0.6, 0.06, 0.5, black);
      for (let k = 0; k < 4; k++) gb.box(0, hoodTop(z) + 0.075, z - 0.18 + k * 0.12, 0.5, 0.012, 0.03, carbon);
    } else if (P.induction === 't2') {
      const z = (hz0 + hz1) / 2 - 0.1;
      gb.box(0, hoodTop(z) + 0.11, z, 0.7, 0.2, 0.9, carbonHood ? carbon : body);
      gb.box(0, hoodTop(z) + 0.15, z + 0.46, 0.56, 0.12, 0.05, black);
      gb.box(0, fy - 0.12, fz + 0.03, 1.1, 0.2, 0.06, chrome); // intercooler
      for (let k = 0; k < 5; k++) gb.box(0, fy - 0.2 + k * 0.04, fz + 0.065, 1.04, 0.01, 0.01, dark);
    }
    if (P.cooling === 'race') {
      gb.box(0, fS.yb + 0.1, fz + 0.02, 1.2, 0.1, 0.05, black); // big duct
      for (const sx of [-1, 1]) gb.box(sx * 0.3, hoodTop(hz1 - 0.3) + 0.02, hz1 - 0.3, 0.3, 0.03, 0.35, black); // hood vents
    } else if (P.cooling === 'radiator') gb.box(0, fS.yb + 0.1, fz + 0.015, 0.8, 0.08, 0.04, carbon);
    if (P.ecu === 'stage2') for (const sx of [-1, 1]) gb.box(sx * 0.55, hoodTop(hz0 + 0.3) + 0.015, hz0 + 0.3, 0.14, 0.02, 0.3, black); // hood pins

    // ---- aero visuals
    const ty = B.trunkY, tz = B.trunkZ;
    if (P.aero === 'a1') {
      gb.box(0, ty + 0.06, tz, 1.5, 0.05, 0.28, body);
      gb.box(0, fS.yb - 0.02, fz - 0.1, 1.55, 0.04, 0.25, black);
    } else if (P.aero === 'a2' || P.aero === 'a3') {
      const big = P.aero === 'a3';
      const wy = ty + (big ? 0.55 : 0.4);
      const ww = big ? 1.95 : 1.65;
      // wing element, pitched by the Wing angle setup (trailing edge rises)
      const tilt = 0.08 + (T.wing - 5) * 0.045;
      gb.beam([0.5, ty, tz - 0.02], [0.5, wy, tz - 0.08], 0.05, 0.14, black);
      gb.beam([-0.5, ty, tz - 0.02], [-0.5, wy, tz - 0.08], 0.05, 0.14, black);
      const chord = big ? 0.55 : 0.42, th = 0.05, zc = tz - 0.08;
      const wcol = big ? carbon : L.livery === 'none' ? body : acc;
      const Wp = (x, zf, yo) => [x, wy + yo + tilt * (zc - zf), zf];
      const wv = [];
      for (const x of [ww / 2, -ww / 2]) for (const zf of [zc + chord / 2, zc - chord / 2]) for (const yo of [-th / 2, th / 2]) wv.push(Wp(x, zf, yo));
      for (const q of [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]]) gb.quad(wv[q[0]], wv[q[1]], wv[q[2]], wv[q[3]], wcol, 0, wy, zc);
      gb.box(ww / 2, wy + 0.08, tz - 0.08, 0.04, 0.26, 0.6, black);
      gb.box(-ww / 2, wy + 0.08, tz - 0.08, 0.04, 0.26, 0.6, black);
      gb.box(0, fS.yb - 0.03, fz - 0.05, big ? 1.9 : 1.6, 0.04, big ? 0.45 : 0.3, black);
      if (big) {
        gb.box(0.96, 0.22, 0, 0.1, 0.12, car.len * 0.55, carbon);
        gb.box(-0.96, 0.22, 0, 0.1, 0.12, car.len * 0.55, carbon);
        gb.box(0.85, fy - 0.05, fz - 0.25, 0.3, 0.03, 0.2, carbon, 0.4);
        gb.box(-0.85, fy - 0.05, fz - 0.25, 0.3, 0.03, 0.2, carbon, -0.4);
      }
    }
    // ---- wide tyres get fender flares; rally gets mud flaps + light pod
    if (P.width === 'wide') {
      for (const wz of B.wheelZ) for (const sx of [-1, 1]) gb.box(sx * (wheelX + 0.06), 0.62 - rideH, wz, 0.18, 0.1, 0.95, black);
    }
    if (P.suspension === 'rally') {
      for (const sx of [-1, 1]) gb.box(sx * wheelX, 0.28, B.wheelZ[1] - 0.45, 0.3, 0.34, 0.03, black);
      gb.box(0, fy + 0.02, fz + 0.06, 0.9, 0.14, 0.06, black);
      for (const lx of [-0.3, -0.1, 0.1, 0.3]) gb.box(lx, fy + 0.02, fz + 0.1, 0.14, 0.1, 0.03, light);
    }
    if (P.weight !== 'stock') gb.box(0.3, fS.yb + 0.05, fz + 0.02, 0.06, 0.12, 0.06, C(0xff3030)); // tow strap

    const mat = G.CarModel.material();
    const geo = gb.geometry();
    const bodyMesh = new THREE.Mesh(geo, mat);
    bodyMesh.castShadow = true;

    // ---- wheels (geometry cached per look: width, compound, rim style/colour)
    const comp = G.Parts.opt('compound', P.compound);
    const wkey = [tw, comp.stripe, L.rims, L.rimCol].join('|');
    let wgeo = _wheelCache[wkey];
    if (!wgeo) {
      const wgb = new GB();
      wgb.wheel(0.33, 0.27 * tw, 12, { tyre: C(0x1c1d21), rim: C(L.rimCol), stripe: C(comp.stripe), disc: C(0x8d9299) }, L.rims);
      wgeo = _wheelCache[wkey] = wgb.geometry();
      wgeo.userData.shared = true;
    }
    const root = new THREE.Group();
    const tilt = new THREE.Group(); // track banking tilt
    root.add(tilt);
    const pivot = new THREE.Group(); // body roll/pitch pivot at CG height
    pivot.position.y = 0.5;
    bodyMesh.position.y = -0.5 + rideH;
    pivot.add(bodyMesh);
    tilt.add(pivot);
    // One InstancedMesh for all four wheels (1 draw call instead of 4, and 1
    // instead of 4 in the shadow pass): world.updateCar writes the matrices.
    const zs = [B.wheelZ[0], B.wheelZ[0], B.wheelZ[1], B.wheelZ[1]];
    const xs = [wheelX, -wheelX, wheelX, -wheelX];
    const wheelMesh = new THREE.InstancedMesh(wgeo, mat, 4);
    wheelMesh.castShadow = true;
    wheelMesh.frustumCulled = false; // instance bounds aren't tracked; 4 wheels are cheap
    const wheelDummy = new THREE.Object3D();
    const wheels = [];
    for (let i = 0; i < 4; i++) {
      wheels.push({ x: xs[i], z: zs[i], spin: 0 });
      wheelDummy.position.set(xs[i], 0.33, zs[i]);
      wheelDummy.updateMatrix();
      wheelMesh.setMatrixAt(i, wheelDummy.matrix);
    }
    tilt.add(wheelMesh);
    const exhaust = exXs.map((x) => [x, exY + rideH, rz - 0.18]);
    return {
      root, tilt, pivot, body: bodyMesh, wheels, wheelMesh, wheelDummy, carId, color: paint,
      exhaust,
      wheelLocal: xs.map((x, i) => [x, zs[i]]),
      tailLocal: [[0.56, ry + rideH, rz - 0.05], [-0.56, ry + rideH, rz - 0.05]],
      tail: { s: tailStart, e: tailEnd, rs: revStart, re: revEnd, on: 0, rev: 0 },
      glow: G.Parts.GLOW_COL[L.glow] || 0,
      len: car.len, rollGain: su.roll * (1 - 0.035 * (T.arbF + T.arbR - 10)),
      // visual suspension springs
      roll: 0, rollV: 0, pitch: 0, pitchV: 0, heave: 0, spinA: 0,
    };
  }
  const _wheelCache = {};

  // Brake (0/1) and reverse (0/1) lights: rewrite only those vertices.
  // (THREE.Color converts hex to the linear values stored in the buffer.)
  let LC = null;
  function setLights(model, brake, rev) {
    const t = model.tail;
    if (t.on === brake && t.rev === rev) return;
    if (!LC) LC = { dim: C(0x8a1010), on: C(0xff3020), rdim: C(0x9a9a9a), ron: C(0xffffff) };
    const col = model.body.geometry.attributes.color;
    const a = col.array;
    if (t.on !== brake) {
      const c = brake ? LC.on : LC.dim;
      for (let i = t.s; i < t.e; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    }
    if (t.rev !== rev) {
      const c = rev ? LC.ron : LC.rdim;
      for (let i = t.rs; i < t.re; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    }
    t.on = brake;
    t.rev = rev;
    col.updateRange.offset = t.s * 3;
    col.updateRange.count = (t.re - t.s) * 3;
    col.needsUpdate = true;
  }

  function dispose(model) {
    model.body.geometry.dispose();
    // wheel geometry is shared via _wheelCache — kept alive for reuse
  }

  let _mat = null;
  G.CarModel = {
    GB, PALETTE, COLOR_NAMES, BODIES, build, dispose, lighten, setLights, digit,
    material() {
      if (!_mat) _mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      return _mat;
    },
  };
})(window.G);
