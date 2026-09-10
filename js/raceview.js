// raceview.js — turns "what's happening in the race" into pixels + HUD.
// The view object has the same shape whether it came from the local
// authoritative sim (host / practice) or from network snapshots (client),
// so rendering code never cares which side of the wire it's on.
'use strict';
(function (G) {
  const U = G.U;

  const RaceView = {
    // Build a view from a local RaceSim. alpha = interpolation into next tick.
    fromSim(sim, meId, alpha) {
      const tr = sim.track;
      const order = sim.order();
      const raceTime = sim.raceStartT != null ? sim.t - sim.raceStartT : 0;
      const cars = sim.cars.map((c) => ({ id: c.id, name: c.name, color: c.color, rs: sim.renderState(c, alpha) }));
      const mc = sim.byId[meId];
      let me = null;
      if (mc) {
        const pos = order.indexOf(mc) + 1;
        let curMs = 0;
        if (tr.closed) curMs = mc.lapStartT != null && !mc.finished ? (sim.t - mc.lapStartT) * 1000 : mc.finished ? mc.finishMs : raceTime * 1000;
        else curMs = mc.finished ? mc.finishMs : mc.lapStartT === -1 ? mc.lastLap : raceTime * 1000;
        me = {
          id: mc.id, pos, lapCount: mc.lapCount, curMs, lastLap: mc.lastLap, bestLap: mc.bestLap,
          rs: cars.find((c) => c.id === meId).rs, hasBoost: mc.spec.boostKind !== 'none', wrong: mc.wrongT > 1.2, finished: mc.finished,
        };
      }
      return {
        phase: sim.phase, countdown: sim.countdown, raceTime, format: tr.format, laps: sim.practice ? '∞' : tr.laps,
        practice: sim.practice, total: sim.cars.length,
        leaderLap: order[0] ? Math.max(1, Math.min(order[0].lapCount, tr.laps)) : 1,
        me, order: order.map((c) => ({ id: c.id, name: c.name, color: c.color, finished: c.finished, dnf: c.dnf })), cars,
      };
    },

    // Push a view into the world + HUD. `focusId` = car the camera follows
    // (null => free camera for spectators).
    apply(v, world, hud, dt, opts) {
      opts = opts || {};
      for (const c of v.cars) world.updateCar(c.id, c.rs, dt);
      const focus = opts.focusId ? v.cars.find((c) => c.id === opts.focusId) : null;
      if (focus && !opts.freeCam) world.follow(focus.rs, dt);
      else world.freeCam(dt, opts.keys, focus ? focus.rs : null);
      if (v.practice && v.me) v.me.lapCount = Math.max(1, v.me.lapCount);
      hud.update(v, dt, world);
      // Sound: own engine/turbo/screech + countdown ticks (no-op when muted).
      if (G.Audio) {
        G.Audio.update(v.me && !v.me.finished ? v.me.rs : null, dt);
        G.Audio._fed = true;
        const cd = v.phase === 'grid' ? Math.ceil(v.countdown) : 0;
        if (v.phase === 'grid' && cd >= 1 && cd <= 3 && cd !== this._lastCd) G.Audio.countdown(cd);
        this._lastCd = cd;
      }
    },

    // React to sim events (banners, camera shake, sounds).
    events(evts, meId, hud, world, audio) {
      for (const e of evts) {
        if (e.type === 'go') {
          if (audio) audio.countdown(0);
        } else if (e.type === 'lap' && e.id === meId) {
          hud.banner(e.lap != null ? 'LAP ' + U.fmtTime(e.ms) : 'TIME ' + U.fmtTime(e.ms), '', 2.2);
        } else if (e.type === 'finish' && e.id === meId) {
          hud.banner('FINISHED ' + U.ordinal(e.pos), U.fmtTime(e.ms), 4);
          world.confetti(meId, e.pos <= 3 ? 90 : 30);
          if (audio) e.pos <= 3 ? audio.win() : audio.beep(660, 0.3);
        } else if (e.type === 'hit') {
          if (e.a === meId || e.b === meId) {
            world.shake(Math.min(1.6, e.j / 6000));
            if (audio) audio.thud(Math.min(1, e.j / 8000));
          }
          world.sparks(e.x, e.z, Math.min(14, 3 + e.j / 1500));
        } else if (e.type === 'respawn' && e.id === meId) {
          world.cam.snap = false;
        }
      }
    },
  };

  G.RaceView = RaceView;
})(window.G);
