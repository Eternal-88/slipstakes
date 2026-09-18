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
          rs: cars.find((c) => c.id === meId).rs, hasBoost: mc.spec.boostKind !== 'none', hasNos: !!mc.spec.nosGain, coldBrakes: (mc.spec.bCold || 1) < 0.9, wrong: mc.wrongT > 1.2, finished: mc.finished,
          // v5.1 cluster: the rev scale, and the boost dial's own numbers
          ev: !!mc.spec.ev, boostGain: mc.spec.boostGain, redline: mc.spec.redline,
          boostAvail: G.Parts.boostAvail(mc.spec, mc.st.rpm),
        };
      }
      return {
        phase: sim.phase, countdown: sim.countdown, hold: sim.hold ? sim.holdN || 1 : 0, raceTime, wet: sim.env ? sim.env.wet : 0, format: tr.format, laps: sim.practice ? '∞' : sim.laps, endu: sim.endu,
        practice: sim.practice, total: sim.cars.length,
        leaderLap: order[0] ? Math.max(1, Math.min(order[0].lapCount, sim.laps)) : 1,
        me, order: order.map((c) => ({ id: c.id, name: c.name, color: c.color, finished: c.finished, dnf: c.dnf, stops: c.stops, pit: c.st.pit })), cars,
      };
    },

    // Push a view into the world + HUD. `focusId` = car the camera follows
    // (null => free camera for spectators).
    apply(v, world, hud, dt, opts) {
      opts = opts || {};
      // v5 environment: race time (moving hazards), rain, and how far the
      // leader is round (tracks where night falls during the race)
      if (world.track) {
        let lead = 0;
        for (const c of v.cars) if (c.dist > lead) lead = c.dist;
        const len = world.track.closed && typeof v.laps === 'number' ? world.track.length * v.laps : world.track.raceDistance;
        world.setEnv(v.raceTime || 0, v.wet || 0, lead / (len || 1));
        if (v.wet > 0.03 && !world.rainWarned && v.phase === 'race') {
          world.rainWarned = true;
          hud.banner('RAIN', v.wet > 0.9 ? 'Wet race: brake early, narrow tyres grip best' : 'Rain is starting: the road is getting slippery', 2.6, 'warn');
        }
      }
      for (const c of v.cars) world.updateCar(c.id, c.rs, dt);
      const focus = opts.focusId ? v.cars.find((c) => c.id === opts.focusId) : null;
      world.focusId = focus ? focus.id : null; // (slipstream streaks / pad shake on the camera car only)
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
      let hits = 0; // other cars' contacts drawn this frame (a pile-up: the first few are plenty)
      for (const e of evts) {
        if (e.type === 'horn') {
          // v5: someone else's horn, from where their car is
          if (e.id === meId || !audio || !lv) continue;
          const car = lv.cars.find((c) => c.id === e.id);
          if (!car) continue;
          const d = Math.hypot(car.rs.x - world.cam.fx, car.rs.z - world.cam.fz);
          audio.horn(car.carId, U.clamp(1.2 - d / 70, 0, 1));
          continue;
        }
        if (e.type === 'pitIn' && e.id === meId) {
          // v5 endurance: our car is held in the box — play the crew
          const info = (hud.enduT && hud.enduT.info) || {};
          if (G.PitGame) G.PitGame.start({ tank: e.tank, tw: e.tw, ck: e.ck || 1, qr: e.qr || 1, need: info.need != null ? info.need : 1, lapsLeft: info.lapsLeft || 1 });
        } else if (e.type === 'pitOut' && e.id === meId) {
          if (hud.enduT && !e.cancel) hud.enduT.fuelIn += e.fuel || 0;
          if (G.PitGame) G.PitGame.released(e);
          if (!e.cancel && audio) audio.go();
        } else if (e.type === 'go') {
          if (audio) audio.go();
          if (audio && audio.musicIntensity) audio.musicIntensity(0);
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
          const finalLap = tr && tr.closed && lv && !lv.practice && e.lap === lv.laps - 1;
          hud.banner(finalLap ? 'FINAL LAP' : txt, finalLap ? txt + (sub ? ' · ' + sub : '') : sub, 2.4, finalLap ? 'final' : cls);
          if (audio) finalLap ? audio.lastLap() : audio.lap();
          if (audio && audio.musicIntensity) audio.musicIntensity(finalLap ? 1 : 0.25 * (e.lap || 0));
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
          if (!mine && ++hits > 4) continue;
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
        } else if (e.type === 'rival' && e.target === meId) {
          // v5: a rival bot has picked you
          const who = lv && lv.order.find((o) => o.id === e.id);
          hud.banner('⚠ RIVAL', `${who ? who.name.replace(' ⚙', '') : 'A bot'} is coming for you`, 1.8, 'warn');
          if (audio && audio.notify) audio.notify('warn');
        } else if (e.type === 'respawn' && e.id === meId) {
          world.cam.snap = false;
          if (audio) audio.respawn();
        }
      }
    },
  };

  // v5 horn: play our own at once, then tell the race (host relays it)
  RaceView.honk = function (carId) {
    const now = performance.now();
    if (now - (this._honkT || 0) < 700) return;
    this._honkT = now;
    if (G.Audio) G.Audio.horn(carId, 1);
    if (G.App.mode === 'drive' && G.App.sim) return; // single player: nobody to hear it
    if (G.Client) G.Client.act({ t: 'horn' });
  };

  G.RaceView = RaceView;
})(window.G);
