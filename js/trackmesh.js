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
    ice: [0xbcd8e8, 0xc8e1ee],
    mud: [0x5a3c22, 0x62432a],
    water: [0x3f6f95, 0x46789e],
  };
  // Hazard patch colours (base, inner sheen / ruts / frost)
  const PATCH_COL = { oil: [0x121418, 0x2a2f38], mud: [0x5a3c22, 0x6d4a2b], ice: [0xcfe6f2, 0xf2fbff], water: [0x3f6f95, 0x8fc3e6] };

  // Ground height everywhere (v4): the terrain mesh AND every prop use this,
  // so trees and buildings sit on the hills instead of floating or sinking.
  // Near the road the ground is at the road's elevation; further out, hills
  // rise (theme.hills scales how steeply); toward a sea it drops to the bed.
  let _gH = null;
  // Terrain grid for a track (v5: shared with groundFn, which needs the cell
  // size to keep the ground under the road — see below).
  function terrainGrid(track) {
    const b = track.bounds, m = 260;
    const x0 = b.x0 - m, x1 = b.x1 + m, z0 = b.z0 - m, z1 = b.z1 + m;
    // ~16000 cells whatever the track's size (a 3 km sprint used to get 50 m
    // cells, too coarse to follow the road's crests and dips)
    const cell = Math.max(12, Math.sqrt(((x1 - x0) * (z1 - z0)) / 16000));
    const nx = Math.max(24, Math.round((x1 - x0) / cell)), nz = Math.max(24, Math.round((z1 - z0) / cell));
    return { x0, x1, z0, z1, nx, nz, dx: (x1 - x0) / nx, dz: (z1 - z0) / nz };
  }

  function groundFn(track, seaAt) {
    const N = track.N, th = track.theme;
    const hm = th.hills != null ? th.hills : 1; // (v5.5.8: 0 = dead flat, indoors)
    // v5: the terrain is a mesh of big flat triangles. Where the ground rises
    // next to the road (hills, the leg above a switchback) a triangle's slope
    // used to pass straight through the road. So near every piece of road the
    // ground is held just under that road's lowest edge, out to the wall plus
    // one triangle's reach (any triangle over the road then has all three
    // corners below it), and may only climb 1:1 beyond that. Props use this
    // same function, so they sit on the ground you see. Where a road ends up
    // above the ground beside it, the walls get a stone skirt (see Walls).
    const T = terrainGrid(track);
    const reach = Math.hypot(T.dx, T.dz) + 1.5;
    const low = new Float32Array(N);
    let maxW = 0;
    for (let k = 0; k < N; k++) {
      low[k] = track.Y[k] + Math.min(0, track.bankH(k, track.W[k]), track.bankH(k, -track.W[k])) - 0.12;
      maxW = Math.max(maxW, track.wallD[k]);
    }
    const BS = 40, cols = new Map();
    const key = (i, j) => i * 100003 + j;
    for (let k = 0; k < N; k++) {
      const kk = key(Math.floor(track.X[k] / BS), Math.floor(track.Z[k] / BS));
      let a = cols.get(kk);
      if (!a) cols.set(kk, (a = []));
      a.push(k);
    }
    const SLOPE = 1.0, R = maxW + reach + 30; // beyond ~30 m the 1:1 slope never binds
    const nb = Math.ceil(R / BS), R2 = R * R, cover2 = (nb * BS) ** 2;
    // v5.5.6: far from every road (most of the ground) the nearest sample is
    // found in a coarse grid, ring by ring outwards, instead of a scan of every
    // other sample on the track for each point. Same sample, same tie-break
    // (the lowest index); that scan was a third of a track load.
    const FB = 50;
    let fx0 = Infinity, fz0 = Infinity, fx1 = -Infinity, fz1 = -Infinity;
    for (let k = 0; k < N; k += 2) {
      fx0 = Math.min(fx0, track.X[k]);
      fx1 = Math.max(fx1, track.X[k]);
      fz0 = Math.min(fz0, track.Z[k]);
      fz1 = Math.max(fz1, track.Z[k]);
    }
    const fw = Math.floor((fx1 - fx0) / FB) + 1, fh = Math.floor((fz1 - fz0) / FB) + 1;
    const cells = new Array(fw * fh);
    for (let k = 0; k < N; k += 2) {
      const c = Math.floor((track.X[k] - fx0) / FB) + fw * Math.floor((track.Z[k] - fz0) / FB);
      (cells[c] || (cells[c] = [])).push(k);
    }
    let eBest = Infinity, eK = -1;
    const scan = (x, z, i, j) => {
      const a = cells[i + fw * j];
      if (!a) return;
      for (let n = 0; n < a.length; n++) {
        const k = a[n];
        const ddx = x - track.X[k], ddz = z - track.Z[k];
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < eBest || (d2 === eBest && k < eK)) {
          eBest = d2;
          eK = k;
        }
      }
    };
    const nearestFar = (x, z) => {
      eBest = Infinity;
      eK = -1;
      const qi = Math.floor((x - fx0) / FB), qj = Math.floor((z - fz0) / FB);
      const rMax = Math.max(Math.abs(qi), Math.abs(fw - 1 - qi), Math.abs(qj), Math.abs(fh - 1 - qj));
      for (let r = 0; r <= rMax; r++) {
        // every sample in ring r is more than (r - 1) cells away (1 m spare)
        if (r > 1 && eBest < ((r - 1) * FB - 1) ** 2) break;
        const i0 = Math.max(0, qi - r), i1 = Math.min(fw - 1, qi + r);
        const j0 = Math.max(0, qj - r), j1 = Math.min(fh - 1, qj + r);
        for (let i = i0; i <= i1; i++) {
          if (i === qi - r || i === qi + r) {
            for (let j = j0; j <= j1; j++) scan(x, z, i, j);
          } else {
            if (qj - r >= 0 && qj - r < fh) scan(x, z, i, qj - r);
            if (qj + r >= 0 && qj + r < fh) scan(x, z, i, qj + r);
          }
        }
      }
    };
    const fn = (x, z) => {
      // one pass over the nearby buckets: the nearest sample (for the base
      // height) and the cap; far from any road, fall back to a full search
      let best = 1e9, bk = -1, c = Infinity;
      const bi = Math.floor(x / BS), bj = Math.floor(z / BS);
      for (let i = bi - nb; i <= bi + nb; i++) {
        for (let j = bj - nb; j <= bj + nb; j++) {
          const a = cols.get(key(i, j));
          if (!a) continue;
          for (let n = 0; n < a.length; n++) {
            const k = a[n];
            const ddx = x - track.X[k], ddz = z - track.Z[k];
            const d2 = ddx * ddx + ddz * ddz;
            if (d2 < best) {
              best = d2;
              bk = k;
            }
            if (d2 > R2) continue;
            const d = Math.sqrt(d2), lim = track.wallD[k] + reach;
            const v = d <= lim ? low[k] : low[k] + (d - lim) * SLOPE;
            if (v < c) c = v;
          }
        }
      }
      if (bk < 0 || best > cover2) {
        nearestFar(x, z);
        if (eBest < best) {
          best = eBest;
          bk = eK;
        }
      }
      const d = Math.sqrt(best);
      const base = track.Y[bk];
      fn.lastBase = base; // (v5.6.1: for theme.hillRel colouring)
      // (v5: run-off width varies along the road — pit aprons, gravel traps)
      const flat = track.wallD[bk] + 3, clear = track.wallD[bk] + 14;
      let h = base;
      if (d >= flat) {
        const amp = 0.6 + 0.4 * Math.sin(x * 0.013 + z * 0.021) * Math.sin(z * 0.017 - x * 0.009);
        h = base + Math.min(Math.max(0, d - clear) * 0.12 * hm, 26 * hm) * amp;
      }
      if (seaAt) h = U.lerp(h, -3.2, seaAt(x, z));
      return Math.min(h, c);
    };
    fn.reach = reach;
    fn.grid = T;
    return fn;
  }

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

  // v5.5.6: the build is a generator that pauses between pieces, so the next
  // race's track can be built a few ms per frame while everyone is in the
  // garage and on the betting board (world.js prepareTrack); build() still
  // runs it in one go. After each pause it puts back the two module globals
  // it set, since another track may have been built in between.
  function build(track, opts) {
    const it = steps(track, opts);
    for (;;) {
      const r = it.next();
      if (r.done) return r.value;
    }
  }

  function* steps(track, opts) {
    opts = opts || {};
    const grainOn = (_grainOn = opts.tier !== 'low');
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
    const gH = (_gH = groundFn(track, seaAt));
    const resume = () => {
      _grainOn = grainOn;
      _gH = gH;
    };
    {
      const { x0, z0, nx, nz, dx, dz } = gH.grid;
      const H = [];
      const rng = U.rng(U.hashStr(track.id + 'terrain'));
      const clear = track.wallD[0] + 14;
      // (v5: corners near the road stay on the grid, so no triangle there is
      // longer than groundFn's reach; faceted jitter only further out)
      const calm = gH.reach * 2 + 20;
      // v5.5.6: all that matters below is whether the road (every 4th sample)
      // comes within calm / clear of the point, so only the 3x3 cells around
      // it are searched (cells wider than both) instead of the whole track for
      // each of ~16000 points: the same ground, and most of a track load.
      const CB = Math.max(calm, clear) + 1, cw = Math.floor((nx * dx) / CB) + 1, ch = Math.floor((nz * dz) / CB) + 1;
      const near = new Array(cw * ch);
      for (let k = 0; k < N; k += 4) {
        const ci = Math.floor((track.X[k] - x0) / CB), cj = Math.floor((track.Z[k] - z0) / CB);
        if (ci < 0 || cj < 0 || ci >= cw || cj >= ch) continue; // (off the ground grid: never within calm of it)
        const c = ci + cw * cj;
        (near[c] || (near[c] = [])).push(k);
      }
      for (let j = 0; j <= nz; j++) {
        for (let i = 0; i <= nx; i++) {
          const gx = x0 + i * dx, gz = z0 + j * dz;
          let best = 1e9;
          const ci = Math.floor((gx - x0) / CB), cj = Math.floor((gz - z0) / CB);
          for (let a = Math.max(0, ci - 1); a <= Math.min(cw - 1, ci + 1); a++) {
            for (let e = Math.max(0, cj - 1); e <= Math.min(ch - 1, cj + 1); e++) {
              const ks = near[a + cw * e];
              if (ks) for (let n = 0; n < ks.length; n++) best = Math.min(best, (gx - track.X[ks[n]]) ** 2 + (gz - track.Z[ks[n]]) ** 2);
            }
          }
          const far = Math.sqrt(best) - calm > 0 && !th.smoothGround; // (v5.6.1 theme.smoothGround: no jitter, see gH.mesh)
          const rj = rng(), rk = rng();
          const x = gx + (far && i > 0 && i < nx ? (rj - 0.5) * dx * 0.5 : 0);
          const z = gz + (far && j > 0 && j < nz ? (rk - 0.5) * dz * 0.5 : 0);
          let h = gH(x, z);
          // a little facet noise away from the road
          const jit = (rng() - 0.5) * 1.2;
          if (Math.sqrt(best) > clear && far) h += jit;
          H.push([x, h - 0.05, z, gH.lastBase]);
        }
        if (j % 16 === 15) {
          yield 'ground rows';
          resume();
        }
      }
      yield 'ground';
      resume();
      // (v5.6.1) the mesh's own height anywhere, for ground cover that has to
      // lie right on it: between its corners a big terrain triangle is not
      // where groundFn says, and a field laid by groundFn sank into it in
      // places. Only on an unjittered grid (theme.smoothGround).
      if (th.smoothGround) {
        gH.mesh = (x, z) => {
          const fi = U.clamp((x - x0) / dx, 0, nx - 1e-6), fj = U.clamp((z - z0) / dz, 0, nz - 1e-6), W = nx + 1;
          const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
          const a = H[j * W + i][1], b = H[j * W + i + 1][1], c = H[(j + 1) * W + i + 1][1], d = H[(j + 1) * W + i][1];
          return (u >= v ? a + u * (b - a) + v * (c - b) : a + v * (d - a) + u * (c - d)) + 0.05; // (+0.05: where groundFn's height sits)
        };
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
            // (v5.6.1 theme.hillRel: gold by height above the nearest road
            // instead of above sea level, so a road that climbs keeps its
            // green valley floor and only the hills round it turn gold)
            tmp.lerp(g3, th.hillRel ? U.clamp((hAvg - (p[3] + q[3] + r[3]) / 3) / th.hillRel, 0, 1) : U.clamp(hAvg / 14, 0, 1));
            if (slope > 0.45) tmp.lerp(rock, U.clamp((slope - 0.45) * 1.5, 0, 0.7)); // cliffs show rock
            if (th.snow && hAvg > 18) tmp.lerp(snow, U.clamp((hAvg - 18) / 6, 0, 0.9));
            if (hAvg < -0.25) tmp.copy(beach).multiplyScalar(0.8 + 0.2 * U.clamp(1 + hAvg / 3, 0, 1)); // sea bed / beach
            const cc = tmp.clone().multiplyScalar(sh);
            pushQuadTri(pos, col, p, q, r, cc);
          }
        }
        if (j % 40 === 39) {
          yield 'ground colour rows';
          resume();
        }
      }
      yield 'ground colour';
      resume();
      const terrain = meshFrom(pos, col, grainMat(0.045, 0.22));
      terrain.name = 'terrain';
      group.add(terrain);
    }
    yield 'terrain mesh';
    resume();

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
    yield 'water';
    resume();
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
        if (s % 300 === 299) {
          yield 'road rows';
          resume();
        }
        const sid = G.SURF[track.S[i]].id;
        // (v5.4: a theme can recolour a surface - volcanic gravel is ash-black)
        const pal = (th.surfCol && th.surfCol[sid]) || SURF_COL[sid] || SURF_COL.tarmac;
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
          const pc = C(th.puddle || 0x6a84a3); // (v5.5.8: a night street's puddles are darker)
          const o = ((s * 13) % 7) - 3;
          pushQuad(pos, col, P(i, o + 1.6, 0.01), P(i, o - 1.6, 0.01), P(j, o - 1.6, 0.01), P(j, o + 1.6, 0.01), pc);
        }
        // Runoff strips (gravel traps / sand / concrete) where it isn't grass
        // (v5: per-section width + surface: pit aprons, gravel-trap shortcuts)
        const rsid = G.SURF[track.RS[i]].id;
        if (rsid !== 'grass' || track.GR) {
          const rc = rsid === 'grass' ? C(s % 2 ? th.ground2 : th.ground) : C(((th.surfCol && th.surfCol[rsid]) || SURF_COL[rsid] || SURF_COL.sand)[s % 2]);
          const ra = track.RO[i], rb = track.RO[j];
          pushQuad(pos, col, P(i, w0 + ra, -0.02), P(i, w0, -0.02), P(j, w1, -0.02), P(j, w1 + rb, -0.02), rc);
          pushQuad(pos, col, P(i, -w0, -0.02), P(i, -w0 - ra, -0.02), P(j, -w1 - rb, -0.02), P(j, -w1, -0.02), rc);
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
            const yy = track.Y[A.i] + Y + 0.02;
            pushQuad(pos, col, [A.x, yy, A.z], [Bq.x, yy, Bq.z], [Cq.x, yy, Cq.z], [Dq.x, yy, Dq.z], cc);
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
        const yy = track.Y[A.i] + Y + 0.02;
        pushQuad(pos, col, [A.x, yy, A.z], [Bq.x, yy, Bq.z], [Cq.x, yy, Cq.z], [Dq.x, yy, Dq.z], C(0xf2f2f2));
      }
      // Drag strips: burnout box + threshold "piano keys"
      if (track.format === 'drag') {
        const bo = C(0x33363d);
        for (let d = track.startDist - 16; d < track.startDist - 1; d += 1) {
          const A = track.pointAt(d, 14), Bq = track.pointAt(d, -14), Cq = track.pointAt(d + 1, -14), Dq = track.pointAt(d + 1, 14);
          const yy = track.Y[A.i] + Y + 0.008;
          pushQuad(pos, col, [A.x, yy, A.z], [Bq.x, yy, Bq.z], [Cq.x, yy, Cq.z], [Dq.x, yy, Dq.z], bo);
        }
        for (let k = -6; k <= 6; k++) {
          const la = k * 2.1;
          for (const d0 of [track.startDist + 6, track.finishDist + 4]) {
            // 12 m long: split in 1 m pieces so they follow crests and dips
            for (let e = 0; e < 12; e++) {
              const A = track.pointAt(d0 + e, la + 0.6), Bq = track.pointAt(d0 + e, la - 0.6), Cq = track.pointAt(d0 + e + 1, la - 0.6), Dq = track.pointAt(d0 + e + 1, la + 0.6);
              const ya = track.elevAlong(d0 + e) + Y + 0.013, yb = track.elevAlong(d0 + e + 1) + Y + 0.013;
              pushQuad(pos, col, [A.x, ya, A.z], [Bq.x, ya, Bq.z], [Cq.x, yb, Cq.z], [Dq.x, yb, Dq.z], C(0xf2f2f2));
            }
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

    // ---------------- Hazards (v4): patches, speed pads, obstacles ----------
    yield 'road';
    resume();
    buildHazards(track, group, P);

    // ---------------- Walls ------------------------------------------------
    yield 'hazards';
    resume();
    {
      const pos = [], col = [];
      const q = {};
      const H = 0.9, T = 0.5;
      const wc = th.wall.map(C);
      const stone = C(th.mtn || 0x8a8f96).lerp(C(0x9a948c), 0.5), stone2 = stone.clone().multiplyScalar(0.9);
      const xg = track.xings || [];
      const atXing = (k) => {
        for (const x of xg) {
          let d = Math.abs(track.D[k] - x.at);
          if (closed && d > track.length / 2) d = track.length - d;
          if (d < x.hw) return true;
        }
        return false;
      };
      for (const side of [1, -1]) {
        for (let s = 0; s < segCount; s++) {
          const i = s, j = track.idx(s + 1);
          if (s % 300 === 299) {
            yield 'walls rows';
            resume();
          }
          if (xg.length && (atXing(i) || atXing(j))) continue; // (the rails cross here)
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
          // v5: retaining wall under the road edge down to the ground beside it
          // (switchbacks, embankments: the ground is kept under the road)
          const ga = gH(gnd0[0] + ox * 2, gnd0[2] + oz * 2), gb2 = gH(gnd1[0] + oxb * 2, gnd1[2] + ozb * 2);
          if (ya - ga > 0.35 || yb - gb2 > 0.35) {
            const lo0 = [gnd0[0], Math.min(ya, ga) - 0.4, gnd0[2]], lo1 = [gnd1[0], Math.min(yb, gb2) - 0.4, gnd1[2]];
            quadV(pos, col, lo0, lo1, gnd1, gnd0, (s >> 1) % 2 ? stone : stone2, side, track.NX[i], track.NZ[i]);
          }
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
          const ey = track.Y[end];
          quadV(pos, col, [A.x, ey, A.z], [Bq.x, ey, Bq.z], [Bq.x, ey + H + 0.4, Bq.z], [A.x, ey + H + 0.4, A.z], c, -1, track.TX[end] * dirS, track.TZ[end] * dirS);
          pushQuad(pos, col, [A.x, ey + H + 0.4, A.z], [Bq.x, ey + H + 0.4, Bq.z], [Bq.x + tx, ey + H + 0.4, Bq.z + tz], [A.x + tx, ey + H + 0.4, A.z + tz], c);
        }
      }
      const walls = meshFrom(pos, col);
      walls.castShadow = true;
      walls.name = 'walls';
      group.add(walls);
    }

    // ---------------- Boards: sponsors on straights, 3-2-1 before corners ---
    yield 'walls';
    resume();
    buildBoards(track, group, th);
    // ---------------- Scenery ----------------------------------------------
    yield 'boards';
    resume();
    buildScenery(track, group, detail, seaAt);
    yield 'scenery';
    resume();
    // v5.5.8: the big set pieces (store, city, valley), in slices of their own
    if (SCENES[th.props]) yield* SCENES[th.props](track, group, detail, resume);
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
      if (track.nearRail && track.nearRail(x, z, 2)) return false;
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
      const by = track.Y[i];
      for (const lx of [-3.2, 3.2]) boxAt(gb, x, by, z, rot, lx, 1.1, 0, 0.18, 2.2, 0.18, dark);
      boxAt(gb, x, by, z, rot, 0, 1.9, 0, 7.4, 1.5, 0.14, cb);
      // "logo": a few blocks in the foreground colour
      const kind = Math.floor(rng() * 3);
      if (kind === 0) {
        for (let k = 0; k < 5; k++) boxAt(gb, x, by, z, rot, -2.6 + k * 1.3, 1.9, 0.08, 0.9, 0.6 + (k % 2) * 0.3, 0.04, cf);
      } else if (kind === 1) {
        boxAt(gb, x, by, z, rot, -2.2, 1.9, 0.08, 1.2, 1.1, 0.04, cf);
        boxAt(gb, x, by, z, rot, 0.9, 1.9, 0.08, 4.4, 0.35, 0.04, cf);
      } else {
        boxAt(gb, x, by, z, rot, 0, 2.45, 0.08, 7.2, 0.18, 0.04, cf);
        boxAt(gb, x, by, z, rot, 0, 1.35, 0.08, 7.2, 0.18, 0.04, cf);
        boxAt(gb, x, by, z, rot, 0, 1.9, 0.08, 2.4, 0.5, 0.04, cf);
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
          const by = track.Y[j];
          boxAt(gb, x, by, z, rot, 0, 0.8, 0, 0.12, 1.6, 0.12, dark);
          boxAt(gb, x, by, z, rot, 0, 1.75, 0, 1.3, 1.0, 0.1, C(0xf5f5f5));
          for (let k = 0; k < n; k++) boxAt(gb, x, by, z, rot, -0.36 + k * 0.36 - (n - 1) * 0 + (3 - n) * 0.18, 1.75, 0.06, 0.16, 0.8, 0.04, C(0x111111));
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
      const by = track.Y[i];
      boxAt(gb, x, by, z, rot, 0, 1.1, 0, 1.6, 2.2, 1.6, C(0xff7a1a));
      boxAt(gb, x, by, z, rot, 0, 2.3, 0, 2.0, 0.2, 2.0, C(0xf5f5f5));
      boxAt(gb, x, by, z, rot, 0, 1.4, -0.81, 1.2, 0.5, 0.04, C(0x243447));
      boxAt(gb, x, by, z, rot, 0.9, 3.2, 0, 0.06, 1.8, 0.06, dark);
      boxAt(gb, x, by, z, rot, 1.25, 3.7, 0, 0.7, 0.5, 0.04, C(0xffcc00));
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
    } else if (kind === 'palm') {
      // v4 coast: segmented leaning trunk, a crown of fronds, coconuts
      const tr = C(0x8a6a44);
      for (let k = 0; k < 5; k++) gb.box(k * 0.14, 0.65 + k * 1.3, 0, 0.46 - k * 0.04, 1.32, 0.46 - k * 0.04, k % 2 ? tr : tr.clone().multiplyScalar(0.86));
      const top = [0.72, 7.1, 0];
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        gb.beam(top, [top[0] + Math.cos(a) * 3.3, top[1] - 1.3, top[2] + Math.sin(a) * 3.3], 0.95, 0.08, C(k % 2 ? 0x3f9e4d : 0x2f8a45));
      }
      ico(gb, 0.72, 6.85, 0, 0.36, C(0x6b4a30));
    } else if (kind === 'barrels') {
      // v4 trap: a cluster of oil drums (collider radius ~0.95 at scale 1)
      const cols = [0xe8322b, 0xffc400, 0x2f6bff];
      [[0, 0], [0.62, 0.3], [-0.24, 0.62]].forEach(([x, z], k) => {
        cyl(gb, x, 0.5, z, 0.32, 1.0, 10, C(cols[k]));
        cyl(gb, x, 0.28, z, 0.335, 0.06, 10, C(0x2a2d33));
        cyl(gb, x, 0.74, z, 0.335, 0.06, 10, C(0x2a2d33));
      });
    } else if (kind === 'wreck') {
      // v4 scrapyard: a rusted car hulk, one wheel missing
      gb.box(0, 0.55, 0, 1.8, 0.7, 4.2, C(0x8a4a2a));
      gb.box(0, 1.1, -0.3, 1.5, 0.5, 2.0, C(0x6b3a22));
      gb.box(0, 1.1, 0.72, 1.4, 0.45, 0.06, C(0x243447));
      for (const [x, z] of [[0.85, 1.3], [-0.85, 1.3], [0.85, -1.3]]) cylX(gb, x, 0.33, z, 0.33, 0.2, 8, C(0x1c1d21));
    } else extraGeo(kind, gb);
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

  // items: [{x, z, y?, r?, s?, t?, abs?}] — t = colour tint multiplier (per
  // instance). y is an offset above the ground (groundFn) unless abs is set.
  function instanced(kind, items, group, shadow) {
    if (!items.length) return null;
    const m = new THREE.InstancedMesh(geo(kind), G.CarModel.material(), items.length);
    const o = new THREE.Object3D();
    const tint = new THREE.Color();
    let tinted = false;
    items.forEach((it, k) => {
      o.position.set(it.x, (it.y || 0) + (it.abs || !_gH ? 0 : _gH(it.x, it.z)), it.z);
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
      if (track.nearRail && track.nearRail(x, z, 3)) return false;
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
    if (th.rocks !== 0) instanced(th.props === 'rocks' || th.trees === 'cactus' ? 'redrock' : 'rock', rocks, group, true);

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
    if (th.props === 'city' || th.props === 'rain' || th.lamps) {
      const lamps = ring('lamp', th.lamps ? 14 : 16, 1.2, 0.6, (i, side, x, z) => ({ x, z, r: track.H[i] + (side > 0 ? -Math.PI / 2 : Math.PI / 2), i, side }));
      instanced('lamp', lamps, group, true);
      if (th.night || (th.todTo || 0) >= 0.7) nightLights(track, group, lamps);
    }
    if (th.neon) neonSigns(track, group, rng, clearOf);

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
          docks.push({ x, z, r: Math.atan2(dx, dz), abs: true });
          if (rng() < 0.8) boats.push({ x: x + px * 6 + dx * (6 + rng() * 10), z: z + pz * 6 + dz * (6 + rng() * 10), y: -0.6, abs: true, r: Math.atan2(dx, dz) + (rng() - 0.5) * 0.4 });
        }
        for (let k = 0; k < 3; k++) {
          const a = U.lerp(lo, hi, 0.2 + k * 0.3);
          const x = px * a + dx * (shore - 6), z = pz * a + dz * (shore - 6);
          if (clearOf(x, z, 10)) cranes.push({ x, z, r: Math.atan2(dx, dz) });
        }
        lights.push({ x: px * (hi + 30) + dx * (shore + 14), z: pz * (hi + 30) + dz * (shore + 14), abs: true });
        // v4.4.2: boats out in the bay are placed along/out from the shoreline.
        // They used to start from the track's centre (b.cx, b.cz) and then add
        // the full shore distance on top, counting the centre twice, so on
        // Harbour Loop (centre on the land side) a boat sat on the road.
        const ac = b.cx * px + b.cz * pz;
        for (let k = 0; k < 5; k++) {
          const a = ac + (rng() - 0.5) * 400, out = shore + 70 + rng() * 120;
          const r = rng() * 6.28, s = 0.8 + rng() * 0.5;
          const x = px * a + dx * out, z = pz * a + dz * out;
          if (clearOf(x, z, 14) && seaAt(x, z) > 0.9) boats.push({ x, z, y: -0.6, abs: true, r, s });
        }
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
    if (th.props === 'scrap') {
      // v4 scrapyard: wrecks (some stacked), containers, tyre piles, cranes
      const wr = [], cr = [], cr2 = [], cranes = [], piles = [];
      for (let k = 0; k < 90 * detail; k++) {
        const x = U.lerp(b.x0 - 70, b.x1 + 70, rng()), z = U.lerp(b.z0 - 70, b.z1 + 70, rng());
        if (!clearOf(x, z, 6)) continue;
        const roll = rng();
        const it = { x, z, r: rng() * 6.28, t: 0.7 + rng() * 0.4 };
        if (roll < 0.45) {
          wr.push(it);
          if (rng() < 0.4) wr.push({ x, z, r: it.r + 0.3, y: 0.95, t: it.t });
        } else if (roll < 0.7) (rng() < 0.5 ? cr : cr2).push(Object.assign(it, { r: Math.round(rng() * 2) * (Math.PI / 2) }));
        else piles.push(Object.assign(it, { s: 0.8 + rng() * 0.6 }));
      }
      for (let k = 0; k < 3; k++) {
        const x = U.lerp(b.x0 - 40, b.x1 + 40, rng()), z = U.lerp(b.z0 - 40, b.z1 + 40, rng());
        if (clearOf(x, z, 14)) cranes.push({ x, z, r: rng() * 6.28 });
      }
      instanced('wreck', wr, group, true);
      instanced('crate', cr, group, true);
      instanced('crate2', cr2, group, true);
      instanced('crane', cranes, group, true);
      instanced('tyres', piles, group, false);
      instanced('lamp', ring('lamp', 20, 1.2, 0.6), group, true);
    }
    // Grandstand + start posts + start lights (every track)
    startSetPiece(track, th, group);
  }

  // v4 hazards: oil / mud / ice patches (elliptical decals over the road),
  // glowing speed pads with chevrons (their own unlit mesh, pulsing), and the
  // solid obstacles (instanced props at their collider positions).
  function buildHazards(track, group, P) {
    buildDynamic(track, group);
    if (!track.patches.length && !track.pads.length && !track.obs.length) return;
    const sp = track.sp;
    if (track.patches.length) {
      const pos = [], col = [];
      for (const pt of track.patches) {
        const [c0, c1] = PATCH_COL[pt.k].map(C);
        const n = Math.max(3, Math.ceil((pt.hl * 2) / sp));
        for (let k = 0; k < n; k++) {
          const u0 = -1 + (2 * k) / n, u1 = -1 + (2 * (k + 1)) / n;
          const i0 = track.idx(pt.ic + Math.round((u0 * pt.hl) / sp)), i1 = track.idx(pt.ic + Math.round((u1 * pt.hl) / sp));
          if (i0 === i1) continue;
          const w0 = pt.hw * Math.sqrt(Math.max(0, 1 - u0 * u0)), w1 = pt.hw * Math.sqrt(Math.max(0, 1 - u1 * u1));
          pushQuad(pos, col, P(i0, pt.lat + w0, 0.016), P(i0, pt.lat - w0, 0.016), P(i1, pt.lat - w1, 0.016), P(i1, pt.lat + w1, 0.016), c0);
          pushQuad(pos, col, P(i0, pt.lat + w0 * 0.5, 0.022), P(i0, pt.lat - w0 * 0.05, 0.022), P(i1, pt.lat - w1 * 0.05, 0.022), P(i1, pt.lat + w1 * 0.5, 0.022), c1);
        }
      }
      const m = meshFrom(pos, col, new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.name = 'patches';
      group.add(m);
    }
    if (track.pads.length) {
      const pos = [], col = [];
      const base = C(0x0b2a4a), chev = C(0x39d4ff), hot = C(0xeaffff);
      const Q = (d, l, dy) => {
        const p = track.pointAt(d, l);
        return [p.x, track.elevAlong(d) + track.bankH(p.i, l) + 0.04 + dy, p.z];
      };
      for (const pd of track.pads) {
        const d0 = pd.at - pd.hl, d1 = pd.at + pd.hl, l = pd.lat, w = pd.hw;
        for (let e = 0; e < 4; e++) {
          const a = U.lerp(d0, d1, e / 4), b2 = U.lerp(d0, d1, (e + 1) / 4);
          pushQuad(pos, col, Q(a, l + w, 0.018), Q(a, l - w, 0.018), Q(b2, l - w, 0.018), Q(b2, l + w, 0.018), base);
        }
        const L = d1 - d0;
        for (let k = 0; k < 3; k++) {
          const c0 = d0 + L * (0.12 + k * 0.28);
          const cc = k === 2 ? hot : chev;
          for (const s of [1, -1]) pushQuad(pos, col, Q(c0, l + s * w * 0.85, 0.024), Q(c0 + 0.45, l + s * w * 0.85, 0.024), Q(c0 + 1.35, l, 0.024), Q(c0 + 0.9, l, 0.024), cc);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.computeBoundingSphere();
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      const m = new THREE.Mesh(g, mat);
      m.name = 'pads';
      group.add(m);
      group.userData.animFns.push((t) => mat.color.setScalar(0.72 + 0.28 * (0.5 + 0.5 * Math.sin(t * 7))));
    }
    if (track.obs.length) {
      const byK = { barrels: [], tyres: [], rock: [] };
      for (const o of track.obs) {
        const it = { x: o.x, z: o.z, r: (o.i * 1.7) % 6.28, y: track.heightAt(o.i, o.lat), abs: true };
        if (o.k === 'rock') byK.rock.push(Object.assign(it, { s: o.r / 1.3 }));
        else if (o.k === 'tyres') byK.tyres.push(Object.assign(it, { s: o.r / 0.58 }));
        else byK.barrels.push(Object.assign(it, { s: o.r / 0.95 }));
      }
      instanced('barrels', byK.barrels, group, true);
      instanced('tyres', byK.tyres, group, true);
      instanced('rock', byK.rock, group, true);
    }
  }

  // ---------------------------------------------------------------- v5 night
  // Fake lighting: nothing here is a real light (a light per lamp would cost
  // every pixel on the Chromebooks). Lamp heads are glowing points, the light
  // on the road is an additive pool under each lamp, neon is unlit colour.
  // World fades them in with the dark (userData.nightMats, world.js _atmos).
  let _glowTex = null;
  function glowTex() {
    if (_glowTex) return _glowTex;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.6)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.18)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    _glowTex = new THREE.CanvasTexture(cv);
    return _glowTex;
  }
  function nightMat(group, obj, mat, base) {
    (group.userData.nightMats || (group.userData.nightMats = [])).push({ obj, mat, base });
    mat.opacity = 0;
    obj.visible = false;
  }

  function nightLights(track, group, lamps) {
    const heads = [], pos = [], uv = [];
    const tint = track.theme.neon ? 0xffd9a8 : 0xffe7b0;
    for (const l of lamps) {
      // lamp head: 1.7 m out along the arm, toward the road, 6.7 m up
      const lat = l.side * (track.wallD[l.i] + 1.2 - 1.7);
      const hp = track.pointAt(track.D[l.i], lat);
      heads.push(hp.x, track.heightAt(l.i, U.clamp(lat, -track.wallD[l.i], track.wallD[l.i])) + 6.6, hp.z);
      // pool of light on the ground: 18 × 18 m, centred a little in from the lamp
      const c = l.side * Math.max(0, track.wallD[l.i] - 4.5), d = track.D[l.i], R = 9;
      for (let a = 0; a < 2; a++) {
        for (let b = 0; b < 2; b++) {
          const q = (u, v) => {
            const la = c + (u - 0.5) * 2 * R, dd = d + (v - 0.5) * 2 * R;
            const pt = track.pointAt(dd, la);
            const cl = U.clamp(la, -track.wallD[pt.i], track.wallD[pt.i]);
            return [pt.x, track.elevAlong(dd) + track.bankH(pt.i, cl) + 0.07, pt.z, u, v];
          };
          const A = q(a / 2, b / 2), B = q((a + 1) / 2, b / 2), Cq = q((a + 1) / 2, (b + 1) / 2), D = q(a / 2, (b + 1) / 2);
          for (const v of [A, B, Cq, A, Cq, D]) {
            pos.push(v[0], v[1], v[2]);
            uv.push(v[3], v[4]);
          }
        }
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    pg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    pg.computeBoundingSphere();
    const pm = new THREE.MeshBasicMaterial({ map: glowTex(), color: tint, transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
    const pools = new THREE.Mesh(pg, pm);
    pools.name = 'lightPools';
    pools.renderOrder = 1;
    group.add(pools);
    nightMat(group, pools, pm, 0.55);
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute(heads, 3));
    const hm = new THREE.PointsMaterial({ map: glowTex(), color: 0xfff2cc, size: 4.2, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const hp = new THREE.Points(hg, hm);
    hp.name = 'lampHeads';
    group.add(hp);
    nightMat(group, hp, hm, 1);
  }

  const NEON = [0xff2d92, 0x19e3ff, 0xb44dff, 0xffb020, 0x3dff8a];
  function neonSigns(track, group, rng, clearOf) {
    const back = new G.CarModel.GB(), tube = new G.CarModel.GB();
    const gap = 30; // samples (60 m), alternating sides
    let n = 0, placed = 0;
    for (let i = 7; i < track.N; i += gap) {
      const side = n++ % 2 ? 1 : -1;
      const lat = side * (track.wallD[i] + 3.2);
      const x = track.X[i] + track.NX[i] * lat, z = track.Z[i] + track.NZ[i] * lat;
      if (!clearOf(x, z, 1.5)) continue;
      placed++;
      const y = _gH ? _gH(x, z) : 0;
      const col = C(NEON[Math.floor(rng() * NEON.length)]), col2 = C(NEON[Math.floor(rng() * NEON.length)]);
      const w = 5 + rng() * 4, h = 2 + rng() * 1.4, top = 5.5 + rng() * 3;
      // the sign faces the road: local +z = toward the road, local +x along it
      const nx = -track.NX[i] * side, nz = -track.NZ[i] * side, r = Math.atan2(nx, nz);
      const ux = nz, uz = -nx;
      const at = (u, v, f) => [x + ux * u + nx * f, y + v, z + uz * u + nz * f];
      for (const u of [-w * 0.35, w * 0.35]) {
        const pp = at(u, top / 2, -0.25);
        back.box(pp[0], pp[1], pp[2], 0.3, top, 0.3, C(0x23252b), r);
      }
      const mid = at(0, top - h / 2, 0);
      back.box(mid[0], mid[1], mid[2], w, h, 0.3, C(0x14151a), r);
      // neon: an outline and two bars of "lettering"
      const bars = [
        [0, -h / 2 + 0.27, w - 0.4, 0.14, col],
        [0, h / 2 - 0.27, w - 0.4, 0.14, col],
        [-w / 2 + 0.27, 0, 0.14, h - 0.4, col],
        [w / 2 - 0.27, 0, 0.14, h - 0.4, col],
        [-w * 0.1, 0.32, w * 0.62, 0.34, col2],
        [-w * 0.2, -0.4, w * 0.42, 0.3, col2],
      ];
      for (const [u, v, bw, bh, c] of bars) {
        const pp = at(u, top - h / 2 + v, 0.2);
        tube.box(pp[0], pp[1], pp[2], bw, bh, 0.08, c, r);
      }
    }
    if (!placed) return;
    const bm = new THREE.Mesh(back.geometry(), G.CarModel.material());
    bm.castShadow = true;
    group.add(bm);
    const tm = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true });
    const tmesh = new THREE.Mesh(tube.geometry(), tm);
    tmesh.name = 'neon';
    group.add(tmesh);
    nightMat(group, tmesh, tm, 1);
    // a slight buzz, and now and then the whole strip stutters
    group.userData.animFns.push((t) => {
      if (!tmesh.visible) return;
      const cut = Math.sin(t * 31) > 0.985 || Math.sin(t * 2.3 + 1) > 0.995;
      tm.color.setScalar(cut ? 0.45 : 0.93 + 0.07 * Math.sin(t * 60));
    });
  }
  function boxGeo(w, h, d, col) {
    const gb = new G.CarModel.GB();
    gb.box(0, 0, 0, w, h, d, C(col));
    return gb.geometry();
  }

  // ------------------------------------------------------- v5 moving hazards
  // Rockfall zones, wrecking balls, crosswind socks and the pit box. Where a
  // moving hazard is comes from track.dynPos(race time) — the same function
  // the physics uses — so what you see is exactly what you hit.
  function buildDynamic(track, group) {
    const env = () => group.userData.env || { t: 0 };
    const tmp = {}, q = {};
    for (const o of track.dyn) {
      if (o.k === 'train' && o.look && o.look !== 'train') {
        // v5.6.1 crossings that aren't railways: forklifts out of the
        // Megastore's stockrooms, a tractor and its hay wagons on Harvest Run.
        // Same timing, physics and bots as a level crossing (each vehicle is
        // a carriage). Built in the crossing's frame like the railway: local
        // X across the road, Z along it; everything is mirror-symmetric in X.
        const i = o.i, y0 = track.Y[i], H0 = track.H[i], cx = track.X[i], cz = track.Z[i];
        const fork = o.look === 'forklift', wd = track.wallD[i];
        const ground = (x, z) => (_gH ? (_gH.mesh || _gH)(x, z) : y0);
        const W = (lx, lz) => [cx + lx * Math.cos(H0) + lz * Math.sin(H0), cz - lx * Math.sin(H0) + lz * Math.cos(H0)];
        if (!o.car) {
          const xb = new G.CarModel.GB(), wb = new G.CarModel.GB(), txt = new G.CarModel.GB(), lampOn = [];
          const at = (lx, lz) => {
            const p = W(lx, lz);
            return [p[0], ground(p[0], p[1]), p[1]];
          };
          if (fork) {
            // yellow and black stripes down both edges of the forklift lane,
            // right across the aisle; a stockroom at each end, its door hung
            // with plastic strips (the forklifts come and go through it)
            for (let k = -o.span + 1.6, n = 0; k < o.span - 1.6; k += 1.2, n++) for (const sz of [-2.2, 2.2]) xb.box(k + 0.6, 0.03, sz, 1.2, 0.02, 0.32, C(n % 2 ? 0x1b1d22 : 0xf2c230));
            for (const sx of [-1, 1]) {
              const face = sx * (o.span - 1.6);
              xb.box(sx * (o.span + 2.4), 2.6, 0, 8, 5.2, 10, C(0xd9d6cf));
              xb.box(sx * (o.span + 2.4), 5.25, 0, 8.3, 0.1, 10.3, C(0x9a9ea5));
              xb.box(face - sx * 0.03, 1.7, 0, 0.04, 3.4, 3.4, C(0x2a2d33));
              for (let k = -6; k <= 6; k++) xb.box(face - sx * 0.07, 1.72, k * 0.25, 0.03, 3.3, 0.18, C(k % 2 ? 0xb9c6cc : 0xa7b6bd));
              xb.box(face - sx * 0.05, 4.1, 0, 0.06, 0.7, 4.2, C(0x2a2d33));
              pixText(txt, 'STOCKROOM', [face - sx * 0.1, 4.1, 0], [0, 0, sx], [0, 1, 0], 0.06, C(0xf2c230), [-sx, 0, 0]);
              for (const sz of [-4, 4]) {
                xb.box(face - sx * 0.1, 3.9, sz, 0.12, 0.12, 0.12, C(0x3b3d42));
                lampOn.push([face - sx * 0.18, 3.9, sz]);
              }
            }
            // a post at each edge of the road, each way: amber flasher, sign
            for (const sx of [wd + 0.9, -wd - 0.9]) {
              for (const sz of [-3.4, 3.4]) {
                xb.box(sx, 1.35, sz, 0.12, 2.7, 0.12, C(0x2a2d33));
                xb.box(sx, 2.25, sz, 1.5, 0.5, 0.06, C(0xf2c230));
                pixText(txt, 'FORKLIFTS', [sx, 2.25, sz + Math.sign(sz) * 0.04], [Math.sign(sz), 0, 0], [0, 1, 0], 0.035, C(0x1b1d22), [0, 0, Math.sign(sz)]);
                xb.box(sx, 2.8, sz, 0.26, 0.26, 0.26, C(0x3b3d42));
                lampOn.push([sx, 2.8, sz + Math.sign(sz) * 0.14]);
              }
            }
          } else {
            // a dirt farm track across both verges; a pole barn at each end
            // the tractor drives in and out of; diamond warning signs on the
            // approaches with amber flashers on top
            for (const sx of [-1, 1]) {
              gpatch(wb, W(sx * (wd - 0.5), -2.2), W(sx * (o.span - 1), -2.2), W(sx * (o.span - 1), 2.2), W(sx * (wd - 0.5), 2.2), C(0x8a6a48), 0.1, Math.max(2, Math.round((o.span - wd) / 4)), 1);
              const bx = sx * (o.span + 1.2), [px, pz] = W(bx, 0), by = ground(px, pz);
              const red = C(0x9c3a2e), roof = C(0x6b6f75);
              boxAt(wb, px, by, pz, H0, sx * 4, 2.2, 0, 0.3, 5.4, 9, red); // back wall
              for (const sz of [-4.4, 4.4]) boxAt(wb, px, by, pz, H0, 0, 2.2, sz, 8, 5.4, 0.3, red);
              for (const sz of [-4.4, 4.4]) boxAt(wb, px, by, pz, H0, -sx * 4, 2.3, sz, 0.35, 4.6, 0.35, C(0xece6d8)); // corner posts, white
              boxAt(wb, px, by, pz, H0, -sx * 4, 4.55, 0, 0.35, 0.3, 9, C(0xece6d8)); // the header over the opening
              const rp = rotPt(px, pz, H0, 0, 0);
              roofW(wb, rp[0], by + 4.9, rp[1], H0 + Math.PI / 2, 9.2, 8.2, 2.2, 'gable', roof);
              for (const k of [0, 1]) boxAt(wb, px, by, pz, H0, sx * (2.5 - k * 1.3), 0.45 + k * 0.6, 3.2, 1.1, 0.6, 1.1, C(0xd9b860)); // bales inside
            }
            for (const sz of [-30, 30]) {
              for (const sx of [wd + 1.2, -wd - 1.2]) {
                const [px, py, pz] = at(sx, sz), s = Math.sign(sz);
                boxAt(wb, px, py, pz, H0, 0, 1.4, 0, 0.12, 2.8, 0.12, C(0x8a9097));
                // the diamond (a quad on its corner), facing traffic coming at it
                const Dp = (lx, ly) => {
                  const p = rotPt(px, pz, H0, lx, s * 0.07);
                  return [p[0], py + ly, p[1]];
                };
                const nn = rotPt(0, 0, H0, 0, s);
                wb.quadN(Dp(0, 2.35), Dp(0.75, 3.1), Dp(0, 3.85), Dp(-0.75, 3.1), C(0xf2c230), [nn[0], 0, nn[1]]);
                // the tractor on it: body, cab, a big wheel and a little one
                const Tq = (lx, ly, w, h) => {
                  const p0 = rotPt(px, pz, H0, lx - w / 2, s * 0.09), p1 = rotPt(px, pz, H0, lx + w / 2, s * 0.09);
                  wb.quadN([p0[0], py + ly - h / 2, p0[1]], [p1[0], py + ly - h / 2, p1[1]], [p1[0], py + ly + h / 2, p1[1]], [p0[0], py + ly + h / 2, p0[1]], C(0x1b1d22), [nn[0], 0, nn[1]]);
                };
                Tq(0.05, 3.12, 0.55, 0.14);
                Tq(-0.12, 3.3, 0.2, 0.26);
                Tq(-0.14, 2.93, 0.26, 0.26);
                Tq(0.26, 2.9, 0.16, 0.16);
                lampOn.push([sx, py - y0 + 4.05, sz]);
                boxAt(wb, px, py, pz, H0, 0, 4.05, 0, 0.24, 0.24, 0.24, C(0x3b3d42));
              }
            }
          }
          for (const [gb2, sh] of [[xb, true], [txt, false]]) {
            if (!gb2.p.length) continue;
            const m = new THREE.Mesh(gb2.geometry(), G.CarModel.material());
            m.position.set(cx, y0, cz);
            m.rotation.y = H0;
            m.castShadow = sh;
            group.add(m);
          }
          worldMesh(group, wb, null, 'crossing', true);
          // amber flashers, two sets flashed in turn while it's coming
          const mk = (odd) => {
            const lb = new G.CarModel.GB();
            lampOn.forEach((q, k) => { if (k % 2 === odd) lb.box(q[0], q[1], q[2], 0.3, 0.3, 0.3, C(0xffa21a)); });
            const m = new THREE.Mesh(lb.geometry(), new THREE.MeshBasicMaterial({ vertexColors: true }));
            m.position.set(cx, y0, cz);
            m.rotation.y = H0;
            m.visible = false;
            group.add(m);
            return m;
          };
          const lA = mk(0), lB = mk(1);
          const pass = (2 * o.span + o.cars * o.gap) / o.speed;
          let told = -1;
          group.userData.animFns.push(() => {
            const t = env().t;
            if (t <= 0) { lA.visible = lB.visible = false; return; }
            const c = t + o.off, n = Math.floor(c / o.every), ph = c - n * o.every;
            const warn = ph < pass || ph > o.every - 2.5, on = Math.floor(t * 2.2) % 2 === 0;
            lA.visible = warn && on;
            lB.visible = warn && !on;
            if (ph < 0.6 && told !== n) {
              told = n;
              const cam = group.userData.cam;
              const k = cam ? U.clamp(1.15 - Math.hypot(cam.fx - cx, cam.fz - cz) / 120, 0, 1) : 0;
              if (G.Audio && k > 0) {
                if (fork) G.Audio.forkBeep(k);
                else G.Audio.tractorHorn(k);
              }
            }
          });
        }
        // this vehicle, built facing +Z and turned to the way it's going
        const vb = new G.CarModel.GB(), dark = C(0x24262b);
        let beacon = null;
        if (fork && o.car === 0) {
          // the load on the forks: a pallet of boxes
          for (const x of [-0.3, 0.3]) vb.box(x, 0.2, -0.3, 0.12, 0.05, 1.6, dark);
          vb.box(0, 0.32, 0, 1.15, 0.14, 1.2, C(0xa9855a));
          vb.box(0, 0.93, 0, 1.1, 1.08, 1.12, C(0xc49a6c));
          vb.box(0, 0.93, 0.57, 0.14, 1.09, 0.02, C(0xd9c7a0)); // tape
          vb.box(0.15, 1.72, -0.1, 0.7, 0.5, 0.7, C(0xb88c5e));
        } else if (fork) {
          const orange = C(0xf29a1a);
          vb.box(0, 0.6, 0, 1.2, 0.7, 2.2, orange);
          vb.box(0, 0.95, -0.95, 1.22, 1.0, 0.5, dark); // counterweight
          vb.box(0, 1.1, -0.2, 0.5, 0.3, 0.5, C(0x111214)); // seat
          for (const x of [-0.55, 0.55]) for (const z of [-0.8, 0.55]) vb.box(x, 1.65, z, 0.08, 1.5, 0.08, dark);
          vb.box(0, 2.42, -0.12, 1.22, 0.07, 1.5, dark); // overhead guard
          for (const x of [-0.35, 0.35]) vb.box(x, 1.7, 1.28, 0.12, 3.1, 0.14, dark); // mast
          vb.box(0, 3.2, 1.28, 0.82, 0.12, 0.14, dark);
          for (const x of [-0.58, 0.58]) for (const z of [-0.75, 0.75]) cylX(vb, x, 0.3, z, 0.3, 0.24, 8, C(0x111214));
          beacon = [0, 2.58, -0.3];
        } else if (o.car === 0) {
          const red = C(0xb8352c);
          vb.box(0, 1.2, 0.8, 1.0, 0.9, 2.1, red); // bonnet
          vb.box(0, 2.0, -0.55, 1.4, 1.5, 1.4, C(0x2b3440)); // cab glass
          for (const x of [-0.68, 0.68]) for (const z of [-1.22, 0.12]) vb.box(x, 2.0, z, 0.1, 1.5, 0.1, red);
          vb.box(0, 2.8, -0.55, 1.6, 0.12, 1.6, red);
          vb.box(0.36, 2.35, 1.35, 0.1, 1.2, 0.1, dark); // exhaust
          vb.box(0, 0.65, -1.6, 0.2, 0.2, 0.8, dark); // hitch
          for (const x of [-1, 1]) {
            cylX(vb, x, 0.9, -0.6, 0.9, 0.55, 12, C(0x1d1e20));
            cylX(vb, x * 1.01, 0.9, -0.6, 0.42, 0.57, 8, C(0xb9b4a8));
            cylX(vb, x * 0.8, 0.5, 1.45, 0.5, 0.36, 10, C(0x1d1e20));
          }
          beacon = [0, 2.98, -0.55];
        } else {
          // a hay wagon: a flatbed stacked with bales
          vb.box(0, 1.0, 0, 2.3, 0.2, 3.6, C(0x9a7550));
          vb.box(0, 0.7, 2.2, 0.15, 0.15, 0.9, dark); // tow bar
          for (const x of [-1.05, 1.05]) for (const z of [-1.1, 1.1]) cylX(vb, x, 0.45, z, 0.45, 0.3, 8, C(0x1d1e20));
          const bale = C(0xd9b860);
          for (let a = 0; a < 2; a++) for (let b2 = 0; b2 < 3; b2++) vb.box(-0.55 + a * 1.1, 1.45, -1.15 + b2 * 1.15, 1.05, 0.7, 1.1, b2 % 2 ? bale : bale.clone().multiplyScalar(0.93));
          for (let a = 0; a < 2; a++) for (let b2 = 0; b2 < 2; b2++) vb.box(-0.55 + a * 1.1, 2.15, -0.6 + b2 * 1.2, 1.05, 0.7, 1.1, bale.clone().multiplyScalar(0.97));
        }
        const car = new THREE.Mesh(vb.geometry(), G.CarModel.material());
        car.castShadow = true;
        car.visible = false;
        group.add(car);
        let bm = null;
        if (beacon) {
          const bg = new G.CarModel.GB();
          bg.box(beacon[0], beacon[1], beacon[2], 0.22, 0.2, 0.22, C(0xffa21a));
          bm = new THREE.Mesh(bg.geometry(), new THREE.MeshBasicMaterial({ vertexColors: true }));
          car.add(bm);
        }
        const tp = {}, q2 = {};
        group.userData.animFns.push(() => {
          const t = env().t, p = track.dynPos(o, t, tp);
          if (!p) { car.visible = false; return; }
          car.visible = true;
          track.query(p.x, p.z, o.i, q2);
          const onRoad = Math.abs(q2.lat) < track.W[q2.i] + 0.4;
          car.position.set(p.x, onRoad ? track.heightAt(q2.i, q2.lat) : ground(p.x, p.z) - 0.05, p.z);
          car.rotation.y = Math.atan2(p.vx, p.vz);
          if (bm) bm.visible = Math.floor(t * 3.2) % 2 === 0;
        });
        continue;
      }
      if (o.k === 'train') {
        // v5.4 level crossing. Built in the crossing's own frame: local X runs
        // ALONG the rails (across the road), local Z along the road.
        const i = o.i, y0 = track.Y[i], H0 = track.H[i];
        const cx = track.X[i], cz = track.Z[i];
        if (!o.car) {
          const xb = new G.CarModel.GB();
          for (const rl of [-0.72, 0.72]) xb.box(0, 0.07, rl, o.span * 2, 0.1, 0.12, C(0x7a808a));
          for (let k = -o.span; k <= o.span; k += 1.4) xb.box(k, 0.03, 0, 0.32, 0.06, 2.4, C(0x3a2e24));
          // a post each side of the road, before the rails in each direction:
          // crossbuck on top, twin lamps under it
          const lampOn = [], wd = track.wallD[i] + 0.9;
          for (const sx of [wd, -wd]) {
            for (const sz of [-3.6, 3.6]) {
              xb.box(sx, 1.6, sz, 0.14, 3.2, 0.14, C(0xf4f4f4));
              xb.beam([sx - 0.66, 2.66, sz], [sx + 0.66, 3.34, sz], 0.06, 0.18, C(0xe8322b));
              xb.beam([sx - 0.66, 3.34, sz], [sx + 0.66, 2.66, sz], 0.06, 0.18, C(0xe8322b));
              xb.box(sx, 2.3, sz, 0.9, 0.34, 0.08, C(0x1b1d22));
              for (const lx of [-0.26, 0.26]) lampOn.push([sx + lx, 2.3, sz + Math.sign(sz) * 0.06]);
            }
          }
          const xm = new THREE.Mesh(xb.geometry(), G.CarModel.material());
          xm.position.set(cx, y0, cz);
          xm.rotation.y = H0;
          xm.castShadow = true;
          group.add(xm);
          // the lamps: two sets of lit discs, flashed alternately
          const mk = (odd) => {
            const lb = new G.CarModel.GB();
            lampOn.forEach((q, k) => { if (k % 2 === odd) lb.box(q[0], q[1], q[2], 0.2, 0.2, 0.05, C(0xff3b30)); });
            const m = new THREE.Mesh(lb.geometry(), new THREE.MeshBasicMaterial({ vertexColors: true }));
            m.position.set(cx, y0, cz);
            m.rotation.y = H0;
            m.visible = false;
            group.add(m);
            return m;
          };
          const lA = mk(0), lB = mk(1);
          const pass = (2 * o.span + o.cars * o.gap) / o.speed;
          let horned = -1;
          group.userData.animFns.push(() => {
            const t = env().t;
            if (t <= 0) { lA.visible = lB.visible = false; return; }
            const c = t + o.off, n = Math.floor(c / o.every), ph = c - n * o.every;
            const warn = ph < pass || ph > o.every - 2.5;
            const on = warn && Math.floor(t * 2.6) % 2 === 0;
            lA.visible = warn && on;
            lB.visible = warn && !on;
            // the horn as it comes in, if you are near enough to hear it
            if (ph < 0.6 && horned !== n) {
              horned = n;
              const cam = group.userData.cam;
              if (cam && G.Audio && G.Audio.trainHorn) G.Audio.trainHorn(U.clamp(1.15 - Math.hypot(cam.fx - cx, cam.fz - cz) / 140, 0, 1));
            }
          });
        }
        // this carriage: the loco in yellow, then container wagons
        const cb = new G.CarModel.GB();
        const L = o.gap * 0.92;
        const loco = !o.car;
        const colBody = loco ? C(0xffc400) : C([0x2f6bb5, 0x9c3a26, 0x4d7d4a, 0x7a7f88][o.car % 4]);
        cb.box(0, 0.55, 0, L, 0.4, 2.6, C(0x22252b)); // chassis
        for (const wx of [-L * 0.3, L * 0.3]) for (const wz of [-0.8, 0.8]) cb.box(wx, 0.38, wz, 0.7, 0.62, 0.2, C(0x121418));
        cb.box(0, 2.0, 0, L - 0.08, 2.5, 2.7, colBody);
        if (loco) {
          cb.box(-L * 0.28, 2.75, 0, L * 0.34, 0.8, 2.72, C(0x1b1d22)); // cab windows
          cb.box(L * 0.2, 3.35, 0, L * 0.4, 0.2, 2.3, C(0x3a3f47));
        } else {
          for (let k = -2; k <= 2; k++) cb.box(k * L * 0.18, 2.0, 1.36, 0.06, 2.3, 0.02, colBody.clone().multiplyScalar(0.8)); // corrugations
          for (let k = -2; k <= 2; k++) cb.box(k * L * 0.18, 2.0, -1.36, 0.06, 2.3, 0.02, colBody.clone().multiplyScalar(0.8));
        }
        const car = new THREE.Mesh(cb.geometry(), G.CarModel.material());
        car.castShadow = true;
        car.visible = false;
        car.rotation.y = H0;
        group.add(car);
        const tp = {};
        group.userData.animFns.push(() => {
          const p = track.dynPos(o, env().t, tp);
          if (!p) { car.visible = false; return; }
          car.visible = true;
          car.position.set(p.x, y0, p.z);
        });
      } else if (o.k === 'swing') {
        // gantry across the road, chain + ball on a pivot
        const i = o.i, wd = track.wallD[i] + 1.4, H = 14.5, L = H - o.r - 0.25;
        const gb = new G.CarModel.GB();
        const y0 = track.Y[i];
        for (const sx of [wd, -wd]) {
          gb.box(sx, H / 2, 0, 0.7, H, 0.7, C(0xffc400));
          for (let k = 0; k < 6; k++) gb.box(sx, 1 + k * 2.4, 0, 0.74, 0.5, 0.74, C(0x1b1d22));
        }
        gb.box(0, H + 0.4, 0, wd * 2 + 0.8, 0.8, 0.9, C(0xffc400));
        gb.box(o.lat, H - 0.1, 0, 1.4, 0.5, 1.2, C(0x2a2d33));
        const gantry = new THREE.Mesh(gb.geometry(), G.CarModel.material());
        gantry.position.set(track.X[i], y0, track.Z[i]);
        gantry.rotation.y = track.H[i];
        gantry.castShadow = true;
        group.add(gantry);
        const pivot = new THREE.Object3D();
        pivot.position.set(o.lat, H - 0.2, 0);
        gantry.add(pivot);
        const cb = new G.CarModel.GB();
        cb.box(0, -L / 2, 0, 0.14, L, 0.14, C(0x3a3f47));
        cb.box(0, -L + o.r + 0.15, 0, 0.5, 0.4, 0.5, C(0x5a5f68)); // shackle
        const sg = new THREE.IcosahedronGeometry(o.r, 1), sp = sg.attributes.position;
        for (let k = 0; k < sp.count; k += 3) {
          const v = (j) => [sp.getX(j), sp.getY(j) - L, sp.getZ(j)];
          const band = Math.abs((sp.getY(k) + sp.getY(k + 1) + sp.getY(k + 2)) / 3) < o.r * 0.22;
          cb.tri(v(k), v(k + 1), v(k + 2), C(band ? 0xffc400 : (k / 3) % 2 ? 0x30343c : 0x2a2d34), 0, -L, 0);
        }
        sg.dispose();
        const ball = new THREE.Mesh(cb.geometry(), G.CarModel.material());
        ball.castShadow = true;
        pivot.add(ball);
        const w = (2 * Math.PI) / o.period;
        let lastS = 0;
        const bx = track.X[i] + track.NX[i] * o.lat, bz = track.Z[i] + track.NZ[i] * o.lat;
        group.userData.animFns.push(() => {
          const ph = Math.sin(w * env().t + o.off);
          const off = o.amp * ph;
          pivot.rotation.z = Math.asin(U.clamp(off / L, -0.99, 0.99));
          // a swish each time it sweeps through the middle, if you're near
          const cam = group.userData.cam;
          if (cam && G.Audio && env().t > 0 && Math.sign(ph) !== Math.sign(lastS)) G.Audio.whoosh(U.clamp(1.1 - Math.hypot(cam.fx - bx, cam.fz - bz) / 45, 0, 1));
          lastS = ph;
        });
      } else if (o.k === 'rockfall') {
        // warning signs at the zone ends, rubble on the verges, one live rock
        // per stream (the signs and rubble once per zone)
        const rb = new G.CarModel.GB();
        const rng = U.rng(o.seed);
        for (let k = 0; k < 14; k++) {
          const d = o.at + (rng() - 0.5) * o.len, side = rng() < 0.5 ? 1 : -1;
          const pq = track.pointAt(d, 0);
          const lat = side * (track.wallD[pq.i] + 0.8 + rng() * 2.5);
          const pt = track.pointAt(d, lat);
          if (o.look === 'debris') {
            const s = 0.5 + rng() * 0.9, g2 = _gH ? _gH(pt.x, pt.z) : track.Y[pt.i];
            rb.box(pt.x, g2 + s * 0.22, pt.z, s * 1.5, s * 0.45, s, C(rng() < 0.5 ? 0x8e8c88 : 0x6e6c68), rng() * 3);
          } else ico(rb, pt.x, (_gH ? _gH(pt.x, pt.z) : track.Y[pt.i]) + 0.2, pt.z, 0.4 + rng() * 0.7, C(rng() < 0.5 ? 0x8f857c : 0x7a716a));
        }
        for (const e of [-1, 1]) {
          const d = o.at + e * (o.len / 2 + 12), pq = track.pointAt(d, 0);
          const lat = -e * (track.wallD[pq.i] + 1.5), pt = track.pointAt(d, lat);
          const gy = _gH ? _gH(pt.x, pt.z) : track.Y[pt.i];
          rb.box(pt.x, gy + 1.3, pt.z, 0.14, 2.6, 0.14, C(0x3a3f47));
          rb.box(pt.x, gy + 2.9, pt.z, 1.5, 1.5, 0.12, C(0xffc400), track.H[pt.i]);
          rb.box(pt.x, gy + 2.9, pt.z, 0.5, 0.5, 0.14, C(0x1b1d22), track.H[pt.i]);
        }
        if (!o.stream) {
          const rub = new THREE.Mesh(rb.geometry(), G.CarModel.material());
          rub.castShadow = true;
          group.add(rub);
        }
        const deb = o.look === 'debris'; // (v5.6.1: concrete off a building)
        const rock = new THREE.Mesh(geo(deb ? 'slab' : 'rock'), G.CarModel.material());
        rock.userData.sharedGeo = true;
        rock.scale.setScalar(o.r / 1.3);
        rock.castShadow = true;
        rock.visible = false;
        group.add(rock);
        const sh = new THREE.Mesh(new THREE.CircleGeometry(o.r * 1.4, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));
        sh.rotation.x = -Math.PI / 2;
        sh.visible = false;
        group.add(sh);
        let lastN = -1, gy = 0, landed = false;
        group.userData.animFns.push(() => {
          const t = env().t, p = track.dynPos(o, t, tmp);
          if (!p) {
            rock.visible = sh.visible = false;
            return;
          }
          const c = t + o.off, n = Math.floor(c / o.every), ph = c - n * o.every;
          if (n !== lastN) {
            lastN = n;
            landed = false;
            track.query(p.x, p.z, o.i, q);
            gy = track.elevAlong(q.along) + track.bankH(q.i, U.clamp(q.lat, -q.hw, q.hw));
            rock.rotation.set(n * 1.3, n * 2.1, 0);
            const cam = group.userData.cam;
            if (deb && cam && G.Audio && env().t > 0) G.Audio.debrisCrack(U.clamp(1.1 - Math.hypot(cam.fx - p.x, cam.fz - p.z) / 90, 0, 1));
          }
          const end = Math.min(o.every, 1.5 + o.stay);
          const sink = U.clamp((ph - (end - 0.5)) / 0.5, 0, 1);
          rock.visible = true;
          rock.position.set(p.x, gy + 32 * p.fall * p.fall + o.r * 0.3 - sink * o.r * 1.6, p.z);
          if (p.fall > 0) rock.rotation.x += 0.12;
          sh.visible = true;
          sh.position.set(p.x, gy + 0.09, p.z);
          sh.scale.setScalar(1.2 - 0.6 * p.fall);
          sh.material.opacity = 0.55 * (1 - p.fall) * (1 - sink);
          if (!landed && p.fall === 0) {
            landed = true;
            const cam = group.userData.cam;
            if (cam && G.Audio && env().t > 0) G.Audio.rockImpact(U.clamp(1.1 - Math.hypot(cam.fx - p.x, cam.fz - p.z) / 90, 0, 1));
            const fx = group.userData.fx;
            if (fx) for (let k = 0; k < 18; k++) fx.emit(k < 11 ? 'dust' : 'debris', p.x, gy + 0.6, p.z, (Math.random() - 0.5) * 12, 1 + Math.random() * 4.5, (Math.random() - 0.5) * 12, 1.5, deb ? [0.64, 0.64, 0.62] : [0.55, 0.5, 0.45]);
          }
        });
      }
    }
    // crosswind: a line of socks down the zone, all streaming the way it
    // blows. (v5.1: two socks at the ends of a 200 m zone were easy to miss —
    // the push arrived with nothing on screen to explain it.)
    if (track.winds.length) {
      const socks = [];
      for (const W of track.winds) {
        const n = Math.max(2, Math.round((W.hl * 2) / 30));
        for (let k = 0; k <= n; k++) {
          const d = W.at + (k / n - 0.5) * W.hl * 1.9, pq = track.pointAt(d, 0);
          const r = Math.atan2(-track.NX[pq.i] * W.dir, -track.NZ[pq.i] * W.dir);
          // upwind side gets them all; downwind side every other one, so the
          // road is framed without a forest of poles
          for (const side of k % 2 ? [-1] : [-1, 1]) {
            const lat = side * W.dir * (track.wallD[pq.i] + 2.5), pt = track.pointAt(d, lat);
            socks.push({ x: pt.x, z: pt.z, r });
          }
        }
      }
      instanced('sock', socks, group, false);
    }
    // pit box: white box lines + a yellow PIT stripe on the concrete apron
    if (track.pit) {
      const pt = track.pit, pos = [], col = [];
      const white = C(0xf2f2f2), yel = C(0xffc400), grey = C(0x6f757d);
      // v5.1: every painted layer gets its own height, and they follow the
      // road surface (heightAt) the way the road mesh does. They all used to
      // sit on one flat plane 3 cm up, so the white lines fought the box
      // paint, the box paint fought the run-off strip under it, and the whole
      // pit lane flickered as the camera moved.
      const Qp = (d, l, dy) => {
        const a = track.pointAt(d, l);
        return [a.x, track.heightAt(a.i, l) + 0.06 + (dy || 0), a.z];
      };
      const strip = (d0, d1, l0, l1, c, dy) => {
        for (let d = d0; d < d1 - 0.01; d += 2) {
          const e = Math.min(d1, d + 2);
          pushQuad(pos, col, Qp(d, l1, dy), Qp(d, l0, dy), Qp(e, l0, dy), Qp(e, l1, dy), c);
        }
      };
      const LINE = 0.014, PIT = 0.028; // paint on top of the box, stripe on top of the paint
      const l = pt.lat, hw = pt.hw, d0 = pt.at - pt.hl, d1 = pt.at + pt.hl;
      strip(d0, d1, l - hw, l + hw, grey, 0);
      strip(d0, d1, l - hw, l - hw + 0.3, white, LINE);
      strip(d0, d1, l + hw - 0.3, l + hw, white, LINE);
      strip(d0, d0 + 0.4, l - hw, l + hw, white, LINE);
      strip(d1 - 0.4, d1, l - hw, l + hw, white, LINE);
      for (let d = d0 + 4; d < d1 - 4; d += 8) strip(d, d + 3, l - 0.25, l + 0.25, yel, PIT);
      // the entry and exit lanes across the concrete apron, dashed
      // (v5.1: 30 m, not 40 — the last dashes used to run off the apron and
      //  stripe the grass)
      const side = pt.side, LANE = 30;
      for (let k = 0; k < 12; k++) {
        const f = k / 12, g = (k + 0.5) / 12;
        const la = side * (track.W[pt.ic] + 0.5) + (l - side * (track.W[pt.ic] + 0.5)) * f;
        const lb = side * (track.W[pt.ic] + 0.5) + (l - side * (track.W[pt.ic] + 0.5)) * g;
        strip(d0 - LANE + LANE * f, d0 - LANE + LANE * g, Math.min(la, lb) - 0.12, Math.max(la, lb) + 0.12, white, LINE);
      }
      const m = meshFrom(pos, col, new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.name = 'pitbox';
      group.add(m);
      // pit garages beyond the wall: a row of open bays facing the box
      const gb = new G.CarModel.GB();
      const r = Math.atan2(-track.NX[pt.ic] * side, -track.NZ[pt.ic] * side); // facing the road
      const back = side * (track.wallD[pt.ic] + 6);
      const teal = C(track.theme.wall[0]), wallC = C(0xe7e9ee), dark = C(0x24272e);
      for (let k = 0; k < 6; k++) {
        const d = d0 + (k + 0.5) * ((d1 - d0) / 6);
        const a = track.pointAt(d, back);
        const gy = track.Y[a.i];
        const bw = (d1 - d0) / 6 - 0.4;
        gb.box(a.x, gy + 2.2, a.z, bw, 4.4, 9, wallC, r);
        // (v5.1: the band overlaps the bay instead of sitting exactly on top
        //  of it, and the door stands proud of the wall — touching faces were
        //  z-fighting all down the pit lane)
        gb.box(a.x, gy + 4.5, a.z, bw + 0.4, 0.4, 9.6, teal, r);
        const f = track.pointAt(d, back - side * 4.58);
        gb.box(f.x, gy + 1.7, f.z, bw - 1.2, 3.2, 0.1, dark, r); // open door
      }
      const pm = new THREE.Mesh(gb.geometry(), G.CarModel.material());
      pm.castShadow = true;
      group.add(pm);
    }
  }

  // A windmill with a spinning rotor (the rotor is its own small mesh).
  function windmill(group, x, z) {
    const gb = new G.CarModel.GB();
    gb.box(0, 7, 0, 0.5, 14, 0.5, C(0x9aa5b4));
    for (const [a, c] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) gb.beam([a * 1.6, 0, c * 1.6], [0, 13, 0], 0.18, 0.18, C(0x7d8a99));
    gb.box(0, 14.2, 0, 1.2, 1.2, 2.2, C(0x7d8a99));
    gb.box(0, 14.4, -2.2, 0.1, 1.4, 1.8, C(0xe23d6b)); // tail vane
    const base = new THREE.Mesh(gb.geometry(), G.CarModel.material());
    const gy = _gH ? _gH(x, z) : 0;
    base.position.set(x, gy, z);
    base.castShadow = true;
    group.add(base);
    const rb = new G.CarModel.GB();
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      rb.beam([0, 0, 0], [Math.cos(a) * 3.2, Math.sin(a) * 3.2, 0], 0.5, 0.06, C(0xe9e2d0));
    }
    const rotor = new THREE.Mesh(rb.geometry(), G.CarModel.material());
    rotor.position.set(x, gy + 14.4, z + 1.2);
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
    // grandstand on the left side (v5.5.8: not where nobody came to watch)
    const side = 1, stand = th.stand !== 0;
    for (let r = 0; r < 5 && stand; r++) {
      const x = side * (hw + 4 + r * 1.6);
      gb.box(x, 0.5 + r * 0.8, 0, 1.6, 1 + r * 1.6, 26, C(r % 2 ? 0xd8dde4 : 0xc9ced6));
    }
    if (stand) {
      gb.box(side * (hw + 7.2), 9.8, 0, 9, 0.4, 28, C(th.wall[0]));
      gb.box(side * (hw + 11.2), 5, 13.5, 0.4, 10, 0.4, C(0x2a2d33));
      gb.box(side * (hw + 11.2), 5, -13.5, 0.4, 10, 0.4, C(0x2a2d33));
      gb.box(side * (hw + 3.2), 1.6, 0, 0.1, 0.6, 26, C(th.wall[1])); // front rail
    }
    const m = new THREE.Mesh(gb.geometry(), G.CarModel.material());
    m.position.set(p.x, track.Y[p.i], p.z);
    m.rotation.y = p.h;
    m.castShadow = true;
    group.add(m);

    // crowd: little people in team colours; the shader bobs them (and makes
    // them jump when someone finishes — world.cheer() via userData.cheer)
    const cg = new G.CarModel.GB();
    const cols = [0xff3b30, 0x2f6bff, 0xffc400, 0x22c55e, 0xff2d92, 0x19c3e6, 0xff8a00, 0xa855f7, 0xf5f5f5, 0x1b1d22];
    const skin = [0xe8b894, 0xc68c64, 0x8d5a3b, 0xf1cfae];
    const rng = U.rng(U.hashStr(track.id + 'crowd'));
    for (let r = 0; r < 5 && stand; r++) {
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

  // ======================================================================
  // v5.6 scenery for the Megastore, Harrow City and Harvest Run.
  // Prop geometries first (extraGeo, called from propGeo), then one builder
  // per theme (SCENES), each a generator that yields between chunks so a
  // track built in the background never holds a frame for long.
  // ======================================================================

  // A tiny 5x7 pixel font: neon lettering, price tags, road signs.
  const FONT = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'], D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'], H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'], K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'], M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'], O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'], R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'], T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'], V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'], Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], 1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'], 3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], 5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'], 7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'], 9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    $: ['00100', '01111', '10100', '01110', '00101', '11110', '00100'], '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  };
  // Lettering into a GB. o = the text's centre; u = the direction it reads
  // (unit, horizontal), v = up (unit); px = one pixel; out = which way the
  // face points (for winding). vertical: letters stacked top to bottom.
  function pixText(gb, text, o, u, v, px, col, out, vertical) {
    const s = String(text).toUpperCase();
    const cw = 6, n = s.length;
    const W = vertical ? 5 : n * cw - 1, Hh = vertical ? n * 8 - 1 : 7;
    const at = (cx, cy) => [o[0] + u[0] * cx * px + v[0] * cy * px + out[0] * 0.02, o[1] + u[1] * cx * px + v[1] * cy * px + out[1] * 0.02, o[2] + u[2] * cx * px + v[2] * cy * px + out[2] * 0.02];
    for (let k = 0; k < n; k++) {
      const g = FONT[s[k]];
      if (!g) continue;
      const ox = vertical ? 0 : k * cw, oy = vertical ? k * 8 : 0;
      for (let r = 0; r < 7; r++) {
        const row = g[r];
        let c = 0;
        while (c < 5) {
          if (row[c] !== '1') {
            c++;
            continue;
          }
          let e = c;
          while (e < 5 && row[e] === '1') e++;
          // one run of lit pixels: x from ox+c to ox+e, row oy+r (from the top)
          const x0 = ox + c - W / 2, x1 = ox + e - W / 2 - 0.12, y1 = Hh / 2 - (oy + r), y0 = y1 - 0.88;
          const A = at(x0, y0), B = at(x1, y0), Cc = at(x1, y1), D = at(x0, y1);
          gb.quadN(A, B, Cc, D, col, out);
          c = e;
        }
      }
    }
  }
  const hipRoof = (gb, x, y, z, w, h, d, col) => {
    const hw = w / 2, hd = d / 2, r = Math.min(hw, hd) * 0.9;
    const A = [x - hw, y, z - hd], B = [x + hw, y, z - hd], Cc = [x + hw, y, z + hd], D = [x - hw, y, z + hd];
    const T0 = [x - hw + r, y + h, z], T1 = [x + hw - r, y + h, z];
    const c2 = col.clone().multiplyScalar(0.86);
    gb.quad(A, B, T1, T0, c2, x, y, z);
    gb.quad(D, Cc, T1, T0, col, x, y, z);
    gb.tri(A, D, T0, col.clone().multiplyScalar(0.93), x, y, z);
    gb.tri(B, Cc, T1, col.clone().multiplyScalar(0.93), x, y, z);
  };
  const flat = (gb, x, y, z, w, d, col) => gb.quadN([x - w / 2, y, z - d / 2], [x + w / 2, y, z - d / 2], [x + w / 2, y, z + d / 2], [x - w / 2, y, z + d / 2], col, [0, 1, 0]);

  // --- furniture and fittings (local: +z = the front)
  function sofa(gb, x, z, rot, col) {
    const c = C(col), c2 = C(col).multiplyScalar(1.12);
    boxAt(gb, x, 0, z, rot, 0, 0.25, 0, 3.4, 0.5, 1.1, c);
    boxAt(gb, x, 0, z, rot, 0, 0.75, -0.45, 3.4, 0.8, 0.22, c);
    for (const s of [-1, 1]) boxAt(gb, x, 0, z, rot, s * 1.6, 0.45, 0, 0.24, 0.62, 1.1, c);
    for (const s of [-1, 1]) boxAt(gb, x, 0, z, rot, s * 0.75, 0.56, 0.05, 1.45, 0.14, 0.95, c2);
  }
  function chair(gb, x, z, rot, col, seat) {
    const c = C(col);
    boxAt(gb, x, 0, z, rot, 0, 0.46, 0, 0.46, 0.06, 0.46, seat ? C(seat) : c);
    boxAt(gb, x, 0, z, rot, 0, 0.78, -0.21, 0.46, 0.6, 0.05, c);
    boxAt(gb, x, 0, z, rot, 0, 0.22, 0, 0.36, 0.44, 0.3, c.clone().multiplyScalar(0.8));
  }
  function table(gb, x, z, rot, w, d, h, col) {
    const c = C(col);
    boxAt(gb, x, 0, z, rot, 0, h, 0, w, 0.07, d, c);
    for (const a of [-1, 1]) boxAt(gb, x, 0, z, rot, a * (w / 2 - 0.12), h / 2, 0, 0.07, h, d - 0.2, c.clone().multiplyScalar(0.8));
  }
  function lampStand(gb, x, z) {
    gb.box(x, 0.85, z, 0.06, 1.7, 0.06, C(0x2a2d33));
    cyl(gb, x, 1.75, z, 0.28, 0.34, 8, C(0xf3e7c6));
  }
  function planks(gb, w, d, c1, c2) {
    flat(gb, 0, 0.03, 0, w, d, C(c1));
    for (let x = -w / 2 + 1.5; x < w / 2; x += 1.5) flat(gb, x, 0.036, 0, 0.05, d, C(c2));
  }
  function checker(gb, w, d, sz, c1, c2) {
    flat(gb, 0, 0.03, 0, w, d, C(c1));
    const n = Math.round(w / sz), m = Math.round(d / sz), cc = C(c2);
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) if ((i + j) % 2) flat(gb, -w / 2 + (i + 0.5) * sz, 0.036, -d / 2 + (j + 0.5) * sz, sz, sz, cc);
  }
  // Where a display's lamps are (local x, y, z): their glow is drawn at night
  const LAMPS = {
    dLiving: [[4.2, 1.75, -3.8], [-4.6, 1.75, 3.6]],
    dBed: [[-1.7, 0.95, -3.1], [1.7, 0.95, -3.1]],
    dDining: [[0, 2.4, 0]],
    dOffice: [[-3, 1.1, -2.4], [3, 1.1, -2.4]],
    dKitchen: [[1.5, 2.5, 1.2]],
    dPatio: [[4.4, 1.5, 4.4]],
  };

  function extraGeo(kind, gb) {
    // ---------------- Megastore
    if (kind === 'dLiving') {
      planks(gb, 12, 12, 0x6e5139, 0x5d4430);
      flat(gb, 0, 0.05, 0.4, 5.2, 3.6, C(0x9a9ea5));
      sofa(gb, 0, -2.2, 0, 0x8a8f97);
      for (const s of [-1, 1]) {
        boxAt(gb, s * 2.8, 0, 0.4, s * -1.2, 0, 0.3, 0, 0.9, 0.44, 0.9, C(0xb88a5c));
        boxAt(gb, s * 2.8, 0, 0.4, s * -1.2, 0, 0.72, -0.38, 0.9, 0.5, 0.16, C(0xb88a5c));
      }
      table(gb, 0, 0.4, 0, 1.6, 0.8, 0.42, 0xc9a27a);
      gb.box(0, 0.3, 3.1, 2.8, 0.6, 0.5, C(0x3b2f28));
      gb.box(0, 1.1, 3.12, 2.0, 1.1, 0.08, C(0x111418));
      gb.box(0, 0.62, 3.12, 0.3, 0.08, 0.3, C(0x222428));
      lampStand(gb, 4.2, -3.8);
      lampStand(gb, -4.6, 3.6);
      gb.box(-4.9, 1.0, -3.4, 0.4, 2.0, 2.6, C(0xe9e7e2));
      for (let k = 0; k < 4; k++) gb.box(-4.8, 0.45 + k * 0.48, -3.4 + (k % 2 ? 0.5 : -0.5), 0.32, 0.3, 0.7, C([0x3f6aa8, 0xd9534f, 0xf0c05a, 0x5b8c5a][k]));
      gb.box(4.6, 0.35, 2.8, 0.6, 0.7, 0.6, C(0xa55a3a)); // plant pot
      ico(gb, 4.6, 1.05, 2.8, 0.55, C(0x4f8f45));
    } else if (kind === 'dDining') {
      flat(gb, 0, 0.03, 0, 11, 10, C(0x7e2b2b));
      table(gb, 0, 0, 0, 3.2, 1.4, 0.76, 0xd9b48c);
      for (const zz of [-1.05, 1.05]) for (const xx of [-1, 0, 1]) chair(gb, xx * 1.05, zz, zz > 0 ? Math.PI : 0, 0x5a3a28);
      gb.box(0, 3.2, 0, 0.03, 1.6, 0.03, C(0x2a2d33));
      cone(gb, 0, 2.2, 0, 0.45, 0.35, 8, C(0x2a2d33));
      gb.box(4.2, 0.9, -3.6, 1.8, 1.8, 0.5, C(0x6b4a33)); // sideboard
      gb.box(4.2, 1.82, -3.6, 1.9, 0.06, 0.55, C(0x5a3d2a));
    } else if (kind === 'dDining2') {
      checker(gb, 10, 10, 1, 0xf2f2f2, 0x1b1d22);
      table(gb, 0, 0, 0, 1.2, 1.2, 0.74, 0xf3efe6);
      for (let k = 0; k < 4; k++) chair(gb, Math.sin((k * Math.PI) / 2) * 0.95, Math.cos((k * Math.PI) / 2) * 0.95, (k * Math.PI) / 2 + Math.PI, 0xd6342c, 0xd6342c);
      table(gb, 3.2, -2.6, 0, 1.2, 1.2, 0.74, 0xf3efe6);
      for (let k = 0; k < 2; k++) chair(gb, 3.2 + (k ? 0.95 : -0.95), -2.6, k ? -Math.PI / 2 : Math.PI / 2, 0x2f6bff, 0x2f6bff);
    } else if (kind === 'dBed') {
      flat(gb, 0, 0.03, 0, 11, 11, C(0x5d6b7c));
      gb.box(0, 0.3, 0, 2.0, 0.4, 2.3, C(0x6b4a33));
      gb.box(0, 0.85, -1.12, 2.1, 1.1, 0.12, C(0x6b4a33));
      gb.box(0, 0.56, 0.05, 1.9, 0.2, 2.1, C(0xf1f1ee));
      gb.box(0, 0.67, 0.45, 1.96, 0.07, 1.3, C(0x3f6aa8));
      for (const s of [-1, 1]) gb.box(s * 0.45, 0.73, -0.78, 0.7, 0.14, 0.4, C(0xfafaf7));
      for (const s of [-1, 1]) {
        gb.box(s * 1.7, 0.3, -0.9, 0.5, 0.6, 0.45, C(0xe9e7e1));
        cyl(gb, s * 1.7, 0.8, -0.9, 0.15, 0.3, 8, C(0xf3e7c6));
      }
      gb.box(-4, 1.1, -4.6, 2.4, 2.2, 0.7, C(0xe9e7e1));
      gb.box(-4, 1.1, -4.24, 0.02, 2.1, 0.02, C(0x9aa0a6));
      flat(gb, 0, 0.05, 1.8, 3, 1.6, C(0xc9b89c));
    } else if (kind === 'dOffice') {
      flat(gb, 0, 0.03, 0, 11, 10, C(0x6f7378));
      for (const xx of [-3, 0, 3]) {
        table(gb, xx, -2.3, 0, 2.2, 1.0, 0.74, 0xe6d2b5);
        gb.box(xx, 1.02, -2.6, 0.9, 0.5, 0.05, C(0x111418));
        gb.box(xx, 0.5, -1.3, 0.55, 0.08, 0.55, C(0x1f2126));
        gb.box(xx, 0.85, -1.05, 0.55, 0.6, 0.06, C(0x1f2126));
        gb.box(xx, 0.25, -1.3, 0.06, 0.5, 0.06, C(0x3a3d42));
      }
      for (const xx of [-2.5, 2.5]) gb.box(xx, 1.0, 3.6, 3, 2, 0.45, C(0xf2efe8));
    } else if (kind === 'dKitchen') {
      checker(gb, 10, 10, 0.8, 0xeeeeea, 0x9aa0a6);
      gb.box(-2, 0.45, -4.3, 6, 0.9, 0.65, C(0xf4f3ef));
      gb.box(-2, 0.93, -4.3, 6.1, 0.06, 0.7, C(0x9c7b5a));
      gb.box(-2, 2.1, -4.45, 6, 0.8, 0.35, C(0xf4f3ef));
      gb.box(1.9, 1.0, -4.25, 0.8, 2.0, 0.75, C(0xdcdfe3)); // fridge
      gb.box(-2.5, 0.96, -4.2, 0.8, 0.04, 0.45, C(0xb9c0c8)); // sink
      gb.box(1, 0.45, 0.4, 3, 0.9, 1.1, C(0xf4f3ef));
      gb.box(1, 0.93, 0.4, 3.1, 0.06, 1.2, C(0x9c7b5a));
      for (const xx of [0, 1, 2]) {
        cyl(gb, xx, 0.66, 1.35, 0.2, 0.06, 8, C(0x2a2d33));
        gb.box(xx, 0.33, 1.35, 0.05, 0.66, 0.05, C(0x2a2d33));
      }
    } else if (kind === 'dPatio') {
      flat(gb, 0, 0.03, 0, 11, 11, C(0x3f8a3a));
      checker(gb, 7, 7, 0.7, 0xa4553a, 0x94492f);
      table(gb, 0, 0, 0, 2.4, 1.2, 0.74, 0xd8c8a0);
      for (const zz of [-0.95, 0.95]) for (const xx of [-0.6, 0.6]) chair(gb, xx, zz, zz > 0 ? Math.PI : 0, 0xd8c8a0);
      const rail = C(0x1b1d22);
      for (let k = -3; k <= 3; k++) {
        gb.box(k * 1.1, 0.5, -3.6, 0.05, 1.0, 0.05, rail);
        gb.box(3.6, 0.5, k * 1.1, 0.05, 1.0, 0.05, rail);
      }
      gb.box(0, 1.0, -3.6, 7.2, 0.06, 0.06, rail);
      gb.box(3.6, 1.0, 0, 0.06, 0.06, 7.2, rail);
      gb.box(4.4, 0.75, 4.4, 0.06, 1.5, 0.06, C(0x2a2d33));
      cone(gb, 4.4, 1.3, 4.4, 1.4, 0.5, 8, C(0xe8e2d0)); // parasol
    } else if (kind === 'rack') {
      const up = C(0x2d5fb8), bm = C(0xf07c1a);
      for (const x of [-6, 0, 6]) for (const z of [-1.1, 1.1]) gb.box(x, 3.6, z, 0.12, 7.2, 0.12, up);
      for (const y of [0.25, 2.5, 4.75]) for (const z of [-1.1, 1.1]) gb.box(0, y, z, 12, 0.14, 0.1, bm);
      const bx = [0xb08a5a, 0xa27c4d, 0xc49a68];
      for (let b = 0; b < 2; b++) for (let l = 0; l < 3; l++) {
        if ((b * 3 + l) % 4 === 2) continue;
        gb.box(-3 + b * 6, 0.95 + l * 2.25, 0, 5.4, 1.3, 1.9, C(bx[(b + l) % 3]));
      }
    } else if (kind === 'pillar') {
      gb.box(0, 60, 0, 6, 120, 6, C(0xa3a7ab));
      gb.box(0, 0.6, 0, 6.6, 1.2, 6.6, C(0x8e9296));
    } else if (kind.startsWith('psign')) {
      const price = { psign: '$99.99', psign2: '$49.99', psign3: '$19.99' }[kind];
      const Y = C(0xffd21f), B = C(0x1f4fbd), Wt = C(0xffffff);
      gb.box(0, 0, 0, 5, 3.2, 0.12, Y);
      for (const s of [-1, 1]) {
        gb.box(0, s * 1.55, 0, 5, 0.12, 0.14, B);
        gb.box(s * 2.44, 0, 0, 0.12, 3.2, 0.14, B);
      }
      for (const f of [1, -1]) {
        gb.box(0, 1.05, f * 0.07, 4.4, 0.55, 0.02, B);
        gb.box(0.9, -0.45, f * 0.07, 2.4, 1.2, 0.02, Wt);
        gb.box(-1.5, -0.3, f * 0.07, 1.3, 1.5, 0.02, C(0x6b4a33)); // the product
        pixText(gb, price, [0.9, -0.45, f * 0.085], [f, 0, 0], [0, 1, 0], 0.075, B, [0, 0, f]);
      }
      for (const s of [-1, 1]) gb.box(s * 2, 16.6, 0, 0.03, 30, 0.03, C(0x2a2d33)); // wires up into the fog
    } else if (kind === 'clight') {
      gb.box(0, 0.12, 0, 7.2, 0.24, 1.3, C(0x8e949b));
      for (const s of [-1, 1]) gb.box(s * 3, 8, 0, 0.03, 16, 0.03, C(0x2a2d33));
    } else if (kind === 'cart') {
      const g = C(0x9aa0a6);
      gb.box(0, 0.75, 0, 0.6, 0.5, 0.9, g);
      gb.box(0, 1.15, -0.5, 0.6, 0.06, 0.06, C(0xd33a2c));
      for (const [a, b] of [[-0.25, -0.35], [0.25, -0.35], [-0.25, 0.35], [0.25, 0.35]]) gb.box(a, 0.25, b, 0.05, 0.5, 0.05, g);
    } else if (kind === 'wetsign') {
      const y = C(0xffd21f);
      for (const s of [-1, 1]) gb.beam([0, 0.02, s * 0.3], [0, 0.95, 0], 0.5, 0.03, y);
      gb.box(0, 0.55, 0.16, 0.25, 0.25, 0.02, C(0x1b1d22));
    }
    // ---------------- Harrow City
    else if (kind === 'sedanW' || kind === 'sedanK' || kind === 'sedanR' || kind === 'burnt') {
      const body = C({ sedanW: 0xd9dcdf, sedanK: 0x1d1f23, sedanR: 0x5b1a1e, burnt: 0x2a2624 }[kind]);
      gb.box(0, 0.55, 0, 1.8, 0.6, 4.5, body);
      gb.box(0, 1.08, -0.25, 1.6, 0.48, 2.2, body.clone().multiplyScalar(0.92));
      gb.box(0, 1.08, 0.86, 1.5, 0.44, 0.05, C(kind === 'burnt' ? 0x0c0c0c : 0x1d2a38));
      gb.box(0, 1.08, -1.36, 1.5, 0.44, 0.05, C(kind === 'burnt' ? 0x0c0c0c : 0x1d2a38));
      if (kind === 'burnt') for (const [x, z] of [[0.6, 1.4], [-0.5, -1.6]]) gb.box(x, 0.86, z, 0.6, 0.04, 0.8, C(0x8a4a22));
      else for (const s of [-1, 1]) gb.box(s * 0.6, 0.62, 2.26, 0.35, 0.15, 0.03, C(0xe8e4d0));
      for (const [x, z] of [[0.85, 1.4], [-0.85, 1.4], [0.85, -1.4], [-0.85, -1.4]]) cylX(gb, x, 0.34, z, 0.34, 0.22, 8, C(0x141518));
    } else if (kind === 'copcar') {
      const Wt = C(0xf0f0ee), K = C(0x16171a);
      gb.box(0, 0.5, 0, 1.84, 0.5, 4.7, K);
      gb.box(0, 0.8, 0, 1.86, 0.16, 4.72, Wt);
      gb.box(0, 1.1, -0.25, 1.62, 0.5, 2.3, Wt);
      gb.box(0, 1.1, 0.92, 1.5, 0.44, 0.05, C(0x1d2a38));
      gb.box(0, 1.42, -0.2, 1.3, 0.14, 0.36, K); // light bar (lit separately)
      for (const [x, z] of [[0.86, 1.45], [-0.86, 1.45], [0.86, -1.45], [-0.86, -1.45]]) cylX(gb, x, 0.34, z, 0.34, 0.22, 8, C(0x141518));
    } else if (kind === 'firetruck') {
      const R = C(0xb3171a);
      gb.box(0, 1.5, 1.2, 2.5, 2.3, 7.5, R);
      gb.box(0, 1.6, 4.4, 2.5, 2.5, 1.6, R);
      gb.box(0, 2.15, 5.22, 2.2, 0.9, 0.05, C(0x1d2a38));
      gb.box(0, 0.9, 1.2, 2.52, 0.18, 7.52, C(0xf0f0ee));
      gb.box(0, 0.55, 5.3, 2.4, 0.3, 0.2, C(0xc9ced6));
      gb.beam([0, 2.9, -2.4], [0, 4.2, 3.8], 1.2, 0.3, C(0xc9ced6)); // ladder, raised
      for (let k = 0; k < 8; k++) gb.box(0, 3.0 + k * 0.17, -1.6 + k * 0.77, 1.2, 0.05, 0.05, C(0x8a9097));
      for (const [x, z] of [[1.1, 3.6], [-1.1, 3.6], [1.1, -1], [-1.1, -1], [1.1, -2.3], [-1.1, -2.3]]) cylX(gb, x, 0.48, z, 0.48, 0.34, 8, C(0x141518));
    } else if (kind === 'ambulance') {
      const Wt = C(0xf0f0ee);
      gb.box(0, 1.55, -0.6, 2.4, 2.4, 4.4, Wt);
      gb.box(0, 1.1, 2.5, 2.2, 1.5, 1.9, Wt);
      gb.box(0, 1.55, 3.46, 1.9, 0.6, 0.05, C(0x1d2a38));
      gb.box(0, 1.2, -0.6, 2.42, 0.3, 4.42, C(0xc41e2a));
      gb.box(0, 2.82, 1.4, 1.6, 0.14, 0.3, C(0x16171a));
      for (const [x, z] of [[1.05, 2.4], [-1.05, 2.4], [1.05, -2], [-1.05, -2]]) cylX(gb, x, 0.42, z, 0.42, 0.3, 8, C(0x141518));
    } else if (kind === 'bus') {
      const top = C(0xe8e0c8), low = C(0x2f6b4f);
      gb.box(0, 2.0, 0, 2.6, 1.6, 11, top);
      gb.box(0, 0.85, 0, 2.62, 0.9, 11.02, low);
      for (const s of [-1, 1]) gb.box(s * 1.31, 2.1, 0, 0.03, 0.9, 10, C(0x1d2a38));
      gb.box(0, 2.1, 5.51, 2.2, 1.2, 0.03, C(0x1d2a38));
      for (const [x, z] of [[1.15, 3.8], [-1.15, 3.8], [1.15, -3.4], [-1.15, -3.4]]) cylX(gb, x, 0.5, z, 0.5, 0.32, 8, C(0x141518));
    } else if (kind === 'chain') {
      const g = C(0x7c8288);
      for (const s of [-1, 1]) gb.box(s * 1.8, 1.2, 0, 0.07, 2.4, 0.07, g);
      gb.box(0, 2.38, 0, 3.6, 0.05, 0.05, g);
      gb.box(0, 0.05, 0, 3.6, 0.05, 0.05, g);
      const m = C(0x5d6369);
      for (let k = -4; k <= 4; k++) gb.box(k * 0.38, 1.2, 0, 0.015, 2.3, 0.015, m);
      for (let k = 1; k < 7; k++) gb.box(0, k * 0.34, 0, 3.5, 0.015, 0.015, m);
      for (const s of [-1, 1]) gb.box(s * 1.8, 0.04, 0, 0.3, 0.08, 0.7, C(0x3a3d42)); // feet
    } else if (kind === 'sawhorse') {
      const Wt = C(0xf0efe8), O = C(0xff6a1a);
      for (const s of [-1, 1]) for (const f of [-1, 1]) gb.beam([s * 1.1, 0, f * 0.35], [s * 1.1, 1.0, 0], 0.08, 0.08, C(0x9aa0a6));
      for (const y of [0.55, 0.9]) {
        for (let k = 0; k < 6; k++) gb.box(-1.25 + k * 0.5 + 0.25, y, 0, 0.5, 0.2, 0.05, k % 2 ? Wt : O);
      }
    } else if (kind === 'jersey') {
      gb.box(0, 0.25, 0, 3.8, 0.5, 0.7, C(0x9a9c9e));
      gb.box(0, 0.62, 0, 3.8, 0.3, 0.32, C(0x9a9c9e));
      gb.box(0, 0.6, 0.17, 3.8, 0.12, 0.02, C(0xff6a1a));
    } else if (kind === 'sandbag') {
      const c = C(0xa8946a);
      for (let r = 0; r < 3; r++) for (let k = 0; k < 4 - r; k++) gb.box(-1.1 + k * 0.75 + r * 0.37, 0.18 + r * 0.3, 0, 0.7, 0.3, 0.45, c.clone().multiplyScalar(0.9 + ((k + r) % 3) * 0.05));
    } else if (kind === 'tlight') {
      const K = C(0x1f2126);
      gb.box(0, 3.5, 0, 0.2, 7, 0.2, K);
      gb.box(0, 6.8, 2.8, 0.14, 0.14, 5.6, K);
      gb.box(0, 6.1, 5.2, 0.45, 1.3, 0.45, K);
    } else if (kind === 'watertank') {
      for (const [x, z] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) gb.box(x, 1.2, z, 0.14, 2.4, 0.14, C(0x2a2320));
      cyl(gb, 0, 3.6, 0, 1.9, 2.6, 10, C(0x5a4636));
      cone(gb, 0, 4.9, 0, 2.05, 1.1, 10, C(0x3b312a));
    }
    // ---------------- Harvest Run: street trees, yard trees, crops, odds and ends
    else if (kind === 'olive') {
      const bark = C(0x6e655a);
      gb.beam([0, 0, 0], [0.3, 1.4, 0.1], 0.45, 0.45, bark);
      gb.beam([0.3, 1.4, 0.1], [-0.6, 2.4, -0.3], 0.3, 0.3, bark);
      gb.beam([0.3, 1.4, 0.1], [1.0, 2.3, 0.4], 0.3, 0.3, bark);
      for (const [x, y, z, r, c] of [[-0.7, 2.9, -0.3, 1.4, 0x8a9a6c], [1.0, 2.8, 0.4, 1.35, 0x7d8f62], [0.2, 3.4, 0.1, 1.5, 0x95a576], [0.1, 2.7, 1.0, 1.1, 0x86976a]]) ico(gb, x, y, z, r, C(c));
    } else if (kind === 'crepeP' || kind === 'crepeV') {
      // crepe myrtle: a knot of pale trunks and a cloud of summer flowers
      const bark = C(0xb9a48c), fl = kind === 'crepeP' ? [0xd9669a, 0xe68ab4] : [0xa071c4, 0xb68ad2];
      for (const [x, z] of [[0.5, 0.2], [-0.4, 0.3], [0, -0.5]]) gb.beam([x * 0.3, 0, z * 0.3], [x * 1.6, 2.6, z * 1.6], 0.16, 0.16, bark);
      for (const [x, y, z, r, k] of [[0, 3.6, 0, 1.5, 0], [0.9, 3.2, 0.4, 1.1, 1], [-0.8, 3.3, 0.3, 1.1, 0], [0.1, 3.1, -0.9, 1.05, 1], [0, 4.3, 0.2, 0.9, 2]]) ico(gb, x, y, z, r, C(k === 2 ? 0x5f8a3e : fl[k]));
    } else if (kind === 'maple') {
      gb.beam([0, 0, 0], [0, 3, 0], 0.4, 0.4, C(0x5e5046));
      for (const [x, y, z, r] of [[0, 4.6, 0, 2.3], [-1.3, 4.0, 0.4, 1.6], [1.2, 4.1, -0.5, 1.7], [0.2, 5.8, 0.2, 1.5]]) ico(gb, x, y, z, r, C(0x5b8f3a));
    } else if (kind === 'sweetgum' || kind === 'sweetgumR') {
      // tall and pointed; now and then one already turning red
      gb.beam([0, 0, 0], [0, 4, 0], 0.38, 0.38, C(0x5a4d42));
      const cols = kind === 'sweetgum' ? [0x4a7a34, 0x55863a, 0x5f9040] : [0xb8452a, 0xc8702c, 0x8e2c34];
      for (const [y, r, k] of [[3.4, 2.1, 0], [5.0, 2.0, 1], [6.5, 1.6, 2], [7.8, 1.1, 0], [8.8, 0.6, 1]]) ico(gb, 0, y, 0, r, C(cols[k]));
    } else if (kind === 'citrus') {
      gb.beam([0, 0, 0], [0, 1, 0], 0.22, 0.22, C(0x5a4d42));
      ico(gb, 0, 2.1, 0, 1.5, C(0x3d6a2e));
      ico(gb, 0.3, 2.9, 0.2, 1.0, C(0x467634));
      for (let k = 0; k < 6; k++) ico(gb, Math.cos(k * 1.05) * 1.25, 1.7 + (k % 3) * 0.45, Math.sin(k * 1.05) * 1.25, 0.16, C(k % 2 ? 0xf0a030 : 0xf2c440));
    } else if (kind === 'sycamore') {
      // big, pale mottled trunk, a broad loose crown
      const bark = C(0xd3cab6), bark2 = C(0xa89c84);
      gb.beam([0, 0, 0], [0.5, 4.5, 0.2], 0.7, 0.7, bark);
      gb.beam([0.5, 4.5, 0.2], [-2.2, 7.4, -0.6], 0.42, 0.42, bark2);
      gb.beam([0.5, 4.5, 0.2], [2.6, 7.2, 1.0], 0.42, 0.42, bark);
      gb.beam([0.5, 4.5, 0.2], [0.8, 8.2, -1.6], 0.36, 0.36, bark);
      for (const [x, y, z, r, c] of [[-2.4, 8.2, -0.6, 2.4, 0x6f9a45], [2.8, 8.0, 1.0, 2.5, 0x78a24b], [0.8, 9.2, -1.6, 2.3, 0x6a943f], [0.2, 9.6, 0.8, 2.2, 0x7fa851], [-0.8, 7.4, 1.8, 1.8, 0x6f9a45]]) ico(gb, x, y, z, r, C(c));
    } else if (kind === 'cypress') {
      // the tall dark column you see by old farmhouses and along drives
      const c = C(0x2f4d2c);
      cyl(gb, 0, 1.4, 0, 0.75, 2.4, 8, c);
      cone(gb, 0, 2.5, 0, 0.95, 8.5, 8, c.clone().multiplyScalar(1.08));
    } else if (kind === 'eucalyptus') {
      // windbreak gums: tall pale trunks, thin blue-green crowns
      const bark = C(0xd8cfbf), bark2 = C(0xb0a390);
      gb.beam([0, 0, 0], [0.6, 11, 0.2], 0.7, 0.7, bark);
      gb.beam([0.6, 11, 0.2], [-1.6, 16.5, -0.4], 0.4, 0.4, bark2);
      gb.beam([0.6, 11, 0.2], [2.2, 17.5, 0.6], 0.4, 0.4, bark);
      for (const [x, y, z, r, c] of [[-1.8, 16.5, -0.4, 2.3, 0x6f8a6a], [2.3, 17.8, 0.6, 2.6, 0x7a967a], [0.4, 19.4, 0, 2.0, 0x6a8466], [0.8, 14.2, 1.2, 1.8, 0x7d9a78]]) ico(gb, x, y, z, r, C(c));
    } else if (kind === 'oakF') {
      // a far oak on the hills: the same dark crown, a third of the triangles
      gb.beam([0, 0, 0], [0.3, 2.4, 0.1], 0.6, 0.6, C(0x5e5448));
      ico(gb, 0, 4.2, 0, 2.8, C(0x4f6b35));
      ico(gb, 1.6, 3.8, 0.6, 2.0, C(0x46612f));
    } else if (kind === 'hedge') {
      gb.box(0, 0.6, 0, 4, 1.2, 0.9, C(0x3f6b33));
      gb.box(0, 1.22, 0, 3.9, 0.06, 0.8, C(0x4d7d3c));
    } else if (kind === 'succulent') {
      gb.box(0.5, 0.18, 0.3, 0.6, 0.36, 0.5, C(0x9a8f80));
      ico(gb, -0.2, 0.3, 0, 0.45, C(0x7f9e88));
      ico(gb, 0.3, 0.22, -0.4, 0.3, C(0x8fae7a));
      cone(gb, -0.2, 0.4, 0, 0.1, 1.3, 5, C(0xb09a58)); // (a flower spike)
    } else if (kind === 'umbR' || kind === 'umbG' || kind === 'umbC') {
      // a cafe table on the sidewalk: umbrella, two chairs
      const dark = C(0x3b3d42);
      cyl(gb, 0, 0.73, 0, 0.45, 0.06, 10, C(0xd8d4cc));
      gb.box(0, 0.36, 0, 0.08, 0.72, 0.08, dark);
      gb.box(0, 1.3, 0, 0.05, 1.9, 0.05, dark);
      cone(gb, 0, 2.05, 0, 1.35, 0.5, 8, C({ umbR: 0xb8352c, umbG: 0x2f6b4f, umbC: 0xece2c8 }[kind]));
      for (const s of [-1, 1]) {
        gb.box(s * 0.8, 0.23, 0, 0.42, 0.46, 0.42, dark);
        gb.box(s * 1.0, 0.65, 0, 0.06, 0.45, 0.42, dark);
      }
    } else if (kind === 'planter') {
      gb.box(0, 0.3, 0, 1.2, 0.6, 1.2, C(0xa9573a));
      ico(gb, 0, 0.95, 0, 0.6, C(0x4f8a3a));
      for (let k = 0; k < 4; k++) ico(gb, Math.cos(k * 1.57) * 0.4, 1.0, Math.sin(k * 1.57) * 0.4, 0.16, C([0xe84a6a, 0xf2d04a, 0xffffff, 0xb06ad0][k]));
    } else if (kind === 'bench') {
      gb.box(0, 0.45, 0, 1.8, 0.08, 0.5, C(0x8a6a48));
      gb.box(0, 0.8, -0.22, 1.8, 0.4, 0.06, C(0x8a6a48));
      for (const s of [-1, 1]) gb.box(s * 0.8, 0.22, 0, 0.08, 0.45, 0.45, C(0x2b2e33));
    } else if (kind === 'play') {
      // a playground: a tower with a roof, a slide, a set of swings
      const post = C(0x2f6bb0), deck = C(0xd8a040);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) gb.box(x, 1.6, z, 0.14, 3.2, 0.14, post);
      gb.box(0, 1.5, 0, 2.2, 0.12, 2.2, deck);
      hipRoof(gb, 0, 3.2, 0, 2.6, 1, 2.6, C(0xc8352c));
      gb.beam([0, 1.5, 1.1], [0, 0.2, 3.6], 0.8, 0.08, C(0xf2c230));
      for (const x of [3, 6]) {
        gb.beam([x, 0, -0.8], [x, 2.6, 0], 0.12, 0.12, post);
        gb.beam([x, 0, 0.8], [x, 2.6, 0], 0.12, 0.12, post);
      }
      gb.box(4.5, 2.6, 0, 3.2, 0.12, 0.12, post);
      for (const x of [3.9, 5.1]) gb.box(x, 0.55, 0, 0.5, 0.06, 0.25, C(0x2b2e33));
      flat(gb, 1.5, 0.03, 0.5, 10, 7, C(0xc9a878)); // wood chips
    } else if (kind === 'picnic') {
      gb.box(0, 0.75, 0, 0.8, 0.08, 2, C(0x8a6a48));
      for (const s of [-1, 1]) {
        gb.box(s * 0.7, 0.45, 0, 0.3, 0.06, 2, C(0x8a6a48));
        gb.box(s * 0.25, 0.37, 0, 0.08, 0.75, 1.6, C(0x6b5238));
      }
    } else if (kind === 'pump') {
      gb.box(0, 0.12, 0, 1.2, 0.24, 4, C(0xb9b4a8));
      for (const z of [-1, 1]) {
        gb.box(0, 0.95, z, 0.6, 1.5, 0.8, C(0xf2f2ee));
        gb.box(0, 1.5, z, 0.62, 0.3, 0.82, C(0xc8352c));
      }
    } else if (kind === 'slab') {
      // v5.6.1 Harrow City: a lump of concrete off a building, rebar sticking out
      gb.box(0, 0, 0, 2.0, 0.7, 1.5, C(0x8e8c88));
      gb.box(0.3, 0.45, -0.2, 1.1, 0.35, 0.9, C(0x7a7874));
      gb.box(-0.5, -0.1, 0.5, 0.9, 0.5, 0.7, C(0x9a9894));
      for (const [a, b] of [[[-0.8, 0.2, 0.7], [-1.1, 0.9, 1.3]], [[0.5, 0.3, 0.75], [0.8, 1.1, 1.2]], [[0.9, 0.1, -0.6], [1.5, 0.5, -1.0]]]) gb.beam(a, b, 0.06, 0.06, C(0x5a3a2a));
    } else if (kind === 'stopsign') {
      gb.box(0, 1.2, 0, 0.08, 2.4, 0.08, C(0x8a9097));
      const red = C(0xc8262c), P = (k, z) => [Math.cos(((k + 0.5) * Math.PI) / 4) * 0.4, 2.3 + Math.sin(((k + 0.5) * Math.PI) / 4) * 0.4, z];
      for (let k = 0; k < 8; k++) for (const z of [0.05, -0.05]) gb.tri([0, 2.3, z], P(k, z), P(k + 1, z), red, 0, 2.3, 0);
      gb.box(0, 2.3, 0.06, 0.46, 0.12, 0.02, C(0xffffff));
    } else if (kind === 'cornrow') {
      gb.box(0, 1.0, 0, 0.55, 2.0, 24, C(0x6f9a3c));
      gb.box(0, 2.1, 0, 0.3, 0.25, 24, C(0xc9b25a));
    } else if (kind === 'croprow') {
      gb.box(0, 0.18, 0, 0.7, 0.36, 24, C(0x5c9a3a));
      gb.box(0, 0.38, 0, 0.4, 0.06, 24, C(0x74b04a));
    } else if (kind === 'vinerowR') {
      // a young block: shorter vines, the trellis wire showing
      for (let k = -3; k <= 3; k++) gb.box(0, 0.7, k * 4, 0.1, 1.4, 0.1, C(0x7a6450));
      gb.box(0, 1.3, 0, 0.04, 0.04, 24, C(0x8a8f95));
      gb.box(0, 0.8, 0, 0.45, 0.45, 24, C(0x78a445));
    } else if (kind === 'pots') {
      // a nursery row: young trees in black pots
      for (let k = -1.5; k <= 1.5; k++) {
        gb.box(0, 0.3, k * 0.9, 0.6, 0.6, 0.6, C(0x26282b));
        ico(gb, 0, 1.3, k * 0.9, 0.55, C(k > 0 ? 0x5a8a3c : 0x4d7d34));
      }
    } else if (kind === 'greenhouse') {
      // a hoop house, 8 wide and 32 long, milky plastic on low sides
      const film = C(0xe6ebe8), n = 7;
      const P = (k, z) => [Math.cos((Math.PI * k) / n) * 4, 0.6 + Math.sin((Math.PI * k) / n) * 3.2, z];
      for (let k = 0; k < n; k++) {
        gb.quad(P(k, -16), P(k + 1, -16), P(k + 1, 16), P(k, 16), k % 2 ? film : film.clone().multiplyScalar(0.94), 0, 0.6, 0);
        for (const z of [-16, 16]) gb.tri(P(k, z), P(k + 1, z), [0, 0.6, z], film.clone().multiplyScalar(0.88), 0, 0.6, 0);
      }
      for (const s of [-1, 1]) gb.box(s * 4, 0.3, 0, 0.08, 0.6, 32, C(0xa9b0b4));
    } else if (kind === 'tractor') {
      const g = C(0x3a7a3a), dark = C(0x1d1e20);
      gb.box(0, 1.1, 0.6, 1.1, 0.9, 2.4, g);
      gb.box(0, 1.9, -0.6, 1.3, 1.5, 1.2, C(0x2b2e33));
      gb.box(0, 2.7, -0.6, 1.5, 0.1, 1.4, g);
      gb.box(0.35, 2.2, 1.4, 0.1, 1.0, 0.1, dark);
      for (const s of [-1, 1]) {
        cylX(gb, s * 0.95, 0.85, -0.7, 0.85, 0.5, 10, dark);
        cylX(gb, s * 0.75, 0.45, 1.5, 0.45, 0.35, 8, dark);
      }
    } else if (kind === 'fenceW') {
      const c = C(0x8a6a4a);
      gb.box(0, 0.9, 0, 4, 1.8, 0.06, c);
      for (let k = -2; k <= 2; k++) gb.box(k * 0.95, 0.9, 0.04, 0.08, 1.8, 0.04, c.clone().multiplyScalar(0.85));
    } else if (kind === 'mailbox') {
      gb.box(0, 0.55, 0, 0.1, 1.1, 0.1, C(0x5a4a3a));
      gb.box(0, 1.15, 0, 0.25, 0.25, 0.5, C(0x2a2d33));
    } else if (kind === 'hoop') {
      gb.box(0, 1.6, 0, 0.1, 3.2, 0.1, C(0x3a3d42));
      gb.box(0, 3.2, 0.35, 1.2, 0.8, 0.05, C(0xf4f4f0));
      cyl(gb, 0, 2.95, 0.62, 0.24, 0.03, 10, C(0xff6a1a));
    } else if (kind === 'carA' || kind === 'carB' || kind === 'carC' || kind === 'truck') {
      const col = C({ carA: 0xc8ccd0, carB: 0x2a3f6a, carC: 0xa3242a, truck: 0xf0f0ec }[kind]);
      if (kind === 'truck') {
        gb.box(0, 0.75, 0.9, 1.9, 0.8, 2.3, col);
        gb.box(0, 1.35, 0.9, 1.8, 0.8, 1.9, col);
        gb.box(0, 1.4, 1.86, 1.6, 0.6, 0.04, C(0x1d2a38));
        gb.box(0, 0.75, -1.5, 1.9, 0.7, 2.5, col.clone().multiplyScalar(0.9));
      } else {
        gb.box(0, 0.6, 0, 1.8, 0.6, 4.4, col);
        gb.box(0, 1.12, -0.2, 1.6, 0.5, 2.2, col.clone().multiplyScalar(0.94));
        gb.box(0, 1.12, 0.92, 1.5, 0.44, 0.05, C(0x1d2a38));
      }
      for (const [x, z] of [[0.85, 1.4], [-0.85, 1.4], [0.85, -1.4], [-0.85, -1.4]]) cylX(gb, x, 0.34, z, 0.34, 0.22, 8, C(0x141518));
    } else if (kind === 'oak') {
      const bark = C(0x5e5448);
      gb.beam([0, 0, 0], [0.4, 2.2, 0.2], 0.6, 0.6, bark);
      gb.beam([0.4, 2.2, 0.2], [-1.4, 3.6, -0.5], 0.4, 0.4, bark);
      gb.beam([0.4, 2.2, 0.2], [1.8, 3.5, 0.8], 0.4, 0.4, bark);
      const leaf = [0x4f6b35, 0x5c7a3c, 0x46612f];
      for (const [x, y, z, r] of [[0, 4.4, 0, 2.6], [-1.9, 4.0, -0.6, 2.0], [2.0, 4.0, 0.8, 2.1], [0.4, 4.9, 1.2, 1.7], [-0.6, 4.6, 1.6, 1.6]]) ico(gb, x, y, z, r, C(leaf[Math.abs(Math.round(x + z)) % 3]));
    } else if (kind === 'fanpalm') {
      const tr = C(0x8b7355);
      for (let k = 0; k < 6; k++) gb.box(0, 1.1 + k * 2.2, 0, 0.36, 2.22, 0.36, k % 2 ? tr : tr.clone().multiplyScalar(0.9));
      cone(gb, 0, 11.6, 0, 0.9, 1.4, 7, C(0x7a6040)); // the skirt of old fronds
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * Math.PI * 2;
        gb.beam([0, 13.4, 0], [Math.cos(a) * 1.8, 13.1 + (k % 2) * 0.4, Math.sin(a) * 1.8], 0.7, 0.06, C(k % 2 ? 0x3f7a3a : 0x356b33));
      }
    } else if (kind === 'vinerow') {
      flat(gb, 0, 0.03, 0, 1.6, 24, C(0x8a6a48));
      for (let k = -1; k <= 1; k++) gb.box(0, 0.8, k * 11, 0.1, 1.6, 0.1, C(0x7a6450)); // (end and middle posts: the rest hide in the leaves)
      gb.box(0, 1.15, 0, 0.7, 0.6, 24, C(0x5f8c3a));
      gb.box(0, 1.5, 0, 0.5, 0.2, 23.6, C(0x6f9c44));
    } else if (kind === 'ranchfence') {
      const w = C(0x7a6450);
      for (const x of [-2, 2]) gb.box(x, 0.65, 0, 0.14, 1.3, 0.14, w);
      for (const y of [0.55, 1.05]) gb.box(0, y, 0, 4.1, 0.12, 0.06, w.clone().multiplyScalar(1.08));
    } else if (kind === 'garlicrow') {
      gb.box(0, 0.2, 0, 0.5, 0.4, 24, C(0x9cb56a));
      gb.box(0, 0.42, 0, 0.25, 0.1, 24, C(0xb8cf86));
    } else if (kind === 'orchard') {
      gb.box(0, 0.8, 0, 0.25, 1.6, 0.25, C(0x6b5a48));
      ico(gb, 0, 2.4, 0, 1.6, C(0x5a8a3c));
    } else if (kind === 'pole') {
      gb.box(0, 5.5, 0, 0.3, 11, 0.3, C(0x6b5a48));
      gb.box(0, 10.2, 0, 2.6, 0.18, 0.18, C(0x6b5a48));
      for (const x of [-1.1, 0, 1.1]) gb.box(x, 10.4, 0, 0.12, 0.25, 0.12, C(0x5a7a8a));
    } else if (kind === 'farmstand') {
      const w = C(0x9a7550);
      gb.box(0, 1.4, -1, 5, 2.8, 2, w);
      gb.box(0, 0.5, 0.6, 5, 1, 1.2, w.clone().multiplyScalar(0.9));
      for (let k = 0; k < 5; k++) gb.box(-2 + k, 2.9, 1.1, 1, 0.1, 1.8, C(k % 2 ? 0xffffff : 0xd6342c));
      for (let k = 0; k < 10; k++) ico(gb, -2 + (k % 5) * 1, 1.15, 0.4 + Math.floor(k / 5) * 0.4, 0.2, C(0xf2ede2));
      gb.box(0, 3.7, 0, 3.6, 1, 0.08, C(0xf4f3ee));
      pixText(gb, 'GARLIC', [0, 3.7, 0.05], [1, 0, 0], [0, 1, 0], 0.1, C(0xb0302a), [0, 0, 1]);
      pixText(gb, 'GARLIC', [0, 3.7, -0.05], [-1, 0, 0], [0, 1, 0], 0.1, C(0xb0302a), [0, 0, -1]);
    } else if (kind === 'garlic') {
      // the giant garlic bulb: lobes round a core, a neck, a stone plinth
      gb.box(0, 0.5, 0, 3.2, 1, 3.2, C(0xb9b2a4));
      const wc = C(0xf2ede2), pk = C(0xc79ab8);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        ico(gb, Math.cos(a) * 0.8, 2.2, Math.sin(a) * 0.8, 1.05, k % 3 === 0 ? pk : wc);
      }
      ico(gb, 0, 2.5, 0, 1.3, wc);
      cone(gb, 0, 3.2, 0, 0.55, 1.6, 8, wc);
      cone(gb, 0, 4.6, 0, 0.18, 0.8, 6, C(0xd8cfb8));
    } else if (kind === 'oldhall') {
      // the old civic hall: Mission revival, a tall tower with a dome
      const wall = C(0xd8c3a0), trim = C(0xb59a74), tile = C(0xa9502f);
      gb.box(0, 4, 0, 22, 8, 14, wall);
      roofGable(gb, 0, 8, 0, 23, 2, 15, tile);
      for (let k = -4; k <= 4; k++) {
        if (k === 0) continue;
        for (const y of [2.2, 5.6]) {
          gb.box(k * 2.2, y, 7.03, 1.2, 1.8, 0.05, C(0x3a4658));
          cyl(gb, k * 2.2, y + 0.9, 7.03, 0.6, 0.05, 8, C(0x3a4658));
        }
      }
      gb.box(0, 1.6, 7.03, 2.4, 3.2, 0.06, C(0x5a3d2a));
      gb.box(0, 11, 5, 5.2, 22, 5.2, wall);
      gb.box(0, 22.2, 5, 6, 0.6, 6, trim);
      for (const [dx, dz] of [[0, 2.62], [0, -2.62], [2.62, 0], [-2.62, 0]]) {
        cyl(gb, dx, 19, 5 + dz, 1, 0.08, 12, C(0xf4f3ee));
      }
      ico(gb, 0, 24, 5, 2.6, C(0xc9b28a));
      cone(gb, 0, 25.6, 5, 0.3, 2, 6, C(0x8a7a5a));
    } else if (kind === 'citysign') {
      gb.box(-1.4, 1.2, 0, 0.12, 2.4, 0.12, C(0x8a9097));
      gb.box(1.4, 1.2, 0, 0.12, 2.4, 0.12, C(0x8a9097));
      gb.box(0, 2.4, 0, 3.6, 1.3, 0.06, C(0x1f6b3f));
    }
  }

  // ---- shared helpers for the v5.5.8 scenes
  const rotPt = (x, z, r, lx, lz) => [x + lx * Math.cos(r) + lz * Math.sin(r), z - lx * Math.sin(r) + lz * Math.cos(r)];
  const gy = (x, z) => (_gH ? _gH(x, z) : 0);
  // a quad on the face of a box placed at (x, y0, z) turned `r`: face 'f'
  // is local +z (the front), 'l'/'r' local -x/+x; (u, v) the quad's centre
  // across / up the face, (w, h) its size; `out` pushes it off the wall
  function faceQuad(gb, x, y0, z, r, face, half, u, v, w, h, col, out) {
    const o = out || 0.03;
    let a, b, c, d, n;
    if (face === 'f') {
      a = [u - w / 2, v - h / 2, half + o]; b = [u + w / 2, v - h / 2, half + o]; c = [u + w / 2, v + h / 2, half + o]; d = [u - w / 2, v + h / 2, half + o]; n = [0, 1];
    } else {
      const s = face === 'r' ? 1 : -1;
      a = [s * (half + o), v - h / 2, u - w / 2]; b = [s * (half + o), v - h / 2, u + w / 2]; c = [s * (half + o), v + h / 2, u + w / 2]; d = [s * (half + o), v + h / 2, u - w / 2]; n = [s, 0];
    }
    const W = (p) => {
      const q = rotPt(x, z, r, p[0], p[2]);
      return [q[0], y0 + p[1], q[1]];
    };
    const nn = rotPt(0, 0, r, n[0], n[1]);
    gb.quadN(W(a), W(b), W(c), W(d), col, [nn[0], 0, nn[1]]);
  }
  function worldMesh(group, gb, mat, name, shadow) {
    if (!gb.p.length) return null;
    const m = new THREE.Mesh(gb.geometry(), mat || G.CarModel.material());
    m.castShadow = !!shadow;
    m.receiveShadow = false;
    if (name) m.name = name;
    group.add(m);
    return m;
  }
  function glowPoints(group, pts, color, size, opacity) {
    if (!pts.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const m = new THREE.PointsMaterial({ map: glowTex(), color, size, transparent: true, opacity: opacity == null ? 1 : opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    const p = new THREE.Points(g, m);
    group.add(p);
    return p;
  }
  // additive glow quads lying on the ground (light pools)
  function groundGlow(group, spots, color, opacity) {
    const pos = [], uv = [];
    for (const [x, z, R, y] of spots) {
      const Y = (y != null ? y : gy(x, z)) + 0.07;
      const q = [[x - R, z - R, 0, 0], [x + R, z - R, 1, 0], [x + R, z + R, 1, 1], [x - R, z + R, 0, 1]];
      for (const k of [0, 1, 2, 0, 2, 3]) {
        pos.push(q[k][0], Y, q[k][1]);
        uv.push(q[k][2], q[k][3]);
      }
    }
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const m = new THREE.MeshBasicMaterial({ map: glowTex(), color, transparent: true, opacity, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 1;
    group.add(mesh);
    return mesh;
  }
  let _flameTex = null;
  function flameTex() {
    if (_flameTex) return _flameTex;
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 128;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(32, 100, 2, 32, 84, 60);
    grd.addColorStop(0, 'rgba(255,248,200,1)');
    grd.addColorStop(0.25, 'rgba(255,190,70,0.95)');
    grd.addColorStop(0.55, 'rgba(255,90,20,0.6)');
    grd.addColorStop(1, 'rgba(120,20,0,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(32, 2);
    g.bezierCurveTo(62, 50, 64, 90, 50, 118);
    g.quadraticCurveTo(32, 128, 14, 118);
    g.bezierCurveTo(0, 90, 2, 50, 32, 2);
    g.fill();
    _flameTex = new THREE.CanvasTexture(cv);
    return _flameTex;
  }
  // Fires: flickering flame crosses (instanced), a glow, a light pool that
  // breathes, and embers drifting up. fires: [{x, y, z, s}]
  function fireFx(group, fires) {
    if (!fires.length) return;
    const g = new THREE.BufferGeometry();
    const P = [], UV = [];
    for (const a of [0, Math.PI / 2]) {
      const cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5;
      const q = [[-cx, 0, -cz, 0, 0], [cx, 0, cz, 1, 0], [cx, 1.6, cz, 1, 1], [-cx, 1.6, -cz, 0, 1]];
      for (const k of [0, 1, 2, 0, 2, 3]) {
        P.push(q[k][0], q[k][1], q[k][2]);
        UV.push(q[k][3], q[k][4]);
      }
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    const mat = new THREE.MeshBasicMaterial({ map: flameTex(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const n = fires.length * 3;
    const im = new THREE.InstancedMesh(g, mat, n);
    im.userData.sharedGeo = false;
    im.frustumCulled = false;
    const o = new THREE.Object3D();
    const seeds = [];
    fires.forEach((f, k) => {
      for (let j = 0; j < 3; j++) seeds.push({ f, j, ph: k * 1.7 + j * 2.1, dx: (j - 1) * 0.35 * f.s, dz: ((j * 7) % 3 - 1) * 0.3 * f.s });
    });
    group.add(im);
    const glow = glowPoints(group, [].concat(...fires.map((f) => [f.x, f.y + 0.9 * f.s, f.z])), 0xff8a2a, 10, 0.9);
    const pool = groundGlow(group, fires.map((f) => [f.x, f.z, 6 * f.s, f.gy]), 0xff7a2a, 0.5);
    // embers
    const E = fires.length * 10, ep = new Float32Array(E * 3), ev = [];
    for (let k = 0; k < E; k++) {
      const f = fires[k % fires.length];
      ev.push({ f, t: (k * 0.37) % 3, vx: ((k * 13) % 7 - 3) * 0.12, vz: ((k * 5) % 7 - 3) * 0.12 });
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(ep, 3));
    const em = new THREE.Points(eg, new THREE.PointsMaterial({ color: 0xffb040, size: 0.28, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    em.frustumCulled = false;
    group.add(em);
    group.userData.animFns.push((t, dt) => {
      seeds.forEach((s, k) => {
        const fl = 0.75 + 0.25 * Math.sin(t * 9 + s.ph) + 0.12 * Math.sin(t * 23 + s.ph * 3);
        o.position.set(s.f.x + s.dx, s.f.y, s.f.z + s.dz);
        o.rotation.set(0, t * 0.6 + s.ph, 0);
        o.scale.set(s.f.s * (0.9 + 0.1 * Math.sin(t * 7 + s.ph)), s.f.s * fl * (s.j === 1 ? 1.25 : 0.95), s.f.s);
        o.updateMatrix();
        im.setMatrixAt(k, o.matrix);
      });
      im.instanceMatrix.needsUpdate = true;
      if (glow) glow.material.size = 9 + 2 * Math.sin(t * 11);
      if (pool) pool.material.opacity = 0.42 + 0.1 * Math.sin(t * 13) + 0.05 * Math.sin(t * 29);
      const d = Math.min(0.1, dt || 0.016);
      for (let k = 0; k < E; k++) {
        const e = ev[k];
        e.t += d;
        if (e.t > 3) e.t -= 3;
        ep[k * 3] = e.f.x + e.vx * e.t * 3 + Math.sin(e.t * 3 + k) * 0.4;
        ep[k * 3 + 1] = e.f.y + 0.8 + e.t * 2.6 * e.f.s;
        ep[k * 3 + 2] = e.f.z + e.vz * e.t * 3;
      }
      eg.attributes.position.needsUpdate = true;
    });
  }
  // Flashing lights: police / ambulance bars (red and blue) and traffic
  // signals stuck on red. list: [{x, y, z, c: 'rb' | 'r'}]
  function flashFx(group, list) {
    if (!list.length) return;
    const red = [], blue = [], sig = [];
    for (const f of list) {
      if (f.c === 'r') sig.push(f.x, f.y, f.z);
      else {
        red.push(f.x + f.ox, f.y, f.z + f.oz);
        blue.push(f.x - f.ox, f.y, f.z - f.oz);
      }
    }
    const R = glowPoints(group, red, 0xff2a2a, 4.5), B = glowPoints(group, blue, 0x2a5bff, 4.5), S = glowPoints(group, sig, 0xff3020, 3.2);
    group.userData.animFns.push((t) => {
      const ph = (t * 2.6) % 1;
      if (R) R.material.opacity = ph < 0.5 ? (Math.sin(t * 40) > 0 ? 1 : 0.35) : 0.08;
      if (B) B.material.opacity = ph >= 0.5 ? (Math.sin(t * 40) > 0 ? 1 : 0.35) : 0.08;
      if (S) S.material.opacity = (t % 1.2) < 0.7 ? 1 : 0.15;
    });
  }

  // ------------------------------------------------------------- Megastore
  function* sceneStore(track, group, detail, resume) {
    const rng = U.rng(U.hashStr(track.id + 'store'));
    const b = track.bounds, q = {};
    const lat = (x, z) => {
      track.query(x, z, -1, q);
      return Math.abs(q.lat) - q.wall;
    };
    const G0 = 60, M = 240;
    const kinds = ['dLiving', 'dDining', 'dDining2', 'dBed', 'dOffice', 'dKitchen', 'dPatio'];
    const by = {};
    for (const k of kinds.concat(['rack', 'pillar', 'cart', 'psign', 'psign2', 'psign3', 'clight', 'wetsign'])) by[k] = [];
    const lamps = [];
    const reach = 95 + 60 * detail; // beyond this the fog has it
    let n = 0;
    for (let gx = Math.floor((b.x0 - M) / G0); gx <= Math.ceil((b.x1 + M) / G0); gx++) {
      for (let gz = Math.floor((b.z0 - M) / G0); gz <= Math.ceil((b.z1 + M) / G0); gz++) {
        const cx = gx * G0 + 30, cz = gz * G0 + 30;
        const d = lat(cx, cz);
        if (d > reach) continue;
        const pillar = ((gx % 3) + 3) % 3 === 1 && ((gz % 3) + 3) % 3 === 1 && d > 40;
        if (pillar) by.pillar.push({ x: cx, z: cz, r: 0 });
        if (cx > b.x1 + 50) {
          // the warehouse: racking in rows
          for (const oz of [-9, 9]) for (const ox of [-7, 7]) if (lat(cx + ox, cz + oz) > 8 && !track.nearRail(cx + ox, cz + oz, 6)) by.rack.push({ x: cx + ox, z: cz + oz, r: 0 });
          continue;
        }
        for (const [ox, oz] of [[-11.5, -11.5], [11.5, -11.5], [-11.5, 11.5], [11.5, 11.5]]) {
          const x = cx + ox, z = cz + oz;
          if (lat(x, z) < 6.5 || rng() < 0.16) continue;
          const k = kinds[Math.floor(rng() * kinds.length)];
          const r = Math.floor(rng() * 4) * (Math.PI / 2);
          if (track.nearRail(x, z, 6)) continue; // (v5.6.1: a forklift lane)
          by[k].push({ x, z, r });
          for (const L of LAMPS[k] || []) {
            const p = rotPt(x, z, r, L[0], L[2]);
            lamps.push(p[0], gy(p[0], p[1]) + L[1] + 0.1, p[1]);
          }
        }
        if (++n % 30 === 0) {
          yield 'store cells';
          resume();
        }
      }
    }
    // the aisles: lighter strips on the grid (the road is one of them)
    {
      const ag = new G.CarModel.GB(), ac = C(0xd0d2d5);
      for (let gx = Math.floor((b.x0 - 150) / G0); gx <= Math.ceil((b.x1 + 150) / G0); gx++) flat(ag, gx * G0, 0.018, (b.z0 + b.z1) / 2, 14, b.z1 - b.z0 + 300, ac);
      for (let gz = Math.floor((b.z0 - 150) / G0); gz <= Math.ceil((b.z1 + 150) / G0); gz++) flat(ag, (b.x0 + b.x1) / 2, 0.019, gz * G0, b.x1 - b.x0 + 300, 14, ac);
      worldMesh(group, ag, new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), 'aisles');
    }
    // price signs hanging on wires, and shopping carts left in the aisles
    for (let k = 0; k < 75 * detail; k++) {
      const x = U.lerp(b.x0 - 160, b.x1 + 120, rng()), z = U.lerp(b.z0 - 160, b.z1 + 160, rng());
      const dl = lat(x, z);
      if (dl > reach || dl < 26) continue; // (never over the road: the chase camera looks down through there)
      by[['psign', 'psign2', 'psign3'][k % 3]].push({ x, z, y: 11 + rng() * 9, r: rng() * Math.PI });
    }
    for (let k = 0; k < 60 * detail; k++) {
      const gx = Math.round(U.lerp(b.x0 - 150, b.x1 + 150, rng()) / G0) * G0, z = U.lerp(b.z0 - 150, b.z1 + 150, rng());
      const x = gx + (rng() - 0.5) * 8;
      if (lat(x, z) > 1.5 && lat(x, z) < reach && !track.nearRail(x, z, 2)) by.cart.push({ x, z, r: rng() * 6.28 });
    }
    yield 'store signs';
    resume();
    // ceiling panels in rows, lit from below, with a soft haze round each
    const lit = new G.CarModel.GB(), haze = [];
    for (let z = Math.floor((b.z0 - 200) / 30) * 30; z <= b.z1 + 200; z += 30) {
      for (let x = Math.floor((b.x0 - 200) / 36) * 36; x <= b.x1 + 200; x += 36) {
        const dl = lat(x, z);
        if (dl > reach - 50 || dl < 26) continue;
        const y = gy(x, z) + 17;
        by.clight.push({ x, z, y: 17, r: 0 });
        lit.quadN([x - 3.45, y - 0.01, z - 0.5], [x + 3.45, y - 0.01, z - 0.5], [x + 3.45, y - 0.01, z + 0.5], [x - 3.45, y - 0.01, z + 0.5], C(0xeef4ff), [0, -1, 0]);
        haze.push(x, y - 0.6, z);
      }
    }
    const lm = new THREE.MeshBasicMaterial({ vertexColors: true });
    worldMesh(group, lit, lm, 'ceilingLights');
    glowPoints(group, haze, 0xbfd2ff, 11, 0.32);
    // light on the aisle floor under the panels, and the showroom lamps
    const pools = [];
    for (let i = 0; i < track.N; i += 12) pools.push([track.X[i], track.Z[i], 11, track.Y[i]]);
    groundGlow(group, pools, 0x8ea6cc, 0.26);
    glowPoints(group, lamps, 0xffd49a, 2.6);
    // wet-floor signs either side of the mopped patch
    for (const pt of track.patches || []) {
      if (pt.k !== 'water') continue;
      for (const s of [1, -1]) {
        const p = track.pointAt(pt.at, s * (track.wallD[pt.ic] + 0.8));
        by.wetsign.push({ x: p.x, z: p.z, r: track.H[pt.ic] + 0.4 * s });
      }
    }
    for (const k in by) instanced(k, by[k], group, k === 'pillar' || k === 'rack');
    yield 'store';
    resume();
  }

  // ----------------------------------------------------------- Harrow City
  const BRICKS = [0x6e3528, 0x5e4032, 0x74402f, 0x6b6a66, 0x8a7560, 0x4f3a2e, 0x5a2e24];
  function* sceneCity(track, group, detail, resume) {
    const rng = U.rng(U.hashStr(track.id + 'city'));
    const b = track.bounds, q = {};
    const lat = (x, z) => {
      track.query(x, z, -1, q);
      return Math.abs(q.lat) - q.wall;
    };
    // does a w x d footprint at (x, z) turned r keep `m` metres off every road?
    const fits = (x, z, r, w, d, m) => {
      for (const [a, c] of [[0, 0], [-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) {
        const p = rotPt(x, z, r, a, c);
        if (lat(p[0], p[1]) < m) return false;
      }
      return true;
    };
    const bgb = new G.CarModel.GB(), win = new G.CarModel.GB(), neon = new G.CarModel.GB(), rail = new G.CarModel.GB();
    const V = { sedanW: [], sedanK: [], sedanR: [], burnt: [], copcar: [], firetruck: [], ambulance: [], bus: [] };
    const Bz = { chain: [], sawhorse: [], jersey: [], sandbag: [], tlight: [], watertank: [], cone: [] };
    const fires = [], flash = [], placed = [], fronts = [];
    const K = C(0x18191b), STONE = C(0x8c8578);
    const vehicle = (kind, x, z, r) => {
      V[kind].push({ x, z, r });
      const at = (lx, ly, lz, ox) => {
        const p = rotPt(x, z, r, lx, lz), o = rotPt(0, 0, r, ox, 0);
        flash.push({ x: p[0], y: gy(x, z) + ly, z: p[1], ox: o[0], oz: o[1], c: 'rb' });
      };
      if (kind === 'copcar') at(0, 1.55, -0.2, 0.4);
      else if (kind === 'ambulance') at(0, 2.95, 1.4, 0.55);
      else if (kind === 'firetruck') at(0, 2.95, 4.4, 0.8);
      else if (kind === 'burnt' && fires.length < 16) fires.push({ x, y: gy(x, z) + 0.9, z, s: 1.1, gy: gy(x, z) });
    };
    const randVehicle = () => {
      const r = rng();
      return r < 0.18 ? 'sedanW' : r < 0.34 ? 'sedanK' : r < 0.46 ? 'sedanR' : r < 0.62 ? 'copcar' : r < 0.77 ? 'burnt' : r < 0.85 ? 'ambulance' : r < 0.92 ? 'firetruck' : 'bus';
    };
    const building = (x, z, r, w, d, h) => {
      const y0 = gy(x, z) - 0.5, col = C(BRICKS[Math.floor(rng() * BRICKS.length)]);
      boxAt(bgb, x, y0, z, r, 0, h / 2, 0, w, h, d, col);
      boxAt(bgb, x, y0, z, r, 0, h + 0.25, d / 2 - 0.1, w + 0.3, 0.5, 0.5, STONE); // cornice
      boxAt(bgb, x, y0, z, r, 0, 4.9, d / 2 + 0.05, w, 0.35, 0.2, STONE);
      // the shopfront: a steel shutter, or glass with a light on inside
      const glass = rng() < 0.45;
      faceQuad(bgb, x, y0, z, r, 'f', d / 2, 0, 2.6, w * 0.84, 3.6, C(glass ? 0x1b2530 : 0x5d6268));
      if (!glass) for (let k = 1; k < 7; k++) faceQuad(bgb, x, y0, z, r, 'f', d / 2, 0, 0.8 + k * 0.5, w * 0.84, 0.05, C(0x474b50), 0.05);
      else if (rng() < 0.6) faceQuad(win, x, y0, z, r, 'f', d / 2, 0, 2.4, w * 0.8, 3.2, C(rng() < 0.5 ? 0x8a6a3a : 0x3a5a6a), 0.05);
      if (rng() < 0.5) boxAt(bgb, x, y0, z, r, 0, 4.4, d / 2 + 0.9, w * 0.8, 0.12, 1.8, C([0x5a1e1e, 0x1e4a32, 0x2a2f45][Math.floor(rng() * 3)]));
      // windows: dark glass, a few with somebody's light still on
      for (let y = 6.4; y < h - 1.2; y += 3.2) {
        for (let u = -w / 2 + 1.6; u <= w / 2 - 1.4; u += 2.6) {
          faceQuad(bgb, x, y0, z, r, 'f', d / 2, u, y, 1.3, 1.8, C(0x14171b));
          if (rng() < 0.13) faceQuad(win, x, y0, z, r, 'f', d / 2, u, y, 1.1, 1.6, C(rng() < 0.75 ? 0xffc27a : 0x9fc4ff), 0.05);
        }
        for (const s of ['l', 'r']) for (let u = -d / 2 + 1.8; u <= d / 2 - 1.6; u += 2.8) {
          faceQuad(bgb, x, y0, z, r, s, w / 2, u, y, 1.3, 1.8, C(0x14171b));
          if (rng() < 0.08) faceQuad(win, x, y0, z, r, s, w / 2, u, y, 1.1, 1.6, C(0xffc27a), 0.05);
        }
      }
      // a fire escape zig-zagging down the front
      if (h > 12 && rng() < 0.6 && detail > 0.5) {
        const fx = (rng() < 0.5 ? -1 : 1) * w * 0.22;
        for (let y = 6.4 - 1.1, k = 0; y < h - 2; y += 3.2, k++) {
          boxAt(bgb, x, y0, z, r, fx, y, d / 2 + 0.6, 3.6, 0.08, 1.2, K);
          boxAt(bgb, x, y0, z, r, fx, y + 0.5, d / 2 + 1.18, 3.6, 0.05, 0.05, K);
          for (const e of [-1.78, 1.78]) boxAt(bgb, x, y0, z, r, fx + e, y + 0.25, d / 2 + 0.6, 0.05, 0.5, 1.2, K);
          if (y + 3.2 < h - 2) {
            const s = k % 2 ? 1 : -1, a = rotPt(x, z, r, fx - s * 1.5, d / 2 + 0.75), c = rotPt(x, z, r, fx + s * 1.5, d / 2 + 0.75);
            bgb.beam([a[0], y0 + y, a[1]], [c[0], y0 + y + 3.2, c[1]], 0.7, 0.1, K);
          }
        }
      }
      // the roof (the chase camera sees more roof than wall): tar, a parapet,
      // plant, a stair housing, now and then a lit billboard facing the street
      boxAt(bgb, x, y0, z, r, 0, h + 0.03, 0, w - 0.4, 0.06, d - 0.4, C([0x2a2c30, 0x33302d, 0x2d3236][Math.floor(rng() * 3)]));
      for (const s of [-1, 1]) {
        boxAt(bgb, x, y0, z, r, s * (w / 2 - 0.2), h + 0.45, 0, 0.4, 0.9, d, STONE);
        boxAt(bgb, x, y0, z, r, 0, h + 0.45, s * (d / 2 - 0.2), w, 0.9, 0.4, STONE);
      }
      for (let k = 0; k < 1 + Math.floor(rng() * 3); k++) boxAt(bgb, x, y0, z, r, (rng() - 0.5) * (w - 4), h + 0.7, (rng() - 0.5) * (d - 4), 1.8, 1.4, 1.4, C(0x7d8288));
      if (rng() < 0.5) boxAt(bgb, x, y0, z, r, -w * 0.25, h + 1.4, -d * 0.2, 3, 2.8, 3, col.clone().multiplyScalar(0.85));
      if (rng() < 0.35) Bz.watertank.push({ x: rotPt(x, z, r, w * 0.2, -d * 0.2)[0], z: rotPt(x, z, r, w * 0.2, -d * 0.2)[1], y: h - 0.5, r: 0 });
      else if (rng() < 0.3) {
        boxAt(bgb, x, y0, z, r, 0, h + 3, d / 2 - 1.5, 7, 3.4, 0.3, C(0x1a1b1e));
        for (let k = 0; k < 2; k++) boxAt(bgb, x, y0, z, r, (k ? 2.5 : -2.5), h + 0.8, d / 2 - 1.6, 0.2, 1.6, 0.2, C(0x1a1b1e));
        faceQuad(win, x, y0 + h + 3, z, r, 'f', d / 2 - 1.35, 0, 0, 6.6, 3, C([0xd8e8ff, 0xffd9a0, 0xff9ab8, 0xa8ffd8][Math.floor(rng() * 4)]), 0.02);
      }
      fronts.push({ x, z, r, w, d, h, y0 });
    };
    // 1. the blocks that line the streets, with side streets barricaded off
    let slot = 0;
    for (let i = 0; i < track.N; i += 7) {
      for (const side of [1, -1]) {
        const w = 13 + rng() * 3, d = 12, h = 12.8 + Math.floor(rng() * 5) * 3.2;
        const L = side * (track.wallD[i] + 4.5 + d / 2);
        const x = track.X[i] + track.NX[i] * L, z = track.Z[i] + track.NZ[i] * L;
        const r = track.H[i] + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
        if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < 13) || !fits(x, z, r, w, d, 3.5)) continue;
        placed.push({ x, z });
        if (++slot % 8 === 0) {
          // a side street: fence it off, leave what the evacuation left
          for (const u of [-3.6, 0, 3.6]) {
            const p = rotPt(x, z, r, u, d / 2 - 1.5);
            Bz.chain.push({ x: p[0], z: p[1], r });
          }
          const s1 = rotPt(x, z, r, -2, d / 2 + 0.4);
          Bz.sawhorse.push({ x: s1[0], z: s1[1], r: r + 0.15 });
          const s2 = rotPt(x, z, r, 3.2, d / 2 + 0.3);
          Bz.cone.push({ x: s2[0], z: s2[1], r: 0 }, { x: s2[0] + 0.8, z: s2[1] + 0.3, r: 0 });
          const v = rotPt(x, z, r, (rng() - 0.5) * 3, -3);
          vehicle(randVehicle(), v[0], v[1], r + (rng() - 0.5) * 1.4);
          continue;
        }
        building(x, z, r, w, d, h);
      }
      if (i % 49 === 0) {
        yield 'city blocks';
        resume();
      }
    }
    // 2. what was left in the street: cars, police, a bus, fire engines
    for (let i = 3; i < track.N; i += 17) {
      if (rng() < 0.35) continue;
      const side = rng() < 0.5 ? 1 : -1;
      const L = side * (track.wallD[i] + 2.1);
      const x = track.X[i] + track.NX[i] * L, z = track.Z[i] + track.NZ[i] * L;
      const kind = randVehicle(), long = kind === 'bus' ? 11 : kind === 'firetruck' ? 9 : 5;
      const r = track.H[i] + (rng() < 0.7 ? (rng() - 0.5) * 0.3 : (rng() - 0.5) * 1.2) + (rng() < 0.5 ? Math.PI : 0);
      if (!fits(x, z, r, 2.4, long, 0.3)) continue;
      vehicle(kind, x, z, r);
      if (rng() < 0.3) Bz.jersey.push({ x: x + track.TX[i] * (long / 2 + 3), z: z + track.TZ[i] * (long / 2 + 3), r: track.H[i] + Math.PI / 2 + (rng() - 0.5) * 0.3 });
      else if (rng() < 0.3) Bz.sandbag.push({ x: x - track.TX[i] * (long / 2 + 2), z: z - track.TZ[i] * (long / 2 + 2), r: track.H[i] + Math.PI / 2 });
    }
    // 3. the signals at the corners, stuck on red
    for (let i = 0; i < track.N; i++) {
      const k0 = Math.abs(track.K[track.idx(i - 1)]), k1 = Math.abs(track.K[i]);
      if (!(k1 > 1 / 30 && k0 <= 1 / 30)) continue;
      const outside = track.K[i] > 0 ? -1 : 1, j = track.idx(i - 8);
      const L = outside * (track.wallD[j] + 1.5);
      const x = track.X[j] + track.NX[j] * L, z = track.Z[j] + track.NZ[j] * L;
      if (lat(x, z) < 0.8) continue;
      const r = track.H[j] + (outside > 0 ? -Math.PI / 2 : Math.PI / 2);
      Bz.tlight.push({ x, z, r });
      const p = rotPt(x, z, r, 0, 5.4);
      flash.push({ x: p[0], y: gy(x, z) + 6.5, z: p[1], c: 'r' });
    }
    yield 'city street';
    resume();
    // 4. neon: a cinema marquee, hotel and parking signs, a diner, a bar
    const WORDS = [['CINEMA', 0], ['HOTEL', 1], ['DINER', 0], ['PARKING', 1], ['BAR', 0], ['MOTEL', 1], ['OPEN', 0], ['HOTEL', 1]];
    const NC = [0xff2d6a, 0x19e3ff, 0xffb020, 0x3dff8a, 0xb44dff, 0xff5a1f];
    const bulbs = [];
    let wi = 0;
    for (let k = 3; k < fronts.length && wi < WORDS.length; k += Math.max(3, Math.floor(fronts.length / WORDS.length))) {
      const f = fronts[k], [word, vert] = WORDS[wi++], col = C(NC[wi % NC.length]);
      const u = rotPt(0, 0, f.r, 1, 0), fwd = rotPt(0, 0, f.r, 0, 1);
      if (vert) {
        // a blade sign standing out from the wall, lettered top to bottom
        const pp = rotPt(f.x, f.z, f.r, f.w * 0.3, f.d / 2 + 1.1), y = f.y0 + 11;
        const hgt = word.length * 1.25 + 0.8;
        bgb.box(pp[0], y, pp[1], 0.3, hgt, 1.8, C(0x141518), f.r);
        for (const s of [1, -1]) pixText(neon, word, [pp[0] + u[0] * 0.17 * s, y, pp[1] + u[1] * 0.17 * s], [fwd[0] * -s, 0, fwd[1] * -s], [0, 1, 0], 0.16, col, [u[0] * s, 0, u[1] * s], true);
      } else {
        // a marquee over the door, bulbs round the edge
        const pp = rotPt(f.x, f.z, f.r, 0, f.d / 2 + 1.2), y = f.y0 + 5.6;
        const mw = Math.min(f.w * 0.8, word.length * 1.3 + 2);
        bgb.box(pp[0], y, pp[1], mw, 1.6, 2.2, C(0x1a1a1e), f.r);
        const fp = rotPt(f.x, f.z, f.r, 0, f.d / 2 + 2.32);
        pixText(neon, word, [fp[0], y, fp[1]], [u[0], 0, u[1]], [0, 1, 0], 0.17, col, [fwd[0], 0, fwd[1]]);
        for (let e = -mw / 2 + 0.2; e <= mw / 2 - 0.2; e += 0.45) for (const yy of [y - 0.72, y + 0.72]) {
          const bp = rotPt(f.x, f.z, f.r, e, f.d / 2 + 2.34);
          bulbs.push(bp[0], yy, bp[1]);
        }
      }
    }
    // 5. the skyline behind, dark towers in the rain with a few lights on
    const cx = b.cx, cz = b.cz, R0 = Math.max(b.x1 - b.x0, b.z1 - b.z0) / 2;
    for (let k = 0; k < 34 * (0.5 + 0.5 * detail); k++) {
      const a = rng() * Math.PI * 2, R = R0 + 110 + rng() * 170;
      const x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R;
      if (lat(x, z) < 40) continue;
      const w = 18 + rng() * 16, h = 50 + rng() * 90, r = rng() * 1.5;
      boxAt(bgb, x, gy(x, z), z, r, 0, h / 2, 0, w, h, w, C(0x1d252b));
      for (let y = 6; y < h - 3; y += 3.4) for (let u = -w / 2 + 1.5; u < w / 2 - 1; u += 2.2) {
        if (rng() < 0.05) faceQuad(win, x, gy(x, z), z, r, 'f', w / 2, u, y, 1.2, 1.5, C(rng() < 0.7 ? 0xffd08a : 0xb8d4ff), 0.05);
        if (rng() < 0.05) faceQuad(win, x, gy(x, z), z, r, 'l', w / 2, u, y, 1.2, 1.5, C(0xffd08a), 0.05);
      }
    }
    {
      // the one everybody can see from anywhere: a spire with a red beacon
      const a = 0.9, R = R0 + 200, x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R;
      boxAt(bgb, x, 0, z, 0, 0, 90, 0, 26, 180, 26, C(0x1f272d));
      boxAt(bgb, x, 0, z, 0, 0, 195, 0, 14, 30, 14, C(0x222a30));
      boxAt(bgb, x, 0, z, 0, 0, 228, 0, 1, 36, 1, C(0x2a3036));
      flash.push({ x, y: 246, z, c: 'r' });
      for (let y = 8; y < 176; y += 3.6) for (let u = -11; u < 12; u += 2.4) if (rng() < 0.09) faceQuad(win, x, 0, z, 0, 'f', 13, u, y, 1.3, 1.6, C(0xffe0a0), 0.05);
    }
    yield 'city skyline';
    resume();
    // 6. the elevated railway, and a train on it now and then
    const trains = [];
    for (const [x0, z0, x1, z1] of track.def.elRail || []) {
      const dx = x1 - x0, dz = z1 - z0, Lr = Math.hypot(dx, dz), ux = dx / Lr, uz = dz / Lr, nx = -uz, nz = ux;
      const Y = 9.6, st = C(0x33383e), st2 = C(0x2a2e33);
      rail.beam([x0, Y, z0], [x1, Y, z1], 9.2, 0.8, st);
      for (const s of [-1, 1]) {
        const ox = nx * 4.6 * s, oz = nz * 4.6 * s;
        rail.beam([x0 + ox, Y + 2.2, z0 + oz], [x1 + ox, Y + 2.2, z1 + oz], 0.3, 0.3, st2);
        rail.beam([x0 + ox, Y + 0.1, z0 + oz], [x1 + ox, Y + 0.1, z1 + oz], 0.3, 0.3, st2);
        for (let t = 0; t <= Lr; t += 4) {
          const ax = x0 + ux * t + ox, az = z0 + uz * t + oz;
          rail.beam([ax, Y, az], [ax, Y + 2.2, az], 0.18, 0.18, st2);
          if (t + 4 <= Lr) rail.beam([ax, Y, az], [ax + ux * 4, Y + 2.2, az + uz * 4], 0.12, 0.12, st2);
        }
        rail.beam([x0 + nx * 0.8 * s, Y + 0.5, z0 + nz * 0.8 * s], [x1 + nx * 0.8 * s, Y + 0.5, z1 + nz * 0.8 * s], 0.12, 0.16, C(0x8a8f96));
        for (let t = 0; t <= Lr; t += 18) {
          const px = x0 + ux * t + nx * 4.4 * s, pz = z0 + uz * t + nz * 4.4 * s;
          if (lat(px, pz) < 0.7) continue;
          rail.box(px, (gy(px, pz) + Y) / 2, pz, 0.9, Y - gy(px, pz), 0.9, st2);
        }
      }
      trains.push({ x0, z0, ux, uz, L: Lr });
    }
    const railMat = G.CarModel.material().clone();
    railMat.transparent = true;
    const railMesh = worldMesh(group, rail, railMat, 'elRail', true);
    if (railMesh) {
      // (the chase camera looks steeply down: a deck between it and your car
      //  is a dark band across the screen, so the deck goes see-through while
      //  the camera or the car is near it)
      const lines = (track.def.elRail || []).map(([x0, z0, x1, z1]) => [x0, z0, x1, z1]);
      // (see-through only while the deck is between the lens and the car:
      //  the camera-to-car line crosses it, or the car is right under it)
      const cross = (ax, az, bx, bz) => lines.some(([x0, z0, x1, z1]) => {
        const d1 = (bx - ax) * (z0 - az) - (bz - az) * (x0 - ax), d2 = (bx - ax) * (z1 - az) - (bz - az) * (x1 - ax);
        const d3 = (x1 - x0) * (az - z0) - (z1 - z0) * (ax - x0), d4 = (x1 - x0) * (bz - z0) - (z1 - z0) * (bx - x0);
        if (d1 * d2 < 0 && d3 * d4 < 0) return true;
        const dx = x1 - x0, dz = z1 - z0, t = U.clamp(((bx - x0) * dx + (bz - z0) * dz) / (dx * dx + dz * dz), 0, 1);
        return Math.hypot(bx - (x0 + dx * t), bz - (z0 + dz * t)) < 7;
      });
      group.userData.animFns.push((t, dt) => {
        const cam = group.userData.camera, foc = group.userData.cam;
        const hide = cam && foc && cross(cam.position.x, cam.position.z, foc.fx, foc.fz);
        railMat.opacity += ((hide ? 0.25 : 1) - railMat.opacity) * Math.min(1, (dt || 0.016) * 8);
        railMat.depthWrite = railMat.opacity > 0.95;
      });
    }
    if (trains.length) {
      const tg = new G.CarModel.GB(), tw = new G.CarModel.GB();
      for (let c = 0; c < 4; c++) {
        const z = -c * 15.6;
        tg.box(0, 1.9, z, 3, 3.3, 15, C(0xaab0b6));
        tg.box(0, 3.62, z, 2.6, 0.2, 14.6, C(0x7d848b));
        for (const s of [-1, 1]) {
          tg.box(s * 1.51, 2.3, z, 0.02, 0.9, 13, C(0x1d2a38));
          for (let k = -6; k <= 6; k += 1.5) if ((c * 7 + k * 3) % 4 !== 0) tw.box(s * 1.53, 2.3, z + k, 0.02, 0.8, 1.2, C(0xfff0c8));
        }
      }
      const tmat = G.CarModel.material();
      const wmat = new THREE.MeshBasicMaterial({ vertexColors: true });
      for (const T of trains) {
        const m = new THREE.Mesh(tg.geometry(), tmat), wm = new THREE.Mesh(tw.geometry(), wmat);
        m.add(wm);
        m.rotation.y = Math.atan2(T.ux, T.uz);
        m.visible = false;
        group.add(m);
        const speed = 15, run = (T.L + 62) / speed, gap = 14 + T.L / 40;
        group.userData.animFns.push((t) => {
          const p = (t + T.L) % (run + gap);
          m.visible = p < run;
          if (!m.visible) return;
          const s = p * speed;
          m.position.set(T.x0 + T.ux * s, 9.9, T.z0 + T.uz * s);
        });
      }
    }
    yield 'city railway';
    resume();
    // 7. burning barrels (the hazards on the road) and litter everywhere
    for (const o of track.obs || []) if (o.k === 'barrels') fires.push({ x: o.x, y: track.heightAt(o.i, o.lat) + 1.0, z: o.z, s: 0.7, gy: track.heightAt(o.i, o.lat) });
    for (let k = 0; k < 6 && fronts.length; k++) {
      const f = fronts[Math.floor(rng() * fronts.length)];
      const p = rotPt(f.x, f.z, f.r, (rng() - 0.5) * f.w * 0.6, f.d / 2 + 0.2);
      fires.push({ x: p[0], y: f.y0 + 0.6, z: p[1], s: 1.5, gy: f.y0 + 0.5 });
    }
    const lit = new G.CarModel.GB();
    const cols = [0xd9d6cc, 0xb9b3a4, 0x8a7355, 0xe8e4da];
    for (let k = 0; k < 420 * detail; k++) {
      const i = Math.floor(rng() * track.N), la = (rng() * 2 - 1) * (track.wallD[i] - 0.3);
      const p = track.pointAt(track.D[i] + (rng() - 0.5) * 2, la);
      const y = track.heightAt(p.i, la) + 0.05, s = 0.18 + rng() * 0.22, a = rng() * 3.14;
      const ca = Math.cos(a) * s, sa = Math.sin(a) * s;
      lit.quadN([p.x - ca, y, p.z - sa], [p.x + sa, y, p.z - ca], [p.x + ca, y, p.z + sa], [p.x - sa, y, p.z + ca], C(cols[k % 4]), [0, 1, 0]);
    }
    const litMat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    worldMesh(group, lit, litMat, 'litter');
    worldMesh(group, bgb, null, 'cityBlocks', true);
    const wmat = new THREE.MeshBasicMaterial({ vertexColors: true });
    worldMesh(group, win, wmat, 'litWindows');
    const nm = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true });
    const nmesh = worldMesh(group, neon, nm, 'neonWords');
    if (nmesh) {
      group.userData.animFns.push((t) => {
        const cut = Math.sin(t * 29) > 0.985 || Math.sin(t * 1.7 + 2) > 0.994;
        nm.color.setScalar(cut ? 0.35 : 0.92 + 0.08 * Math.sin(t * 57));
      });
    }
    const bl = glowPoints(group, bulbs, 0xffd27a, 1.4);
    if (bl) group.userData.animFns.push((t) => (bl.material.opacity = 0.55 + 0.45 * ((Math.floor(t * 6) % 2) ? 1 : 0.4)));
    for (const k in V) instanced(k, V[k], group, true);
    for (const k in Bz) instanced(k, Bz[k], group, k !== 'cone' && k !== 'chain');
    fireFx(group, fires);
    flashFx(group, flash);
    yield 'city';
    resume();
  }

  // ---------------------------------------------------------- Harvest Run
  // v5.6.1: rebuilt after it came out bland (the same five houses over and
  // over on golden dirt, like a desert). Now it is drawn from photos of a
  // real farm-valley town (no real names anywhere in the game): a green
  // valley floor with golden hills and dark oak woods above it, streets full
  // of mature trees, every house built on its own (size, storeys, roof,
  // colours, garage, porch, chimney, solar), parks, a church, a strip mall
  // and a gas station between the houses, downtown fronts with awnings,
  // signs and cafe tables, and farmland of vines, row crops, corn,
  // orchards, a nursery and greenhouses behind eucalyptus windbreaks.
  const HOUSE_WALLS = [0xece0c4, 0xdcc9a6, 0xc9ae88, 0xb8c0a0, 0xf2efe8, 0xe9c8a8, 0xc8c9c4, 0xb8c6cf, 0xefe2a8, 0xd9b99a, 0xe4d6b8, 0xa9b89a];
  const TILE = [0xb0573a, 0xa24a32, 0xb8653f, 0x9c4630], COMP = [0x6b5a4a, 0x6e7176, 0x4a4e54, 0x7a6a58, 0x585650];
  const DOORS = [0x7a2a26, 0x2a3f6a, 0x2f5a3a, 0x6b4a33, 0x3b3d42, 0xc9a24a];
  const SHOP_WALLS = [0x9a5a44, 0x8a4a38, 0xe8dcc0, 0xd9c3a0, 0xa9b48f, 0xf0ece2, 0xc9b28a, 0x7d6a58, 0xdcc4a4];
  const AWN = [0x2f6b4f, 0x7a2a32, 0x2a3f6a, 0x3b3d42, 0x8a5a2a];
  const SHOPS = ['CAFE', 'BAKERY', 'BOOKS', 'PIZZA', 'WINE', 'DELI', 'TACOS', 'FLOWERS', 'HARDWARE', 'ANTIQUES', 'BIKES', 'SALON', 'DINER', 'GIFTS', 'SUSHI', 'MUSIC', 'OLIVE OIL', 'TEA'];
  const MALL = ['DONUTS', 'LAUNDRY', 'NAILS', 'PHO', 'TAQUERIA', 'PIZZA', 'DENTIST', 'TAX', 'BOBA', 'VIDEO'];
  const pickR = (rng, a) => a[Math.floor(rng() * a.length)];
  // a patch of ground cover that follows the terrain: four world corners
  // [x, z], cut into n x m cells so it never floats over a dip or sinks into
  // a rise (a flat field quad on a slope used to cut into the road)
  function gpatch(gb, A, B, Cc, D, col, dy, n, m) {
    const L = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    const Y = (_gH && _gH.mesh) || gy; // (on the terrain mesh itself where the theme allows)
    const V = (u, v) => {
      const p = L(L(A, B, u), L(D, Cc, u), v);
      return [p[0], Y(p[0], p[1]) + dy, p[1]];
    };
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) gb.quadN(V(i / n, j / m), V((i + 1) / n, j / m), V((i + 1) / n, (j + 1) / m), V(i / n, (j + 1) / m), col, [0, 1, 0]);
  }
  // the same in a lot's own frame: centre (lx, lz), size w x d, turned r
  function lpatch(gb, x, z, r, lx, lz, w, d, col, dy) {
    const P = (a, c) => rotPt(x, z, r, lx + a, lz + c);
    gpatch(gb, P(-w / 2, -d / 2), P(w / 2, -d / 2), P(w / 2, d / 2), P(-w / 2, d / 2), col, dy || 0.05, Math.max(1, Math.round(w / 5)), Math.max(1, Math.round(d / 5)));
  }
  // a roof over a w x d box at (x, y0, z) turned r: 'hip' or 'gable' (the
  // ridge runs along the box's width)
  function roofW(gb, x, y0, z, r, w, d, rh, kind, col) {
    const W = (lx, ly, lz) => {
      const p = rotPt(x, z, r, lx, lz);
      return [p[0], y0 + ly, p[1]];
    };
    const hw = w / 2 + 0.4, hd = d / 2 + 0.4, c2 = col.clone().multiplyScalar(0.84), c3 = col.clone().multiplyScalar(0.93);
    const A = W(-hw, 0, -hd), B = W(hw, 0, -hd), Cc = W(hw, 0, hd), D = W(-hw, 0, hd), cy = y0 + rh / 2;
    const k = kind === 'hip' ? Math.min(hw, hd) * 0.92 : 0;
    const T0 = W(-hw + k, rh, 0), T1 = W(hw - k, rh, 0);
    gb.quad(A, B, T1, T0, c2, x, cy, z);
    gb.quad(D, Cc, T1, T0, col, x, cy, z);
    gb.tri(A, D, T0, c3, x, cy, z);
    gb.tri(B, Cc, T1, c3, x, cy, z);
  }
  // one house, all its own. The front (local +z) faces the street; the
  // yard runs 7 m out front. Returns spots in the yard: the drive (car),
  // trees, and succulents (succ) in a dry garden.
  function houseW(gb, x, z, r, rng, y0, newer) {
    const w = 9 + rng() * 4.5, d = 9 + rng() * 3, two = rng() < (newer ? 0.55 : 0.18), h = two ? 5.7 : 3.0;
    const st = rng(), style = st < (newer ? 0.55 : 0.3) ? 'hip' : st < 0.84 ? 'gable' : 'flat';
    const wall = C(pickR(rng, HOUSE_WALLS)), trim = C(0xf4f2ec), tiled = style !== 'gable' || rng() < 0.3;
    const roofC = C(tiled ? pickR(rng, TILE) : pickR(rng, COMP));
    const g = rng() < 0.5 ? 1 : -1, gw = 6.2, hx = -g * 3.1; // g: the garage's side; hx: the house body's centre
    // (bodies go a metre into the ground so a sloping lot shows no gap)
    boxAt(gb, x, y0, z, r, hx, (h - 1) / 2, 0, w, h + 1, d, wall);
    if (style === 'flat') {
      boxAt(gb, x, y0, z, r, hx, h + 0.35, 0, w, 0.7, d, wall.clone().multiplyScalar(0.95));
      for (const s of [-1, 1]) boxAt(gb, x, y0, z, r, hx, h + 0.6, s * (d / 2 - 0.3), w + 0.2, 0.2, 0.7, roofC); // tile caps
    } else {
      const p = rotPt(x, z, r, hx, 0);
      roofW(gb, p[0], y0 + h, p[1], r, w, d, 1.8 + rng() * 0.8, style, roofC);
    }
    // the garage, lower, with its own roof, set a little forward
    const gx = g * (w / 2 - 0.2), gd = d * 0.85;
    boxAt(gb, x, y0, z, r, gx, 0.95, 0.4, gw, 3.9, gd, wall.clone().multiplyScalar(0.96));
    {
      const p = rotPt(x, z, r, gx, 0.4);
      roofW(gb, p[0], y0 + 2.9, p[1], r, gw, gd, 1.2, style === 'gable' ? 'gable' : 'hip', roofC);
    }
    const gdoor = C(rng() < 0.6 ? 0xf4f3ee : pickR(rng, [0xdcd3c0, 0x8a6a4a, 0x6e7176]));
    faceQuad(gb, x, y0, z, r, 'f', gd / 2 + 0.4, gx, 1.1, 4.8, 2.2, gdoor, 0.04);
    for (let k = 1; k < 4; k++) faceQuad(gb, x, y0, z, r, 'f', gd / 2 + 0.4, gx, k * 0.55, 4.8, 0.035, C(0xbdb7aa), 0.05);
    // the door, windows in white trim (shutters now and then), upstairs
    const dx = hx + g * w * 0.2;
    faceQuad(gb, x, y0, z, r, 'f', d / 2, dx, 1.05, 1.0, 2.1, C(pickR(rng, DOORS)), 0.04);
    const shut = rng() < 0.3 ? C(pickR(rng, [0x2f5a3a, 0x2a3f6a, 0x3b3d42, 0x7a2a26])) : null, glass = C(0x33475b);
    for (const wx of [hx - g * w * 0.3, hx - g * w * 0.05]) {
      faceQuad(gb, x, y0, z, r, 'f', d / 2, wx, 1.55, 1.7, 1.35, trim, 0.03);
      faceQuad(gb, x, y0, z, r, 'f', d / 2, wx, 1.55, 1.45, 1.1, glass, 0.05);
      if (shut) for (const s of [-1, 1]) faceQuad(gb, x, y0, z, r, 'f', d / 2, wx + s * 1.05, 1.55, 0.4, 1.35, shut, 0.04);
    }
    if (two) for (let k = 0; k < 3; k++) {
      const wx = hx - w / 2 + 2 + (k * (w - 4)) / 2;
      faceQuad(gb, x, y0, z, r, 'f', d / 2, wx, 4.3, 1.5, 1.2, trim, 0.03);
      faceQuad(gb, x, y0, z, r, 'f', d / 2, wx, 4.3, 1.3, 1.0, glass, 0.05);
    }
    // a porch roof on posts, a chimney, solar panels on the front slope
    if (rng() < 0.3) {
      boxAt(gb, x, y0, z, r, dx, 2.75, d / 2 + 1.1, 3.4, 0.15, 2.2, roofC);
      for (const s of [-1, 1]) boxAt(gb, x, y0, z, r, dx + s * 1.5, 1.35, d / 2 + 2, 0.15, 2.7, 0.15, trim);
    }
    if (rng() < 0.3) boxAt(gb, x, y0, z, r, hx + (rng() - 0.5) * w * 0.5, h + 1.8, -d * 0.2, 0.8, 2.4, 0.8, C(rng() < 0.5 ? 0x8a4a38 : 0xb9b2a4));
    if (style !== 'flat' && rng() < 0.28) {
      const a = rotPt(x, z, r, hx, d / 2 - 0.5), bb = rotPt(x, z, r, hx, 1.2);
      gb.beam([a[0], y0 + h + 0.6, a[1]], [bb[0], y0 + h + 1.6, bb[1]], 2.5 + rng() * 2.5, 0.08, C(0x1d2d4a));
    }
    // the yard: a lawn or a dry garden of gravel and succulents; the drive; a path
    const lawn = rng() < 0.72;
    lpatch(gb, x, z, r, hx, d / 2 + 3.6, w, 7, C(lawn ? pickR(rng, [0x6ea44b, 0x79aa52, 0x64984a, 0x86ad58]) : pickR(rng, [0xc9b89a, 0xbfae8c, 0xd4c4a4])), 0.05);
    lpatch(gb, x, z, r, gx, gd / 2 + 0.4 + 3.4, 5, 6.8, C(0xcfcac0), 0.07);
    lpatch(gb, x, z, r, dx, d / 2 + 3.6, 1.1, 7, C(0xc6c1b6), 0.08);
    lpatch(gb, x, z, r, 0, -d / 2 - 5, w + 7, 10, C(pickR(rng, [0x6a9a48, 0x72a24c, 0x5f9444])), 0.04); // the back yard
    const cp = rotPt(x, z, r, gx, gd / 2 + 4);
    const yard = [{ x: cp[0], z: cp[1], car: true }]; // (the drive, for a parked car)
    const tp = rotPt(x, z, r, hx - g * w * 0.25, d / 2 + 3.5 + (rng() - 0.5) * 2);
    yard.push({ x: tp[0], z: tp[1] });
    if (rng() < 0.4) {
      const bp = rotPt(x, z, r, hx + (rng() - 0.5) * w, -d / 2 - 4);
      yard.push({ x: bp[0], z: bp[1] }); // one in the back yard too
    }
    if (!lawn) for (let k = 0; k < 4; k++) {
      const sp = rotPt(x, z, r, hx - g * (1 + rng() * w * 0.4), d / 2 + 1.5 + rng() * 5);
      yard.push({ x: sp[0], z: sp[1], succ: true });
    }
    return yard;
  }
  // a board on a front (local +z face at `half`) with a word on it
  function signBoard(gb, txt, x, y0, z, r, half, u, v, w, h, word, dark) {
    faceQuad(gb, x, y0, z, r, 'f', half, u, v, w, h, C(dark ? 0x23262b : 0xf2ede0), 0.06);
    const fp = rotPt(x, z, r, u, half + 0.1), ux = rotPt(0, 0, r, 1, 0), f = rotPt(0, 0, r, 0, 1);
    pixText(txt, word, [fp[0], y0 + v, fp[1]], [ux[0], 0, ux[1]], [0, 1, 0], Math.min((h * 0.75) / 7, (w * 0.88) / (word.length * 6)), C(dark ? 0xf2e6c8 : 0x2a2d33), [f[0], 0, f[1]]);
  }
  // a downtown front: one or two storeys, a parapet (flat, stepped or
  // Mission), a shopfront, an awning and a sign with the shop's name
  function shopW(gb, txt, x, z, r, w, rng, y0) {
    const two = rng() < 0.55, h = two ? 8.2 : 5, d = 11;
    const wall = C(pickR(rng, SHOP_WALLS)), trim = C(pickR(rng, [0xf0ece2, 0xd8cbb4, 0x3b3d42]));
    boxAt(gb, x, y0, z, r, 0, (h - 1) / 2, 0, w, h + 1, d, wall);
    const ps = rng();
    if (ps < 0.35) boxAt(gb, x, y0, z, r, 0, h + 0.35, d / 2 - 0.2, w + 0.2, 0.7, 0.5, trim);
    else if (ps < 0.7) for (let k = 0; k < 3; k++) boxAt(gb, x, y0, z, r, 0, h + 0.3 + k * 0.45, d / 2 - 0.25, w * (1 - k * 0.28), 0.45, 0.4, k ? wall : trim);
    else {
      boxAt(gb, x, y0, z, r, 0, h + 0.3, d / 2 - 0.25, w, 0.6, 0.4, wall);
      boxAt(gb, x, y0, z, r, 0, h + 0.9, d / 2 - 0.25, w * 0.4, 0.8, 0.4, wall);
      boxAt(gb, x, y0, z, r, 0, h + 1.45, d / 2 - 0.25, w * 0.16, 0.5, 0.4, trim);
    }
    const glass = C(0x2c3a4a);
    faceQuad(gb, x, y0, z, r, 'f', d / 2, 0, 1.55, w * 0.78, 2.7, glass, 0.04);
    faceQuad(gb, x, y0, z, r, 'f', d / 2, w * 0.3, 1.2, 1.1, 2.4, C(pickR(rng, DOORS)), 0.05);
    if (two) for (let k = 0; k < 3; k++) faceQuad(gb, x, y0, z, r, 'f', d / 2, -w / 3 + (k * w) / 3, 5.8, 1.4, 1.8, glass, 0.04);
    // the awning: plain or striped
    const awC = C(pickR(rng, AWN));
    if (rng() < 0.3) for (let k = 0; k < 8; k++) boxAt(gb, x, y0, z, r, -w * 0.4 + (k + 0.5) * ((w * 0.8) / 8), 3.35, d / 2 + 0.8, (w * 0.8) / 8, 0.1, 1.6, k % 2 ? C(0xf4f3ee) : awC);
    else boxAt(gb, x, y0, z, r, 0, 3.35, d / 2 + 0.8, w * 0.82, 0.1, 1.6, awC);
    signBoard(gb, txt, x, y0, z, r, d / 2, 0, 3.95, w * 0.62, 0.8, pickR(rng, SHOPS), rng() < 0.6);
    for (let k = Math.floor(rng() * 3); k >= 0; k--) boxAt(gb, x, y0, z, r, (rng() - 0.5) * (w - 3), h + 0.5, (rng() - 0.5) * 6, 1.4, 1, 1.2, C(0xb9bcc0)); // rooftop units
  }
  // behind a downtown front: flats or offices over the alley, or a car park
  function backW(gb, x, z, r, w, rng, y0, add) {
    if (rng() < 0.55) {
      const fl = 2 + Math.floor(rng() * 2), h = fl * 3.2, wall = C(pickR(rng, SHOP_WALLS));
      boxAt(gb, x, y0, z, r, 0, (h - 1) / 2, 0, w, h + 1, 12, wall);
      boxAt(gb, x, y0, z, r, 0, h + 0.25, 0, w + 0.3, 0.5, 12.3, wall.clone().multiplyScalar(0.9));
      for (let f = 0; f < fl; f++) for (let k = 0; k < Math.floor(w / 3.2); k++) faceQuad(gb, x, y0, z, r, 'f', 6, -w / 2 + 1.6 + k * 3.2, 1.6 + f * 3.2, 1.3, 1.5, C(0x2c3a4a), 0.04);
      if (rng() < 0.6) boxAt(gb, x, y0, z, r, (rng() - 0.5) * (w - 3), h + 1, 0, 1.6, 1, 1.4, C(0xb9bcc0));
    } else {
      lpatch(gb, x, z, r, 0, 0, w, 12, C(0x5a5d61), 0.05);
      for (let k = 0; k < 2; k++) if (rng() < 0.7) {
        const p = rotPt(x, z, r, (rng() - 0.5) * (w - 3), (rng() - 0.5) * 6);
        add(pickR(rng, ['carA', 'carB', 'carC', 'truck']), { x: p[0], z: p[1], r: r + (rng() < 0.5 ? 0 : Math.PI) });
      }
    }
  }

  function* sceneSuburb(track, group, detail, resume) {
    const rng = U.rng(U.hashStr(track.id + 'harvest'));
    const XG = !!(track.xings && track.xings.length);
    const b = track.bounds, q = {};
    const lat = (x, z) => {
      track.query(x, z, -1, q);
      return Math.abs(q.lat) - q.wall;
    };
    const fits = (x, z, r, w, d, m) => {
      for (const [a, c] of [[0, 0], [-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2], [0, d / 2], [-w / 2, 0], [w / 2, 0]]) {
        const p = rotPt(x, z, r, a, c);
        if (lat(p[0], p[1]) < m || (XG && track.nearRail(p[0], p[1], 2))) return false;
      }
      return true;
    };
    const P = {};
    // (v5.6.1: nothing in the tractor's lane; a fence panel is 8 m long)
    const add = (k, it) => {
      if (XG && track.nearRail(it.x, it.z, k === 'ranchfence' ? 4.5 : 1.5)) return;
      (P[k] || (P[k] = [])).push(it);
    };
    const hg = new G.CarModel.GB(), txt = new G.CarModel.GB(), wgb = new G.CarModel.GB(), soil = new G.CarModel.GB();
    const L0 = track.length;
    // zones along the road: downtown Clovehaven, its neighbourhoods, the
    // farm valley, Oak Valley's neighbourhoods, downtown Oak Valley
    const zone = (a) => (a < 170 ? 'dtg' : a < 700 ? 'town' : a < 1690 ? 'farm' : a < L0 - 360 ? 'town' : 'dtm');
    const face = (i, side) => track.H[i] + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
    const at = (i, side, off, along) => {
      const L = side * (track.wallD[i] + off);
      return [track.X[i] + track.NX[i] * L + track.TX[i] * (along || 0), track.Z[i] + track.NZ[i] * L + track.TZ[i] * (along || 0)];
    };
    const placed = [];
    const free = (x, z, rr) => !placed.some((p) => Math.hypot(p[0] - x, p[1] - z) < rr + p[2]);
    const YARD = ['olive', 'crepeP', 'crepeV', 'maple', 'sweetgum', 'olive', 'citrus', 'cypress', 'maple'];
    const STREET = ['sycamore', 'sweetgum', 'sweetgum', 'olive', 'sycamore', 'maple', 'sweetgumR', 'fanpalm', 'sycamore'];
    const CARS = ['carA', 'carB', 'carC', 'truck'];
    // (every tree gets a tint: in a kind where some are tinted and some not,
    // the untinted ones draw black)
    const tree = (k, x, z, s) => add(k, { x, z, r: rng() * 6.28, s: s || 0.85 + rng() * 0.35, t: 0.9 + rng() * 0.2 });
    // ---- the special lots between the houses (each returns its half-width)
    const SPECIAL = {
      park(x, z, r) {
        lpatch(hg, x, z, r, 0, 0, 32, 24, C(0x6aa447), 0.05);
        lpatch(hg, x, z, r, 0, 4, 2, 16, C(0xcfc8b8), 0.08);
        const pl = rotPt(x, z, r, -7, -2);
        add('play', { x: pl[0], z: pl[1], r: r + (rng() - 0.5) * 0.4 });
        for (const [a, c] of [[8, 6], [-12, 8], [11, -8], [2, -9], [-13, -7]]) {
          const p = rotPt(x, z, r, a + (rng() - 0.5) * 3, c + (rng() - 0.5) * 3);
          tree(rng() < 0.5 ? 'sycamore' : 'oak', p[0], p[1], 0.9 + rng() * 0.3);
        }
        for (const [a, c, k] of [[3, 9, 'bench'], [-3, 9, 'bench'], [7, -2, 'picnic'], [10, 1, 'picnic']]) {
          const p = rotPt(x, z, r, a, c);
          add(k, { x: p[0], z: p[1], r: r + (k === 'picnic' ? rng() : 0) });
        }
        return 17;
      },
      church(x, z, r, y0) {
        const wall = C(0xf2ede2), tile = C(pickR(rng, TILE)), wood = C(0x5a3d2a);
        boxAt(hg, x, y0, z, r, 2, 3, -2, 11, 8, 18, wall);
        const rp = rotPt(x, z, r, 2, -2);
        roofW(hg, rp[0], y0 + 7, rp[1], r + Math.PI / 2, 18, 11, 3.6, 'gable', tile);
        // the front: a stepped Mission parapet, an arched door, two windows
        boxAt(hg, x, y0, z, r, 2, 8.4, 7.05, 11.6, 2.8, 0.5, wall);
        boxAt(hg, x, y0, z, r, 2, 10.3, 7.05, 5, 1.2, 0.5, wall);
        boxAt(hg, x, y0, z, r, 2, 11.2, 7.05, 1.8, 0.8, 0.5, wall);
        faceQuad(hg, x, y0, z, r, 'f', 7, 2, 1.6, 2.4, 3.2, wood, 0.04);
        faceQuad(hg, x, y0, z, r, 'f', 7, 2, 3.4, 1.6, 0.5, wood, 0.04);
        for (const s of [-1, 1]) faceQuad(hg, x, y0, z, r, 'f', 7, 2 + s * 3.4, 3.6, 1, 2.4, C(0x5a6a88), 0.04);
        // the bell tower beside it
        boxAt(hg, x, y0, z, r, -6.5, 6.5, 4, 4, 15, 4, wall);
        faceQuad(hg, x, y0, z, r, 'f', 6, -6.5, 11.5, 1.6, 2.4, C(0x2a2d33), 0.03);
        faceQuad(hg, x, y0, z, r, 'l', 8.5, 4, 11.5, 1.6, 2.4, C(0x2a2d33), 0.03);
        const tp = rotPt(x, z, r, -6.5, 4);
        roofW(hg, tp[0], y0 + 14, tp[1], r, 4, 4, 2.4, 'hip', tile);
        lpatch(hg, x, z, r, 2, 10, 14, 5, C(0x6ea44b), 0.05);
        lpatch(hg, x, z, r, 2, 10, 3, 5.2, C(0xd8cfbe), 0.08);
        for (const a of [-2.5, 6.5]) {
          const p = rotPt(x, z, r, a, 10.5);
          tree('cypress', p[0], p[1], 1);
        }
        const op = rotPt(x, z, r, 10.5, 9);
        tree('olive', op[0], op[1], 1.1);
        return 13;
      },
      mall(x, z, r, y0) {
        // a strip mall: a long low block, its lot and a few cars
        const wall = C(pickR(rng, [0xe4d6b8, 0xd9c3a0, 0xcfc6b4])), trim = C(pickR(rng, TILE));
        boxAt(hg, x, y0, z, r, 0, 2.3, -7, 34, 6.6, 10, wall);
        boxAt(hg, x, y0, z, r, 0, 5.8, -1.6, 34.4, 0.5, 1.2, trim);
        const names = MALL.slice().sort(() => rng() - 0.5).slice(0, 4);
        for (let k = 0; k < 4; k++) {
          const u = -12.75 + k * 8.5;
          faceQuad(hg, x, y0, z, r, 'f', -2, u, 1.5, 6.6, 2.6, C(0x2c3a4a), 0.04);
          signBoard(hg, txt, x, y0, z, r, -1.9, u, 4.4, 6.8, 1.0, names[k], rng() < 0.5);
        }
        lpatch(hg, x, z, r, 0, 6, 34, 16, C(0x5a5d61), 0.05);
        for (let k = -4; k <= 4; k++) lpatch(hg, x, z, r, k * 3.4, 3, 0.12, 5, C(0xe8e8e2), 0.08);
        for (let k = 0; k < 4; k++) if (rng() < 0.7) {
          const p = rotPt(x, z, r, (Math.floor(rng() * 8) - 4) * 3.4 + 1.7, 3);
          add(pickR(rng, CARS), { x: p[0], z: p[1], r: r + (rng() < 0.5 ? 0 : Math.PI) });
        }
        return 18;
      },
      gas(x, z, r, y0) {
        // a gas station: canopy, pumps, a little shop, the tall sign
        lpatch(hg, x, z, r, 0, 2, 26, 22, C(0xb9b4a8), 0.05);
        boxAt(hg, x, y0, z, r, 0, 5.1, 4, 14, 0.7, 9, C(0xf4f4f0));
        boxAt(hg, x, y0, z, r, 0, 5.1, 4, 14.1, 0.25, 9.1, C(0xc8352c));
        for (const [a, c] of [[-5, 1], [5, 1], [-5, 7], [5, 7]]) boxAt(hg, x, y0, z, r, a, 2.4, c, 0.4, 4.8, 0.4, C(0xe8e8e4));
        for (const a of [-3.5, 3.5]) {
          const p = rotPt(x, z, r, a, 4);
          add('pump', { x: p[0], z: p[1], r });
        }
        boxAt(hg, x, y0, z, r, 0, 1.5, -7, 12, 5, 7, C(0xe8dcc0));
        faceQuad(hg, x, y0, z, r, 'f', -3.5, 0, 1.5, 8, 2.4, C(0x2c3a4a), 0.04);
        signBoard(hg, txt, x, y0, z, r, -3.5, 0, 3.6, 7, 0.9, 'FOOD MART', false);
        const sp = rotPt(x, z, r, 11, 10), sy = gy(sp[0], sp[1]);
        boxAt(hg, sp[0], sy, sp[1], r, 0, 4, 0, 0.4, 8, 0.4, C(0x8a9097));
        boxAt(hg, sp[0], sy, sp[1], r, 0, 8.3, 0, 3.4, 2.4, 0.4, C(0xc8352c));
        signBoard(hg, txt, sp[0], sy, sp[1], r, 0.2, 0, 8.6, 3, 1.2, 'GAS', false);
        return 15;
      },
    };
    // 1. the neighbourhoods, both sides: every house its own, set back by
    //    its own amount, a street tree in front of most, a house behind on
    //    the next street; now and then a park, the church, a strip mall or a
    //    gas station in place of a house
    // straight enough here for a street behind the houses? (on a bend the
    // offset would fold over itself)
    const straight = (i) => {
      const k = Math.round(15 / track.sp), dh = track.H[track.idx(i + k)] - track.H[track.idx(i - k)];
      return Math.abs(Math.atan2(Math.sin(dh), Math.cos(dh))) < 0.2;
    };
    const ASPH = C(0x55585c), WALK = C(0xcac5b9);
    for (const side of [1, -1]) {
      const deck = ['park', 'mall', 'church', 'gas', 'park', 'mall'].sort(() => rng() - 0.5);
      let a = 175 + rng() * 10, lastSp = -1e9, lastX = -1e9;
      while (a < L0 - 360) {
        const i = track.idx(Math.round(a / track.sp)), zn = zone(a);
        if (zn !== 'town') {
          a += 25;
          continue;
        }
        const newer = a > 1000, r = face(i, side) + (rng() - 0.5) * 0.05;
        if (deck.length && a - lastSp > 120 && rng() < 0.12) {
          const [x, z] = at(i, side, 17);
          if (fits(x, z, r, 34, 24, 0.6) && free(x, z, 17)) {
            const kind = deck.pop(), half = SPECIAL[kind](x, z, r, gy(x, z));
            placed.push([x, z, half]);
            lastSp = a;
            a += half * 2 + 2;
            continue;
          }
        }
        // now and then a side street off the road, out to the next street over
        if (a - lastX > 90 && a - lastSp > 30 && straight(i) && rng() < 0.16) {
          const [cx, cz] = at(i, side, 34.5), rr = face(i, side);
          const clearOf = [-24, -8, 8, 24].every((o) => {
            const p = rotPt(cx, cz, rr, 0, o);
            return free(p[0], p[1], 4);
          });
          if (fits(cx, cz, rr, 8, 69, 0) && clearOf) {
            lpatch(hg, cx, cz, rr, 0, 0, 8, 69, ASPH, 0.06);
            for (const s of [-1, 1]) lpatch(hg, cx, cz, rr, s * 4.8, -1, 1.6, 67, WALK, 0.06);
            lpatch(hg, cx, cz, rr, 2, 31.5, 3.6, 0.45, C(0xf2f2ee), 0.08); // the stop line
            for (const o of [-24, -8, 8, 24]) {
              const p = rotPt(cx, cz, rr, 0, o);
              placed.push([p[0], p[1], 5]);
            }
            const sp = rotPt(cx, cz, rr, 4.8, 32);
            add('stopsign', { x: sp[0], z: sp[1], r: rr });
            lastX = a;
            a += 14;
            continue;
          }
        }
        const gap = 20 + rng() * 6, set = 14 + rng() * 2.5;
        const [x, z] = at(i, side, set);
        if (fits(x, z, r, 20, 24, 0.6) && free(x, z, 9.5)) {
          placed.push([x, z, 9.5]);
          for (const y of houseW(hg, x, z, r, rng, gy(x, z), newer)) {
            if (y.car) {
              if (rng() < 0.55) add(pickR(rng, CARS), { x: y.x, z: y.z, r: r + (rng() < 0.5 ? 0 : Math.PI) });
            } else if (y.succ) add('succulent', { x: y.x, z: y.z, r: rng() * 6, s: 0.8 + rng() * 0.6 });
            else if (rng() < 0.8) tree(pickR(rng, YARD), y.x, y.z);
          }
          const mb = rotPt(x, z, r, (rng() - 0.5) * 8, set - 1.2);
          add('mailbox', { x: mb[0], z: mb[1], r });
          const fe = rotPt(x, z, r, 10.2, 0);
          if (rng() < 0.4) add('hedge', { x: fe[0], z: fe[1], r: r + Math.PI / 2, sv: [2.3, 0.8 + rng() * 0.6, 1] });
          else add('fenceW', { x: fe[0], z: fe[1], r: r + Math.PI / 2, sv: [2.3, 1, 1] });
          if (rng() < 0.1) {
            const hp = rotPt(x, z, r, 6.5, 11);
            add('hoop', { x: hp[0], z: hp[1], r: r + Math.PI });
          }
          // the house behind, its back to us, facing the next street over
          const [bx, bz] = at(i, side, set + 30 + rng() * 4);
          if (fits(bx, bz, r + Math.PI, 20, 24, 2) && free(bx, bz, 9.5)) {
            placed.push([bx, bz, 9.5]);
            for (const y of houseW(hg, bx, bz, r + Math.PI, rng, gy(bx, bz), newer)) if (!y.succ && !y.car && rng() < 0.6) tree(pickR(rng, YARD), y.x, y.z, 1 + rng() * 0.4);
          }
        }
        const [tx, tz] = at(i, side, 2.4, gap / 2);
        if (lat(tx, tz) > 1.2 && rng() < 0.88) tree(pickR(rng, STREET), tx, tz);
        a += gap;
      }
      yield 'valley houses';
      resume();
    }
    // the next street over, where the road runs straight, and a third row of
    // houses facing it
    for (const side of [1, -1]) {
      let a = 180, nextHouse = 0;
      while (a < L0 - 360) {
        if (zone(a) !== 'town') {
          a += 10;
          continue;
        }
        const i = track.idx(Math.round(a / track.sp)), r = face(i, side), [sx, sz] = at(i, side, 68);
        if (straight(i) && lat(sx, sz) > 60 && free(sx, sz, 3.5)) {
          lpatch(hg, sx, sz, r, 0, 0, 10.6, 7, ASPH, 0.06);
          for (const s of [-1, 1]) lpatch(hg, sx, sz, r, 0, s * 4.3, 10.6, 1.6, WALK, 0.06);
          if (rng() < 0.3) {
            const [tx, tz] = at(i, side, 73.8);
            tree(pickR(rng, STREET), tx, tz);
          }
          if (a >= nextHouse) {
            const [cx, cz] = at(i, side, 88);
            if (fits(cx, cz, r, 20, 24, 60) && free(cx, cz, 9.5)) {
              placed.push([cx, cz, 9.5]);
              nextHouse = a + 20 + rng() * 6;
              for (const y of houseW(hg, cx, cz, r, rng, gy(cx, cz), a > 1000)) {
                if (y.car) {
                  if (rng() < 0.5) add(pickR(rng, CARS), { x: y.x, z: y.z, r: r + (rng() < 0.5 ? 0 : Math.PI) });
                } else if (!y.succ && rng() < 0.7) tree(pickR(rng, YARD), y.x, y.z);
              }
            }
          }
        }
        a += 10;
      }
    }
    yield 'valley streets';
    resume();
    // 2. downtown at both ends: fronts of different widths, awnings, signs,
    //    cafe tables, planters and trees on the sidewalk
    for (const side of [1, -1]) {
      let a = 20;
      while (a < L0 - 20) {
        const zn = zone(a);
        if (zn !== 'dtg' && zn !== 'dtm') {
          a += 30;
          continue;
        }
        const w = 9 + rng() * 6, i = track.idx(Math.round(a / track.sp)), r = face(i, side);
        const [x, z] = at(i, side, 11);
        if (fits(x, z, r, w, 11, 1.5) && free(x, z, w / 2)) {
          placed.push([x, z, w / 2 + 0.5]);
          shopW(hg, txt, x, z, r, w, rng, gy(x, z));
          const [bx, bz] = at(i, side, 30);
          if (fits(bx, bz, r, w, 12, 12) && free(bx, bz, w / 2)) {
            placed.push([bx, bz, w / 2 + 0.5]);
            backW(hg, bx, bz, r, w, rng, gy(bx, bz), add);
          }
          if (rng() < 0.55) {
            const u = rotPt(x, z, r, (rng() - 0.5) * w * 0.5, 7.4);
            add(pickR(rng, ['umbR', 'umbG', 'umbC']), { x: u[0], z: u[1], r: rng() * 6 });
          }
          if (rng() < 0.5) {
            const pl = rotPt(x, z, r, w / 2 - 0.7, 7);
            add('planter', { x: pl[0], z: pl[1], r });
          }
        }
        const [tx, tz] = at(i, side, 2, w / 2 + 0.5);
        if (lat(tx, tz) > 1 && rng() < 0.65) tree(rng() < 0.6 ? 'sweetgum' : 'olive', tx, tz, 0.8 + rng() * 0.3);
        a += w + 0.3;
      }
    }
    yield 'valley downtown';
    resume();
    const SOIL = { vine: [0x8a6a48, 0x7c9c4a], corn: [0x8a6a48], rows: [0x7d5e40, 0x8a6a48], orchard: [0x7fa04c, 0x94a85a], nursery: [0xb8ad98], stubble: [0xc9b27a] };
    const cropOf = (roll) => (roll < 0.22 ? 'vine' : roll < 0.34 ? 'corn' : roll < 0.52 ? 'rows' : roll < 0.66 ? 'orchard' : roll < 0.73 ? 'nursery' : roll < 0.8 ? 'greenhouse' : roll < 0.88 ? 'stubble' : 'pasture');
    // one field: road distance a..a+len, n0..n1 metres out from the fence.
    // Soil and rows go in pieces of 25 m or less, each lined up with the road
    // where it is, so a field bends with the road instead of cutting across
    // it on a curve.
    const field = (side, a, len, n0, n1) => {
      const roll = rng(), crop = cropOf(roll), segs = Math.ceil(len / 25), segL = len / segs;
      const soilC = SOIL[crop] && C(pickR(rng, SOIL[crop])).multiplyScalar(0.92 + rng() * 0.12);
      const rowStep = { vine: 3, corn: 2.2, rows: 1.8 }[crop], citrusy = rng() < 0.35, young = rng() < 0.15;
      for (let s = 0; s < segs; s++) {
        const ia = track.idx(Math.round((a + s * segL) / track.sp)), ib = track.idx(Math.round((a + (s + 1) * segL) / track.sp));
        const im = track.idx(Math.round((a + (s + 0.5) * segL) / track.sp)), r = track.H[im];
        if (soilC) gpatch(soil, at(ia, side, n0), at(ib, side, n0), at(ib, side, n1), at(ia, side, n1), soilC, 0.06, Math.max(1, Math.round(segL / 5)), Math.max(2, Math.round((n1 - n0) / 5)));
        if (rowStep) for (let L = n0 + 1.5; L <= n1 - 1; L += rowStep) {
          const [x, z] = at(im, side, L);
          if (lat(x, z) < n0 - 0.5) continue;
          const kind = crop === 'vine' ? (young ? 'vinerowR' : 'vinerow') : crop === 'corn' ? 'cornrow' : L - n0 < 12 === roll < 0.43 ? 'garlicrow' : 'croprow';
          add(kind, { x, z, r, sv: [1, 1, (segL - 0.8) / 24] });
        }
      }
      const i = track.idx(Math.round((a + len / 2) / track.sp)), r = track.H[i];
      if (crop === 'orchard' || crop === 'nursery') {
        for (let L = n0 + 3; L <= n1 - 2; L += crop === 'orchard' ? 6 : 4) for (let al = 4; al <= len - 4; al += crop === 'orchard' ? 6 : 5) {
          const ii = track.idx(Math.round((a + al) / track.sp)), [x, z] = at(ii, side, L);
          if (lat(x, z) < n0) continue;
          if (crop === 'orchard') add(citrusy ? 'citrus' : 'orchard', { x, z, r: rng() * 6, s: 0.85 + rng() * 0.3 });
          else add('pots', { x, z, r: track.H[ii] });
        }
      }
      if (crop === 'greenhouse') for (const L of [n0 + 6, n0 + 18]) {
        const [x, z] = at(i, side, L);
        if (lat(x, z) > n0 + 1) add('greenhouse', { x, z, r, sv: [1, 1, Math.min(len - 6, 50) / 32] });
      }
      if (crop === 'stubble' || crop === 'pasture') for (let k = 0; k < 5; k++) {
        const ii = track.idx(Math.round((a + 4 + rng() * (len - 8)) / track.sp)), [x, z] = at(ii, side, n0 + 4 + rng() * (n1 - n0 - 8));
        if (lat(x, z) > n0 + 1) {
          if (crop === 'stubble') add('hay', { x, z, r: rng() * 6, s: 0.8 + rng() * 0.5 });
          else tree('oak', x, z, 0.8 + rng() * 0.5);
        }
      }
    };
    // 3. the farm valley: blocks of two fields deep along the road, each
    //    field its own crop; windbreaks between some blocks; a farmhouse and
    //    barn behind now and then
    for (const side of [1, -1]) {
      let a = 705 + rng() * 20;
      while (a < 1660) {
        let len = Math.min(44 + rng() * 30, 1685 - a);
        // (a block stops short of the tractor's lane; the next starts past it)
        const xg = XG && track.xings.find((x) => a + len > x.at - 9 && a < x.at + 9);
        if (xg) {
          len = xg.at - 9 - a;
          if (len < 20) {
            a = xg.at + 9;
            continue;
          }
        }
        if (len < 20) break;
        field(side, a, len, 8, 34);
        field(side, a, len, 38, 64);
        const i = track.idx(Math.round((a + len / 2) / track.sp));
        // a windbreak of eucalyptus or cypress down the block's edge
        if (rng() < 0.4) {
          const kind = rng() < 0.6 ? 'eucalyptus' : 'cypress', ie = track.idx(Math.round((a + len + 1) / track.sp));
          for (let L = 9; L <= 66; L += kind === 'cypress' ? 2.6 : 4.5) {
            const [x, z] = at(ie, side, L);
            if (lat(x, z) > 7) tree(kind, x, z);
          }
        }
        // now and then a farmhouse and a barn behind the fields
        if (rng() < 0.35) {
          const fr = face(i, side), [hx, hz] = at(i, side, 80);
          if (free(hx, hz, 12) && fits(hx, hz, fr, 20, 24, 60)) {
            placed.push([hx, hz, 12]);
            for (const y of houseW(hg, hx, hz, fr, rng, gy(hx, hz), false)) if (!y.succ && !y.car) tree(rng() < 0.5 ? 'oak' : 'sycamore', y.x, y.z, 1.1);
            const [bx, bz] = at(i, side, 84, 20);
            if (fits(bx, bz, fr, 12, 16, 60) && free(bx, bz, 9)) {
              placed.push([bx, bz, 9]);
              add('barn', { x: bx, z: bz, r: fr + (rng() - 0.5) * 0.3 });
            }
            if (rng() < 0.6) add('tractor', { x: hx + 9, z: hz - 6, r: rng() * 6 });
          }
        }
        a += len + 2;
      }
    }
    // a ranch fence along the farm road; power poles and wires on one side
    const fstep = Math.max(1, Math.round(8 / track.sp)); // (8 m panels)
    for (let i = 0; i < track.N; i += fstep) {
      if (zone(track.D[i]) !== 'farm') continue;
      for (const side of [1, -1]) {
        const [x, z] = at(i, side, 4.2);
        if (lat(x, z) > 3.5 && (side > 0 || i % (fstep * 6) >= fstep)) add('ranchfence', { x, z, r: track.H[i] + Math.PI / 2, sv: [(fstep * track.sp) / 4.05, 1, 1] });
      }
    }
    let prev = null;
    for (let i = 0; i < track.N; i += 22) {
      if (zone(track.D[i]) !== 'farm') {
        prev = null;
        continue;
      }
      const [x, z] = at(i, -1, 3.2);
      if (lat(x, z) < 1) {
        prev = null;
        continue;
      }
      const r = track.H[i] + Math.PI / 2;
      if (XG && track.nearRail(x, z, 3)) continue; // (the wires carry on over the tractor's lane)
      add('pole', { x, z, r });
      const y = gy(x, z) + 10.45, cur = [];
      for (const o of [-1.1, 0, 1.1]) {
        const p = rotPt(x, z, r, o, 0);
        cur.push([p[0], y, p[1]]);
      }
      if (prev) for (let k = 0; k < 3; k++) {
        const a2 = prev[k], c = cur[k], m = [(a2[0] + c[0]) / 2, (a2[1] + c[1]) / 2 - 0.7, (a2[2] + c[2]) / 2];
        wgb.beam(a2, m, 0.04, 0.04, C(0x2a2d33));
        wgb.beam(m, c, 0.04, 0.04, C(0x2a2d33));
      }
      prev = cur;
    }
    yield 'valley farms';
    resume();
    // 4. oaks: clumps in the gaps and on the rising ground, thickening into
    //    woods on the hills beyond the valley floor (gold grass, dark oaks)
    for (let k = 0; k < 340 * detail; k++) {
      const x = U.lerp(b.x0 - 420, b.x1 + 420, rng()), z = U.lerp(b.z0 - 280, b.z1 + 280, rng());
      const d = lat(x, z);
      if (d < 10 || !free(x, z, 4)) continue;
      track.query(x, z, -1, q);
      const zn = zone(q.along);
      if (zn !== 'farm' && d < 75) continue;
      if (zn === 'farm' && d < 60 && rng() < 0.8) continue; // (the valley floor is farmed)
      const n = 1 + Math.floor(rng() * 3), far = d > 110;
      for (let c = 0; c < n; c++) add(far ? 'oakF' : 'oak', { x: x + (rng() - 0.5) * 14, z: z + (rng() - 0.5) * 14, r: rng() * 6.28, s: 0.8 + rng() * 0.6, t: 0.85 + rng() * 0.25 });
    }
    // 5. landmarks: the civic hall and the giant garlic at the start, a
    //    fruit stand, a water tower, the town signs (made-up towns), and the
    //    peak over the finish
    const spot = (along, side, off) => {
      const i = track.idx(Math.round(along / track.sp));
      return [...at(i, side, off), face(i, side), i];
    };
    {
      const [x, z, r] = spot(115, 1, 17);
      if (fits(x, z, r, 22, 16, 1) && free(x, z, 11)) add('oldhall', { x, z, r });
      const [gx, gz] = spot(30, -1, 5);
      add('garlic', { x: gx, z: gz, r: 0, s: 1.1 });
      const [fx, fz, fr] = spot(1160, 1, 7);
      if (lat(fx, fz) > 2) add('farmstand', { x: fx, z: fz, r: fr });
      const [wx, wz] = spot(1300, -1, 40);
      if (lat(wx, wz) > 4 && free(wx, wz, 5)) add('watertower', { x: wx, z: wz });
      for (const [a, s, word] of [[60, -1, 'CLOVEHAVEN'], [1700, -1, 'OAK VALLEY']]) {
        const [sx, sz, , si] = spot(a, s, 1.6);
        const r2 = track.H[si] + Math.PI;
        add('citysign', { x: sx, z: sz, r: r2 });
        const u = rotPt(0, 0, r2, 1, 0), f = rotPt(0, 0, r2, 0, 1), y = gy(sx, sz) + 2.4;
        pixText(txt, word, [sx + f[0] * 0.04, y + 0.2, sz + f[1] * 0.04], [u[0], 0, u[1]], [0, 1, 0], word.length > 7 ? 0.05 : 0.07, C(0xffffff), [f[0], 0, f[1]]);
        pixText(txt, 'CITY LIMIT', [sx + f[0] * 0.04, y - 0.35, sz + f[1] * 0.04], [u[0], 0, u[1]], [0, 1, 0], 0.035, C(0xffffff), [f[0], 0, f[1]]);
      }
    }
    worldMesh(group, soil, null, 'fields');
    worldMesh(group, hg, null, 'valleyBuildings', true);
    worldMesh(group, wgb, null, 'wires');
    worldMesh(group, txt, null, 'signText');
    // the peak over the finish: oak woods up its sides, gold grass on top
    {
      const ex = -650, ez = b.z1 - 250, base = gy(ex + 400, ez), n = 30, rings = 10;
      const pos = [], col = [];
      const gold = C(0xc2a462), green = C(0x7e9a4a), oakc = C(0x3f5a2c), tmpc = new THREE.Color();
      const hAt = (k, j) => {
        const f = j / rings, a = (k / n) * Math.PI * 2;
        const R = 460 * (1 - f) + 12, h = 330 * Math.pow(f, 0.8) * (1 + 0.06 * Math.sin(a * 3 + j));
        return [ex + Math.cos(a) * R * (1 + 0.08 * Math.sin(a * 5)), base - 6 + h, ez + Math.sin(a) * R];
      };
      for (let j = 0; j < rings; j++) {
        for (let k = 0; k < n; k++) {
          const A = hAt(k, j), B = hAt(k + 1, j), Cc = hAt(k + 1, j + 1), D = hAt(k, j + 1);
          const noise = ((k * 13 + j * 7) % 9) / 9;
          tmpc.copy(j >= rings - 2 ? gold : noise < 0.6 ? oakc : noise < 0.82 ? green : gold).multiplyScalar(0.86 + ((k * 7 + j * 3) % 5) * 0.04);
          for (const tri of [[A, B, Cc], [A, Cc, D]]) {
            for (const v of tri) pos.push(v[0], v[1], v[2]);
            for (let v = 0; v < 3; v++) col.push(tmpc.r, tmpc.g, tmpc.b);
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      m.name = 'thePeak';
      group.add(m);
    }
    yield 'valley landmarks';
    resume();
    const flatK = ['garlicrow', 'croprow', 'mailbox', 'fenceW', 'vinerow', 'vinerowR', 'succulent', 'hedge', 'ranchfence', 'bench', 'picnic', 'pots', 'cornrow'];
    // (each kind in 400 m chunks along the valley, so the chase camera's
    // frustum can skip most of a 2.7 km sprint's scenery, and its shadows)
    for (const k in P) {
      const ch = {};
      for (const it of P[k]) (ch[Math.floor(it.z / 400)] || (ch[Math.floor(it.z / 400)] = [])).push(it);
      for (const c in ch) instanced(k, ch[c], group, !flatK.includes(k));
    }
    const lamps = [];
    for (let i = 0; i < track.N; i += 9) {
      const zn = zone(track.D[i]);
      if (zn !== 'dtg' && zn !== 'dtm') continue;
      for (const side of [1, -1]) {
        const [x, z] = at(i, side, 1.2);
        if (lat(x, z) > 0.5) lamps.push({ x, z, r: face(i, side) + Math.PI });
      }
    }
    instanced('lamp', lamps, group, true);
    yield 'valley';
    resume();
  }
  const SCENES = { store: sceneStore, deadcity: sceneCity, suburb: sceneSuburb };

  G.TrackMesh = { build, steps };
})(window.G);
