// carmodel.js — low-poly cars built from lofted cross-sections, flat shaded,
// vertex-coloured (one shared material, ~5 draw calls per car). Installed parts
// are visible: wings, scoops, blowers, carbon panels, ride height, tyre width,
// compound stripes, rally flaps.
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
    // Axis-aligned box (optionally yaw-rotated about its centre).
    box(cx, cy, cz, sx, sy, sz, col, rotY) {
      const hx = sx / 2, hy = sy / 2, hz = sz / 2;
      const cr = Math.cos(rotY || 0), sr = Math.sin(rotY || 0);
      const P = (x, y, z) => [cx + x * cr + z * sr, cy + y, cz - x * sr + z * cr];
      const v = [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(-hx, hy, -hz), P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)];
      const f = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];
      for (const q of f) this.quad(v[q[0]], v[q[1]], v[q[2]], v[q[3]], col, cx, cy, cz);
    }
    // Lofted hull through hexagonal sections {z, yb, ym, yt, wb, wm, wt}.
    loft(secs, col, colTop, skipBottom) {
      const ring = (s) => [[-s.wb, s.yb, s.z], [s.wb, s.yb, s.z], [s.wm, s.ym, s.z], [s.wt, s.yt, s.z], [-s.wt, s.yt, s.z], [-s.wm, s.ym, s.z]];
      const R = secs.map(ring);
      let cy = 0, cz = 0;
      secs.forEach((s) => { cy += (s.yb + s.yt) / 2; cz += s.z; });
      cy /= secs.length; cz /= secs.length;
      for (let k = 0; k < R.length - 1; k++) {
        const A = R[k], B = R[k + 1];
        const iz = (secs[k].z + secs[k + 1].z) / 2;
        const icy = (secs[k].yb + secs[k].yt + secs[k + 1].yb + secs[k + 1].yt) / 4;
        for (let e = 0; e < 6; e++) {
          if (skipBottom && e === 0) continue;
          const e2 = (e + 1) % 6;
          const c = e === 3 && colTop ? colTop : col;
          this.quad(A[e], A[e2], B[e2], B[e], c, 0, icy, iz);
        }
      }
      // caps
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
    // Cylinder along X (wheels). Outer tread + side walls + hub disc.
    wheel(radius, width, n, colTyre, colHub, colStripe) {
      const hw = width / 2;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        const y0 = Math.cos(a0) * radius, z0 = Math.sin(a0) * radius, y1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
        this.quad([-hw, y0, z0], [hw, y0, z0], [hw, y1, z1], [-hw, y1, z1], colTyre, 0, 0, 0);
        for (const sx of [-1, 1]) {
          const x = sx * hw;
          const ri = radius * 0.62, rs = radius * 0.8;
          const yi0 = Math.cos(a0) * ri, zi0 = Math.sin(a0) * ri, yi1 = Math.cos(a1) * ri, zi1 = Math.sin(a1) * ri;
          const ys0 = Math.cos(a0) * rs, zs0 = Math.sin(a0) * rs, ys1 = Math.cos(a1) * rs, zs1 = Math.sin(a1) * rs;
          // sidewall ring (tyre), stripe ring, hub
          this.quad([x, ys0, zs0], [x, y0, z0], [x, y1, z1], [x, ys1, zs1], colTyre, -sx * 5, 0, 0);
          this.quad([x, yi0, zi0], [x, ys0, zs0], [x, ys1, zs1], [x, yi1, zi1], colStripe, -sx * 5, 0, 0);
          this.tri([x * 1.02, 0, 0], [x * 1.02, yi0, zi0], [x * 1.02, yi1, zi1], i % 2 ? colHub : colHub.clone().multiplyScalar(0.8), -sx * 5, 0, 0);
        }
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
      roof: [-0.95, 0.05, 1.29], hood: [0.9, 2.0, 0.8], trunkZ: -1.8, trunkY: 0.85, wheelZ: [1.35, -1.25],
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
      roof: [-1.6, 0.2, 1.42], hood: [1.0, 1.9, 0.86], trunkZ: -1.95, trunkY: 1.3, wheelZ: [1.25, -1.25],
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
      cockpit: true, hood: [0.7, 1.8, 0.74], trunkZ: -1.6, trunkY: 0.77, wheelZ: [1.2, -1.2],
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
      roof: [-0.95, 0.0, 1.34], hood: [0.75, 2.3, 0.92], trunkZ: -2.05, trunkY: 0.93, wheelZ: [1.5, -1.4],
    },
  };

  function lighten(hex, k) {
    const c = new THREE.Color(hex);
    const hsl = {};
    c.getHSL(hsl);
    c.setHSL(hsl.h, hsl.s, U.clamp(hsl.l + k, 0, 1));
    return c;
  }

  // Build a car. `parts` = installed map. Returns an object the World animates.
  function build(carId, colorHex, parts) {
    const car = G.Parts.CARS[carId] || G.Parts.CARS.vandal;
    const P = Object.assign({}, G.Parts.STOCK, parts || {});
    const B = BODIES[car.body];
    const gb = new GB();
    const body = C(colorHex);
    const bodyTop = lighten(colorHex, 0.06);
    const dark = C(0x1b1f27), glass = C(0x243447), chrome = C(0xcfd6de), carbon = C(0x2a2d33), black = C(0x121418);
    const light = C(0xfff4c2), tail = C(0xff2a2a), stripe = C(0xf7f7f7);

    gb.loft(B.body, body, bodyTop);
    gb.loft4(B.cabin, glass);
    if (B.roof) {
      const [z0, z1, y] = B.roof;
      const w = B.cabin[1].wt * 2 - 0.02;
      gb.box(0, y + 0.03, (z0 + z1) / 2, w, 0.06, z1 - z0, P.weight === 'w3' ? carbon : body);
    }
    if (B.cockpit) {
      gb.box(0, 0.74, -0.45, 1.2, 0.08, 1.2, dark);
      gb.box(0.36, 0.98, -0.8, 0.08, 0.4, 0.08, chrome); // roll hoops
      gb.box(-0.36, 0.98, -0.8, 0.08, 0.4, 0.08, chrome);
      gb.box(0, 1.16, -0.8, 0.8, 0.08, 0.08, chrome);
    }
    // racing stripe down the middle of hood/trunk
    const [hz0, hz1, hy] = B.hood;
    gb.box(0, hy + 0.012, (hz0 + hz1) / 2, 0.34, 0.02, hz1 - hz0, P.weight === 'w2' || P.weight === 'w3' ? carbon : stripe);
    if (P.weight === 'w2' || P.weight === 'w3') gb.box(0, hy + 0.01, (hz0 + hz1) / 2, 1.2, 0.015, hz1 - hz0 - 0.1, carbon);
    // lights
    const fz = B.body[B.body.length - 1].z, rz = B.body[0].z;
    const fy = (B.body[B.body.length - 1].ym + B.body[B.body.length - 1].yt) / 2;
    const ry = (B.body[0].ym + B.body[0].yt) / 2;
    gb.box(0.55, fy, fz - 0.02, 0.36, 0.1, 0.06, light);
    gb.box(-0.55, fy, fz - 0.02, 0.36, 0.1, 0.06, light);
    gb.box(0.55, ry, rz + 0.02, 0.4, 0.1, 0.06, tail);
    gb.box(-0.55, ry, rz + 0.02, 0.4, 0.1, 0.06, tail);
    gb.box(0, fy - 0.12, fz - 0.03, 0.9, 0.12, 0.06, dark); // grille

    // --- Induction visuals
    if (P.induction === 'sc') {
      gb.box(0, hy + 0.14, hz0 + 0.45, 0.46, 0.26, 0.6, chrome);
      gb.box(0, hy + 0.3, hz0 + 0.45, 0.36, 0.08, 0.32, black);
    } else if (P.induction === 't1') {
      gb.box(0, hy + 0.05, (hz0 + hz1) / 2, 0.6, 0.08, 0.5, black);
    } else if (P.induction === 't2') {
      gb.box(0, hy + 0.12, (hz0 + hz1) / 2 - 0.1, 0.7, 0.2, 0.9, body);
      gb.box(0, hy + 0.16, (hz0 + hz1) / 2 + 0.36, 0.56, 0.12, 0.05, black);
      gb.box(0, fy - 0.12, fz + 0.02, 1.1, 0.2, 0.06, chrome); // intercooler
    }
    // exhausts (bigger for boost)
    const exR = P.induction === 't2' ? 0.13 : P.induction === 'na' ? 0.07 : 0.1;
    gb.box(0.45, B.body[0].yb + 0.05, rz - 0.05, exR, exR, 0.2, chrome);
    if (car.body === 'muscle' || P.induction !== 'na') gb.box(-0.45, B.body[0].yb + 0.05, rz - 0.05, exR, exR, 0.2, chrome);

    // --- Aero visuals
    const ty = B.trunkY, tz = B.trunkZ;
    if (P.aero === 'a1') {
      gb.box(0, ty + 0.06, tz, 1.5, 0.05, 0.28, body);
      gb.box(0, B.body[B.body.length - 1].yb - 0.02, fz - 0.1, 1.55, 0.04, 0.25, black);
    } else if (P.aero === 'a2' || P.aero === 'a3') {
      const big = P.aero === 'a3';
      const wy = ty + (big ? 0.55 : 0.4);
      const ww = big ? 1.95 : 1.65;
      gb.box(0.5, (ty + wy) / 2, tz - 0.05, 0.06, wy - ty, 0.14, black);
      gb.box(-0.5, (ty + wy) / 2, tz - 0.05, 0.06, wy - ty, 0.14, black);
      gb.box(0, wy, tz - 0.08, ww, 0.06, big ? 0.55 : 0.42, big ? carbon : body);
      gb.box(ww / 2, wy + 0.08, tz - 0.08, 0.04, 0.26, 0.6, black);
      gb.box(-ww / 2, wy + 0.08, tz - 0.08, 0.04, 0.26, 0.6, black);
      gb.box(0, B.body[B.body.length - 1].yb - 0.03, fz - 0.05, big ? 1.9 : 1.6, 0.04, big ? 0.45 : 0.3, black);
      if (big) {
        gb.box(0.96, 0.22, 0, 0.1, 0.12, car.len * 0.55, carbon);
        gb.box(-0.96, 0.22, 0, 0.1, 0.12, car.len * 0.55, carbon);
        gb.box(0.85, fy - 0.05, fz - 0.25, 0.3, 0.03, 0.2, carbon, 0.4);
        gb.box(-0.85, fy - 0.05, fz - 0.25, 0.3, 0.03, 0.2, carbon, -0.4);
      }
    }
    // --- Wide tyres get fender flares; rally gets mud flaps + light pod
    const tw = G.Parts.opt('width', P.width).vis;
    const wheelX = car.track / 2 + 0.06 + (tw - 1) * 0.08;
    if (P.width === 'wide') {
      for (const wz of B.wheelZ) for (const sx of [-1, 1]) gb.box(sx * (wheelX + 0.06), 0.62, wz, 0.18, 0.1, 0.95, black);
    }
    if (P.suspension === 'rally') {
      for (const sx of [-1, 1]) gb.box(sx * wheelX, 0.28, B.wheelZ[1] - 0.45, 0.3, 0.34, 0.03, black);
      gb.box(0, fy + 0.02, fz + 0.06, 0.9, 0.14, 0.06, black);
      for (const lx of [-0.3, -0.1, 0.1, 0.3]) gb.box(lx, fy + 0.02, fz + 0.1, 0.14, 0.1, 0.03, light);
    }
    if (P.weight === 'w1' || P.weight === 'w2' || P.weight === 'w3') gb.box(0.3, B.body[B.body.length - 1].yb + 0.05, fz + 0.02, 0.06, 0.12, 0.06, C(0xff3030)); // tow strap

    const mat = G.CarModel.material();
    const bodyMesh = new THREE.Mesh(gb.geometry(), mat);
    bodyMesh.castShadow = true;

    // --- Wheels
    const comp = G.Parts.opt('compound', P.compound);
    const wgb = new GB();
    wgb.wheel(0.33, 0.27 * tw, 10, C(0x1c1d21), C(0xbfc6ce), C(comp.stripe));
    const wgeo = wgb.geometry();
    const root = new THREE.Group();
    const tilt = new THREE.Group(); // track banking tilt
    root.add(tilt);
    const pivot = new THREE.Group(); // body roll/pitch pivot at CG height
    pivot.position.y = 0.5;
    bodyMesh.position.y = -0.5 + (P.suspension ? G.Parts.opt('suspension', P.suspension).rideH : 0);
    pivot.add(bodyMesh);
    tilt.add(pivot);
    const wheels = [];
    const zs = [B.wheelZ[0], B.wheelZ[0], B.wheelZ[1], B.wheelZ[1]];
    const xs = [wheelX, -wheelX, wheelX, -wheelX];
    for (let i = 0; i < 4; i++) {
      const steerG = new THREE.Group();
      steerG.position.set(xs[i], 0.33, zs[i]);
      const m = new THREE.Mesh(wgeo, mat);
      m.castShadow = true;
      steerG.add(m);
      tilt.add(steerG);
      wheels.push({ steer: steerG, mesh: m });
    }
    return {
      root, tilt, pivot, body: bodyMesh, wheels, carId, color: colorHex,
      exhaust: [[0.45, B.body[0].yb + 0.05, rz - 0.15], [-0.45, B.body[0].yb + 0.05, rz - 0.15]],
      wheelLocal: xs.map((x, i) => [x, zs[i]]),
      len: car.len, rollGain: G.Parts.opt('suspension', P.suspension).roll,
      // visual suspension springs
      roll: 0, rollV: 0, pitch: 0, pitchV: 0, heave: 0, spinA: 0,
    };
  }

  function dispose(model) {
    model.body.geometry.dispose();
    if (model.wheels[0]) model.wheels[0].mesh.geometry.dispose();
  }

  let _mat = null;
  G.CarModel = {
    GB, PALETTE, COLOR_NAMES, BODIES, build, dispose, lighten,
    material() {
      if (!_mat) _mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      return _mat;
    },
  };
})(window.G);
