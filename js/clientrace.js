// clientrace.js — what a REMOTE client runs during a race. It never decides
// anything: the host's snapshots are the truth. Two techniques hide latency:
//
// 1. INTERPOLATION (other cars)
//    Snapshots are buffered and drawn INTERP_MS in the past, blended between
//    the two snapshots that bracket that time. We estimate the host clock from
//    snapshot timestamps: sample = hostTs - localArrival = clockOffset - latency.
//    We keep (roughly) the MAX sample, i.e. the least-delayed packet, and let
//    it drift down slowly for clock skew. renderTime = localNow + offset - INTERP.
//    If snapshots stop arriving we extrapolate on velocity for EXTRAP_MS, then
//    freeze rather than fling cars into walls.
//
// 2. PREDICTION + RECONCILIATION (own car)
//    Our car runs the SAME physics locally so steering is instant. Inputs are
//    sampled once per BLOCK of TPI ticks (4 × 1/120 s = 30 Hz), applied locally
//    for that block, sent to the host, and remembered in `hist`.
//    Each snapshot carries our car's authoritative full state + `ack` (last
//    input seq the host applied) + `at` (ticks it applied it for). We:
//      a) overwrite our predicted state with the host's,
//      b) replay the remaining (TPI - at) ticks of the acked block and every
//         later block in `hist` (the newest only as far as we've simulated it),
//      c) compute where that puts the car vs. where we were DRAWING it, and
//         hide the difference in a visual offset that decays over ~100 ms.
//    Errors > SNAP_DIST (a big shunt we couldn't predict, a respawn) snap.
//    Car-vs-car contact is never predicted — the host resolves it and the
//    correction arrives with the next snapshot. That's deliberate: clients
//    predicting contacts is how desyncs start.
'use strict';
(function (G) {
  const U = G.U, P = G.Physics, NP = G.NetPack;
  const TPI = 4;
  const INTERP_MS = 100;
  const EXTRAP_MS = 250;
  const KEEP_MS = 1500;
  const SNAP_DIST = 6;
  const VIS_TAU = 0.1;

  function blankRs() {
    return { x: 0, z: 0, h: 0, vx: 0, vz: 0, w: 0, steer: 0, ax: 0, ay: 0, rpm: 0.14, gear: 1, boost: 0, heat: 0, slip: [0, 0, 0, 0], surf: [0, 0, 0, 0], spin: 0, lock: 0, overheat: 0, backfire: 0, ghost: 0, wallHit: 0, raceDist: 0 };
  }

  class ClientRace {
    constructor(race, meId, net) {
      this.no = race.no;
      this.track = G.getTrack(race.trackId);
      this.entrants = race.entrants;
      this.net = net;
      this.meId = meId;
      this.idx = {};
      race.entrants.forEach((e, i) => (this.idx[e.id] = i));
      this.meIdx = this.idx[meId] != null ? this.idx[meId] : -1;
      this.snaps = [];
      this.slow = null;
      this.slowAt = 0;
      this.lastK = -1;
      this.offset = null;
      this.phase = 'grid';
      this.countdown = 4.5;
      this.goHost = null;
      this.rs = race.entrants.map((e, i) => {
        const g = this.track.gridSlot(i);
        return Object.assign(blankRs(), { x: g.x, z: g.z, h: g.h });
      });
      this.stats = { snaps: 0, corrections: 0, snapsDropped: 0, lastErr: 0 };
      if (this.meIdx >= 0) {
        const e = race.entrants[this.meIdx];
        this.spec = G.Parts.computeSpec(e.carId, e.parts, e.wear);
        const g = this.track.gridSlot(this.meIdx);
        this.pred = P.createCar(g.x, g.z, g.h);
        this.pred.hint = g.i;
        this.pred.tyreWear = (e.wear && e.wear.tyre) || 0;
        this.pred.engineWear = (e.wear && e.wear.engine) || 0;
        this.pred.body = (e.wear && e.wear.body) || 0;
        this.hist = [];
        this.seq = 0;
        this.blockT = TPI; // forces a new block on the first tick
        this.cur = { s: 0, t: 0, b: 0, hb: 0 };
        this.acc = 0;
        this.px = g.x; this.pz = g.z; this.ph = g.h;
        this.vis = { x: 0, z: 0, h: 0 };
      }
    }

    hostNow() {
      return performance.now() + (this.offset || 0);
    }

    onSnap(m) {
      if (m.no !== this.no) return;
      if (m.k <= this.lastK) {
        this.stats.snapsDropped++;
        return; // arrived out of order: we already have something newer
      }
      this.lastK = m.k;
      this.stats.snaps++;
      const sample = m.ts - performance.now();
      if (this.offset == null || sample > this.offset) this.offset = sample;
      else this.offset += (sample - this.offset) * 0.01;
      this.snaps.push({ ts: m.ts, c: m.c });
      while (this.snaps.length > 3 && this.snaps[0].ts < m.ts - KEEP_MS) this.snaps.shift();
      if (m.sl) {
        this.slow = m.sl.map(NP.unpackSlow);
        this.slowAt = m.ts;
      }
      this.phase = NP.PH_NAMES[m.ph];
      this.countdown = m.cd;
      // Host time of the green light, used for the countdown and for knowing
      // whether our predicted car should still be held on the grid.
      this.goHost = this.phase === 'grid' ? m.ts + m.cd * 1000 : m.ts - m.rt * 1000;
      if (m.me && this.pred) this.reconcile(m);
    }

    // Will an input we send NOW reach the host after the green light?
    predFrozen() {
      if (this.goHost == null) return true;
      const rtt = (this.net && this.net.rtt) || 80;
      return this.hostNow() + rtt < this.goHost;
    }

    reconcile(m) {
      const st = this.pred;
      // Where we are currently DRAWING the car (prediction + visual offset).
      const ox = st.x + this.vis.x, oz = st.z + this.vis.z, oh = st.h + this.vis.h;
      // (a) rewind to the authoritative state
      NP.unpackFull(m.me, st);
      // drop inputs the host has completely consumed
      while (this.hist.length && this.hist[0].seq < m.ack) this.hist.shift();
      // (b) replay unacknowledged input
      let frozenTicks = m.ph === 0 ? Math.ceil(m.cd / P.DT) : 0;
      const last = this.hist.length - 1;
      for (let i = 0; i <= last; i++) {
        const b = this.hist[i];
        let n = i === last ? this.blockT : TPI; // newest block: only as far as we've simulated it
        if (b.seq === m.ack) n = Math.max(0, n - m.at); // host already applied `at` ticks of it
        for (let k = 0; k < n; k++) {
          P.step(st, this.spec, b.inp, this.track, P.DT, { frozen: frozenTicks > 0 });
          frozenTicks--;
        }
      }
      // (c) hide the correction in a decaying visual offset
      const ex = ox - st.x, ez = oz - st.z;
      const err = Math.hypot(ex, ez);
      this.stats.lastErr = err;
      if (err > 0.05) this.stats.corrections++;
      if (err > SNAP_DIST) {
        this.vis.x = this.vis.z = this.vis.h = 0;
        this.px = st.x; this.pz = st.z; this.ph = st.h;
      } else {
        this.vis.x = ex;
        this.vis.z = ez;
        this.vis.h = U.wrapAngle(oh - st.h);
      }
    }

    // Local prediction at the fixed physics rate, one input block per TPI ticks.
    update(dt, input) {
      if (!this.pred) return;
      const st = this.pred;
      this.acc += dt;
      let n = 0;
      while (this.acc >= P.DT && n < 12) {
        if (this.blockT >= TPI) {
          this.seq++;
          this.cur = { s: input.s, t: input.t, b: input.b, hb: input.hb };
          this.hist.push({ seq: this.seq, inp: this.cur });
          if (this.hist.length > 120) this.hist.shift(); // 4 s cap
          this.net.sendFast({ t: 'i', q: this.seq, s: this.cur.s, th: this.cur.t, b: this.cur.b, hb: this.cur.hb, rs: input.rs ? 1 : 0 });
          input.rs = 0;
          this.blockT = 0;
        }
        this.px = st.x; this.pz = st.z; this.ph = st.h;
        P.step(st, this.spec, this.cur, this.track, P.DT, { frozen: this.predFrozen() });
        this.blockT++;
        this.acc -= P.DT;
        n++;
      }
      if (n >= 12) this.acc = 0;
      const k = Math.exp(-dt / VIS_TAU);
      this.vis.x *= k;
      this.vis.z *= k;
      this.vis.h *= k;
    }

    // Interpolated remote car states for the current render time.
    _interp() {
      const S = this.snaps;
      if (!S.length) return;
      const rt = this.hostNow() - INTERP_MS;
      let a = S[0], b = null;
      for (let i = S.length - 1; i >= 0; i--) {
        if (S[i].ts <= rt) {
          a = S[i];
          b = S[i + 1] || null;
          break;
        }
      }
      for (let j = 0; j < this.rs.length; j++) {
        if (j === this.meIdx) continue;
        const o = this.rs[j];
        if (b) {
          const t = U.clamp((rt - a.ts) / (b.ts - a.ts || 1), 0, 1);
          NP.unpackFast(t < 0.5 ? a.c[j] : b.c[j], o); // discrete fields from the nearer snapshot
          const A = a.c[j], B = b.c[j];
          o.x = U.lerp(A[0], B[0], t); o.z = U.lerp(A[1], B[1], t); o.h = U.lerpAngle(A[2], B[2], t);
          o.vx = U.lerp(A[3], B[3], t); o.vz = U.lerp(A[4], B[4], t);
          o.steer = U.lerp(A[6], B[6], t); o.ax = U.lerp(A[7], B[7], t); o.ay = U.lerp(A[8], B[8], t);
          o.raceDist = U.lerp(A[16], B[16], t);
        } else {
          // starved: extrapolate on velocity for a short while, then hold
          NP.unpackFast(a.c[j], o);
          const ex = U.clamp(rt - a.ts, 0, EXTRAP_MS) / 1000;
          o.x += o.vx * ex;
          o.z += o.vz * ex;
          o.h += o.w * ex;
        }
      }
    }

    // Build a RaceView-compatible view.
    view() {
      this._interp();
      const tr = this.track;
      const hostNow = this.hostNow();
      const cars = this.entrants.map((e, i) => {
        let rs = this.rs[i];
        if (i === this.meIdx) {
          const st = this.pred;
          const a = this.acc / P.DT;
          rs = Object.assign({}, st, {
            x: U.lerp(this.px, st.x, a) + this.vis.x,
            z: U.lerp(this.pz, st.z, a) + this.vis.z,
            h: U.lerpAngle(this.ph, st.h, a) + this.vis.h,
          });
        }
        return { id: e.id, name: e.name, color: e.color, rs };
      });
      const slow = this.slow;
      const L = (i) => (slow && slow[i] ? slow[i] : { lapCount: 0, finished: false, dnf: false, finishMs: null, bestLap: null, lastLap: null, curMs: 0, wrong: false });
      const dist = (i) => (i === this.meIdx && this.snaps.length ? this.snaps[this.snaps.length - 1].c[i][16] : cars[i].rs.raceDist || 0);
      const order = this.entrants
        .map((e, i) => ({ i, e, s: L(i), d: dist(i) }))
        .sort((x, y) => {
          if (x.s.finished && y.s.finished) return x.s.finishMs - y.s.finishMs;
          if (x.s.finished) return -1;
          if (y.s.finished) return 1;
          return y.d - x.d;
        });
      const raceTime = this.goHost != null ? Math.max(0, (hostNow - this.goHost) / 1000) : 0;
      let countdown = this.goHost != null ? Math.max(0, (this.goHost - hostNow) / 1000) : this.countdown;
      let phase = this.phase;
      if (phase === 'grid' && countdown <= 0) phase = 'race';
      let me = null;
      if (this.meIdx >= 0) {
        const s = L(this.meIdx);
        const since = s.finished ? 0 : Math.max(0, hostNow - this.slowAt);
        me = {
          id: this.meId, pos: order.findIndex((o) => o.i === this.meIdx) + 1, lapCount: s.lapCount,
          curMs: s.finished ? s.finishMs : s.curMs + since, lastLap: s.lastLap, bestLap: s.bestLap,
          rs: cars[this.meIdx].rs, hasBoost: this.spec.boostKind !== 'none', wrong: s.wrong, finished: s.finished,
        };
      }
      const lead = order[0] ? L(order[0].i).lapCount : 1;
      return {
        phase, countdown, raceTime, format: tr.format, laps: tr.laps, total: this.entrants.length,
        leaderLap: Math.max(1, Math.min(lead, tr.laps)), me,
        order: order.map((o) => ({ id: o.e.id, name: o.e.name, color: o.e.color, finished: o.s.finished, dnf: o.s.dnf })),
        cars,
        net: `rtt ${Math.round((this.net && this.net.rtt) || 0)}ms · err ${this.stats.lastErr.toFixed(2)}m · drops ${this.stats.snapsDropped}`,
      };
    }
  }

  G.ClientRace = ClientRace;
})(window.G);
