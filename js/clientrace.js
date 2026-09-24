// clientrace.js — what a REMOTE client runs during a race. It never decides
// anything: the host's snapshots are the truth. Three techniques hide latency:
//
// 1. PROJECTION (other cars)   [v5.2 — this used to be interpolation]
//    A snapshot describes the host a latency AGO, while our own car is
//    predicted a latency into the host's FUTURE — that is what prediction is.
//    So drawing the other cars straight out of the newest snapshot already put
//    them a whole round trip behind our own car, and buffering them a further
//    100 ms in the past to get smooth motion made it worse. Measured with
//    tools/netlag.js, the gap between where a car was DRAWN relative to us and
//    where the host really had it was 2.7 m on a LAN, 3.6 m on Wi-Fi, 5.3 m on
//    a poor link and 8.9 m through the backup relay — against a car 4.3 m
//    long. (Both ways round, five runs each, one session.) That is the whole
//    "the cars are further ahead than they seem" complaint: you cannot aim at
//    anyone, you drive through cars that are really in front of you, and you
//    get shoved by a car your screen has not caught up with yet.
//    Every remote car is therefore dead-reckoned forward onto OUR clock by
//    (snapshot age + RTT). A constant yaw rate integrates exactly, so a
//    cornering car projects properly instead of flying off on a tangent, and
//    the leftover model error goes into an eased offset rather than a visible
//    twitch. Projections are clamped to the road, so a guess never puts a car
//    through a barrier, and once the host has been quiet for STALE_MS we stop
//    guessing and hold.
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
//         hide the difference in a visual offset that eases out (a
//         critically damped spring, ~0.3 s).
//    Errors > SNAP_DIST (a big shunt we couldn't predict, a respawn) snap.
//
// 3. CONTACT PREDICTION (our car only)   [v5.2]
//    Our own HALF of a car-vs-car contact is resolved locally against the
//    other cars as we are drawing them, with the host's own maths (P.contact,
//    onlyA). The host still decides: its answer overwrites ours with the next
//    snapshot, exactly like a wall hit. The point is timing — leaning on
//    somebody stops you now instead of letting you slide through and be
//    yanked back a round trip later, and the bang happens while you can see
//    what caused it. This is only safe BECAUSE of (1): predicting contacts
//    against cars drawn in the past is how phantom collisions start.
'use strict';
(function (G) {
  const U = G.U, P = G.Physics, NP = G.NetPack;
  const TPI = 4;
  // (v5.5: 320 / 300 / 380 ms before. Through the backup relay a car has to
  // be guessed ~450 ms ahead to sit where it really is next to OUR car, and
  // the old cap left every relayed car drawn 2.9 m behind on average - now
  // 1.2 m. School Wi-Fi also stalls for a few hundred ms at a time: past the
  // old 300 ms every car froze, then jumped up to 5.6 m when the burst
  // landed. Measured with tools/netlag.js, three seeds each.)
  const LEAD_MAX = 600; // ms of dead reckoning we are willing to do at all
  const STALE_MS = 550; // newest snapshot older than this: stop guessing, hold
  const LEAD_TOTAL = 700; // ms; a stalled link must not slide cars across the map
  const EASE_MAX = 7; // m; a bigger step than this is a respawn, so snap to it (a respawn is flagged as one anyway)
  const SPRING_W = 18; // 1/s: how stiffly that offset is pulled back to zero (critically damped, ~0.25 s)
  const OFF_WIN = 4000; // ms window for the host-clock estimate
  // How a client resolves its own half of a contact: the impulse of a real
  // bump, no position claim, nothing below a 1.2 m/s closing speed. See the
  // note on P.contact for why each of those matters.
  const MY_HALF = { onlyA: 1, noPush: 1, minVn: 1.2 };
  // ...and only while the guess about where the other cars are is good enough
  // to claim a bang at all. Measured (tools/netlag.js, deliberate ramming):
  // guessing under a quarter of a second ahead, every predicted bang was a
  // real one; past ~0.28 s more than a third of them were phantom bangs the
  // host never had. Through the backup relay we are always past that, so a
  // relayed player gets the projection but hears shunts from the host only.
  const GUESS_MAX = 0.26; // s
  const KEEP_MS = 1500;
  const SNAP_DIST = 9; // (v5.5: 6 - the softer spring below can be carrying a few metres when a stall's correction lands)
  const VIS_W = 12; // 1/s, own-car correction spring (critically damped)

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
      this.countdown = 10.5;
      this.goHost = null;
      this.rs = race.entrants.map((e, i) => {
        const g = this.track.gridSlot(i);
        return Object.assign(blankRs(), { x: g.x, z: g.z, h: g.h });
      });
      this.stats = { snaps: 0, corrections: 0, snapsDropped: 0, lastErr: 0 };
      this.osamp = []; // host-clock samples, a moving window
      this.lead = 0; // s we are currently projecting the other cars forward by
      this.fresh = false; // are we hearing from the host often enough to guess?
      // Every entrant's spec, so we can predict our own half of a contact.
      // Mass, size and yaw inertia don't change during a race, so once is enough.
      this.specs = race.entrants.map((e) => G.Parts.computeSpec(e.carId, e.parts, e.wear, e.tune));
      // Per remote car: the eased offset that hides each projection correction.
      this.ease = race.entrants.map(() => ({ x: 0, z: 0, h: 0, ox: 0, oz: 0, oh: 0, k: -1, hint: -1, has: false }));
      this.evs = []; // hits we predicted ourselves, so a shunt sparks on time
      this._hitAt = {}; // other car id -> when we last predicted hitting it
      this._rem = [];
      this._remN = 0;
      this._q = {};
      // v5 race environment for our own car's prediction (same as the host's)
      this.weather = race.weather || null;
      this.endu = race.endu || null;
      this.laps = this.endu ? this.endu.laps : this.track.laps;
      this.env = { t: 0, wet: 0, endu: this.endu };
      if (this.meIdx >= 0) {
        const e = race.entrants[this.meIdx];
        this.spec = this.specs[this.meIdx]; // identical to the host's: same entrant data
        const g = this.track.gridSlot(this.meIdx);
        this.pred = P.createCar(g.x, g.z, g.h);
        this.pred.hint = g.i;
        this.pred.tyreWear = (e.wear && e.wear.tyre) || 0;
        this.pred.engineWear = (e.wear && e.wear.engine) || 0;
        this.pred.body = (e.wear && e.wear.body) || 0;
        this.hist = [];
        this.seq = 0;
        this.blockT = TPI; // forces a new block on the first tick
        this.cur = { s: 0, t: 0, b: 0, hb: 0, n: 0 };
        this.acc = 0;
        this.px = g.x; this.pz = g.z; this.ph = g.h;
        this.vis = { x: 0, z: 0, h: 0, vx: 0, vz: 0, vh: 0 };
        this._me = { st: this.pred, spec: this.spec };
      }
    }

    hostNow() {
      return performance.now() + (this.offset || 0);
    }

    // race time and rain as the host sees them now
    _env() {
      const t = this.goHost != null ? Math.max(0, (this.hostNow() - this.goHost) / 1000) : 0;
      this.env.t = t;
      this.env.wet = G.RaceEnv.wet(this.weather, t);
      return this.env;
    }

    onSnap(m) {
      if (m.no !== this.no) return;
      if (m.k <= this.lastK) {
        this.stats.snapsDropped++;
        return; // arrived out of order: we already have something newer
      }
      this.lastK = m.k;
      this.stats.snaps++;
      const now = performance.now();
      // Host-clock estimate, for the countdown and the race clock only — the
      // other cars no longer depend on it. The least-delayed packet in a
      // moving window: an all-time maximum that leaked only 1% per snapshot
      // meant one lucky early packet skewed the clock for five seconds, and
      // every remote car stuttered for as long as it took to bleed off.
      const sample = m.ts - now;
      this.osamp.push({ s: sample, t: now });
      while (this.osamp.length > 1 && this.osamp[0].t < now - OFF_WIN) this.osamp.shift();
      let mx = -Infinity;
      for (const q of this.osamp) if (q.s > mx) mx = q.s;
      if (this.offset == null || mx > this.offset) this.offset = mx;
      else this.offset += (mx - this.offset) * 0.08;
      this.snaps.push({ ts: m.ts, c: m.c, rt: now, k: m.k });
      while (this.snaps.length > 3 && this.snaps[0].ts < m.ts - KEEP_MS) this.snaps.shift();
      if (m.sl) {
        this.slow = m.sl.map(NP.unpackSlow);
        this.slowAt = m.ts;
      }
      this.phase = NP.PH_NAMES[m.ph];
      this.countdown = m.cd;
      this.hold = m.hw || 0; // racers the host is still waiting for (start hold)
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
      const env = this._env();
      for (let i = 0; i <= last; i++) {
        const b = this.hist[i];
        let n = i === last ? this.blockT : TPI; // newest block: only as far as we've simulated it
        if (b.seq === m.ack) n = Math.max(0, n - m.at); // host already applied `at` ticks of it
        for (let k = 0; k < n; k++) {
          P.step(st, this.spec, b.inp, this.track, P.DT, { frozen: frozenTicks > 0, env });
          this._contact(true); // the same contacts, so leaning on somebody doesn't fight the replay
          frozenTicks--;
        }
      }
      // (c) hide the correction in a decaying visual offset
      const ex = ox - st.x, ez = oz - st.z;
      const err = Math.hypot(ex, ez);
      this.stats.lastErr = err;
      if (err > 0.05) this.stats.corrections++;
      if (err > SNAP_DIST) {
        this.vis.x = this.vis.z = this.vis.h = this.vis.vx = this.vis.vz = this.vis.vh = 0;
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
      this._project(performance.now());
      this._remote();
      this.acc += dt;
      const env = this._env();
      let n = 0;
      while (this.acc >= P.DT && n < 12) {
        if (this.blockT >= TPI) {
          this.seq++;
          this.cur = { s: input.s, t: input.t, b: input.b, hb: input.hb, n: input.n ? 1 : 0 };
          this.hist.push({ seq: this.seq, inp: this.cur });
          if (this.hist.length > 120) this.hist.shift(); // 4 s cap
          // Redundancy: each packet also carries the previous two blocks, so a
          // single lost packet (the fast channel is unreliable) no longer means
          // the host applies the wrong input for 4+ ticks. At 5% loss that was
          // the source of every 0.5–1 m correction spike.
          const red = [];
          for (let k = this.hist.length - 2; k >= 0 && k >= this.hist.length - 3; k--) {
            const h = this.hist[k];
            red.push([h.seq, h.inp.s, h.inp.t, h.inp.b, h.inp.hb, h.inp.n]);
          }
          this.net.sendFast({ t: 'i', q: this.seq, s: this.cur.s, th: this.cur.t, b: this.cur.b, hb: this.cur.hb, n: this.cur.n, rs: input.rs ? 1 : 0, p: red });
          input.rs = 0;
          this.blockT = 0;
        }
        this.px = st.x; this.pz = st.z; this.ph = st.h;
        P.step(st, this.spec, this.cur, this.track, P.DT, { frozen: this.predFrozen(), env });
        this._contact();
        this.blockT++;
        this.acc -= P.DT;
        n++;
      }
      if (n >= 12) this.acc = 0;
      // v5.5: the visual offset rides a critically damped spring (as for
      // the other cars), so a correction - the big one after a Wi-Fi stall
      // especially - glides in instead of yanking the car sideways on the
      // first frame. Measured through 0.35-0.7 s stalls: frames where our own
      // car visibly jumped went from 17-20 a minute to 0-2.
      const V = this.vis, sx = Math.exp(-VIS_W * dt);
      let tq = (V.vx + VIS_W * V.x) * dt;
      V.x = (V.x + tq) * sx; V.vx = (V.vx - VIS_W * tq) * sx;
      tq = (V.vz + VIS_W * V.z) * dt;
      V.z = (V.z + tq) * sx; V.vz = (V.vz - VIS_W * tq) * sx;
      tq = (V.vh + VIS_W * V.h) * dt;
      V.h = (V.h + tq) * sx; V.vh = (V.vh - VIS_W * tq) * sx;
    }

    // The other cars, dead-reckoned onto OUR clock. See note (1) at the top.
    _project(now) {
      const S = this.snaps;
      if (!S.length) return;
      const A = S[S.length - 1];
      const dt = Math.min(0.1, Math.max(0, (now - (this._pt == null ? now : this._pt)) / 1000));
      this._pt = now;
      const age = now - A.rt;
      // How far ahead of the snapshot we have to guess to land on our own
      // car's clock: the snapshot's own age plus the round trip. Past STALE_MS
      // the link has gone quiet and guessing further only flings cars about.
      this.fresh = age < STALE_MS;
      // (the ping estimate moves in steps once a second; glide between them,
      // or every remote car hops a little each time it updates)
      const rttNow = U.clamp((this.net && this.net.rtt) || 0, 0, 3000);
      this.rttS = this.rttS == null ? rttNow : this.rttS + (rttNow - this.rttS) * (1 - Math.exp(-dt / 0.6));
      const rttL = Math.min(this.rttS, LEAD_MAX);
      const leadOf = (snap) => Math.min(Math.min(now - snap.rt, STALE_MS) + rttL, LEAD_TOTAL) / 1000;
      const lead = leadOf(A);
      this.lead = lead;
      const T = this._pj || (this._pj = { x: 0, z: 0, h: 0, vx: 0, vz: 0, hint: -1 });
      for (let j = 0; j < this.rs.length; j++) {
        if (j === this.meIdx) continue;
        const o = this.rs[j];
        NP.unpackFast(A.c[j], o);
        const E = this.ease[j];
        this._guess(o, lead, E, T);
        const tx = T.x, tz = T.z, th = T.h;
        o.vx = T.vx;
        o.vz = T.vz;
        // A new snapshot moves the target by whatever the guess got wrong.
        // Absorb that step in an offset that decays, so the car doesn't twitch
        // every time one lands. Too big a step is a respawn: snap to it.
        // v5.5: the step is measured against where the OLD guess puts the car
        // at this instant - not where it was drawn last frame. Last frame's
        // spot was a frame of travel behind, so every car stood still for one
        // frame each time a snapshot landed (30 times a second: a fine,
        // constant shimmer on every car you race against, 0.4 m at speed).
        // v5.5: the offset rides a critically damped spring instead of
        // decaying straight away. The position was already continuous; now
        // its SPEED is too, so a correction eases in and out rather than
        // kinking the car's path the frame it starts.
        const sx = Math.exp(-SPRING_W * dt);
        let tq = ((E.vx || 0) + SPRING_W * E.ox) * dt;
        E.ox = (E.ox + tq) * sx; E.vx = ((E.vx || 0) - SPRING_W * tq) * sx;
        tq = ((E.vz || 0) + SPRING_W * E.oz) * dt;
        E.oz = (E.oz + tq) * sx; E.vz = ((E.vz || 0) - SPRING_W * tq) * sx;
        tq = ((E.vh || 0) + SPRING_W * E.oh) * dt;
        E.oh = (E.oh + tq) * sx; E.vh = ((E.vh || 0) - SPRING_W * tq) * sx;
        if (E.k !== A.k) {
          let bx = E.x, bz = E.z, bh = E.h;
          if (E.has && E.base && E.base !== A) {
            const B = this._pjOld || (this._pjOld = { slip: [0, 0, 0, 0], surf: [0, 0, 0, 0] });
            NP.unpackFast(E.base.c[j], B);
            const T2 = this._pj2 || (this._pj2 = { x: 0, z: 0, h: 0, vx: 0, vz: 0, hint: -1 });
            T2.hint = E.hint;
            this._guess(B, leadOf(E.base), T2, T2);
            bx = T2.x + E.ox;
            bz = T2.z + E.oz;
            bh = U.wrapAngle(T2.h + E.oh);
          }
          E.k = A.k;
          E.base = A;
          const ex = bx - tx, ez = bz - tz;
          if (E.has && !o.ghost && Math.hypot(ex, ez) < EASE_MAX) {
            E.ox = ex;
            E.oz = ez;
            E.oh = U.wrapAngle(bh - th);
          } else E.ox = E.oz = E.oh = E.vx = E.vz = E.vh = 0;
        }
        o.x = E.x = tx + E.ox;
        o.z = E.z = tz + E.oz;
        o.h = E.h = U.wrapAngle(th + E.oh);
        o.hint = E.hint = T.hint;
        E.has = true;
      }
    }

    // Dead-reckon one car (unpacked fast state `o`) `t` seconds ahead into
    // `out` {x, z, h, vx, vz, hint}. `H.hint` seeds the road lookup.
    _guess(o, t, H, out) {
      const tr = this.track;
      const vx = o.vx, vz = o.vz, w = o.w;
      let tx, tz;
      if (Math.abs(w) > 0.02) {
        // Constant yaw rate. A car in a corner holds its rate of turn far
        // better than it holds a straight line, so integrating the rotating
        // velocity exactly is what makes guessing this far ahead work at all
        // - plain velocity dead reckoning fires cars off on the tangent.
        const s1 = Math.sin(w * t), c1 = 1 - Math.cos(w * t);
        tx = o.x + (vx * s1 + vz * c1) / w;
        tz = o.z + (vz * s1 - vx * c1) / w;
      } else {
        tx = o.x + vx * t;
        tz = o.z + vz * t;
      }
      // Braking and accelerating, along the car's own axis at mid-guess. ax
      // is already a smoothed number and this is a guess, so take half of it.
      const th = U.wrapAngle(o.h + w * t);
      const hm = o.h + w * t * 0.5;
      const al = U.clamp(o.ax, -12, 12) * t * t * 0.25;
      tx += Math.sin(hm) * al;
      tz += Math.cos(hm) * al;
      // Turn the velocity with it, so wheel spin, engine note, body roll and
      // the skid marks all match the direction the car is actually pointing.
      const cw = Math.cos(w * t), sw = Math.sin(w * t);
      out.vx = vx * cw + vz * sw;
      out.vz = vz * cw - vx * sw;
      // Never guess a car through a barrier.
      const q = tr.query(tx, tz, H.hint, this._q);
      out.hint = q.i;
      if (Math.abs(q.lat) > q.wall) {
        const d = U.clamp(q.lat, -q.wall, q.wall) - q.lat;
        tx += q.nx * d;
        tz += q.nz * d;
      }
      out.x = tx;
      out.z = tz;
      out.h = th;
    }

    // The other cars as we are DRAWING them, ready for a contact test.
    _remote() {
      this._remN = 0;
      if (!this.fresh || this.phase !== 'race' || this.lead > GUESS_MAX) return;
      for (let j = 0; j < this.rs.length; j++) {
        if (j === this.meIdx) continue;
        const R = this._rem[this._remN] || (this._rem[this._remN] = { st: null, spec: null, id: null });
        R.st = this.rs[j];
        R.spec = this.specs[j];
        R.id = this.entrants[j].id;
        this._remN++;
      }
    }

    // Our own half of a contact - note (3) at the top of the file. `quiet`
    // during a replay, where the bang has already been made once.
    _contact(quiet) {
      const A = this._me;
      for (let i = 0; i < this._remN; i++) {
        const B = this._rem[i];
        const jn = P.contact(A, B, MY_HALF);
        if (jn > 1500 && !quiet) {
          const now = performance.now();
          const last = this._hitAt[B.id];
          if (!last || now - last > 350) {
            this._hitAt[B.id] = now;
            this.evs.push({ type: 'hit', a: this.meId, b: B.id, x: P.HIT.x, z: P.HIT.z, j: jn });
          }
        }
      }
    }

    // Hits we predicted ourselves: sparks and a bang at the moment of contact.
    popEvents() {
      const e = this.evs;
      if (e.length) this.evs = [];
      return e;
    }

    // ...and so the host's own 'hit' for the same contact doesn't spark twice
    // when it arrives a round trip later.
    filterEv(evs) {
      if (!evs || !evs.length) return evs || [];
      const now = performance.now();
      return evs.filter((e) => {
        if (e.type !== 'hit' || (e.a !== this.meId && e.b !== this.meId)) return true;
        const t = this._hitAt[e.a === this.meId ? e.b : e.a];
        return !(t && now - t < 700);
      });
    }

    // Build a RaceView-compatible view.
    view() {
      this._project(performance.now());
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
        return { id: e.id, name: e.name, color: e.color, carId: e.carId, parts: e.parts, look: e.look, rs, dist: i === this.meIdx && this.snaps.length ? this.snaps[this.snaps.length - 1].c[i][16] : rs.raceDist || 0 };
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
          rs: cars[this.meIdx].rs, hasBoost: this.spec.boostKind !== 'none', hasNos: !!this.spec.nosGain, coldBrakes: (this.spec.bCold || 1) < 0.9, wrong: s.wrong, finished: s.finished,
          carId: this.entrants[this.meIdx].carId, parts: this.entrants[this.meIdx].parts, look: this.entrants[this.meIdx].look,
          // v5.1 cluster: the rev scale, and the boost dial's own numbers
          ev: !!this.spec.ev, boostGain: this.spec.boostGain, redline: this.spec.redline,
          boostAvail: G.Parts.boostAvail(this.spec, cars[this.meIdx].rs.rpm),
        };
      }
      const lead = order[0] ? L(order[0].i).lapCount : 1;
      return {
        phase, countdown, hold: this.hold || 0, raceTime, format: tr.format, laps: this.laps, total: this.entrants.length, wet: this.env.wet, endu: this.endu,
        leaderLap: Math.max(1, Math.min(lead, this.laps)), me,
        order: order.map((o) => ({ id: o.e.id, name: o.e.name, color: o.e.color, finished: o.s.finished, dnf: o.s.dnf, stops: o.s.stops || 0, pit: this.rs[o.i] && this.rs[o.i].pit })),
        cars,
        link: { relay: !!(this.net && this.net.via === 'relay'), rtt: Math.round((this.net && this.net.rtt) || 0) },
        net: `${(this.net && this.net.via) || '?'} ${Math.round((this.net && this.net.rtt) || 0)}ms · lead ${Math.round(this.lead * 1000)}ms · err ${this.stats.lastErr.toFixed(2)}m · drops ${this.stats.snapsDropped}`,
      };
    }
  }

  G.ClientRace = ClientRace;
})(window.G);
