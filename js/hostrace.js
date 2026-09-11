// hostrace.js — the host's race loop. Wraps the authoritative RaceSim and is
// the ONLY thing that advances it. Netcode notes:
//
//  INPUTS (client -> host, 'fast' channel, 30 Hz)
//    {t:'i', q:seq, s, th, b, hb, rs}. Each packet is one BLOCK of input that
//    the client applied for exactly TPI (=4) ticks in its own prediction.
//    The host keeps a small per-client JITTER BUFFER (sorted by seq) and
//    consumes it at the same rate: one block per TPI ticks, in order. That
//    makes the host apply inputs with the same tick timing the client used,
//    so the client's replay (clientrace.js) lands on the same answer even when
//    packets arrive bunched or late. (An earlier "apply the latest packet each
//    tick" version drifted up to ~1 m per correction at 200 ms jittery RTT.)
//      * starved (next block not here yet): keep applying the current block;
//        `ticks` keeps counting past TPI and the client's replay accounts for it.
//        Starved for more than STALE ticks (the player's device froze, or the
//        link stalled), a stand-in bot drives the car at reduced power until
//        input returns. Repeating the last input for seconds drove frozen
//        players into walls, which looked like a desync to everyone.
//      * buffer deeper than MAX_Q blocks: drop the oldest so added latency
//        stays bounded (~100 ms worst case). Except while catching up after
//        a host hitch: then the queued blocks ARE the missed time.
//
//  TIME: the host advances by REAL elapsed time. After a hitch (a GC pause, a
//  first-time load on a slow Chromebook) it catches up by as much as CATCHUP
//  instead of dropping the time. Dropping it threw away every client's
//  inputs for the lost time, and every client's car jumped back (13.9 m
//  after a 1 s hitch in testing). At most one snapshot goes out per frame.
//
//  START HOLD: the countdown waits (up to HOLD_MAX) until every connected
//  human racer is sending input, which means they've finished building the
//  track. A slow first load used to eat into the countdown.
//    If a client DISCONNECTS the car gets "park" input and stops — it is never
//    simulated by anyone else.
//
//  SNAPSHOTS (host -> client, 'fast', every 6th tick = 20 Hz)
//    Everyone gets every car's FAST array; every 4th snapshot adds SLOW data
//    (laps, times, wear). A racing client additionally gets its own car's
//    FULL core state plus `ack` (last input seq applied) and `at` (how many
//    ticks that input has been applied). Those three are exactly what the
//    client needs to rewind to our state and replay only the inputs we
//    haven't processed yet — see clientrace.js.
'use strict';
(function (G) {
  const U = G.U, P = G.Physics, NP = G.NetPack;
  const SNAP_EVERY = 6; // ticks (120 Hz / 6 = 20 Hz)
  const TPI = 4; // ticks per input block (must match clientrace.js)
  const MAX_Q = 3; // jitter-buffer depth cap, in blocks
  const CATCHUP = 1.0; // s of host hitch simulated afterwards instead of dropped (six cars ≈ 3 ms per simulated second on a desktop, ~10x that on a Chromebook)
  const STALE = 30; // ticks (0.25 s) of missing input before a stand-in bot takes the wheel
  const HOLD_MAX = 8; // s the countdown will wait for slow loaders
  const BRAKE = { s: 0, t: 0, b: 1, hb: 1 }; // "park": brake + handbrake never engages reverse

  class HostRace {
    constructor(session, net, localPid) {
      this.session = session;
      this.net = net;
      this.localPid = localPid;
      const r = session.state.race;
      this.no = r.no;
      this.track = G.getTrack(r.trackId);
      this.sim = new G.RaceSim(this.track, r.entrants, { countdown: 4.5, catchup: r.catchup || 0 });
      this.inputs = {}; // pid -> {q: [blocks], cur: block|null, seq, ticks, rs}
      this.acc = 0;
      this.snapN = 0;
      this.doneAt = null;
      this.finished = false;
      this.stats = { snaps: 0, bytes: 0 };
      this.others = this.sim.cars.map((c) => c.st); // for stand-in bots
      this.lastNow = null;
      this.holdT = 0;
    }

    onInput(pid, m) {
      if (!this.sim.byId[pid]) return; // spectators can't drive
      let I = this.inputs[pid];
      if (!I) I = this.inputs[pid] = { q: [], cur: null, seq: -1, ticks: 0, rs: 0 };
      if (typeof m.q !== 'number') return;
      this._insert(I, m.q, m.s, m.th, m.b, m.hb, m.n);
      // redundant copies of the previous blocks: recover any we lost
      if (Array.isArray(m.p)) for (const r of m.p.slice(0, 3)) if (Array.isArray(r)) this._insert(I, r[0], r[1], r[2], r[3], r[4], r[5]);
      if (m.rs) I.rs = 1;
    }

    _insert(I, seq, s, th, b, hb, n) {
      if (typeof seq !== 'number' || seq <= I.seq) return; // already consumed / stale
      if (I.q.some((x) => x.seq === seq)) return; // duplicate
      // Clamp everything: never trust the wire.
      const blk = { seq, inp: { s: U.clamp(+s || 0, -1, 1), t: U.clamp(+th || 0, 0, 1), b: U.clamp(+b || 0, 0, 1), hb: hb ? 1 : 0, n: n ? 1 : 0 } };
      // insert in seq order (the fast channel is unordered)
      let i = I.q.length;
      while (i > 0 && I.q[i - 1].seq > blk.seq) i--;
      I.q.splice(i, 0, blk);
    }

    // Advance one client's jitter buffer by one tick; returns the input to use.
    // left = ticks still to run this frame (more than one when catching up).
    _nextInput(I, left) {
      if (!I.cur || I.ticks >= TPI) {
        if (I.q.length) {
          const deep = MAX_Q + Math.ceil(Math.max(0, left || 0) / TPI);
          while (I.q.length > deep) I.q.shift(); // too far behind: skip ahead
          I.cur = I.q.shift();
          I.seq = I.cur.seq;
          I.ticks = 0;
        } // else starved: keep the current block (ticks runs past TPI)
      }
      if (!I.cur) return null;
      I.ticks++;
      return I.cur.inp;
    }

    // A bot keeps a frozen player's car on the road (at 70% throttle, so
    // freezing is never an advantage) until their input arrives again.
    _standIn(c) {
      if (!c.standIn) c.standIn = new G.Bot(0.7, U.hashStr(c.id) + 1);
      const o = c.standIn.drive(c.st, c.spec, this.track, P.DT, this.others);
      return { s: o.s, t: o.t * 0.7, b: o.b, hb: o.hb, n: 0 };
    }

    // Start hold: connected human racers who haven't sent any input yet are
    // still building the track. The countdown pauses while any remain.
    _hold() {
      let waiting = 0;
      for (const c of this.sim.cars) {
        if (c.bot || c.id === this.localPid || this.inputs[c.id]) continue;
        const p = this.session.player(c.id);
        if (p && p.connected) waiting++;
      }
      const hold = waiting > 0 && this.holdT < HOLD_MAX;
      if (hold) this.holdT += P.DT;
      this.sim.hold = hold;
      this.sim.holdN = hold ? waiting : 0;
    }

    // Advance the race by REAL elapsed time (fixed 120 Hz steps), catching up
    // to CATCHUP after a hitch. dt (the app's, clamped to 0.1 s) is only
    // used for the very first frame.
    update(dt, localInput) {
      const sim = this.sim;
      const now = performance.now();
      const gap = this.lastNow == null ? dt : Math.max(0, (now - this.lastNow) / 1000);
      this.lastNow = now;
      this.acc = Math.min(this.acc + gap, CATCHUP);
      // Just out of a hitch: give the input messages that queued up during it
      // two frames to arrive BEFORE simulating the missed time with them.
      // Catching up straight away ran on stale input, then threw the late
      // inputs away (an 11 m jump for every client after a 1 s hitch).
      if (gap > 0.15) this.settle = 2;
      if (this.settle > 0) {
        this.settle--;
        return [];
      }
      const maxN = Math.ceil(CATCHUP / P.DT) + 1;
      let n = 0, snapDue = false;
      while (this.acc >= P.DT && n < maxN) {
        const left = Math.floor(this.acc / P.DT) - 1; // ticks still to run this frame after this one
        for (const c of sim.cars) {
          if (c.bot) continue;
          if (c.id === this.localPid) {
            sim.setInput(c.id, localInput);
            continue;
          }
          const p = this.session.player(c.id);
          const I = this.inputs[c.id];
          const inp = p && p.connected && I ? this._nextInput(I, left) : null;
          if (!inp) {
            sim.setInput(c.id, BRAKE);
            continue;
          }
          if (I.ticks > TPI + STALE && sim.phase === 'race') {
            sim.setInput(c.id, this._standIn(c));
            continue;
          }
          sim.setInput(c.id, I.rs ? { s: inp.s, t: inp.t, b: inp.b, hb: inp.hb, n: inp.n, rs: 1 } : inp);
          I.rs = 0;
        }
        localInput.rs = 0;
        if (sim.phase === 'grid') this._hold();
        sim.step();
        if (sim.tick % SNAP_EVERY === 0) snapDue = true;
        this.acc -= P.DT;
        n++;
      }
      if (n >= maxN) this.acc = 0; // hitched for longer than CATCHUP: drop the rest rather than spiral
      if (snapDue) this.broadcast(); // one per frame: a catch-up burst of same-timestamp snapshots made remote cars jump
      const ev = sim.popEvents();
      if (ev.length && this.net) this.net.broadcastCtrl({ t: 'ev', no: this.no, e: ev });
      if (sim.phase === 'done' && !this.finished) {
        if (this.doneAt == null) this.doneAt = performance.now();
        if (performance.now() - this.doneAt > 2500) {
          this.finished = true;
          this.session.finishRace(sim.results(), sim);
        }
      }
      return ev;
    }

    broadcast() {
      if (!this.net) return;
      const sim = this.sim;
      this.snapN++;
      const base = {
        t: 's', no: this.no, k: sim.tick, ts: performance.now(),
        ph: NP.PH[sim.phase], cd: Math.max(0, +sim.countdown.toFixed(3)),
        rt: sim.raceStartT != null ? +(sim.t - sim.raceStartT).toFixed(3) : 0,
        c: sim.cars.map(NP.packFast),
      };
      if (this.snapN % 4 === 0) base.sl = sim.cars.map((c) => NP.packSlow(c, sim));
      if (sim.holdN) base.hw = sim.holdN; // countdown held: this many racers still loading
      for (const pid of this.net.connectedPids()) {
        const c = sim.byId[pid];
        let msg = base;
        if (c) {
          const I = this.inputs[pid];
          msg = Object.assign({}, base, { me: NP.packFull(c.st), ack: I ? I.seq : -1, at: I ? I.ticks : 0 });
        }
        this.net.sendFast(pid, msg);
        this.stats.snaps++;
      }
    }
  }

  G.HostRace = HostRace;
})(window.G);
