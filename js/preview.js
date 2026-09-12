// preview.js — the garage's LIVE HANDLING PREVIEW. An aggressive bot drives the
// candidate build around the Proving Ground (hairpin, fast sweeper, kerbed
// chicane, wet patch, dirt patch) using the real physics. Change a part or a
// setup slider and the car's spec is swapped in place, mid-lap: you watch the
// same corner get taken differently. Metrics shown: last lap, peak slide
// angle, top speed. In the Paint tab it parks and becomes a turntable.
'use strict';
(function (G) {
  const U = G.U, P = G.Physics;

  const Preview = {
    active: false,
    world: null,
    showroom: false,

    start(world, garage, color) {
      this.world = world;
      this.track = G.getTrack('proving');
      if (world.track !== this.track) world.loadTrack(this.track);
      const slot = this.track.pointAt(this.track.length - 30, 0);
      this.st = P.createCar(slot.x, slot.z, slot.h);
      this.st.hint = slot.i;
      // Previous-step pose for render interpolation. Must exist BEFORE the first
      // physics step: on a frame with no step, lerp(undefined, x) = NaN, and a
      // NaN fed to the snapping chase camera never recovers (screen = sky).
      this.px = slot.x;
      this.pz = slot.z;
      this.ph = slot.h;
      this.bot = new G.Bot(0.97, 5, { aggressive: true });
      this.color = color;
      this.key = null;
      this.specKey = null;
      this.acc = 0;
      this.q = {};
      this.lastAlong = null;
      this.lapT = 0;
      this.m = { lastLap: null, peakB: 0, vmax: 0, curPeak: 0, curV: 0, spins: 0 };
      this.active = true;
      this.setBuild(garage);
      world.cam.snap = true;
    },

    setBuild(garage) {
      if (!garage || !this.world) return;
      const specKey = garage.carId + JSON.stringify(garage.installed) + JSON.stringify(garage.wear) + JSON.stringify(garage.tune || {});
      const key = specKey + JSON.stringify(garage.look || {});
      if (key === this.key) return;
      this.key = key;
      this.world.setCars([{ id: 'preview', carId: garage.carId, color: this.color, parts: garage.installed, look: garage.look, tune: garage.tune }]);
      if (specKey === this.specKey) return; // paint only: keep the lap going
      this.specKey = specKey;
      this.spec = G.Parts.computeSpec(garage.carId, garage.installed, garage.wear, garage.tune);
      this.carId = garage.carId;
      this.parts = garage.installed;
      // restart lap metrics so numbers reflect the new build only
      this.m.curPeak = 0;
      this.m.curV = 0;
      this.lapT = 0;
      this.lapFresh = false;
    },

    // Paint tab: park and orbit close so the livery is what you look at.
    setShowroom(on) {
      on = !!on;
      if (on === this.showroom) return;
      this.showroom = on;
      if (on) this.cam.yaw = null; // start the orbit from wherever the camera is
      document.body.classList.toggle('showroom', on);
      if (this.world) this.world.cam.snap = !on;
    },

    // Remove ONLY our own car: whoever takes over the world next (test drive,
    // race) may already have put its cars in.
    stop() {
      this.active = false;
      this.showroom = false;
      document.body.classList.remove('showroom');
      if (this.world) this.world.removeCar('preview');
    },

    update(dt) {
      if (!this.active) return;
      const tr = this.track;
      const st = this.st;
      if (this.showroom) {
        // bleed off speed and sit still while the camera orbits
        st.vx *= Math.exp(-4 * dt);
        st.vz *= Math.exp(-4 * dt);
        st.w *= Math.exp(-4 * dt);
        st.ax = U.damp(st.ax, 0, 4, dt);
        st.ay = U.damp(st.ay, 0, 4, dt);
        st.rpm = U.damp(st.rpm, 0.16, 3, dt);
        st.thr = 0;
        st.brk = 1;
        st.slip = [0, 0, 0, 0];
        const rs = Object.assign({}, st, { vx: st.vx, vz: st.vz });
        this.world.updateCar('preview', rs, dt);
        this._orbit(st, dt);
        return; // silent: the brake-squeal and engine loops kept playing in the garage (use 🔊 Listen)
      }
      this.acc += dt;
      let n = 0;
      while (this.acc >= P.DT && n < 12) {
        this.px = st.x; this.pz = st.z; this.ph = st.h;
        const inp = this.bot.drive(st, this.spec, tr, P.DT, null);
        if (inp.rs) this._respawn();
        P.step(st, this.spec, inp, tr, P.DT, {});
        const sp = Math.hypot(st.vx, st.vz);
        const vL = st.vx * Math.sin(st.h) + st.vz * Math.cos(st.h), vT = st.vx * Math.cos(st.h) - st.vz * Math.sin(st.h);
        if (sp > 5) this.m.curPeak = Math.max(this.m.curPeak, Math.abs(Math.atan2(vT, Math.abs(vL))));
        this.m.curV = Math.max(this.m.curV, sp);
        this.lapT += P.DT;
        const q = tr.query(st.x, st.z, st.hint, this.q);
        if (this.lastAlong != null && this.lastAlong > tr.length * 0.7 && q.along < tr.length * 0.3) {
          if (this.lapFresh) {
            this.m.lastLap = this.lapT * 1000;
            this.m.peakB = this.m.curPeak;
            this.m.vmax = this.m.curV;
          }
          this.lapFresh = true; // first crossing after a build change starts a clean lap
          this.lapT = 0;
          this.m.curPeak = 0;
          this.m.curV = 0;
        }
        this.lastAlong = q.along;
        if (st.offT > 5) this._respawn();
        this.acc -= P.DT;
        n++;
      }
      if (n >= 12) this.acc = 0;
      const a = this.acc / P.DT;
      const rs = Object.assign({}, st, { x: U.lerp(this.px, st.x, a), z: U.lerp(this.pz, st.z, a), h: U.lerpAngle(this.ph, st.h, a) });
      this.world.updateCar('preview', rs, dt);
      this.world.follow(rs, dt, { pitch: 38, dist: 17, lead: 0.15 });
      // v4.4: no engine sound here. The preview's engine and tyre loops played
      // on through the whole between-rounds garage; the garage's 🔊 Listen
      // button plays the build's sound on demand instead.
    },

    // Paint tab camera (v4.4): you steer it. Drag on the car to turn round it
    // and tilt, scroll to zoom. It turns slowly by itself until you touch it,
    // and again 8 s after you let go.
    cam: { yaw: null, pitch: 18, dist: 9, touchedAt: 0 },
    camTouched() {
      if (this.cam.yaw == null && this.world) this.cam.yaw = this.world.cam.yaw || 0;
      this.cam.touchedAt = performance.now();
    },
    _orbit(st, dt) {
      const c = this.cam, w = this.world;
      if (c.yaw == null) c.yaw = w.cam.yaw || 0;
      if (performance.now() - c.touchedAt > 8000) c.yaw += dt * 0.28;
      w.cam.yaw = c.yaw;
      w.orbit(st.x, st.z, dt, c.dist, c.pitch, 0);
    },

    _respawn() {
      const tr = this.track;
      const q = tr.query(this.st.x, this.st.z, this.st.hint, this.q);
      const p = tr.pointAt(q.along, 0);
      Object.assign(this.st, { x: p.x, z: p.z, h: p.h, vx: 0, vz: 0, w: 0, steer: 0, ax: 0, ay: 0, gear: 1, offT: 0 });
      this.st.fy = [0, 0, 0, 0];
      this.st.hint = p.i;
      this.px = p.x; this.pz = p.z; this.ph = p.h;
      this.m.spins++;
    },

    info() {
      return this.m;
    },
  };

  // Paint tab: mouse / touch drag and wheel over the car view (the garage's
  // .g-center area, or the 3D canvas itself) steer the showroom camera.
  let drag = null;
  const inView = (e) => Preview.active && Preview.showroom && e.target && (e.target.id === 'c' || (e.target.closest && e.target.closest('.g-center')));
  window.addEventListener('pointerdown', (e) => {
    if (!inView(e)) return;
    drag = { x: e.clientX, y: e.clientY };
    Preview.camTouched();
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || !Preview.showroom) return;
    const c = Preview.cam;
    c.yaw -= (e.clientX - drag.x) * 0.008;
    c.pitch = U.clamp(c.pitch + (e.clientY - drag.y) * 0.25, 5, 70);
    drag.x = e.clientX;
    drag.y = e.clientY;
    Preview.camTouched();
  });
  window.addEventListener('pointerup', () => (drag = null));
  window.addEventListener('pointercancel', () => (drag = null));
  window.addEventListener(
    'wheel',
    (e) => {
      if (!inView(e)) return;
      Preview.cam.dist = U.clamp(Preview.cam.dist * (e.deltaY > 0 ? 1.1 : 0.9), 4.5, 24);
      Preview.camTouched();
    },
    { passive: true }
  );

  G.Preview = Preview;
})(window.G);
