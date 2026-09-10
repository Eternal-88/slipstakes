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
//      * buffer deeper than MAX_Q blocks: drop the oldest so added latency
//        stays bounded (~100 ms worst case).
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
  const BRAKE = { s: 0, t: 0, b: 1, hb: 1 }; // "park": brake + handbrake never engages reverse

  class HostRace {
    constructor(session, net, localPid) {
      this.session = session;
      this.net = net;
      this.localPid = localPid;
      const r = session.state.race;
      this.no = r.no;
      this.track = G.getTrack(r.trackId);
      this.sim = new G.RaceSim(this.track, r.entrants, { countdown: 4.5 });
      this.inputs = {}; // pid -> {q: [blocks], cur: block|null, seq, ticks, rs}
      this.acc = 0;
      this.snapN = 0;
      this.doneAt = null;
      this.finished = false;
      this.stats = { snaps: 0, bytes: 0 };
    }

    onInput(pid, m) {
      if (!this.sim.byId[pid]) return; // spectators can't drive
      let I = this.inputs[pid];
      if (!I) I = this.inputs[pid] = { q: [], cur: null, seq: -1, ticks: 0, rs: 0 };
      if (typeof m.q !== 'number' || m.q <= I.seq) return; // already consumed / stale
      if (I.q.some((b) => b.seq === m.q)) return; // duplicate
      // Clamp everything: never trust the wire.
      const blk = { seq: m.q, inp: { s: U.clamp(+m.s || 0, -1, 1), t: U.clamp(+m.th || 0, 0, 1), b: U.clamp(+m.b || 0, 0, 1), hb: m.hb ? 1 : 0 } };
      // insert in seq order (the fast channel is unordered)
      let i = I.q.length;
      while (i > 0 && I.q[i - 1].seq > blk.seq) i--;
      I.q.splice(i, 0, blk);
      if (m.rs) I.rs = 1;
    }

    // Advance one client's jitter buffer by one tick; returns the input to use.
    _nextInput(I) {
      if (!I.cur || I.ticks >= TPI) {
        if (I.q.length) {
          while (I.q.length > MAX_Q) I.q.shift(); // too far behind: skip ahead
          I.cur = I.q.shift();
          I.seq = I.cur.seq;
          I.ticks = 0;
        } // else starved: keep the current block (ticks runs past TPI)
      }
      if (!I.cur) return null;
      I.ticks++;
      return I.cur.inp;
    }

    // Advance the race by dt seconds of wall time (fixed 120 Hz steps).
    update(dt, localInput) {
      const sim = this.sim;
      this.acc += dt;
      let n = 0;
      while (this.acc >= P.DT && n < 12) {
        for (const c of sim.cars) {
          if (c.bot) continue;
          if (c.id === this.localPid) {
            sim.setInput(c.id, localInput);
            continue;
          }
          const p = this.session.player(c.id);
          const I = this.inputs[c.id];
          const inp = p && p.connected && I ? this._nextInput(I) : null;
          if (!inp) {
            sim.setInput(c.id, BRAKE);
            continue;
          }
          sim.setInput(c.id, I.rs ? { s: inp.s, t: inp.t, b: inp.b, hb: inp.hb, rs: 1 } : inp);
          I.rs = 0;
        }
        localInput.rs = 0;
        sim.step();
        if (sim.tick % SNAP_EVERY === 0) this.broadcast();
        this.acc -= P.DT;
        n++;
      }
      if (n >= 12) this.acc = 0; // host hitched badly: drop time rather than spiral
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
