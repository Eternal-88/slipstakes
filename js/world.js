// world.js — renderer, lights, camera rig, car models, particle/skid emission,
// and an adaptive quality governor aimed at 60 fps on integrated graphics.
'use strict';
(function (G) {
  const U = G.U;

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

  class World {
    constructor(canvas) {
      this.canvas = canvas;
      this.quality = U.store.get('ss.quality', 'auto'); // auto | high | medium | low
      this.gpu = gpuTier();
      const q = this.quality === 'auto' ? (this.gpu.low ? 'medium' : 'high') : this.quality;
      this.tier = q;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q !== 'low', powerPreference: 'high-performance', stencil: false });
      this.maxPR = q === 'high' ? Math.min(window.devicePixelRatio || 1, 1.5) : q === 'medium' ? 1 : 0.75;
      this.pr = this.maxPR;
      this.renderer.setPixelRatio(this.pr);
      this.renderer.shadowMap.enabled = q !== 'low';
      // Soft PCF is the single most expensive thing we draw (shadows = half the
      // GPU frame on the test machine); plain PCF on anything but "high".
      this.renderer.shadowMap.type = q === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
      this.renderer.shadowMap.autoUpdate = true;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(40, 1, 2, 1400);
      this.hemi = new THREE.HemisphereLight(0xe6f4ff, 0x7a8f5a, 1.6);
      this.sun = new THREE.DirectionalLight(0xfff1d8, 2.3);
      this.sun.castShadow = true;
      const sc = this.sun.shadow.camera;
      sc.left = -48; sc.right = 48; sc.top = 48; sc.bottom = -48; sc.near = 5; sc.far = 240;
      const ms = q === 'high' ? 2048 : 1024;
      this.sun.shadow.mapSize.set(ms, ms);
      this.sun.shadow.bias = -0.0005;
      this.sun.shadow.normalBias = 0.05;
      this.scene.add(this.hemi, this.sun, this.sun.target);
      this.fx = new G.FX.Particles(this.scene);
      if (q !== 'high') this.fx.budget = 0.75; // particles are fill-rate heavy on integrated GPUs
      this.skids = new G.FX.Skids(this.scene);
      this.models = new Map();
      this.cam = { yaw: 0, fx: 0, fz: 0, dist: 38, shake: 0, mode: U.store.get('ss.cam', 'follow'), freeYaw: 0, freeDist: 60, fvx: 0, fvz: 0 };
      this.q = {};
      this.time = 0;
      this.fpsT = 0; this.fpsN = 0; this.fps = 60; this.slowT = 0; this.level = 0;
      window.addEventListener('resize', () => this.resize());
      canvas.addEventListener('wheel', (e) => {
        this.cam.freeDist = U.clamp(this.cam.freeDist * (e.deltaY > 0 ? 1.1 : 0.9), 20, 220);
      }, { passive: true });
      this.resize();
    }

    resize() {
      const w = window.innerWidth, h = window.innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.fx.setScale(h * this.pr);
    }

    loadTrack(track) {
      if (this.trackGroup) {
        this.scene.remove(this.trackGroup);
        this.trackGroup.traverse((o) => {
          if (o.geometry && !o.isInstancedMesh) o.geometry.dispose();
        });
      }
      this.track = track;
      this.trackGroup = G.TrackMesh.build(track);
      // Below "high", only cars cast shadows: the shadow pass was half the GPU
      // frame, and scenery shadows matter far less than the car's own.
      if (this.tier !== 'high') this.trackGroup.traverse((o) => { if (o.isMesh) o.castShadow = false; });
      this.scene.add(this.trackGroup);
      const th = track.theme;
      this.scene.background = new THREE.Color(th.sky);
      this.scene.fog = new THREE.Fog(th.fog, 170, 560);
      this.hemi.groundColor.set(th.ground).multiplyScalar(0.8);
      this.fx.clear();
      this.skids.clear();
    }

    // list: [{id, carId, color, parts}] — (re)builds models whose look changed.
    setCars(list) {
      const keep = new Set();
      for (const c of list) {
        keep.add(c.id);
        const key = c.carId + '|' + c.color + '|' + JSON.stringify(c.parts || {});
        const m = this.models.get(c.id);
        if (m && m.key === key) continue;
        if (m) {
          this.scene.remove(m.root);
          G.CarModel.dispose(m);
        }
        const nm = G.CarModel.build(c.carId, c.color, c.parts);
        nm.key = key;
        nm.id = c.id;
        nm.hint = -1;
        nm.bump = G.Parts.opt('suspension', (c.parts && c.parts.suspension) || 'stock').bump;
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
    // rs: {x,z,h,vx,vz,w,steer,ax,ay,rpm,boost,spin,lock,slip[4],surf[4],wallHit,backfire,overheat,ghost}
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
      // Wheels: steer + spin.
      const sinH = Math.sin(rs.h), cosH = Math.cos(rs.h);
      const vLong = rs.vx * sinH + rs.vz * cosH;
      m.spinA += ((vLong / 0.33) + ((rs.spin & 12) ? 25 : 0)) * dt;
      for (let i = 0; i < 4; i++) {
        const wh = m.wheels[i];
        if (i < 2) wh.steer.rotation.y = rs.steer;
        wh.mesh.rotation.x = (rs.lock & (1 << i)) ? wh.mesh.rotation.x : m.spinA;
      }
      m.root.visible = !(rs.ghost > 0 && Math.floor(this.time * 12) % 2);
      this._emit(m, rs, dt, speed, sinH, cosH, y);
    }

    _emit(m, rs, dt, speed, sinH, cosH, y) {
      const fx = this.fx;
      for (let i = 0; i < 4; i++) {
        const [lx, lz] = m.wheelLocal[i];
        const wx = rs.x + sinH * lz + cosH * lx, wz = rs.z + cosH * lz - sinH * lx;
        const sf = G.SURF[rs.surf[i] || 0];
        const slip = rs.slip[i] || 0;
        const rear = i >= 2;
        const key = m.id + ':' + i;
        const back = -1.5;
        const bvx = sinH * back * speed * 0.2, bvz = cosH * back * speed * 0.2;
        if (sf.fx === 'smoke') {
          if (slip > 0.3 && Math.random() < slip * dt * 55) fx.emit('smoke', wx, y + 0.25, wz, bvx + (Math.random() - 0.5), 0, bvz + (Math.random() - 0.5), 0.8 + slip);
          this.skids.add(key, wx, y + 0.06, wz, 0.26, slip > 0.32 ? Math.min(0.55, slip * 0.6) : 0, [0.08, 0.08, 0.09]);
        } else if (sf.fx === 'dust') {
          const amt = (rear ? Math.min(speed / 25, 1) * 0.5 : 0) + slip;
          if (speed > 4 && Math.random() < amt * dt * 40) fx.emit(sf.id === 'sand' ? 'sand' : 'dust', wx, y + 0.3, wz, bvx * 2 + (Math.random() - 0.5) * 2, 0.5, bvz * 2 + (Math.random() - 0.5) * 2, 0.7 + slip);
          this.skids.add(key, wx, y + 0.05, wz, 0.3, rear && (slip > 0.2 || speed > 12) ? 0.22 : 0, [0.35, 0.22, 0.12]);
        } else if (sf.fx === 'grass') {
          if (speed > 4 && Math.random() < (0.3 + slip) * dt * 30) fx.emit('grass', wx, y + 0.2, wz, bvx + (Math.random() - 0.5) * 2, 1.5, bvz + (Math.random() - 0.5) * 2, 1);
          this.skids.add(key, wx, y + 0.05, wz, 0.3, speed > 6 ? 0.25 : 0, [0.2, 0.3, 0.12]);
        } else if (sf.fx === 'spray') {
          if (speed > 6 && Math.random() < (speed / 30 + slip) * dt * 30) fx.emit('spray', wx, y + 0.2, wz, bvx * 2, 0.3, bvz * 2, 0.6 + speed / 40);
          this.skids.add(key, wx, y + 0.06, wz, 0.24, slip > 0.35 ? 0.25 : 0, [0.1, 0.12, 0.14]);
        }
      }
      if (rs.backfire > 0 && Math.random() < 0.6) {
        for (const e of m.exhaust) {
          const ex = rs.x + sinH * e[2] + cosH * e[0], ez = rs.z + cosH * e[2] - sinH * e[0];
          fx.emit('flame', ex, y + e[1], ez, -sinH * 4, 0, -cosH * 4, 1);
        }
      }
      if (rs.overheat && Math.random() < dt * 25) fx.emit('steam', rs.x + sinH * 1.5, y + 1, rs.z + cosH * 1.5, 0, 0.5, 0, 1);
      if (rs.wallHit > 800) {
        for (let k = 0; k < 6; k++) fx.emit('spark', rs.x, y + 0.5, rs.z, (Math.random() - 0.5) * 8, 2 + Math.random() * 3, (Math.random() - 0.5) * 8, 1);
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

    sparks(x, z, n) {
      for (let k = 0; k < n; k++) this.fx.emit('spark', x, 0.6, z, (Math.random() - 0.5) * 9, 2 + Math.random() * 3, (Math.random() - 0.5) * 9, 1);
    }

    shake(a) {
      this.cam.shake = Math.max(this.cam.shake, a);
    }

    // Angled top-down chase: ~56° pitch, yaw follows the direction of travel,
    // focus leads the car along its velocity so you see corners coming.
    // o (optional): {pitch, dist, lead} overrides — the garage uses a lower,
    // closer camera so body roll and squat are easy to read.
    follow(rs, dt, o) {
      const c = this.cam;
      const speed = Math.hypot(rs.vx, rs.vz);
      const vdir = speed > 3 ? Math.atan2(rs.vx, rs.vz) : rs.h;
      const la = U.clamp(speed * (o && o.lead != null ? o.lead : 0.42), 0, 15);
      const tx = rs.x + Math.sin(vdir) * la, tz = rs.z + Math.cos(vdir) * la;
      if (c.snap) {
        c.fx = tx; c.fz = tz; c.yaw = rs.h; c.snap = false;
      }
      c.fx = U.damp(c.fx, tx, 6, dt);
      c.fz = U.damp(c.fz, tz, 6, dt);
      const yawT = c.mode === 'fixed' ? 0 : speed > 3 ? U.lerpAngle(rs.h, vdir, 0.6) : rs.h;
      c.yaw = U.lerpAngle(c.yaw, yawT, 1 - Math.exp(-2.4 * dt));
      c.dist = U.damp(c.dist, o && o.dist ? o.dist + speed * 0.1 : 31 + speed * 0.28, 2, dt);
      this._place(c.fx, c.fz, c.yaw, c.dist, (o && o.pitch) || 56, dt);
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
        if (mx || mz) target = null;
      }
      const sy = Math.sin(c.freeYaw), cy = Math.cos(c.freeYaw);
      c.fx += (sy * mz + cy * mx) * sp * dt;
      c.fz += (cy * mz - sy * mx) * sp * dt;
      c.yaw = U.lerpAngle(c.yaw, c.freeYaw, 1 - Math.exp(-6 * dt));
      c.dist = U.damp(c.dist, c.freeDist, 6, dt);
      this._place(c.fx, c.fz, c.yaw, c.dist, 58, dt);
    }

    orbit(x, z, dt, dist) {
      const c = this.cam;
      c.yaw += dt * 0.12;
      c.fx = U.damp(c.fx, x, 2, dt);
      c.fz = U.damp(c.fz, z, 2, dt);
      c.dist = U.damp(c.dist, dist || 60, 2, dt);
      this._place(c.fx, c.fz, c.yaw, c.dist, 42, dt);
    }

    _place(fx, fz, yaw, dist, pitchDeg, dt) {
      const c = this.cam;
      const p = (pitchDeg * Math.PI) / 180;
      let sx = 0, sz = 0;
      if (c.shake > 0.01) {
        sx = (Math.random() - 0.5) * c.shake;
        sz = (Math.random() - 0.5) * c.shake;
        c.shake *= Math.exp(-8 * dt);
      }
      const hd = Math.cos(p) * dist, hy = Math.sin(p) * dist;
      this.camera.position.set(fx - Math.sin(yaw) * hd + sx, hy, fz - Math.cos(yaw) * hd + sz);
      this.camera.lookAt(fx + sx * 0.5, 0, fz + sz * 0.5);
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
      return out;
    }

    render(dt) {
      this.time += dt;
      this.fx.update(dt);
      this.skids.update();
      this.renderer.render(this.scene, this.camera);
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
        if (this.quality !== 'auto') return;
        if (this.fps < 52) this.slowT++;
        else if (this.fps > 58.5) this.slowT = Math.min(0, this.slowT - 0.25);
        else this.slowT = 0;
        if (this.slowT >= 2 && this.level < 4) {
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
    _applyLevel() {
      const L = this.level;
      const pr = [this.maxPR, Math.min(this.maxPR, 1), 0.85, 0.75, 0.65][L];
      this.pr = pr;
      this.renderer.setPixelRatio(pr);
      this.resize();
      this.sun.castShadow = L < 3;
      this.fx.budget = L >= 4 ? 0.5 : this.tier === 'high' ? 1 : 0.75;
    }

    stats() {
      const i = this.renderer.info;
      return { fps: this.fps, calls: i.render.calls, tris: i.render.triangles, level: this.level, pr: this.pr, tier: this.tier, gpu: this.gpu.name };
    }
  }

  G.World = World;
})(window.G);
