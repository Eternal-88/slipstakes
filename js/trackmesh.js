// trackmesh.js — builds the visual world for a Track: faceted terrain, road
// ribbon with per-surface colours, kerbs, lines, start/finish, walls and
// instanced low-poly scenery. Everything static is merged into a handful of
// meshes so the whole track costs ~12 draw calls.
'use strict';
(function (G) {
  const U = G.U;
  const C = (h) => new THREE.Color(h);

  const SURF_COL = {
    tarmac: [0x4b4f58, 0x464a52],
    dirt: [0xc0814e, 0xb77846],
    wet: [0x3b4b60, 0x43566d],
    gravel: [0xb4a58e, 0xa89a82],
    concrete: [0x8d949c, 0x858c94],
    sand: [0xe2c58f, 0xd9bb85],
  };

  function pushQuad(pos, col, a, b, c, d, colr) {
    // a,b,c,d are [x,y,z]; wound so the normal faces +Y for a road quad listed
    // left->right->right->left when looking along travel. We just emit both
    // triangles and fix orientation with an up-check.
    const tri = (p, q, r) => {
      const ux = q[0] - p[0], uz = q[2] - p[2], vx = r[0] - p[0], vz = r[2] - p[2];
      const ny = uz * vx - ux * vz;
      if (ny < 0) { const t = q; q = r; r = t; }
      pos.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
      for (let i = 0; i < 3; i++) col.push(colr.r, colr.g, colr.b);
    };
    tri(a, b, c);
    tri(a, c, d);
  }

  function meshFrom(pos, col, opts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, opts && opts.mat ? opts.mat : new THREE.MeshLambertMaterial({ vertexColors: true }));
    m.receiveShadow = true;
    return m;
  }

  function build(track) {
    const group = new THREE.Group();
    const th = track.theme;
    const N = track.N, closed = track.closed;
    const segCount = closed ? N : N - 1;
    const Y = 0.04;
    const P = (i, lat, dy) => {
      const x = track.X[i] + track.NX[i] * lat, z = track.Z[i] + track.NZ[i] * lat;
      return [x, track.heightAt(i, lat) + Y + (dy || 0), z];
    };

    // ---------------- Terrain (faceted, hills rising away from the track) ----
    {
      const b = track.bounds, m = 260;
      const x0 = b.x0 - m, x1 = b.x1 + m, z0 = b.z0 - m, z1 = b.z1 + m;
      const nx = 70, nz = 70;
      const dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;
      const H = [], D = [];
      const rng = U.rng(U.hashStr(track.id + 'terrain'));
      for (let j = 0; j <= nz; j++) {
        for (let i = 0; i <= nx; i++) {
          const x = x0 + i * dx + (i > 0 && i < nx ? (rng() - 0.5) * dx * 0.5 : 0);
          const z = z0 + j * dz + (j > 0 && j < nz ? (rng() - 0.5) * dz * 0.5 : 0);
          let best = 1e9;
          for (let k = 0; k < N; k += 2) {
            const ddx = x - track.X[k], ddz = z - track.Z[k];
            const d = ddx * ddx + ddz * ddz;
            if (d < best) best = d;
          }
          const d = Math.sqrt(best);
          const clear = track.wallD[0] + 14;
          const hill = Math.max(0, d - clear);
          const amp = 0.6 + 0.4 * Math.sin(x * 0.013 + z * 0.021) * Math.sin(z * 0.017 - x * 0.009);
          const h = Math.min(hill * 0.12, 26) * amp + (d > clear ? (rng() - 0.5) * 1.2 : 0);
          H.push([x, d < track.wallD[0] + 3 ? -0.05 : h - 0.05, z]);
          D.push(d);
        }
      }
      const pos = [], col = [];
      const g1 = C(th.ground), g2 = C(th.ground2), g3 = C(th.hill);
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const a = H[j * (nx + 1) + i], bq = H[j * (nx + 1) + i + 1], c = H[(j + 1) * (nx + 1) + i + 1], d = H[(j + 1) * (nx + 1) + i];
          const hAvg = (a[1] + bq[1] + c[1] + d[1]) / 4;
          const base = (i + j) % 3 === 0 ? g2 : g1;
          const cc = base.clone().lerp(g3, U.clamp(hAvg / 14, 0, 1));
          const cc2 = cc.clone().multiplyScalar(0.96);
          pushQuadTri(pos, col, a, bq, c, cc);
          pushQuadTri(pos, col, a, c, d, cc2);
        }
      }
      const terrain = meshFrom(pos, col);
      terrain.name = 'terrain';
      group.add(terrain);
    }

    // ---------------- Road ribbon ------------------------------------------
    {
      const pos = [], col = [];
      for (let s = 0; s < segCount; s++) {
        const i = s, j = track.idx(s + 1);
        const sid = G.SURF[track.S[i]].id;
        const pal = SURF_COL[sid] || SURF_COL.tarmac;
        const cc = C(pal[Math.floor(s / 5) % 2]);
        const w0 = track.W[i], w1 = track.W[j];
        // two strips so banking tilts correctly about the centre
        const L0 = P(i, w0), C0 = P(i, 0), R0 = P(i, -w0);
        const L1 = P(j, w1), C1 = P(j, 0), R1 = P(j, -w1);
        pushQuad(pos, col, L0, C0, C1, L1, cc);
        pushQuad(pos, col, C0, R0, R1, C1, cc);
        // Standing water: lighter puddle patches on wet sections
        if (sid === 'wet' && (s * 7) % 5 < 2) {
          const pc = C(0x5d7593);
          const o = ((s * 13) % 7) - 3;
          pushQuad(pos, col, P(i, o + 1.6, 0.01), P(i, o - 1.6, 0.01), P(j, o - 1.6, 0.01), P(j, o + 1.6, 0.01), pc);
        }
        // Runoff strips (gravel traps / sand / concrete) on non-grass themes
        if (th.runoff !== 'grass') {
          const rc = C((SURF_COL[th.runoff] || SURF_COL.sand)[s % 2]);
          const ro = track.runoff;
          pushQuad(pos, col, P(i, w0 + ro, -0.02), P(i, w0, -0.02), P(j, w1, -0.02), P(j, w1 + ro, -0.02), rc);
          pushQuad(pos, col, P(i, -w0, -0.02), P(i, -w0 - ro, -0.02), P(j, -w1 - ro, -0.02), P(j, -w1, -0.02), rc);
        }
        // Edge lines on sealed surfaces where there's no kerb
        if (sid === 'tarmac' || sid === 'wet') {
          const lc = C(0xf2f2f2);
          if (!track.KL[i]) pushQuad(pos, col, P(i, w0 - 0.35, 0.012), P(i, w0 - 0.6, 0.012), P(j, w1 - 0.6, 0.012), P(j, w1 - 0.35, 0.012), lc);
          if (!track.KR[i]) pushQuad(pos, col, P(i, -w0 + 0.6, 0.012), P(i, -w0 + 0.35, 0.012), P(j, -w1 + 0.35, 0.012), P(j, -w1 + 0.6, 0.012), lc);
          // dashed centre line on long straights
          if (track.format === 'drag') {
            for (let lane = -3; lane <= 3; lane++) {
              if (s % 4 < 2) pushQuad(pos, col, P(i, lane * 3.6 + 0.12, 0.012), P(i, lane * 3.6 - 0.12, 0.012), P(j, lane * 3.6 - 0.12, 0.012), P(j, lane * 3.6 + 0.12, 0.012), lc);
            }
          }
        }
        // Kerbs: raised red/white strips
        for (const side of [1, -1]) {
          const on = side > 0 ? track.KL[i] : track.KR[i];
          if (!on) continue;
          const kc = C(s % 2 ? 0xe8322b : 0xf5f5f5);
          const a0 = side * (w0 - 1.1), a1 = side * (w0 + 0.9), b0 = side * (w1 - 1.1), b1 = side * (w1 + 0.9);
          pushQuad(pos, col, P(i, a1, 0.05), P(i, a0, 0.05), P(j, b0, 0.05), P(j, b1, 0.05), kc);
        }
      }
      // Start/finish checker(s) + grid marks
      const checker = (dist) => {
        const f = dist / track.sp;
        const i = track.idx(Math.floor(f));
        const hw = track.W[i];
        const n = Math.round(hw * 2 / 1.0);
        for (let r = 0; r < 2; r++) {
          for (let k = 0; k < n; k++) {
            const la = hw - (k * 2 * hw) / n, lb = hw - ((k + 1) * 2 * hw) / n;
            const cc = C((k + r) % 2 ? 0x111111 : 0xffffff);
            const d0 = dist + r * 1.0, d1 = dist + (r + 1) * 1.0;
            const A = track.pointAt(d0, la), Bq = track.pointAt(d0, lb), Cq = track.pointAt(d1, lb), Dq = track.pointAt(d1, la);
            pushQuad(pos, col, [A.x, Y + 0.02, A.z], [Bq.x, Y + 0.02, Bq.z], [Cq.x, Y + 0.02, Cq.z], [Dq.x, Y + 0.02, Dq.z], cc);
          }
        }
      };
      checker(track.startDist);
      if (!closed) checker(track.finishDist);
      for (let k = 0; k < 8; k++) {
        const g = track.gridSlot(k);
        const q = track.query(g.x, g.z, g.i, {});
        const d = q.along + 2.6;
        const A = track.pointAt(d, q.lat + 1.1), Bq = track.pointAt(d, q.lat - 1.1), Cq = track.pointAt(d + 0.3, q.lat - 1.1), Dq = track.pointAt(d + 0.3, q.lat + 1.1);
        pushQuad(pos, col, [A.x, Y + 0.02, A.z], [Bq.x, Y + 0.02, Bq.z], [Cq.x, Y + 0.02, Cq.z], [Dq.x, Y + 0.02, Dq.z], C(0xf2f2f2));
      }
      // Banked sections: skirt from the raised outer edge down to the ground
      for (let s = 0; s < segCount; s++) {
        const i = s, j = track.idx(s + 1);
        if (Math.abs(track.BK[i]) < 0.01 && Math.abs(track.BK[j]) < 0.01) continue;
        const si = track.BK[i] > 0 ? -1 : 1, sj = track.BK[j] > 0 ? -1 : 1;
        const cc = C(SURF_COL.dirt[1]).multiplyScalar(0.85);
        pushQuad(pos, col, P(i, si * track.W[i], -0.01), P(i, si * (track.W[i] + 8), -0.01), P(j, sj * (track.W[j] + 8), -0.01), P(j, sj * track.W[j], -0.01), cc);
      }
      const road = meshFrom(pos, col, {
        mat: new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      });
      road.name = 'road';
      group.add(road);
    }

    // ---------------- Walls ------------------------------------------------
    {
      const pos = [], col = [];
      const q = {};
      const H = 0.9, T = 0.5;
      const wc = th.wall.map(C);
      for (const side of [1, -1]) {
        for (let s = 0; s < segCount; s++) {
          const i = s, j = track.idx(s + 1);
          const la = side * track.wallD[i], lb = side * track.wallD[j];
          // Skip where the offset curve folds (tight inside of a hairpin): the
          // wall point must genuinely be ~wallD from the nearest centreline.
          const ax = track.X[i] + track.NX[i] * la, az = track.Z[i] + track.NZ[i] * la;
          track.query(ax, az, i, q);
          if (Math.abs(q.lat) < track.wallD[i] - 0.6 || Math.abs(q.i - i) > 3 && Math.abs(q.i - i) < N - 3) continue;
          const bx = track.X[j] + track.NX[j] * lb, bz = track.Z[j] + track.NZ[j] * lb;
          track.query(bx, bz, j, q);
          if (Math.abs(q.lat) < track.wallD[j] - 0.6) continue;
          const ya = track.heightAt(i, la), yb = track.heightAt(j, lb);
          const ox = track.NX[i] * side * T, oz = track.NZ[i] * side * T;
          const oxb = track.NX[j] * side * T, ozb = track.NZ[j] * side * T;
          const c = wc[Math.floor(s / 2) % 2];
          const in0 = [ax, ya, az], in1 = [bx, yb, bz], top0 = [ax, ya + H, az], top1 = [bx, yb + H, bz];
          const out0 = [ax + ox, ya + H, az + oz], out1 = [bx + oxb, yb + H, bz + ozb];
          const gnd0 = [ax + ox, ya, az + oz], gnd1 = [bx + oxb, yb, bz + ozb];
          quadV(pos, col, in0, in1, top1, top0, c, -side, track.NX[i], track.NZ[i]);
          pushQuad(pos, col, top0, top1, out1, out0, c.clone().multiplyScalar(0.9));
          quadV(pos, col, gnd0, gnd1, out1, out0, c.clone().multiplyScalar(0.8), side, track.NX[i], track.NZ[i]);
        }
      }
      if (!closed) {
        for (const end of [0, track.N - 1]) {
          const w = track.wallD[end];
          const dirS = end === 0 ? -1 : 1;
          const d = end === 0 ? -0.6 : track.length + 0.6;
          const A = track.pointAt(d, w), Bq = track.pointAt(d, -w);
          const c = wc[0];
          const tx = track.TX[end] * dirS * T, tz = track.TZ[end] * dirS * T;
          quadV(pos, col, [A.x, 0, A.z], [Bq.x, 0, Bq.z], [Bq.x, H + 0.4, Bq.z], [A.x, H + 0.4, A.z], c, -1, track.TX[end] * dirS, track.TZ[end] * dirS);
          pushQuad(pos, col, [A.x, H + 0.4, A.z], [Bq.x, H + 0.4, Bq.z], [Bq.x + tx, H + 0.4, Bq.z + tz], [A.x + tx, H + 0.4, A.z + tz], c);
        }
      }
      const walls = meshFrom(pos, col);
      walls.castShadow = true;
      walls.name = 'walls';
      group.add(walls);
    }

    // ---------------- Scenery ----------------------------------------------
    buildScenery(track, group);
    return group;
  }

  function pushQuadTri(pos, col, a, b, c, cc) {
    // raw triangle with upward winding
    const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
    const ny = uz * vx - ux * vz;
    if (ny < 0) pos.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
    else pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) col.push(cc.r, cc.g, cc.b);
  }

  // Vertical quad wound to face direction (sgn * normal).
  function quadV(pos, col, a, b, c, d, cc, sgn, nx, nz) {
    const tri = (p, q, r) => {
      const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
      const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
      const fx = uy * vz - uz * vy, fz = ux * vy - uy * vx;
      if ((fx * nx + fz * nz) * sgn < 0) { const t = q; q = r; r = t; }
      pos.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
      for (let i = 0; i < 3; i++) col.push(cc.r, cc.g, cc.b);
    };
    tri(a, b, c);
    tri(a, c, d);
  }

  // ---- Prop geometries (vertex coloured, instanced) -----------------------
  function propGeo(kind) {
    const gb = new G.CarModel.GB();
    if (kind === 'round') {
      gb.box(0, 1.2, 0, 0.5, 2.4, 0.5, C(0x7a5236));
      ico(gb, 0, 3.6, 0, 2.2, C(0x3f9e4d));
      ico(gb, 0.6, 4.6, 0.3, 1.4, C(0x4fb45a));
    } else if (kind === 'pine') {
      gb.box(0, 0.9, 0, 0.45, 1.8, 0.45, C(0x6b4a30));
      cone(gb, 0, 1.4, 0, 2.4, 3.2, 7, C(0x2f7d4a));
      cone(gb, 0, 3.4, 0, 1.8, 2.8, 7, C(0x37905a));
      cone(gb, 0, 5.2, 0, 1.1, 2.2, 7, C(0x43a366));
    } else if (kind === 'cactus') {
      const g = C(0x4f9c56);
      gb.box(0, 2, 0, 0.7, 4, 0.7, g);
      gb.box(0.7, 2.2, 0, 0.9, 0.5, 0.5, g);
      gb.box(1.0, 2.9, 0, 0.5, 1.4, 0.5, g);
      gb.box(-0.6, 1.6, 0, 0.8, 0.5, 0.5, g);
      gb.box(-0.9, 2.2, 0, 0.5, 1.2, 0.5, g);
    } else if (kind === 'rock') {
      ico(gb, 0, 0.6, 0, 1.6, C(0x9a8f86));
      ico(gb, 1.0, 0.4, 0.6, 1.0, C(0x8a7f76));
    } else if (kind === 'redrock') {
      ico(gb, 0, 1.4, 0, 3.2, C(0xc0643c));
      ico(gb, 2.2, 0.8, 1.0, 2.0, C(0xad5733));
    } else if (kind === 'building') {
      gb.box(0, 5, 0, 10, 10, 10, C(0xdfe3ea));
      for (let y = 2; y < 10; y += 2.6) for (const x of [-3, 0, 3]) {
        gb.box(x, y, 5.02, 1.6, 1.2, 0.1, C(0x4b6b8f));
        gb.box(x, y, -5.02, 1.6, 1.2, 0.1, C(0x4b6b8f));
        gb.box(5.02, y, x, 0.1, 1.2, 1.6, C(0x4b6b8f));
        gb.box(-5.02, y, x, 0.1, 1.2, 1.6, C(0x4b6b8f));
      }
      gb.box(0, 10.3, 0, 10.4, 0.6, 10.4, C(0x9aa5b4));
    } else if (kind === 'tyres') {
      for (let k = 0; k < 3; k++) cyl(gb, 0, 0.3 + k * 0.5, 0, 0.55, 0.45, 8, C(k % 2 ? 0x1f1f1f : 0x2b2b2b));
    } else if (kind === 'cone') {
      cone(gb, 0, 0, 0, 0.35, 0.8, 6, C(0xff7a1a));
      gb.box(0, 0.03, 0, 0.8, 0.06, 0.8, C(0x222222));
    } else if (kind === 'crate') {
      gb.box(0, 1.2, 0, 2.4, 2.4, 6, C(0x2f6fed));
      gb.box(0, 2.45, 0, 2.5, 0.1, 6.1, C(0x1f4fbd));
    } else if (kind === 'crate2') {
      gb.box(0, 1.2, 0, 2.4, 2.4, 6, C(0xe8453c));
      gb.box(0, 2.45, 0, 2.5, 0.1, 6.1, C(0xb8352c));
    } else if (kind === 'hangar') {
      gb.box(0, 4, 0, 24, 8, 18, C(0xc9d2dc));
      gb.box(0, 8.4, 0, 25, 0.8, 19, C(0x7d8a99));
      gb.box(0, 3.2, 9.02, 16, 6.4, 0.1, C(0x5a6677));
    }
    return gb.geometry();
  }
  function ico(gb, x, y, z, r, c) {
    const g = new THREE.IcosahedronGeometry(r, 0);
    const p = g.attributes.position;
    const idx = g.index ? g.index.array : null;
    const get = (k) => [p.getX(k) + x, p.getY(k) * 0.8 + y, p.getZ(k) + z];
    const n = idx ? idx.length : p.count;
    for (let k = 0; k < n; k += 3) {
      const a = idx ? idx[k] : k, b = idx ? idx[k + 1] : k + 1, cc = idx ? idx[k + 2] : k + 2;
      const shade = c.clone().multiplyScalar(0.9 + ((k / 3) % 3) * 0.06);
      gb.tri(get(a), get(b), get(cc), shade, x, y, z);
    }
    g.dispose();
  }
  function cone(gb, x, y, z, r, h, n, c) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const p0 = [x + Math.cos(a0) * r, y, z + Math.sin(a0) * r], p1 = [x + Math.cos(a1) * r, y, z + Math.sin(a1) * r];
      gb.tri(p0, p1, [x, y + h, z], i % 2 ? c : c.clone().multiplyScalar(0.9), x, y + h * 0.3, z);
      gb.tri(p0, p1, [x, y, z], c.clone().multiplyScalar(0.7), x, y + 0.1, z);
    }
  }
  function cyl(gb, x, y, z, r, h, n, c) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const b0 = [x + Math.cos(a0) * r, y - h / 2, z + Math.sin(a0) * r], b1 = [x + Math.cos(a1) * r, y - h / 2, z + Math.sin(a1) * r];
      const t0 = [b0[0], y + h / 2, b0[2]], t1 = [b1[0], y + h / 2, b1[2]];
      gb.quad(b0, b1, t1, t0, c, x, y, z);
      gb.tri(t0, t1, [x, y + h / 2, z], c.clone().multiplyScalar(1.2), x, y, z);
    }
  }

  const _geoCache = {};
  const geo = (k) => _geoCache[k] || (_geoCache[k] = propGeo(k));

  function instanced(kind, items, group, shadow) {
    if (!items.length) return;
    const m = new THREE.InstancedMesh(geo(kind), G.CarModel.material(), items.length);
    const o = new THREE.Object3D();
    items.forEach((it, k) => {
      o.position.set(it.x, it.y || 0, it.z);
      o.rotation.set(0, it.r || 0, 0);
      o.scale.setScalar(it.s || 1);
      o.updateMatrix();
      m.setMatrixAt(k, o.matrix);
    });
    m.castShadow = !!shadow;
    m.receiveShadow = false;
    m.computeBoundingSphere();
    group.add(m);
  }

  function buildScenery(track, group) {
    const th = track.theme;
    const rng = U.rng(U.hashStr(track.id + 'props'));
    const b = track.bounds, M = 170;
    const q = {};
    const clearOf = (x, z, extra) => {
      track.query(x, z, -1, q);
      return Math.abs(q.lat) > q.wall + extra || q.along < 0 || (!track.closed && (q.along <= 0.5 || q.along >= track.length - 0.5) && Math.hypot(x - track.X[q.i], z - track.Z[q.i]) > q.wall + extra);
    };
    const trees = [], rocks = [], props2 = [];
    const treeKind = th.trees === 'none' ? null : th.trees;
    const count = track.format === 'drag' ? 160 : 260;
    for (let k = 0; k < count * 3 && trees.length < count; k++) {
      const x = U.lerp(b.x0 - M, b.x1 + M, rng()), z = U.lerp(b.z0 - M, b.z1 + M, rng());
      if (!clearOf(x, z, 4)) continue;
      const item = { x, z, r: rng() * 6.28, s: 0.7 + rng() * 0.8 };
      if (treeKind && rng() < 0.8) trees.push(item);
      else rocks.push(item);
    }
    if (treeKind) instanced(treeKind, trees, group, true);
    instanced(th.props === 'rocks' || th.trees === 'cactus' ? 'redrock' : 'rock', rocks, group, true);

    // Tyre stacks on the outside of corners, cones at corner apexes.
    const tyres = [], cones = [];
    for (let i = 0; i < track.N; i += 6) {
      if (Math.abs(track.K[i]) < 1 / 50) continue;
      const side = track.K[i] > 0 ? -1 : 1; // outside of the corner
      const lat = side * (track.wallD[i] + 1.2);
      tyres.push({ x: track.X[i] + track.NX[i] * lat, z: track.Z[i] + track.NZ[i] * lat, r: rng() * 6 });
      if (track.format !== 'drag' && i % 12 === 0) {
        const la = -side * (track.W[i] + 2.2);
        const cx = track.X[i] + track.NX[i] * la, cz = track.Z[i] + track.NZ[i] * la;
        if (Math.abs(la) < track.wallD[i] - 0.5 && clearOf(cx, cz, -track.runoff + 1.5)) cones.push({ x: cx, z: cz, r: 0 });
      }
    }
    instanced('tyres', tyres, group, false);
    instanced('cone', cones, group, false);

    // Theme set pieces
    if (th.props === 'city') {
      const bl = [];
      for (let i = 0; i < track.N; i += 7) {
        for (const side of [1, -1]) {
          const lat = side * (track.wallD[i] + 9);
          const x = track.X[i] + track.NX[i] * lat, z = track.Z[i] + track.NZ[i] * lat;
          if (!clearOf(x, z, 7.5)) continue;
          if (bl.some((o) => Math.hypot(o.x - x, o.z - z) < 11)) continue;
          bl.push({ x, z, r: track.H[i], s: 0.8 + rng() * 0.9 });
        }
      }
      instanced('building', bl, group, true);
    }
    if (th.props === 'harbour' || th.props === 'airstrip') {
      const cr = [], cr2 = [];
      for (let k = 0; k < 60; k++) {
        const x = U.lerp(b.x0 - 60, b.x1 + 60, rng()), z = U.lerp(b.z0 - 60, b.z1 + 60, rng());
        if (!clearOf(x, z, 8)) continue;
        (rng() < 0.5 ? cr : cr2).push({ x, z, r: Math.round(rng() * 2) * (Math.PI / 2), y: rng() < 0.25 ? 2.5 : 0 });
      }
      instanced('crate', cr, group, true);
      instanced('crate2', cr2, group, true);
      if (th.props === 'airstrip') {
        const hg = [];
        for (let k = 0; k < 6; k++) {
          const z = track.bounds.z0 + 80 + k * 120, x = (k % 2 ? 1 : -1) * (track.wallD[0] + 30);
          if (clearOf(x, z, 12)) hg.push({ x, z, r: k % 2 ? -Math.PI / 2 : Math.PI / 2 });
        }
        instanced('hangar', hg, group, true);
      }
    }
    // Grandstand + gantry at the start line (every track)
    group.add(startSetPiece(track, th));
  }

  function startSetPiece(track, th) {
    const gb = new G.CarModel.GB();
    const p = track.pointAt(track.startDist, 0);
    const hw = track.wallD[p.i] + 0.6;
    const cols = [0xff3b30, 0xffc400, 0x2f6bff, 0x22c55e, 0xff2d92];
    // gantry
    // Start posts with chequered flags. No overhead beam: with an angled
    // top-down camera an overhead gantry sits between the lens and the grid
    // and reads as a glitch band (and shadows the whole grid).
    for (const sx of [hw, -hw]) {
      gb.box(sx, 3.2, 0, 0.5, 6.4, 0.5, C(0x2a2d33));
      gb.box(sx, 6.6, 0, 0.8, 0.4, 0.8, C(th.wall[0]));
      for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) gb.box(sx - Math.sign(sx) * (0.45 + k * 0.4), 5.9 - r * 0.4, 0, 0.4, 0.4, 0.06, C((r + k) % 2 ? 0x111111 : 0xffffff));
    }
    // grandstand on the left side
    const side = 1;
    for (let r = 0; r < 5; r++) {
      const x = side * (hw + 4 + r * 1.6);
      gb.box(x, 0.5 + r * 0.8, 0, 1.6, 1 + r * 1.6, 26, C(0xd8dde4));
      for (let k = 0; k < 10; k++) gb.box(x, 1.1 + r * 1.6, -11.5 + k * 2.55, 0.9, 0.5, 1.8, C(cols[(k + r) % cols.length]));
    }
    gb.box(side * (hw + 7.2), 9.8, 0, 9, 0.4, 28, C(th.wall[0]));
    gb.box(side * (hw + 11.2), 5, 13.5, 0.4, 10, 0.4, C(0x2a2d33));
    gb.box(side * (hw + 11.2), 5, -13.5, 0.4, 10, 0.4, C(0x2a2d33));
    const m = new THREE.Mesh(gb.geometry(), G.CarModel.material());
    m.position.set(p.x, 0, p.z);
    m.rotation.y = p.h;
    m.castShadow = true;
    return m;
  }

  G.TrackMesh = { build };
})(window.G);
