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
  const CAMS = {
    follow: [31, 0.28, 56, 0.42],
    near: [21, 0.19, 49, 0.34],
    far: [43, 0.3, 61, 0.46],
    fixed: [33, 0.28, 58, 0.42],
  };
  const CAM_ORDER = ['follow', 'near', 'far', 'fixed'];
  const CAM_NAMES = { follow: 'Chase', near: 'Close chase', far: 'High chase', fixed: 'Fixed north' };

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
      this.camera = new THREE.PerspectiveCamera(40, 1, 2, 1400);
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
      if (k === 'weather' || k == null) this.rain.setOn(s.weather && this.track && this.track.theme.rain);
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
      return m;
    }
    _paintSky(th) {
      const g = this.sky.geometry, p = g.attributes.position, c = g.attributes.color;
      const top = new THREE.Color(th.sky).multiplyScalar(0.78), hor = new THREE.Color(th.fog), gnd = new THREE.Color(th.ground).multiplyScalar(0.9);
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
      const th = track.theme;
      this.scene.background = new THREE.Color(th.fog);
      this.scene.fog = new THREE.Fog(th.fog, th.fogNear || 170, th.fogFar || 560);
      this.hemi.color.set(th.hemiSky || 0xe6f4ff);
      this.hemi.groundColor.set(th.ground).multiplyScalar(0.8);
      this.hemi.intensity = th.hemiI || 1.6;
      this.sun.color.set(th.sunCol || 0xfff1d8);
      this.sun.intensity = th.sunI || 2.3;
      this._paintSky(th);
      this.rain.setOn(ST().weather && th.rain);
      this.lightsState = -1;
      this.fx.clear();
      this.skids.clear();
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
      const y = tr.heightAt(q.i, q.lat);
      m.root.position.set(rs.x, y, rs.z);
      m.root.rotation.y = rs.h;
      // Bank tilt relative to the car's heading.
      const dh = U.wrapAngle(rs.h - tr.H[q.i]);
      const bk = Math.abs(q.lat) <= q.hw ? tr.BK[q.i] : 0;
      m.tilt.rotation.z = U.damp(m.tilt.rotation.z, -bk * Math.cos(dh), 10, dt);
      m.tilt.rotation.x = U.damp(m.tilt.rotation.x, bk * Math.sin(dh), 10, dt);
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
      m.spinA += (vLong / 0.33 + (rs.spin & 12 ? 25 : 0)) * dt;
      // All four wheels are ONE InstancedMesh: compose steer (Y) then spin (X).
      const d = m.wheelDummy;
      for (let i = 0; i < 4; i++) {
        const wh = m.wheels[i];
        if (!(rs.lock & (1 << i))) wh.spin = m.spinA;
        d.position.set(wh.x, 0.33, wh.z);
        d.rotation.set(wh.spin, i < 2 ? rs.steer : 0, 0, 'YXZ');
        d.updateMatrix();
        m.wheelMesh.setMatrixAt(i, d.matrix);
      }
      m.wheelMesh.instanceMatrix.needsUpdate = true;
      // Brake + reverse lights (vertex-colour range, no extra draw calls).
      const braking = (rs.brk > 0.3 && speed > 0.6) || rs.hb > 0;
      G.CarModel.setLights(m, braking ? 1 : 0, rs.gear === -1 ? 1 : 0);
      m.root.visible = !(rs.ghost > 0 && Math.floor(this.time * 12) % 2);
      this._emit(m, rs, dt, speed, sinH, cosH, y, braking);
    }

    _emit(m, rs, dt, speed, sinH, cosH, y, braking) {
      const fx = this.fx;
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
          if (rear && slip > 0.4 && Math.random() < dt * 20) fx.emit('debris', wx, y + 0.2, wz, bvx * 1.5 + (Math.random() - 0.5) * 3, 1 + Math.random() * 2, bvz * 1.5 + (Math.random() - 0.5) * 3, 0.8, sf.id === 'sand' ? [0.85, 0.72, 0.5] : [0.52, 0.36, 0.22]);
          this.skids.add(key, wx, y + 0.05, wz, 0.3, rear && (slip > 0.2 || speed > 12) ? 0.22 : 0, [0.35, 0.22, 0.12]);
        } else if (sf.fx === 'grass') {
          if (speed > 4 && Math.random() < (0.3 + slip) * dt * 30) fx.emit('grass', wx, y + 0.2, wz, bvx + (Math.random() - 0.5) * 2, 1.5, bvz + (Math.random() - 0.5) * 2, 1);
          this.skids.add(key, wx, y + 0.05, wz, 0.3, speed > 6 ? 0.25 : 0, [0.2, 0.3, 0.12]);
        } else if (sf.fx === 'spray') {
          if (speed > 6 && Math.random() < (speed / 30 + slip) * dt * 34) fx.emit('spray', wx, y + 0.2, wz, bvx * 2, 0.3 + speed * 0.02, bvz * 2, 0.6 + speed / 40);
          this.skids.add(key, wx, y + 0.06, wz, 0.24, slip > 0.35 ? 0.25 : 0, [0.1, 0.12, 0.14]);
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
      if (rs.overheat && Math.random() < dt * 25) fx.emit('steam', rs.x + sinH * 1.5, y + 1, rs.z + cosH * 1.5, 0, 0.5, 0, 1);
      if (rs.wallHit > 800) {
        for (let k = 0; k < 6; k++) fx.emit('spark', rs.x, y + 0.5, rs.z, (Math.random() - 0.5) * 8, 2 + Math.random() * 3, (Math.random() - 0.5) * 8, 1);
      }
      // brake-light glow + underglow (one-frame additive sprites)
      if (braking) {
        for (const t of m.tailLocal) {
          const [tx, ty, tz] = W(t[0], t[1], t[2]);
          fx.emit('glow', tx, ty, tz, 0, 0, 0, 0.9, [1, 0.1, 0.05]);
        }
      }
      if (m.glowRGB) {
        for (const lz of [-1.2, 0, 1.2]) {
          const [gx, gy, gz] = W(0, 0.12, lz);
          fx.emit('glow', gx, gy, gz, 0, 0, 0, 3.2, m.glowRGB);
        }
      }
    }

    // Confetti burst over a car (finishing, podiums).
    confetti(id, n) {
      const m = this.models.get(id);
      if (!m) return;
      const p = m.root.position;
      const cols = [[1, 0.8, 0], [1, 0.24, 0.5], [0.16, 0.83, 1], [0.18, 0.88, 0.48], [1, 1, 1]];
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
      for (let k = 0; k < n; k++) this.fx.emit('spark', x, 0.6, z, (Math.random() - 0.5) * 9, 2 + Math.random() * 3, (Math.random() - 0.5) * 9, 1);
    }

    // Body-coloured bits flying off in a big contact.
    debris(x, z, colors, n) {
      for (let k = 0; k < n; k++) {
        const c = colors[k % colors.length];
        this.fx.emit('debris', x, 0.7, z, (Math.random() - 0.5) * 10, 2 + Math.random() * 4, (Math.random() - 0.5) * 10, 0.7 + Math.random() * 0.6, c);
      }
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
      const P = CAMS[c.mode] || CAMS.follow;
      const speed = Math.hypot(rs.vx, rs.vz);
      const vdir = speed > 3 ? Math.atan2(rs.vx, rs.vz) : rs.h;
      const la = U.clamp(speed * (o && o.lead != null ? o.lead : P[3]), 0, 15);
      const tx = rs.x + Math.sin(vdir) * la, tz = rs.z + Math.cos(vdir) * la;
      if (c.snap) {
        c.fx = tx; c.fz = tz; c.yaw = rs.h; c.snap = false;
      }
      c.fx = U.damp(c.fx, tx, 6, dt);
      c.fz = U.damp(c.fz, tz, 6, dt);
      const yawT = c.mode === 'fixed' && !o ? 0 : speed > 3 ? U.lerpAngle(rs.h, vdir, 0.6) : rs.h;
      c.yaw = U.lerpAngle(c.yaw, yawT, 1 - Math.exp(-2.4 * dt));
      c.dist = U.damp(c.dist, o && o.dist ? o.dist + speed * 0.1 : P[0] + speed * P[1], 2, dt);
      // speed feel: FOV opens up and the camera buzzes on rough ground
      const s = ST();
      const fovT = !o && s.fovKick ? 40 + U.clamp((speed - 15) / 35, 0, 1) * 7 : 40;
      if (!o && s.shake) {
        if (speed > 38) c.shake = Math.max(c.shake, (speed - 38) * 0.004);
        let rough = 0;
        if (rs.surf) for (let i = 0; i < 4; i++) rough += G.SURF[rs.surf[i] || 0].rough;
        if (rough > 0.3 && speed > 8) c.shake = Math.max(c.shake, rough * 0.03 * Math.min(1, speed / 25));
      }
      this._fov(fovT, dt);
      this._place(c.fx, c.fz, c.yaw, c.dist, (o && o.pitch) || P[2], dt);
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
      this._fov(40, dt);
      this._place(c.fx, c.fz, c.yaw, c.dist, 58, dt);
    }

    orbit(x, z, dt, dist, pitch, speed) {
      const c = this.cam;
      c.yaw += dt * (speed == null ? 0.12 : speed);
      c.fx = U.damp(c.fx, x, 3, dt);
      c.fz = U.damp(c.fz, z, 3, dt);
      c.dist = U.damp(c.dist, dist || 60, 3, dt);
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
      this.camera.position.set(fx - Math.sin(yaw) * hd + sx, hy + sy, fz - Math.cos(yaw) * hd + sz);
      this.camera.lookAt(fx + sx * 0.5, lookY || 0, fz + sz * 0.5);
      // Sun + shadow frustum follow the focus point (tight frustum = sharp shadows).
      this.sun.position.set(fx + 40, 90, fz + 25);
      this.sun.target.position.set(fx, 0, fz);
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
      this.rain.update(dt, this.cam.fx, this.cam.fz);
      const anim = this.trackGroup && this.trackGroup.userData.anim;
      if (anim) anim(this.time, dt);
      this.sky.position.copy(this.camera.position);
      this.renderer.render(this.scene, this.camera);
      this.frameMs = U.lerp(this.frameMs, performance.now() - t0, 0.1);
      this._governor(dt);
    }

    // Adaptive quality: if we average under ~52 fps for 2 s, step down
    // (resolution -> shadows -> particle budget). Steps back up if we have headroom.
    _governor(dt) {
      this.fpsT += dt;
      this.fpsN++;
      if (this.fpsT >= 1) {
        this.fps = this.fpsN / this.fpsT;
        this.fpsT = 0;
        this.fpsN = 0;
        if (this.quality !== 'auto' || document.hidden) return;
        if (this.fps < 52) this.slowT++;
        else if (this.fps > 58.5) this.slowT = Math.min(0, this.slowT - 0.25);
        else this.slowT = 0;
        if (this.slowT >= 2 && this.level < 5) {
          this.level++;
          this.slowT = 0;
          this._applyLevel();
        } else if (this.slowT <= -12 && this.level > 0) {
          this.level--;
          this.slowT = 0;
          this._applyLevel();
        }
      }
    }

    stats() {
      const i = this.renderer.info;
      return { fps: this.fps, calls: i.render.calls, tris: i.render.triangles, level: this.level, pr: this.pr, tier: this.tier, gpu: this.gpu.name, ms: this.frameMs, parts: this.fx.norm.live + this.fx.add.live };
    }
  }

  World.CAMS = CAMS;
  World.CAM_NAMES = CAM_NAMES;
  G.World = World;
})(window.G);
