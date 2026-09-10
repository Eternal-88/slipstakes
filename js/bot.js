// bot.js — AI drivers. They use the exact same physics and input interface as
// humans (steer/throttle/brake), so they get NO speed help of any kind: a bot
// in a stock car is a stock car. Skill scales how close to the grip limit they
// dare to corner.
'use strict';
(function (G) {
  const U = G.U;
  const NAMES = ['Dash Rivera', 'Ada Lockwood', 'Sprocket', 'Nina Volt', 'Grit McCall', 'Tex Tarmac', 'Juno Apex', 'Rook Hart'];

  class Bot {
    // opts.aggressive: no traction control, only catches big slides. Used by the
    // garage preview so a wild build is SHOWN being wild instead of masked.
    constructor(skill, seed, opts) {
      this.skill = skill; // 0.8 .. 1.0
      this.aggressive = !!(opts && opts.aggressive);
      this.rng = U.rng(seed || 1);
      this.lane = (this.rng() - 0.5) * 3;
      this.laneT = 0;
      this.stuck = 0;
      this.q = {};
      this.out = { s: 0, t: 0, b: 0, hb: 0, rs: 0 };
    }

    drive(st, spec, track, dt, others) {
      const q = track.query(st.x, st.z, st.hint, this.q);
      const speed = Math.hypot(st.vx, st.vz);
      const out = this.out;
      out.rs = 0;
      // Wander lane a little so bots don't form a conga line; dodge cars ahead.
      this.laneT -= dt;
      if (this.laneT <= 0) {
        this.lane = U.clamp(this.lane + (this.rng() - 0.5) * 2.5, -q.hw * 0.45, q.hw * 0.45);
        this.laneT = 2 + this.rng() * 3;
      }
      let dodge = 0;
      if (others) {
        const fx = Math.sin(st.h), fz = Math.cos(st.h);
        for (const o of others) {
          if (o === st) continue;
          const dx = o.x - st.x, dz = o.z - st.z;
          const ahead = dx * fx + dz * fz;
          const side = dx * fz - dz * fx; // + = to the left
          if (ahead > 0 && ahead < 14 && Math.abs(side) < 2.6) dodge += side > 0 ? -1.8 : 1.8;
        }
      }
      const lane = U.clamp(this.lane + dodge, -q.hw + 1.5, q.hw - 1.5);
      // Steering: pure pursuit. Arc curvature to the lookahead point
      // k = 2 sin(err) / Ld, turned into a wheel angle via the wheelbase, then
      // divided by the physics' speed-dependent lock to get a -1..1 input.
      const look = 5 + speed * 0.42;
      const p = track.pointAt(q.along + look, lane);
      const dx = p.x - st.x, dz = p.z - st.z;
      const want = Math.atan2(dx, dz);
      const err = U.wrapAngle(want - st.h); // + = target to the left
      const Ld = Math.max(3, Math.hypot(dx, dz));
      const delta = Math.atan((2 * Math.sin(err) * spec.wheelbase) / Ld);
      const lock = spec.steerLock / (1 + speed / spec.steerFalloff);
      out.s = U.clamp(-delta / lock - st.w * 0.04, -1, 1);
      // Speed: min over the road ahead of the corner speed + braking distance.
      const g = 9.81;
      // Real grip includes tyre load sensitivity: heavy cars have less per kg.
      const sens = 1 - spec.loadSens * ((spec.mass * g) / 4 / spec.fzNom - 1);
      let vT = 99;
      const span = 40 + speed * 1.6;
      const i0 = q.i;
      for (let d = 0; d <= span; d += 4) {
        const i = track.idx(i0 + Math.round(d / track.sp));
        if (!track.closed && i >= track.N - 1) break;
        const k = Math.abs(track.K[i]) + 1e-4;
        const mu = spec.mu * spec.surfMul[track.S[i]] * sens * 0.86 * this.skill * (1 - G.SURF[track.S[i]].rough * spec.roughGrip);
        // v² = mu*g / (k - mu*0.6*clA/m) : downforce raises the limit with speed
        const den = k - (mu * 0.6 * spec.clA) / spec.mass;
        const vc = den > 1e-5 ? Math.sqrt((mu * g) / den) : 99;
        const decel = mu * g * 0.75;
        const va = Math.sqrt(vc * vc + 2 * decel * d);
        if (va < vT) vT = va;
      }
      if (!track.closed && q.along > track.finishDist + 5) vT = Math.min(vT, 12);
      const dv = vT - speed;
      out.t = U.clamp(dv * 0.6 + 0.3, 0, 1);
      out.b = dv < -1.5 ? U.clamp(-dv * 0.25, 0, 1) : 0;
      // Traction control + slide recovery (bots aren't heroes): ease off in
      // proportion to how sideways the car is, a little for plain wheelspin.
      const vLong = st.vx * Math.sin(st.h) + st.vz * Math.cos(st.h);
      const vLat = st.vx * Math.cos(st.h) - st.vz * Math.sin(st.h);
      const beta = Math.atan2(vLat, Math.abs(vLong) + 0.1);
      if (this.aggressive) {
        if (Math.abs(beta) > 0.55) out.t *= 0.4;
      } else {
        if (st.spin) out.t *= 0.85;
        // Feather the throttle in low gears while steering (what a human does
        // on corner exit), and back off harder while a slide is still growing.
        if (st.gear >= 1 && st.gear <= 2) out.t = Math.min(out.t, 1 - Math.abs(out.s) * 0.45);
        const growing = Math.sign(beta) * (beta - (this.prevBeta || 0)) > 0.002;
        this.prevBeta = beta;
        if (Math.abs(beta) > 0.14) out.t *= U.clamp(1 - (Math.abs(beta) - 0.14) * (growing ? 4 : 2.2), 0.2, 1);
      }
      if (st.heat > 0.8) out.t = Math.min(out.t, 0.55); // manage turbo heat
      out.hb = 0;
      // Stuck / wrong way -> ask for a respawn.
      if (speed < 1.2 && out.t > 0.5) this.stuck += dt;
      else this.stuck = Math.max(0, this.stuck - dt);
      if (Math.abs(err) > 2.2 && speed > 3) this.stuck += dt * 0.5;
      if (this.stuck > 2.5) {
        out.rs = 1;
        this.stuck = 0;
      }
      return out;
    }
  }

  G.Bot = Bot;
  G.BOT_NAMES = NAMES;
})(window.G);
