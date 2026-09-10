// race.js — RaceSim: the authoritative race. Runs ONLY on the host (and in
// single-player practice). Owns the grid, countdown, fixed-step physics for
// every car, car-vs-car collisions, lap/sector bookkeeping, finishing order.
'use strict';
(function (G) {
  const U = G.U;
  const P = G.Physics;

  class RaceSim {
    // entrants: [{id, name, color, carId, parts, wear, bot?:{skill}}] in GRID order (pole first)
    constructor(track, entrants, opts) {
      opts = opts || {};
      this.track = track;
      this.t = 0; // sim seconds
      this.tick = 0;
      this.phase = 'grid'; // grid -> race -> done
      this.countdown = opts.countdown != null ? opts.countdown : 4;
      this.raceStartT = null;
      this.firstFinishT = null;
      this.finishOrder = [];
      this.events = [];
      this.fastest = null; // {id, ms}
      this.maxTime = opts.maxTime || 360;
      this.practice = !!opts.practice;
      this.cars = entrants.map((e, k) => {
        const slot = track.gridSlot(k);
        const st = P.createCar(slot.x, slot.z, slot.h);
        st.hint = slot.i;
        const spec = G.Parts.computeSpec(e.carId, e.parts, e.wear);
        // Start the race with the wear the car came in with.
        st.tyreWear = (e.wear && e.wear.tyre) || 0;
        st.engineWear = (e.wear && e.wear.engine) || 0;
        st.body = (e.wear && e.wear.body) || 0;
        const q = track.query(slot.x, slot.z, slot.i, {});
        return {
          id: e.id, name: e.name, color: e.color, carId: e.carId, parts: e.parts, entrant: e,
          spec, st, grid: k,
          input: { s: 0, t: 0, b: 0, hb: 0 },
          bot: e.bot ? new G.Bot(e.bot.skill, U.hashStr(e.id)) : null,
          autopilot: null,
          lapCount: 0, maxLap: 0, laps: 0, lastAlong: q.along, raceDist: track.closed ? q.along - track.length : q.along - track.startDist,
          lapStartT: null, lastLap: null, bestLap: null, finished: false, finishMs: null, dnf: false,
          px: st.x, pz: st.z, ph: st.h, wrongT: 0, respawnReq: false, specWearT: 0,
          startWear: { tyre: st.tyreWear, engine: st.engineWear, body: st.body },
        };
      });
      this.byId = {};
      this.cars.forEach((c) => (this.byId[c.id] = c));
      this._q = {};
    }

    setInput(id, inp) {
      const c = this.byId[id];
      if (!c) return;
      c.input.s = inp.s; c.input.t = inp.t; c.input.b = inp.b; c.input.hb = inp.hb;
      if (inp.rs) c.respawnReq = true;
    }

    // One fixed step (P.DT). Order matters: inputs -> physics -> contacts -> progress.
    step() {
      const dt = P.DT;
      this.t += dt;
      this.tick++;
      const tr = this.track;
      if (this.phase === 'grid') {
        this.countdown -= dt;
        if (this.countdown <= 0) {
          this.phase = 'race';
          this.raceStartT = this.t;
          this.events.push({ type: 'go' });
        }
      }
      const frozen = this.phase === 'grid';
      const others = this.cars.map((c) => c.st);
      for (const c of this.cars) {
        c.px = c.st.x; c.pz = c.st.z; c.ph = c.st.h;
        let inp = c.input;
        if (c.dnf) inp = { s: 0, t: 0, b: 1, hb: 1 }; // park (no reverse)
        else if (c.bot && !frozen) inp = c.bot.drive(c.st, c.spec, tr, dt, others);
        else if (c.finished && !this.practice) {
          // Cool-down lap on autopilot after the flag.
          if (!c.autopilot) c.autopilot = new G.Bot(0.7, 7);
          inp = c.autopilot.drive(c.st, c.spec, tr, dt, others);
          inp.t *= 0.6;
        }
        if (frozen) inp = { s: inp.s, t: inp.t, b: 0, hb: 0 };
        if ((c.respawnReq || inp.rs) && !frozen) this.respawn(c);
        c.respawnReq = false;
        P.step(c.st, c.spec, inp, tr, dt, { frozen });
      }
      this.collideCars();
      if (this.phase !== 'grid') this.progress();
    }

    // Put the car back on the centreline at its current progress, facing forward.
    respawn(c) {
      const tr = this.track;
      const q = tr.query(c.st.x, c.st.z, c.st.hint, this._q);
      let d = q.along;
      if (!tr.closed) d = U.clamp(d, 2, tr.length - 2);
      const p = tr.pointAt(d, 0);
      const st = c.st;
      st.x = p.x; st.z = p.z; st.h = p.h;
      st.vx = st.vz = st.w = 0;
      st.steer = 0; st.ax = st.ay = 0;
      st.fy[0] = st.fy[1] = st.fy[2] = st.fy[3] = 0;
      st.hint = p.i;
      st.ghost = 2.0;
      st.gear = 1;
      st.offT = 0;
      c.px = st.x; c.pz = st.z; c.ph = st.h;
      this.events.push({ type: 'respawn', id: c.id });
    }

    // Car-vs-car contact (host only). Each car is three circles along its length.
    // We resolve the deepest overlapping pair per car pair with a positional
    // split by mass and an impulse (restitution + friction) at the contact point
    // — so a light car genuinely gets shoved and spun by a heavy one.
    collideCars() {
      const cs = this.cars;
      for (let i = 0; i < cs.length; i++) {
        const A = cs[i], a = A.st;
        if (a.ghost > 0) continue;
        for (let j = i + 1; j < cs.length; j++) {
          const B = cs[j], b = B.st;
          if (b.ghost > 0) continue;
          const dx0 = b.x - a.x, dz0 = b.z - a.z;
          const reach = (A.spec.len + B.spec.len) * 0.5 + 0.5;
          if (dx0 * dx0 + dz0 * dz0 > reach * reach) continue;
          let best = 0, bn = null;
          const ra = A.spec.wid * 0.5, rb = B.spec.wid * 0.5;
          const sa = Math.sin(a.h), ca = Math.cos(a.h), sb = Math.sin(b.h), cb = Math.cos(b.h);
          for (let ka = -1; ka <= 1; ka++) {
            const ua = ka * A.spec.len * 0.3;
            const ax = a.x + sa * ua, az = a.z + ca * ua;
            for (let kb = -1; kb <= 1; kb++) {
              const ub = kb * B.spec.len * 0.3;
              const bx = b.x + sb * ub, bz = b.z + cb * ub;
              const dx = bx - ax, dz = bz - az;
              const d = Math.hypot(dx, dz);
              const pen = ra + rb - d;
              if (pen > best && d > 1e-4) {
                best = pen;
                bn = [dx / d, dz / d, (ax + bx) / 2, (az + bz) / 2];
              }
            }
          }
          if (!bn) continue;
          const [nx, nz, px, pz] = bn;
          const ma = A.spec.mass, mb = B.spec.mass;
          // positional correction split by inverse mass
          const wa = mb / (ma + mb), wb = ma / (ma + mb);
          a.x -= nx * best * wa; a.z -= nz * best * wa;
          b.x += nx * best * wb; b.z += nz * best * wb;
          // contact-point velocities: v + w * (rz, -rx)
          const rax = px - a.x, raz = pz - a.z, rbx = px - b.x, rbz = pz - b.z;
          const vax = a.vx + a.w * raz, vaz = a.vz - a.w * rax;
          const vbx = b.vx + b.w * rbz, vbz = b.vz - b.w * rbx;
          const rvx = vbx - vax, rvz = vbz - vaz;
          const vn = rvx * nx + rvz * nz;
          if (vn >= 0) continue;
          const ka2 = nx * raz - nz * rax, kb2 = nx * rbz - nz * rbx;
          const Ia = A.spec.Iz, Ib = B.spec.Iz;
          const e = 0.3;
          const jn = (-(1 + e) * vn) / (1 / ma + 1 / mb + (ka2 * ka2) / Ia + (kb2 * kb2) / Ib);
          a.vx -= (jn * nx) / ma; a.vz -= (jn * nz) / ma; a.w -= (jn * ka2) / Ia;
          b.vx += (jn * nx) / mb; b.vz += (jn * nz) / mb; b.w += (jn * kb2) / Ib;
          // tangential friction (rubbing)
          const tx = -nz, tz = nx;
          const vt = rvx * tx + rvz * tz;
          const jt = U.clamp(-vt / (1 / ma + 1 / mb), -jn * 0.25, jn * 0.25);
          a.vx -= (jt * tx) / ma; a.vz -= (jt * tz) / ma;
          b.vx += (jt * tx) / mb; b.vz += (jt * tz) / mb;
          const dmg = Math.max(0, jn - 3000) * 0.000009;
          a.body = Math.min(1, a.body + dmg * (mb / ma));
          b.body = Math.min(1, b.body + dmg * (ma / mb));
          if (jn > 1500) this.events.push({ type: 'hit', a: A.id, b: B.id, x: px, z: pz, j: jn });
        }
      }
    }

    progress() {
      const tr = this.track;
      const raceT = this.t - this.raceStartT;
      for (const c of this.cars) {
        const st = c.st;
        const q = tr.query(st.x, st.z, st.hint, this._q);
        const a = q.along;
        if (tr.closed) {
          const L = tr.length;
          if (c.lastAlong > L * 0.7 && a < L * 0.3) {
            c.lapCount++;
            if (c.lapCount > c.maxLap) {
              c.maxLap = c.lapCount;
              if (c.lapCount === 1) c.lapStartT = this.t;
              else {
                const ms = (this.t - c.lapStartT) * 1000;
                c.lastLap = ms;
                c.laps = c.lapCount - 1;
                if (c.bestLap == null || ms < c.bestLap) c.bestLap = ms;
                if (!this.practice && (this.fastest == null || ms < this.fastest.ms)) this.fastest = { id: c.id, ms };
                c.lapStartT = this.t;
                this.events.push({ type: 'lap', id: c.id, ms, lap: c.laps });
                if (!this.practice && c.laps >= tr.laps && !c.finished) this.finish(c, raceT);
              }
            }
          } else if (c.lastAlong < L * 0.3 && a > L * 0.7) {
            c.lapCount--;
          }
          c.raceDist = (c.lapCount - 1) * L + a;
        } else {
          c.raceDist = a - tr.startDist;
          if (!c.finished && a >= tr.finishDist && !this.practice) this.finish(c, raceT);
          if (this.practice && a >= tr.finishDist && c.lapStartT == null) {
            c.lastLap = raceT * 1000;
            c.lapStartT = -1;
            if (c.bestLap == null || c.lastLap < c.bestLap) c.bestLap = c.lastLap;
            this.events.push({ type: 'lap', id: c.id, ms: c.lastLap });
          }
        }
        c.lastAlong = a;
        // wrong-way detection
        const fwd = Math.sin(st.h) * q.tx + Math.cos(st.h) * q.tz;
        const sp = Math.hypot(st.vx, st.vz);
        c.wrongT = fwd < -0.3 && sp > 3 ? c.wrongT + P.DT : 0;
        // auto-respawn humans who are wedged off-track for ages
        if (c.st.offT > 8) this.respawn(c);
      }
      // End conditions
      if (this.phase === 'race' && !this.practice) {
        const active = this.cars.filter((c) => !c.dnf);
        const allDone = active.every((c) => c.finished);
        const grace = tr.format === 'drag' ? 8 : 25;
        if (allDone || (this.firstFinishT != null && this.t - this.firstFinishT > grace) || raceT > this.maxTime) this.end();
      }
    }

    finish(c, raceT) {
      c.finished = true;
      c.finishMs = raceT * 1000;
      this.finishOrder.push(c.id);
      if (this.firstFinishT == null) this.firstFinishT = this.t;
      this.events.push({ type: 'finish', id: c.id, pos: this.finishOrder.length, ms: c.finishMs });
    }

    end() {
      this.phase = 'done';
      for (const c of this.cars) if (!c.finished) c.dnf = true;
      this.events.push({ type: 'end' });
    }

    // Race order: finishers by time, then everyone else by distance covered.
    order() {
      return this.cars.slice().sort((x, y) => {
        if (x.finished && y.finished) return x.finishMs - y.finishMs;
        if (x.finished) return -1;
        if (y.finished) return 1;
        return y.raceDist - x.raceDist;
      });
    }

    // Final classification with wear deltas, used for payouts.
    results() {
      return this.order().map((c, i) => ({
        id: c.id, pos: i + 1, finished: c.finished, dnf: !c.finished, ms: c.finishMs, bestLap: c.bestLap, grid: c.grid + 1,
        dist: Math.max(0, Math.round(c.raceDist)), // metres covered (anti-AFK payout rule)
        wear: { tyre: Math.min(1, c.st.tyreWear), engine: Math.min(1, c.st.engineWear), body: Math.min(1, c.st.body) },
        fuel: c.st.fuel,
      }));
    }

    // Interpolated render state for a car (alpha = fraction into the next step).
    renderState(c, alpha) {
      const st = c.st;
      const rs = this._rs || (this._rs = {});
      return Object.assign({}, st, {
        x: U.lerp(c.px, st.x, alpha),
        z: U.lerp(c.pz, st.z, alpha),
        h: U.lerpAngle(c.ph, st.h, alpha),
      });
    }

    popEvents() {
      const e = this.events;
      this.events = [];
      return e;
    }
  }

  G.RaceSim = RaceSim;
})(window.G);
