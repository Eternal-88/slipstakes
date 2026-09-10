// game.js — multiplayer session controller (both roles).
//   host  : owns HostSession + NetHost + HostRace; broadcasts state; autosaves.
//   client: owns NetClient + ClientRace; applies state; reconnects on drops.
// The App's frame loop calls tick() for bookkeeping every frame (even while
// test-driving) and render() when the session view is on screen.
'use strict';
(function (G) {
  const U = G.U, P = G.Physics;
  const HOST_PID = 'h';
  const SAVE_KEY = 'ss.save';
  const CLIENT_KEY = 'ss.client';
  const SAVE_EVERY = 30; // seconds
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const Game = {
    role: null,
    session: null,
    net: null,
    hostRace: null,
    clientRace: null,
    code: null,
    lastScreen: null,
    saveT: 0,
    spectate: 0,
    lost: null,

    // =============================================================== HOST
    async hostNew(name) {
      const s = new G.HostSession({ hostId: HOST_PID });
      const hp = s.addPlayer({ id: HOST_PID, name: name || 'Host', color: G.CarModel.PALETTE[0], carId: G.App.myCar() });
      hp.garage.carId = hp.carId;
      hp.garage.look = G.Parts.cleanLook(hp.garage.look, G.App.myLook() || {}); // your paint comes with you
      s.syncBots();
      await this._startHost(s, null);
    },

    savedSession() {
      const sv = U.store.get(SAVE_KEY, null);
      if (!sv || !sv.state || Date.now() - sv.savedAt > 12 * 3600 * 1000) return null;
      if (sv.state.phase === 'final') return null;
      return sv;
    },

    async resume() {
      const sv = this.savedSession();
      if (!sv) return;
      const s = G.HostSession.fromSave(sv.state);
      await this._startHost(s, sv.code);
    },

    async _startHost(s, wantCode) {
      this.role = 'host';
      this.session = s;
      G.UI.toast(wantCode ? `Re-opening room ${wantCode}…` : 'Opening a room…');
      let net = null, code = wantCode;
      if (G.Net.peerAvailable()) {
        // After a crash our old peer id can stay registered for a while; keep
        // trying the SAME code (clients are trying to reconnect to it).
        const tries = wantCode ? 25 : 6;
        for (let i = 0; i < tries; i++) {
          const c = wantCode || U.roomCode();
          const n = new G.Net.NetHost(c);
          try {
            await n.open();
            net = n;
            code = c;
            break;
          } catch (e) {
            n.close();
            if (e.message === 'taken' && wantCode) {
              G.UI.toast(`Room ${wantCode} still held by the old tab… retrying`, 'info');
              await sleep(3000);
              continue;
            }
            if (e.message !== 'taken') {
              console.warn('[host] open failed', e);
              break;
            }
          }
        }
      }
      if (!net) {
        code = code || 'OFFLINE';
        G.UI.toast('Could not reach the PeerJS server — playing offline (bots only).', 'bad');
      }
      this.code = code;
      s.state.code = code;
      this.net = net;
      this._wireHost();
      G.Client.connectLocal(s, HOST_PID);
      this._save();
      G.App.enterSession();
    },

    _wireHost() {
      const s = this.session, net = this.net;
      s.on('state', (st) => {
        if (net) net.broadcastCtrl({ t: 'state', s: st });
      });
      s.on('toPlayer', (pid, m) => {
        if (pid !== HOST_PID && net) net.sendCtrl(pid, m);
      });
      s.on('broadcast', (m) => {
        if (net) net.broadcastCtrl(m);
      });
      s.on('raceStart', () => {
        this.hostRace = new G.HostRace(s, net, HOST_PID);
      });
      s.on('raceEnd', () => {
        this.hostRace = null;
      });
      s.on('phase', () => this._save());
      s.on('kick', (pid) => {
        if (!net) return;
        net.sendCtrl(pid, { t: 'kicked', reason: 'The host removed you from the room.' });
        setTimeout(() => net.dropPid(pid), 300);
      });
      if (!net) return;
      net.on('hello', (L, d) => {
        const r = s.join(String(d.name || 'Driver'), String(d.token || ''));
        if (!r.ok) return net.reject(L, r.reason);
        net.bind(L, r.pid);
        net.sendCtrl(r.pid, { t: 'welcome', id: r.pid, code: this.code });
        net.sendCtrl(r.pid, { t: 'state', s: s.publicState() });
        s.touch();
      });
      net.on('ctrl', (pid, m) => s.handle(pid, m));
      net.on('fast', (pid, m) => {
        if (m.t === 'i' && this.hostRace) this.hostRace.onInput(pid, m);
      });
      net.on('leave', (pid) => s.leave(pid));
      net.on('signal', (st) => {
        if (st === 'lost') G.UI.toast('Lost the matchmaking server — racers already here are fine; reconnecting…', 'bad');
      });
    },

    _save() {
      if (this.role !== 'host' || !this.session) return;
      U.store.set(SAVE_KEY, { code: this.code, savedAt: Date.now(), state: this.session.state });
      this.saveT = 0;
    },

    // ============================================================= CLIENT
    lastClient() {
      const c = U.store.get(CLIENT_KEY, null);
      return c && Date.now() - c.at < 6 * 3600 * 1000 ? c : null;
    },

    // token (optional): reclaim a specific seat — used by the menu's Rejoin button.
    async join(code, name, token) {
      code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 5) throw new Error('Room codes are 5 characters.');
      this.role = 'client';
      this.code = code;
      this.name = name;
      this.kicked = false;
      this.rejoinToken = token || null;
      await this._connectClient();
      U.store.set(CLIENT_KEY, { code, name, token: this.token, at: Date.now() });
      G.App.enterSession();
      // Bring the player's car choice and paint from single-player. Paint is
      // free any time; the car only before race 1 (it's a paid swap later).
      const sendPrefs = () => {
        const st = G.Client.state;
        if (!st) return false;
        const me = G.Client.me;
        const look = G.App.myLook();
        if (look) G.Client.act({ t: 'look', look });
        if (me && ['lobby', 'carselect'].includes(st.phase) && me.carId !== G.App.myCar()) G.Client.act({ t: 'setCar', carId: G.App.myCar() });
        return true;
      };
      if (!sendPrefs()) {
        const off = G.Client.on('state', () => {
          off();
          sendPrefs();
        });
      }
    },

    // Seat token. Kept in sessionStorage: it is per TAB and survives a reload
    // or crash-restore of that tab, so the same tab always gets its seat back,
    // while two tabs/windows in one browser are two different drivers. (With
    // localStorage, a second tab silently stole the first tab's seat.) The
    // menu's "Rejoin" button passes the last token explicitly for the case
    // where the tab itself was closed.
    _seatToken() {
      const key = 'ss.tok.' + this.code;
      let token = null;
      try {
        token = sessionStorage.getItem(key);
      } catch (e) {}
      if (!token) token = this.rejoinToken || U.uid(18);
      try {
        sessionStorage.setItem(key, token);
      } catch (e) {}
      this.rejoinToken = null;
      this.token = token;
      return token;
    },

    async _connectClient() {
      const code = this.code;
      const token = this._seatToken();
      const net = new G.Net.NetClient(code);
      await net.connect();
      // Attach the general handler BEFORE hello so the state that follows the
      // welcome can't slip past us.
      let welcomed = null;
      const offCtrl = net.on('ctrl', (m) => {
        if (welcomed) this._onCtrl(m);
      });
      const welcome = await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error('The host did not answer.')), 8000);
        const off = net.on('ctrl', (m) => {
          if (m.t === 'welcome') {
            clearTimeout(to);
            off();
            res(m);
          } else if (m.t === 'reject') {
            clearTimeout(to);
            off();
            rej(new Error(m.reason || 'Rejected by host.'));
          }
        });
        net.sendCtrl({ t: 'hello', proto: G.Net.PROTO, name: this.name, token });
      }).catch((e) => {
        offCtrl();
        net.close();
        throw e;
      });
      welcomed = welcome;
      this.net = net;
      G.Client.connectRemote(net, welcome.id);
      net.on('fast', (m) => {
        if (m.t === 's' && this.clientRace) this.clientRace.onSnap(m);
      });
      net.on('lost', (why) => this._lost(why));
      this.lost = null;
    },

    _onCtrl(m) {
      if (m.t === 'kicked') {
        // Our seat was claimed by a newer connection with the same token
        // (the player reopened the game elsewhere). Don't fight over it.
        this.kicked = true;
        G.UI.toast(m.reason || 'You joined from somewhere else.', 'bad');
        return;
      }
      if (m.t === 'state') G.Client._state(m.s);
      else if (m.t === 'ev') {
        if (this.clientRace && m.no === this.clientRace.no) G.RaceView.events(m.e, G.Client.meId, G.App.hud, G.App.world, G.Audio);
      } else G.Client._msg(m);
    },

    // Link to the host died. Keep the last state on screen and retry the full
    // handshake (same token => same seat) every few seconds for 5 minutes.
    async _lost(why) {
      if (this.role !== 'client' || this.lost) return;
      if (this.kicked) return this.leave();
      this.lost = { since: Date.now(), why, tries: 0 };
      this.clientRace = null;
      G.UI.toast('Connection to the host lost — reconnecting…', 'bad');
      while (this.role === 'client' && this.lost) {
        await sleep(3000);
        if (this.role !== 'client' || !this.lost) return;
        this.lost.tries++;
        try {
          await this._connectClient();
          G.UI.toast('Reconnected!', 'good');
          this.lastScreen = null;
          return;
        } catch (e) {
          if (Date.now() - this.lost.since > 5 * 60 * 1000) {
            G.UI.toast('Could not get back into the session.', 'bad');
            this.leave();
            return;
          }
        }
      }
    },

    leave() {
      if (this.net) this.net.close();
      if (this.role === 'host' && this.session && this.session.state.phase === 'final') U.store.del(SAVE_KEY);
      this.role = null;
      this.session = null;
      this.net = null;
      this.hostRace = null;
      this.clientRace = null;
      this.lost = null;
      this.lastScreen = null;
      G.Client.disconnect();
      G.App.exitSession();
    },

    // ============================================================== FRAME
    // Bookkeeping that must run every frame regardless of what's on screen.
    tick(dt) {
      if (!this.role) return;
      if (this.role === 'host') {
        const s = this.session;
        s.update(Date.now());
        if (this.hostRace) {
          const drivingHere = G.App.mode === 'session';
          const inp = drivingHere ? G.Input.read() : { s: 0, t: 0, b: 1, hb: 0 };
          if (drivingHere && G.Input.hitAction('reset')) inp.rs = 1;
          const ev = this.hostRace.update(dt, inp);
          if (drivingHere && ev.length) G.RaceView.events(ev, HOST_PID, G.App.hud, G.App.world, G.Audio);
        }
        if (this.net) this.net.tick(performance.now());
        s.flush();
        this.saveT += dt;
        if (this.saveT >= SAVE_EVERY) this._save();
      } else {
        if (this.net && this.net.pump) this.net.pump(performance.now()); // keep-alive, works when hidden
        if (this.clientRace && G.App.mode === 'session') {
          const inp = G.Input.read();
          if (G.Input.hitAction('reset')) inp.rs = 1;
          this.clientRace.update(dt, inp);
        }
      }
      this._syncRace();
    },

    // Create/destroy the client-side race object as the session enters/leaves a race.
    _syncRace() {
      const st = G.Client.state;
      if (!st) return;
      if (this.role === 'client') {
        if (st.phase === 'race' && st.race && (!this.clientRace || this.clientRace.no !== st.race.no) && this.net && !this.lost) {
          this.clientRace = new G.ClientRace(st.race, G.Client.meId, this.net);
          this._enterRaceView(st.race);
        } else if (st.phase !== 'race' && this.clientRace) this.clientRace = null;
      } else if (this.role === 'host') {
        if (this.hostRace && this.viewNo !== this.hostRace.no) this._enterRaceView(st.race || { trackId: this.hostRace.track.id, entrants: this.hostRace.sim.cars.map((c) => c.entrant), no: this.hostRace.no });
      }
    },

    _enterRaceView(race) {
      this.viewNo = race.no;
      const w = G.App.world;
      w.loadTrack(G.getTrack(race.trackId));
      w.setCars(race.entrants);
      w.cam.snap = true;
      G.App.hud.setTrack(G.getTrack(race.trackId));
      this.spectate = 0;
    },

    racing() {
      const st = G.Client.state;
      return !!(st && st.phase === 'race' && st.race && st.race.entrants.some((e) => e.id === G.Client.meId));
    },

    // Draw the session: race view during races, attract race otherwise.
    render(dt) {
      const st = G.Client.state;
      if (!st) return;
      const app = G.App;
      if (st.phase === 'race' && (this.hostRace || this.clientRace)) {
        let view;
        if (this.hostRace) view = G.RaceView.fromSim(this.hostRace.sim, HOST_PID, this.hostRace.acc / P.DT);
        else view = this.clientRace.view();
        const meRacing = view.cars.some((c) => c.id === G.Client.meId);
        // Spectators: number keys / Tab pick who to follow; WASD = free camera.
        let focus = null, free = false;
        if (meRacing) focus = G.Client.meId;
        else {
          for (let k = 1; k <= 8; k++) if (G.Input.hit('Digit' + k) && view.cars[k - 1]) { this.spectate = k - 1; this.freeCam = false; }
          if (G.Input.hit('Tab')) { this.spectate = (this.spectate + 1) % view.cars.length; this.freeCam = false; }
          const K = G.Input.keys;
          if (K.KeyW || K.KeyA || K.KeyS || K.KeyD || K.ArrowUp || K.ArrowDown || K.ArrowLeft || K.ArrowRight) this.freeCam = true;
          const tgt = view.order[Math.min(this.spectate, view.order.length - 1)];
          focus = this.freeCam ? null : tgt ? tgt.id : null;
          free = true;
        }
        if (G.Input.hitAction('cam')) G.UI.toast('Camera: ' + app.world.cycleCam(), 'info');
        if (!app.hud.root.style.display || app.hud.root.style.display === 'none') app.hud.show(true);
        view.order.forEach((o) => {
          const b = this.betTag ? this.betTag(o.id) : null;
          if (b) o.bet = b;
        });
        this.lastView = view;
        G.RaceView.apply(view, app.world, app.hud, dt, { focusId: free && !this.freeCam ? focus : meRacing ? focus : null, freeCam: free && this.freeCam, keys: G.Input.keys });
      } else {
        if (app.hud.root.style.display !== 'none') {
          app.hud.show(false);
          app.hud.clearTags();
        }
        if (G.UI.curName === 'garage') G.Preview.update(dt); // intermission, or tune/paint before race 1
        else {
          if (!app.attract || app.world.track !== app.attract.track) app.startAttract();
          app.frameAttract(dt);
        }
      }
    },

    // Screen for the current phase. Called on every state change.
    syncScreen() {
      const st = G.Client.state;
      if (!st || G.App.mode !== 'session') return;
      const key = st.phase + (st.phase === 'intermission' ? ':' + (this.interTab || 'garage') : '');
      if (key !== this.lastScreen) {
        this.lastScreen = key;
        const map = { lobby: 'lobby', carselect: 'carselect', entry: 'entry', betting: 'betting', race: 'raceui', results: 'results', final: 'final' };
        if (st.phase === 'intermission') {
          const t = this.interTab || 'garage';
          if (t === 'garage' || !G.UI.screens[t]) G.UI.show('garage', this.garageArg());
          else G.UI.show(t);
        } else if (map[st.phase] && G.UI.screens[map[st.phase]]) G.UI.show(map[st.phase]);
      } else G.UI.refresh();
    },

    // ---------------------------------------------- betting presentation
    // Tag shown next to a racer in the HUD standings tower.
    betTag(id) {
      const st = G.Client.state, me = G.Client.meId;
      if (!st) return null;
      const mine = (st.bets || []).filter((b) => b.pid === me && b.racer === id);
      if (mine.length) return mine.map((b) => (b.type === 'win' ? 'WIN ' : 'POD ') + '$' + b.stake).join(' ');
      const sb = (st.sideBets || []).find((s) => s.status === 'accepted' && ((s.from === me && s.to === id) || (s.to === me && s.from === id)));
      return sb ? '⚔ $' + sb.stake : null;
    },

    spectateExtra() {
      const st = G.Client.state, me = G.Client.meId;
      const mine = st && (st.bets || []).filter((b) => b.pid === me);
      if (!mine || !mine.length) return '';
      return ' · <b>your bets</b> ' + mine.map((b) => `${U.esc(b.racerName)} ${b.type} $${b.stake}@${b.odds.toFixed(1)}x`).join(', ');
    },

    // Payout + bet breakdown under the results table.
    resultsExtra(R) {
      const me = G.Client.meId;
      const row = R.rows.find((r) => r.id === me);
      const ln = (k, v, cls) => `<div class="ln ${cls || ''}"><span>${k}</span><b>${v}</b></div>`;
      let a = '';
      if (row && row.payout) {
        const p = row.payout;
        a = `<div class="box"><h3>Your payout</h3>${ln(row.dnf ? 'DNF appearance fee' : 'Prize (' + U.ordinal(row.pos) + ')', U.fmtMoney(p.prize))}${p.fast ? ln('Fastest lap', U.fmtSigned(p.fast)) : ''}${p.gain ? ln('Places gained', U.fmtSigned(p.gain)) : ''}${p.stipend ? ln('Sponsor stipend', U.fmtSigned(p.stipend)) : ''}${ln('Fuel bill', U.fmtSigned(-p.fuel))}${ln('Net', U.fmtSigned(p.net), 'tot')}</div>`;
      }
      const bets = (R.bets || []).filter((b) => b.pid === me);
      const sides = (R.sideBets || []).filter((s) => s.from === me || s.to === me);
      let b = '';
      if (bets.length || sides.length) {
        b = `<div class="box"><h3>Your bets</h3>${bets.map((x) => ln(`${U.esc(x.racerName)} ${x.type} @${x.odds.toFixed(2)}x`, x.won ? U.fmtSigned(x.payout - x.stake) : U.fmtSigned(-x.stake))).join('')}${sides
          .map((s) => {
            const other = s.from === me ? s.toName : s.fromName;
            const res = s.winner == null ? 'refunded' : s.winner === me ? U.fmtSigned(s.stake) : U.fmtSigned(-s.stake);
            return ln('⚔ vs ' + U.esc(other), res);
          })
          .join('')}</div>`;
      } else {
        const n = (R.bets || []).length + (R.sideBets || []).length;
        if (n) b = `<div class="box"><h3>The book</h3>${(R.bets || []).map((x) => ln(`${U.esc(x.name)} → ${U.esc(x.racerName)}`, x.won ? 'WON ' + U.fmtMoney(x.payout) : 'lost')).join('')}</div>`;
      }
      return a + b;
    },

    garageArg() {
      return {
        tabs: true,
        doneLabel: () => (G.Client.me && G.Client.me.ready ? '✓ Ready (undo)' : 'Ready for next race'),
        onDone: () => G.Client.act({ t: 'ready', v: !(G.Client.me && G.Client.me.ready) }),
        onTestDrive: (c) => G.App.startDrive({ trackId: 'proving', test: c }),
        nextTrack: () => {
          const st = G.Client.state;
          const id = st && st.schedule[st.raceNo];
          return id ? G.getTrack(id) : null;
        },
        extra: () => this.readyLine(),
      };
    },

    readyLine() {
      const st = G.Client.state;
      if (!st) return '';
      const hs = Object.values(st.players).filter((p) => !p.isBot && p.connected);
      const r = hs.filter((p) => p.ready).length;
      const left = st.phaseEnds ? Math.max(0, Math.ceil((st.phaseEnds - G.Client.hostNow()) / 1000)) : null;
      return `${r}/${hs.length} ready${left != null ? ' · auto-start ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : ''}`;
    },
  };

  G.Game = Game;
})(window.G);
