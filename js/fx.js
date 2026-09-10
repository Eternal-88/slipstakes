// fx.js — pooled particles (one draw call) and ring-buffer skidmarks (one draw call).
'use strict';
(function (G) {
  const U = G.U;

  const MAX = 1400;
  const TYPES = {
    smoke: { life: 1.5, size0: 1.2, size1: 4.2, col: [0.93, 0.93, 0.95], a: 0.42, rise: 0.8, drag: 1.6, grav: 0 },
    dust: { life: 1.8, size0: 1.4, size1: 5.0, col: [0.84, 0.62, 0.42], a: 0.5, rise: 0.6, drag: 1.3, grav: 0 },
    sand: { life: 1.4, size0: 1.0, size1: 3.6, col: [0.92, 0.82, 0.62], a: 0.45, rise: 0.4, drag: 1.4, grav: 0 },
    grass: { life: 0.7, size0: 0.5, size1: 0.35, col: [0.34, 0.62, 0.28], a: 0.9, rise: 2.5, drag: 1.0, grav: 9 },
    spray: { life: 0.6, size0: 0.8, size1: 2.8, col: [0.78, 0.86, 0.96], a: 0.45, rise: 1.5, drag: 2.2, grav: 2 },
    spark: { life: 0.45, size0: 0.45, size1: 0.1, col: [1.0, 0.8, 0.3], a: 1.0, rise: 3, drag: 0.6, grav: 12 },
    flame: { life: 0.18, size0: 0.9, size1: 0.3, col: [1.0, 0.55, 0.12], a: 0.95, rise: 0.2, drag: 3.0, grav: 0 },
    steam: { life: 1.1, size0: 0.8, size1: 3.0, col: [0.97, 0.97, 1.0], a: 0.35, rise: 2.5, drag: 1.5, grav: 0 },
    confetti: { life: 2.2, size0: 0.55, size1: 0.45, col: [1, 1, 1], a: 1.0, rise: 7, drag: 0.9, grav: 6 },
  };

  class Particles {
    constructor(scene) {
      this.n = 0;
      this.pos = new Float32Array(MAX * 3);
      this.col = new Float32Array(MAX * 3);
      this.size = new Float32Array(MAX);
      this.alpha = new Float32Array(MAX);
      this.vel = new Float32Array(MAX * 3);
      this.age = new Float32Array(MAX);
      this.type = new Array(MAX);
      this.head = 0;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
      g.setDrawRange(0, MAX);
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { scale: { value: 600 } },
        vertexShader: `
          attribute float size; attribute float alpha; attribute vec3 color;
          varying float vA; varying vec3 vC; uniform float scale;
          void main(){ vA = alpha; vC = color;
            vec4 mv = modelViewMatrix * vec4(position,1.0);
            gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `
          varying float vA; varying vec3 vC;
          void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d);
            if (r > 0.25) discard; float e = smoothstep(0.25, 0.12, r);
            gl_FragColor = vec4(vC, vA * e); }`,
      });
      this.mat = mat;
      this.points = new THREE.Points(g, mat);
      this.points.frustumCulled = false;
      this.geo = g;
      scene.add(this.points);
      for (let i = 0; i < MAX; i++) this.alpha[i] = 0;
      this.budget = 1; // scaled down by the quality governor
    }
    // rgb (optional) overrides the type's colour (confetti).
    emit(type, x, y, z, vx, vy, vz, sizeMul, rgb) {
      if (this.budget < 1 && Math.random() > this.budget) return;
      const T = TYPES[type];
      const i = this.head;
      this.head = (this.head + 1) % MAX;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy + T.rise; this.vel[i * 3 + 2] = vz;
      this.age[i] = 0;
      this.type[i] = T;
      this.size[i] = T.size0 * (sizeMul || 1);
      const c = rgb || T.col;
      this.col[i * 3] = c[0]; this.col[i * 3 + 1] = c[1]; this.col[i * 3 + 2] = c[2];
      this.alpha[i] = T.a;
      this._sm = sizeMul || 1;
      this.sizeMul = this.sizeMul || new Float32Array(MAX);
      this.sizeMul[i] = sizeMul || 1;
    }
    update(dt) {
      const sm = this.sizeMul;
      for (let i = 0; i < MAX; i++) {
        const T = this.type[i];
        if (!T || this.alpha[i] <= 0) continue;
        const a = (this.age[i] += dt);
        const k = a / T.life;
        if (k >= 1) {
          this.alpha[i] = 0;
          this.type[i] = null;
          continue;
        }
        const d = Math.exp(-T.drag * dt);
        this.vel[i * 3] *= d; this.vel[i * 3 + 2] *= d;
        this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - T.grav * dt;
        this.pos[i * 3] += this.vel[i * 3] * dt;
        this.pos[i * 3 + 1] = Math.max(0.05, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
        this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
        this.size[i] = U.lerp(T.size0, T.size1, Math.sqrt(k)) * (sm ? sm[i] : 1);
        this.alpha[i] = T.a * (1 - k) * (k < 0.1 ? k * 10 : 1);
        if (T === TYPES.flame) {
          this.col[i * 3 + 1] = 0.55 * (1 - k) + 0.15;
        }
      }
      const g = this.geo.attributes;
      g.position.needsUpdate = true;
      g.color.needsUpdate = true;
      g.size.needsUpdate = true;
      g.alpha.needsUpdate = true;
    }
    clear() {
      for (let i = 0; i < MAX; i++) {
        this.alpha[i] = 0;
        this.type[i] = null;
      }
    }
    setScale(h) {
      this.mat.uniforms.scale.value = h * 0.9;
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
      this.minI = SKID_MAX; this.maxI = -1;
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
      this.dirty = true;
    }
    update() {
      if (!this.dirty) return;
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
      this.dirty = false;
    }
    clear() {
      this.pos.fill(0);
      this.col.fill(0);
      this.last = {};
      this.dirty = true;
      this.update();
    }
  }

  G.FX = { Particles, Skids, TYPES };
})(window.G);
