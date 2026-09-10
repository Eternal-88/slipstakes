// raceview.js — turns "what's happening in the race" into pixels, HUD and
// sound. The view object has the same shape whether it came from the local
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
      const cars = sim.cars.map((c) => ({ id: c.id, name: c.name, color: c.color, carId: c.carId, parts: c.parts, rs: sim.renderState(c, alpha), dist: c.raceDist }));
      const mc = sim.byId[meId];
      let me = null;
      if (mc) {
        const pos = order.indexOf(mc) + 1;
        let curMs = 0;
        if (tr.closed) curMs = mc.lapStartT != null && !mc.finished ? (sim.t - mc.lapStartT) * 1000 : mc.finished ? mc.finishMs : raceTime * 1000;
        else curMs = mc.finished ? mc.finishMs : mc.lapStartT === -1 ? mc.lastLap : raceTime * 1000;
        me = {
          id: mc.id, pos, lapCount: mc.lapCount, curMs, lastLap: mc.lastLap, bestLap: mc.bestLap, carId: mc.carId, parts: mc.parts,
          rs: cars.find((c) => c.id === meId).rs, hasBoost: mc.spec.boostKind !== 'none', coldBrakes: (mc.spec.bCold || 1) < 0.9, wrong: mc.wrongT > 1.2, finished: mc.finished,
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
      // Sound: own engine + surfaces + nearby cars + countdown ticks.
      if (G.Audio && opts.silent) {
        G.Audio.update(null, 0); // paused
        G.Audio.silenceOthers();
        G.Audio._fed = true;
      } else if (G.Audio) {
        G.Audio.race(v, world, dt);
        const cd = v.phase === 'grid' ? Math.ceil(v.countdown) : 0;
        if (v.phase === 'grid' && cd >= 1 && cd <= 3 && cd !== this._lastCd) G.Audio.countdown(cd);
        this._lastCd = cd;
      }
    },

    // React to sim events (banners, camera shake, particles, sounds).
    events(evts, meId, hud, world, audio) {
      const lv = hud.lastView;
      for (const e of evts) {
        if (e.type === 'go') {
          if (audio) audio.go();
          const cheer = world.trackGroup && world.trackGroup.userData.cheer;
          if (cheer) cheer(0.6);
        } else if (e.type === 'lap' && e.id === meId) {
          // lap delta vs. the best lap we knew about before this one
          const prev = hud.bestSeen;
          const txt = e.lap != null ? 'LAP ' + U.fmtTime(e.ms) : 'TIME ' + U.fmtTime(e.ms);
          let sub = '', cls = '';
          if (prev != null && e.ms < prev - 1) {
            sub = 'NEW BEST  −' + ((prev - e.ms) / 1000).toFixed(3);
            cls = 'best';
          } else if (prev != null) sub = '+' + ((e.ms - prev) / 1000).toFixed(3);
          const tr = hud.track;
          const finalLap = tr && tr.closed && lv && !lv.practice && e.lap === tr.laps - 1;
          hud.banner(finalLap ? 'FINAL LAP' : txt, finalLap ? txt + (sub ? ' · ' + sub : '') : sub, 2.4, finalLap ? 'final' : cls);
          if (audio) finalLap ? audio.lastLap() : audio.lap();
        } else if (e.type === 'finish' && e.id === meId) {
          hud.banner('FINISHED ' + U.ordinal(e.pos), U.fmtTime(e.ms), 4, e.pos === 1 ? 'best' : '');
          world.confetti(meId, e.pos <= 3 ? 110 : 30);
          const m = world.models.get(meId);
          if (e.pos <= 3 && m) world.fireworks(m.root.position.x, m.root.position.z, e.pos === 1 ? 5 : 3);
          if (audio) audio.finish(e.pos);
          const cheer = world.trackGroup && world.trackGroup.userData.cheer;
          if (cheer) cheer(1);
        } else if (e.type === 'finish') {
          const cheer = world.trackGroup && world.trackGroup.userData.cheer;
          if (cheer && e.pos === 1) cheer(0.8);
        } else if (e.type === 'hit') {
          const mine = e.a === meId || e.b === meId;
          if (mine) {
            world.shake(Math.min(1.6, e.j / 6000));
            if (audio) audio.thud(Math.min(1, e.j / 8000));
            if (e.j > 5000) hud.flash('hit');
          } else if (audio && audio.near) {
            // other cars banging wheels: audible, quieter with distance
            const k = Math.min(1, e.j / 8000) * audio.near(e.x, e.z) * 0.8;
            if (k > 0.08) audio.thud(k);
          }
          world.sparks(e.x, e.z, Math.min(14, 3 + e.j / 1500));
          if (e.j > 4000) world.debris(e.x, e.z, [world.colorOf(e.a), world.colorOf(e.b)], Math.min(16, Math.round(e.j / 900)));
        } else if (e.type === 'respawn' && e.id === meId) {
          world.cam.snap = false;
          if (audio) audio.respawn();
        }
      }
    },
  };

  G.RaceView = RaceView;
})(window.G);
