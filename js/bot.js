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
      this._cap = 99; // speed cap set by _hazards when an obstacle isn't cleared yet
      // Wander lane a little so bots don't form a conga line; dodge cars ahead.
      this.laneT -= dt;
      if (this.laneT <= 0) {
        this.lane = U.clamp(this.lane + (this.rng() - 0.5) * 2.5, -q.hw * 0.45, q.hw * 0.45);
        this.laneT = 2 + this.rng() * 3;
      }
      let dodge = 0;
      let tow = null; // lateral offset of a car 14-32 m ahead to tuck in behind
      if (others) {
        const fx = Math.sin(st.h), fz = Math.cos(st.h);
        for (const o of others) {
          if (o === st) continue;
          const dx = o.x - st.x, dz = o.z - st.z;
          const ahead = dx * fx + dz * fz;
          const side = dx * fz - dz * fx; // + = to the left
          if (ahead > 0 && ahead < 14 && Math.abs(side) < 2.6) dodge += side > 0 ? -1.8 : 1.8;
          else if (tow == null && ahead >= 14 && ahead < 32 && Math.abs(side) < 4) tow = side;
          // v4: don't rear-end it. A slower car right in our path caps our
          // speed near its own until the dodge (above) takes us clear. (With
          // slipstream + catch-up bunching the field, bots ploughed into each
          // other: Wild catch-up on Harbour was 40 hard hits and 3 of 6 cars
          // wrecked.)
          // Only when contact is under ~0.9 s away, and softly, so the dodge
          // can still carry us past: a harder cap chopped the throttle of
          // big-power cars mid-swerve and set them weaving (a Big Turbo that
          // won the Salt Flat in v3 stopped finishing it).
          if (ahead > 0 && Math.abs(side) < 2.1) {
            const vo = o.vx * fx + o.vz * fz;
            const close = speed - vo;
            if (close > 1 && ahead / close < 0.9) this._cap = Math.min(this._cap, vo + ahead * 0.8);
          }
        }
      }
      // Slipstream: close up behind the car ahead, then (dodge, above) pull
      // out and slingshot past once within 14 m — that's how packs form.
      let laneT = this.lane + dodge;
      if (tow != null && !dodge) laneT = U.lerp(laneT, q.lat + tow, 0.65);
      if (track.obs.length || track.patches.length || track.pads.length) laneT = this._hazards(track, q, laneT, speed);
      // (A lane rate-limit was tried here to calm high-power weaves: it
      // delayed dodges and hazard swerves, and an 8-track A/B went from 13 to
      // 69 respawns. The weave is handled by the yaw damping + traction limit.)
      const lane = U.clamp(laneT, -q.hw + 1.5, q.hw - 1.5);
      // how much this build's power overwhelms its rear tyres (>1 = wheelspin
      // on tap) — feeds the steering damping and traction limit below
      if (this._spec !== spec) {
        this._spec = spec;
        this._ex = G.Parts.rearExcess ? G.Parts.rearExcess(spec) : 1;
      }
      const exK = U.clamp(this._ex - 0.9, 0, 1);
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
      out.s = U.clamp(-delta / lock - st.w * (0.04 + 0.05 * exK), -1, 1);
      // Speed: min over the road ahead of the corner speed + braking distance.
      const g = 9.81;
      // Real grip includes tyre load sensitivity: heavy cars have less per kg.
      const sens = 1 - spec.loadSens * ((spec.mass * g) / 4 / spec.fzNom - 1);
      let vT = 99;
      // (v4: 1.6 -> 2.3 s of look-ahead. With slipstream, nitrous and speed
      // pads, bots reach 60 m/s and the old horizon started braking too late
      // for fast sweepers on Coastal Highway.)
      const span = 40 + speed * 2.3;
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
      vT = Math.min(vT, this._cap);
      const dv = vT - speed;
      this.lastDv = dv;
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
        // Traction control: ramp the throttle down while the driven wheels
        // spin, back up once they grip. (A fixed 15% cut let turbo cars light
        // the rears up all the way down a straight: Street Turbo bots were
        // 20+ s slower than stock over 3 laps of Harbour Loop.)
        this.tc = U.clamp((this.tc == null ? 1 : this.tc) + (st.spin ? -3 : 1.5) * dt, 0.3, 1);
        out.t = Math.min(out.t, this.tc);
        // feed-forward: in the low gears, don't ask for more than the rear
        // tyres can take (a human feathers a Big Turbo out of a hairpin too)
        if (this._ex > 1 && st.gear >= 1 && st.gear <= 3) out.t = Math.min(out.t, U.clamp(1.15 / this._ex + speed / 60, 0.45, 1));
        // Feather the throttle in low gears while steering (what a human does
        // on corner exit), and back off harder while a slide is still growing.
        if (st.gear >= 1 && st.gear <= 2) out.t = Math.min(out.t, 1 - Math.abs(out.s) * 0.45);
        const growing = Math.sign(beta) * (beta - (this.prevBeta || 0)) > 0.002;
        this.prevBeta = beta;
        if (Math.abs(beta) > 0.14) out.t *= U.clamp(1 - (Math.abs(beta) - 0.14) * (growing ? 4 : 2.2), 0.2, 1);
      }
      if (st.heat > 0.8) out.t = Math.min(out.t, 0.55); // manage turbo heat
      out.hb = 0;
      // Nitrous: fire it accelerating on a straight-ish bit, never when hot.
      out.n = spec.nosGain && st.nos > 0.04 && dv > 3 && speed > 8 && Math.abs(out.s) < 0.3 && st.heat < 0.7 && !this.aggressive ? 1 : 0;
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

    // Track hazards (v4): pick a lane round solid obstacles, round oil / mud /
    // ice if the bot is a good driver (average ones blunder into them), and
    // onto speed pads.
    _hazards(track, q, lane, speed) {
      const L = track.length;
      const ahead = (at) => {
        let d = at - q.along;
        if (track.closed) d = ((d % L) + L) % L;
        return d;
      };
      const lo = -q.hw + 1.5, hi = q.hw - 1.5;
      const away = (lat, clr) => {
        if (Math.abs(lane - lat) >= clr) return;
        const a = lat + clr, b = lat - clr;
        const aOk = a <= hi, bOk = b >= lo;
        lane = aOk && (!bOk || Math.abs(a - lane) <= Math.abs(b - lane)) ? a : bOk ? b : lane;
      };
      const look = 22 + speed * 1.6;
      for (const o of track.obs) {
        const d = ahead(o.at);
        if (d < -2 || d > look) continue;
        away(o.lat, o.r + 2.4);
        // not across yet and it's close: ease off so the swerve works
        if (d < 32 && Math.abs(q.lat - o.lat) < o.r + 1.9) this._cap = Math.min(this._cap, 13 + d * 0.7);
      }
      if (this.skill >= 0.9) {
        for (const p of track.patches) {
          const d = ahead(p.at);
          if (d < -p.hl || d > look) continue;
          away(p.lat, p.hw + 1.4);
        }
      }
      // speed pads: take one only with speed to spare for what comes next
      // (lastDv = target minus actual speed last frame); otherwise steer round
      // it — a pad right before a hairpin fired bots into the wall
      for (const p of track.pads) {
        const d = ahead(p.at);
        if (d < 0 || d > look * 1.2) continue;
        if ((this.lastDv || 0) > p.dv + 3) lane = U.lerp(lane, p.lat, 0.75);
        else away(p.lat, p.hw + 1.3);
        break;
      }
      return lane;
    }
  }

  G.Bot = Bot;
  G.BOT_NAMES = NAMES;
})(window.G);
