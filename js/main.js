// main.js — application entry + state machine.
//   menu    : title screen over an attract-mode bot race
//   garage  : sandbox shop + live handling preview (single player)
//   drive   : free practice / test drive (local sim)
//   session : a hosted or joined multiplayer session (see game.js)
// Debug URL params: ?track=harbour&car=vandal&bots=3&auto=1&parts=aero:a3,induction:t2   ?garage=1
'use strict';
(function (G) {
  const U = G.U, P = G.Physics;

  const ATTRACT_BUILDS = [{}, { aero: 'a2', induction: 't1' }, { aero: 'a3', width: 'wide', suspension: 'race' }, { induction: 'sc', suspension: 'rally', width: 'narrow' }, { induction: 't2', weight: 'w2' }, {}];
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago';
  };

  const App = {
    mode: 'boot',

    init() {
      // Three.js / PeerJS come from a CDN. If Three is missing we can't draw at
      // all — say so plainly instead of showing a blank page.
      if (typeof THREE === 'undefined') {
        const ui = document.getElementById('ui');
        ui.style.display = '';
        ui.innerHTML = `<div class="fatal"><h1>SLIPSTAKES</h1><p>Couldn't load the 3D engine (Three.js) from <b>cdn.jsdelivr.net</b>.</p><p class="muted">Check the internet connection or ask whoever runs the network to allow jsDelivr, then reload.</p></div>`;
        return;
      }
      this.world = new G.World(document.getElementById('c'));
      this.hud = new G.HUD(document.getElementById('hud'));
      this.hud.show(false);
      G.UI.init();
      G.Client = new G.ClientSession();
      // The single-player sandbox is just a session hosted locally.
      this.host = new G.HostSession({ sandbox: true });
      this.host.addPlayer({ id: 'me', name: U.store.get('ss.name', 'Driver') || 'Driver', color: G.CarModel.PALETTE[0], carId: 'vandal' });
      G.Client.connectLocal(this.host, 'me');
      G.Client.on('state', () => {
        if (this.mode === 'session') G.Game.syncScreen();
        else G.UI.refresh();
      });
      window.addEventListener('keydown', (e) => {
        if (e.code === 'F3') this.hud.debugOn = !this.hud.debugOn;
        const a = document.activeElement;
        const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
        if (e.code === 'KeyM' && !typing && G.Audio) G.Audio.toggle();
      });
      const p = new URLSearchParams(location.search);
      if (p.get('track')) {
        const parts = {};
        (p.get('parts') || '').split(',').filter(Boolean).forEach((kv) => {
          const [k, v] = kv.split(':');
          parts[k] = v;
        });
        this.startDrive({ trackId: p.get('track'), carId: p.get('car') || 'vandal', parts, bots: +(p.get('bots') || 0), auto: p.get('auto') === '1', direct: true });
      } else if (p.get('garage')) this.openGarage();
      else this.showMenu();
      this.last = performance.now();
      this.acc = 0;
      requestAnimationFrame((t) => this.frame(t));
      this.startBackgroundTicker();
    },

    // Browsers stop requestAnimationFrame for hidden tabs AND for occluded /
    // minimised windows (where visibilityState can still say "visible"). If the
    // HOST's rAF stops, the authoritative sim freezes for everyone. So a
    // dedicated Worker (whose timers aren't throttled like rAF) pings us every
    // 16 ms, and whenever rAF hasn't run for 200 ms we drive the simulation
    // ourselves — no rendering, just physics, netcode and session logic.
    startBackgroundTicker() {
      this.lastRaf = performance.now();
      const tick = () => {
        const now = performance.now();
        if (now - this.lastRaf < 200) return; // rAF is alive: it does the work
        const dt = Math.min(0.1, (now - this.last) / 1000);
        this.last = now;
        this.bgTicks = (this.bgTicks || 0) + 1;
        this.tickAll(dt);
        G.Input.endFrame();
      };
      try {
        const src = 'setInterval(()=>postMessage(0),16)';
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.onmessage = tick;
        this.bgWorker = w;
      } catch (e) {
        console.warn('[app] worker ticker unavailable, using setInterval (throttled when hidden)', e);
        setInterval(tick, 16);
      }
    },

    name() {
      return (U.store.get('ss.name', '') || 'Driver').slice(0, 16);
    },

    setName(v) {
      const me = this.host.player('me');
      if (me) {
        me.name = v || 'Driver';
        this.host.touch();
      }
    },

    // Extra menu buttons for multiplayer (rendered by menu.js).
    menuButtons() {
      const sv = G.Game.savedSession();
      const lc = G.Game.lastClient();
      let h = `<button class="btn big primary" data-act="host">Host a session <small>you + up to 7 friends, bots fill gaps</small></button>
               <button class="btn big pink" data-act="join">Join with a code</button>`;
      if (sv) h += `<button class="btn ghost" data-act="resume">Resume hosted session <b>${U.esc(sv.code)}</b> <small>autosaved ${ago(sv.savedAt)} · race ${sv.state.raceNo}/${sv.state.settings.races}</small></button>`;
      if (lc) h += `<button class="btn ghost" data-act="rejoin">Rejoin <b>${U.esc(lc.code)}</b> <small>as ${U.esc(lc.name)}</small></button>`;
      return h;
    },

    // ---------------------------------------------------------------- menu
    showMenu(arg) {
      this.mode = 'menu';
      this.sim = null;
      this.hud.show(false);
      this.hud.clearTags();
      this.startAttract();
      G.UI.show('menu', arg);
    },

    startAttract() {
      const ids = G.TrackDefs.ROTATION.filter((id) => G.getTrack(id).format !== 'drag');
      const track = G.getTrack(ids[Math.floor(Math.random() * ids.length)]);
      this.world.loadTrack(track);
      const ents = [];
      for (let k = 0; k < 6; k++) ents.push({ id: 'a' + k, name: G.BOT_NAMES[k], carId: G.Parts.CAR_ORDER[k % 4], color: G.CarModel.PALETTE[k], parts: ATTRACT_BUILDS[k], wear: {}, bot: { skill: 0.86 + 0.025 * k } });
      this.attract = new G.RaceSim(track, ents, { countdown: 0.3, practice: true });
      this.world.setCars(ents);
      this.attractFocus = 0;
      this.attractT = 0;
      this.acc = 0;
      this.world.cam.snap = true;
    },

    frameAttract(dt) {
      const sim = this.attract;
      if (!sim) return;
      this.acc += dt;
      let n = 0;
      while (this.acc >= P.DT && n < 12) {
        sim.step();
        this.acc -= P.DT;
        n++;
      }
      if (n >= 12) this.acc = 0;
      sim.popEvents();
      this.attractT += dt;
      if (this.attractT > 9) {
        this.attractT = 0;
        this.attractFocus = (this.attractFocus + 1) % sim.cars.length;
        this.world.cam.snap = true;
      }
      const a = this.acc / P.DT;
      for (const c of sim.cars) this.world.updateCar(c.id, sim.renderState(c, a), dt);
      this.world.follow(sim.renderState(sim.cars[this.attractFocus], a), dt, { pitch: 46, dist: 26 });
    },

    // -------------------------------------------------------------- garage
    openGarage() {
      this.mode = 'garage';
      this.sim = null;
      this.attract = null;
      this.hud.show(false);
      this.hud.clearTags();
      G.UI.show('garage', { doneLabel: 'Drive it', onDone: () => this.showMenu({ tab: 'practice' }), onTestDrive: (c) => this.startDrive({ trackId: 'proving', test: c }) });
    },

    // ------------------------------------------------------------- session
    enterSession() {
      this.mode = 'session';
      this.attract = null;
      this.sim = null;
      this.drive = null;
      this.hud.show(false);
      G.Game.lastScreen = null;
      G.Game.syncScreen();
    },

    exitSession() {
      G.Client.connectLocal(this.host, 'me');
      this.showMenu();
    },

    // --------------------------------------------------------------- drive
    // opts: {trackId, bots, test: candidateGarage, carId, parts, auto, direct}
    startDrive(opts) {
      const me = G.Client.me;
      const test = opts.test || null;
      const carId = test ? test.carId : opts.carId || me.carId;
      const parts = test ? test.installed : opts.parts || me.garage.installed;
      const wear = test ? test.wear : opts.direct ? {} : me.garage.wear;
      const track = G.getTrack(opts.trackId);
      G.UI.show('drivebar'); // show first: unmounting the garage stops its preview
      this.world.loadTrack(track);
      const ents = [{ id: 'me', name: me.name, carId, color: me.color, parts, wear, bot: opts.auto ? { skill: 0.95 } : null }];
      for (let k = 0; k < (opts.bots || 0); k++) {
        ents.push({ id: 'bot' + k, name: G.BOT_NAMES[k], carId: G.Parts.CAR_ORDER[(k + 1) % 4], color: G.CarModel.PALETTE[(k + 1) % 8], parts: {}, wear: {}, bot: { skill: 0.86 + 0.1 * Math.random() } });
      }
      this.sim = new G.RaceSim(track, ents, { countdown: 2.5, practice: true });
      this.attract = null;
      this.world.setCars(ents);
      this.world.cam.snap = true;
      this.hud.setTrack(track);
      this.hud.show(true);
      this.drive = { test: !!test, direct: !!opts.direct, t: 0, limit: test ? 60 : 0, restartAt: null, opts };
      this.acc = 0;
      this.mode = 'drive';
    },

    driveInfo() {
      if (!this.drive) return '';
      if (this.drive.test) return `<b>TEST DRIVE</b> candidate build · no wear · ${Math.max(0, Math.ceil(this.drive.limit - this.drive.t))} s left`;
      return `<b>FREE PRACTICE</b> ${U.esc(this.sim.track.name)} · your car · wear counts`;
    },

    endDrive() {
      if (this.mode !== 'drive') return;
      const d = this.drive;
      const me = this.sim.byId.me;
      if (!d.test && !d.direct && !G.Game.role) this.host.applyWear('me', { tyre: me.st.tyreWear, engine: me.st.engineWear, body: me.st.body });
      this.sim = null;
      this.drive = null;
      this.hud.show(false);
      this.hud.clearTags();
      if (G.Game.role) {
        this.mode = 'session';
        G.Game.lastScreen = null;
        G.Game.viewNo = null;
        G.Game.syncScreen();
        return;
      }
      if (d.test) this.openGarage();
      else this.showMenu({ tab: 'practice' });
    },

    frameDrive(dt) {
      const sim = this.sim;
      const inp = G.Input.read();
      if (G.Input.hit('KeyR')) inp.rs = 1;
      if (G.Input.hit('KeyC')) {
        this.world.cam.mode = this.world.cam.mode === 'follow' ? 'fixed' : 'follow';
        U.store.set('ss.cam', this.world.cam.mode);
      }
      if (G.Input.hit('Escape')) return this.endDrive();
      sim.setInput('me', inp);
      this.acc += dt;
      let n = 0;
      while (this.acc >= P.DT && n < 12) {
        sim.step();
        this.acc -= P.DT;
        n++;
      }
      if (n >= 12) this.acc = 0;
      G.RaceView.events(sim.popEvents(), 'me', this.hud, this.world, G.Audio);
      const d = this.drive;
      if (sim.phase === 'race') d.t += dt;
      if (d.limit && d.t >= d.limit) return this.endDrive();
      // open tracks: back to the start line after the finish
      if (!sim.track.closed) {
        const me = sim.byId.me;
        if (me.lapStartT === -1 && d.restartAt == null) d.restartAt = d.t + 2.5;
        if (d.restartAt != null && d.t > d.restartAt) {
          const carry = { tyre: me.st.tyreWear, engine: me.st.engineWear, body: me.st.body };
          if (!d.test && !d.direct && !G.Game.role) this.host.applyWear('me', carry);
          return this.startDrive(d.opts);
        }
      }
      const view = G.RaceView.fromSim(sim, 'me', this.acc / P.DT);
      G.RaceView.apply(view, this.world, this.hud, dt, { focusId: 'me' });
    },

    // ---------------------------------------------------------------- loop
    frame(now) {
      requestAnimationFrame((t) => this.frame(t));
      now = performance.now(); // same clock as the worker ticker
      this.lastRaf = now;
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      if (G.Audio) G.Audio._fed = false;
      this.tickAll(dt);
      if (G.Audio && !G.Audio._fed) G.Audio.update(null, dt); // no race view this frame: engine silent
      this.world.render(dt);
      G.Input.endFrame();
    },

    // Everything except the GPU draw — also driven by the background ticker
    // when the tab is hidden (see audio/background handling).
    tickAll(dt) {
      // Session bookkeeping first, every frame, whatever is on screen: the
      // host must keep simulating while its player browses the shop.
      if (G.Game.role) G.Game.tick(dt);
      if (this.mode === 'drive') {
        const st = G.Game.role && G.Client.state;
        if (st && st.phase === 'race') this.endDrive(); // a race started mid test-drive
        else this.frameDrive(dt);
      } else if (this.mode === 'session') G.Game.render(dt);
      else if (this.mode === 'garage') G.Preview.update(dt);
      else if (this.mode === 'menu') this.frameAttract(dt);
      if (!G.Game.role) this.host.flush();
      G.UI.update(dt);
    },
  };

  G.App = App;
  window.addEventListener('load', () => App.init());
})(window.G);
