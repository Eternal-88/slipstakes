// trackmesh.js — builds the visual world for a Track: faceted terrain (with a
// sea on the harbour), road ribbon with per-surface colours and a rubbered-in
// racing line, kerbs, lines, start/finish, walls, sponsor boards, corner
// marker boards, instanced low-poly scenery per theme, a grandstand with a
// crowd that bobs (and cheers), start lights, distant mountains and water.
//
// Draw-call budget: everything static is merged; repeated props are
// InstancedMesh (one call per kind). A full track is ~15-20 calls.
// Surfaces get a subtle world-space noise "grain" in the shader (one texture
// fetch) so big flat areas don't look like plastic — skipped on "low".
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

  // ---------------------------------------------------------------- grain
  let _noise = null;
  function noiseTex() {
    if (_noise) return _noise;
    const n = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = n;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(n, n);
    const rng = U.rng(9127);
    const oct = [[4, 0.45], [16, 0.33], [64, 0.22]].map(([g, w]) => {
      const v = [];
      for (let i = 0; i < g * g; i++) v.push(rng());
      return { g, w, v };
    });
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let s = 0;
        for (const o of oct) {
          const fx = (x / n) * o.g, fy = (y / n) * o.g;
          const x0 = Math.floor(fx), y0 = Math.floor(fy);
          const tx = fx - x0, ty = fy - y0;
          const at = (i, j) => o.v[(j % o.g) * o.g + (i % o.g)];
          const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
          s += o.w * U.lerp(U.lerp(at(x0, y0), at(x0 + 1, y0), sx), U.lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), sx), sy);
        }
        const k = (y * n + x) * 4;
        img.data[k] = img.data[k + 1] = img.data[k + 2] = Math.round(s * 255);
        img.data[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return (_noise = t);
  }
  let _grainOn = true;
  // Lambert + world-space grain. scale = texture repeats per metre, amt = contrast.
  function grainMat(scale, amt, extra) {
    const m = new THREE.MeshLambertMaterial(Object.assign({ vertexColors: true }, extra || {}));
    if (!_grainOn) return m;
    const tex = noiseTex();
    m.onBeforeCompile = (sh) => {
      sh.uniforms.gMap = { value: tex };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vGW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vGW; uniform sampler2D gMap;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           float gn = texture2D(gMap, vGW * ${scale.toFixed(4)}).r * 0.6 + texture2D(gMap, vGW * ${(scale * 0.17).toFixed(4)}).r * 0.4;
           diffuseColor.rgb *= 1.0 + (gn - 0.5) * ${amt.toFixed(3)};`
        );
    };
    m.customProgramCacheKey = () => 'grain' + scale + '_' + amt;
    return m;
  }

  function pushQuad(pos, col, a, b, c, d, colr) {
    // Emit both triangles with an upward-facing winding check.
    const tri = (p, q, r) => {
      const ux = q[0] - p[0], uz = q[2] - p[2], vx = r[0] - p[0], vz = r[2] - p[2];
      const ny = uz * vx - ux * vz;
      if (ny < 0) {
        const t = q; q = r; r = t;
      }
      pos.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
      for (let i = 0; i < 3; i++) col.push(colr.r, colr.g, colr.b);
    };
    tri(a, b, c);
    tri(a, c, d);
  }

  function meshFrom(pos, col, mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat || new THREE.MeshLambertMaterial({ vertexColors: true }));
    m.receiveShadow = true;
    return m;
  }

  // smooth 2-D value noise from sines (deterministic, cheap) in ~[-1, 1]
  const vnoise = (x, z) => Math.sin(x * 0.021 + Math.sin(z * 0.013) * 1.7) * 0.5 + Math.sin(z * 0.027 - x * 0.011 + 1.3) * 0.35 + Math.sin((x + z) * 0.061) * 0.15;

  function build(track, opts) {
    opts = opts || {};
    _grainOn = opts.tier !== 'low';
    const detail = opts.detail === 'low' ? 0.4 : opts.detail === 'medium' ? 0.62 : 1;
    const group = new THREE.Group();
    group.userData.animFns = [];
    const th = track.theme;
    const N = track.N, closed = track.closed;
    const segCount = closed ? N : N - 1;
    const Y = 0.04;
    const P = (i, lat, dy) => {
      const x = track.X[i] + track.NX[i] * lat, z = track.Z[i] + track.NZ[i] * lat;
      return [x, track.heightAt(i, lat) + Y + (dy || 0), z];
    };
    const b = track.bounds;
    // sea mask: >0 beyond the track in theme.sea's direction
    let seaAt = null;
    if (th.sea) {
      const [dx, dz] = th.sea;
      let ext = -1e9;
      for (let i = 0; i < N; i++) ext = Math.max(ext, track.X[i] * dx + track.Z[i] * dz);
      seaAt = (x, z) => U.smoothstep(22, 46, x * dx + z * dz - ext);
    }

    // ---------------- Terrain (faceted, hills rising away from the track) ----
    {
      const m = 260;
      const x0 = b.x0 - m, x1 = b.x1 + m, z0 = b.z0 - m, z1 = b.z1 + m;
      const nx = 72, nz = 72;
      const dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;
      const H = [];
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
          let h = Math.min(hill * 0.12, 26) * amp + (d > clear ? (rng() - 0.5) * 1.2 : 0);
          if (d < track.wallD[0] + 3) h = 0;
          if (seaAt) h = U.lerp(h, -3.2, seaAt(x, z));
          H.push([x, h - 0.05, z]);
        }
      }
      const pos = [], col = [];
      const g1 = C(th.ground), g2 = C(th.ground2), g3 = C(th.hill), gp = C(th.patch || th.ground2), rock = C(th.mtn || th.hill).multiplyScalar(0.9);
      const beach = C(0xe6d3a0), snow = C(0xf4f6f8);
      const tmp = new THREE.Color();
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const a = H[j * (nx + 1) + i], bq = H[j * (nx + 1) + i + 1], c = H[(j + 1) * (nx + 1) + i + 1], d = H[(j + 1) * (nx + 1) + i];
          for (const [p, q, r, sh] of [[a, bq, c, 1], [a, c, d, 0.96]]) {
            const hAvg = (p[1] + q[1] + r[1]) / 3;
            const cx = (p[0] + q[0] + r[0]) / 3, cz = (p[2] + q[2] + r[2]) / 3;
            const slope = (Math.max(p[1], q[1], r[1]) - Math.min(p[1], q[1], r[1])) / dx;
            const n = vnoise(cx, cz);
            tmp.copy((i + j) % 3 === 0 ? g2 : g1);
            if (n > 0.35) tmp.lerp(gp, U.clamp((n - 0.35) * 2.2, 0, 0.8)); // meadow / dry patches
            tmp.lerp(g3, U.clamp(hAvg / 14, 0, 1));
            if (slope > 0.45) tmp.lerp(rock, U.clamp((slope - 0.45) * 1.5, 0, 0.7)); // cliffs show rock
            if (th.snow && hAvg > 18) tmp.lerp(snow, U.clamp((hAvg - 18) / 6, 0, 0.9));
            if (hAvg < -0.25) tmp.copy(beach).multiplyScalar(0.8 + 0.2 * U.clamp(1 + hAvg / 3, 0, 1)); // sea bed / beach
            const cc = tmp.clone().multiplyScalar(sh);
            pushQuadTri(pos, col, p, q, r, cc);
          }
        }
      }
      const terrain = meshFrom(pos, col, grainMat(0.045, 0.22));
      terrain.name = 'terrain';
      group.add(terrain);
    }

    // ---------------- Water (harbour) -----------------------------------------
    if (seaAt) {
      const size = Math.max(b.x1 - b.x0, b.z1 - b.z0) + 900;
      const wg = new THREE.PlaneGeometry(size, size, 44, 44);
      wg.rotateX(-Math.PI / 2);
      const wm = new THREE.MeshLambertMaterial({ color: 0x2a86c8, transparent: true, opacity: 0.88, flatShading: true });
      let shader = null;
      wm.onBeforeCompile = (sh) => {
        sh.uniforms.uT = { value: 0 };
        shader = sh;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uT; varying float vWv;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
             float wv = sin(position.x * 0.07 + uT * 1.2) * 0.22 + sin(position.z * 0.11 + uT * 1.6) * 0.14 + sin((position.x - position.z) * 0.19 + uT * 2.3) * 0.06;
             transformed.y += wv; vWv = wv;`
          );
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vWv;')
          .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb += smoothstep(0.18, 0.4, vWv) * 0.35;');
      };
      const water = new THREE.Mesh(wg, wm);
      water.position.set(b.cx, -0.6, b.cz);
      water.userData.castShadow = false;
      group.add(water);
      group.userData.animFns.push((t) => {
        if (shader) shader.uniforms.uT.value = t;
      });
    }

    // ---------------- Road ribbon ------------------------------------------
    {
      const pos = [], col = [];
      // smoothed racing line offset: the rubbered-in groove hugs the inside
      const line = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let k = -12; k <= 12; k++) s += track.K[track.idx(i + k)];
        line[i] = U.clamp((s / 25) * 320, -track.W[i] * 0.55, track.W[i] * 0.55);
      }
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
        if (sid === 'tarmac' && track.format !== 'drag') {
          const lc = cc.clone().multiplyScalar(0.84);
          pushQuad(pos, col, P(i, line[i] + 1.1, 0.006), P(i, line[i] - 1.1, 0.006), P(j, line[j] - 1.1, 0.006), P(j, line[j] + 1.1, 0.006), lc);
        }
        if (sid === 'dirt' || sid === 'gravel') {
          // wheel ruts
          const rc = cc.clone().multiplyScalar(0.88);
          for (const o of [-1.9, 1.9]) pushQuad(pos, col, P(i, line[i] + o + 0.5, 0.005), P(i, line[i] + o - 0.5, 0.005), P(j, line[j] + o - 0.5, 0.005), P(j, line[j] + o + 0.5, 0.005), rc);
        }
        // Standing water: lighter puddle patches on wet sections
        if (sid === 'wet' && (s * 7) % 5 < 2) {
          const pc = C(0x6a84a3);
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
          if (track.format === 'drag') {
            for (let lane = -3; lane <= 3; lane++) {
              if (s % 4 < 2) pushQuad(pos, col, P(i, lane * 3.6 + 0.12, 0.012), P(i, lane * 3.6 - 0.12, 0.012), P(j, lane * 3.6 - 0.12, 0.012), P(j, lane * 3.6 + 0.12, 0.012), lc);
            }
          } else if (track.format === 'sprint' && s % 6 < 3) {
            pushQuad(pos, col, P(i, 0.12, 0.012), P(i, -0.12, 0.012), P(j, -0.12, 0.012), P(j, 0.12, 0.012), C(0xf2d23a)); // road centre line
          }
        }
        // Kerbs: raised red/white strips with a sloped inner edge
        for (const side of [1, -1]) {
          const on = side > 0 ? track.KL[i] : track.KR[i];
          if (!on) continue;
          const kc = C(s % 2 ? 0xe8322b : 0xf5f5f5);
          const a0 = side * (w0 - 1.1), am = side * (w0 - 0.7), a1 = side * (w0 + 0.9), b0 = side * (w1 - 1.1), bm = side * (w1 - 0.7), b1 = side * (w1 + 0.9);
          pushQuad(pos, col, P(i, am, 0.07), P(i, a0, 0.02), P(j, b0, 0.02), P(j, bm, 0.07), kc.clone().multiplyScalar(0.9));
          pushQuad(pos, col, P(i, a1, 0.07), P(i, am, 0.07), P(j, bm, 0.07), P(j, b1, 0.07), kc);
        }
      }
      // Start/finish checker(s) + grid marks
      const checker = (dist) => {
        const f = dist / track.sp;
        const i = track.idx(Math.floor(f));
        const hw = track.W[i];
        const n = Math.round((hw * 2) / 1.0);
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
      // Drag strips: burnout box + threshold "piano keys"
      if (track.format === 'drag') {
        const bo = C(0x33363d);
        for (let d = track.startDist - 16; d < track.startDist - 1; d += 1) {
          const A = track.pointAt(d, 14), Bq = track.pointAt(d, -14), Cq = track.pointAt(d + 1, -14), Dq = track.pointAt(d + 1, 14);
          pushQuad(pos, col, [A.x, Y + 0.008, A.z], [Bq.x, Y + 0.008, Bq.z], [Cq.x, Y + 0.008, Cq.z], [Dq.x, Y + 0.008, Dq.z], bo);
        }
        for (let k = -6; k <= 6; k++) {
          const la = k * 2.1;
          for (const d0 of [track.startDist + 6, track.finishDist + 4]) {
            const A = track.pointAt(d0, la + 0.6), Bq = track.pointAt(d0, la - 0.6), Cq = track.pointAt(d0 + 12, la - 0.6), Dq = track.pointAt(d0 + 12, la + 0.6);
            pushQuad(pos, col, [A.x, Y + 0.013, A.z], [Bq.x, Y + 0.013, Bq.z], [Cq.x, Y + 0.013, Cq.z], [Dq.x, Y + 0.013, Dq.z], C(0xf2f2f2));
          }
        }
      }
      // Banked sections: skirt from the raised outer edge down to the ground
      for (let s = 0; s < segCount; s++) {
        const i = s, j = track.idx(s + 1);
        if (Math.abs(track.BK[i]) < 0.01 && Math.abs(track.BK[j]) < 0.01) continue;
        const si = track.BK[i] > 0 ? -1 : 1, sj = track.BK[j] > 0 ? -1 : 1;
        const cc = C(SURF_COL.dirt[1]).multiplyScalar(0.85);
        pushQuad(pos, col, P(i, si * track.W[i], -0.01), P(i, si * (track.W[i] + 8), -0.01), P(j, sj * (track.W[j] + 8), -0.01), P(j, sj * track.W[j], -0.01), cc);
      }
      const road = meshFrom(pos, col, grainMat(0.3, 0.2, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
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
          if (Math.abs(q.lat) < track.wallD[i] - 0.6 || (Math.abs(q.i - i) > 3 && Math.abs(q.i - i) < N - 3)) continue;
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

    // ---------------- Boards: sponsors on straights, 3-2-1 before corners ---
    buildBoards(track, group, th);
    // ---------------- Scenery ----------------------------------------------
    buildScenery(track, group, detail, seaAt);
    if (th.mtn) group.add(mountains(track, th));
    group.userData.anim = (t, dt) => {
      for (const f of group.userData.animFns) f(t, dt);
    };
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
      if ((fx * nx + fz * nz) * sgn < 0) {
        const t = q; q = r; r = t;
      }
      pos.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
      for (let i = 0; i < 3; i++) col.push(cc.r, cc.g, cc.b);
    };
    tri(a, b, c);
    tri(a, c, d);
  }

  // Box helper in a local frame (x along `h` heading's right, z forward).
  // Places a GB box at world (px, pz) rotated to heading `rot`.
  function boxAt(gb, px, py, pz, rot, lx, ly, lz, sx, sy, sz, col) {
    const c = Math.cos(rot), s = Math.sin(rot);
    gb.box(px + lx * c + lz * s, py + ly, pz - lx * s + lz * c, sx, sy, sz, col, rot);
  }

  // ---------------------------------------------------------------- boards
  const SPONSORS = [
    [0xffcc00, 0x1a1300], [0xe8322b, 0xffffff], [0x2f6bff, 0xffffff], [0x1b1d22, 0x2fe07a], [0xffffff, 0xff3d7f], [0x19c3e6, 0x0e1322], [0xff8a00, 0x111111],
  ];
  function buildBoards(track, group, th) {
    const gb = new G.CarModel.GB();
    const rng = U.rng(U.hashStr(track.id + 'boards'));
    const q = {};
    const clearOf = (x, z, need) => {
      track.query(x, z, -1, q);
      return Math.abs(q.lat) > q.wall + need;
    };
    const dark = C(0x2a2d33);
    // sponsor boards along straights, facing the track, just behind the wall
    let last = -999;
    const every = track.format === 'drag' ? 26 : 34;
    for (let i = 0; i < track.N; i += 3) {
      const d = i * track.sp;
      if (d - last < every || Math.abs(track.K[i]) > 1 / 160) continue;
      const side = (Math.floor(d / every) % 2 ? 1 : -1) * (track.format === 'drag' ? (i % 2 ? 1 : -1) : 1);
      const lat = side * (track.wallD[i] + 1.4);
      const x = track.X[i] + track.NX[i] * lat, z = track.Z[i] + track.NZ[i] * lat;
      if (!clearOf(x, z, 0.8)) continue;
      last = d;
      const rot = track.H[i] + (side > 0 ? -Math.PI / 2 : Math.PI / 2); // panel faces the road
      const [bg, fg] = SPONSORS[Math.floor(rng() * SPONSORS.length)];
      const cb = C(bg), cf = C(fg);
      for (const lx of [-3.2, 3.2]) boxAt(gb, x, 0, z, rot, lx, 1.1, 0, 0.18, 2.2, 0.18, dark);
      boxAt(gb, x, 0, z, rot, 0, 1.9, 0, 7.4, 1.5, 0.14, cb);
      // "logo": a few blocks in the foreground colour
      const kind = Math.floor(rng() * 3);
      if (kind === 0) {
        for (let k = 0; k < 5; k++) boxAt(gb, x, 0, z, rot, -2.6 + k * 1.3, 1.9, 0.08, 0.9, 0.6 + (k % 2) * 0.3, 0.04, cf);
      } else if (kind === 1) {
        boxAt(gb, x, 0, z, rot, -2.2, 1.9, 0.08, 1.2, 1.1, 0.04, cf);
        boxAt(gb, x, 0, z, rot, 0.9, 1.9, 0.08, 4.4, 0.35, 0.04, cf);
      } else {
        boxAt(gb, x, 0, z, rot, 0, 2.45, 0.08, 7.2, 0.18, 0.04, cf);
        boxAt(gb, x, 0, z, rot, 0, 1.35, 0.08, 7.2, 0.18, 0.04, cf);
        boxAt(gb, x, 0, z, rot, 0, 1.9, 0.08, 2.4, 0.5, 0.04, cf);
      }
    }
    // 3-2-1 marker boards before tight corners, on the outside
    if (track.format !== 'drag') {
      for (let i = 0; i < track.N; i++) {
        const k0 = Math.abs(track.K[track.idx(i - 1)]), k1 = Math.abs(track.K[i]);
        if (!(k1 > 1 / 38 && k0 <= 1 / 38)) continue;
        if (!closed(track) && i < 60) continue;
        const outside = track.K[i] > 0 ? -1 : 1;
        for (let n = 1; n <= 3; n++) {
          const j = track.idx(i - n * 17);
          const lat = outside * (track.W[j] + Math.min(track.runoff, 6) * 0.5 + 1.2);
          const x = track.X[j] + track.NX[j] * lat, z = track.Z[j] + track.NZ[j] * lat;
          const rot = track.H[j] + Math.PI; // faces oncoming cars
          boxAt(gb, x, 0, z, rot, 0, 0.8, 0, 0.12, 1.6, 0.12, dark);
          boxAt(gb, x, 0, z, rot, 0, 1.75, 0, 1.3, 1.0, 0.1, C(0xf5f5f5));
          for (let k = 0; k < n; k++) boxAt(gb, x, 0, z, rot, -0.36 + k * 0.36 - (n - 1) * 0 + (3 - n) * 0.18, 1.75, 0.06, 0.16, 0.8, 0.04, C(0x111111));
        }
      }
    }
    // marshal posts at a few corner exits
    let mp = 0;
    for (let i = 0; i < track.N && track.format !== 'drag'; i += 9) {
      if (Math.abs(track.K[i]) < 1 / 45 || mp > 6) continue;
      if (rng() > 0.35) continue;
      const outside = track.K[i] > 0 ? -1 : 1;
      const lat = outside * (track.wallD[i] + 3.2);
      const x = track.X[i] + track.NX[i] * lat, z = track.Z[i] + track.NZ[i] * lat;
      if (!clearOf(x, z, 2)) continue;
      mp++;
      const rot = track.H[i];
      boxAt(gb, x, 0, z, rot, 0, 1.1, 0, 1.6, 2.2, 1.6, C(0xff7a1a));
      boxAt(gb, x, 0, z, rot, 0, 2.3, 0, 2.0, 0.2, 2.0, C(0xf5f5f5));
      boxAt(gb, x, 0, z, rot, 0, 1.4, -0.81, 1.2, 0.5, 0.04, C(0x243447));
      boxAt(gb, x, 0, z, rot, 0.9, 3.2, 0, 0.06, 1.8, 0.06, dark);
      boxAt(gb, x, 0, z, rot, 1.25, 3.7, 0, 0.7, 0.5, 0.04, C(0xffcc00));
    }
    if (!gb.p.length) return;
    const m = new THREE.Mesh(gb.geometry(), G.CarModel.material());
    m.castShadow = true;
    m.receiveShadow = false;
    m.name = 'boards';
    group.add(m);
  }
  const closed = (t) => t.closed;

  // ---- Prop geometries (vertex coloured, instanced) -----------------------
  function propGeo(kind) {
    const gb = new G.CarModel.GB();
    if (kind === 'round') {
      gb.box(0, 1.2, 0, 0.5, 2.4, 0.5, C(0x7a5236));
      ico(gb, 0, 3.6, 0, 2.2, C(0x3f9e4d));
      ico(gb, 0.6, 4.6, 0.3, 1.4, C(0x4fb45a));
      ico(gb, -0.7, 3.9, -0.4, 1.3, C(0x378f44));
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
      gb.box(0, 4.05, 0, 0.3, 0.12, 0.3, C(0xff5a8a)); // flower
    } else if (kind === 'rock') {
      ico(gb, 0, 0.6, 0, 1.6, C(0x9a8f86));
      ico(gb, 1.0, 0.4, 0.6, 1.0, C(0x8a7f76));
    } else if (kind === 'redrock') {
      ico(gb, 0, 1.4, 0, 3.2, C(0xc0643c));
      ico(gb, 2.2, 0.8, 1.0, 2.0, C(0xad5733));
    } else if (kind === 'mesa') {
      const cols = [0xc0643c, 0xd98a58, 0xb45a36, 0xe2a070];
      let w = 26, y = 0;
      for (let k = 0; k < 4; k++) {
        const h = 6 + k * 1.5;
        gb.box(0, y + h / 2, 0, w, h, w * 0.7, C(cols[k]), k * 0.2);
        y += h;
        w *= 0.84;
      }
    } else if (kind === 'building') {
      bld(gb, 10, 10, 10, 0xdfe3ea, 0x4b6b8f, 0x9aa5b4);
    } else if (kind === 'tower') {
      bld(gb, 9, 26, 9, 0x8fb4d8, 0x2c4a6e, 0x5d6d80);
      gb.box(0, 27.2, 0, 1.2, 2.4, 1.2, C(0x5d6d80));
    } else if (kind === 'brick') {
      bld(gb, 11, 14, 9, 0xb4553e, 0xf0e6d2, 0x7c3a2a);
    } else if (kind === 'shop') {
      bld(gb, 12, 5, 9, 0xf2e3c4, 0x3b4b60, 0xc9b28d);
      gb.box(0, 3.1, 4.9, 11, 0.2, 1.6, C(0xe8322b)); // awning
      gb.box(0, 5.6, 4.4, 8, 1.2, 0.2, C(0xffcc00)); // sign
    } else if (kind === 'tyres') {
      for (let k = 0; k < 3; k++) cyl(gb, 0, 0.3 + k * 0.5, 0, 0.55, 0.45, 8, C(k === 1 ? 0xe8322b : k % 2 ? 0x1f1f1f : 0x2b2b2b));
    } else if (kind === 'cone') {
      cone(gb, 0, 0, 0, 0.35, 0.8, 6, C(0xff7a1a));
      gb.box(0, 0.45, 0, 0.36, 0.1, 0.36, C(0xf5f5f5));
      gb.box(0, 0.03, 0, 0.8, 0.06, 0.8, C(0x222222));
    } else if (kind === 'crate') {
      gb.box(0, 1.2, 0, 2.4, 2.4, 6, C(0x2f6fed));
      gb.box(0, 2.45, 0, 2.5, 0.1, 6.1, C(0x1f4fbd));
      for (let k = -2; k <= 2; k++) gb.box(1.22, 1.2, k * 1.1, 0.04, 2.2, 0.12, C(0x1f4fbd));
    } else if (kind === 'crate2') {
      gb.box(0, 1.2, 0, 2.4, 2.4, 6, C(0xe8453c));
      gb.box(0, 2.45, 0, 2.5, 0.1, 6.1, C(0xb8352c));
      for (let k = -2; k <= 2; k++) gb.box(1.22, 1.2, k * 1.1, 0.04, 2.2, 0.12, C(0xb8352c));
    } else if (kind === 'hangar') {
      gb.box(0, 4, 0, 24, 8, 18, C(0xc9d2dc));
      gb.box(0, 8.4, 0, 25, 0.8, 19, C(0x7d8a99));
      gb.box(0, 3.2, 9.02, 16, 6.4, 0.1, C(0x5a6677));
      for (let k = -3; k <= 3; k++) gb.box(k * 2.3, 3.2, 9.06, 0.06, 6.4, 0.04, C(0x46505f));
    } else if (kind === 'lamp') {
      gb.box(0, 3.5, 0, 0.18, 7, 0.18, C(0x3a3f47));
      gb.box(0, 6.9, 0.9, 0.12, 0.12, 1.8, C(0x3a3f47));
      gb.box(0, 6.8, 1.7, 0.5, 0.18, 0.7, C(0x2a2d33));
      gb.box(0, 6.68, 1.7, 0.36, 0.05, 0.5, C(0xfff4c2));
    } else if (kind === 'tuft') {
      // three 3-sided blades + a flower: 24 triangles (hundreds are instanced)
      const cols = [0x4f9a47, 0x5fae52, 0x3f8a3d];
      for (let k = 0; k < 3; k++) {
        const a = k * 2.1;
        cone(gb, Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3, 0.16, 0.75 + (k % 2) * 0.3, 3, C(cols[k]));
      }
      cone(gb, 0.22, 0.45, -0.18, 0.12, 0.14, 3, C(0xffe066)); // flower
    } else if (kind === 'dry') {
      const cols = [0xb08a4e, 0x9c7a44, 0x8a6a3a];
      for (let k = 0; k < 4; k++) {
        const a = k * 1.6;
        cone(gb, Math.cos(a) * 0.35, 0, Math.sin(a) * 0.35, 0.12, 0.6 + (k % 2) * 0.25, 3, C(cols[k % 3]));
      }
    } else if (kind === 'hay') {
      cylX(gb, 0, 0.8, 0, 0.8, 1.4, 10, C(0xe0bc5c));
    } else if (kind === 'fence') {
      const w = C(0xe9e2d0);
      gb.box(-2, 0.6, 0, 0.14, 1.2, 0.14, w);
      gb.box(2, 0.6, 0, 0.14, 1.2, 0.14, w);
      gb.box(0, 0.95, 0, 4.2, 0.14, 0.08, w);
      gb.box(0, 0.5, 0, 4.2, 0.14, 0.08, w);
    } else if (kind === 'barn') {
      gb.box(0, 3, 0, 10, 6, 14, C(0xb8352c));
      roofGable(gb, 0, 6, 0, 11, 3.2, 15, C(0x5a4a42));
      gb.box(0, 2.4, 7.02, 4, 4.8, 0.1, C(0xf5f0e6));
      gb.box(0, 2.4, 7.06, 3.2, 0.2, 0.06, C(0xb8352c));
    } else if (kind === 'cabin') {
      gb.box(0, 1.6, 0, 6, 3.2, 5, C(0x8a5a36));
      for (let k = 0; k < 5; k++) gb.box(0, 0.4 + k * 0.64, 2.52, 6.02, 0.08, 0.04, C(0x6b4428));
      roofGable(gb, 0, 3.2, 0, 6.8, 2, 6, C(0x3f4a3a));
      gb.box(1.5, 1.6, 2.53, 1.2, 1, 0.05, C(0xffe7a8));
      gb.box(2.2, 4.4, 0, 0.6, 1.8, 0.6, C(0x6d6d6d)); // chimney
    } else if (kind === 'logs') {
      for (let k = 0; k < 3; k++) cylX(gb, 0, 0.35 + k * 0.1, (k - 1) * 0.72, 0.35, 5, 7, C(k === 1 ? 0x8b5e3c : 0x7a5236));
      cylX(gb, 0, 0.95, -0.36, 0.35, 5, 7, C(0x8b5e3c));
      cylX(gb, 0, 0.95, 0.36, 0.35, 5, 7, C(0x7a5236));
    } else if (kind === 'fans') {
      // a knot of rally spectators with an umbrella
      const cols = [0xe8322b, 0x2f6bff, 0xffcc00, 0x22c55e, 0xffffff, 0xff8a00];
      for (let k = 0; k < 6; k++) {
        const x = (k % 3) * 0.8 - 0.8, z = Math.floor(k / 3) * 0.9 - 0.4;
        gb.box(x, 0.55, z, 0.45, 1.1, 0.35, C(cols[k]));
        gb.box(x, 1.28, z, 0.28, 0.3, 0.28, C(0xe8b894));
      }
      gb.box(0.4, 1.2, 0.3, 0.05, 2.4, 0.05, C(0x333333));
      cone(gb, 0.4, 2.1, 0.3, 1.1, 0.5, 8, C(0xe8322b));
    } else if (kind === 'plane') {
      const w = C(0xf2f4f7), acc = C(0xe8322b);
      gb.beam([0, 1.4, -5], [0, 1.4, 5], 1.3, 1.4, w);
      gb.beam([0, 1.5, 5], [0, 1.35, 6.2], 0.9, 0.9, w);
      gb.box(0, 1.25, 0.8, 11, 0.2, 1.8, w);
      gb.box(0, 1.8, -4.6, 3.6, 0.15, 1, w);
      gb.box(0, 2.6, -4.7, 0.15, 1.8, 1.1, acc);
      gb.box(0, 1.6, 4.2, 1.34, 0.4, 0.8, C(0x243447));
      gb.box(0, 1.4, 6.4, 0.2, 0.2, 0.2, C(0x333333));
      gb.box(0, 1.4, 6.5, 2.6, 0.12, 0.08, C(0x333333)); // prop
      for (const x of [-1.6, 1.6]) gb.box(x, 0.4, 1.2, 0.15, 0.8, 0.15, C(0x333333));
      gb.box(0, 0.35, 5.2, 0.15, 0.7, 0.15, C(0x333333));
      gb.box(0, 1.3, 0.8, 11.02, 0.06, 0.4, acc);
    } else if (kind === 'ctower') {
      gb.box(0, 3, 0, 5, 6, 5, C(0xd8dde4));
      gb.box(0, 9, 0, 3, 6, 3, C(0xd8dde4));
      gb.box(0, 13, 0, 5.4, 2.4, 5.4, C(0x243447));
      gb.box(0, 14.4, 0, 6, 0.4, 6, C(0x7d8a99));
      gb.box(0, 16, 0, 0.12, 3, 0.12, C(0x333333));
      gb.box(0, 17.4, 0, 0.3, 0.3, 0.3, C(0xff2a1a));
    } else if (kind === 'sock') {
      gb.box(0, 3, 0, 0.12, 6, 0.12, C(0x3a3f47));
      gb.beam([0, 5.8, 0], [0, 5.6, -2.2], 0.6, 0.6, C(0xff7a1a));
      gb.beam([0, 5.6, -1.1], [0, 5.55, -1.6], 0.62, 0.62, C(0xf5f5f5));
    } else if (kind === 'crane') {
      const y = C(0xffc400), d = C(0x2a2d33);
      for (const [x, z] of [[-4, -3], [4, -3], [-4, 3], [4, 3]]) gb.box(x, 9, z, 0.6, 18, 0.6, y);
      gb.box(0, 18.3, 0, 9, 0.8, 7, y);
      gb.box(0, 18.8, 8, 2, 1, 22, y);
      gb.box(0, 18.8, -5, 2, 1, 6, d);
      gb.box(0, 20, 0, 3, 2.4, 3, C(0xf5f5f5));
      gb.box(0, 12, 14, 0.08, 12, 0.08, d);
      gb.box(0, 6, 14, 2.4, 0.4, 6, d);
    } else if (kind === 'boat') {
      const hull = C(0xf5f5f5);
      gb.box(0, 0.6, 0, 4, 1.4, 10, hull);
      gb.beam([0, 0.8, 5], [0, 1.1, 7], 3.2, 1.2, hull);
      gb.box(0, 0.05, 0, 4.05, 0.3, 10.05, C(0xe8322b));
      gb.box(0, 2.2, -1, 3, 1.8, 4, C(0x2f6bff));
      gb.box(0, 2.3, 1.02, 2.8, 0.7, 0.06, C(0x243447));
      gb.box(0, 4.5, -1, 0.12, 3, 0.12, C(0x333333));
    } else if (kind === 'dock') {
      const wood = C(0x8b6a48);
      gb.box(0, 0.3, 0, 4, 0.3, 30, wood);
      for (let k = -3; k <= 3; k++) for (const x of [-1.8, 1.8]) gb.box(x, -0.8, k * 4.6, 0.3, 2.2, 0.3, C(0x6b4a30));
    } else if (kind === 'lighthouse') {
      for (let k = 0; k < 6; k++) cyl(gb, 0, 1.5 + k * 3, 0, 2.2 - k * 0.2, 3, 10, C(k % 2 ? 0xe8322b : 0xf5f5f5));
      cyl(gb, 0, 19.5, 0, 1.4, 2, 10, C(0x243447));
      cone(gb, 0, 20.5, 0, 1.8, 1.6, 10, C(0xe8322b));
      gb.box(0, 19.5, 0, 1.2, 1.2, 1.2, C(0xfff4c2));
    } else if (kind === 'watertower') {
      for (const [x, z] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) gb.box(x, 5, z, 0.3, 10, 0.3, C(0x6b4a30));
      cyl(gb, 0, 12, 0, 3.2, 4, 12, C(0x9aa5b4));
      cone(gb, 0, 14, 0, 3.4, 1.6, 12, C(0x7d8a99));
    }
    return gb.geometry();
  }
  function bld(gb, w, h, d, wall, win, roof) {
    gb.box(0, h / 2, 0, w, h, d, C(wall));
    const wc = C(win);
    // windows are single outward quads (2 triangles, not a 12-triangle box)
    const hw = w / 2 + 0.03, hd = d / 2 + 0.03;
    for (let y = 2; y < h - 1; y += 2.6) {
      const y0 = y - 0.6, y1 = y + 0.6;
      for (let x = -w / 2 + 2; x <= w / 2 - 1.8; x += 3) {
        gb.quadN([x - 0.8, y0, hd], [x + 0.8, y0, hd], [x + 0.8, y1, hd], [x - 0.8, y1, hd], wc, [0, 0, 1]);
        gb.quadN([x - 0.8, y0, -hd], [x + 0.8, y0, -hd], [x + 0.8, y1, -hd], [x - 0.8, y1, -hd], wc, [0, 0, -1]);
      }
      for (let z = -d / 2 + 2; z <= d / 2 - 1.8; z += 3) {
        gb.quadN([hw, y0, z - 0.8], [hw, y0, z + 0.8], [hw, y1, z + 0.8], [hw, y1, z - 0.8], wc, [1, 0, 0]);
        gb.quadN([-hw, y0, z - 0.8], [-hw, y0, z + 0.8], [-hw, y1, z + 0.8], [-hw, y1, z - 0.8], wc, [-1, 0, 0]);
      }
    }
    gb.box(0, h + 0.3, 0, w + 0.4, 0.6, d + 0.4, C(roof));
    gb.box(w * 0.2, h + 1.1, -d * 0.15, 2.2, 1.2, 1.8, C(0xb9c0c9)); // rooftop unit
  }
  function roofGable(gb, x, y, z, w, h, d, col) {
    const hw = w / 2, hd = d / 2;
    const A = [x - hw, y, z - hd], B = [x + hw, y, z - hd], Cc = [x + hw, y, z + hd], D = [x - hw, y, z + hd];
    const T0 = [x, y + h, z - hd], T1 = [x, y + h, z + hd];
    gb.quad(A, T0, T1, D, col, x, y, z);
    gb.quad(B, T0, T1, Cc, col.clone().multiplyScalar(0.85), x, y, z);
    gb.tri(A, B, T0, col, x, y, z);
    gb.tri(D, Cc, T1, col, x, y, z);
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
  // cylinder lying along X
  function cylX(gb, x, y, z, r, len, n, c) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const P = (a, xx) => [xx, y + Math.cos(a) * r, z + Math.sin(a) * r];
      gb.quad(P(a0, x - len / 2), P(a1, x - len / 2), P(a1, x + len / 2), P(a0, x + len / 2), i % 2 ? c : c.clone().multiplyScalar(0.92), x, y, z);
      gb.tri([x + len / 2, y, z], P(a0, x + len / 2), P(a1, x + len / 2), c.clone().multiplyScalar(1.15), x, y, z);
      gb.tri([x - len / 2, y, z], P(a0, x - len / 2), P(a1, x - len / 2), c.clone().multiplyScalar(1.15), x, y, z);
    }
  }

  const _geoCache = {};
  const geo = (k) => _geoCache[k] || (_geoCache[k] = propGeo(k));

  // items: [{x, z, y?, r?, s?, t?}] — t = colour tint multiplier (per instance)
  function instanced(kind, items, group, shadow) {
    if (!items.length) return null;
    const m = new THREE.InstancedMesh(geo(kind), G.CarModel.material(), items.length);
    const o = new THREE.Object3D();
    const tint = new THREE.Color();
    let tinted = false;
    items.forEach((it, k) => {
      o.position.set(it.x, it.y || 0, it.z);
      o.rotation.set(0, it.r || 0, 0);
      if (it.sv) o.scale.set(it.sv[0], it.sv[1], it.sv[2]);
      else o.scale.setScalar(it.s || 1);
      o.updateMatrix();
      m.setMatrixAt(k, o.matrix);
      if (it.t) {
        tint.setRGB(it.t, it.t * (it.tg || 1), it.t);
        m.setColorAt(k, tint);
        tinted = true;
      }
    });
    if (tinted && m.instanceColor) m.instanceColor.needsUpdate = true;
    m.castShadow = !!shadow;
    m.receiveShadow = false;
    m.userData.sharedGeo = true;
    m.computeBoundingSphere();
    group.add(m);
    return m;
  }

  function buildScenery(track, group, detail, seaAt) {
    const th = track.theme;
    const rng = U.rng(U.hashStr(track.id + 'props'));
    const b = track.bounds, M = 170;
    const q = {};
    const clearOf = (x, z, extra) => {
      track.query(x, z, -1, q);
      return Math.abs(q.lat) > q.wall + extra || q.along < 0 || (!track.closed && (q.along <= 0.5 || q.along >= track.length - 0.5) && Math.hypot(x - track.X[q.i], z - track.Z[q.i]) > q.wall + extra);
    };
    const dry = (x, z) => !seaAt || seaAt(x, z) < 0.05;
    const trees = [], rocks = [];
    const treeKind = th.trees === 'none' ? null : th.trees;
    const count = Math.round((track.format === 'drag' ? 170 : 290) * detail * (th.props === 'forest' ? 1.6 : 1));
    for (let k = 0; k < count * 3 && trees.length < count; k++) {
      const x = U.lerp(b.x0 - M, b.x1 + M, rng()), z = U.lerp(b.z0 - M, b.z1 + M, rng());
      if (!clearOf(x, z, 4) || !dry(x, z)) continue;
      const item = { x, z, r: rng() * 6.28, s: 0.7 + rng() * 0.8, t: 0.82 + rng() * 0.3 };
      if (treeKind && rng() < 0.8) trees.push(item);
      else rocks.push(item);
    }
    if (treeKind) instanced(treeKind, trees, group, true);
    instanced(th.props === 'rocks' || th.trees === 'cactus' ? 'redrock' : 'rock', rocks, group, true);

    // grass tufts / dry scrub near the track edge (the ground the camera sees most)
    if (th.tufts) {
      const tufts = [];
      const n = Math.round(900 * detail);
      for (let k = 0; k < n * 2 && tufts.length < n; k++) {
        const i = Math.floor(rng() * track.N);
        const side = rng() < 0.5 ? 1 : -1;
        const lat = side * (track.wallD[i] + 1.5 + rng() * 40);
        const x = track.X[i] + track.NX[i] * lat + (rng() - 0.5) * 6, z = track.Z[i] + track.NZ[i] * lat + (rng() - 0.5) * 6;
        if (!clearOf(x, z, 1) || !dry(x, z)) continue;
        tufts.push({ x, z, r: rng() * 6.28, s: 0.7 + rng() * 0.9, t: 0.85 + rng() * 0.3 });
      }
      instanced(th.tufts === 'dry' ? 'dry' : 'tuft', tufts, group, false);
    }

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

    // Street lamps (city, rain) facing the road
    const ring = (kind, gap, off, need, cb) => {
      const out = [];
      for (let i = 0; i < track.N; i += gap) {
        for (const side of [1, -1]) {
          const lat = side * (track.wallD[i] + off);
          const x = track.X[i] + track.NX[i] * lat, z = track.Z[i] + track.NZ[i] * lat;
          if (!clearOf(x, z, need)) continue;
          out.push(cb ? cb(i, side, x, z) : { x, z, r: track.H[i] + (side > 0 ? -Math.PI / 2 : Math.PI / 2) });
        }
      }
      return out;
    };
    if (th.props === 'city' || th.props === 'rain') instanced('lamp', ring('lamp', 16, 1.2, 0.6), group, true);

    // Theme set pieces
    if (th.props === 'city') {
      const kinds = ['building', 'tower', 'brick', 'shop'];
      const byKind = { building: [], tower: [], brick: [], shop: [] };
      const placed = [];
      for (let i = 0; i < track.N; i += 6) {
        for (const side of [1, -1]) {
          const lat = side * (track.wallD[i] + 10);
          const x = track.X[i] + track.NX[i] * lat, z = track.Z[i] + track.NZ[i] * lat;
          if (!clearOf(x, z, 8)) continue;
          if (placed.some((o) => Math.hypot(o.x - x, o.z - z) < 13)) continue;
          const k = kinds[Math.floor(rng() * kinds.length)];
          const it = { x, z, r: track.H[i] + (side > 0 ? -Math.PI / 2 : Math.PI / 2), s: 0.8 + rng() * 0.5, t: 0.85 + rng() * 0.25 };
          placed.push(it);
          byKind[k].push(it);
        }
      }
      // a second, taller ring of skyline behind
      for (let k = 0; k < 40 * detail; k++) {
        const x = U.lerp(b.x0 - 90, b.x1 + 90, rng()), z = U.lerp(b.z0 - 90, b.z1 + 90, rng());
        if (!clearOf(x, z, 26) || placed.some((o) => Math.hypot(o.x - x, o.z - z) < 16)) continue;
        const it = { x, z, r: Math.round(rng() * 4) * (Math.PI / 2), s: 0.9 + rng() * 0.6, t: 0.8 + rng() * 0.3 };
        placed.push(it);
        byKind[rng() < 0.6 ? 'tower' : 'brick'].push(it);
      }
      for (const k of kinds) instanced(k, byKind[k], group, true);
    }
    if (th.props === 'harbour' || th.props === 'airstrip') {
      const cr = [], cr2 = [];
      for (let k = 0; k < 70 * detail; k++) {
        const x = U.lerp(b.x0 - 60, b.x1 + 60, rng()), z = U.lerp(b.z0 - 60, b.z1 + 60, rng());
        if (!clearOf(x, z, 8) || !dry(x, z)) continue;
        const stack = rng() < 0.3;
        (rng() < 0.5 ? cr : cr2).push({ x, z, r: Math.round(rng() * 2) * (Math.PI / 2), y: 0 });
        if (stack) (rng() < 0.5 ? cr : cr2).push({ x, z, r: Math.round(rng() * 2) * (Math.PI / 2), y: 2.5 });
      }
      instanced('crate', cr, group, true);
      instanced('crate2', cr2, group, true);
      if (th.props === 'airstrip') {
        const hg = [], planes = [], towers = [], socks = [];
        for (let k = 0; k < 6; k++) {
          const z = track.bounds.z0 + 80 + k * 120, x = (k % 2 ? 1 : -1) * (track.wallD[0] + 30);
          if (clearOf(x, z, 12)) hg.push({ x, z, r: k % 2 ? -Math.PI / 2 : Math.PI / 2 });
          const px = (k % 2 ? 1 : -1) * (track.wallD[0] + 16), pz = z + 30;
          if (k < 4 && clearOf(px, pz, 8)) planes.push({ x: px, z: pz, r: (k % 2 ? -1 : 1) * 2.2 + rng() * 0.4 });
        }
        const tp = { x: -(track.wallD[0] + 48), z: track.bounds.z0 + 140 };
        if (clearOf(tp.x, tp.z, 20)) towers.push(Object.assign(tp, { r: Math.PI / 2 }));
        const sp = { x: track.wallD[0] + 12, z: track.bounds.z0 + 30 };
        if (clearOf(sp.x, sp.z, 4)) socks.push(Object.assign(sp, { r: 0.6 }));
        instanced('hangar', hg, group, true);
        instanced('plane', planes, group, true);
        instanced('ctower', towers, group, true);
        instanced('sock', socks, group, false);
      }
      if (th.props === 'harbour' && seaAt) {
        // docks, boats, cranes and a lighthouse along the shoreline
        const [dx, dz] = th.sea;
        let ext = -1e9;
        for (let i = 0; i < track.N; i++) ext = Math.max(ext, track.X[i] * dx + track.Z[i] * dz);
        const shore = ext + 40;
        const px = -dz, pz = dx; // along the shore
        const docks = [], boats = [], cranes = [], lights = [];
        const along0 = b.x0 * px + b.z0 * pz, along1 = b.x1 * px + b.z1 * pz;
        const lo = Math.min(along0, along1), hi = Math.max(along0, along1);
        for (let a = lo; a < hi; a += 55) {
          const x = px * a + dx * (shore + 10), z = pz * a + dz * (shore + 10);
          docks.push({ x, z, r: Math.atan2(dx, dz) });
          if (rng() < 0.8) boats.push({ x: x + px * 6 + dx * (6 + rng() * 10), z: z + pz * 6 + dz * (6 + rng() * 10), y: -0.6, r: Math.atan2(dx, dz) + (rng() - 0.5) * 0.4 });
        }
        for (let k = 0; k < 3; k++) {
          const a = U.lerp(lo, hi, 0.2 + k * 0.3);
          const x = px * a + dx * (shore - 6), z = pz * a + dz * (shore - 6);
          if (clearOf(x, z, 10)) cranes.push({ x, z, r: Math.atan2(dx, dz) });
        }
        lights.push({ x: px * (hi + 30) + dx * (shore + 14), z: pz * (hi + 30) + dz * (shore + 14) });
        for (let k = 0; k < 5; k++) boats.push({ x: b.cx + px * (rng() - 0.5) * 400 + dx * (shore + 70 + rng() * 120), z: b.cz + pz * (rng() - 0.5) * 400 + dz * (shore + 70 + rng() * 120), y: -0.6, r: rng() * 6.28, s: 0.8 + rng() * 0.5 });
        instanced('dock', docks, group, false);
        instanced('boat', boats, group, true);
        instanced('crane', cranes, group, true);
        instanced('lighthouse', lights, group, true);
      }
    }
    if (th.props === 'rocks') {
      // canyon: mesas on the horizon
      const mesas = [];
      for (let k = 0; k < 26 * detail; k++) {
        const x = U.lerp(b.x0 - 150, b.x1 + 150, rng()), z = U.lerp(b.z0 - 150, b.z1 + 150, rng());
        if (!clearOf(x, z, 45)) continue;
        mesas.push({ x, z, r: rng() * 6.28, s: 0.6 + rng() * 0.7 });
      }
      instanced('mesa', mesas, group, true);
    }
    if (th.props === 'stands') {
      // dust bowl: fence around the outside, hay bales, a barn, water tower, windmill
      const fences = ring('fence', 2, 2.2, 1, (i, side, x, z) => ({ x, z, r: track.H[i] }));
      instanced('fence', fences.filter((_, k) => k % 2 === 0), group, false);
      const hay = [], barns = [], wt = [];
      for (let k = 0; k < 50 * detail; k++) {
        const x = U.lerp(b.x0 - 80, b.x1 + 80, rng()), z = U.lerp(b.z0 - 80, b.z1 + 80, rng());
        if (clearOf(x, z, 6)) hay.push({ x, z, r: rng() * 6.28 });
      }
      for (const [x, z] of [[b.x0 - 55, b.cz + 20], [b.x1 + 60, b.cz - 30]]) if (clearOf(x, z, 12)) barns.push({ x, z, r: rng() * 6.28 });
      if (clearOf(b.cx, b.z1 + 50, 10)) wt.push({ x: b.cx, z: b.z1 + 50 });
      instanced('hay', hay, group, true);
      instanced('barn', barns, group, true);
      instanced('watertower', wt, group, true);
      const wx = b.x1 + 45, wz = b.z1 + 25;
      if (clearOf(wx, wz, 8)) windmill(group, wx, wz);
    }
    if (th.props === 'forest') {
      const cabins = [], logs = [], fans = [];
      for (let k = 0; k < 14 * detail; k++) {
        const x = U.lerp(b.x0 - 80, b.x1 + 80, rng()), z = U.lerp(b.z0 - 80, b.z1 + 80, rng());
        if (clearOf(x, z, 12)) (k % 3 === 0 ? cabins : logs).push({ x, z, r: rng() * 6.28 });
      }
      for (let i = 0; i < track.N; i += 22) {
        if (Math.abs(track.K[i]) < 1 / 60) continue;
        const outside = track.K[i] > 0 ? -1 : 1;
        const lat = outside * (track.wallD[i] + 4);
        const x = track.X[i] + track.NX[i] * lat, z = track.Z[i] + track.NZ[i] * lat;
        if (clearOf(x, z, 2)) fans.push({ x, z, r: track.H[i] + (outside > 0 ? -Math.PI / 2 : Math.PI / 2) });
      }
      instanced('cabin', cabins, group, true);
      instanced('logs', logs, group, true);
      instanced('fans', fans, group, false);
    }
    // Grandstand + start posts + start lights (every track)
    startSetPiece(track, th, group);
  }

  // A windmill with a spinning rotor (the rotor is its own small mesh).
  function windmill(group, x, z) {
    const gb = new G.CarModel.GB();
    gb.box(0, 7, 0, 0.5, 14, 0.5, C(0x9aa5b4));
    for (const [a, c] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) gb.beam([a * 1.6, 0, c * 1.6], [0, 13, 0], 0.18, 0.18, C(0x7d8a99));
    gb.box(0, 14.2, 0, 1.2, 1.2, 2.2, C(0x7d8a99));
    gb.box(0, 14.4, -2.2, 0.1, 1.4, 1.8, C(0xe23d6b)); // tail vane
    const base = new THREE.Mesh(gb.geometry(), G.CarModel.material());
    base.position.set(x, 0, z);
    base.castShadow = true;
    group.add(base);
    const rb = new G.CarModel.GB();
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      rb.beam([0, 0, 0], [Math.cos(a) * 3.2, Math.sin(a) * 3.2, 0], 0.5, 0.06, C(0xe9e2d0));
    }
    const rotor = new THREE.Mesh(rb.geometry(), G.CarModel.material());
    rotor.position.set(x, 14.4, z + 1.2);
    rotor.castShadow = true;
    group.add(rotor);
    group.userData.animFns.push((t) => {
      rotor.rotation.z = t * 1.4;
    });
  }

  function startSetPiece(track, th, group) {
    const gb = new G.CarModel.GB();
    const p = track.pointAt(track.startDist, 0);
    const hw = track.wallD[p.i] + 0.6;
    // Start posts with chequered flags and light pods on top. No overhead
    // beam: with an angled top-down camera an overhead gantry sits between
    // the lens and the grid and reads as a glitch band.
    for (const sx of [hw, -hw]) {
      gb.box(sx, 3.2, 0, 0.5, 6.4, 0.5, C(0x2a2d33));
      gb.box(sx, 6.6, 0, 0.8, 0.4, 0.8, C(th.wall[0]));
      for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) gb.box(sx - Math.sign(sx) * (0.45 + k * 0.4), 5.9 - r * 0.4, 0, 0.4, 0.4, 0.06, C((r + k) % 2 ? 0x111111 : 0xffffff));
      gb.box(sx, 7.6, 0, 0.7, 1.7, 0.5, C(0x1b1d22)); // light pod housing
    }
    // grandstand on the left side
    const side = 1;
    for (let r = 0; r < 5; r++) {
      const x = side * (hw + 4 + r * 1.6);
      gb.box(x, 0.5 + r * 0.8, 0, 1.6, 1 + r * 1.6, 26, C(r % 2 ? 0xd8dde4 : 0xc9ced6));
    }
    gb.box(side * (hw + 7.2), 9.8, 0, 9, 0.4, 28, C(th.wall[0]));
    gb.box(side * (hw + 11.2), 5, 13.5, 0.4, 10, 0.4, C(0x2a2d33));
    gb.box(side * (hw + 11.2), 5, -13.5, 0.4, 10, 0.4, C(0x2a2d33));
    gb.box(side * (hw + 3.2), 1.6, 0, 0.1, 0.6, 26, C(th.wall[1])); // front rail
    const m = new THREE.Mesh(gb.geometry(), G.CarModel.material());
    m.position.set(p.x, 0, p.z);
    m.rotation.y = p.h;
    m.castShadow = true;
    group.add(m);

    // crowd: little people in team colours; the shader bobs them (and makes
    // them jump when someone finishes — world.cheer() via userData.cheer)
    const cg = new G.CarModel.GB();
    const cols = [0xff3b30, 0x2f6bff, 0xffc400, 0x22c55e, 0xff2d92, 0x19c3e6, 0xff8a00, 0xa855f7, 0xf5f5f5, 0x1b1d22];
    const skin = [0xe8b894, 0xc68c64, 0x8d5a3b, 0xf1cfae];
    const rng = U.rng(U.hashStr(track.id + 'crowd'));
    for (let r = 0; r < 5; r++) {
      const x = side * (hw + 4 + r * 1.6);
      for (let k = 0; k < 19; k++) {
        if (rng() < 0.12) continue;
        const z = -12 + k * 1.33 + (rng() - 0.5) * 0.3;
        const y = 1.1 + r * 1.6;
        cg.box(x, y + 0.35, z, 0.5, 0.7, 0.42, C(cols[Math.floor(rng() * cols.length)]));
        cg.box(x, y + 0.86, z, 0.3, 0.3, 0.3, C(skin[Math.floor(rng() * skin.length)]));
      }
    }
    const cm = new THREE.MeshLambertMaterial({ vertexColors: true });
    let csh = null;
    const cheer = { amp: 0.05 };
    cm.onBeforeCompile = (sh) => {
      sh.uniforms.uT = { value: 0 };
      sh.uniforms.uA = { value: 0.05 };
      csh = sh;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uT; uniform float uA;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += max(0.0, sin(uT * 9.0 + position.z * 2.3 + position.x * 1.7)) * uA;');
    };
    const crowd = new THREE.Mesh(cg.geometry(), cm);
    crowd.position.copy(m.position);
    crowd.rotation.copy(m.rotation);
    group.add(crowd);
    group.userData.animFns.push((t, dt) => {
      cheer.amp = U.lerp(cheer.amp, 0.05, 1 - Math.exp(-0.6 * (dt || 0.016)));
      if (csh) {
        csh.uniforms.uT.value = t;
        csh.uniforms.uA.value = cheer.amp;
      }
    });
    group.userData.cheer = (k) => {
      cheer.amp = Math.max(cheer.amp, 0.35 * (k || 1));
    };

    // start lights: 5 lamps on each pod; lamp k's vertices are contiguous
    // across both posts so world.setStartLights can recolour each lamp
    const lg = new G.CarModel.GB();
    const lamps = [];
    for (let k = 0; k < 5; k++) {
      const s0 = lg.n;
      for (const sx of [hw, -hw]) lg.box(sx, 8.25 - k * 0.32, 0.27, 0.34, 0.24, 0.06, C(0x2a1111));
      lamps.push([s0, lg.n]);
    }
    const lm = new THREE.Mesh(lg.geometry(), new THREE.MeshBasicMaterial({ vertexColors: true }));
    lm.position.copy(m.position);
    lm.rotation.copy(m.rotation);
    group.add(lm);
    group.userData.lights = { mesh: lm, lamps };
  }

  // Distant mountain ring (unlit, pre-hazed toward the fog colour).
  function mountains(track, th) {
    const b = track.bounds;
    const R = Math.max(b.x1 - b.x0, b.z1 - b.z0) / 2 + 420;
    const rng = U.rng(U.hashStr(track.id + 'mtn'));
    const pos = [], col = [];
    const base = C(th.mtn).lerp(C(th.fog), 0.35), peak = C(th.mtn).lerp(C(th.fog), 0.1), snow = C(0xf4f6f8).lerp(C(th.fog), 0.25);
    const n = 64;
    const hs = [];
    for (let i = 0; i < n; i++) hs.push(40 + rng() * 120 * (0.6 + 0.4 * Math.sin(i * 0.4)));
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
      const h0 = hs[i], h1 = hs[(i + 1) % n], hm = (h0 + h1) / 2 + rng() * 30;
      const P = (a, r, y) => [b.cx + Math.cos(a) * r, y, b.cz + Math.sin(a) * r];
      const ctop = th.snow && hm > 110 ? snow : peak;
      const tri = (p, q, r, c) => {
        pos.push(...p, ...q, ...r);
        for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
      };
      tri(P(a0, R, -4), P(a1, R, -4), P(am, R + 60, hm), base);
      tri(P(a0, R, -4), P(am, R + 60, hm), P(a0, R + 70, h0), peak.clone().lerp(base, 0.4));
      tri(P(a1, R, -4), P(a1, R + 70, h1), P(am, R + 60, hm), ctop);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
    m.userData.castShadow = false;
    m.name = 'mountains';
    return m;
  }

  G.TrackMesh = { build };
})(window.G);
