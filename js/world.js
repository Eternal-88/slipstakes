// world.js — renderer, lights, sky, camera rig, car models, particle/skid
// emission, start lights, rain, and an adaptive quality governor aimed at
// 60 fps on integrated graphics. Reads G.Settings live (no reload needed
// except for antialiasing).
'use strict';
(function (G) {
  const U = G.U;
  const ST = () => G.Settings.s;

  // Rough GPU tier from the WebGL renderer string, probed on a throwaway
  // context BEFORE the real renderer exists (antialiasing can't be changed
  // later). Integrated / mobile GPUs — every Chromebook — start at "medium".
  function gpuTier() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl');
      if (!gl) return { name: 'none', low: true };
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      const name = d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : '';
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      const weakGpu = /intel|uhd|iris|mali|adreno|powervr|swiftshader|llvmpipe|videocore|microsoft basic/i.test(name);
      const weakBox = (navigator.deviceMemory && navigator.deviceMemory <= 4) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
      return { name, low: weakGpu || !!weakBox };
    } catch (e) {
      return { name: 'unknown', low: true };
    }
  }

  // Camera presets: [distance at rest, extra distance per m/s, pitch°, lookahead]
  // [distance, extra distance per m/s, pitch in degrees above the car, how
  // far the focus leads the car along its velocity]. A LOWER pitch sits the
  // camera nearer the road, which shows more of what is coming and less of
  // the bodywork - that is the whole point of `low`.
  const CAMS = {
    follow: [31, 0.28, 56, 0.42],
    near: [21, 0.19, 49, 0.34],
    low: [17, 0.14, 14, 0.62], // v5.3: close and down near the road, so you see over the car into the corner
    far: [43, 0.3, 61, 0.46],
    fixed: [33, 0.28, 58, 0.42],
    tv: [43, 0.3, 61, 0.46], // v5: trackside TV cameras (see _tvCam)
  };
  const CAM_ORDER = ['follow', 'near', 'low', 'far', 'fixed', 'tv'];
  const CAM_NAMES = { follow: 'Chase', near: 'Close chase', low: 'Low chase', far: 'High chase', fixed: 'Fixed north', tv: 'TV cameras' };
  // Particle colours emitted every frame, made once (v4.5: a new array per
  // particle was needless garbage for the collector)
  const RGB = { head: [1, 0.93, 0.75], sand: [0.85, 0.72, 0.5], dirt: [0.52, 0.36, 0.22], mud: [0.3, 0.2, 0.1], nos: [0.25, 0.5, 1], nosSpark: [0.3, 0.8, 1], pad: [0.2, 0.7, 1], smoke: [0.22, 0.22, 0.24], tail: [1, 0.1, 0.05] };

  // v5 time of day. A theme's own light is "day"; races on themes with todTo
  // slide through dusk toward night as the leader goes round, night themes
  // sit at night. Rain greys the sky and fog and dims the sun.
  const TOD = {
    dusk: { sky: 0xe98a62, fog: 0xe2a184, hemiSky: 0xffc6a8, hemiI: 1.25, sunCol: 0xff9a52, sunI: 1.55 },
    night: { sky: 0x0b1030, fog: 0x161c38, hemiSky: 0x6674b0, hemiI: 1.0, sunCol: 0xa9bcff, sunI: 0.45 },
  };

  const rgbOf = (hex) => {
    const c = new THREE.Color(hex);
    return [c.r, c.g, c.b];
  };

  class World {
    constructor(canvas) {
      this.canvas = canvas;
      const s = ST();
      this.quality = s.quality;
      this.gpu = gpuTier();
      const q = this.quality === 'auto' ? (this.gpu.low ? 'medium' : 'high') : this.quality;
      this.tier = q;
      // MSAA only on "high": 4x multisampling at 1366x768 is one of the most
      // expensive things an integrated GPU can do, and flat-shaded low-poly
      // edges survive without it. (Needs a reload to change.)
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q === 'high', powerPreference: 'high-performance', stencil: false });
      this.renderer.shadowMap.enabled = true;
      // Soft PCF is the single most expensive thing we draw (shadows = half the
      // GPU frame on the test machine); plain PCF on anything but "high".
      this.renderer.shadowMap.type = q === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
      this.scene = new THREE.Scene();
      // near plane 3 m (the closest camera — the paint showroom — is ~9 m
      // away): 50% more depth precision than 2 m, less distant flicker
      this.camera = new THREE.PerspectiveCamera(40, 1, 3, 1400);
      this.hemi = new THREE.HemisphereLight(0xe6f4ff, 0x7a8f5a, 1.6);
      this.sun = new THREE.DirectionalLight(0xfff1d8, 2.3);
      this.sun.castShadow = true;
      const sc = this.sun.shadow.camera;
      sc.left = -46; sc.right = 46; sc.top = 46; sc.bottom = -46; sc.near = 5; sc.far = 240;
      const ms = q === 'high' ? 2048 : q === 'medium' ? 1024 : 512;
      this.sun.shadow.mapSize.set(ms, ms);
      this.sun.shadow.bias = -0.0005;
      this.sun.shadow.normalBias = 0.05;
      this.scene.add(this.hemi, this.sun, this.sun.target);
      this.sky = this._makeSky();
      this.scene.add(this.sky);
      // v5 race environment as the view last saw it (setEnv): race time drives
      // the moving hazards, tod/wet the light
      this.env = { t: 0, wet: 0, tod: 0, night: 0 };
      this._atmKey = '';
      this.fx = new G.FX.System(this.scene);
      this.skids = new G.FX.Skids(this.scene);
      this.rain = new G.FX.Rain(this.scene, q === 'high' ? 900 : q === 'medium' ? 550 : 300);
      this.models = new Map();
      this.cam = { yaw: 0, fx: 0, fz: 0, dist: 38, shake: 0, mode: CAMS[s.cam] ? s.cam : 'follow', freeYaw: 0, freeDist: 60, fov: 40 };
      this.q = {};
      this.time = 0;
      this.fpsT = 0; this.fpsN = 0; this.fps = 60; this.slowT = 0; this.level = 0;
      this.frameMs = 0;
      this.lightsState = -1;
      window.addEventListener('resize', () => this.resize());
      canvas.addEventListener('wheel', (e) => {
        this.cam.freeDist = U.clamp(this.cam.freeDist * (e.deltaY > 0 ? 1.1 : 0.9), 20, 220);
      }, { passive: true });
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      G.Settings.on((k) => this.applySettings(k));
      this.applySettings();
    }

    // Everything that can change live. (Antialiasing can't: needs a reload.)
    applySettings(k) {
      const s = ST();
      if (k === 'quality') {
        this.quality = s.quality;
        const q = s.quality === 'auto' ? (this.gpu.low ? 'medium' : 'high') : s.quality;
        this.tier = q;
        this.level = 0;
        this.renderer.shadowMap.type = q === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
        const ms = q === 'high' ? 2048 : q === 'medium' ? 1024 : 512;
        if (this.sun.shadow.map) {
          this.sun.shadow.map.dispose();
          this.sun.shadow.map = null;
        }
        this.sun.shadow.mapSize.set(ms, ms);
        this.renderer.shadowMap.needsUpdate = true;
        if (this.trackGroup) this._trackShadows();
      }
      if (k === 'cam' && CAMS[s.cam]) this.cam.mode = s.cam;
      this.maxPR = this.tier === 'high' ? Math.min(window.devicePixelRatio || 1, 1.5) : this.tier === 'medium' ? 1 : 0.75;
      this._applyLevel();
      if (k === 'weather' || k == null) this._rainOn();
    }

    // Pixel ratio / shadows / particle budget from tier × governor × settings.
    _applyLevel() {
      const s = ST();
      const L = this.level;
      const pr = [this.maxPR, Math.min(this.maxPR, 1), 0.85, 0.75, 0.65, 0.55][L] * (s.resScale / 100);
      this.pr = Math.max(0.4, pr);
      this.renderer.setPixelRatio(this.pr);
      this.resize();
      this.sun.castShadow = s.shadows && L < 3 && this.tier !== 'low';
      const pb = s.particles === 'low' ? 0.4 : s.particles === 'medium' ? 0.7 : 1;
      // particles are fill-rate (overdraw) bound — the thing integrated GPUs lack most
      this.fx.budget = pb * (L >= 5 ? 0.3 : L >= 4 ? 0.4 : this.tier === 'high' ? 1 : this.tier === 'medium' ? 0.6 : 0.42);
    }

    resize() {
      const w = window.innerWidth, h = window.innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.fx.setScale(h * this.pr);
    }

    // Gradient sky dome (vertex colours) that follows the camera, plus a sun
    // disc. Only visible from the lower menu / garage cameras.
    _makeSky() {
      const g = new THREE.SphereGeometry(900, 24, 12);
      const col = new Float32Array(g.attributes.position.count * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
      m.renderOrder = -1;
      m.frustumCulled = false;
      const sun = new THREE.Mesh(new THREE.CircleGeometry(38, 20), new THREE.MeshBasicMaterial({ color: 0xfff6d8, fog: false, depthWrite: false }));
      sun.position.set(420, 520, 300);
      sun.lookAt(0, 0, 0);
      m.add(sun);
      // v5 stars for night races (faded in by _atmos)
      const n = 420, sp = new Float32Array(n * 3), rng = U.rng(4411);
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2, y = 0.12 + 0.88 * Math.pow(rng(), 0.7), r = Math.sqrt(1 - y * y);
        sp[i * 3] = Math.cos(a) * r * 860;
        sp[i * 3 + 1] = y * 860;
        sp[i * 3 + 2] = Math.sin(a) * r * 860;
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
      const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xdfe8ff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
      stars.visible = false;
      stars.frustumCulled = false;
      m.add(stars);
      m.userData.sun = sun;
      m.userData.stars = stars;
      return m;
    }
    _paintSky(th) {
      const g = this.sky.geometry, p = g.attributes.position, c = g.attributes.color;
      const top = new THREE.Color(th.sky).multiplyScalar(0.78), hor = new THREE.Color(th.fog), gnd = new THREE.Color(th.ground).multiplyScalar(0.9 * (th._gk || 1));
      const tmp = new THREE.Color();
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i) / 900;
        if (y >= 0) tmp.copy(hor).lerp(top, Math.pow(y, 0.6));
        else tmp.copy(hor).lerp(gnd, Math.min(1, -y * 4));
        c.setXYZ(i, tmp.r, tmp.g, tmp.b);
      }
      c.needsUpdate = true;
    }

    _trackShadows() {
      // Below "high", only cars cast shadows: the shadow pass was half the
      // GPU frame, and scenery shadows matter far less than the car's own.
      const hi = this.tier === 'high';
      this.trackGroup.traverse((o) => {
        if (o.isMesh && o.userData.castShadow != null) o.castShadow = hi && o.userData.castShadow;
      });
    }

    loadTrack(track) {
      if (this.trackGroup) {
        this.scene.remove(this.trackGroup);
        this.trackGroup.traverse((o) => {
          if (o.geometry && !o.userData.sharedGeo) o.geometry.dispose();
        });
      }
      this.track = track;
      const sc = ST().scenery;
      const detail = sc === 'auto' || !sc ? this.tier : sc; // Chromebooks (medium tier) get medium scenery
      this.trackGroup = G.TrackMesh.build(track, { detail, tier: this.tier });
      this.trackGroup.traverse((o) => {
        if (o.isMesh && o.userData.castShadow == null) o.userData.castShadow = o.castShadow;
      });
      this._trackShadows();
      this.scene.add(this.trackGroup);
      this.trackGroup.userData.env = this.env; // v5: moving hazards follow race time
      this.trackGroup.userData.fx = this.fx;
      this.trackGroup.userData.cam = this.cam; // v5: hazard sounds by distance
      const th = track.theme;
      this.scene.background = new THREE.Color(th.fog);
      this.scene.fog = new THREE.Fog(th.fog, th.fogNear || 170, th.fogFar || 560);
      // v5: a car headlight that really lights the road, only on tracks that
      // get dark (adding a light recompiles every material: do it at load)
      const dark = !!(th.night || (th.todTo || 0) >= 0.7);
      if (dark && !this.headL) {
        this.headL = new THREE.SpotLight(0xfff0d0, 0, 70, 0.5, 0.55, 1.1);
        this.scene.add(this.headL, this.headL.target);
      } else if (!dark && this.headL) {
        this.scene.remove(this.headL, this.headL.target);
        this.headL.dispose();
        this.headL = null;
      }
      this.env.t = 0;
      this.env.wet = 0;
      this.rainWarned = false;
      this._atmKey = '';
      this._atmos(th.night || 0, 0);
      this.lightsState = -1;
      this.fx.clear();
      this.skids.clear();
      this._loadAt = performance.now(); // (the governor lets the next few seconds go: shaders compile)
      this._unshareMaterials();
      this._precompile();
    }

    // list: [{id, carId, color, parts, look, tune}] — (re)builds models whose look changed.
    setCars(list) {
      const keep = new Set();
      for (const c of list) {
        keep.add(c.id);
        const t = c.tune || {};
        const key = c.carId + '|' + c.color + '|' + JSON.stringify(c.parts || {}) + JSON.stringify(c.look || {}) + [t.rideH, t.arbF, t.arbR, t.wing].join(',');
        const m = this.models.get(c.id);
        if (m && m.key === key) continue;
        if (m) {
          this.scene.remove(m.root);
          G.CarModel.dispose(m);
        }
        const nm = G.CarModel.build(c.carId, c.color, c.parts, c.look, c.tune);
        this._beam();
        const beam = new THREE.Mesh(this._beamGeo, this._beamMat);
        beam.position.set(0, 0.1, nm.len / 2 - 0.2);
        beam.renderOrder = 2;
        beam.userData.sharedGeo = true;
        nm.root.add(beam);
        nm.beam = beam;
        nm.key = key;
        nm.id = c.id;
        nm.hint = -1;
        nm.bump = G.Parts.opt('suspension', (c.parts && c.parts.suspension) || 'stock').bump;
        nm.glowRGB = nm.glow ? rgbOf(nm.glow) : null;
        nm.lastGear = 1;
        if (m) {
          nm.root.position.copy(m.root.position);
          nm.root.rotation.copy(m.root.rotation);
        }
        this.scene.add(nm.root);
        this.models.set(c.id, nm);
      }
      for (const [id, m] of this.models) {
        if (!keep.has(id)) {
          this.scene.remove(m.root);
          G.CarModel.dispose(m);
          this.models.delete(id);
        }
      }
      this._unshareMaterials();
    }

    // v5.5.5: build the shaders for things that are hidden at the start - the
    // lamps and neon that light up at dusk, the rain - now, while the track
    // loads, instead of the first time they appear: that was a hitch of a
    // second or more mid-race on a slow machine, at nightfall or when the
    // shower started.
    _precompile() {
      const shown = [];
      this.scene.traverse((o) => {
        if (!o.visible && (o.isMesh || o.isPoints || o.isLine || o.isSprite)) {
          o.visible = true;
          shown.push(o);
        }
      });
      try {
        this.renderer.compile(this.scene, this.camera);
      } catch (e) {}
      for (const o of shown) o.visible = false;
    }

    // v5.5.5: one material drawn by different KINDS of mesh (plain, instanced,
    // instanced with per-instance colour, with or without vertex colours)
    // makes three.js re-pick its shader on every draw that switches kind -
    // all of that work is thrown away and redone next frame. The track's
    // scenery shared one such material across 28 meshes, and the shadow pass
    // shares one depth material between instanced and plain casters: about
    // a tenth of a Chromebook's frame. Each kind now gets its own copy (made
    // once, reused), and instanced casters their own depth material.
    _unshareMaterials() {
      const kinds = new Map(); // material -> first kind seen
      const copies = (this._matCopies = this._matCopies || new WeakMap());
      // (instanced casters with and without per-instance colour are two more kinds)
      const dm = () => new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      const depth = (this._depthI = this._depthI || { i: dm(), ic: dm() });
      // (materials something animates stay shared: a copy wouldn't follow)
      const live = new Set(((this.trackGroup && this.trackGroup.userData.nightMats) || []).map((it) => it.mat));
      this.scene.traverse((o) => {
        if (!o.isMesh || Array.isArray(o.material) || !o.material) return;
        if (o.isInstancedMesh && o.castShadow && !o.customDepthMaterial) o.customDepthMaterial = o.instanceColor ? depth.ic : depth.i;
        const m = o.material, g = o.geometry, col = g && g.attributes && g.attributes.color;
        if (m.transparent || live.has(m)) return;
        const kind = (o.isInstancedMesh ? (o.instanceColor ? 'ic' : 'i') : 'm') + (m.vertexColors ? (col ? col.itemSize : 0) : '');
        const first = kinds.get(m);
        if (first == null) return kinds.set(m, kind);
        if (first === kind) return;
        let per = copies.get(m);
        if (!per) copies.set(m, (per = {}));
        let c = per[kind];
        if (!c) {
          c = per[kind] = m.clone();
          c.onBeforeCompile = m.onBeforeCompile; // (clone() drops these: the grain shader lives here)
          if (m.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey) c.customProgramCacheKey = m.customProgramCacheKey;
        }
        o.material = c;
      });
    }

    removeCar(id) {
      const m = this.models.get(id);
      if (!m) return;
      this.scene.remove(m.root);
      G.CarModel.dispose(m);
      this.models.delete(id);
    }

    // Pose a car model from a render state and emit its particles.
    // rs: {x,z,h,vx,vz,w,steer,ax,ay,rpm,gear,boost,spin,lock,slip[4],surf[4],wallHit,backfire,overheat,ghost,brk,hb,thr}
    updateCar(id, rs, dt) {
      const m = this.models.get(id);
      if (!m) return;
      const tr = this.track;
      const q = tr.query(rs.x, rs.z, m.hint, this.q);
      m.hint = q.i;
      const y = tr.groundY(q); // elevation (smoothly interpolated) + banking
      m.root.position.set(rs.x, y, rs.z);
      m.root.rotation.y = rs.h;
      // Bank tilt relative to the car's heading, plus pitch on hills.
      const dh = U.wrapAngle(rs.h - tr.H[q.i]);
      const bk = Math.abs(q.lat) <= q.hw ? tr.BK[q.i] : 0;
      m.tilt.rotation.z = U.damp(m.tilt.rotation.z, -bk * Math.cos(dh), 10, dt);
      m.tilt.rotation.x = U.damp(m.tilt.rotation.x, bk * Math.sin(dh) - Math.atan(q.gr || 0) * Math.cos(dh), 10, dt);
      // Visual suspension: under-damped springs chasing load-transfer targets.
      // Exaggerated on purpose — the roll/squat/dive IS the game feel.
      const rg = m.rollGain;
      const w0 = 11 / Math.sqrt(rg), zeta = 0.36;
      const rollT = U.clamp(rs.ay * 0.0115 * rg, -0.2, 0.2);
      const pitchT = U.clamp(-rs.ax * 0.0085 * (0.6 + 0.4 * rg), -0.12, 0.12);
      const sdt = Math.min(dt, 0.033);
      m.rollV += (w0 * w0 * (rollT - m.roll) - 2 * zeta * w0 * m.rollV) * sdt;
      m.roll += m.rollV * sdt;
      m.pitchV += (w0 * w0 * (pitchT - m.pitch) - 2 * zeta * w0 * m.pitchV) * sdt;
      m.pitch += m.pitchV * sdt;
      let rough = 0;
      for (let i = 0; i < 4; i++) rough += G.SURF[rs.surf[i] || 0].rough;
      const speed = Math.hypot(rs.vx, rs.vz);
      const jig = rough * 0.25 * m.bump * Math.min(speed / 15, 1);
      m.heave = jig * (Math.sin(this.time * 47 + rs.x) * 0.5 + Math.sin(this.time * 31 + rs.z) * 0.5) * 0.035;
      m.pivot.rotation.z = m.roll + m.heave * 1.5;
      m.pivot.rotation.x = m.pitch;
      m.pivot.position.y = 0.5 + m.heave;
      m.rough = rough;
      // Wheels: steer + spin (locked wheels stop).
      const sinH = Math.sin(rs.h), cosH = Math.cos(rs.h);
      const vLong = rs.vx * sinH + rs.vz * cosH;
      const wr = m.wheelR || 0.33;
      m.spinA += (vLong / wr + (rs.spin & 12 ? 25 : 0)) * dt;
      // All four wheels are ONE InstancedMesh: compose steer (Y) then spin (X).
      const d = m.wheelDummy;
      for (let i = 0; i < 4; i++) {
        const wh = m.wheels[i];
        if (!(rs.lock & (1 << i))) wh.spin = m.spinA;
        d.position.set(wh.x, wr, wh.z);
        d.rotation.set(wh.spin, i < 2 ? rs.steer : 0, 0, 'YXZ');
        d.updateMatrix();
        m.wheelMesh.setMatrixAt(i, d.matrix);
      }
      m.wheelMesh.instanceMatrix.needsUpdate = true;
      // Brake + reverse lights (vertex-colour range, no extra draw calls).
      const braking = (rs.brk > 0.3 && speed > 0.6) || rs.hb > 0;
      G.CarModel.setLights(m, braking ? 1 : 0, rs.gear === -1 ? 1 : 0);
      m.root.visible = !(rs.ghost > 0 && !rs.pit && Math.floor(this.time * 12) % 2); // (v5: not while parked in the pit box)
      this._emit(m, rs, dt, speed, sinH, cosH, y, braking);
    }

    _emit(m, rs, dt, speed, sinH, cosH, y, braking) {
      const fx = this.fx;
      fx.floorY = y + 0.05;
      const W = (lx, ly, lz) => [rs.x + sinH * lz + cosH * lx, y + ly, rs.z + cosH * lz - sinH * lx];
      for (let i = 0; i < 4; i++) {
        const [lx, lz] = m.wheelLocal[i];
        const wx = rs.x + sinH * lz + cosH * lx, wz = rs.z + cosH * lz - sinH * lx;
        const sf = G.SURF[rs.surf[i] || 0];
        const slip = rs.slip[i] || 0;
        const rear = i >= 2;
        const key = m.id + ':' + i;
        const bvx = sinH * -1.5 * speed * 0.2, bvz = cosH * -1.5 * speed * 0.2;
        if (sf.fx === 'smoke') {
          // (launch wheelspin at 5 cars × 2 wheels used to bury the grid in smoke)
          if (slip > 0.3 && Math.random() < slip * dt * (speed < 6 ? 18 : 40)) fx.emit('smoke', wx, y + 0.25, wz, bvx + (Math.random() - 0.5), 0, bvz + (Math.random() - 0.5), 0.8 + slip * 0.6);
          this.skids.add(key, wx, y + 0.06, wz, 0.26, slip > 0.32 ? Math.min(0.55, slip * 0.6) : 0, [0.08, 0.08, 0.09]);
          if (sf.id === 'kerb' && speed > 8 && Math.random() < dt * 8) fx.emit('dust', wx, y + 0.2, wz, bvx, 0.4, bvz, 0.5);
        } else if (sf.fx === 'dust') {
          // rooster tails: rear wheels throw more, and more when spinning
          const amt = (rear ? Math.min(speed / 25, 1) * 0.6 : 0.15) + slip;
          if (speed > 4 && Math.random() < amt * dt * 44) fx.emit(sf.id === 'sand' ? 'sand' : 'dust', wx, y + 0.3, wz, bvx * 2 + (Math.random() - 0.5) * 2, 0.5 + slip, bvz * 2 + (Math.random() - 0.5) * 2, 0.7 + slip);
          if (rear && slip > 0.4 && Math.random() < dt * 20) fx.emit('debris', wx, y + 0.2, wz, bvx * 1.5 + (Math.random() - 0.5) * 3, 1 + Math.random() * 2, bvz * 1.5 + (Math.random() - 0.5) * 3, 0.8, sf.id === 'sand' ? RGB.sand : RGB.dirt);
          this.skids.add(key, wx, y + 0.05, wz, 0.3, rear && (slip > 0.2 || speed > 12) ? 0.22 : 0, [0.35, 0.22, 0.12]);
        } else if (sf.fx === 'grass') {
          if (speed > 4 && Math.random() < (0.3 + slip) * dt * 30) fx.emit('grass', wx, y + 0.2, wz, bvx + (Math.random() - 0.5) * 2, 1.5, bvz + (Math.random() - 0.5) * 2, 1);
          this.skids.add(key, wx, y + 0.05, wz, 0.3, speed > 6 ? 0.25 : 0, [0.2, 0.3, 0.12]);
        } else if (sf.fx === 'spray') {
          if (speed > 6 && Math.random() < (speed / 30 + slip) * dt * 34) fx.emit('spray', wx, y + 0.2, wz, bvx * 2, 0.3 + speed * 0.02, bvz * 2, 0.6 + speed / 40);
          this.skids.add(key, wx, y + 0.06, wz, 0.24, slip > 0.35 ? 0.25 : 0, [0.1, 0.12, 0.14]);
        } else if (sf.fx === 'splash') {
          // v5 water: sheets of spray off every wheel, more the faster you go
          if (speed > 3 && Math.random() < (0.5 + speed / 18) * dt * 30) fx.emit('splash', wx, y + 0.25, wz, bvx * 2.4 + (Math.random() - 0.5) * 3, 1.2 + speed * 0.05, bvz * 2.4 + (Math.random() - 0.5) * 3, 0.8 + speed / 30);
        } else if (sf.fx === 'oil') {
          if (speed > 6 && Math.random() < (0.4 + slip) * dt * 20) fx.emit('oil', wx, y + 0.15, wz, bvx * 1.5, 0.4, bvz * 1.5, 0.7);
          this.skids.add(key, wx, y + 0.06, wz, 0.28, speed > 4 ? 0.5 : 0, [0.03, 0.03, 0.04]);
        } else if (sf.fx === 'mud') {
          const amt = (rear ? Math.min(speed / 25, 1) * 0.7 : 0.25) + slip;
          if (speed > 3 && Math.random() < amt * dt * 40) fx.emit('mud', wx, y + 0.3, wz, bvx * 2 + (Math.random() - 0.5) * 2, 1 + slip, bvz * 2 + (Math.random() - 0.5) * 2, 0.8 + slip);
          if (rear && Math.random() < dt * 14 * (0.3 + slip)) fx.emit('debris', wx, y + 0.2, wz, bvx * 1.5 + (Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, bvz * 1.5 + (Math.random() - 0.5) * 3, 0.9, RGB.mud);
          this.skids.add(key, wx, y + 0.05, wz, 0.32, 0.45, [0.22, 0.14, 0.08]);
        } else if (sf.fx === 'ice') {
          if (speed > 5 && Math.random() < (0.2 + slip) * dt * 30) fx.emit('snow', wx, y + 0.2, wz, bvx * 1.5, 0.6, bvz * 1.5, 0.6 + slip);
          this.skids.add(key, wx, y + 0.06, wz, 0.24, slip > 0.2 ? 0.3 : 0, [0.75, 0.85, 0.95]);
        }
      }
      // v4: nitrous — blue exhaust flames + glow
      if (rs.nosOn) {
        for (const e of m.exhaust) {
          const [ex, ey, ez] = W(e[0], e[1], e[2]);
          fx.emit('nos', ex, ey, ez, -sinH * 9 + rs.vx * 0.9, 0, -cosH * 9 + rs.vz * 0.9, 1.3);
          fx.emit('glow', ex - sinH * 0.4, ey, ez - cosH * 0.4, 0, 0, 0, 1.6, RGB.nos);
        }
      }
      // v4: speed pad — a cyan burst the moment the car hits it
      const onPad = rs.padT > 0.6 || !!rs.pad;
      if (onPad && !m.padPrev) {
        for (let k = 0; k < 14; k++) fx.emit('spark', rs.x, y + 0.3, rs.z, (Math.random() - 0.5) * 6 + rs.vx * 0.5, 1 + Math.random() * 2, (Math.random() - 0.5) * 6 + rs.vz * 0.5, 1, RGB.nosSpark);
        m.padFlash = 0.35;
        if (m.id === this.focusId) this.shake(0.25);
        if (this.onPad) this.onPad(m.id === this.focusId);
      }
      m.padPrev = onPad;
      if (m.padFlash > 0) {
        m.padFlash -= dt;
        fx.emit('glow', rs.x, y + 0.2, rs.z, 0, 0, 0, 5 * m.padFlash, RGB.pad);
      }
      // v4: slipstream — wind streaks streaming past the camera car
      if (m.id === this.focusId && (rs.draft || 0) > 0.2 && speed > 14) {
        const n = rs.draft * dt * 60;
        for (let k = 0; k < n; k++) {
          const [px, py, pz] = W((Math.random() - 0.5) * 3.2, 0.3 + Math.random() * 1.2, 1.5 + Math.random() * 4);
          fx.emit('streak', px, py, pz, rs.vx * 0.35, 0, rs.vz * 0.35, 1);
        }
      }
      // v5.1 crosswind: grit and spray blowing across the road, so the push
      // you can feel has something to look at. Spawned upwind of the camera
      // car and blown across it at the gust's own strength.
      if (m.id === this.focusId && Math.abs(rs.gust || 0) > 0.4) {
        const g = rs.gust, dir = g > 0 ? 1 : -1, str = Math.min(1, Math.abs(g) / 6);
        const wx = rs.gnx * dir, wz = rs.gnz * dir;
        const n = dt * (26 + 34 * str) * this.fx.budget;
        for (let k = 0; k < n; k++) {
          const along = (Math.random() - 0.5) * 34, across = -14 - Math.random() * 12;
          const px = rs.x + wx * across - wz * along;
          const pz = rs.z + wz * across + wx * along;
          const sp = 13 + 3.2 * Math.abs(g) + Math.random() * 6;
          const gy = this.groundAt ? this.groundAt(px, pz) : y;
          // small and quick: grit skating across the road, not smoke
          if (Math.random() < 0.45) fx.emit('sand', px, gy + 0.2 + Math.random() * 1.1, pz, wx * sp, 0.15, wz * sp, 0.22 + str * 0.2);
          else fx.emit('streak', px, gy + 0.3 + Math.random() * 2.4, pz, wx * sp * 1.7, 0, wz * sp * 1.7, 1.3);
        }
      }
      // exhaust: flames on backfire, puffs on gear changes and hard launches
      const gearUp = rs.gear > m.lastGear && m.lastGear > 0;
      m.lastGear = rs.gear;
      for (const e of m.exhaust) {
        const [ex, ey, ez] = W(e[0], e[1], e[2]);
        if (rs.backfire > 0 && Math.random() < 0.6) fx.emit('flame', ex, ey, ez, -sinH * 4, 0, -cosH * 4, 1);
        if (gearUp) fx.emit('puff', ex, ey, ez, -sinH * 2 + rs.vx * 0.6, 0.2, -cosH * 2 + rs.vz * 0.6, 1);
        else if (rs.thr > 0.5 && speed < 8 && Math.random() < dt * 14) fx.emit('puff', ex, ey, ez, -sinH * 1.5, 0.2, -cosH * 1.5, 0.8);
      }
      // v5.3 overrun: a free-flowing exhaust throws unburnt fuel out of the
      // pipe, so it smokes and spits as well as banging. Driven from the car,
      // not from the mixer, so it shows with the sound off - and it stops a
      // couple of seconds after the lift, like the noise does.
      const od = m.od;
      if (od && od.pops > 0) {
        if (m.lastThr > 0.5 && rs.thr < 0.2 && rs.rpm > 0.4) m.ovT = 0;
        if (rs.thr > 0.3) m.ovT = 99;
        m.ovT += dt;
        const win = od.bang ? 2.2 : 1.2;
        if (m.ovT < win && rs.thr < 0.25) {
          const fade = 1 - m.ovT / win;
          const rate = dt * (od.bang ? 26 : 14) * od.pops * fade;
          for (const e of m.exhaust) {
            if (Math.random() > rate) continue;
            const [ex, ey, ez] = W(e[0], e[1], e[2]);
            const back = -sinH * (2 + Math.random() * 3), backZ = -cosH * (2 + Math.random() * 3);
            fx.emit('puff', ex, ey, ez, back + rs.vx * 0.5, 0.3 + Math.random() * 0.5, backZ + rs.vz * 0.5, 0.7 + Math.random() * 0.6, RGB.smoke);
            // a bang tune spits a lick of flame with the bigger ones
            if (od.bang && Math.random() < 0.3 * fade) fx.emit('flame', ex, ey, ez, -sinH * 4, 0, -cosH * 4, 0.8);
          }
        }
      }
      m.lastThr = rs.thr;

      if (rs.overheat && Math.random() < dt * 25) fx.emit('steam', rs.x + sinH * 1.5, y + 1, rs.z + cosH * 1.5, 0, 0.5, 0, 1);
      // a battered car shows it: dark smoke from under the bonnet
      if (rs.body > 0.3 && Math.random() < dt * rs.body * 16) {
        const [hx, hy, hz] = W(0, 0.85, m.len * 0.28);
        fx.emit('puff', hx, hy, hz, rs.vx * 0.3, 0.8, rs.vz * 0.3, 0.8 + rs.body, RGB.smoke);
      }
      if (rs.wallHit > 800) {
        for (let k = 0; k < 6; k++) fx.emit('spark', rs.x, y + 0.5, rs.z, (Math.random() - 0.5) * 8, 2 + Math.random() * 3, (Math.random() - 0.5) * 8, 1);
      }
      // brake-light glow + underglow (one-frame additive sprites). v4.4.2:
      // only near the camera. These sprites skip the particle budget, so a
      // braking pack (plus underglow on some bots since v4.4) meant dozens of
      // big see-through quads every frame even where the governor had turned
      // particles down (Chromebooks).
      const cdx = rs.x - this.cam.fx, cdz = rs.z - this.cam.fz;
      const camD2 = cdx * cdx + cdz * cdz;
      if (braking && camD2 < 90 * 90) {
        for (const t of m.tailLocal) {
          const [tx, ty, tz] = W(t[0], t[1], t[2]);
          fx.emit('glow', tx, ty, tz, 0, 0, 0, 0.9, RGB.tail);
        }
      }
      // v5 at night: headlight lenses and tail lights glow, and the beam shows
      const night = this.env.night;
      if (m.beam) m.beam.visible = night > 0.02 && !rs.ghost;
      if (night > 0.02 && camD2 < 110 * 110) {
        for (const sx of [0.62, -0.62]) {
          const [hx, hy, hz] = W(sx, 0.62, m.len / 2 - 0.05);
          fx.emit('glow', hx, hy, hz, 0, 0, 0, 1.3 * night, RGB.head);
        }
        if (!braking) for (const t of m.tailLocal) {
          const [tx, ty, tz] = W(t[0], t[1], t[2]);
          fx.emit('glow', tx, ty, tz, 0, 0, 0, 0.55 * night, RGB.tail);
        }
      }
      if (this.headL && m.id === this.focusId) {
        const L = this.headL;
        L.intensity = 260 * night;
        L.visible = night > 0.02;
        const [lx, ly, lz] = W(0, 1.1, m.len / 2);
        const [ax, ay, az] = W(0, 0, m.len / 2 + 24);
        L.position.set(lx, ly, lz);
        L.target.position.set(ax, ay, az);
      }
      if (m.glowRGB && camD2 < 45 * 45 && fx.budget >= 0.6) {
        // v5 underglow effects: pulse breathes, rainbow walks the hue
        let size = 3.2, col = m.glowRGB;
        if (m.glowFx === 'pulse') size *= 0.7 + 0.35 * Math.sin(this.time * 4);
        else if (m.glowFx === 'rainbow') {
          const c = (this._rbw = this._rbw || new THREE.Color()).setHSL((this.time * 0.25 + (m.id ? m.id.length * 0.13 : 0)) % 1, 1, 0.55);
          col = this._rbwA || (this._rbwA = [0, 0, 0]);
          col[0] = c.r; col[1] = c.g; col[2] = c.b;
        }
        for (const lz of [-1.2, 0, 1.2]) {
          const [gx, gy, gz] = W(0, 0.12, lz);
          fx.emit('glow', gx, gy, gz, 0, 0, 0, size, col);
        }
      }
    }

    // Confetti burst over a car (finishing, podiums).
    confetti(id, n) {
      const m = this.models.get(id);
      if (!m) return;
      const p = m.root.position;
      const cols = [[1, 0.8, 0], [1, 0.24, 0.5], [0.16, 0.83, 1], [0.18, 0.88, 0.48], [1, 1, 1]];
      this.fx.floorY = p.y + 0.05;
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 6;
        this.fx.emit('confetti', p.x, p.y + 1.5, p.z, Math.cos(a) * s, 2 + Math.random() * 4, Math.sin(a) * s, 1, cols[k % cols.length]);
      }
    }

    // Firework bursts high over a point (podium finishes, final standings).
    fireworks(x, z, n) {
      const cols = [[1, 0.8, 0.2], [1, 0.3, 0.6], [0.3, 0.8, 1], [0.4, 1, 0.5], [1, 1, 1]];
      for (let b = 0; b < (n || 3); b++) {
        const bx = x + (Math.random() - 0.5) * 30, bz = z + (Math.random() - 0.5) * 30, by = 16 + Math.random() * 10;
        const col = cols[Math.floor(Math.random() * cols.length)];
        for (let k = 0; k < 40; k++) {
          const a = Math.random() * Math.PI * 2, e = Math.random() * 2 - 1, s = 7 + Math.random() * 4;
          const r = Math.sqrt(1 - e * e);
          this.fx.emit('firework', bx, by, bz, Math.cos(a) * r * s, e * s, Math.sin(a) * r * s, 1, col);
        }
      }
    }

    sparks(x, z, n) {
      const gy = this.groundAt(x, z);
      this.fx.floorY = gy + 0.05;
      for (let k = 0; k < n; k++) this.fx.emit('spark', x, gy + 0.6, z, (Math.random() - 0.5) * 9, 2 + Math.random() * 3, (Math.random() - 0.5) * 9, 1);
    }

    // Body-coloured bits flying off in a big contact.
    debris(x, z, colors, n) {
      const gy = this.groundAt(x, z);
      this.fx.floorY = gy + 0.05;
      for (let k = 0; k < n; k++) {
        const c = colors[k % colors.length];
        this.fx.emit('debris', x, gy + 0.7, z, (Math.random() - 0.5) * 10, 2 + Math.random() * 4, (Math.random() - 0.5) * 10, 0.7 + Math.random() * 0.6, c);
      }
    }

    // Road height at a world position (v4 elevation); 0 with no track.
    groundAt(x, z) {
      if (!this.track || !this.track.GR) return 0;
      const q = this.track.query(x, z, this._gHint == null ? -1 : this._gHint, (this._gq = this._gq || {}));
      this._gHint = q.i;
      return this.track.groundY(q);
    }
    colorOf(id) {
      const m = this.models.get(id);
      return m ? rgbOf(m.color) : [0.6, 0.6, 0.6];
    }

    shake(a) {
      if (!ST().shake) return;
      this.cam.shake = Math.max(this.cam.shake, a);
    }

    cycleCam() {
      const i = CAM_ORDER.indexOf(this.cam.mode);
      const next = CAM_ORDER[(i + 1) % CAM_ORDER.length];
      G.Settings.set('cam', next);
      this.cam.mode = next;
      return CAM_NAMES[next];
    }

    // Start lights on the posts. n = lamps lit red (0..5), go = all green.
    setStartLights(n, go) {
      const L = this.trackGroup && this.trackGroup.userData.lights;
      if (!L) return;
      const state = go ? 9 : n;
      if (state === this.lightsState) return;
      this.lightsState = state;
      const col = L.mesh.geometry.attributes.color, a = col.array;
      const off = new THREE.Color(0x2a1111), red = new THREE.Color(0xff2a1a), green = new THREE.Color(0x2fe07a);
      L.lamps.forEach((r, k) => {
        const c = go ? green : k < n ? red : off;
        for (let i = r[0]; i < r[1]; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
      });
      col.needsUpdate = true;
    }

    // Angled top-down chase: ~56° pitch, yaw follows the direction of travel,
    // focus leads the car along its velocity so you see corners coming.
    // o (optional): {pitch, dist, lead} overrides — the garage uses a lower,
    // closer camera so body roll and squat are easy to read.
    follow(rs, dt, o) {
      const c = this.cam;
      if (!Number.isFinite(rs.x) || !Number.isFinite(rs.z)) return; // (a NaN focus used to turn the whole view white)
      if (c.mode === 'tv' && !o && this.track) return this._tvCam(rs, dt);
      const P = CAMS[c.mode] || CAMS.follow;
      const speed = Math.hypot(rs.vx, rs.vz);
      const vdir = speed > 3 ? Math.atan2(rs.vx, rs.vz) : rs.h;
      const la = U.clamp(speed * (o && o.lead != null ? o.lead : P[3]), 0, 15);
      const tx = rs.x + Math.sin(vdir) * la, tz = rs.z + Math.cos(vdir) * la;
      const gy = this.groundAt(rs.x, rs.z);
      if (c.snap) {
        c.fx = tx; c.fz = tz; c.yaw = rs.h; c.fy = gy; c.snap = false;
      }
      c.fx = U.damp(c.fx, tx, 6, dt);
      c.fz = U.damp(c.fz, tz, 6, dt);
      c.fy = U.damp(c.fy || 0, gy, 4, dt);
      const yawT = c.mode === 'fixed' && !o ? 0 : speed > 3 ? U.lerpAngle(rs.h, vdir, 0.6) : rs.h;
      c.yaw = U.lerpAngle(c.yaw, yawT, 1 - Math.exp(-2.4 * dt));
      c.dist = U.damp(c.dist, o && o.dist ? o.dist + speed * 0.1 : P[0] + speed * P[1], 2, dt);
      // speed feel: FOV opens up and the camera buzzes on rough ground
      const s = ST();
      // (v4: nitrous kicks the FOV wider still; a slipstream a touch)
      const fovT = !o && s.fovKick ? 40 + U.clamp((speed - 15) / 35, 0, 1) * 7 + (rs.nosOn ? 6 : 0) + (rs.draft || 0) * 2 : 40;
      if (!o && s.shake && rs.nosOn) c.shake = Math.max(c.shake, 0.06);
      if (!o && s.shake) {
        if (speed > 38) c.shake = Math.max(c.shake, (speed - 38) * 0.004);
        let rough = 0;
        if (rs.surf) for (let i = 0; i < 4; i++) rough += G.SURF[rs.surf[i] || 0].rough;
        if (rough > 0.3 && speed > 8) c.shake = Math.max(c.shake, rough * 0.03 * Math.min(1, speed / 25));
      }
      this._fov(fovT, dt);
      this._place(c.fx, c.fz, c.yaw, c.dist, (o && o.pitch) || P[2], dt);
    }

    // v5 TV cameras: posts every ~110 m round the track, alternating sides,
    // set back beyond the wall and up high. The nearest post just ahead of
    // the car takes the shot (a hard cut between posts) and zooms so the car
    // stays about the same size on screen.
    _tvCam(rs, dt) {
      const tr = this.track, c = this.cam;
      const q = tr.query(rs.x, rs.z, this._tvHint == null ? -1 : this._tvHint, this._tvQ || (this._tvQ = {}));
      this._tvHint = q.i;
      const GAP = 110, n = Math.max(1, Math.floor(tr.length / GAP));
      let k = Math.floor((q.along + 55) / GAP);
      k = tr.closed ? ((k % n) + n) % n : U.clamp(k, 0, n);
      const cut = k !== this._tvK;
      this._tvK = k;
      const pi = tr.idx(Math.round((k * GAP) / tr.sp));
      const side = k % 2 ? 1 : -1;
      const lat = side * (tr.wallD[pi] + 10);
      const px = tr.X[pi] + tr.NX[pi] * lat, pz = tr.Z[pi] + tr.NZ[pi] * lat;
      const py = Math.max(this.groundAt(px, pz), tr.Y[pi]) + 7 + ((k * 7) % 5);
      const gy = this.groundAt(rs.x, rs.z);
      const ax = rs.x + rs.vx * 0.25, az = rs.z + rs.vz * 0.25;
      if (cut || c.snap) {
        c.fx = ax; c.fz = az; c.fy = gy; c.snap = false;
      } else {
        c.fx = U.damp(c.fx, ax, 9, dt);
        c.fz = U.damp(c.fz, az, 9, dt);
        c.fy = U.damp(c.fy || 0, gy, 6, dt);
      }
      const d = Math.hypot(c.fx - px, c.fz - pz, c.fy - py);
      const fovT = U.clamp((2 * Math.atan(11 / Math.max(1, d)) * 180) / Math.PI, 9, 55);
      if (cut) c.fov = fovT;
      this._fov(fovT, dt);
      this.camera.position.set(px, py, pz);
      this.camera.lookAt(c.fx, c.fy + 0.8, c.fz);
      this.sun.position.set(c.fx + 40, c.fy + 90, c.fz + 25);
      this.sun.target.position.set(c.fx, c.fy, c.fz);
    }

    _fov(target, dt) {
      const c = this.cam;
      c.fov = U.damp(c.fov, target, 3, dt);
      if (Math.abs(this.camera.fov - c.fov) > 0.05) {
        this.camera.fov = c.fov;
        this.camera.updateProjectionMatrix();
      }
    }

    // Free spectator camera: WASD/arrows pan, Q/E rotate, wheel zoom.
    freeCam(dt, keys, target) {
      const c = this.cam;
      const k = keys || {};
      let mx = 0, mz = 0;
      if (k.KeyW || k.ArrowUp) mz += 1;
      if (k.KeyS || k.ArrowDown) mz -= 1;
      if (k.KeyA || k.ArrowLeft) mx += 1;
      if (k.KeyD || k.ArrowRight) mx -= 1;
      if (k.KeyQ) c.freeYaw += dt * 1.6;
      if (k.KeyE) c.freeYaw -= dt * 1.6;
      const sp = c.freeDist * 1.2;
      if (target) {
        c.fx = U.damp(c.fx, target.x, 5, dt);
        c.fz = U.damp(c.fz, target.z, 5, dt);
      }
      const sy = Math.sin(c.freeYaw), cy = Math.cos(c.freeYaw);
      c.fx += (sy * mz + cy * mx) * sp * dt;
      c.fz += (cy * mz - sy * mx) * sp * dt;
      c.yaw = U.lerpAngle(c.yaw, c.freeYaw, 1 - Math.exp(-6 * dt));
      c.dist = U.damp(c.dist, c.freeDist, 6, dt);
      c.fy = U.damp(c.fy || 0, this.groundAt(c.fx, c.fz), 3, dt);
      this._fov(40, dt);
      this._place(c.fx, c.fz, c.yaw, c.dist, 58, dt);
    }

    orbit(x, z, dt, dist, pitch, speed) {
      const c = this.cam;
      c.yaw += dt * (speed == null ? 0.12 : speed);
      c.fx = U.damp(c.fx, x, 3, dt);
      c.fz = U.damp(c.fz, z, 3, dt);
      c.dist = U.damp(c.dist, dist || 60, 3, dt);
      c.fy = U.damp(c.fy || 0, this.groundAt(c.fx, c.fz), 3, dt);
      this._fov(40, dt);
      this._place(c.fx, c.fz, c.yaw, c.dist, pitch || 42, dt, 0.6);
    }

    _place(fx, fz, yaw, dist, pitchDeg, dt, lookY) {
      const c = this.cam;
      const p = (pitchDeg * Math.PI) / 180;
      let sx = 0, sz = 0, sy = 0;
      if (c.shake > 0.01) {
        sx = (Math.random() - 0.5) * c.shake;
        sz = (Math.random() - 0.5) * c.shake;
        sy = (Math.random() - 0.5) * c.shake * 0.5;
        c.shake *= Math.exp(-8 * dt);
      }
      const hd = Math.cos(p) * dist, hy = Math.sin(p) * dist;
      const fy = c.fy || 0; // focus height (v4 hills)
      this.camera.position.set(fx - Math.sin(yaw) * hd + sx, fy + hy + sy, fz - Math.cos(yaw) * hd + sz);
      this.camera.lookAt(fx + sx * 0.5, fy + (lookY || 0), fz + sz * 0.5);
      // Sun + shadow frustum follow the focus point (tight frustum = sharp shadows).
      this.sun.position.set(fx + 40, fy + 90, fz + 25);
      this.sun.target.position.set(fx, fy, fz);
    }

    // v5: the race environment from the view (raceview.js apply): race time
    // for the moving hazards, rain, and how far the leader is round (time of
    // day on themes that get dark during the race).
    setEnv(t, wet, prog) {
      const th = this.track && this.track.theme;
      if (!th) return;
      this.env.t = t;
      this.env.wet = wet || 0;
      const tod = th.night != null ? th.night : th.todTo ? th.todTo * U.clamp(prog || 0, 0, 1) : 0;
      this._atmos(tod, th.rain ? 0 : this.env.wet);
    }

    _rainOn() {
      const th = this.track && this.track.theme;
      const k = th ? (th.rain ? 1 : U.clamp(this.env.wet * 1.4, 0, 1)) : 0;
      this.rain.setOn(ST().weather && k > 0.02, k);
    }

    _atmos(tod, wet) {
      const th = this.track.theme;
      const key = Math.round(tod * 60) + '|' + Math.round(wet * 30);
      if (key === this._atmKey) return;
      this._atmKey = key;
      const A = this._atm || (this._atm = { sky: new THREE.Color(), fog: new THREE.Color(), hs: new THREE.Color(), sc: new THREE.Color(), t: new THREE.Color(), grey: new THREE.Color() });
      const day = { sky: th.sky, fog: th.fog, hemiSky: th.hemiSky || 0xe6f4ff, hemiI: th.hemiI || 1.6, sunCol: th.sunCol || 0xfff1d8, sunI: th.sunI || 2.3 };
      const night = th.night ? Object.assign({}, TOD.night, { sky: th.sky, fog: th.fog }) : TOD.night;
      const [a, b, f] = tod <= 0.5 ? [day, TOD.dusk, tod * 2] : [TOD.dusk, night, (tod - 0.5) * 2];
      const col = (out, k) => out.set(a[k]).lerp(A.t.set(b[k]), f);
      col(A.sky, 'sky');
      col(A.fog, 'fog');
      col(A.hs, 'hemiSky');
      col(A.sc, 'sunCol');
      let hemiI = U.lerp(a.hemiI, b.hemiI, f), sunI = U.lerp(a.sunI, b.sunI, f);
      if (wet > 0) {
        A.grey.set(0x9aa6b2).lerp(A.t.set(0x1d2333), U.clamp(tod * 1.4, 0, 1));
        A.fog.lerp(A.grey, 0.5 * wet);
        A.sky.lerp(A.grey, 0.6 * wet);
        sunI *= 1 - 0.55 * wet;
        hemiI *= 1 - 0.12 * wet;
      }
      const gk = 1 - 0.55 * U.clamp((tod - 0.4) / 0.6, 0, 1);
      this.scene.background.copy(A.fog);
      this.scene.fog.color.copy(A.fog);
      this.scene.fog.near = (th.fogNear || 170) * (1 - 0.3 * wet);
      this.scene.fog.far = (th.fogFar || 560) * (1 - 0.3 * wet);
      this.hemi.color.copy(A.hs);
      this.hemi.groundColor.set(th.ground).multiplyScalar(0.8 * gk);
      this.hemi.intensity = hemiI;
      this.sun.color.copy(A.sc);
      this.sun.intensity = sunI;
      this._paintSky({ sky: A.sky.getHex(), fog: A.fog.getHex(), ground: th.ground, _gk: gk });
      // sun by day, a pale moon by night; stars once it's properly dark
      const night01 = U.clamp((tod - 0.55) / 0.35, 0, 1);
      const sun = this.sky.userData.sun, stars = this.sky.userData.stars;
      sun.material.color.set(0xfff6d8).lerp(A.t.set(0xdfe6ff), night01);
      sun.scale.setScalar(1 - 0.45 * night01);
      sun.visible = wet < 0.6;
      stars.material.opacity = night01 * (1 - wet) * 0.9;
      stars.visible = stars.material.opacity > 0.02;
      this.env.tod = tod;
      this.env.night = night01;
      // lamps, light pools and neon built by trackmesh.js
      const nm = this.trackGroup && this.trackGroup.userData.nightMats;
      if (nm) for (const it of nm) {
        it.mat.opacity = it.base * night01;
        it.obj.visible = night01 > 0.02;
      }
      if (this._beamMat) this._beamMat.opacity = 0.3 * night01;
      this._rainOn();
    }

    // v5 headlights at dusk/night: a soft beam on the road ahead of every car
    // (one shared additive quad), lens glows near the camera, and one real
    // spotlight on the car the camera follows.
    _beam() {
      if (this._beamGeo) return;
      const cv = document.createElement('canvas');
      cv.width = 64;
      cv.height = 128;
      const g = cv.getContext('2d');
      const grd = g.createLinearGradient(0, 128, 0, 0);
      grd.addColorStop(0, 'rgba(255,244,214,1)');
      grd.addColorStop(0.35, 'rgba(255,240,200,0.55)');
      grd.addColorStop(1, 'rgba(255,236,190,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 128);
      const side = g.createLinearGradient(0, 0, 64, 0);
      side.addColorStop(0, 'rgba(0,0,0,1)');
      side.addColorStop(0.3, 'rgba(0,0,0,0)');
      side.addColorStop(0.7, 'rgba(0,0,0,0)');
      side.addColorStop(1, 'rgba(0,0,0,1)');
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = side;
      g.fillRect(0, 0, 64, 128);
      const tex = new THREE.CanvasTexture(cv);
      // a trapezoid from the bumper (2.2 m wide) to 26 m ahead (11 m wide)
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([-1.1, 0, 0, 1.1, 0, 0, 5.5, 0, 26, -5.5, 0, 26], 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      geo.setIndex([0, 2, 1, 0, 3, 2]);
      this._beamGeo = geo;
      this._beamMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.3 * this.env.night, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
    }

    project(x, y, z, out) {
      const v = (this._pv = this._pv || new THREE.Vector3());
      v.set(x, y, z).project(this.camera);
      out.x = (v.x * 0.5 + 0.5) * window.innerWidth;
      out.y = (-v.y * 0.5 + 0.5) * window.innerHeight;
      out.vis = v.z < 1 && v.z > -1;
      out.depth = v.z;
      return out;
    }

    render(dt) {
      const t0 = performance.now();
      this.time += dt;
      this.fx.update(dt);
      this.skids.update();
      this.rain.update(dt, this.cam.fx, this.cam.fz, this.cam.fy || 0);
      const anim = this.trackGroup && this.trackGroup.userData.anim;
      if (anim) anim(this.time, dt);
      this.sky.position.copy(this.camera.position);
      this.renderer.render(this.scene, this.camera);
      const ri = this.renderer.info.render;
      this._calls = ri.calls; // (kept: stats() can be read between frames)
      this._tris = ri.triangles;
      this.frameMs = U.lerp(this.frameMs, performance.now() - t0, 0.1);
      this._governor();
    }

    // Adaptive quality (resolution -> shadows -> particle budget).
    // v5.5.5: it only ever went down on a weak machine. Any two slow seconds
    // took a step - every track build, a garbage-collection hiccup - and
    // coming back needed 48 s above 58.5 fps, which a 60 Hz screen hardly
    // shows. A Chromebook finished a session at the lowest level (pixel
    // ratio 0.55, blurry) whatever its real frame rate. Now it judges the
    // MEDIAN frame of each second (a hitch doesn't count), ignores the few
    // seconds after a track loads, steps down after 3 slow seconds, back up
    // after 10 good ones - and undoes a step that didn't help (a machine
    // held back by its processor gains nothing from fewer pixels), then
    // leaves quality alone for a while.
    _governor() {
      const now = performance.now();
      if (this._gLast != null) this._gFrames.push(now - this._gLast);
      else this._gFrames = [];
      this._gLast = now;
      if (!this._gT) this._gT = now;
      if (now - this._gT < 1000) return;
      const f = this._gFrames.sort((a, b) => a - b);
      const n = f.length;
      this.fps = n ? 1000 / f[n >> 1] : 60;
      this._gFrames = [];
      this._gT = now;
      if (this.quality !== 'auto' || document.hidden || n < 5) return;
      if (now - (this._loadAt || -1e9) < 3000) return (this.slowT = 0); // a track just loaded
      const tr = this._trial;
      if (tr && now - tr.at > 4000) {
        this._trial = null;
        if (this.fps - tr.fps < 2) {
          // that step bought nothing: put it back and stop trying for a while
          this.level = tr.from;
          this._applyLevel();
          this._holdUntil = now + 45000;
          this.slowT = 0;
          return;
        }
      }
      if (this.fps < 50) this.slowT = Math.max(0, this.slowT) + 1;
      else if (this.fps >= 57) this.slowT = Math.min(0, this.slowT) - 1;
      else this.slowT = 0;
      if (this.slowT >= 3 && this.level < 5 && !this._trial && now > (this._holdUntil || 0)) {
        this._trial = { from: this.level, fps: this.fps, at: now };
        this.level++;
        this.slowT = 0;
        this._applyLevel();
      } else if (this.slowT <= -10 && this.level > 0) {
        this.level--;
        this.slowT = 0;
        this._applyLevel();
      }
    }

    stats() {
      const i = this.renderer.info;
      return { fps: this.fps, calls: this._calls || i.render.calls, tris: this._tris || i.render.triangles, level: this.level, pr: this.pr, tier: this.tier, gpu: this.gpu.name, ms: this.frameMs, parts: this.fx.norm.live + this.fx.add.live };
    }
  }

  World.CAMS = CAMS;
  World.CAM_NAMES = CAM_NAMES;
  G.World = World;
})(window.G);
