// fx.js — pooled particles (two draw calls: a normal-blended pass for smoke /
// dust / debris and an ADDITIVE pass for sparks, flames, brake-light and
// underglow glows), ring-buffer skidmarks (one draw call) and rain streaks
// (one draw call, only on wet tracks).
'use strict';
(function (G) {
  const U = G.U;

  const TYPES = {
    smoke: { life: 1.3, size0: 1.0, size1: 3.6, col: [0.93, 0.93, 0.95], a: 0.3, rise: 0.8, drag: 1.6, grav: 0 },
    dust: { life: 1.9, size0: 1.4, size1: 5.2, col: [0.84, 0.62, 0.42], a: 0.5, rise: 0.6, drag: 1.3, grav: 0 },
    sand: { life: 1.4, size0: 1.0, size1: 3.8, col: [0.92, 0.82, 0.62], a: 0.45, rise: 0.4, drag: 1.4, grav: 0 },
    grass: { life: 0.7, size0: 0.5, size1: 0.35, col: [0.34, 0.62, 0.28], a: 0.9, rise: 2.5, drag: 1.0, grav: 9 },
    spray: { life: 0.65, size0: 0.8, size1: 3.0, col: [0.78, 0.86, 0.96], a: 0.45, rise: 1.5, drag: 2.2, grav: 2 },
    steam: { life: 1.1, size0: 0.8, size1: 3.0, col: [0.97, 0.97, 1.0], a: 0.35, rise: 2.5, drag: 1.5, grav: 0 },
    puff: { life: 0.8, size0: 0.45, size1: 1.8, col: [0.5, 0.5, 0.53], a: 0.3, rise: 0.7, drag: 2.2, grav: 0 },
    debris: { life: 1.5, size0: 0.3, size1: 0.24, col: [0.4, 0.4, 0.4], a: 1.0, rise: 3.5, drag: 0.4, grav: 15, solid: 1 },
    confetti: { life: 2.4, size0: 0.55, size1: 0.45, col: [1, 1, 1], a: 1.0, rise: 7, drag: 0.9, grav: 6, solid: 1 },
    // additive
    spark: { life: 0.5, size0: 0.5, size1: 0.1, col: [1.0, 0.75, 0.3], a: 1.0, rise: 3, drag: 0.6, grav: 12, add: 1 },
    flame: { life: 0.2, size0: 1.0, size1: 0.3, col: [1.0, 0.5, 0.12], a: 0.95, rise: 0.2, drag: 3.0, grav: 0, add: 1 },
    glow: { life: 0.045, size0: 1.3, size1: 1.3, col: [1, 0.1, 0.05], a: 0.55, rise: 0, drag: 0, grav: 0, add: 1, flat: 1 },
    firework: { life: 1.3, size0: 1.0, size1: 0.2, col: [1, 1, 1], a: 1.0, rise: 0, drag: 1.1, grav: 4, add: 1 },
  };

  class Particles {
    constructor(scene, opts) {
      const MAX = (this.MAX = opts.max);
      this.additive = !!opts.additive;
      this.pos = new Float32Array(MAX * 3);
      this.col = new Float32Array(MAX * 3);
      this.size = new Float32Array(MAX);
      this.alpha = new Float32Array(MAX);
      this.vel = new Float32Array(MAX * 3);
      this.age = new Float32Array(MAX);
      this.sm = new Float32Array(MAX);
      this.type = new Array(MAX);
      this.head = 0;
      this.live = 0;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
      g.setDrawRange(0, MAX);
      // Normal pass: soft discs, lit from above (lighter top half) so smoke
      // reads as volume. Additive pass: a hot core fading to the edge.
      const frag = this.additive
        ? `varying float vA; varying vec3 vC;
           void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d);
             if (r > 0.25) discard; float e = smoothstep(0.25, 0.0, r);
             gl_FragColor = vec4(vC * (0.6 + 0.8 * e), vA * e); }`
        : `varying float vA; varying vec3 vC;
           void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d);
             if (r > 0.25) discard; float e = smoothstep(0.25, 0.1, r);
             float shade = 1.0 - d.y * 0.4;
             gl_FragColor = vec4(vC * shade, vA * e); }`;
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: this.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        uniforms: { scale: { value: 600 } },
        vertexShader: `
          attribute float size; attribute float alpha; attribute vec3 color;
          varying float vA; varying vec3 vC; uniform float scale;
          void main(){ vA = alpha; vC = color;
            vec4 mv = modelViewMatrix * vec4(position,1.0);
            gl_PointSize = min(size * scale / -mv.z, 256.0); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: frag,
      });
      this.mat = mat;
      this.points = new THREE.Points(g, mat);
      this.points.frustumCulled = false;
      this.points.renderOrder = this.additive ? 3 : 2;
      this.geo = g;
      scene.add(this.points);
      this.budget = 1; // scaled down by the quality governor / settings
      this._idle = false;
    }
    // rgb (optional) overrides the type's colour (confetti, debris, glows).
    emit(type, x, y, z, vx, vy, vz, sizeMul, rgb) {
      const T = TYPES[type];
      if (this.budget < 1 && !T.flat && Math.random() > this.budget) return;
      // Cap LIVE particles by budget too: eight cars on dirt saturated the
      // whole 1500 pool even at a 0.6 spawn budget (overdraw = GPU time).
      if (!T.flat && this.live >= this.MAX * Math.max(0.25, this.budget)) return;
      const i = this.head;
      this.head = (this.head + 1) % this.MAX;
      if (!this.type[i]) this.live++;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy + T.rise; this.vel[i * 3 + 2] = vz;
      this.age[i] = 0;
      this.type[i] = T;
      this.sm[i] = sizeMul || 1;
      this.size[i] = T.size0 * this.sm[i];
      const c = rgb || T.col;
      // a little per-particle variation so clouds of dust aren't one flat colour
      const v = T.solid || T.add ? 1 : 0.94 + Math.random() * 0.1;
      this.col[i * 3] = c[0] * v; this.col[i * 3 + 1] = c[1] * v; this.col[i * 3 + 2] = c[2] * v;
      this.alpha[i] = T.flat ? T.a : 0;
      this._idle = false;
    }
    update(dt) {
      if (this._idle) return;
      const MAX = this.MAX;
      for (let i = 0; i < MAX; i++) {
        const T = this.type[i];
        if (!T) continue;
        if (T.flat) {
          // one-frame sprites (glows): drawn for exactly one frame, re-emitted
          // by whoever wants them every frame
          if (this.age[i] >= 1) {
            this.alpha[i] = 0;
            this.type[i] = null;
            this.live--;
          } else this.age[i] = 1;
          continue;
        }
        const a = (this.age[i] += dt);
        const k = a / T.life;
        if (k >= 1) {
          this.alpha[i] = 0;
          this.type[i] = null;
          this.live--;
          continue;
        }
        if (!T.flat) {
          const d = Math.exp(-T.drag * dt);
          this.vel[i * 3] *= d; this.vel[i * 3 + 2] *= d;
          this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - T.grav * dt;
          this.pos[i * 3] += this.vel[i * 3] * dt;
          this.pos[i * 3 + 1] = Math.max(0.05, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
          this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
          this.size[i] = U.lerp(T.size0, T.size1, Math.sqrt(k)) * this.sm[i];
          this.alpha[i] = T.a * (1 - k) * (k < 0.08 ? k * 12.5 : 1);
          if (T === TYPES.flame) this.col[i * 3 + 1] = 0.5 * (1 - k) + 0.12;
        }
      }
      if (this.live <= 0) {
        this.live = 0;
        this._idle = true; // nothing alive: skip the loop AND the GPU upload next frame
      }
      const g = this.geo.attributes;
      g.position.needsUpdate = true;
      g.color.needsUpdate = true;
      g.size.needsUpdate = true;
      g.alpha.needsUpdate = true;
    }
    clear() {
      for (let i = 0; i < this.MAX; i++) {
        this.alpha[i] = 0;
        this.type[i] = null;
      }
      this.live = 0;
      this._idle = false;
    }
    setScale(h) {
      this.mat.uniforms.scale.value = h * 0.9;
    }
  }

  // Facade: routes each type to the right pass.
  class System {
    constructor(scene) {
      this.norm = new Particles(scene, { max: 1500 });
      this.add = new Particles(scene, { max: 700, additive: true });
      this._budget = 1;
    }
    get budget() {
      return this._budget;
    }
    set budget(v) {
      this._budget = v;
      this.norm.budget = v;
      this.add.budget = v;
    }
    emit(type, x, y, z, vx, vy, vz, s, rgb) {
      (TYPES[type].add ? this.add : this.norm).emit(type, x, y, z, vx, vy, vz, s, rgb);
    }
    update(dt) {
      this.norm.update(dt);
      this.add.update(dt);
    }
    clear() {
      this.norm.clear();
      this.add.clear();
    }
    setScale(h) {
      this.norm.setScale(h);
      this.add.setScale(h);
    }
  }

  // Skidmarks: fixed pool of quads; oldest overwritten first.
  const SKID_MAX = 2400;
  class Skids {
    constructor(scene) {
      this.pos = new Float32Array(SKID_MAX * 6 * 3);
      this.col = new Float32Array(SKID_MAX * 6 * 4);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
      this.geo = g;
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.frustumCulled = false;
      m.renderOrder = 1;
      scene.add(m);
      this.mesh = m;
      this.head = 0;
      this.last = {}; // key -> [x,z]
      this.dirty = false;
      this.lo = SKID_MAX;
      this.hi = -1;
    }
    // Continue the mark for wheel `key` to (x,z). alpha 0 breaks the mark.
    add(key, x, y, z, width, alpha, rgb) {
      const L = this.last[key];
      if (!L || alpha <= 0.02) {
        this.last[key] = alpha > 0.02 ? [x, z] : null;
        return;
      }
      const dx = x - L[0], dz = z - L[1];
      const d = Math.hypot(dx, dz);
      if (d < 0.35) return;
      if (d > 3) {
        this.last[key] = [x, z];
        return;
      }
      const nx = (-dz / d) * width * 0.5, nz = (dx / d) * width * 0.5;
      const i = this.head;
      this.head = (this.head + 1) % SKID_MAX;
      const p = this.pos, o = i * 18;
      const A = [L[0] + nx, y, L[1] + nz], B = [L[0] - nx, y, L[1] - nz], C2 = [x - nx, y, z - nz], D = [x + nx, y, z + nz];
      const tri = [A, B, C2, A, C2, D];
      for (let k = 0; k < 6; k++) {
        p[o + k * 3] = tri[k][0]; p[o + k * 3 + 1] = tri[k][1]; p[o + k * 3 + 2] = tri[k][2];
        const c = i * 24 + k * 4;
        this.col[c] = rgb[0]; this.col[c + 1] = rgb[1]; this.col[c + 2] = rgb[2]; this.col[c + 3] = alpha;
      }
      this.last[key] = [x, z];
      this.lo = Math.min(this.lo, i);
      this.hi = Math.max(this.hi, i);
      this.dirty = true;
    }
    // Upload only the quads written since last frame (usually a handful).
    update() {
      if (!this.dirty) return;
      const a = this.geo.attributes;
      if (this.hi >= this.lo) {
        a.position.updateRange.offset = this.lo * 18;
        a.position.updateRange.count = (this.hi - this.lo + 1) * 18;
        a.color.updateRange.offset = this.lo * 24;
        a.color.updateRange.count = (this.hi - this.lo + 1) * 24;
      }
      a.position.needsUpdate = true;
      a.color.needsUpdate = true;
      this.dirty = false;
      this.lo = SKID_MAX;
      this.hi = -1;
    }
    clear() {
      this.pos.fill(0);
      this.col.fill(0);
      this.last = {};
      const a = this.geo.attributes;
      a.position.updateRange.count = -1;
      a.color.updateRange.count = -1;
      a.position.needsUpdate = true;
      a.color.needsUpdate = true;
      this.dirty = false;
      this.lo = SKID_MAX;
      this.hi = -1;
    }
  }

  // Rain: line segments recycled in a box around the camera focus.
  class Rain {
    constructor(scene, n) {
      this.n = n;
      this.pos = new Float32Array(n * 6);
      this.v = new Float32Array(n);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
      this.geo = g;
      this.mesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xc9d8ea, transparent: true, opacity: 0.45, depthWrite: false }));
      this.mesh.frustumCulled = false;
      this.mesh.visible = false;
      scene.add(this.mesh);
      this.cx = 0;
      this.cz = 0;
      for (let i = 0; i < n; i++) this._reset(i, true);
    }
    _reset(i, anyY) {
      const R = 42;
      const x = this.cx + (Math.random() * 2 - 1) * R, z = this.cz + (Math.random() * 2 - 1) * R;
      const y = anyY ? Math.random() * 30 : 26 + Math.random() * 6;
      const p = this.pos, o = i * 6;
      p[o] = x; p[o + 1] = y; p[o + 2] = z;
      p[o + 3] = x + 0.12; p[o + 4] = y + 1.1; p[o + 5] = z + 0.05;
      this.v[i] = 26 + Math.random() * 8;
    }
    update(dt, cx, cz) {
      if (!this.mesh.visible) return;
      this.cx = cx;
      this.cz = cz;
      const p = this.pos;
      for (let i = 0; i < this.n; i++) {
        const o = i * 6, dy = this.v[i] * dt;
        p[o + 1] -= dy;
        p[o + 4] -= dy;
        if (p[o + 1] < 0 || Math.abs(p[o] - cx) > 48 || Math.abs(p[o + 2] - cz) > 48) this._reset(i, false);
      }
      this.geo.attributes.position.needsUpdate = true;
    }
    setOn(on) {
      this.mesh.visible = !!on;
    }
  }

  G.FX = { System, Particles, Skids, Rain, TYPES };
})(window.G);
