// trackbuild.js — turns a hand-laid definition into a queryable track.
// Pure data (no Three.js): used by the authoritative host simulation, the
// client's own-car prediction, bots, the minimap and the mesh builder.
'use strict';
(function (G) {
  const U = G.U;

  // Surface table. grip = friction multiplier, rr = rolling resistance coeff,
  // rough = bump amplitude (hurts stiff suspension), wet = 1 for standing water.
  const SURF = [
    { id: 'tarmac', name: 'Tarmac', grip: 1.0, rr: 0.012, rough: 0.0, wet: 0, loose: 0, fx: 'smoke' },
    { id: 'dirt', name: 'Dirt', grip: 0.74, rr: 0.03, rough: 0.35, wet: 0, loose: 1, fx: 'dust' },
    { id: 'wet', name: 'Wet', grip: 0.66, rr: 0.016, rough: 0.05, wet: 1, loose: 0, fx: 'spray' },
    { id: 'gravel', name: 'Gravel', grip: 0.63, rr: 0.05, rough: 0.55, wet: 0, loose: 1, fx: 'dust' },
    { id: 'kerb', name: 'Kerb', grip: 0.9, rr: 0.02, rough: 1.0, wet: 0, loose: 0, fx: 'smoke' },
    // Run-off is slow but not a trap: at grip 0.50 / rr 0.16 a keyboard driver
    // who ran wide at full throttle got stuck in wheelspin donuts (16 respawns
    // on Copper Canyon in 2 minutes). These values cut that to 0 while normal
    // lap times moved < 1 s — mistakes cost time, not the race.
    { id: 'grass', name: 'Grass', grip: 0.6, rr: 0.07, rough: 0.3, wet: 0, loose: 1, fx: 'grass' },
    { id: 'sand', name: 'Sand', grip: 0.56, rr: 0.11, rough: 0.4, wet: 0, loose: 1, fx: 'dust' },
    { id: 'concrete', name: 'Concrete', grip: 0.86, rr: 0.015, rough: 0.1, wet: 0, loose: 0, fx: 'smoke' },
    // Hazard patches (v4): laid on the road by a track's `hazards` list.
    // Oil: almost no grip for a moment — lift and keep it straight.
    { id: 'oil', name: 'Oil', grip: 0.34, rr: 0.012, rough: 0.0, wet: 0, loose: 0, fx: 'oil' },
    // Mud: slow and draggy, rally tyres and trucks cope best.
    { id: 'mud', name: 'Mud', grip: 0.55, rr: 0.15, rough: 0.5, wet: 0, loose: 1, fx: 'mud' },
    // Ice: glassy. Narrow tyres help (uses the WET multiplier), wide ones hurt.
    { id: 'ice', name: 'Ice', grip: 0.44, rr: 0.01, rough: 0.0, wet: 0, icy: 1, loose: 0, fx: 'ice' },
  ];
  const SI = {};
  SURF.forEach((s, i) => {
    s.code = i;
    SI[s.id] = i;
  });

  const SPACING = 2; // metres between resampled centreline samples

  // Replace polygon corners that carry a radius with circular arcs.
  function expandCorners(def, closed) {
    let cur = { w: 7, s: 'tarmac', kerb: 0, bank: 0, y: 0 };
    const V = def.pts.map((p) => {
      const a = p[2] || {};
      const { r, ...rest } = a;
      cur = Object.assign({}, cur, rest);
      return { x: p[0], z: p[1], r: r || 0, w: cur.w, s: cur.s, kerb: cur.kerb, bank: cur.bank, y: cur.y };
    });
    const n = V.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = V[i];
      const corner = v.r > 0 && (closed || (i > 0 && i < n - 1));
      if (!corner) {
        out.push(v);
        continue;
      }
      const A = V[(i - 1 + n) % n];
      const B = V[(i + 1) % n];
      let d1x = v.x - A.x, d1z = v.z - A.z;
      let d2x = B.x - v.x, d2z = B.z - v.z;
      const l1 = Math.hypot(d1x, d1z), l2 = Math.hypot(d2x, d2z);
      d1x /= l1; d1z /= l1; d2x /= l2; d2z /= l2;
      const cross = d1x * d2z - d1z * d2x;
      const dot = d1x * d2x + d1z * d2z;
      const theta = Math.atan2(Math.abs(cross), dot); // turn angle
      if (theta < 0.03) {
        out.push(v);
        continue;
      }
      let r = v.r;
      let t = r * Math.tan(theta / 2);
      const tmax = 0.5 * Math.min(l1, l2);
      if (t > tmax) {
        t = tmax;
        r = t / Math.tan(theta / 2);
      }
      const Sx = v.x - d1x * t, Sz = v.z - d1z * t;
      const Ex = v.x + d2x * t, Ez = v.z + d2z * t;
      // left normal of d1 in our convention (forward=(sin h,cos h), left=(cos h,-sin h)) is (dz,-dx)
      const side = cross < 0 ? 1 : -1; // cross<0 => left turn => centre on the left
      const Cx = Sx + d1z * r * side, Cz = Sz - d1x * r * side;
      const a0 = Math.atan2(Sz - Cz, Sx - Cx);
      const a1 = Math.atan2(Ez - Cz, Ex - Cx);
      const da = U.wrapAngle(a1 - a0);
      const K = Math.max(2, Math.ceil(theta / (12 * Math.PI / 180)));
      for (let k = 0; k <= K; k++) {
        const a = a0 + (da * k) / K;
        out.push({ x: Cx + Math.cos(a) * r, z: Cz + Math.sin(a) * r, w: v.w, s: v.s, kerb: v.kerb, bank: v.bank, y: v.y });
      }
    }
    return out;
  }

  // Centripetal Catmull-Rom (alpha = 0.5) — no cusps or self-loops on uneven spacing.
  function crPoint(p0, p1, p2, p3, t) {
    const al = 0.5;
    const tj = (a, b) => Math.pow(Math.hypot(b.x - a.x, b.z - a.z), al) || 1e-4;
    const t0 = 0, t1 = t0 + tj(p0, p1), t2 = t1 + tj(p1, p2), t3 = t2 + tj(p2, p3);
    const u = t1 + (t2 - t1) * t;
    const L = (a, b, ta, tb) => {
      const k = (u - ta) / (tb - ta);
      return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
    };
    const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
    const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
    return L(B1, B2, t1, t2);
  }

  class Track {
    constructor(def) {
      this.def = def;
      this.id = def.id;
      this.name = def.name;
      this.format = def.format; // 'circuit' | 'sprint' | 'drag'
      this.closed = def.format === 'circuit';
      this.laps = this.closed ? def.laps || 3 : 1;
      this.theme = G.TrackDefs.THEMES[def.theme];
      this.runoff = def.runoff;
      this.runoffSurf = SI[this.theme.runoff] != null ? SI[this.theme.runoff] : SI.grass;
      this._build();
    }

    _build() {
      const def = this.def;
      const P = expandCorners(def, this.closed);
      const n = P.length;
      const get = (i) => {
        if (this.closed) return P[((i % n) + n) % n];
        if (i < 0) return { x: 2 * P[0].x - P[1].x, z: 2 * P[0].z - P[1].z };
        if (i >= n) return { x: 2 * P[n - 1].x - P[n - 2].x, z: 2 * P[n - 1].z - P[n - 2].z };
        return P[i];
      };
      // 1. Dense sampling of the spline (~0.5 m), carrying per-point attributes.
      const segs = this.closed ? n : n - 1;
      const dense = [];
      for (let i = 0; i < segs; i++) {
        const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
        const len = Math.hypot(p2.x - p1.x, p2.z - p1.z);
        const m = Math.max(2, Math.ceil(len / 0.5));
        for (let k = 0; k < m; k++) {
          const t = k / m;
          const q = crPoint(p0, p1, p2, p3, t);
          const a = P[i], b = P[(i + 1) % n];
          dense.push({ x: q.x, z: q.z, w: U.lerp(a.w, b.w, t), bank: U.lerp(a.bank, b.bank, t), y: U.lerp(a.y, b.y, t), s: a.s, kerb: a.kerb });
        }
      }
      if (!this.closed) dense.push(Object.assign({}, P[n - 1]));
      // 2. Arc length + uniform resample every SPACING metres.
      const cum = [0];
      for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].z - dense[i - 1].z));
      let total = cum[cum.length - 1];
      if (this.closed) total += Math.hypot(dense[0].x - dense[dense.length - 1].x, dense[0].z - dense[dense.length - 1].z);
      const N = this.closed ? Math.round(total / SPACING) : Math.floor(total / SPACING) + 1;
      const sp = this.closed ? total / N : SPACING;
      this.N = N;
      this.sp = sp;
      this.length = this.closed ? total : (N - 1) * sp;
      const X = new Float32Array(N), Z = new Float32Array(N), W = new Float32Array(N), BKm = new Float32Array(N), Yr = new Float32Array(N);
      const S = new Uint8Array(N), KA = new Uint8Array(N);
      let j = 0;
      for (let i = 0; i < N; i++) {
        const d = i * sp;
        while (j < dense.length - 1 && cum[j + 1] < d) j++;
        const a = dense[j];
        const b = j + 1 < dense.length ? dense[j + 1] : dense[0];
        const segLen = (j + 1 < dense.length ? cum[j + 1] : total) - cum[j];
        const t = segLen > 0 ? U.clamp((d - cum[j]) / segLen, 0, 1) : 0;
        X[i] = U.lerp(a.x, b.x, t);
        Z[i] = U.lerp(a.z, b.z, t);
        W[i] = U.lerp(a.w, b.w, t);
        BKm[i] = U.lerp(a.bank, b.bank, t);
        Yr[i] = U.lerp(a.y || 0, b.y || 0, t);
        S[i] = SI[a.s];
        KA[i] = a.kerb ? 1 : 0;
      }
      // 3. Tangents, left normals, heading, curvature.
      const TX = new Float32Array(N), TZ = new Float32Array(N), NX = new Float32Array(N), NZ = new Float32Array(N);
      const H = new Float32Array(N), K = new Float32Array(N), D = new Float32Array(N);
      const idx = (i) => (this.closed ? ((i % N) + N) % N : U.clamp(i, 0, N - 1));
      for (let i = 0; i < N; i++) {
        const a = idx(i - 1), b = idx(i + 1);
        let tx = X[b] - X[a], tz = Z[b] - Z[a];
        const l = Math.hypot(tx, tz) || 1;
        tx /= l; tz /= l;
        TX[i] = tx; TZ[i] = tz;
        NX[i] = tz; NZ[i] = -tx; // left normal
        H[i] = Math.atan2(tx, tz);
        D[i] = i * sp;
      }
      const Kraw = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const a = idx(i - 2), b = idx(i + 2);
        const span = (this.closed ? 4 : Math.max(1, b - a)) * sp;
        Kraw[i] = U.wrapAngle(H[b] - H[a]) / span; // + = turning left
      }
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let k = -3; k <= 3; k++) s += Kraw[idx(i + k)];
        K[i] = s / 7;
      }
      // 4. Banking: max bank from the definition, applied in proportion to curvature,
      //    signed so the OUTSIDE of the corner is raised. bk > 0 => right side high.
      const BK = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const amt = U.clamp(Math.abs(K[i]) * 60, 0, 1);
        BK[i] = Math.sign(K[i]) * BKm[i] * amt * (Math.PI / 180);
      }
      // 5. Kerbs on tight tarmac corners (both sides), dilated a little.
      const KL = new Uint8Array(N), KR = new Uint8Array(N);
      const kraw = new Uint8Array(N);
      for (let i = 0; i < N; i++) kraw[i] = KA[i] && Math.abs(K[i]) > 1 / 65 && S[i] === SI.tarmac ? 1 : 0;
      for (let i = 0; i < N; i++) {
        let on = 0;
        for (let k = -4; k <= 4; k++) if (kraw[idx(i + k)]) on = 1;
        KL[i] = on; KR[i] = on;
      }
      // 5b. Elevation (v4). Vertices may carry `y` (metres); the profile is
      //     smoothed twice over ±24 m so crests and dips are gentle vertical
      //     curves, then its slope GR (rise per metre) feeds gravity in
      //     physics.js §8. Flat tracks keep Y = 0 and GR = null (zero cost).
      const Y = new Float32Array(N);
      let GR = null;
      if (Yr.some((v) => v !== 0)) {
        let a = Yr, bb = new Float32Array(N);
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i < N; i++) {
            let s = 0, n = 0;
            for (let k = -12; k <= 12; k++) {
              const j = i + k;
              if (!this.closed && (j < 0 || j >= N)) continue;
              s += a[idx(j)];
              n++;
            }
            bb[i] = s / n;
          }
          [a, bb] = [bb, a];
        }
        Y.set(a);
        GR = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          const ia = idx(i - 1), ib = idx(i + 1);
          const span = (this.closed ? 2 : Math.max(1, ib - ia)) * sp;
          GR[i] = (Y[ib] - Y[ia]) / span;
        }
      }
      Object.assign(this, { X, Z, W, S, TX, TZ, NX, NZ, H, K, D, BK, KL, KR, Y, GR });
      this.wallD = new Float32Array(N);
      for (let i = 0; i < N; i++) this.wallD[i] = W[i] + this.runoff;
      this._hazards();

      // 6. Start / finish.
      if (this.closed) {
        this.startDist = 0;
        this.finishDist = this.length; // per lap
      } else {
        this.startDist = this.def.startAt || 40;
        this.finishDist = this.def.dragLength ? this.startDist + this.def.dragLength : this.length - (this.def.finishBack || 40);
      }
      this.raceDistance = this.closed ? this.length * this.laps : this.finishDist - this.startDist;

      // bounds
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (let i = 0; i < N; i++) {
        x0 = Math.min(x0, X[i]); x1 = Math.max(x1, X[i]);
        z0 = Math.min(z0, Z[i]); z1 = Math.max(z1, Z[i]);
      }
      this.bounds = { x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
      this._validate();
    }

    // Warn (console) if two non-adjacent parts of the track come close enough for
    // their walls/run-off to overlap — that would confuse the nearest-point query.
    _validate() {
      const N = this.N;
      let worst = 1e9, wi = -1, wj = -1;
      for (let i = 0; i < N; i += 2) {
        for (let j = i + 2; j < N; j += 2) {
          let sep = (j - i) * this.sp;
          if (this.closed) sep = Math.min(sep, this.length - sep);
          const need = this.wallD[i] + this.wallD[j];
          if (sep < need * 3.2) continue;
          const d = Math.hypot(this.X[i] - this.X[j], this.Z[i] - this.Z[j]);
          const ratio = d / need;
          if (ratio < worst) {
            worst = ratio; wi = i; wj = j;
          }
        }
      }
      this.clearance = worst;
      if (worst < 1.02) console.warn(`[track ${this.id}] sections too close: ratio ${worst.toFixed(2)} at samples ${wi}/${wj}`, this.X[wi], this.Z[wi]);
    }

    // Hazards (v4). def.hazards: [{k, at, lat, len, hw, r}] with `at` = metres
    // along the centreline, `lat` = offset (+ = left), `len` along × `hw`
    // half-width across. Kinds:
    //   'oil' | 'mud' | 'ice'   elliptical surface patch (per-wheel grip — see SURF)
    //   'boost'                  speed pad: a forward kick (physics.js §5b)
    //   'barrels' | 'tyres' | 'rock'  solid obstacle of radius r (physics collideWalls)
    // Everything is indexed per centreline sample so a lookup is O(1).
    _hazards() {
      const N = this.N, sp = this.sp;
      this.patches = [];
      this.pads = [];
      this.obs = [];
      this.PT = null;
      this.PD = null;
      this.OBL = null;
      const list = this.def.hazards || [];
      if (!list.length) return;
      this.PT = new Int16Array(N).fill(-1);
      this.PD = new Int16Array(N).fill(-1);
      const mark = (arr, ic, hl, id) => {
        const n = Math.ceil(hl / sp);
        for (let k = -n; k <= n; k++) {
          const j = ic + k;
          if (!this.closed && (j < 0 || j >= N)) continue;
          arr[this.idx(j)] = id;
        }
      };
      for (const h of list) {
        // placed by distance along (`at`) or by a world position {x, z} near
        // the road (snapped to the nearest centreline sample; lat is added on)
        let at = h.at || 0, lat = h.lat || 0;
        if (h.x != null) {
          const q = this.query(h.x, h.z, -1, {});
          at = q.along + (h.along || 0);
          lat += q.lat;
        }
        const ic = this.idx(Math.round(at / sp));
        at = this.D[ic];
        if (h.k === 'oil' || h.k === 'mud' || h.k === 'ice') {
          const P = { k: h.k, ic, at, lat, hl: (h.len || 10) / 2, hw: h.hw || 2.5, surf: SI[h.k] };
          mark(this.PT, ic, P.hl, this.patches.length);
          this.patches.push(P);
        } else if (h.k === 'boost') {
          const P = { ic, at, lat, hl: (h.len || 6) / 2, hw: h.hw || 1.8, dv: h.dv || 7, vmax: h.vmax || 68 };
          mark(this.PD, ic, P.hl, this.pads.length);
          this.pads.push(P);
        } else {
          const o = { k: h.k, i: ic, at, lat, r: h.r || 0.9, x: this.X[ic] + this.NX[ic] * lat, z: this.Z[ic] + this.NZ[ic] * lat };
          this.obs.push(o);
        }
      }
      if (this.obs.length) {
        // obstacles within ±12 samples (24 m) of each sample
        this.OBL = new Array(N).fill(null);
        for (const o of this.obs) {
          for (let k = -12; k <= 12; k++) {
            const j = o.i + k;
            if (!this.closed && (j < 0 || j >= N)) continue;
            const jj = this.idx(j);
            (this.OBL[jj] || (this.OBL[jj] = [])).push(o);
          }
        }
      }
    }

    // Speed pad under (sample i, lateral lat), or null.
    padAt(i, lat) {
      if (!this.PD) return null;
      const id = this.PD[i];
      if (id < 0) return null;
      const P = this.pads[id];
      let da = (i - P.ic) * this.sp;
      if (this.closed && Math.abs(da) > this.length / 2) da -= Math.sign(da) * this.length;
      return Math.abs(da) <= P.hl && Math.abs(lat - P.lat) <= P.hw ? P : null;
    }

    idx(i) {
      return this.closed ? ((i % this.N) + this.N) % this.N : U.clamp(i, 0, this.N - 1);
    }

    // Nearest-centreline query. `hint` is the sample index found last time for this
    // car (or -1). A local window search keeps this O(1); we fall back to a full
    // scan if the answer lands on the window edge (car teleported / respawned).
    query(x, z, hint, out) {
      const N = this.N, X = this.X, Z = this.Z;
      let best = -1, bd = Infinity;
      const R = 10;
      let edge = true;
      if (hint >= 0 && hint < N) {
        edge = false;
        for (let k = -R; k <= R; k++) {
          const i = this.closed ? (hint + k + N) % N : hint + k;
          if (i < 0 || i >= N) continue;
          const dx = x - X[i], dz = z - Z[i];
          const d = dx * dx + dz * dz;
          if (d < bd) {
            bd = d; best = i;
            edge = (k === -R || k === R);
          }
        }
      }
      if (edge || bd > 3600) {
        bd = Infinity;
        for (let i = 0; i < N; i++) {
          const dx = x - X[i], dz = z - Z[i];
          const d = dx * dx + dz * dz;
          if (d < bd) {
            bd = d; best = i;
          }
        }
      }
      const i = best;
      const dx = x - X[i], dz = z - Z[i];
      const da = dx * this.TX[i] + dz * this.TZ[i];
      const lat = dx * this.NX[i] + dz * this.NZ[i];
      let along = this.D[i] + da;
      if (this.closed) along = ((along % this.length) + this.length) % this.length;
      out.i = i;
      out.along = along;
      out.lat = lat;
      out.hw = this.W[i];
      out.bank = this.BK[i];
      out.tx = this.TX[i]; out.tz = this.TZ[i];
      out.nx = this.NX[i]; out.nz = this.NZ[i];
      out.wall = this.wallD[i];
      out.surf = this.surfaceAt(i, lat);
      out.gr = this.GR ? this.GR[i] : 0;
      return out;
    }

    surfaceAt(i, lat) {
      const hw = this.W[i];
      const al = Math.abs(lat);
      if (this.PT) {
        const id = this.PT[i];
        if (id >= 0) {
          const P = this.patches[id];
          let da = (i - P.ic) * this.sp;
          if (this.closed && Math.abs(da) > this.length / 2) da -= Math.sign(da) * this.length;
          const u = da / P.hl, v = (lat - P.lat) / P.hw;
          if (u * u + v * v <= 1) return P.surf;
        }
      }
      const kerb = lat > 0 ? this.KL[i] : this.KR[i];
      if (al <= hw) {
        if (kerb && al > hw - 1.1) return SI.kerb;
        return this.S[i];
      }
      if (kerb && al < hw + 0.9) return SI.kerb;
      return this.runoffSurf;
    }

    // Banking's share of the ground height at a lateral offset (the outside
    // of a banked corner is raised).
    bankH(i, lat) {
      const bk = this.BK[i];
      if (Math.abs(bk) < 1e-4) return 0;
      const hw = this.W[i];
      const tb = Math.tan(Math.abs(bk));
      const outer = bk > 0 ? -lat : lat; // + toward the raised side
      if (Math.abs(lat) <= hw) return tb * (hw + outer);
      if (outer > 0) return 2 * hw * tb * Math.max(0, 1 - (Math.abs(lat) - hw) / 8);
      return 0;
    }

    // Visual height of the ground at a sample + lateral offset: elevation plus banking.
    heightAt(i, lat) {
      return this.Y[i] + this.bankH(i, lat);
    }

    // Elevation interpolated between samples (for smooth car placement: whole
    // samples would step 16 cm at a time on an 8% grade).
    elevAlong(along) {
      if (!this.GR) return 0;
      let d = along;
      if (this.closed) d = ((d % this.length) + this.length) % this.length;
      else d = U.clamp(d, 0, this.length);
      const f = d / this.sp;
      const i = Math.floor(f);
      return U.lerp(this.Y[this.idx(i)], this.Y[this.idx(i + 1)], f - i);
    }

    // Ground height under a query result (see query()).
    groundY(q) {
      return this.elevAlong(q.along) + this.bankH(q.i, q.lat);
    }

    // World position + heading of a point `dist` metres along the centreline, offset `lat`.
    pointAt(dist, lat) {
      let d = dist;
      if (this.closed) d = ((d % this.length) + this.length) % this.length;
      else d = U.clamp(d, 0, this.length);
      const f = d / this.sp;
      const i = Math.floor(f), t = f - i;
      const a = this.idx(i), b = this.idx(i + 1);
      const x = U.lerp(this.X[a], this.X[b], t) + this.NX[a] * lat;
      const z = U.lerp(this.Z[a], this.Z[b], t) + this.NZ[a] * lat;
      return { x, z, h: Math.atan2(this.TX[a], this.TZ[a]), i: a };
    }

    // Grid slots: pole first. Circuits/sprints use a staggered 2-wide grid behind
    // the line; drags line all cars up abreast.
    gridSlot(k) {
      if (this.format === 'drag') {
        return this.pointAt(this.startDist - 3.5, (3.5 - k) * 3.6);
      }
      const row = Math.floor(k / 2), col = k % 2;
      const back = 6 + row * 9 + col * 4.5;
      return this.pointAt(this.startDist - back, col === 0 ? 2.4 : -2.4);
    }
  }

  G.SURF = SURF;
  G.SI = SI;
  G.Track = Track;
  G.trackCache = {};
  G.getTrack = (id) => G.trackCache[id] || (G.trackCache[id] = new Track(G.TrackDefs.byId(id)));
})(window.G);
