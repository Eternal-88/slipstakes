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
    loft(secs, col, colTop, skipBottom, colFn, holeZ) {
      const ring = (s) => [[-s.wb, s.yb, s.z], [s.wb, s.yb, s.z], [s.wm, s.ym, s.z], [s.wt, s.yt, s.z], [-s.wt, s.yt, s.z], [-s.wm, s.ym, s.z]];
      const R = secs.map(ring);
      for (let k = 0; k < R.length - 1; k++) {
        const A = R[k], B = R[k + 1];
        const iz = (secs[k].z + secs[k + 1].z) / 2;
        const icy = (secs[k].yb + secs[k].yt + secs[k + 1].yb + secs[k + 1].yt) / 4;
        // holeZ leaves the TOP face out over a span: that is how an open
        // cockpit is cut into the shell. Anything else and the interior has
        // to be stacked on the deck, where it reads as luggage.
        const opened = holeZ && iz > holeZ[0] && iz < holeZ[1];
        for (let e = 0; e < 6; e++) {
          if (skipBottom && e === 0) continue;
          if (opened && e === 3) continue;
          const e2 = (e + 1) % 6;
          const c = colFn ? colFn(e, k) : e === 3 && colTop ? colTop : col;
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
    // faceCol(e, k), optional: the colour of face e (1 right, 2 top, 3 left)
    // of segment k, or null to leave it out, or {split: [f, outer, inner]}
    // to lay the top face in three strips - the middle f of its width in
    // `inner` - so a window can sit IN a panel rather than on top of it.
    loft4(secs, col, colTop, faceCol) {
      const ring = (s) => [[-s.wb, s.yb, s.z], [s.wb, s.yb, s.z], [s.wt, s.yt, s.z], [-s.wt, s.yt, s.z]];
      const R = secs.map(ring);
      const mix = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
      for (let k = 0; k < R.length - 1; k++) {
        const A = R[k], B = R[k + 1];
        const iz = (secs[k].z + secs[k + 1].z) / 2;
        const iy = (secs[k].yb + secs[k + 1].yb) / 2 + 0.05;
        for (let e = 1; e < 4; e++) {
          const e2 = (e + 1) % 4;
          let c = e === 2 && colTop ? colTop : col;
          const f = faceCol ? faceCol(e, k) : undefined;
          if (f === null) continue;
          if (f && f.split) {
            const t0 = (1 - f.split[0]) / 2, t1 = 1 - t0;
            const ra = mix(A[e], A[e2], t0), la = mix(A[e], A[e2], t1), rb = mix(B[e], B[e2], t0), lb = mix(B[e], B[e2], t1);
            this.quad(A[e], ra, rb, B[e], f.split[1], 0, iy, iz);
            this.quad(ra, la, lb, rb, f.split[2], 0, iy, iz);
            this.quad(la, A[e2], B[e2], lb, f.split[1], 0, iy, iz);
            continue;
          }
          if (f) c = f;
          this.quad(A[e], A[e2], B[e2], B[e], c, 0, iy, iz);
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
      const lip = cols.rim.clone().multiplyScalar(1.12);
      for (const sx of [-1, 1]) {
        // Every layer sits at an ABSOLUTE offset, millimetres apart, and
        // layers never share a plane where they overlap. (The old x*1.002 /
        // x*1.004 layers were a fraction of a millimetre apart and flickered:
        // z-fighting on the tyre stripe and rims.)
        const o = (d) => sx * (hw + d);
        ring(o(0), R * 0.64, R, cols.tyre, sx); // sidewall
        ring(o(0.006), R * 0.745, R * 0.775, cols.stripe, sx); // compound ring, 6 mm proud
        ring(o(0.004), R * 0.6, R * 0.64, lip, sx); // rim lip (no overlap with the sidewall)
        const f = (d) => sx * (hw - 0.016 + d); // rim face plane, inset 16 mm
        const fx = f(0);
        const nrm = [sx, 0, 0];
        const D = (r, a) => [fx, Math.cos(a) * r, Math.sin(a) * r];
        // brake disc behind the face
        this.disc([sx * hw * 0.35, 0, 0], [0, 1, 0], [0, 0, 1], nrm, R * 0.5, 10, cols.disc);
        if (style === 'dish' || style === 'rally' || style === 'turbine') {
          this.disc([style === 'turbine' ? f(-0.006) : fx, 0, 0], [0, 1, 0], [0, 0, 1], nrm, R * 0.6, n, style === 'turbine' ? rimDark : cols.rim);
          if (style === 'dish') {
            ring(f(0.005), R * 0.5, R * 0.58, rimDark, sx);
            for (let k = 0; k < 5; k++) {
              const a = (k / 5) * Math.PI * 2;
              this.disc([f(0.008), Math.cos(a) * R * 0.18, Math.sin(a) * R * 0.18], [0, 1, 0], [0, 0, 1], nrm, R * 0.035, 5, rimDark);
            }
          } else if (style === 'rally') {
            for (let k = 0; k < 8; k++) {
              const a = (k / 8) * Math.PI * 2;
              this.disc([f(0.006), Math.cos(a) * R * 0.4, Math.sin(a) * R * 0.4], [0, 1, 0], [0, 0, 1], nrm, R * 0.085, 6, cols.tyre);
            }
          } else {
            for (let k = 0; k < 12; k++) {
              const a = (k / 12) * Math.PI * 2;
              this.quadN(D(R * 0.16, a), D(R * 0.58, a + 0.18), D(R * 0.58, a + 0.36), D(R * 0.16, a + 0.12), cols.rim, nrm);
            }
          }
        } else {
          // (v5.4: Split 5 is five PAIRS of thin spokes; Classic 8 is eight
          // straight ones over a darker dish)
          const k = style === 'mesh' ? 10 : style === 'classic' ? 8 : 5;
          const w0 = style === 'mesh' ? 0.07 : style === 'split' ? 0.06 : style === 'classic' ? 0.11 : 0.2;
          const w1 = style === 'mesh' ? 0.05 : style === 'split' ? 0.04 : style === 'classic' ? 0.075 : 0.13;
          if (style === 'classic') this.disc([f(-0.004), 0, 0], [0, 1, 0], [0, 0, 1], nrm, R * 0.55, n, rimDark);
          for (let i = 0; i < k; i++) {
            const a = (i / k) * Math.PI * 2;
            // spokes stop where the outer rim ring starts (no overlap)
            if (style === 'split') {
              for (const d of [-0.13, 0.13]) this.quadN(D(R * 0.16, a + d - w0), D(R * 0.55, a + d * 1.25 - w1), D(R * 0.55, a + d * 1.25 + w1), D(R * 0.16, a + d + w0), cols.rim, nrm);
            } else this.quadN(D(R * 0.14, a - w0), D(R * 0.55, a - w1), D(R * 0.55, a + w1), D(R * 0.14, a + w0), cols.rim, nrm);
          }
          ring(fx, R * 0.55, R * 0.6, cols.rim, sx);
          if (style === 'mesh') ring(f(0.005), R * 0.3, R * 0.34, cols.rim, sx);
        }
        this.disc([f(0.012), 0, 0], [0, 1, 0], [0, 0, 1], nrm, R * 0.15, 6, cols.rim.clone().multiplyScalar(1.1)); // centre cap
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
    // ---- v5.3 SKIN BODIES. Same Z span and wheelZ as the car they dress, so
    // the wheels and the physics still line up; everything between changes.
    //
    // gtd: modern fastback. A very long bonnet, the cabin pushed right back
    // over the rear axle, a roof that runs down into a high short deck rather
    // than a notch, and haunches that swell over the rear wheels and are the
    // widest part of the car. (Dresses the muscle chassis.)
    gtd: {
      // 4811 x 1996 x 1372 on a 2718 wheelbase, to scale: a high beltline, a
      // shallow glasshouse set well back, and a fastback falling to a short
      // deck. The widest point is over the rear wheels, not amidships.
      // Fitted to the side-elevation photograph by overlay, on the wheel
      // centres and the ground line: bonnet falling to a short upright face,
      // beltline at 0.99, a roof peaking behind the B-pillar and a fastback
      // that meets a SHORT deck at the back.
      body: [
        { z: -2.38, yb: 0.3, ym: 0.58, yt: 0.83, wb: 0.84, wm: 0.94, wt: 0.88 },
        { z: -2.1, yb: 0.25, ym: 0.62, yt: 0.95, wb: 0.88, wm: 1.0, wt: 0.94 },
        { z: -1.55, yb: 0.24, ym: 0.64, yt: 0.99, wb: 0.92, wm: 1.06, wt: 0.99 },
        { z: -1.0, yb: 0.24, ym: 0.64, yt: 0.99, wb: 0.91, wm: 1.04, wt: 0.97 },
        { z: -0.2, yb: 0.24, ym: 0.62, yt: 0.99, wb: 0.89, wm: 1.0, wt: 0.94 },
        { z: 0.7, yb: 0.24, ym: 0.62, yt: 0.97, wb: 0.88, wm: 0.99, wt: 0.93 },
        { z: 1.45, yb: 0.24, ym: 0.61, yt: 0.955, wb: 0.91, wm: 1.05, wt: 0.95 },
        { z: 2.0, yb: 0.24, ym: 0.58, yt: 0.88, wb: 0.89, wm: 1.0, wt: 0.91 },
        { z: 2.25, yb: 0.23, ym: 0.52, yt: 0.78, wb: 0.87, wm: 0.96, wt: 0.88 },
        { z: 2.38, yb: 0.22, ym: 0.46, yt: 0.66, wb: 0.84, wm: 0.92, wt: 0.84 },
      ],
      cabin: [
        { z: -1.68, yb: 0.98, yt: 1.0, wb: 0.92, wt: 0.9 },
        { z: -1.3, yb: 0.99, yt: 1.13, wb: 0.92, wt: 0.84 },
        { z: -0.9, yb: 0.99, yt: 1.28, wb: 0.92, wt: 0.77 },
        { z: -0.4, yb: 0.99, yt: 1.32, wb: 0.91, wt: 0.73 },
        { z: 0.19, yb: 0.98, yt: 1.29, wb: 0.9, wt: 0.75 },
        { z: 0.72, yb: 0.97, yt: 0.99, wb: 0.89, wt: 0.86 },
      ],
      // the roof spans the FLAT part of the cabin: held to a short span, the
      // panel covered a third of it and the rest of the roof was glass
      roof: [-0.9, 0.19, 1.32], hood: [0.8, 2.25, 0.955], trunkZ: -2.1, trunkY: 0.97, wheelZ: [1.45, -1.435], doors: [0.66, -0.78], wheelR: 0.36,
    },
    // miata: a very small, very round drop-top. Low everywhere, short
    // overhangs, a blunt oval nose, hips over the rear wheels and a shallow
    // upright screen. The pop-up lamps are drawn by the skin itself.
    // (Dresses the roadster chassis.)
    miata: {
      // Traced off the side-elevation photograph: wheelbase 450 px between the
      // arch centres, body 762 px long, screen top 241 px over the ground.
      // Every section is that measurement. The beltline DIPS at the doors -
      // that dip is the cockpit cut, and the wings stand proud of it.
      body: [
        { z: -1.95, yb: 0.36, ym: 0.58, yt: 0.72, wb: 0.6, wm: 0.7, wt: 0.64 },
        { z: -1.82, yb: 0.28, ym: 0.6, yt: 0.885, wb: 0.7, wm: 0.79, wt: 0.73 },
        { z: -1.57, yb: 0.24, ym: 0.62, yt: 0.921, wb: 0.76, wm: 0.83, wt: 0.79 },
        { z: -1.31, yb: 0.235, ym: 0.63, yt: 0.937, wb: 0.78, wm: 0.85, wt: 0.81 },
        { z: -1.05, yb: 0.235, ym: 0.63, yt: 0.9, wb: 0.78, wm: 0.85, wt: 0.82 },
        { z: -0.55, yb: 0.235, ym: 0.63, yt: 0.82, wb: 0.78, wm: 0.85, wt: 0.82 },
        { z: 0.1, yb: 0.235, ym: 0.63, yt: 0.785, wb: 0.78, wm: 0.85, wt: 0.82 },
        { z: 0.6, yb: 0.235, ym: 0.63, yt: 0.83, wb: 0.78, wm: 0.85, wt: 0.82 },
        { z: 1.0, yb: 0.235, ym: 0.63, yt: 0.911, wb: 0.78, wm: 0.85, wt: 0.81 },
        { z: 1.38, yb: 0.25, ym: 0.62, yt: 0.845, wb: 0.77, wm: 0.84, wt: 0.79 },
        { z: 1.7, yb: 0.28, ym: 0.6, yt: 0.76, wb: 0.74, wm: 0.8, wt: 0.74 },
        { z: 1.89, yb: 0.31, ym: 0.55, yt: 0.66, wb: 0.68, wm: 0.74, wt: 0.68 },
        { z: 1.95, yb: 0.34, ym: 0.51, yt: 0.6, wb: 0.62, wm: 0.68, wt: 0.62 },
      ],
      cabin: [
        { z: -0.4, yb: 0.79, yt: 0.83, wb: 0.72, wt: 0.72 },
        { z: 0.04, yb: 0.79, yt: 1.233, wb: 0.7, wt: 0.6 },
        { z: 0.1, yb: 0.79, yt: 1.233, wb: 0.7, wt: 0.6 },
      ],
      cockpit: true, scr: 0.55, hood: [0.62, 1.86, 0.83], trunkZ: -1.5, trunkY: 0.92, wheelZ: [1.25, -1.05], doors: [0.55, -0.75], wheelR: 0.28,
    },
    // v5.4 Regent V12: a long-bonnet grand tourer. The cabin sits well back,
    // the roof runs in one line to a short tail with a lip, and the car is
    // widest over the rear wheels. Twin tips, a wide low grille, and a chrome
    // strake on each front wing.
    gt: {
      body: [
        { z: -2.475, yb: 0.3, ym: 0.58, yt: 0.84, wb: 0.86, wm: 0.93, wt: 0.86 },
        { z: -2.2, yb: 0.24, ym: 0.62, yt: 0.93, wb: 0.91, wm: 0.99, wt: 0.93 },
        { z: -1.55, yb: 0.2, ym: 0.62, yt: 0.95, wb: 0.93, wm: 1.0, wt: 0.95 },
        { z: -0.6, yb: 0.2, ym: 0.6, yt: 0.92, wb: 0.91, wm: 0.98, wt: 0.92 },
        { z: 0.6, yb: 0.2, ym: 0.58, yt: 0.9, wb: 0.9, wm: 0.97, wt: 0.9 },
        { z: 1.6, yb: 0.21, ym: 0.58, yt: 0.88, wb: 0.9, wm: 0.98, wt: 0.9 },
        { z: 2.2, yb: 0.24, ym: 0.54, yt: 0.8, wb: 0.86, wm: 0.94, wt: 0.84 },
        { z: 2.475, yb: 0.28, ym: 0.48, yt: 0.67, wb: 0.79, wm: 0.86, wt: 0.75 },
      ],
      cabin: [
        { z: -1.95, yb: 0.94, yt: 0.97, wb: 0.9, wt: 0.88 },
        { z: -1.35, yb: 0.94, yt: 1.13, wb: 0.9, wt: 0.8 },
        { z: -0.75, yb: 0.93, yt: 1.26, wb: 0.89, wt: 0.72 },
        { z: -0.15, yb: 0.92, yt: 1.28, wb: 0.89, wt: 0.72 },
        { z: 0.35, yb: 0.91, yt: 1.23, wb: 0.88, wt: 0.74 },
        { z: 0.85, yb: 0.9, yt: 0.93, wb: 0.87, wt: 0.84 },
      ],
      roof: [-0.75, 0.35, 1.28], hood: [0.9, 2.35, 0.9], trunkZ: -2.1, trunkY: 0.94, wheelZ: [1.6, -1.45], doors: [0.8, -0.65],
      grilleW: 0.78, hlX: 0.6, twinEx: 1, strake: 1, lip: 1,
    },
    // v5.4 Rotor 7: low and curvy - a waist between rear hips and front wings,
    // a small bubble cabin, and the hoop wing it is known by.
    rotor: {
      body: [
        { z: -2.15, yb: 0.3, ym: 0.54, yt: 0.74, wb: 0.72, wm: 0.8, wt: 0.72 },
        { z: -1.9, yb: 0.24, ym: 0.57, yt: 0.83, wb: 0.79, wm: 0.86, wt: 0.8 },
        { z: -1.3, yb: 0.2, ym: 0.57, yt: 0.85, wb: 0.81, wm: 0.88, wt: 0.82 },
        { z: -0.4, yb: 0.19, ym: 0.54, yt: 0.8, wb: 0.78, wm: 0.84, wt: 0.78 },
        { z: 0.7, yb: 0.19, ym: 0.52, yt: 0.76, wb: 0.78, wm: 0.84, wt: 0.77 },
        { z: 1.35, yb: 0.2, ym: 0.52, yt: 0.76, wb: 0.8, wm: 0.87, wt: 0.79 },
        { z: 1.9, yb: 0.23, ym: 0.46, yt: 0.64, wb: 0.76, wm: 0.83, wt: 0.72 },
        { z: 2.15, yb: 0.27, ym: 0.4, yt: 0.53, wb: 0.66, wm: 0.74, wt: 0.6 },
      ],
      cabin: [
        { z: -1.75, yb: 0.83, yt: 0.86, wb: 0.79, wt: 0.77 },
        { z: -1.2, yb: 0.83, yt: 1.01, wb: 0.79, wt: 0.71 },
        { z: -0.55, yb: 0.8, yt: 1.13, wb: 0.78, wt: 0.63 },
        { z: 0.05, yb: 0.79, yt: 1.14, wb: 0.78, wt: 0.63 },
        { z: 0.55, yb: 0.77, yt: 1.07, wb: 0.77, wt: 0.67 },
        { z: 1.0, yb: 0.76, yt: 0.79, wb: 0.77, wt: 0.76 },
      ],
      roof: [-0.55, 0.05, 1.14], hood: [1.05, 2.05, 0.77], trunkZ: -1.85, trunkY: 0.85, wheelZ: [1.3, -1.2], doors: [0.75, -0.5],
      grilleW: 0.66, hlX: 0.55, twinEx: 1, hoop: 1,
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
    // v4: desert pickup — tall body, cab forward, open bed (drawn as a dark
    // well with rails, see `bed`), big tyres (wheelR).
    truck: {
      body: [
        { z: -2.45, yb: 0.5, ym: 0.74, yt: 1.02, wb: 0.88, wm: 0.98, wt: 0.94 },
        { z: -2.3, yb: 0.44, ym: 0.76, yt: 1.08, wb: 0.9, wm: 1.0, wt: 0.96 },
        { z: -0.2, yb: 0.44, ym: 0.76, yt: 1.08, wb: 0.9, wm: 1.0, wt: 0.96 },
        { z: 1.6, yb: 0.44, ym: 0.76, yt: 1.06, wb: 0.9, wm: 1.0, wt: 0.94 },
        { z: 2.3, yb: 0.48, ym: 0.74, yt: 0.98, wb: 0.86, wm: 0.96, wt: 0.88 },
        { z: 2.45, yb: 0.56, ym: 0.72, yt: 0.9, wb: 0.8, wm: 0.9, wt: 0.8 },
      ],
      cabin: [
        { z: -0.38, yb: 1.06, yt: 1.12, wb: 0.92, wt: 0.86 },
        { z: -0.32, yb: 1.06, yt: 1.72, wb: 0.92, wt: 0.8 },
        { z: 0.75, yb: 1.06, yt: 1.74, wb: 0.92, wt: 0.8 },
        { z: 1.45, yb: 1.04, yt: 1.08, wb: 0.9, wt: 0.86 },
      ],
      roof: [-0.32, 0.75, 1.74], hood: [1.45, 2.4, 1.06], trunkZ: -2.35, trunkY: 1.08, wheelZ: [1.6, -1.35], doors: [1.2, -0.25],
      bed: [-2.3, -0.45], wheelR: 0.42,
    },
    // v4: mid-engine wedge — low nose, cab forward, long engine deck with
    // cooling slats (see `deck`).
    mid: {
      body: [
        { z: -2.2, yb: 0.28, ym: 0.5, yt: 0.72, wb: 0.84, wm: 0.95, wt: 0.84 },
        { z: -2.0, yb: 0.2, ym: 0.5, yt: 0.8, wb: 0.9, wm: 0.99, wt: 0.88 },
        { z: -0.6, yb: 0.2, ym: 0.5, yt: 0.82, wb: 0.9, wm: 0.99, wt: 0.86 },
        { z: 0.8, yb: 0.2, ym: 0.46, yt: 0.72, wb: 0.86, wm: 0.95, wt: 0.8 },
        { z: 1.8, yb: 0.2, ym: 0.38, yt: 0.56, wb: 0.84, wm: 0.92, wt: 0.74 },
        { z: 2.22, yb: 0.22, ym: 0.3, yt: 0.42, wb: 0.78, wm: 0.84, wt: 0.62 },
      ],
      cabin: [
        { z: -1.0, yb: 0.8, yt: 0.86, wb: 0.8, wt: 0.7 },
        { z: -0.55, yb: 0.8, yt: 1.12, wb: 0.8, wt: 0.6 },
        { z: 0.25, yb: 0.77, yt: 1.14, wb: 0.8, wt: 0.6 },
        { z: 1.15, yb: 0.66, yt: 0.7, wb: 0.8, wt: 0.74 },
      ],
      roof: [-0.55, 0.25, 1.14], hood: [1.15, 2.1, 0.66], trunkZ: -1.95, trunkY: 0.82, wheelZ: [1.45, -1.3], doors: [0.8, -0.5],
      deck: [-1.85, -1.05],
    },
    // v5: kei box — tiny, narrow and tall, stubby bonnet, big glasshouse
    kei: {
      body: [
        { z: -1.7, yb: 0.3, ym: 0.56, yt: 0.86, wb: 0.66, wm: 0.72, wt: 0.68 },
        { z: -1.55, yb: 0.26, ym: 0.58, yt: 0.92, wb: 0.68, wm: 0.74, wt: 0.71 },
        { z: 0.9, yb: 0.26, ym: 0.58, yt: 0.92, wb: 0.68, wm: 0.74, wt: 0.71 },
        { z: 1.45, yb: 0.26, ym: 0.54, yt: 0.8, wb: 0.68, wm: 0.73, wt: 0.68 },
        { z: 1.7, yb: 0.3, ym: 0.48, yt: 0.66, wb: 0.64, wm: 0.7, wt: 0.62 },
      ],
      cabin: [
        { z: -1.66, yb: 0.92, yt: 1.46, wb: 0.7, wt: 0.62 },
        { z: -1.5, yb: 0.92, yt: 1.58, wb: 0.71, wt: 0.63 },
        { z: 0.45, yb: 0.92, yt: 1.58, wb: 0.71, wt: 0.63 },
        { z: 1.15, yb: 0.9, yt: 0.96, wb: 0.7, wt: 0.66 },
      ],
      roof: [-1.5, 0.45, 1.58], hood: [1.15, 1.65, 0.9], trunkZ: -1.65, trunkY: 1.46, wheelZ: [1.08, -1.1], doors: [0.95, -0.4],
      hlX: 0.44, grilleW: 0.5,
    },
    // v5: electric fastback — smooth and low, long glass roof, no grille or
    // exhaust, a light bar across the nose and tail
    ev: {
      body: [
        { z: -2.35, yb: 0.3, ym: 0.54, yt: 0.78, wb: 0.84, wm: 0.94, wt: 0.84 },
        { z: -2.1, yb: 0.22, ym: 0.56, yt: 0.86, wb: 0.88, wm: 0.97, wt: 0.88 },
        { z: 0.6, yb: 0.22, ym: 0.56, yt: 0.84, wb: 0.88, wm: 0.97, wt: 0.88 },
        { z: 1.7, yb: 0.22, ym: 0.5, yt: 0.7, wb: 0.86, wm: 0.95, wt: 0.82 },
        { z: 2.35, yb: 0.26, ym: 0.4, yt: 0.52, wb: 0.8, wm: 0.88, wt: 0.68 },
      ],
      cabin: [
        { z: -2.05, yb: 0.84, yt: 0.9, wb: 0.84, wt: 0.74 },
        { z: -1.1, yb: 0.86, yt: 1.3, wb: 0.86, wt: 0.66 },
        { z: 0.3, yb: 0.86, yt: 1.34, wb: 0.86, wt: 0.66 },
        { z: 1.3, yb: 0.8, yt: 0.84, wb: 0.84, wt: 0.8 },
      ],
      roof: [-1.1, 0.3, 1.34], hood: [1.3, 2.25, 0.8], trunkZ: -2.1, trunkY: 0.88, wheelZ: [1.5, -1.45], doors: [0.8, -0.9],
      flush: true, glassRoof: true,
    },
    // v5: Group B rally wedge — boxy, big flared arches, stock rear wing,
    // roof scoop, lamp pod and mud flaps whatever you fit
    rally: {
      body: [
        { z: -2.05, yb: 0.32, ym: 0.58, yt: 0.86, wb: 0.84, wm: 0.9, wt: 0.82 },
        { z: -1.85, yb: 0.26, ym: 0.6, yt: 0.92, wb: 0.88, wm: 0.92, wt: 0.86 },
        { z: -0.9, yb: 0.26, ym: 0.6, yt: 0.92, wb: 0.86, wm: 0.9, wt: 0.84 },
        { z: 0.7, yb: 0.26, ym: 0.6, yt: 0.9, wb: 0.86, wm: 0.9, wt: 0.84 },
        { z: 1.6, yb: 0.26, ym: 0.56, yt: 0.8, wb: 0.86, wm: 0.92, wt: 0.82 },
        { z: 2.05, yb: 0.3, ym: 0.48, yt: 0.64, wb: 0.8, wm: 0.86, wt: 0.72 },
      ],
      cabin: [
        { z: -1.7, yb: 0.92, yt: 1.02, wb: 0.84, wt: 0.72 },
        { z: -1.2, yb: 0.92, yt: 1.38, wb: 0.84, wt: 0.66 },
        { z: 0.25, yb: 0.92, yt: 1.4, wb: 0.84, wt: 0.66 },
        { z: 1.0, yb: 0.9, yt: 0.94, wb: 0.84, wt: 0.8 },
      ],
      roof: [-1.2, 0.25, 1.4], hood: [1.0, 1.95, 0.9], trunkZ: -1.9, trunkY: 1.02, wheelZ: [1.3, -1.2], doors: [0.85, -0.5],
      rallyKit: true,
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
    const T = G.Parts.effTune(P, tune, carId);
    // A skin brings its own body: the silhouette IS the car, so dressing the
    // stock shape in details was never going to read as a different one.
    const SK = G.Parts.skinFor(carId, (look || {}).skin);
    const B = BODIES[(SK && SK.body) || car.body];
    const paint = L.paint != null ? L.paint : colorHex;
    const body = C(paint), bodyTop = lighten(paint, 0.05);
    const acc = C(L.accent), acc0 = acc;
    const dark = C(0x1b1f27), black = C(0x121418), chrome = C(0xd5dbe2), carbon = C(0x2a2d33), white = C(0xf4f4f4), rubber = C(0x16181d);
    const glass = C(L.tint === 'clear' ? 0x6f8fae : L.tint === 'black' ? 0x0c0f14 : 0x243447);
    const light = C(L.lights === 'xenon' ? 0xe4f2ff : L.lights === 'amber' ? 0xffc24a : 0xfff4c2);
    const su = G.Parts.opt('suspension', P.suspension);
    const rideH = su.rideH + T.rideH * 0.01;
    // wheel radius: 0.33 m, except the truck's big tyres; wk scales wheel-sized details
    const WR = B.wheelR || BODIES[car.body].wheelR || 0.33, wk = WR / 0.33;
    const gb = new GB();
    const S = B.body, cab = B.cabin;
    const fz = S[S.length - 1].z, rz = S[0].z;
    const fS = S[S.length - 1], rS = S[0];
    const fy = (fS.ym + fS.yt) / 2, ry = (rS.ym + rS.yt) / 2;
    const carbonHood = P.weight === 'w2' || P.weight === 'w3';

    // ---- hull + cabin
    const two = L.livery === 'twotone';
    // An open car's cockpit is a hole in the shell. The hull is re-sectioned
    // at the two edges of it so the opening lands exactly where the cabin
    // says, and an interior tub is built to the same rim below.
    const cF = cab[cab.length - 1], hole = B.cockpit ? [cF.z - 1.12, cF.z - 0.03] : null;
    const SS = (() => {
      if (!hole) return S;
      const zs = S.map((q) => q.z);
      for (const z of hole) if (!zs.some((v) => Math.abs(v - z) < 0.02)) zs.push(z);
      zs.sort((a, b) => a - b);
      return zs.map((z) => Object.assign({}, secAt(B, z), { z }));
    })();
    if (L.livery === 'fade') {
      // Fade: the hull is re-lofted through extra sections every ~0.3 m and
      // each band blends from the accent (tail) to the paint (nose).
      const zsD = [];
      for (let k = 0; k < S.length - 1; k++) {
        const a = S[k].z, b = S[k + 1].z, n = Math.max(1, Math.ceil((b - a) / 0.3));
        for (let j = 0; j < n; j++) zsD.push(a + ((b - a) * j) / n);
      }
      zsD.push(fz);
      if (hole) for (const z of hole) if (!zsD.some((v) => Math.abs(v - z) < 0.02)) zsD.push(z);
      zsD.sort((a, b) => a - b);
      const secs = zsD.map((z) => Object.assign({}, secAt(B, z), { z }));
      const span = secs.length - 2 || 1;
      gb.loft(secs, body, bodyTop, false, (e, k) => {
        if (e === 0) return dark;
        const c = acc.clone().lerp(body, U.smoothstep(0.1, 0.9, k / span));
        return e === 3 ? c.multiplyScalar(1.06) : c;
      }, hole);
    } else gb.loft(SS, body, bodyTop, false, (e) => (e === 3 ? bodyTop : (e === 1 || e === 5) && two ? acc : e === 0 ? dark : body), hole);
    if (hole) {
      // the tub: rim exactly on the hull's own top edge so there is no seam,
      // walls dropping away from it and a floor down inside the car
      const trim = C(0x23252b), floorC = C(0x131519), DEEP = 0.22;
      const hs = SS.filter((q) => q.z >= hole[0] - 1e-4 && q.z <= hole[1] + 1e-4);
      for (let i = 0; i < hs.length - 1; i++) {
        const a = hs[i], b2 = hs[i + 1];
        for (const sx of [-1, 1]) {
          gb.quadN([sx * a.wt, a.yt, a.z], [sx * b2.wt, b2.yt, b2.z], [sx * b2.wt, b2.yt - DEEP, b2.z], [sx * a.wt, a.yt - DEEP, a.z], trim, [-sx, 0, 0]);
        }
        gb.quadN([-a.wt, a.yt - DEEP, a.z], [a.wt, a.yt - DEEP, a.z], [b2.wt, b2.yt - DEEP, b2.z], [-b2.wt, b2.yt - DEEP, b2.z], floorC, [0, 1, 0]);
      }
      const e0 = hs[0], e1 = hs[hs.length - 1];
      gb.quadN([-e0.wt, e0.yt, e0.z], [e0.wt, e0.yt, e0.z], [e0.wt, e0.yt - DEEP, e0.z], [-e0.wt, e0.yt - DEEP, e0.z], trim, [0, 0, 1]);
      gb.quadN([-e1.wt, e1.yt, e1.z], [e1.wt, e1.yt, e1.z], [e1.wt, e1.yt - DEEP, e1.z], [-e1.wt, e1.yt - DEEP, e1.z], C(0x1c1e24), [0, 0, -1]);
    }
    const pillar = L.livery === 'roof' ? acc : body;
    const roofCol = P.weight === 'w3' ? carbon : L.livery === 'roof' || L.livery === 'checker' ? acc : bodyTop;
    const c0 = cab[0], cN = cab[cab.length - 1];
    // An open car has no glass lid. Lofting the whole cabin volume in tinted
    // glass laid a dark slab over the cockpit and hid everything inside it;
    // only the SCREEN is glass, leaning back from the scuttle to the rail.
    const scZ = B.scr != null ? B.scr : cN.z + 0.17, scS = secAt(B, scZ);
    if (B.cockpit) {
      gb.quadN([cN.wt - 0.02, cN.yt - 0.02, cN.z], [-(cN.wt - 0.02), cN.yt - 0.02, cN.z],
        [-(scS.wt - 0.05), scS.yt + 0.01, scZ], [scS.wt - 0.05, scS.yt + 0.01, scZ], glass, [0, 0.8, 0.6]);
    } else {
      // v5.5: the cabin is ONE surface - glass where there is glass, metal
      // where there is metal. Metal panels laid a few millimetres over a
      // glass cabin fought it for the same pixels at a distance, and the
      // glass flickered through the roof.
      const roofZa = B.roof ? B.roof[0] - 0.06 : 99, roofZb = B.roof ? B.roof[1] + 0.06 : -99;
      // (the GTD: behind the doors a Mustang is a broad metal sail panel with
      // the rear window set into it)
      const sailZ = SK && SK.id === 'gtd' ? B.doors[1] - 0.12 + 1e-6 : -99;
      gb.loft4(cab, glass, null, (e, k) => {
        const za = cab[k].z, zb = cab[k + 1].z;
        if (zb <= sailZ) return e === 2 ? { split: [0.58, bodyTop, glass] } : bodyTop;
        if (e === 2 && za >= roofZa && zb <= roofZb) return roofCol;
        return undefined;
      });
    }
    if (B.roof) {
      const [z0, z1, y] = B.roof;
      // Width comes from the cabin sections the roof actually spans. Taken
      // from one section it overhung the glass by 10 cm on any cabin that
      // narrows towards the back, and 5 cm of thickness made it a plank
      // hovering over the car. It is a panel now, flush with the cabin top.
      let rw = 0;
      for (const sc of cab) if (sc.z >= z0 - 0.14 && sc.z <= z1 + 0.14) rw = Math.max(rw, sc.wt);
      const w = (rw || cab[1].wt) * 2 - 0.015;
      // (the roof is the cabin's own top face now - see the cabin loft; a
      // cabin with too few sections under the roof still gets a panel)
      const rsec = cab.filter((sc) => sc.z >= z0 - 0.06 && sc.z <= z1 + 0.06);
      if (rsec.length < 2) gb.box(0, y - 0.004, (z0 + z1) / 2, w, 0.035, z1 - z0 + 0.04, roofCol);
      if (L.livery === 'checker') {
        const nx = 6, nz = 7;
        for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
          if ((i + k) % 2) continue;
          const x0 = -w / 2 + (i * w) / nx, zz = z0 + (k * (z1 - z0)) / nz;
          gb.quadN([x0, y + 0.011, zz], [x0 + w / nx, y + 0.011, zz], [x0 + w / nx, y + 0.011, zz + (z1 - z0) / nz], [x0, y + 0.011, zz + (z1 - z0) / nz], black, [0, 1, 0]);
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
        gb.beam([sx * (c0.wb + 0.01), c0.yb + 0.01, c0.z + 0.08], [sx * (cN.wb + 0.01), cN.yb + 0.01, cN.z - 0.05], 0.025, 0.025, SK ? dark : chrome);
      }
      // antenna
      if (car.body !== 'roadster' && !SK) gb.beam([-0.35, y - 0.01, z0 + 0.12], [-0.35, y + 0.45, z0 - 0.02], 0.015, 0.015, black); // (a skin is a track car: no aerial)
    }
    if (B.cockpit) {
      // Everything in here is measured off the CABIN, not written as numbers:
      // hard-coded heights were sized for one body, so on any other one the
      // seats and floor sank through the deck and the hoops grew out of it.
      // Everything in here hangs off the SCREEN, not off fixed z numbers:
      // written as numbers, the floor ran out onto the bonnet and the humps
      // hovered over the boot on any cabin placed differently.
      // Furniture sits on the tub FLOOR, so nothing needs a height written
      // into it and nothing stands on the deck looking like luggage.
      const ckF = hole[1], ckR = hole[0];
      const fl = secAt(B, (ckF + ckR) / 2).yt - 0.22;      // the floor, 22 cm down
      const deck = (z) => secAt(B, z).yt;
      for (const sx of [-1, 1]) {
        gb.box(sx * 0.29, fl + 0.07, ckF - 0.46, 0.4, 0.14, 0.42, C(0x2e2319)); // seat cushions
        gb.box(sx * 0.29, fl + 0.24, ckF - 0.66, 0.4, 0.34, 0.09, C(0x2e2319)); // and their backs
        gb.box(sx * 0.29, fl + 0.4, ckF - 0.67, 0.2, 0.1, 0.1, C(0x2e2319)); // head restraints
      }
      gb.box(0, fl + 0.13, ckF - 0.5, 0.2, 0.16, 0.7, C(0x1c1e24)); // transmission tunnel
      gb.box(0, fl + 0.2, ckF - 0.1, 1.1, 0.22, 0.2, C(0x1c1e24)); // dash
      gb.box(0.3, fl + 0.29, ckF - 0.16, 0.3, 0.04, 0.16, black); // steering wheel
      gb.beam([0.3, fl + 0.28, ckF - 0.16], [0.3, fl + 0.2, ckF - 0.04], 0.05, 0.05, dark); // column into the dash
      if (!(SK && SK.flatDeck)) {
        const hz = ckR - 0.07;
        gb.beam([0.36, deck(hz) - 0.04, hz], [0.36, deck(hz) + 0.38, hz - 0.02], 0.07, 0.07, chrome); // roll hoops
        gb.beam([-0.36, deck(hz) - 0.04, hz], [-0.36, deck(hz) + 0.38, hz - 0.02], 0.07, 0.07, chrome);
        gb.beam([0.36, deck(hz) + 0.38, hz - 0.02], [-0.36, deck(hz) + 0.38, hz - 0.02], 0.07, 0.07, chrome);
      }
      // The windscreen SURROUND: pillars with a section to them, a rail
      // capping the top and another along the scuttle, so the glass sits in
      // a frame instead of between two sticks.
      const frame = SK && SK.flatDeck ? body : dark;
      for (const sx of [-1, 1]) gb.beam([sx * (scS.wt - 0.05), scS.yt + 0.005, scZ], [sx * (cN.wt - 0.015), cN.yt - 0.01, cN.z], 0.075, 0.05, frame);
      gb.beam([cN.wt + 0.005, cN.yt - 0.005, cN.z], [-(cN.wt + 0.005), cN.yt - 0.005, cN.z], 0.06, 0.065, frame);
      gb.beam([scS.wt - 0.04, scS.yt + 0.012, scZ], [-(scS.wt - 0.04), scS.yt + 0.012, scZ], 0.05, 0.04, dark);
    }
    // wipers at the windscreen base
    // Wipers lie ON the scuttle. Taking their height from the screen base
    // left them hanging 2-3 cm in the air on every car whose cowl drops away.
    const wpA = Math.min((B.cockpit ? scZ : cN.z) - 0.06, B.hood ? B.hood[0] - 0.03 : 99), wpB = wpA - 0.12;
    for (const sx of [0.25, -0.2]) gb.beam([sx - 0.25, secAt(B, wpA).yt + 0.018, wpA], [sx + 0.2, secAt(B, wpB).yt + 0.018, wpB], 0.03, 0.02, black);

    // ---- top surface bands (stripes / carbon hood) following the body
    const topY = (z) => secAt(B, z).yt;
    const band = (z0, z1, x0, x1, col, lift) => {
      if (z1 - z0 < 0.05) return;
      const zs = [z0];
      for (const s of S) if (s.z > z0 && s.z < z1) zs.push(s.z);
      zs.push(z1);
      for (let i = 0; i < zs.length - 1; i++) {
        const za = zs[i], zb = zs[i + 1];
        const ya = topY(za) + (lift || 0.012), yb = topY(zb) + (lift || 0.012);
        gb.quadN([x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb], col, [0, 1, 0]);
      }
    };
    const hoodZ0 = B.cockpit ? cab[cab.length - 1].z + 0.05 : cN.z + 0.02;
    const zones = [[hoodZ0, fz - 0.04]];
    if (B.cockpit) zones.push([rz + 0.05, hole[0] - 0.04]);
    else if (c0.z - rz > 0.2 && !B.bed) zones.push([rz + 0.05, c0.z - 0.02]);
    // Layer heights above the paint, ≥ 1 cm apart so they never z-fight at
    // chase-camera distance: carbon 1 cm, stripes 2 cm, roundels 3 cm.
    if (carbonHood) band(zones[0][0], zones[0][1], -0.62, 0.62, carbon, 0.005);
    // (v5.4 Heritage band: one wide stripe in the accent with a pinstripe
    // down each edge in whichever of white or black stands off it)
    const pin = acc.r * 0.3 + acc.g * 0.59 + acc.b * 0.11 > 0.62 ? dark : white;
    const stripes = L.livery === 'stripes' || L.livery === 'race' ? [[0.09, 0.25], [-0.25, -0.09]] : L.livery === 'single' ? [[-0.2, 0.2]]
      : L.livery === 'heritage' ? [[-0.27, 0.27], [0.29, 0.325, pin], [-0.325, -0.29, pin]] : [];
    if (L.livery === 'panels') for (const [z0, z1] of zones) band(z0, z1, -0.64, 0.64, acc, 0.006); // contrast bonnet and boot lid
    for (const [x0, x1, scol] of stripes) {
      const acc = scol || acc0;
      for (const [z0, z1] of zones) band(z0, z1, x0, x1, acc, 0.009);
      if (B.roof) {
        const [rz0, rz1, ry0] = B.roof;
        // (v5.4: along the cabin's own top line, as the roof panel is - held
        // flat, a stripe over a curved roof floated off it at both ends)
        if (L.livery !== 'checker') {
          const rs = cab.filter((sc) => sc.z >= rz0 - 0.06 && sc.z <= rz1 + 0.06);
          if (rs.length >= 2) for (let k = 0; k < rs.length - 1; k++) {
            const a = rs[k], b2 = rs[k + 1];
            gb.quadN([x0, a.yt + 0.013, a.z], [x1, a.yt + 0.013, a.z], [x1, b2.yt + 0.013, b2.z], [x0, b2.yt + 0.013, b2.z], acc, [0, 1, 0]);
          }
          else gb.quadN([x0, ry0 + 0.011, rz0 - 0.03], [x1, ry0 + 0.011, rz0 - 0.03], [x1, ry0 + 0.011, rz1 + 0.03], [x0, ry0 + 0.011, rz1 + 0.03], acc, [0, 1, 0]);
        }
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
    if (L.kit !== 'street' && L.kit !== 'wide') sideBand(midS.yb + 0.005, midS.yb + 0.075, dark, rz + 0.25, fz - 0.3); // skirts (a kit brings its own)
    // v5 liveries: tiger slashes on the flanks, a lightning bolt, hood chevrons
    const sidePoly = (pts, col, lift) => {
      // pts: [[y, z], ...] a convex quad laid on both flanks
      for (const sx of [-1, 1]) {
        const P3 = ([y, z]) => [sx * (surfX(secAt(B, z), y) + lift), y, z];
        gb.quadN(P3(pts[0]), P3(pts[1]), P3(pts[2]), P3(pts[3]), col, [sx, 0, 0]);
      }
    };
    if (L.livery === 'tiger') {
      const [wf, wr] = B.wheelZ;
      const y0 = midS.ym - 0.1, y1 = midS.yt - 0.03;
      for (let k = 0; k < 5; k++) {
        const z = U.lerp(wr + 0.5, wf - 0.4, k / 4), w = 0.07 + (k % 2) * 0.03;
        sidePoly([[y0, z - 0.18], [y0, z - 0.18 + w], [y1, z + 0.12 + w * 0.4], [y1, z + 0.12]], acc, 0.022);
      }
    } else if (L.livery === 'bolt') {
      const [wf, wr] = B.wheelZ;
      const ym = midS.ym + 0.05, a = wr + 0.45, b = wf - 0.45, m1 = U.lerp(a, b, 0.4), m2 = U.lerp(a, b, 0.62);
      sidePoly([[ym - 0.03, a], [ym + 0.03, a], [ym + 0.12, m1], [ym + 0.04, m1]], acc, 0.022);
      sidePoly([[ym + 0.04, m1 - 0.06], [ym + 0.12, m1], [ym - 0.02, m2], [ym - 0.1, m2 - 0.06]], acc, 0.023);
      sidePoly([[ym - 0.1, m2 - 0.06], [ym - 0.02, m2], [ym + 0.02, b], [ym - 0.01, b]], acc, 0.022);
    }
    if (L.livery === 'chevron') {
      const [hz0, hz1] = zones[0];
      for (let k = 0; k < 3; k++) {
        const zc = U.lerp(hz0 + 0.15, hz1 - 0.2, k / 2.2), d = 0.14;
        const y = (z) => topY(z) + 0.02;
        for (const sx of [-1, 1]) {
          const P3 = (x, z) => [x, y(z), z];
          gb.quadN(P3(0, zc + d), P3(sx * 0.02, zc + d + 0.12), P3(sx * 0.55, zc - 0.12 + 0.12), P3(sx * 0.55, zc - 0.12), acc, [0, 1, 0]);
        }
      }
    }
    // (v5.4: how far a flank livery stops short of the arch centres - scaled
    // with the wheel, and clear of any flare, which the fixed 0.47 m was not)
    const archGap = 0.47 * wk + ((P.width === 'wide' && L.kit !== 'wide') || car.body === 'truck' ? 0.16 : 0);
    if (L.livery === 'retro') {
      // three thin lines down the flank in graded shades of the accent
      const [wf, wr] = B.wheelZ, shades = [acc.clone().lerp(white, 0.35), acc, acc.clone().lerp(dark, 0.35)];
      for (let k = 0; k < 3; k++) {
        const y0 = midS.ym + 0.1 - k * 0.055;
        for (const [a, b] of [[rz + 0.12, wr - archGap], [wr + archGap, wf - archGap], [wf + archGap, fz - 0.12]]) if (b - a > 0.1) sideBand(y0, y0 + 0.028, shades[k], a, b, 0.008 + k * 0.001);
      }
    }
    if (L.livery === 'side' || L.livery === 'race') {
      // runs between the wheel arches, like the real thing
      const [wf, wr] = B.wheelZ;
      for (const [a, b] of [[rz + 0.1, wr - archGap], [wr + archGap, wf - archGap], [wf + archGap, fz - 0.1]]) if (b - a > 0.1) sideBand(midS.ym + 0.03, midS.ym + (L.livery === 'side' ? 0.13 : 0.07), acc, a, b, 0.022);
    }
    if (L.livery === 'flames') {
      // Flames: tongues licking back from behind the front wheel, an outer
      // layer in the accent and a hotter inner layer, laid on the side panel.
      const z0 = B.wheelZ[0] - 0.46 * wk;
      const maxLen = z0 - (B.wheelZ[1] + 0.5 * wk);
      const s0 = secAt(B, z0);
      const yLo = s0.ym - 0.04, yHi = s0.yt - 0.05;
      const hot = acc.clone().lerp(C(0xffd23a), 0.55);
      const LENS = [0.55, 0.8, 0.68, 0.9, 0.5];
      for (const [col, sc, lift] of [[acc, 1, 0.02], [hot, 0.55, 0.03]]) {
        for (let t = 0; t < 5; t++) {
          const yc = U.lerp(yLo, yHi, (t + 0.5) / 5), h = ((yHi - yLo) / 5) * 1.05 * sc;
          const len = Math.min(maxLen, LENS[t] * car.len * 0.42) * sc;
          const tipY = yc + (t % 2 ? 0.05 : -0.04);
          for (const sx of [-1, 1]) {
            const pt = (y, z) => [sx * (surfX(secAt(B, z), y) + lift), y, z];
            for (let j = 0; j < 3; j++) {
              const za = z0 - (len * j) / 3, zb = z0 - (len * (j + 1)) / 3;
              const ya = U.lerp(yc, tipY, j / 3), yb = U.lerp(yc, tipY, (j + 1) / 3);
              const wa = h * (1 - j / 3) * 0.5, wb2 = h * (1 - (j + 1) / 3) * 0.5;
              gb.quadN(pt(ya + wa, za), pt(ya - wa, za), pt(yb - wb2, zb), pt(yb + wb2 + 0.001, zb), col, [sx, 0, 0]);
            }
          }
        }
      }
    }
    // ---- body-specific details (v4 chassis)
    if (B.bed) {
      // pickup bed: dark well with ribs, roll bar + light bar behind the cab, a spare
      const [bz0, bz1] = B.bed;
      const bw = secAt(B, (bz0 + bz1) / 2).wt - 0.12;
      band(bz0, bz1, -bw, bw, C(0x2a2d33), 0.012);
      for (let z = bz0 + 0.2; z < bz1 - 0.1; z += 0.3) band(z, z + 0.05, -bw, bw, C(0x3a3e46), 0.022);
      const ry0 = topY(bz1);
      for (const sx of [-1, 1]) gb.beam([sx * (bw - 0.05), ry0, bz1 - 0.08], [sx * (bw - 0.05), ry0 + 0.55, bz1 - 0.12], 0.07, 0.07, dark);
      gb.beam([bw - 0.05, ry0 + 0.55, bz1 - 0.12], [-(bw - 0.05), ry0 + 0.55, bz1 - 0.12], 0.07, 0.07, dark);
      for (const lx of [-0.45, -0.15, 0.15, 0.45]) gb.box(lx, ry0 + 0.66, bz1 - 0.12, 0.22, 0.14, 0.08, light);
      const sz = bz0 + 0.75, sy = topY(sz);
      gb.disc([0, sy + 0.02, sz], [1, 0, 0], [0, 0, 1], [0, 1, 0], 0.36, 10, C(0x1c1d21));
      gb.disc([0, sy + 0.026, sz], [1, 0, 0], [0, 0, 1], [0, 1, 0], 0.2, 8, C(L.rimCol));
    }
    if (B.deck) {
      // mid-engine: cooling slats over the engine, intakes behind the doors
      const [dz0, dz1] = B.deck;
      for (let z = dz0 + 0.06; z < dz1 - 0.05; z += 0.13) band(z, z + 0.06, -0.5, 0.5, dark, 0.014);
      sideBand(midS.ym + 0.02, midS.yt - 0.07, dark, B.doors[1] - 0.55, B.doors[1] - 0.08, 0.012);
    }
    // v5.4 Regent: a chrome strake on each front wing, laid ON the panel
    // behind the wheel, and a lip across the tail
    if (B.strake && !SK) {
      for (const sx of [-1, 1]) {
        const a0 = B.wheelZ[0] - 0.5, a1 = B.wheelZ[0] - 0.95, sa = secAt(B, a0), sb = secAt(B, a1);
        const ya = sa.ym + 0.1, yb2 = sb.ym + 0.12;
        gb.beam([sx * (surfX(sa, ya) + 0.004), ya, a0], [sx * (surfX(sb, yb2) + 0.004), yb2, a1], 0.02, 0.04, chrome);
      }
      // and a chrome surround on the grille - it is the face of a GT
      const gw = (B.grilleW || 0.9) / 2 + 0.025, gy0 = fy - 0.225, gy1 = fy - 0.055, gz = fz + 0.006;
      gb.box(0, gy1, gz, gw * 2, 0.022, 0.024, chrome);
      gb.box(0, gy0, gz, gw * 2, 0.022, 0.024, chrome);
      for (const sx of [-1, 1]) gb.box(sx * gw, (gy0 + gy1) / 2, gz, 0.022, gy1 - gy0 + 0.02, 0.024, chrome);
    }
    if (B.lip && !SK && P.aero === 'none' && L.spoiler === 'none') {
      const lz = rz + 0.16, ls = secAt(B, lz);
      gb.box(0, ls.yt + 0.018, lz, ls.wt * 2 - 0.1, 0.045, 0.2, bodyTop);
    }
    // v5.4 Rotor: the hoop wing - two uprights off the deck and a thin blade
    // looped between them, the whole width of the boot lid
    if (B.hoop && !SK && P.aero === 'none' && L.spoiler === 'none') {
      const hz = B.trunkZ + 0.06, hS = secAt(B, hz), hx = hS.wt - 0.1, hy = hS.yt + 0.17;
      for (const sx of [-1, 1]) gb.beam([sx * hx, hS.yt - 0.02, hz + 0.1], [sx * hx, hy, hz - 0.02], 0.06, 0.1, body);
      gb.box(0, hy + 0.01, hz - 0.03, hx * 2 + 0.06, 0.035, 0.2, body);
    }
    const [dzF, dzR] = B.doors;
    const seam = (z) => {
      const s = secAt(B, z);
      for (const sx of [-1, 1]) {
        const p = (y, dz) => [sx * (surfX(s, y) + 0.015), y, z + dz];
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
      // Door roundels lie ON the upper side panel, tilted to match its slope.
      // (A vertical disc floated several cm off the curved flank and looked
      // like a part stuck on in the wrong place.) Lifted 3 cm: above stripes.
      const zc = (dzF + dzR) / 2 + (car.body === 'roadster' ? 0.05 : 0);
      const s = secAt(B, zc);
      const dx = s.wt - s.wm, dy = s.yt - s.ym, fl = Math.hypot(dx, dy);
      const size = Math.min(0.15, fl * 0.46);
      const xm = (s.wm + s.wt) / 2, ymid = (s.ym + s.yt) / 2;
      for (const sx of [1, -1]) {
        const n = [(sx * dy) / fl, -dx / fl, 0]; // outward panel normal
        const ev = [(sx * dx) / fl, dy / fl, 0]; // "up" along the panel
        roundel(gb, L.num, [sx * xm + n[0] * 0.03, ymid + n[1] * 0.03, zc], [0, 0, -sx], ev, n, size, white, black);
      }
    }
    if (L.livery === 'race' && L.num > 0) {
      if (B.roof) roundel(gb, L.num, [0, B.roof[2] + 0.064, (B.roof[0] + B.roof[1]) / 2], [-1, 0, 0], [0, 0, 1], [0, 1, 0], 0.3, white, black);
      else roundel(gb, L.num, [0, topY(1.2) + 0.032, 1.25], [-1, 0, 0], [0, 0, 1], [0, 1, 0], 0.26, white, black);
    }

    // ---- mirrors
    // On a car with a roof the mirror hangs off the base of the A-pillar; on
    // an open one there IS no pillar there, so it went on the door top - and
    // the stalk was starting 6 cm above the bodywork, in mid-air.
    const mz = (B.cockpit ? scZ - 0.14 : cN.z - 0.1);
    const ms = secAt(B, mz);
    const mY = ms.yt - 0.03;
    for (const sx of [-1, 1]) {
      const bx = surfX(ms, mY);
      const mx = sx * (bx + 0.1);
      gb.beam([sx * (bx - 0.05), mY, mz], [mx, mY + 0.045, mz - 0.02], 0.045, 0.035, dark);
      gb.box(mx + sx * 0.03, mY + 0.08, mz - 0.03, 0.14, 0.1, 0.08, L.livery === 'roof' ? acc : body);
      gb.box(mx + sx * 0.03, mY + 0.08, mz - 0.075, 0.12, 0.08, 0.01, C(0x9fb4c8));
    }

    // ---- nose + tail
    const grilleW = B.grilleW || (car.body === 'muscle' ? 1.2 : 0.9);
    if (B.flush) {
      // (v5 EV: no grille — a closed nose with a light bar)
      gb.box(0, fy - 0.02, fz + 0.01, fS.wm * 2 - 0.3, 0.025, 0.03, light);
    } else {
      gb.box(0, fy - 0.14, fz - 0.025, grilleW, 0.15, 0.06, dark);
      for (let k = 0; k < 3; k++) gb.box(0, fy - 0.19 + k * 0.05, fz + 0.008, grilleW - 0.06, 0.012, 0.02, car.body === 'muscle' ? chrome : carbon);
    }
    gb.box(0, fS.yb + 0.07, fz - 0.03, fS.wb * 2 - 0.1, 0.12, 0.08, dark); // lower bumper
    // plate: white back plate, then the lighter face 1 cm proud (was 1 mm)
    gb.box(0, fS.yb + 0.16, fz + 0.015, 0.44, 0.1, 0.02, white);
    gb.box(0, fS.yb + 0.16, fz + 0.03, 0.4, 0.06, 0.01, C(0xc9d2dc));
    // headlights: bezel + lens + DRL strip. The bezel's face used to sit
    // exactly ON the nose (same plane = z-fighting); now every layer stands
    // proud of the one behind it, and the DRL no longer overlaps the lens.
    const hlX = B.hlX || (car.body === 'hatch' || car.body === 'muscle' ? 0.6 : 0.56);
    // A skin draws its own face, so the stock lamps stay off: drawn together
    // the pop-up car had four headlights and the GTD's bars were buried
    // inside the stock units where nobody could see them.
    if (!SK) for (const sx of [-1, 1]) {
      gb.box(sx * hlX, fy, fz - 0.02, 0.4, 0.16, 0.06, dark);
      gb.box(sx * hlX, fy + 0.02, fz, 0.34, 0.08, 0.05, light);
      gb.box(sx * (hlX + 0.02), fy - 0.05, fz, 0.28, 0.02, 0.04, white);
    }
    // rear: diffuser + fins, plate, exhaust tips, tail lights (dynamic range)
    gb.box(0, rS.yb + 0.06, rz + 0.02, rS.wb * 2 - 0.2, 0.1, 0.1, dark);
    gb.box(0, ry - 0.14, rz - 0.015, 0.44, 0.1, 0.02, white);
    gb.box(0, ry - 0.14, rz - 0.03, 0.4, 0.06, 0.01, C(0xc9d2dc));
    const exKind = P.exhaust;
    const exR = (P.induction === 't2' ? 0.075 : P.induction === 'na' ? 0.045 : 0.06) + (exKind === 'straight' ? 0.03 : exKind === 'sport' ? 0.012 : 0);
    const exY = rS.yb + 0.08;
    const exXs = car.body === 'muscle' || B.twinEx || P.induction !== 'na' || exKind !== 'stock' ? [0.45, -0.45] : [car.body === 'kei' ? 0.35 : 0.45];
    if (exKind === 'straight' && car.body !== 'muscle' && L.tips !== 'quad') exXs.splice(0, exXs.length, 0.12, -0.12); // centre-exit (a quad needs the width, below)
    if (car.ev) exXs.length = 0; // (v5: nothing to exhaust)
    // v5 exhaust tips (looks): quad, burnt titanium, or out of the sides
    const tipCol = L.tips === 'burnt' ? C(0x6a62c8) : chrome;
    // Quad tips: four SMALLER pipes spread across the back, which is how a
    // real quad system works and the only way four of them fit. A fixed 0.09
    // split at full pipe size had them growing through each other - worst on
    // a straight-piped big-turbo car, where the exits move to the centreline
    // and the pipes are at their fattest.
    let tipR = exR;
    if (L.tips === 'quad' && exXs.length) {
      tipR = exR * 0.74;
      const spread = Math.max(0.075, tipR * 1.18);
      exXs.splice(0, exXs.length, ...exXs.flatMap((x) => [x + spread, x - spread]));
    }
    // Where the pipes actually END, in body space - this is what the flames,
    // shift puffs and nitrous come out of. It used to be derived from the rear
    // tip positions no matter what was fitted, so side exits breathed fire out
    // of a bumper that had no pipes in it.
    // Diffuser fins, drawn once the pipe positions are known: a fin standing
    // exactly where a tail pipe comes out had the two growing through each other.
    for (const x of [-0.3, 0, 0.3]) if (L.tips === 'side' || !exXs.some((ex) => Math.abs(ex - x) < 0.13)) gb.box(x, rS.yb + 0.03, rz + 0.05, 0.02, 0.09, 0.14, black);
    let exOut = null;
    if (L.tips !== 'side') for (const x of exXs) gb.cylZ(x, exY, rz - 0.035, tipR, 0.15, 8, tipCol, black);
    else if (!car.ev) {
      exOut = [];
      for (const sx of [-1, 1]) {
        const zc = (B.wheelZ[0] + B.wheelZ[1]) / 2 - 0.2, sS = secAt(B, zc);
        gb.box(sx * (surfX(sS, sS.yb + 0.05) + 0.06), sS.yb + 0.02, zc, 0.12, 0.12, 0.7, black);
        gb.box(sx * (surfX(sS, sS.yb + 0.05) + 0.13), sS.yb + 0.02, zc + 0.36, 0.1, 0.1, 0.04, C(0x6a62c8));
        exOut.push([sx * (surfX(sS, sS.yb + 0.05) + 0.2), sS.yb + 0.02, zc + 0.4]);
      }
    }
    if (B.flush) gb.box(0, ry + 0.06, rz - 0.01, rS.wm * 2 - 0.25, 0.03, 0.03, C(0x8a1010)); // light bar
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
    const wheelY = WR - rideH; // wheel centre in body space
    if (L.kit !== 'wide') for (const wz of B.wheelZ) {
      for (const sx of [-1, 1]) {
        const K = 9;
        for (let k = 0; k < K; k++) {
          const a0 = 0.15 + (k / K) * (Math.PI - 0.3), a1 = 0.15 + ((k + 1) / K) * (Math.PI - 0.3);
          const pt = (r, a) => {
            const y = wheelY + Math.sin(a) * r, z = wz + Math.cos(a) * r;
            return [sx * (surfX(secAt(B, z), Math.max(y, secAt(B, z).yb)) + 0.004), y, z];
          };
          // A narrower ring: at 10 cm deep and in tyre black it read as a
          // slab stuck on the side of a narrow car. A skin can ask for it in
          // body colour too (a standard little roadster's arches are painted).
          gb.quadN(pt(0.37 * wk, a0), pt(0.44 * wk, a0), pt(0.44 * wk, a1), pt(0.37 * wk, a1), SK && SK.archBody ? body : rubber, [sx, 0, 0]);
        }
      }
    }
    // (brake calipers are built below as their own mesh on the NON-rolling
    // group: in the body mesh they leaned with the body and slid up and down
    // out of the wheels in every corner)
    // fuel cap
    const fcz = (B.wheelZ[1] + rz) / 2 + 0.1, fcs = secAt(B, fcz);
    gb.disc([-(surfX(fcs, fcs.ym + 0.12) + 0.006), fcs.ym + 0.12, fcz], [0, 1, 0], [0, 0, 1], [-1, 0, 0], 0.07, 8, dark);

    // ---- induction visuals
    // (a mid-engined car wears its blower / scoop / vents on the engine deck)
    const [hz0, hz1r] = B.deck || B.hood;
    // Pop-up lamps own the front of the bonnet; a vent or scoop centred on the
    // whole bonnet ran straight into them, so on a pop-up car it stops short.
    const hz1 = SK && SK.popups ? Math.min(hz1r, B.hood[1] - 0.5) : hz1r;
    // A box that sits ON the sloping hood: its bottom follows the hood's top
    // surface front-to-back (sunk 1 cm so no gap shows). Flat boxes used to
    // float at one end and sink at the other on every sloped bonnet.
    const topBox = (x, zc, w, len, h, col, lift) => {
      const z0 = zc - len / 2, z1 = zc + len / 2, l = (lift || 0) - 0.01;
      const y0 = topY(z0) + l, y1 = topY(z1) + l;
      const v = [[x - w / 2, y0, z0], [x + w / 2, y0, z0], [x + w / 2, y1, z1], [x - w / 2, y1, z1], [x - w / 2, y0 + h, z0], [x + w / 2, y0 + h, z0], [x + w / 2, y1 + h, z1], [x - w / 2, y1 + h, z1]];
      const cy = (y0 + y1) / 2 + h / 2;
      for (const q of [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]]) gb.quad(v[q[0]], v[q[1]], v[q[2]], v[q[3]], col, x, cy, zc);
    };
    if (P.induction === 'sc') {
      const z = hz0 + 0.45;
      topBox(0, z, 0.46, 0.6, 0.27, chrome);
      topBox(0, z, 0.36, 0.32, 0.08, black, 0.26);
      for (const x of [-0.12, 0, 0.12]) topBox(x, z, 0.08, 0.28, 0.06, chrome, 0.33); // injector hats
    } else if (P.induction === 't1') {
      const z = (hz0 + hz1) / 2;
      topBox(0, z, 0.6, 0.5, 0.07, black);
      for (let k = 0; k < 4; k++) topBox(0, z - 0.18 + k * 0.12, 0.5, 0.03, 0.015, carbon, 0.065);
    } else if (P.induction === 't2') {
      // The scoop fits the bonnet it is on: at a fixed 0.9 m it was longer
      // than a small car's whole bonnet and ran back into the windscreen.
      const sl = Math.min(0.9, hz1 - hz0 - 0.08);
      const z = Math.max(hz0 + sl / 2 + 0.04, (hz0 + hz1) / 2 - 0.1);
      topBox(0, z, 0.7, sl, 0.22, carbonHood ? carbon : body);
      topBox(0, z + sl / 2 + 0.005, 0.56, 0.02, 0.12, black, 0.06); // scoop mouth
      gb.box(0, fy - 0.12, fz + 0.03, 1.1, 0.2, 0.06, chrome); // intercooler
      for (let k = 0; k < 5; k++) gb.box(0, fy - 0.2 + k * 0.04, fz + 0.065, 1.04, 0.01, 0.01, dark);
    }
    if (P.cooling === 'race') {
      gb.box(0, fS.yb + 0.1, fz + 0.02, 1.2, 0.1, 0.05, black); // big duct
      for (const sx of [-1, 1]) topBox(sx * 0.3, hz1 - 0.3, 0.3, 0.35, 0.028, black); // hood vents
    } else if (P.cooling === 'radiator') gb.box(0, fS.yb + 0.1, fz + 0.015, 0.8, 0.08, 0.04, carbon);
    if (P.ecu === 'stage2') for (const sx of [-1, 1]) topBox(sx * 0.55, hz0 + 0.3, 0.14, 0.3, 0.025, black); // hood pins

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
      gb.box(ww / 2, wy + 0.03, tz - 0.08, 0.04, 0.17, chord + 0.06, black);
      gb.box(-ww / 2, wy + 0.03, tz - 0.08, 0.04, 0.17, chord + 0.06, black);
      gb.box(0, fS.yb - 0.03, fz - 0.05, fS.wb * 2 + (big ? 0.18 : 0.04), 0.04, big ? 0.4 : 0.28, black);
      if (big) {
        if (L.tips !== 'side') {
          const rkS = secAt(B, 0), rkX = surfX(rkS, rkS.yb + 0.08) + 0.02;
          gb.box(rkX, rkS.yb + 0.04, 0, 0.1, 0.12, car.len * 0.55, carbon);
          gb.box(-rkX, rkS.yb + 0.04, 0, 0.1, 0.12, car.len * 0.55, carbon);
        }
        gb.box(0.85, fy - 0.05, fz - 0.25, 0.3, 0.03, 0.2, carbon, 0.4);
        gb.box(-0.85, fy - 0.05, fz - 0.25, 0.3, 0.03, 0.2, carbon, -0.4);
      }
    }
    // ---- wide tyres get fender flares; rally gets mud flaps + light pod
    if ((P.width === 'wide' && L.kit !== 'wide') || car.body === 'truck') {
      for (const wz of B.wheelZ) for (const sx of [-1, 1]) gb.box(sx * (wheelX + 0.06), wheelY + 0.29 * wk, wz, 0.18, 0.1, 0.95 * wk, black);
    }
    if (P.suspension === 'rally') {
      for (const sx of [-1, 1]) gb.box(sx * wheelX, WR - 0.05, B.wheelZ[1] - 0.45 * wk, 0.3, 0.34, 0.03, black);
      gb.box(0, fy + 0.09, fz + 0.06, 0.9, 0.14, 0.06, black);
      for (const lx of [-0.3, -0.1, 0.1, 0.3]) gb.box(lx, fy + 0.02, fz + 0.1, 0.14, 0.1, 0.03, light);
    }
    // v5 body kits (looks only)
    if (L.kit === 'street' || L.kit === 'wide') {
      gb.box(0, fS.yb - 0.04, fz - 0.06, fS.wb * 2 + 0.06, 0.03, 0.26, black); // splitter
      gb.box(0, rS.yb + 0.02, rz + 0.1, rS.wb * 2 - 0.1, 0.06, 0.24, carbon); // diffuser
      if (L.kit !== 'wide') sideBand(midS.yb - 0.03, midS.yb + 0.08, carbon, rz + 0.3, fz - 0.35, 0.05); // skirts (the widebody sill is its own)
    }
    if (L.kit === 'wide') {
      // A real flare is an ARCH over the wheel that blends back into the body
      // at each end. This used to be two plain boxes per wheel, which read as
      // exactly that: a rectangle stuck on near the wheel. Now it is a strip
      // of segments swept over the top of the tyre, standing proudest at the
      // crown and tapering to nothing front and back, with a sill joining the
      // front and rear arches so the car reads as one wide body.
      const R = WR * wk + 0.1; // arch radius, a little clear of the tyre
      const SEG = 9, OUT = 0.17; // how far the widest point stands out
      for (const wz of B.wheelZ) {
        for (const sx of [-1, 1]) {
          for (let i = 0; i < SEG; i++) {
            const a0 = Math.PI * (0.06 + (0.88 * i) / SEG), a1 = Math.PI * (0.06 + (0.88 * (i + 1)) / SEG);
            const am = (a0 + a1) / 2;
            // taper: proud over the crown, flush where it meets the body
            const t = Math.sin(am);
            const out = OUT * (0.35 + 0.65 * t);
            const y0 = wheelY + Math.sin(a0) * R, z0 = wz + Math.cos(a0) * R;
            const y1 = wheelY + Math.sin(a1) * R, z1 = wz + Math.cos(a1) * R;
            const xi = sx * (wheelX - 0.02), xo = sx * (wheelX - 0.02 + out);
            // Outer skin, outer wall and the lip underneath. Every face is
            // wound against the WHEEL CENTRE as the inside reference, so the
            // mirrored side comes out facing the right way too - written by
            // hand, the left flare was inside-out and you could see through it.
            const ix = sx * wheelX, iy = wheelY, iz = wz;
            gb.quad([xi, y0, z0], [xo, y0 - 0.03, z0], [xo, y1 - 0.03, z1], [xi, y1, z1], body, ix, iy, iz);
            gb.quad([xo, y0 - 0.03, z0], [xo, y0 - 0.12, z0], [xo, y1 - 0.12, z1], [xo, y1 - 0.03, z1], body, ix, iy, iz);
            gb.quad([xo, y0 - 0.12, z0], [xi, y0 - 0.13, z0], [xi, y1 - 0.13, z1], [xo, y1 - 0.12, z1], dark, ix, iy, iz);
          }
        }
      }
      // sill between the arches, so the widened track carries down the flank
      const sillZ0 = Math.min(B.wheelZ[0], B.wheelZ[1]) + R * 1.02, sillZ1 = Math.max(B.wheelZ[0], B.wheelZ[1]) - R * 1.02;
      for (const sx of [-1, 1]) {
        // (v5.4: it spans from INSIDE the flank out to the flare line, so it
        // meets the body on any car - at a fixed width it hovered off the
        // side of a narrow one)
        const sS = secAt(B, (sillZ0 + sillZ1) / 2);
        const y = sS.yb + 0.08, xin = surfX(sS, y) - 0.03, xout = Math.max(xin + 0.08, wheelX - 0.02 + OUT * 0.47);
        gb.box(sx * (xin + xout) / 2, y, (sillZ0 + sillZ1) / 2, xout - xin, 0.16, Math.abs(sillZ1 - sillZ0), body);
      }
    }
    if (L.kit === 'bash' || L.kit === 'drift') {
      const bx = fS.wb - 0.1, by = fS.yb + 0.12, bz = fz + 0.14;
      gb.beam([-bx, by, bz], [bx, by, bz], 0.06, 0.06, dark);
      gb.beam([-bx, by + 0.22, bz - 0.02], [bx, by + 0.22, bz - 0.02], 0.05, 0.05, dark);
      for (const sx of [-1, 1]) gb.beam([sx * bx, by - 0.02, bz], [sx * bx, by + 0.24, bz - 0.02], 0.05, 0.05, dark);
      for (const sx of [-1, 1]) gb.beam([sx * (bx - 0.05), by, bz], [sx * (bx - 0.05), by, fz - 0.1], 0.04, 0.04, dark);
    }
    if (L.kit === 'drift') {
      for (const sx of [-1, 1]) gb.box(sx * (fS.wm - 0.02), fy - 0.12, fz - 0.2, 0.26, 0.025, 0.18, carbon, sx * 0.35); // canards
      if (B.roof) gb.box(0, B.roof[2] + 0.018, B.roof[1] - 0.25, 0.38, 0.05, 0.26, C(0x15171b)); // roof vent
    }
    if (L.spoiler !== 'none' && P.aero === 'none' && !B.rallyKit && !B.bed && !(SK && SK.wing)) {
      // Sit it on the BODY, not on B.trunkY - that number is the top of the
      // tailgate, which on a hatchback or a kei van is most of a metre above
      // the bodywork at the very back, so the spoiler hung in mid-air (43 cm
      // clear on the hatch, 58 cm on the kei). A hatchback's spoiler belongs
      // at the trailing edge of the ROOF; a boot-lid car's on the deck. And
      // take the width from the car it is bolted to rather than a constant.
      const hatchy = !!B.roof && ty - secAt(B, tz).yt > 0.18;
      const spZ = hatchy ? B.roof[0] + 0.05 : tz;
      const spS = secAt(B, spZ);
      const spY = hatchy ? B.roof[2] : spS.yt;
      const spW = Math.max(0.45, spS.wt - 0.04); // half-width of the deck there
      if (L.spoiler === 'duck') {
        gb.box(0, spY + 0.03, spZ - 0.06, spW * 2, 0.05, 0.19, body, 0);
        gb.beam([-spW, spY + 0.07, spZ - 0.13], [spW, spY + 0.07, spZ - 0.13], 0.05, 0.11, body);
      } else if (L.spoiler === 'whale') {
        gb.box(0, spY + 0.06, spZ - 0.04, spW * 2, 0.05, 0.46, body);
        gb.box(0, spY + 0.13, spZ - 0.26, spW * 2, 0.12, 0.04, black);
        for (const sx of [-1, 1]) gb.box(sx * (spW - 0.03), spY + 0.09, spZ - 0.04, 0.04, 0.1, 0.46, black);
      } else if (L.spoiler === 'roof' && B.roof) {
        const [rz0, , ryy] = B.roof;
        gb.box(0, ryy + 0.04, rz0 - 0.1, cab[1].wt * 2 + 0.05, 0.04, 0.34, L.livery === 'none' ? body : acc);
      }
    }
    // ---- v5.3 SKINS -------------------------------------------------------
    // Cosmetic alternate identities. They keep the car's silhouette (the
    // muscle body IS a fastback, the roadster body IS a small drop-top) and
    // add the things you actually recognise a car by.
    if (SK && SK.id === 'gtd') {
      const tS = secAt(B, tz);
      // Swan-neck wing: two uprights off the deck, the blade hung UNDER their
      // tops rather than sitting on posts - that is the detail that reads.
      // Level with the roof, not hovering above it, on uprights you can see.
      const wy = Math.min((B.roof ? B.roof[2] : tS.yt + 0.5) + 0.02, tS.yt + 0.46);
      const wz = tz - 0.14, ww = Math.max(0.86, tS.wt + 0.02);
      // Laid over the photograph, the blade runs from just behind the tail to
      // well over the deck - a deep chord, not a plank hung off the back.
      const wc = wz + 0.04, ch = 0.54;
      for (const sx of [-1, 1]) {
        gb.beam([sx * (ww - 0.2), tS.yt - 0.03, wc + 0.36], [sx * (ww - 0.2), wy, wc + 0.1], 0.09, 0.13, black);
        gb.box(sx * (ww - 0.2), wy - 0.035, wc + 0.02, 0.1, 0.07, 0.24, black); // swan neck, over the top
      }
      gb.box(0, wy - 0.07, wc, ww * 2, 0.05, ch, carbon, 0);
      gb.box(0, wy - 0.02, wc - ch / 2 + 0.015, ww * 2, 0.1, 0.03, carbon); // gurney
      // End plates the size of the blade they close off, not of the boot lid.
      for (const sx of [-1, 1]) gb.box(sx * ww, wy - 0.055, wc, 0.035, 0.18, ch + 0.04, black);
      // Louvred bonnet: slats across the top, the GTD's clearest signature
      // from any angle that matters in this game.
      const [hz0, hz1v] = B.hood;
      for (let i = 0; i < 4; i++) {
        const z = hz0 + 0.34 + i * 0.19;
        topBox(0, z, 0.86, 0.1, 0.035, black);
      }
      // A vent RECESSED into the fender behind the front wheel: a dark
      // opening with slats inside it, set slightly under the surface. Three
      // black boxes stuck on the outside just looked stuck on.
      for (const sx of [-1, 1]) {
        const zc = B.wheelZ[0] - 0.52, fsS = secAt(B, zc);
        const fx0 = surfX(fsS, fsS.ym + 0.08);
        gb.box(sx * (fx0 - 0.015), fsS.ym + 0.12, zc, 0.03, 0.17, 0.34, C(0x14161a)); // the opening
        for (let i = 0; i < 3; i++) gb.box(sx * (fx0 - 0.005), fsS.ym + 0.07 + i * 0.05, zc, 0.02, 0.022, 0.32, dark, 0); // slats
        // and a smaller one on the rear quarter, ahead of the back wheel
        const qz = B.wheelZ[1] + 0.72, qS = secAt(B, qz);
        const qx0 = surfX(qS, qS.ym + 0.14);
        gb.box(sx * (qx0 - 0.015), qS.ym + 0.16, qz, 0.03, 0.13, 0.26, C(0x14161a));
        for (let i = 0; i < 2; i++) gb.box(sx * (qx0 - 0.005), qS.ym + 0.13 + i * 0.055, qz, 0.02, 0.022, 0.24, dark, 0);
      }
      // Three-bar lamps at both ends. The stock tail block is already there
      // and is what the brake lights animate, so the bars are cut into it with
      // dark separators rather than replacing it - the lights still work.
      gb.box(0, ry - 0.01, rz - 0.012, rS.wb * 2 - 0.16, 0.24, 0.02, C(0x15171b)); // the panel they sit in
      for (const sx of [-1, 1]) {
        for (const d of [-0.13, 0.13]) gb.box(sx * 0.56 + d, ry, rz - 0.032, 0.035, 0.14, 0.03, black);
        gb.box(sx * 0.56, ry - 0.09, rz - 0.03, 0.44, 0.04, 0.03, black); // under-shadow
      }
      // and at the front: three slim bars set into a blunt, wide nose
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 3; i++) gb.box(sx * 0.58, fS.ym + 0.16 + i * 0.055, fz + 0.022, 0.4, 0.028, 0.03, C(0xf2efe2));
        gb.box(sx * 0.58, fS.ym + 0.215, fz + 0.005, 0.44, 0.21, 0.03, C(0x15171b)); // the lamp housing behind them
      }
      // the big lower grille
      gb.box(0, fS.yb + 0.16, fz + 0.005, 1.12, 0.26, 0.06, C(0x101216));
      for (let i = 0; i < 5; i++) gb.box(-0.44 + i * 0.22, fS.yb + 0.16, fz + 0.032, 0.04, 0.24, 0.02, black);

      // splitter with end plates, and a proper diffuser
      gb.box(0, fS.yb - 0.022, fz + 0.03, fS.wb * 2 + 0.02, 0.04, 0.26, carbon);
      for (const sx of [-1, 1]) gb.box(sx * (fS.wb + 0.01), fS.yb + 0.035, fz + 0.02, 0.03, 0.12, 0.24, carbon);
      for (const sx of [-1, 1]) gb.box(sx * 0.45, rS.yb + 0.08, rz - 0.018, 0.26, 0.17, 0.04, C(0x101216)); // the outlets the pipes come out of
      gb.box(0, rS.yb + 0.01, rz + 0.14, rS.wb * 2 - 0.06, 0.09, 0.3, carbon);
      for (const sx of [-0.42, -0.14, 0.14, 0.42]) gb.box(sx * (rS.wb * 2 - 0.1), rS.yb + 0.03, rz + 0.14, 0.03, 0.13, 0.3, black);
    } else if (SK && SK.id === 'miata') {
      // Pop-up headlamps, up. Nothing else about this car says it so loudly.
      // Pop-ups, up. Sunk INTO the bonnet rather than perched on it: the pod
      // starts below the panel line so there is no gap under it, and the
      // recess it swings out of is drawn behind it.
      const pz = B.hood[1] - 0.2, hS = secAt(B, pz);
      for (const sx of [-1, 1]) {
        const x = sx * 0.36, y = hS.yt;
        gb.box(x, y - 0.008, pz - 0.17, 0.3, 0.04, 0.2, C(0x15171b)); // the recess it swings out of, behind it
        gb.box(x, y + 0.06, pz, 0.3, 0.14, 0.2, body); // the pod, hinged at the back
        gb.box(x, y + 0.06, pz + 0.098, 0.22, 0.1, 0.02, C(0xf6f4e8)); // the lens, facing forward
      }
      // oval intake under the nose
      gb.box(0, fS.yb + 0.055, fz + 0.01, 0.8, 0.12, 0.07, black);
      gb.box(0, fS.yb + 0.055, fz + 0.035, 0.7, 0.08, 0.03, C(0x101216));
      // (the roll hoops come with the open cockpit itself - see B.cockpit)
      // Small round lamps at the tail, and a chrome bumper strip - the stock
      // tail block stays underneath so the brake lights still animate.
      for (const sx of [-1, 1]) {
        gb.box(sx * 0.46, ry + 0.005, rz - 0.028, 0.3, 0.12, 0.03, C(0xc0392b));
        gb.box(sx * 0.46, ry + 0.045, rz - 0.038, 0.22, 0.04, 0.02, C(0xffb36b)); // indicator segment
        gb.box(sx * 0.2, ry + 0.005, rz - 0.028, 0.13, 0.09, 0.03, C(0xf2efe2)); // reverse lamp, inboard of the tail lamp
      }
      gb.box(0, ry - 0.015, rz - 0.012, 0.86, 0.17, 0.02, C(0x24262c)); // the dark panel the lamps sit in
      // the little indicator pods either side of the grille
      for (const sx of [-1, 1]) gb.box(sx * 0.46, fS.yb + 0.17, fz + 0.012, 0.18, 0.07, 0.04, C(0xffb36b));

      // the soft top, folded away under its cover behind the seats
      const tnz = cab[0].z - 0.34, tnS = secAt(B, tnz);
      gb.box(0, tnS.yt + 0.008, tnz, tnS.wt * 2 - 0.18, 0.03, 0.34, C(0x1a1c20));
      gb.box(0, tnS.yt + 0.026, tnz, tnS.wt * 2 - 0.3, 0.03, 0.24, C(0x232629));
      // small round side repeaters, and a chrome strip along the flank
      for (const sx of [-1, 1]) {
        const mz = B.wheelZ[0] - 0.55, mS = secAt(B, mz);
        gb.box(sx * (surfX(mS, mS.ym) + 0.012), mS.ym + 0.02, mz, 0.02, 0.07, 0.07, C(0xff9a3c));
      }
    }

    if (B.rallyKit) {
      // v5 Group B: roof scoop, a tall rear wing (unless an aero part replaces
      // it), mud flaps, a four-lamp pod and box flares over every wheel
      const [rz0, rz1, ryy] = B.roof;
      gb.box(0, ryy + 0.09, rz1 - 0.35, 0.36, 0.12, 0.5, L.livery === 'none' ? body : acc);
      gb.box(0, ryy + 0.09, rz1 - 0.1, 0.3, 0.08, 0.02, black);
      if (P.aero === 'none') {
        const wy = ty + 0.34;
        for (const sx of [-0.55, 0.55]) gb.beam([sx, ty, tz - 0.05], [sx, wy, tz - 0.12], 0.05, 0.12, black);
        gb.box(0, wy + 0.02, tz - 0.14, 1.7, 0.05, 0.42, L.livery === 'none' ? body : acc);
        for (const sx of [-0.85, 0.85]) gb.box(sx, wy + 0.1, tz - 0.14, 0.04, 0.2, 0.46, black);
      }
      for (const wz of B.wheelZ) for (const sx of [-1, 1]) gb.box(sx * (wheelX + 0.04), wheelY + 0.3 * wk, wz, 0.16, 0.12, 0.95 * wk, body);
      if (P.suspension !== 'rally') {
        for (const sx of [-1, 1]) gb.box(sx * wheelX, WR - 0.05, B.wheelZ[1] - 0.45 * wk, 0.3, 0.34, 0.03, black);
        gb.box(0, fy + 0.09, fz + 0.06, 0.9, 0.14, 0.06, black);
        for (const lx of [-0.3, -0.1, 0.1, 0.3]) gb.box(lx, fy + 0.02, fz + 0.1, 0.14, 0.1, 0.03, light);
      }
    }
    if (B.glassRoof) {
      const [gz0, gz1, gy] = B.roof;
      gb.box(0, gy + 0.056, (gz0 + gz1) / 2, cab[1].wt * 2 - 0.2, 0.012, gz1 - gz0 - 0.1, glass);
    }
    if (P.weight !== 'stock') gb.box(0.3, fS.yb + 0.05, fz + 0.02, 0.06, 0.12, 0.06, C(0xff3030)); // tow strap

    const mat = G.CarModel.material();
    const geo = gb.geometry();
    const bodyMesh = new THREE.Mesh(geo, finishMat(L.finish)); // paint finish: gloss / metallic / chrome / matte
    bodyMesh.castShadow = true;

    // ---- wheels (geometry cached per look: size, width, compound, rim style/colour)
    const comp = G.Parts.opt('compound', P.compound);
    const wkey = [WR, tw, comp.stripe, L.rims, L.rimCol].join('|');
    let wgeo = _wheelCache[wkey];
    if (!wgeo) {
      const wgb = new GB();
      wgb.wheel(WR, 0.27 * tw * (wk > 1 ? 1.15 : 1), 12, { tyre: C(0x1c1d21), rim: C(L.rimCol), stripe: C(comp.stripe), disc: C(0x8d9299) }, L.rims);
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
      wheelDummy.position.set(xs[i], WR, zs[i]);
      wheelDummy.updateMatrix();
      wheelMesh.setMatrixAt(i, wheelDummy.matrix);
    }
    tilt.add(wheelMesh);
    // brake calipers: one small mesh on the tilt group (moves with the wheels,
    // not with body roll), coloured by the brake part, seen through the spokes
    const cgb = new GB();
    const bcol = C(G.Parts.opt('brakes', P.brakes).caliper);
    for (let i = 0; i < 4; i++) cgb.box(xs[i] + Math.sign(xs[i]) * 0.02, WR + 0.12 * wk, zs[i] - 0.07 * wk, 0.07, 0.15 * wk, 0.13 * wk, bcol);
    const calMesh = new THREE.Mesh(cgb.geometry(), mat);
    tilt.add(calMesh);
    const exhaust = exOut ? exOut.map((e) => [e[0], e[1] + rideH, e[2]]) : exXs.map((x) => [x, exY + rideH, rz - 0.18]);
    return {
      root, tilt, pivot, body: bodyMesh, wheels, wheelMesh, wheelDummy, calMesh, carId, color: paint, wheelR: WR,
      exhaust,
      // v5.3: what this build does on the overrun, so the WORLD can throw the
      // smoke without asking the mixer - the puffs have to be there whether
      // or not the sound is turned on.
      od: G.Audio && G.Audio.modSound ? (() => { const m = G.Audio.modSound(P, carId, L); return { pops: m.pops, bang: m.bang, crackle: m.crackle }; })() : null,
      lastThr: 0, ovT: 99,
      wheelLocal: xs.map((x, i) => [x, zs[i]]),
      tailLocal: [[0.56, ry + rideH, rz - 0.05], [-0.56, ry + rideH, rz - 0.05]],
      tail: { s: tailStart, e: tailEnd, rs: revStart, re: revEnd, on: 0, rev: 0 },
      glow: G.Parts.GLOW_COL[L.glow] || 0, glowFx: L.glowFx || 'steady',
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
    if (model.calMesh) model.calMesh.geometry.dispose();
    // wheel geometry is shared via _wheelCache — kept alive for reuse
  }

  // Paint finishes (v4). Matte is the plain shared Lambert material; the
  // others are Phong with a sun highlight that runs across the flat facets.
  // One material per finish, shared by every car: still one draw call a body.
  const _fin = {};
  function finishMat(f) {
    if (!f || f === 'matte') return G.CarModel.material();
    if (_fin[f]) return _fin[f];
    const o = { vertexColors: true, shininess: 40, specular: 0x2c2c2c };
    if (f === 'metal') Object.assign(o, { shininess: 70, specular: 0x5e5e5e });
    else if (f === 'chrome') Object.assign(o, { shininess: 130, specular: 0xb4b4b4 });
    else if (f === 'pearl') Object.assign(o, { shininess: 85, specular: 0x7a8cc4 }); // v5.4: a cool sheen across the highlights
    return (_fin[f] = new THREE.MeshPhongMaterial(o));
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
