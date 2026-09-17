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
      // v5 endurance: {laps, fuelK, tyreK} (RaceEnv.endu). Longer race, fuel
      // and tyres run down, cars stop in the pit box to be serviced.
      this.endu = opts.endu || null;
      this.laps = this.endu ? this.endu.laps : track.laps;
      this.maxTime = opts.maxTime || (this.endu ? Math.max(600, ((track.length * this.laps) / 22) * 1.6) : 360);
      this.practice = !!opts.practice;
      // Catch-up strength (host setting): the most extra power a car far
      // behind the leader gets. 0 = off (pure racing).
      this.catchup = opts.catchup || 0;
      // v5 race environment for the physics: race time (moving hazards,
      // gusts) and rain on the track from the weather roll (RaceEnv below)
      this.weather = opts.weather || null;
      this.env = { t: 0, wet: 0, endu: this.endu };
      this.cars = entrants.map((e, k) => {
        const slot = track.gridSlot(k);
        const st = P.createCar(slot.x, slot.z, slot.h);
        st.hint = slot.i;
        const spec = G.Parts.computeSpec(e.carId, e.parts, e.wear, e.tune);
        // Start the race with the wear the car came in with.
        st.tyreWear = (e.wear && e.wear.tyre) || 0;
        st.engineWear = (e.wear && e.wear.engine) || 0;
        st.body = (e.wear && e.wear.body) || 0;
        const q = track.query(slot.x, slot.z, slot.i, {});
        return {
          id: e.id, name: e.name, color: e.color, carId: e.carId, parts: e.parts, entrant: e,
          spec, st, grid: k,
          input: { s: 0, t: 0, b: 0, hb: 0 },
          bot: e.bot ? new G.Bot(e.bot.skill, U.hashStr(e.id) + (opts.seed || 0), { level: e.bot.level }) : null,
          autopilot: null,
          lapCount: 0, maxLap: 0, laps: 0, lastAlong: q.along, raceDist: track.closed ? q.along - track.length : q.along - track.startDist,
          lapStartT: null, lastLap: null, bestLap: null, finished: false, finishMs: null, dnf: false,
          px: st.x, pz: st.z, ph: st.h, wrongT: 0, respawnReq: false, specWearT: 0,
          stops: 0, pitT0: 0, pitDoneAt: null, pitPlan: null, pitCool: 0, fuelIn: 1, // v5 endurance
          startWear: { tyre: st.tyreWear, engine: st.engineWear, body: st.body },
        };
      });
      this.byId = {};
      this.cars.forEach((c) => (this.byId[c.id] = c));
      // v5 rivals: in a real race, up to two bots (by their level's odds) go
      // looking for someone to bump. They pick whoever is nearby, bot or human.
      if (!this.practice) {
        let rivals = 0;
        for (const c of this.cars) {
          if (c.bot && rivals < 2 && Math.random() < c.bot.L.rival) {
            c.bot.makeRival();
            rivals++;
          }
        }
      }
      this._q = {};
      this._hits = new Map(); // pair -> last hit event {t, j} (see collideCars)
    }

    setInput(id, inp) {
      const c = this.byId[id];
      if (!c) return;
      c.input.s = inp.s; c.input.t = inp.t; c.input.b = inp.b; c.input.hb = inp.hb; c.input.n = inp.n ? 1 : 0;
      if (inp.rs) c.respawnReq = true;
    }

    // v4 race assists, computed here on the host only and carried in each
    // car's state (P.CORE) — a client's prediction holds the last value it
    // was sent, so it never has to guess where the other cars are.
    //  * SLIPSTREAM: a car up to DRAFT_LEN ahead, roughly in line and moving
    //    with you, hides you from the wind (physics.js cuts drag up to 45%).
    //    Strongest right behind it; the pocket widens a little with distance.
    //  * CATCH-UP: trailing the leader by more than 12 m earns up to
    //    this.catchup extra power (full strength 160 m back). Off by default
    //    in practice; the host picks Off / Mild / Wild for a session.
    assist(dt) {
      const cs = this.cars;
      const DRAFT_LEN = 30;
      let lead = -Infinity;
      for (const c of cs) if (!c.dnf) lead = Math.max(lead, c.raceDist);
      for (const A of cs) {
        const a = A.st;
        let tgt = 0;
        const sp = Math.hypot(a.vx, a.vz);
        if (sp > 12 && a.ghost <= 0) {
          const fx = Math.sin(a.h), fz = Math.cos(a.h);
          for (const B of cs) {
            if (B === A || B.st.ghost > 0) continue;
            const b = B.st;
            const dx = b.x - a.x, dz = b.z - a.z;
            const ahead = dx * fx + dz * fz;
            if (ahead < 3 || ahead > DRAFT_LEN) continue;
            const lat = Math.abs(dx * fz - dz * fx);
            const lim = 1.3 + ahead * 0.035;
            if (lat > lim || b.vx * fx + b.vz * fz < sp * 0.6) continue;
            const s = Math.pow(1 - ahead / DRAFT_LEN, 0.6) * (1 - (lat / lim) * (lat / lim));
            if (s > tgt) tgt = s;
          }
        }
        a.draft += (tgt - a.draft) * Math.min(1, dt / (tgt > a.draft ? 0.35 : 0.2));
        let cu = 0;
        if (this.catchup && this.phase === 'race' && !A.finished && !A.dnf && isFinite(lead)) {
          cu = this.catchup * U.clamp((lead - A.raceDist - 12) / 150, 0, 1);
        }
        a.cu += (cu - a.cu) * Math.min(1, dt / 0.5);
      }
    }

    // One fixed step (P.DT). Order matters: inputs -> physics -> contacts -> progress.
    step() {
      const dt = P.DT;
      this.t += dt;
      this.tick++;
      const tr = this.track;
      if (this.phase === 'grid') {
        if (!this.hold) this.countdown -= dt; // hold: the host is waiting for a racer to finish loading (hostrace.js)
        if (this.countdown <= 0) {
          this.phase = 'race';
          this.raceStartT = this.t;
          this.events.push({ type: 'go' });
        }
      }
      const frozen = this.phase === 'grid';
      const env = this.env;
      env.t = this.raceStartT != null ? this.t - this.raceStartT : 0;
      env.wet = RaceEnv.wet(this.weather, env.t);
      if (!this._popts) this._popts = [{ frozen: false, env }, { frozen: true, env }];
      const popts = this._popts[frozen ? 1 : 0];
      if (!this._others || this._others.length !== this.cars.length) this._others = this.cars.map((c) => c.st);
      const others = this._others;
      if (!frozen) this.assist(dt);
      for (const c of this.cars) {
        c.px = c.st.x; c.pz = c.st.z; c.ph = c.st.h;
        let inp = c.input;
        if (c.dnf) inp = { s: 0, t: 0, b: 1, hb: 1 }; // park (no reverse)
        else if (c.bot && !frozen) {
          c.bot.env = env;
          if (this.endu) this._botPitPlan(c);
          inp = c.bot.drive(c.st, c.spec, tr, dt, others);
          if (c.bot.huntN !== (c.huntN || 0)) {
            // a rival just picked a target: tell everyone who (the HUD warns the target)
            c.huntN = c.bot.huntN;
            const tgt = c.bot.hunt && this.cars.find((x) => x.st === c.bot.hunt.st);
            if (tgt) this.events.push({ type: 'rival', id: c.id, target: tgt.id });
          }
        }
        else if (c.finished && !this.practice) {
          // Cool-down lap on autopilot after the flag.
          if (!c.autopilot) (c.autopilot = new G.Bot(0.7, 7)).env = env;
          inp = c.autopilot.drive(c.st, c.spec, tr, dt, others);
          inp.t *= 0.6;
          inp.n = 0;
        }
        if (frozen) inp = { s: inp.s, t: inp.t, b: 0, hb: 0 };
        if ((c.respawnReq || inp.rs) && !frozen && !c.st.pit) this.respawn(c);
        c.respawnReq = false;
        P.step(c.st, c.spec, inp, tr, dt, popts);
      }
      this.collideCars();
      // a car that has taken the flag is on its cool-down lap: no more body
      // damage (sprints end at a wall, and v4 finishing speeds are high)
      for (const c of this.cars) if (c.finished && c.bodyAtFinish != null) c.st.body = c.bodyAtFinish;
      if (this.phase !== 'grid') this.progress();
    }

    // Put the car back on the centreline at its current progress, facing forward.
    respawn(c) {
      const tr = this.track;
      const q = tr.query(c.st.x, c.st.z, c.st.hint, this._q);
      let d = q.along;
      if (!tr.closed) d = U.clamp(d, 2, tr.length - 2);
      // never respawn inside a barrel stack: step sideways past it
      let lat = 0;
      const near = tr.OBL && tr.OBL[tr.idx(Math.round(d / tr.sp))];
      if (near) {
        for (const o of near) {
          const pp = tr.pointAt(d, lat);
          if (Math.hypot(pp.x - o.x, pp.z - o.z) < o.r + 3) lat = o.lat > 0 ? o.lat - o.r - 3.2 : o.lat + o.r + 3.2;
        }
      }
      const p = tr.pointAt(d, lat);
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
          // One 'hit' EVENT per contact, not one per physics tick. Two cars
          // leaning on each other used to fire 120 events a second per pair,
          // and each one made sparks, a dozen sound nodes and a network
          // message: in a pack that took a fast PC from 90 to ~20 fps. The
          // physics above still runs every tick; only the effects are
          // throttled (a new, much harder hit still gets through).
          if (jn > 1500) {
            const key = A.id < B.id ? A.id + '|' + B.id : B.id + '|' + A.id;
            const last = this._hits.get(key);
            if (!last || this.t - last.t > 0.35 || (jn > last.j * 2.5 && this.t - last.t > 0.08)) {
              this._hits.set(key, { t: this.t, j: jn });
              this.events.push({ type: 'hit', a: A.id, b: B.id, x: px, z: pz, j: jn });
            }
          }
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
                if (!this.practice && c.laps >= this.laps && !c.finished) this.finish(c, raceT);
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
        if (this.endu && tr.pit) this._pit(c, q);
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
        // after the winner: 25 s on circuits/sprints; drags scale with length
        // (a flat 8 s DNF'd the slowest car on the 1,609 m Backstretch Mile)
        const grace = tr.format === 'drag' ? Math.max(8, tr.raceDistance / 110) : this.endu ? 60 : 25;
        if (allDone || (this.firstFinishT != null && this.t - this.firstFinishT > grace) || raceT > this.maxTime) this.end();
      }
    }

    // ---- v5 endurance pit stops ---------------------------------------------
    // Stop inside the pit box (under ~2 m/s) and the car is held there. Bots
    // get a service time from their skill; a human plays the pit mini-game
    // (ui/pit.js) and sends what they chose. The host never releases a car
    // sooner than that service could really take (RaceEnv.pitTime), so a
    // modified client can't pit instantly.
    _pit(c, q) {
      const tr = this.track, B = tr.pit, st = c.st;
      if (c.finished || c.dnf) {
        if (st.pit) this.pitRelease(c, { cancel: 1 });
        return;
      }
      if (st.pit) {
        st.ghost = Math.max(st.ghost, 0.6); // nobody piles into a parked car
        if (c.pitDoneAt != null && this.t >= c.pitDoneAt) this.pitRelease(c, c.pitPlan);
        else if (!c.bot && c.pitDoneAt == null && this.t - c.pitT0 > 40) this.pitRelease(c, RaceEnv.autoPlan(st, 1)); // walked away from the keyboard
        return;
      }
      if (c.pitCool > 0) {
        c.pitCool -= P.DT;
        return;
      }
      if (Math.abs(RaceEnv.pitAhead(tr, q.along)) > B.hl || Math.abs(q.lat - B.lat) > B.hw + 0.6) return;
      if (Math.hypot(st.vx, st.vz) > 2.2) return;
      st.pit = 1;
      st.vx = st.vz = st.w = 0;
      c.pitT0 = this.t;
      c.pitDoneAt = null;
      c.pitPlan = null;
      if (c.bot) {
        const plan = RaceEnv.autoPlan(st, this._remainingFuelNeed(c));
        c.pitPlan = plan;
        // a slick crew for good drivers, a fumble or two for the rest
        const slow = 1 + (1 - U.clamp((c.bot.skill - 0.7) / 0.32, 0, 1)) * 0.6 + Math.random() * 0.15;
        c.pitDoneAt = this.t + RaceEnv.pitTime(plan, c.spec) * slow;
      }
      this.events.push({ type: 'pitIn', id: c.id, tank: +st.tank.toFixed(3), tw: +st.tw.toFixed(3), ck: c.spec.chargeK || 1, qr: c.spec.qr || 1 });
    }

    // A human's pit crew is done: m = {fuel: 0..1 added, tyres: 0/1, cancel}
    pitDone(id, m) {
      const c = this.byId[id];
      if (!c || c.bot || !c.st.pit || c.pitDoneAt != null) return;
      const plan = m && m.cancel ? { cancel: 1 } : { fuel: U.clamp(+m.fuel || 0, 0, 1 - c.st.tank), tyres: m && m.tyres ? 1 : 0 };
      const at = c.pitT0 + (plan.cancel ? 0.3 : RaceEnv.pitTime(plan, c.spec));
      c.pitPlan = plan;
      c.pitDoneAt = Math.max(this.t, at);
    }

    pitRelease(c, plan) {
      const st = c.st;
      plan = plan || { cancel: 1 };
      st.pit = 0;
      if (!plan.cancel) {
        const add = U.clamp(plan.fuel || 0, 0, 1 - st.tank);
        st.tank += add;
        c.fuelIn += add;
        if (plan.tyres) st.tw = 0;
        c.stops++;
      }
      st.ghost = Math.max(st.ghost, 1.5); // pull out of the box without being collected
      c.pitCool = 8;
      c.pitDoneAt = null;
      c.pitPlan = null;
      if (c.bot) c.bot.pit = false;
      this.events.push({ type: 'pitOut', id: c.id, ms: Math.round((this.t - c.pitT0) * 1000), fuel: +(plan.fuel || 0).toFixed(3), tyres: plan.tyres ? 1 : 0, cancel: plan.cancel ? 1 : 0, stops: c.stops });
    }

    // fuel this car needs to reach the flag, from what it has used per metre
    _remainingFuelNeed(c) {
      const tr = this.track;
      const done = Math.max(250, c.raceDist);
      const used = c.fuelIn - c.st.tank;
      const perM = used > 0.02 ? used / done : 1 / (tr.length * this.laps * 0.56);
      const rem = Math.max(0, tr.length * this.laps - c.raceDist);
      return perM * rem;
    }

    // bots decide at the start of the pit straight whether to come in this lap
    _botPitPlan(c) {
      const tr = this.track, st = c.st;
      if (!tr.pit || c.bot.pit || st.pit || c.finished || c.pitCool > 0) return;
      const ahead = RaceEnv.pitAhead(tr, c.lastAlong);
      if (ahead < 200 || ahead > 320) return; // decide once, a little before the box
      const L = tr.length;
      const rem = Math.max(0, L * this.laps - c.raceDist);
      if (rem < L * 0.35) return; // the flag is right there: stay out
      if (RaceEnv.shouldPit(st, this._remainingFuelNeed(c), rem / L)) c.bot.pit = true;
    }

    finish(c, raceT) {
      c.finished = true;
      c.bodyAtFinish = c.st.body;
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
        stops: c.stops || 0,
        wear: { tyre: Math.min(1, c.st.tyreWear), engine: Math.min(1, c.st.engineWear), body: Math.min(1, c.st.body) },
        fuel: c.st.fuel,
      }));
    }

    // Interpolated render state for a car (alpha = fraction into the next step).
    renderState(c, alpha) {
      const st = c.st;
      // v4.5: one reused object per car. A fresh copy of the whole state for
      // every car on every frame was the biggest source of garbage (and so
      // of garbage-collection hitches) on the host.
      const m = this._rsm || (this._rsm = new WeakMap());
      let rs = m.get(c);
      if (!rs) m.set(c, (rs = {}));
      Object.assign(rs, st);
      rs.x = U.lerp(c.px, st.x, alpha);
      rs.z = U.lerp(c.pz, st.z, alpha);
      rs.h = U.lerpAngle(c.ph, st.h, alpha);
      return rs;
    }

    popEvents() {
      const e = this.events;
      this.events = [];
      return e;
    }
  }

  // v5 weather. The host rolls it once per race; it travels with the race
  // info so every client's prediction sees the same rain at the same time.
  //   {rainAt: race seconds the rain starts, ramp: seconds to soak}
  //   mode (host setting): 'auto' = sometimes a shower mid-race, 'dry', 'rain'
  const RaceEnv = {
    MODES: ['auto', 'dry', 'rain'],
    roll(track, mode, rnd, laps) {
      rnd = rnd || Math.random;
      const th = track.theme || {};
      if (mode === 'dry' || th.rain || th.snow || track.format === 'drag') return null; // wet themes are already wet
      if (mode === 'rain') return { rainAt: 0, ramp: 1 };
      if (rnd() >= (th.showers != null ? th.showers : 0.2)) return null;
      const est = (laps ? track.length * laps : track.raceDistance) / 33; // rough race length in seconds
      return { rainAt: Math.round(est * (0.25 + 0.35 * rnd())), ramp: 20 };
    },
    wet(w, t) {
      return w && w.rainAt >= 0 ? U.clamp((t - w.rainAt) / (w.ramp || 20), 0, 1) : 0;
    },

    // v5 endurance for a track: laps from the definition, and drain rates
    // set from the race distance so a typical car wants one stop: the tank
    // lasts ~60% of the race, tyres are finished at ~60%. CAL = [fuel, tyre
    // wear] a Normal-level field uses per metre on that track (measured with
    // headless races; they differ a lot: flat-out ovals vs stop-start loops).
    CAL: { endu: [0.0187, 7.5e-5], harbour: [0.022, 5.5e-5], tour: [0.0203, 8.9e-5], dustbowl: [0.0181, 6.7e-5] },
    endu(track) {
      const laps = track.def.enduLaps || Math.max(3, track.laps * 2);
      const dist = track.length * laps;
      const [fm, wm] = this.CAL[track.id] || [0.02, 7e-5];
      return { laps, fuelK: 1 / (fm * dist * 0.6), tyreK: 1 / (wm * dist * 0.6) };
    },
    // metres from `along` forward to the pit box centre (-L/2 .. L/2 on circuits)
    pitAhead(track, along) {
      let d = track.pit.at - along;
      if (track.closed) {
        const L = track.length;
        d = ((((d + L / 2) % L) + L) % L) - L / 2;
      }
      return d;
    },
    // Pit this lap? need = fuel to the flag, lapsLeft = laps to go (asked a
    // few hundred metres before the box). Stop when the tank won't last
    // another lap plus the run to the box, or earlier if a full tank would
    // already reach the flag and the tyres are going off. (Stopping while more
    // than a tankful is still needed just means a second stop.)
    shouldPit(st, need, lapsLeft) {
      if (lapsLeft < 0.35) return false;
      const perLap = need / Math.max(0.2, lapsLeft);
      if (st.tank >= need) return st.tw > 0.85 && lapsLeft > 1.3; // fuel's fine: only for dead tyres
      if (st.tank < perLap * 1.35 + 0.03) return true;
      return need - st.tank <= 1 - st.tank && need <= 0.97 && st.tw > 0.55 && st.tank < perLap * 2.2;
    },
    // the least time a crew could do that service in (s)
    pitTime(plan, spec) {
      if (!plan || plan.cancel) return 0.3;
      // (an EV charges slower than a car fills: spec.chargeK)
      return 1.2 + U.clamp(plan.fuel || 0, 0, 1) * 4.5 * ((spec && spec.chargeK) || 1) + (plan.tyres ? 3.2 * ((spec && spec.qr) || 1) : 0);
    },
    // what a sensible crew does: fuel to the flag (+8%), tyres if worn
    autoPlan(st, need) {
      const fuel = U.clamp(need * 1.12 - st.tank, 0, 1 - st.tank);
      return { fuel: Math.max(fuel, Math.min(0.15, 1 - st.tank)), tyres: st.tw > 0.45 ? 1 : 0 };
    },
  };

  G.RaceSim = RaceSim;
  G.RaceEnv = RaceEnv;
})(window.G);
