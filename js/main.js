// main.js — application entry + state machine.
//   menu    : title screen over an attract-mode bot race (also hosts the
//             single-player casino screen)
//   garage  : sandbox shop / tuning / paint + live handling preview
//   drive   : free practice, quick race, test drive (local sim; can PAUSE)
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
  const botLook = (id) => {
    const h = U.hashStr(id), L = G.Parts.LOOK;
    // (>>> not >>: the hash is unsigned 32-bit; a signed shift goes negative)
    return G.Parts.cleanLook(null, { livery: L.liveries[h % L.liveries.length][0], rims: L.rims[(h >>> 3) % L.rims.length][0], accent: L.accents[(h >>> 6) % L.accents.length], rimCol: L.rimCols[(h >>> 9) % L.rimCols.length], num: 1 + (h % 99) });
  };

  const App = {
    mode: 'boot',
    paused: false,

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
      this.world.onPad = (mine) => G.Audio && G.Audio.zap && G.Audio.zap(mine ? 1 : 0.35); // speed-pad zap
      this.hud = new G.HUD(document.getElementById('hud'));
      this.hud.show(false);
      G.UI.init();
      G.Overlay.init();
      G.Touch.init();
      G.Client = new G.ClientSession();
      // The single-player sandbox is just a session hosted locally. It is
      // deliberately NOT saved: every visit starts fresh (stock car, $25,000).
      // Money earned in quick races carries between races within a visit only.
      // (Remembered across visits: settings, your name, personal-best laps.)
      this.host = new G.HostSession({ sandbox: true });
      this.host.addPlayer({ id: 'me', name: U.store.get('ss.name', 'Driver') || 'Driver', color: G.CarModel.PALETTE[0], carId: 'vandal' });
      U.store.del('ss.sandbox'); // clear what an earlier version saved
      G.Client.connectLocal(this.host, 'me');
      G.Client.on('state', () => {
        if (this.mode === 'session') G.Game.syncScreen();
        else G.UI.refresh();
      });
      window.addEventListener('keydown', (e) => this._key(e));
      const p = new URLSearchParams(location.search);
      if (p.get('track')) {
        const parts = {};
        (p.get('parts') || '').split(',').filter(Boolean).forEach((kv) => {
          const [k, v] = kv.split(':');
          parts[k] = v;
        });
        this.startDrive({ trackId: p.get('track'), carId: p.get('car') || 'vandal', parts, bots: +(p.get('bots') || 0), auto: p.get('auto') === '1', direct: true });
      } else if (p.get('garage')) this.openGarage();
      else if (p.get('join')) {
        // invite link: open the Join box with the code filled in
        this.showMenu();
        const code = p.get('join');
        history.replaceState(null, '', location.pathname);
        setTimeout(() => G.UI.screens.menu.openJoin(code), 400);
      } else this.showMenu();
      // Sound stays OFF by default (original brief) — but say so, once per visit.
      if (!G.Settings.s.sound) setTimeout(() => G.UI.toast('🔇 Sound is off — press M or the speaker button (top right) for engines, effects and music.', 'info'), 1800);
      this.last = performance.now();
      this.acc = 0;
      requestAnimationFrame((t) => this.frame(t));
      this.startBackgroundTicker();
    },

    _key(e) {
      if (e.code === 'F3') {
        this.hud.debugOn = !this.hud.debugOn;
        e.preventDefault();
      }
      const a = document.activeElement;
      const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
      if (e.code === 'KeyM' && !typing && G.Audio) G.Audio.toggle();
      if (e.key === 'Escape' || e.code === 'Escape') {
        if (document.querySelector('.modal-bg')) return; // the modal handles its own Esc
        if (typing) {
          a.blur();
          return;
        }
        G.Overlay.escape();
      }
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
        // Pings that queued up behind a slow tick: skip them. Otherwise, on a
        // slow device, the backlog grew without limit and every network
        // message waited behind it (a 17 s gap in testing).
        if (now - (this.lastBgEnd || 0) < 12) return;
        const dt = Math.min(0.1, (now - this.last) / 1000);
        this.last = now;
        this.bgTicks = (this.bgTicks || 0) + 1;
        this.tickAll(dt);
        G.Input.endFrame();
        this.lastBgEnd = performance.now();
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

    // What the player brings into a multiplayer session.
    myLook() {
      const me = this.host.player('me');
      return me ? Object.assign({}, me.garage.look) : null;
    },
    myCar() {
      const me = this.host.player('me');
      return me ? me.carId : 'vandal';
    },

    // Extra menu buttons for multiplayer (rendered by menu.js).
    menuButtons() {
      const lc = G.Game.lastClient();
      let h = `<button class="btn big pink span2" data-act="rooms">🌐 Server list <small>find a room from any classroom — or host your own</small></button>
               <button class="btn big pink" data-act="host">👥 Host <small>open a room · up to 8 drivers</small></button>
               <button class="btn big pink" data-act="join">🔗 Join <small>with a room code</small></button>`;
      if (lc) h += `<button class="btn ghost span2" data-act="rejoin">↻ Rejoin <b>${U.esc(lc.code)}</b> <small>as ${U.esc(lc.name)}</small></button>`;
      return h;
    },

    // ---------------------------------------------------------------- menu
    showMenu(arg) {
      this.mode = 'menu';
      this.sim = null;
      this.drive = null;
      this.paused = false;
      this.hud.show(false);
      this.hud.clearTags();
      if (!this.attract || this.world.track !== this.attract.track) this.startAttract();
      G.UI.show('menu', arg);
    },

    startAttract() {
      const ids = G.TrackDefs.ROTATION.filter((id) => G.getTrack(id).format !== 'drag');
      const track = G.getTrack(ids[Math.floor(Math.random() * ids.length)]);
      this.world.loadTrack(track);
      const ents = [];
      for (let k = 0; k < 6; k++) ents.push({ id: 'a' + k, name: G.BOT_NAMES[k], carId: G.Parts.CAR_ORDER[k % 4], color: G.CarModel.PALETTE[k], parts: ATTRACT_BUILDS[k], wear: {}, look: botLook('a' + k), bot: { skill: 0.86 + 0.025 * k } });
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
      this.world.follow(sim.renderState(sim.cars[this.attractFocus], a), dt, { pitch: 44, dist: 24 });
    },

    // -------------------------------------------------------------- garage
    openGarage(tab) {
      this.mode = 'garage';
      this.sim = null;
      this.attract = null;
      this.paused = false;
      this.hud.show(false);
      this.hud.clearTags();
      G.UI.show('garage', { doneLabel: '← Menu', back: true, tab, onDone: () => this.showMenu(), onTestDrive: (c) => this.startDrive({ trackId: 'proving', test: c }) });
    },

    // "Change car" / "Tune & paint" from the pause menu, in any context.
    openCarTab(tab) {
      if (!G.Game.role) return this.openGarage(tab);
      const st = G.Client.state;
      if (!st) return;
      if (st.phase === 'intermission') {
        G.Game.interTab = 'garage';
        G.UI.screens.garage.nextTab = tab;
        G.Game.lastScreen = null;
        G.Game.syncScreen();
      } else if (['lobby', 'carselect', 'results'].includes(st.phase)) {
        G.UI.show('garage', { doneLabel: 'Done', back: true, tab, onDone: () => { G.Game.lastScreen = null; G.Game.syncScreen(); } });
      }
    },

    openCasino() {
      if (this.mode !== 'menu') this.showMenu();
      G.UI.show('casino', { sandbox: true });
    },

    // ------------------------------------------------------------- session
    enterSession() {
      this.mode = 'session';
      this.attract = null;
      this.sim = null;
      this.drive = null;
      this.paused = false;
      this.hud.show(false);
      G.Game.lastScreen = null;
      G.Game.syncScreen();
    },

    exitSession() {
      G.Client.connectLocal(this.host, 'me');
      this.showMenu();
    },

    // --------------------------------------------------------------- drive
    // Quick race: a REAL race (laps, finish, results, play-money prize) —
    // not endless practice.
    async quickRace(trackId) {
      const ids = G.TrackDefs.ROTATION.filter((id) => G.getTrack(id).format !== 'drag');
      const pick = trackId || ids[Math.floor(Math.random() * ids.length)];
      this._qField = G.BotKit.field(8, G.Settings.s.botLevel); // a fresh, varied field every quick race
      await this._offerQuickBet(pick);
      this.startDrive({ trackId: pick, bots: 5, quick: true });
    },
    quickAgain(nextTrack) {
      const d = this.drive;
      if (!d) return this.quickRace();
      const cur = this.sim.track.id;
      this._applyDriveWear();
      if (!nextTrack) return this.quickRace(cur);
      const ids = G.TrackDefs.ROTATION.filter((id) => G.getTrack(id).format !== 'drag' && id !== cur);
      this.quickRace(ids[Math.floor(Math.random() * ids.length)]);
    },

    // Quick-race bots: same car / parts per grid slot every race, so the
    // bookie's odds (below) describe the field you actually get.
    // v4.4: bots come from G.BotKit (bot.js): varied names, cars, looks and
    // builds by driving style; Hard bots bring bigger builds and sometimes a
    // premium car. One field per quick race (made in quickRace), so the
    // bookie's odds describe the field you actually get.
    _botField() {
      if (!this._qField) this._qField = G.BotKit.field(8, G.Settings.s.botLevel);
      return this._qField;
    },
    _botCar(k) {
      const f = this._botField();
      return f[k % f.length].carId;
    },
    _botParts(k) {
      const f = this._botField();
      return f[k % f.length].parts;
    },

    // v4: back yourself before a quick race, at the bookie's odds for this
    // field on this track (garage money; paid on top of the prize).
    async _offerQuickBet(trackId) {
      this._qbet = null;
      const me = this.host && this.host.player('me');
      if (!me || G.Game.role) return;
      const E = G.Econ, track = G.getTrack(trackId);
      const lvl = G.Settings.s.botLevel;
      const skill = lvl === 'easy' ? 0.83 : lvl === 'hard' ? 0.975 : 0.91;
      const field = [{ id: 'me', carId: me.carId, garage: me.garage, stats: { form: [] }, isBot: false }];
      for (let k = 0; k < 5; k++) field.push({ id: 'b' + k, carId: this._botCar(k), garage: { installed: this._botParts(k), wear: {}, tune: {} }, stats: { form: [] }, isBot: true, botSkill: skill });
      const o = E.computeOdds(field, track, U.hashStr(trackId + lvl + me.carId)).me;
      const can = (s) => me.money - s >= E.FLOOR;
      const btns = [{ label: 'Just race', value: 0, cls: 'ghost' }];
      if (can(250)) btns.push({ label: `$250 on a podium · ${o.podium.toFixed(2)}x`, value: 1 });
      if (can(500)) btns.push({ label: `$500 to win · ${o.win.toFixed(2)}x`, value: 2, cls: 'primary' });
      const r = await G.UI.modal(
        'Back yourself?',
        `<p><b>${U.esc(track.name)}</b> <em class="fmt fmt-${track.format}">${track.format.toUpperCase()}</em>${track.def.isNew ? ' <em class="t-new">NEW</em>' : ''}</p><p class="muted small">${U.esc(track.blurb)}</p><p>The bookie rates your ${U.esc(G.Parts.CARS[me.carId].name)} against this field at <b>${o.win.toFixed(2)}x</b> to win and <b>${o.podium.toFixed(2)}x</b> for a podium. A winning bet is paid on top of your prize.</p>`,
        btns
      );
      const v = r && r.value;
      if (v === 1 || v === 2) {
        const stake = v === 1 ? 250 : 500, type = v === 1 ? 'podium' : 'win';
        me.money -= stake;
        this.host.touch();
        this._qbet = { stake, type, odds: type === 'win' ? o.win : o.podium };
      }
    },
    _applyDriveWear() {
      const d = this.drive, me = this.sim && this.sim.byId.me;
      if (!d || !me || d.test || d.direct || G.Game.role || d.wearApplied) return;
      d.wearApplied = true;
      this.host.applyWear('me', { tyre: me.st.tyreWear, engine: me.st.engineWear, body: me.st.body });
    },
    _quickResults() {
      const sim = this.sim, d = this.drive;
      const res = sim.results();
      const meRow = res.find((r) => r.id === 'me');
      const PRIZES = [1500, 1100, 850, 650, 500, 400, 300, 250];
      const prize = meRow.finished ? PRIZES[meRow.pos - 1] || 200 : 0;
      const fuel = Math.round(sim.byId.me.st.fuel);
      const me = this.host.player('me');
      // settle a "back yourself" bet
      let bet = null;
      if (this._qbet) {
        const b = this._qbet;
        const won = meRow.finished && (b.type === 'win' ? meRow.pos === 1 : meRow.pos <= 3);
        bet = Object.assign({}, b, { won, payout: won ? Math.round(b.stake * b.odds) : 0 });
        this._qbet = null;
      }
      if (me && !G.Game.role) {
        me.money = Math.max(0, me.money + prize - fuel + (bet ? bet.payout : 0));
        this.host.touch();
      }
      d.results = {
        track: sim.track, pos: meRow.pos, finished: meRow.finished, total: res.length, prize, fuel, bet, best: meRow.bestLap, pb: this.getPB(sim.track.id, sim.byId.me.carId),
        rows: res.map((r) => ({ id: r.id, pos: r.pos, name: sim.byId[r.id].name, carId: sim.byId[r.id].carId, color: sim.byId[r.id].color, ms: r.ms, finished: r.finished, best: r.bestLap })),
      };
      G.UI.show('qresults', d.results);
    },

    // opts: {trackId, bots, test: candidateGarage, carId, parts, auto, direct}
    startDrive(opts) {
      const me = G.Client.me;
      const test = opts.test || null;
      const carId = test ? test.carId : opts.carId || me.carId;
      const parts = test ? test.installed : opts.parts || me.garage.installed;
      const wear = test ? test.wear : opts.direct ? {} : me.garage.wear;
      const tune = test ? test.tune : opts.direct ? {} : me.garage.tune;
      const look = me.garage.look;
      const track = G.getTrack(opts.trackId);
      G.UI.show('drivebar'); // show first: unmounting the garage stops its preview
      this.world.loadTrack(track);
      const ents = [{ id: 'me', name: me.name, carId, color: me.color, parts, wear, tune, look, bot: opts.auto ? { skill: 0.95 } : null }];
      // bot difficulty (Settings / practice screen): skill = how close to the
      // grip limit they dare to corner. Hard bots also bring better parts.
      const lvl = G.Settings.s.botLevel;
      const [lo, hi] = lvl === 'easy' ? [0.8, 0.86] : lvl === 'hard' ? [0.95, 1.0] : [0.87, 0.95];
      for (let k = 0; k < (opts.bots || 0); k++) {
        const f = this._botField()[k % 8];
        ents.push({ id: 'bot' + k, name: f.name, carId: f.carId, color: G.CarModel.PALETTE[(k + 1) % 8], parts: f.parts, wear: {}, look: f.look, bot: { skill: lo + (hi - lo) * Math.random() } });
      }
      const quick = !!opts.quick;
      if (quick && ents.length > 3) ents.splice(3, 0, ents.shift()); // you start mid-pack
      // catch-up only in real (quick) races, at the player's chosen strength
      const catchup = quick ? G.Settings.CATCHUP[G.Settings.s.catchup] || 0 : 0;
      this.sim = new G.RaceSim(track, ents, { countdown: quick ? 3.5 : 2.5, practice: !quick, catchup });
      this.attract = null;
      this.world.setCars(ents);
      this.world.cam.snap = true;
      this.hud.setTrack(track);
      this.hud.show(true);
      this.drive = { test: !!test, direct: !!opts.direct, quick, t: 0, limit: test ? 60 : 0, restartAt: null, doneT: 0, results: null, opts };
      this.acc = 0;
      this.paused = false;
      this.mode = 'drive';
    },

    restartDrive() {
      if (this.drive) this.startDrive(this.drive.opts);
    },

    driveInfo() {
      if (!this.drive) return '';
      if (this.drive.test) return `<b>TEST DRIVE</b> candidate build · no wear · ${Math.max(0, Math.ceil(this.drive.limit - this.drive.t))} s left`;
      const pb = this.drive.direct ? null : this.getPB(this.sim.track.id, this.sim.byId.me.carId);
      const lvl = { easy: 'Easy', normal: 'Normal', hard: 'Hard' }[G.Settings.s.botLevel] || 'Normal';
      return `<b>${this.drive.quick ? 'QUICK RACE' : 'FREE PRACTICE'}</b> ${U.esc(this.sim.track.name)} · ${this.paused ? 'PAUSED' : this.drive.quick ? lvl + ' bots · 1st pays $1,500' : 'wear counts'}${pb ? ` · <b>PB ${U.fmtTime(pb)}</b>` : ''}`;
    },

    // Personal-best laps per track + car (single-player practice / quick race).
    getPB(trackId, carId) {
      return U.store.get('ss.pb', {})[trackId + '|' + carId] || null;
    },
    _checkPB(trackId, carId, ms) {
      const all = U.store.get('ss.pb', {});
      const k = trackId + '|' + carId;
      const old = all[k];
      if (old != null && ms >= old) return;
      all[k] = Math.round(ms);
      U.store.set('ss.pb', all);
      if (old != null) {
        this.hud.banner('NEW PERSONAL BEST', U.fmtTime(ms) + '  (−' + ((old - ms) / 1000).toFixed(3) + ' s)', 3, 'best');
        if (G.Audio) G.Audio.win();
      }
    },

    // silent = the caller is about to switch screens itself
    endDrive(silent) {
      if (this.mode !== 'drive') return;
      const d = this.drive;
      this._applyDriveWear();
      this.sim = null;
      this.drive = null;
      this.paused = false;
      this.hud.show(false);
      this.hud.clearTags();
      if (G.Game.role) {
        this.mode = 'session';
        G.Game.lastScreen = null;
        G.Game.viewNo = null;
        G.Game.syncScreen();
        return;
      }
      if (silent) return;
      if (d.test) this.openGarage();
      else this.showMenu({ tab: d.opts.quick ? 'home' : 'practice' });
    },

    frameDrive(dt) {
      const sim = this.sim;
      if (this.paused) {
        // single-player pause: the sim is frozen, the scene keeps drawing
        const view = G.RaceView.fromSim(sim, 'me', this.acc / P.DT);
        G.RaceView.apply(view, this.world, this.hud, 0.0001, { focusId: 'me', silent: true });
        return;
      }
      const inp = G.Input.read();
      if (G.Input.hitAction('reset')) inp.rs = 1;
      if (G.Input.hitAction('cam')) G.UI.toast('Camera: ' + this.world.cycleCam(), 'info');
      sim.setInput('me', inp);
      this.acc += dt;
      let n = 0;
      while (this.acc >= P.DT && n < 12) {
        sim.step();
        this.acc -= P.DT;
        n++;
      }
      if (n >= 12) this.acc = 0;
      const evs = sim.popEvents();
      G.RaceView.events(evs, 'me', this.hud, this.world, G.Audio);
      const d = this.drive;
      if (!d.test && !d.direct) {
        for (const e of evs) {
          if (e.id !== 'me') continue;
          if (e.type === 'lap' || (e.type === 'finish' && !sim.track.closed)) this._checkPB(sim.track.id, sim.byId.me.carId, e.ms); // sprints: the run time
        }
      }
      if (sim.phase === 'race') d.t += dt;
      if (d.limit && d.t >= d.limit) return this.endDrive();
      // quick race over: results screen a moment after the flag
      if (d.quick && sim.phase === 'done' && !d.results) {
        d.doneT += dt;
        if (d.doneT > 2.5) this._quickResults();
      }
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

    musicFor() {
      const race = G.Settings.s.raceMusic ? 'menu' : null;
      if (this.mode === 'menu') return 'menu';
      if (this.mode === 'garage') return 'garage';
      if (this.mode === 'drive') return race;
      if (this.mode === 'session') {
        const st = G.Client.state;
        if (!st) return 'menu';
        if (st.phase === 'race') return race;
        if (st.phase === 'final') return 'final';
        if (['intermission', 'results', 'entry', 'betting'].includes(st.phase)) return 'garage';
        return 'menu';
      }
      return null;
    },

    // ---------------------------------------------------------------- loop
    frame(now) {
      requestAnimationFrame((t) => this.frame(t));
      now = performance.now(); // same clock as the worker ticker
      this.lastRaf = now;
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      if (G.Audio) G.Audio._fed = false;
      if (G.Input.pollStart()) G.Overlay.escape(); // gamepad Start = Esc, on every screen
      this.tickAll(dt);
      if (G.Audio && !G.Audio._fed) {
        G.Audio.update(null, dt); // no race view this frame: engine silent
        G.Audio.silenceOthers();
      }
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
        // The round is starting (entry -> betting -> race): end the test
        // drive now, so the player gets to choose race / sit out and bet.
        // (It used to wait for the race itself, and they missed all of that.)
        if (st && ['entry', 'betting', 'race', 'final'].includes(st.phase)) {
          if (G.Overlay && G.Overlay.isOpen) G.Overlay.hide(); // a pause menu left open would block the controls
          this.endDrive();
          G.UI.toast('Test drive over — the next round is starting!', 'info');
        }
        else this.frameDrive(dt);
      } else if (this.mode === 'session') G.Game.render(dt);
      else if (this.mode === 'garage') G.Preview.update(dt);
      else if (this.mode === 'menu') this.frameAttract(dt);
      if (!G.Game.role) {
        this.host.update(Date.now()); // sandbox casino timers
        this.host.flush();
      }
      G.UI.update(dt);
      G.Touch.update(this.mode === 'drive' || (this.mode === 'session' && G.Game.racing()));
      if (G.Audio && G.Audio.enabled) G.Audio.music(this.musicFor());
    },
  };

  G.App = App;
  window.addEventListener('load', () => App.init());
})(window.G);
