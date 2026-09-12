// game.js — multiplayer session controller (both roles).
//   host  : owns HostSession + NetHost + HostRace; broadcasts state; autosaves.
//   client: owns NetClient + ClientRace; applies state; reconnects on drops.
// The App's frame loop calls tick() for bookkeeping every frame (even while
// test-driving) and render() when the session view is on screen.
'use strict';
(function (G) {
  const U = G.U, P = G.Physics;
  const HOST_PID = 'h'; // the ORIGINAL host's player id (after a migration the host is whoever took over: Game.myPid)
  const CLIENT_KEY = 'ss.client';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    U.store.del('ss.save'); // v4.3: no more host autosave (host migration replaced it) — clear old ones
  } catch (e) {}

  // Room code after the host has changed `epoch` times. Everyone in the room
  // knows the room id and the epoch, so they all work out the same new code
  // without being told: no server needed to find the new host.
  function deriveCode(rid, epoch) {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 5; i++) s += A[(U.hashStr(rid + ':' + epoch + ':' + i) >>> 0) % A.length];
    return s;
  }

  const Game = {
    role: null,
    session: null,
    net: null,
    hostRace: null,
    clientRace: null,
    code: null,
    lastScreen: null,
    spectate: 0,
    lost: null,
    myPid: null, // my player id in the session (host or client)
    token: null, // my seat token: proves it's me when I come back (also after a host change)
    requests: new Map(), // host: private-room join requests waiting for an answer
    heirPkg: null, // client: the full state the host sends its heirs (see _lost)
    deriveCode,

    // =============================================================== HOST
    async hostNew(name) {
      const s = new G.HostSession({ hostId: HOST_PID });
      // The host has a seat token too: if the room moves to a new host while
      // we're offline, we come back into our own seat as a player.
      this.token = U.uid(18);
      const hp = s.addPlayer({ id: HOST_PID, name: name || 'Host', token: this.token, color: G.CarModel.PALETTE[0], carId: G.App.myCar() });
      hp.garage.carId = hp.carId;
      hp.garage.look = G.Parts.cleanLook(hp.garage.look, G.App.myLook() || {}); // your paint comes with you
      s.syncBots();
      await this._startHost(s, null);
    },

    async _startHost(s, wantCode) {
      this.role = 'host';
      this.session = s;
      this.myPid = s.state.hostId;
      this.requests.clear();
      this._hadOthers = false;
      this._aloneSince = null;
      if (!wantCode) G.UI.toast('Opening a room…');
      let net = null, code = wantCode;
      if (G.Net.available()) {
        // After a crash our old peer id can stay registered for a while; keep
        // trying the SAME code (clients are trying to reconnect to it).
        const tries = wantCode ? 25 : 6;
        for (let i = 0; i < tries; i++) {
          const c = wantCode || U.roomCode();
          const n = new G.Net.NetHost(c, { lid: s.state.lid, epoch: s.state.epoch || 0 });
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
      } else if (net.relayOnly) {
        G.UI.toast("The matchmaking server is blocked here, so this room is open through the backup relay only (a bit more lag).", 'info');
      }
      this.code = code;
      s.state.code = code;
      this.net = net;
      this._wireHost();
      G.Client.connectLocal(s, this.myPid);
      this._annKey = null;
      G.App.enterSession();
    },

    _wireHost() {
      const s = this.session, net = this.net;
      s.on('state', (st) => {
        if (net) net.broadcastCtrl({ t: 'state', s: st });
      });
      s.on('toPlayer', (pid, m) => {
        if (pid !== this.myPid && net) net.sendCtrl(pid, m);
      });
      s.on('broadcast', (m) => {
        if (net) net.broadcastCtrl(m);
      });
      s.on('raceStart', () => {
        this.hostRace = new G.HostRace(s, net, this.myPid);
      });
      s.on('raceEnd', () => {
        this.hostRace = null;
      });
      s.on('kick', (pid) => {
        if (!net) return;
        net.sendCtrl(pid, { t: 'kicked', reason: 'The host removed you from the room.' });
        setTimeout(() => net.dropPid(pid), 300);
      });
      if (!net) return;
      // v4.4: anyone who has the code walks straight in. Strangers from the
      // server list ask first (relay 'request'), and only an accepted one is
      // given the code.
      net.on('hello', (L, d) => this._admit(L, d));
      net.on('request', (r) => this._listRequest(r));
      net.on('ctrl', (pid, m) => s.handle(pid, m));
      net.on('fast', (pid, m) => {
        if (m.t === 'i' && this.hostRace) this.hostRace.onInput(pid, m);
      });
      net.on('leave', (pid, why) => {
        s.leave(pid);
        this._lastDrop = { t: performance.now(), why };
      });
      net.on('signal', (st) => {
        if (st === 'lost') G.UI.toast('Lost the matchmaking server — racers already here are fine; reconnecting…', 'bad');
      });
    },

    _admit(L, d) {
      const s = this.session, net = this.net;
      L.waiting = false;
      const r = s.join(String(d.name || 'Driver'), String(d.token || ''));
      if (!r.ok) return net.reject(L, r.reason);
      net.bind(L, r.pid);
      net.sendCtrl(r.pid, { t: 'welcome', id: r.pid, code: this.code });
      net.sendCtrl(r.pid, { t: 'state', s: s.publicState() });
      s.touch();
    },

    // A stranger on the server list asks to join this PRIVATE room (relay.js).
    // The host gets a Let in / No card (G.Requests); "Let in" sends them the
    // room code, encrypted so only they can read it. (A public room just says
    // yes: its code is on the list anyway.)
    _listRequest(r) {
      const id = 'q:' + r.cid;
      if (this.requests.has(id)) return;
      if (this.session.state.settings.vis === 'public') return this._replyList(r, true);
      if (this.requests.size >= 6) return; // don't let a flood bury the host
      const name = String(r.name || 'Driver').trim().slice(0, 16) || 'Driver';
      this.requests.set(id, { id, cid: r.cid, pub: r.pub, name, at: Date.now() });
      G.UI.toast(`${name} is asking to join`, 'money');
      this.reqSeq = (this.reqSeq || 0) + 1;
    },

    // Host's answer to a join request.
    answer(id, ok) {
      const r = this.requests.get(id);
      if (!r || !this.net) return;
      this.requests.delete(id);
      this.reqSeq = (this.reqSeq || 0) + 1;
      this._replyList(r, ok);
    },
    async _replyList(r, ok) {
      const relay = this.net && this.net.relay;
      if (!relay) return;
      if (!ok) return relay.answer(r.cid, { ok: 0 });
      try {
        relay.answer(r.cid, Object.assign({ ok: 1 }, await G.Relay.sealFor(r.pub, this.code)));
      } catch (e) {
        relay.answer(r.cid, { ok: 0 });
      }
    },

    // Host housekeeping, every frame: the server-list card, the heirs' copy
    // of the state, stale join requests, and "did MY internet drop?".
    _hostChores(now) {
      if (!this.net) return;
      this._announce(now);
      this._sendHeirs(now);
      for (const r of Array.from(this.requests.values())) {
        if (Date.now() - r.at > 120000) {
          this.requests.delete(r.id);
          this.reqSeq = (this.reqSeq || 0) + 1;
          this._replyList(r, false);
        }
      }
      this._aloneCheck(now);
      this._idleCheck();
    },

    // Rooms don't live for ever. A lobby that's never started closes after 15
    // minutes, and a room where no human has touched anything for 10 minutes
    // closes too (bots would otherwise race an empty room for hours, and it
    // would sit on the server list). Everyone gets a 2-minute warning.
    IDLE: { lobby: 15 * 60000, idle: 10 * 60000, warn: 2 * 60000 },
    _idleCheck() {
      const s = this.session, st = s.state, now = Date.now(), L = this.IDLE;
      const lobby = st.phase === 'lobby' ? now - (st.lobbySince || st.createdAt || now) : 0;
      const idle = now - (s.lastActive || now);
      if (lobby > L.lobby) return this.closeRoom('The room closed: it sat in the lobby for 15 minutes without the host starting it.');
      if (idle > L.idle) return this.closeRoom('The room closed: nobody touched the controls for 10 minutes.');
      const warn = lobby > L.lobby - L.warn ? 'lobby' : idle > L.idle - L.warn ? 'idle' : null;
      if (warn && this._idleWarned !== warn) {
        this._idleWarned = warn;
        const msg = warn === 'lobby' ? '⏳ This room closes in 2 minutes unless the host starts the session.' : '⏳ This room closes in 2 minutes unless someone plays.';
        s.sys(msg);
        G.UI.toast(msg, 'bad');
      } else if (!warn) this._idleWarned = null;
    },
    // Close the room for everyone (no host migration: the room is done).
    closeRoom(reason) {
      if (this.role !== 'host') return;
      const net = this.net;
      if (net) {
        net.broadcastCtrl({ t: 'closed', reason });
        if (net.relay) net.relay.announce(null);
      }
      this._closing = true;
      this.leave();
      this._closing = false;
      G.UI.modal('Room closed', `<p>${U.esc(reason)}</p>`, [{ label: 'OK', value: 1, cls: 'primary' }]);
    },

    // The room's card on the server list (relay.js RoomBoard). Re-sent when
    // something on it changes, and every 25 s so listers know it's alive.
    _announce(now) {
      const net = this.net;
      if (!net.relay || now - (this._annT || 0) < 2000) return;
      this._annT = now;
      const st = this.session.state;
      const hp = st.players[st.hostId];
      const all = Object.values(st.players);
      const card =
        st.phase === 'final'
          ? null
          : {
              // a private room's code is never published: strangers ask for it
              lid: st.lid || this.code, code: st.settings.vis === 'public' ? this.code : undefined,
              epoch: st.epoch || 0, name: st.settings.name || `${hp ? hp.name : 'Host'}'s room`, host: hp ? hp.name : '',
              vis: st.settings.vis || 'private', players: all.filter((p) => !p.isBot && p.connected).length, max: st.settings.maxPlayers || 8,
              bots: all.filter((p) => p.isBot).length, phase: st.phase, race: st.raceNo, races: st.settings.races, ver: G.VERSION, proto: G.Net.PROTO,
            };
      const key = JSON.stringify(card);
      if (key === this._annKey && now - (this._annSent || 0) < 25000) return;
      this._annKey = key;
      this._annSent = now;
      net.relay.announce(card ? Object.assign(card, { at: Date.now() }) : null);
    },

    // HOST MIGRATION, host side: the first two heirs (session.heirList) get
    // the full state — seat tokens included — every 2 s while it changes.
    _sendHeirs(now, force) {
      const st = this.session.state;
      if (!(st.heirs || []).length) return;
      if (!force && now - (this._heirT || 0) < 2000) return;
      if (!force && this._heirSeq === st.seq && now - this._heirT < 15000) return;
      this._heirT = now;
      this._heirSeq = st.seq;
      const copy = JSON.parse(JSON.stringify(st));
      for (const pid of st.heirs) this.net.sendCtrl(pid, { t: 'heir', s: copy, code: this.code });
    },

    // Did MY internet drop? Then every player timed out together and has
    // moved to the heir's new room. Check once whether that room exists; if
    // it does, rejoin it as a player in our own seat (car and money kept).
    async _aloneCheck(now) {
      const st = this.session.state;
      const others = Object.values(st.players).filter((p) => !p.isBot && p.connected && p.id !== st.hostId).length;
      if (others) {
        this._hadOthers = true;
        this._aloneSince = null;
        return;
      }
      if (!this._hadOthers || this._probing) return;
      if (this._aloneSince == null) this._aloneSince = now;
      if (now - this._aloneSince < 7000) return;
      this._hadOthers = false;
      const d = this._lastDrop;
      if (!d || !['timeout', 'close', 'error'].includes(d.why)) return; // they were kicked / replaced: nothing moved
      this._probing = true;
      const code = deriveCode(st.rid, (st.epoch || 0) + 1);
      const probe = new G.Net.NetClient(code);
      let found = false;
      try {
        await probe.connect();
        found = true;
      } catch (e) {}
      try {
        probe.close();
      } catch (e) {}
      this._probing = false;
      if (!found || this.role !== 'host' || this.session.state !== st) return;
      const me = st.players[st.hostId];
      const tok = this.token;
      G.UI.toast('Your connection dropped and the room carried on with a new host — rejoining as a player…', 'info');
      this._closeHost();
      try {
        await this.join(code, me ? me.name : G.App.name(), tok);
      } catch (e) {
        G.UI.toast('Could not get back in: ' + e.message, 'bad');
        this.leave();
      }
    },

    _closeHost() {
      if (this.net) this.net.close();
      this.net = null;
      this.session = null;
      this.hostRace = null;
      this.requests.clear();
      this.role = null;
      G.Client.disconnect();
    },

    // HOST MIGRATION, client side: I'm the heir and the host is gone. Rebuild
    // the session from my copy and host it under the next room code; the
    // others work out the same code and rejoin with their seat tokens.
    async _takeOver(epoch, code, left) {
      const pkg = this.heirPkg, me = G.Client.meId;
      this.heirPkg = null;
      try {
        if (this.net) this.net.close();
      } catch (e) {}
      this.net = null;
      this.lost = null;
      this.clientRace = null;
      G.UI.clearNotice();
      G.UI.toast(left ? "The host left — you're the new host. The room carries on." : "The host dropped out — you're the new host. The room carries on.", 'info');
      const s = G.HostSession.fromMigration(pkg.s, me, epoch, code, left);
      const seat = s.state.players[me];
      if (seat && seat.token) this.token = seat.token;
      await this._startHost(s, code);
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
      this.roomClosed = false;
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
      const quiet = !!this.lost; // the reconnect loop has its own messages
      net.on('status', (s) => {
        if (s === 'relay' && !quiet) G.UI.toast('No direct link to the host (school or office Wi-Fi?) — trying the backup relay…', 'info');
      });
      await net.connect();
      if (net.via === 'relay' && !quiet) G.UI.toast('Connected through the backup relay. Expect a little more lag than a direct link.', 'good');
      // Attach the general handler BEFORE hello so the state that follows the
      // welcome can't slip past us.
      let welcomed = null;
      const offCtrl = net.on('ctrl', (m) => {
        if (welcomed) this._onCtrl(m);
      });
      const welcome = await new Promise((res, rej) => {
        let to = setTimeout(() => rej(new Error('The host did not answer.')), 8000);
        const done = () => {
          clearTimeout(to);
          off();
          G.UI.clearNotice();
        };
        const off = net.on('ctrl', (m) => {
          if (m.t === 'welcome') {
            done();
            res(m);
          } else if (m.t === 'reject') {
            done();
            rej(new Error(m.reason || 'Rejected by host.'));
          } else if (m.t === 'wait') {
            // private room: the host has to let us in (we wait up to 2 min)
            clearTimeout(to);
            to = setTimeout(() => {
              done();
              rej(new Error("The host didn't answer your request."));
            }, 125000);
            G.UI.notice(U.esc(String(m.msg || 'Waiting for the host to let you in…')), () => {
              done();
              rej(new Error('Cancelled.'));
            });
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
      this.myPid = welcome.id;
      G.Client.connectRemote(net, welcome.id);
      net.on('fast', (m) => {
        if (m.t === 's' && this.clientRace) this.clientRace.onSnap(m);
      });
      net.on('lost', (why) => this._lost(why));
      this.lost = null;
    },

    _onCtrl(m) {
      if (m.t === 'heir') {
        // I'm next in line to host: keep the full state in case the host drops
        this.heirPkg = { s: m.s, code: m.code, at: Date.now() };
        return;
      }
      if (m.t === 'migrate') return this._lost('host-left'); // the host is leaving on purpose: hand over now
      if (m.t === 'closed') {
        // the room was closed (idle timeout): leave, don't hunt for a new host
        this.roomClosed = true;
        this.leave();
        G.UI.modal('Room closed', `<p>${U.esc(m.reason || 'The host closed the room.')}</p>`, [{ label: 'OK', value: 1, cls: 'primary' }]);
        return;
      }
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
    // HOST MIGRATION, everyone else: the public state says who the heirs
    // are, plus the room id and epoch, so every player works out the same next
    // room code. The first heir takes over at once. The rest try that code
    // (and the old one, in case the host comes back). If the first heir never
    // shows up, the second takes over under the code after that.
    async _lost(why) {
      if (this.role !== 'client' || this.lost || this.roomClosed) return;
      if (this.kicked) return this.leave();
      this.lost = { since: Date.now(), why, tries: 0 };
      this.clientRace = null;
      try {
        if (this.net) this.net.close();
      } catch (e) {}
      const st = G.Client.state || {};
      const rid = st.rid || this.code, epoch = st.epoch || 0, heirs = st.heirs || [], me = this.myPid;
      const oldCode = this.code;
      const next1 = deriveCode(rid, epoch + 1), next2 = deriveCode(rid, epoch + 2);
      if (heirs[0] === me && this.heirPkg) return this._takeOver(epoch + 1, next1, why === 'host-left');
      G.UI.toast(why === 'host-left' ? 'The host left — finding the new host…' : 'Connection to the host lost — reconnecting…', 'bad');
      const t0 = Date.now();
      while (this.role === 'client' && this.lost) {
        await sleep(heirs.length ? 1500 : 3000);
        if (this.role !== 'client' || !this.lost) return;
        this.lost.tries++;
        if (heirs[1] === me && this.heirPkg && Date.now() - t0 > 20000) return this._takeOver(epoch + 2, next2);
        const codes = !heirs.length ? [oldCode] : Date.now() - t0 > 20000 ? [next2, next1, oldCode] : [next1, oldCode];
        for (const c of codes) {
          if (this.role !== 'client' || !this.lost) return;
          this.code = c;
          this.rejoinToken = this.token; // the same seat, whatever the code
          try {
            await this._connectClient();
            G.UI.toast(c === oldCode ? 'Reconnected!' : 'Back in — the room has a new host.', 'good');
            U.store.set(CLIENT_KEY, { code: c, name: this.name, token: this.token, at: Date.now() });
            this.lastScreen = null;
            return;
          } catch (e) {}
        }
        if (Date.now() - this.lost.since > 5 * 60 * 1000) {
          G.UI.toast('Could not get back into the session.', 'bad');
          this.leave();
          return;
        }
      }
    },

    leave() {
      const net = this.net;
      const st = this.role === 'host' && this.session ? this.session.state : null;
      if (st && net && !this._closing && (st.heirs || []).length && st.phase !== 'final') {
        // The host is leaving on purpose: send the freshest copy to the heirs
        // and tell everyone to move over now (no 6 s timeout to wait out).
        this._sendHeirs(performance.now(), true);
        net.broadcastCtrl({ t: 'migrate' });
        setTimeout(() => net.close(), 800);
      } else if (net && this._closing) setTimeout(() => net.close(), 700); // let "room closed" reach everyone first
      else if (net) net.close();
      G.UI.clearNotice();
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
          if (drivingHere && ev.length) G.RaceView.events(ev, this.myPid, G.App.hud, G.App.world, G.Audio);
        }
        const now = performance.now();
        if (this.net) this.net.tick(now);
        s.flush();
        this._hostChores(now);
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
        if (this.hostRace) view = G.RaceView.fromSim(this.hostRace.sim, this.myPid, this.hostRace.acc / P.DT);
        else view = this.clientRace.view();
        const meRacing = view.cars.some((c) => c.id === G.Client.meId);
        // Spectators: number keys / Tab pick who to follow; WASD = free camera.
        // v4.4: once your own car has finished (it cools down on autopilot)
        // you spectate too: 2 s after the flag the camera jumps to the first
        // car still racing; F goes back to your own car.
        const done = meRacing && view.me && view.me.finished;
        const rno = (this.hostRace || this.clientRace).no;
        if (done && this._doneNo !== rno) {
          this._doneNo = rno;
          this._doneAt = performance.now();
          this.freeCam = false;
          const i = view.order.findIndex((o) => !o.finished && !o.dnf);
          this.spectate = i >= 0 ? i : 0;
        }
        const specNow = !meRacing || (done && performance.now() - this._doneAt > 2000);
        this.spectating = specNow;
        let focus = null, free = false;
        if (!specNow) focus = G.Client.meId;
        else {
          if (done && G.Input.hit('KeyF')) {
            this.spectate = Math.max(0, view.order.findIndex((o) => o.id === G.Client.meId));
            this.freeCam = false;
          }
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

  // A key or click on the host's own computer counts as activity (idle rooms close).
  const markActive = () => {
    if (Game.role === 'host' && Game.session) Game.session.lastActive = Date.now();
  };
  window.addEventListener('keydown', markActive);
  window.addEventListener('pointerdown', markActive);

  G.Game = Game;
})(window.G);
