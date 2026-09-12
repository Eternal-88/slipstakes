// session.js — HostSession: the single source of truth for a session.
//
// Runs ONLY in the host's browser (in single-player practice the local player
// is the host). Every rule lives here: joining, buying, fitting, selling,
// repairs, race flow, payouts, bets, the casino floor. Clients never mutate
// state — they send small action messages `{t: 'buy', slot, opt}` and receive
// the resulting public state. The state object is plain JSON so it can be
// autosaved and restored after a crash.
'use strict';
(function (G) {
  const U = G.U, Parts = G.Parts;

  const START_MONEY = 3000;
  const SANDBOX_MONEY = 25000;
  const MAX_PLAYERS = 8;
  const T = { carselect: 75000, results: 15000, intermission: 150000, allReadyGrace: 2500 };

  function newPlayer(o) {
    return {
      id: o.id, name: (o.name || 'Driver').slice(0, 16), token: o.token || null, isBot: !!o.isBot, color: o.color,
      carId: o.carId || 'vandal', connected: true, money: o.money != null ? o.money : START_MONEY,
      garage: Parts.newGarage(o.carId || 'vandal'),
      stats: { wins: 0, podiums: 0, races: 0, earned: 0, spent: 0, fuel: 0, repairs: 0, casino: 0, bets: 0, sold: 0, history: [], form: [] },
      ready: false, entry: null, botSkill: o.botSkill || 0, joinedAt: Date.now(),
    };
  }

  class HostSession extends U.Emitter {
    constructor(opts) {
      super();
      opts = opts || {};
      this.state = {
        v: 1, code: opts.code || null, createdAt: Date.now(), hostId: opts.hostId || null,
        phase: opts.sandbox ? 'sandbox' : 'lobby', phaseEnds: 0,
        // vis: 'private' = listed with a lock, the host approves each new
        // driver; 'public' = anyone on the server list walks in.
        settings: { races: 8, bots: 3, sandbox: !!opts.sandbox, catchup: 'mild', vis: 'private', maxPlayers: 8, name: '' },
        // rid: this room's id on the server list (kept through host
        // migrations); epoch: how many times the host has changed
        rid: opts.rid || U.uid(10), epoch: 0, heirs: [],
        // lid: the room's PUBLIC id on the server list (rid stays secret: it
        // derives the room codes after a host change); lobbySince: when the
        // lobby opened (an unstarted lobby closes after 15 min, game.js)
        lid: U.uid(10), lobbySince: Date.now(),
        raceNo: 0, schedule: [], players: {}, order: [], chat: [], race: null, results: null,
        bets: [], sideBets: [], odds: {}, casino: null, final: null, seq: 0, nextId: 1,
      };
      this.dirty = true;
      this.lastActive = Date.now(); // last time a HUMAN did anything (idle rooms close: game.js)
    }

    // HOST MIGRATION. The host keeps sending its full state (tokens
    // included) to the first two heirs (heirList). When it drops, the first
    // heir rebuilds the session from that copy and hosts it under the next
    // room code (see game.js).
    //  * Everyone else starts disconnected. Their games rejoin automatically
    //    with their seat tokens and get their car, parts and money back. The
    //    old host keeps a seat too.
    //  * A race that was running is voided (no payouts, no wear, bets
    //    refunded), and the session carries on from the garage.
    // (This replaced the autosave: a session now lives as long as anyone is
    // still in it, and nothing is stored between visits.)
    static fromMigration(saved, newHostId, epoch, code, left) {
      const s = new HostSession({});
      s.state = U.deepClone(saved);
      const st = s.state;
      const old = st.players[st.hostId];
      st.hostId = newHostId;
      st.epoch = epoch;
      st.code = code;
      st.heirs = [];
      for (const id in st.players) {
        const p = st.players[id];
        p.connected = p.isBot || id === newHostId;
        p.ready = !!p.isBot;
        Parts.fixGarage(p.garage);
      }
      if (st.phase === 'race' || st.phase === 'entry' || st.phase === 'betting') {
        if (s.refundBets) s.refundBets('Race voided: the host changed');
        st.race = null;
        st.phase = 'intermission';
        st.phaseEnds = Date.now() + T.intermission;
      } else if (st.phaseEnds) st.phaseEnds = Math.max(st.phaseEnds, Date.now() + 20000); // time for everyone to find the new host
      const me = st.players[newHostId];
      s.sys(`${me ? me.name : 'Someone'} is now the host${old ? ` — ${old.name} ${left ? 'left' : 'lost connection'} (their seat is saved)` : ''}.`);
      return s;
    }

    player(id) {
      return this.state.players[id];
    }
    humans() {
      return Object.values(this.state.players).filter((p) => !p.isBot);
    }
    bots() {
      return Object.values(this.state.players).filter((p) => p.isBot);
    }
    addPlayer(o) {
      const p = newPlayer(o);
      if (this.state.settings.sandbox) p.money = SANDBOX_MONEY;
      if (!p.garage.look.num) p.garage.look.num = 1 + (U.hashStr(p.id + (o.name || '')) % 99);
      this.state.players[p.id] = p;
      if (!this.state.order.includes(p.id)) this.state.order.push(p.id);
      this.touch();
      return p;
    }
    touch() {
      this.dirty = true;
    }
    toast(pid, msg, kind) {
      this.emit('toPlayer', pid, { t: 'toast', msg, kind: kind || 'info' });
    }
    sys(text) {
      this.state.chat.push({ sys: 1, text, at: Date.now() });
      if (this.state.chat.length > 50) this.state.chat.shift();
      this.touch();
    }
    // Emit the public state if anything changed (called once per frame).
    flush() {
      if (!this.dirty) return;
      this.dirty = false;
      this.state.seq++;
      this.state.now = Date.now(); // host clock: clients derive countdowns from it
      this.state.heirs = this.heirList();
      this.emit('state', this.publicState());
    }
    // Tokens are secrets (they prove identity on rejoin) — never broadcast.
    // The blackjack shoe and the dealer's face-down card are host-only too:
    // anything in public state can be read by any client's dev tools.
    publicState() {
      const s = U.deepClone(this.state);
      for (const id in s.players) delete s.players[id].token;
      delete s.banned; // tokens again
      if (s.casino && s.casino.bj) {
        delete s.casino.bj.shoe;
        delete s.casino.bj.hole;
      }
      return s;
    }
    setPhase(ph, ms) {
      this.state.phase = ph;
      this.state.phaseEnds = ms ? Date.now() + ms : 0;
      this.touch();
      this.emit('phase', ph);
    }

    // Entry point for every client action.
    handle(pid, m) {
      const p = this.player(pid);
      if (!p || !m || typeof m.t !== 'string') return;
      if (!p.isBot) this.lastActive = Date.now();
      const fn = this['on_' + m.t];
      if (fn) {
        try {
          fn.call(this, p, m);
        } catch (e) {
          console.error('[host] action failed', m, e);
        }
      }
    }
    isHost(p) {
      return p.id === this.state.hostId;
    }

    // ------------------------------------------------------ joining / leaving
    // A token that matches an existing human = the same person coming back
    // (crash, reload, network drop): they get their car, parts and money back.
    join(name, token) {
      const st = this.state;
      this.lastActive = Date.now();
      name = String(name || 'Driver').trim().slice(0, 16) || 'Driver';
      if (token && (st.banned || []).includes(token)) return { ok: false, reason: 'The host removed you from this room.' };
      const ex = token ? Object.values(st.players).find((p) => !p.isBot && p.token === token) : null;
      if (ex) {
        ex.connected = true;
        ex.name = name;
        this.sys(`${ex.name} is back.`);
        return { ok: true, pid: ex.id, rejoin: true };
      }
      if (st.phase === 'final') return { ok: false, reason: 'That session has finished.' };
      const cap = Math.min(MAX_PLAYERS, st.settings.maxPlayers || MAX_PLAYERS);
      if (this.humans().filter((p) => p.connected).length >= cap) return { ok: false, reason: `The room is full (${cap} drivers).` };
      if (this.humans().length >= MAX_PLAYERS && !this._freeSeat()) return { ok: false, reason: 'The room is full.' };
      if (Object.keys(st.players).length >= MAX_PLAYERS) this.removeBot();
      // work out a late joiner's money BEFORE they're in the list
      const late = st.phase !== 'lobby' && st.phase !== 'carselect' ? this.lateJoinMoney() : null;
      const id = 'p' + st.nextId++;
      const used = new Set(Object.values(st.players).map((p) => p.color));
      const color = G.CarModel.PALETTE.find((c) => !used.has(c)) || G.CarModel.PALETTE[0];
      const p = this.addPlayer({ id, name, token, color, carId: 'vandal' });
      if (late != null) p.money = late;
      this.sys(late != null ? `${p.name} joined with ${U.fmtMoney(late)} — they race from the next round.` : `${p.name} joined.`);
      return { ok: true, pid: id };
    }

    // Private rooms: a NEW driver needs the host's OK. Someone reclaiming
    // their own seat (same token) walks straight back in; a banned token is
    // turned away by join() without bothering the host.
    needsApproval(token) {
      const st = this.state;
      if (st.settings.vis !== 'private') return false;
      if (token && (st.banned || []).includes(token)) return false;
      return !(token && Object.values(st.players).some((p) => !p.isBot && p.token === token));
    }

    // All 8 seats taken but some are offline: free the one gone longest.
    _freeSeat() {
      const off = this.humans().filter((p) => !p.connected && p.id !== this.state.hostId).sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (!off) return false;
      delete this.state.players[off.id];
      this.state.order = this.state.order.filter((x) => x !== off.id);
      return true;
    }

    // Late joiners get 80% of the POOREST connected driver's net worth (cash
    // plus half their parts' value). They can buy their way back into it,
    // but never start ahead of anyone. Never less than normal starting money.
    lateJoinMoney() {
      const w = this.humans().filter((p) => p.connected).map((p) => this.netWorth(p));
      if (!w.length) return START_MONEY;
      return Math.max(START_MONEY, Math.round((Math.min(...w) * 0.8) / 100) * 100);
    }

    // Who takes over if the host drops: connected humans in the order they
    // first joined (not the host). The first two are sent the full state.
    heirList() {
      return this.humans()
        .filter((p) => p.connected && p.id !== this.state.hostId)
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .slice(0, 2)
        .map((p) => p.id);
    }

    leave(pid) {
      const p = this.player(pid);
      if (!p || p.isBot) return;
      p.connected = false;
      p.ready = false;
      this.sys(`${p.name} disconnected — their seat is saved.`);
      this.touch();
    }

    removeBot() {
      const b = this.bots().pop();
      if (b) {
        delete this.state.players[b.id];
        this.state.order = this.state.order.filter((x) => x !== b.id);
      }
    }

    // Keep the number of bots = settings.bots, capped so humans+bots <= 8.
    syncBots() {
      const st = this.state;
      const want = Math.max(0, Math.min(st.settings.bots, MAX_PLAYERS - this.humans().length));
      while (this.bots().length > want) this.removeBot();
      let k = 0;
      while (this.bots().length < want) {
        const id = 'b' + st.nextId++;
        const used = new Set(Object.values(st.players).map((p) => p.color));
        const color = G.CarModel.PALETTE.find((c) => !used.has(c)) || G.CarModel.PALETTE[7];
        // v4.4 variety (bot.js BotKit): a name nobody here has, a driving style
        // that picks the car and the shopping list, a random look, and a
        // starting build paid out of the bot's own money
        const K = G.BotKit, rnd = Math.random;
        const name = K.names(1, Object.values(st.players).map((p) => p.name.replace(' ⚙', '')), rnd)[0];
        const style = K.style(rnd);
        const carId = K.car(style, rnd);
        const bp = this.addPlayer({ id, name: name + ' ⚙', isBot: true, color, carId, botSkill: +(0.86 + 0.09 * rnd()).toFixed(3) });
        bp.botStyle = style;
        bp.garage.look = K.look(rnd);
        const b = K.parts(style, Math.max(0, Math.min(1600, bp.money - 1400)), rnd);
        for (const slot in b.parts) {
          if (!bp.garage.owned[slot].includes(b.parts[slot])) bp.garage.owned[slot].push(b.parts[slot]);
          bp.garage.installed[slot] = b.parts[slot];
        }
        bp.money -= b.spent;
        if (++k > 8) break;
      }
      this.touch();
    }

    // --------------------------------------------------------------- lobby
    on_settings(p, m) {
      if (!this.isHost(p)) return;
      const st = this.state, s = st.settings;
      // any time: who can get in, and what the room is called on the list
      if (m.vis === 'public' || m.vis === 'private') s.vis = m.vis;
      if (m.maxPlayers != null && isFinite(+m.maxPlayers)) s.maxPlayers = U.clamp(Math.round(+m.maxPlayers), 2, MAX_PLAYERS);
      if (m.name != null) s.name = String(m.name).replace(/\s+/g, ' ').trim().slice(0, 28);
      // bots: any time but mid-race (they join or leave between races)
      if (m.bots != null && isFinite(+m.bots) && st.phase !== 'race') s.bots = U.clamp(Math.round(+m.bots), 0, 7);
      // the shape of the session: lobby only
      if (st.phase === 'lobby') {
        if (m.races != null && isFinite(+m.races)) s.races = U.clamp(Math.round(+m.races), 1, 100);
        if (m.catchup != null && G.Settings.CATCHUP[m.catchup] != null) s.catchup = m.catchup;
      }
      if (st.phase !== 'race') this.syncBots();
      this.touch();
    }

    on_chat(p, m) {
      const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      if (!text) return;
      // chat is open on every screen now: one line per 0.6 s per player
      const last = (this._chatT = this._chatT || {});
      if (Date.now() - (last[p.id] || 0) < 600) return;
      last[p.id] = Date.now();
      this.state.chat.push({ from: p.id, name: p.name, color: p.color, text, at: Date.now() });
      if (this.state.chat.length > 50) this.state.chat.shift();
      this.touch();
    }

    on_ready(p, m) {
      p.ready = !!m.v;
      this.touch();
      this.checkAllReady();
    }

    // Host's big button: advances whatever phase we're in.
    on_start(p) {
      if (!this.isHost(p)) return;
      const ph = this.state.phase;
      if (ph === 'lobby') this.toCarSelect();
      else if (ph === 'carselect' || ph === 'intermission') this.startEntry();
      else if (ph === 'entry') this.startBetting();
      else if (ph === 'betting') this.startRace();
      else if (ph === 'results') this.toIntermission();
    }

    checkAllReady() {
      const st = this.state;
      if (!['carselect', 'intermission', 'results', 'betting'].includes(st.phase)) return;
      const hs = this.humans().filter((p) => p.connected);
      if (hs.length && hs.every((p) => p.ready)) {
        // short grace so a mis-click can be undone
        st.phaseEnds = Math.min(st.phaseEnds || Infinity, Date.now() + T.allReadyGrace);
        this.touch();
      }
    }

    toCarSelect() {
      const st = this.state;
      st.schedule = this.makeSchedule(st.settings.races);
      for (const p of Object.values(st.players)) p.ready = !!p.isBot;
      this.setPhase('carselect', T.carselect);
    }

    // Random order every session, with the old guarantees kept: every track
    // is used before any repeats (a shuffled "bag"), and the same FORMAT is
    // never raced twice in a row (so no build can dominate a stretch).
    makeSchedule(n) {
      const all = G.TrackDefs.ROTATION.slice();
      const fmt = (id) => G.getTrack(id).format;
      const out = [];
      let bag = [];
      while (out.length < n) {
        if (!bag.length) {
          bag = all.slice();
          for (let i = bag.length - 1; i > 0; i--) {
            const j = U.cryptoInt(i + 1);
            [bag[i], bag[j]] = [bag[j], bag[i]];
          }
        }
        const prev = out.length ? out[out.length - 1] : null;
        let k = bag.findIndex((id) => id !== prev && (!prev || fmt(id) !== fmt(prev)));
        if (k < 0) k = bag.findIndex((id) => id !== prev);
        if (k < 0) k = 0;
        out.push(bag.splice(k, 1)[0]);
      }
      return out;
    }
    nextTrackId() {
      return this.state.schedule[this.state.raceNo] || null;
    }

    // Who races: bots, plus connected humans who didn't choose to sit out.
    racers() {
      return this.state.order.map((id) => this.state.players[id]).filter((p) => p && (p.isBot || (p.connected && p.entry !== 'sit')));
    }

    // Grid: race 1 random; afterwards REVERSE standings (richest starts last).
    gridOrder(list) {
      const st = this.state;
      if (st.raceNo === 0) {
        const a = list.slice();
        for (let i = a.length - 1; i > 0; i--) {
          const j = U.cryptoInt(i + 1);
          [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
      }
      return list.slice().sort((a, b) => this.netWorth(a) - this.netWorth(b));
    }

    netWorth(p) {
      return p.money + Math.round(Parts.partsValue(p.garage) * 0.5);
    }

    startRace() {
      const st = this.state;
      if (st.phase === 'race') return;
      const trackId = this.nextTrackId();
      if (!trackId) return this.toFinal();
      const racers = this.gridOrder(this.racers());
      if (!racers.length) {
        this.sys('Nobody to race — skipping.');
        st.raceNo++;
        return this.toIntermission();
      }
      st.race = {
        no: st.raceNo + 1, trackId, startedAt: Date.now(),
        // catch-up strength travels with the race so the host's sim uses it
        catchup: G.Settings.CATCHUP[st.settings.catchup || 'mild'] || 0,
        entrants: racers.map((p) => ({
          id: p.id, name: p.name, carId: p.carId, color: p.color,
          parts: Object.assign({}, p.garage.installed), wear: Object.assign({}, p.garage.wear),
          // setup + looks travel with the entrant so every peer builds the
          // same spec (prediction) and the same model
          tune: Parts.effTune(p.garage.installed, p.garage.tune), look: Object.assign({}, p.garage.look),
          bot: p.isBot ? { skill: p.botSkill } : null,
        })),
      };
      for (const p of Object.values(st.players)) p.ready = false;
      if (this.voidPendingSide) this.voidPendingSide(); // unanswered challenges don't carry into the race
      this.setPhase('race', 0);
      this.emit('raceStart', st.race);
    }

    // results = RaceSim.results(): [{id, pos, finished, dnf, ms, bestLap, grid, wear, fuel}]
    finishRace(results, sim) {
      const st = this.state;
      if (st.phase !== 'race' || !st.race) return;
      const rows = [];
      for (const r of results) {
        const p = this.player(r.id);
        const e = st.race.entrants.find((x) => x.id === r.id);
        if (p) {
          p.garage.wear = { tyre: U.round(r.wear.tyre, 4), engine: U.round(r.wear.engine, 4), body: U.round(r.wear.body, 4) };
          p.stats.races++;
          p.stats.history.push(r.dnf ? 'DNF' : r.pos);
          p.stats.form.push(r.pos);
          if (p.stats.form.length > 3) p.stats.form.shift();
          if (!r.dnf && r.pos === 1) p.stats.wins++;
          if (!r.dnf && r.pos <= 3) p.stats.podiums++;
        }
        rows.push({ id: r.id, name: e ? e.name : '?', color: e ? e.color : 0, pos: r.pos, dnf: r.dnf, ms: r.ms, bestLap: r.bestLap, grid: r.grid, fuel: Math.round(r.fuel), dist: r.dist });
      }
      st.results = { no: st.race.no, trackId: st.race.trackId, rows, fastest: sim && sim.fastest ? sim.fastest : null };
      this.onRaceResults && this.onRaceResults(st.results, sim);
      st.raceNo++;
      st.race = null;
      for (const p of Object.values(st.players)) p.ready = !!p.isBot;
      if (this.casino) this.casino(); // tables open from the results screen on
      this.setPhase('results', T.results);
      this.emit('raceEnd', st.results);
    }

    toIntermission() {
      const st = this.state;
      if (st.raceNo >= st.settings.races) return this.toFinal();
      for (const p of Object.values(st.players)) p.ready = !!p.isBot;
      this.botsShop && this.botsShop();
      // The tables must EXIST before anyone can sit: the casino UI only shows
      // seats once state.casino is in the public state. (It used to be created
      // lazily by the first sit — which the UI never offered: "Tables opening…"
      // forever.)
      if (this.casino) this.casino();
      this.setPhase('intermission', T.intermission);
    }

    toFinal() {
      const st = this.state;
      st.final = {
        at: Date.now(),
        rows: Object.values(st.players)
          .map((p) => ({ id: p.id, name: p.name, color: p.color, isBot: p.isBot, worth: this.netWorth(p), money: p.money, stats: p.stats }))
          .sort((a, b) => b.worth - a.worth),
      };
      this.setPhase('final', 0);
    }

    // Called every host frame.
    update(now) {
      const st = this.state;
      if (this.casinoTick) this.casinoTick(now);
      if (st.phaseEnds && now > st.phaseEnds) {
        st.phaseEnds = 0;
        if (st.phase === 'results') this.toIntermission();
        else if (st.phase === 'carselect' || st.phase === 'intermission') this.startEntry();
        else if (st.phase === 'entry') this.startBetting();
        else if (st.phase === 'betting') this.startRace();
      }
    }

    shopOpen() {
      return ['lobby', 'carselect', 'intermission', 'results', 'sandbox'].includes(this.state.phase);
    }

    // ---------------------------------------------------------------- shop
    on_buy(p, m) {
      if (!this.shopOpen()) return this.toast(p.id, 'The shop is closed right now.', 'bad');
      const slot = Parts.SLOT_MAP[m.slot];
      const o = slot && slot.options.find((x) => x.id === m.opt);
      if (!o) return;
      const g = p.garage;
      if (g.owned[m.slot].includes(o.id)) return this.on_install(p, m);
      if (p.money < o.price) return this.toast(p.id, `Can't afford ${o.name} (${U.fmtMoney(o.price)}).`, 'bad');
      p.money -= o.price;
      p.stats.spent += o.price;
      g.owned[m.slot].push(o.id);
      this._fit(p, m.slot, o.id, true); // buying tyres includes the first set
      this.toast(p.id, `Bought and fitted ${o.name}.`, 'good');
      this.touch();
    }

    on_install(p, m) {
      if (!this.shopOpen()) return this.toast(p.id, 'The shop is closed right now.', 'bad');
      const g = p.garage;
      if (!g.owned[m.slot] || !g.owned[m.slot].includes(m.opt)) return this.toast(p.id, 'You don\'t own that part.', 'bad');
      if (this._fit(p, m.slot, m.opt, false)) {
        this.toast(p.id, `Fitted ${Parts.opt(m.slot, m.opt).name}.`, 'good');
        this.touch();
      }
    }

    // Tyres are a physical set: fitting a different compound or width means a
    // fresh set (paid, resets wear). Otherwise swapping compounds would be a
    // free tyre change.
    _fit(p, slot, optId, freeTyres) {
      const g = p.garage;
      if (g.installed[slot] === optId) return true;
      if (slot === 'compound' || slot === 'width') {
        const np = Object.assign({}, g.installed, { [slot]: optId });
        const cost = freeTyres ? 0 : Parts.tyreSetPrice(np);
        if (p.money < cost) {
          this.toast(p.id, `A new set of those tyres costs ${U.fmtMoney(cost)}.`, 'bad');
          return false;
        }
        p.money -= cost;
        p.stats.repairs += cost;
        g.wear.tyre = 0;
      }
      g.installed[slot] = optId;
      return true;
    }

    on_sell(p, m) {
      if (!this.shopOpen()) return this.toast(p.id, 'The shop is closed right now.', 'bad');
      const slot = Parts.SLOT_MAP[m.slot];
      if (!slot || m.opt === slot.options[0].id) return;
      const g = p.garage;
      const i = g.owned[m.slot].indexOf(m.opt);
      if (i < 0) return;
      const o = Parts.opt(m.slot, m.opt);
      const refund = Math.round(o.price * 0.5);
      g.owned[m.slot].splice(i, 1);
      if (g.installed[m.slot] === m.opt) {
        g.installed[m.slot] = slot.options[0].id;
        if (m.slot === 'compound' || m.slot === 'width') g.wear.tyre = 0.5; // back to a used stock set
      }
      p.money += refund;
      p.stats.sold += refund;
      this.toast(p.id, `Sold ${o.name} for ${U.fmtMoney(refund)}.`, 'good');
      this.touch();
    }

    on_repair(p, m) {
      if (!this.shopOpen()) return this.toast(p.id, 'The shop is closed right now.', 'bad');
      const g = p.garage;
      const q = Parts.repairQuote(g.installed, g.wear);
      const kinds = m.kind === 'all' ? ['tyre', 'engine', 'body'] : [m.kind];
      let spent = 0;
      for (const k of kinds) {
        const c = q[k];
        if (!c) continue;
        if (p.money < c) {
          this.toast(p.id, `Not enough money for the ${k} repair (${U.fmtMoney(c)}).`, 'bad');
          continue;
        }
        p.money -= c;
        spent += c;
        g.wear[k] = 0;
      }
      if (spent) {
        p.stats.repairs += spent;
        this.toast(p.id, `Repairs done: ${U.fmtMoney(spent)}.`, 'good');
        this.touch();
      }
    }

    // Free before the first race (and in single-player). Between races it's a
    // paid chassis swap: all owned parts, setup and paint move to the new car.
    // v4 premium cars (price > 0) are bought once per session on top of that.
    on_setCar(p, m) {
      const ph = this.state.phase;
      const car = Parts.CARS[m.carId];
      if (!car || m.carId === p.carId) return;
      const free = ['lobby', 'carselect', 'sandbox'].includes(ph);
      if (!free && !['intermission', 'results'].includes(ph)) return this.toast(p.id, 'You can only change car between races.', 'bad');
      Parts.fixGarage(p.garage);
      const owned = p.garage.cars.includes(m.carId);
      const buy = owned ? 0 : car.price || 0;
      const fee = buy + (free ? 0 : Parts.CAR_SWAP);
      if (p.money < fee) return this.toast(p.id, `${buy ? 'The ' + car.name + ' costs' : 'A chassis swap costs'} ${U.fmtMoney(fee)}.`, 'bad');
      p.money -= fee;
      p.stats.spent += fee;
      if (buy) p.garage.cars.push(m.carId);
      p.carId = m.carId;
      p.garage.carId = m.carId;
      if (buy) {
        this.toast(p.id, `Bought the ${car.name} (${U.fmtMoney(fee)}). It's yours for the session.`, 'good');
        this.sys(`${p.name} bought a ${car.name}!`);
      } else if (fee) {
        this.toast(p.id, `Swapped to the ${car.name} (${U.fmtMoney(fee)}). Your parts came with you.`, 'good');
        this.sys(`${p.name} swapped to a ${car.name}.`);
      }
      this.touch();
    }

    // Setup sheet. Free, but only while the shop is open (not mid-race).
    on_tune(p, m) {
      if (!this.shopOpen()) return this.toast(p.id, 'Setup changes happen in the garage between races.', 'bad');
      const g = p.garage;
      if (m.reset) g.tune = Parts.defaultTune();
      else if (m.tune && typeof m.tune === 'object') {
        const next = Object.assign({}, g.tune);
        for (const k in m.tune) if (Parts.TUNE_MAP[k]) next[k] = +m.tune[k];
        g.tune = Parts.effTune(g.installed, next);
      }
      this.touch();
    }

    // Paint, livery, rims… cosmetic only, so allowed any time.
    on_look(p, m) {
      if (!m.look || typeof m.look !== 'object') return;
      p.garage.look = Parts.cleanLook(p.garage.look, m.look);
      this.touch();
    }

    // Host removes a player. Their token is banned for this room, so the
    // auto-reconnect / Rejoin button can't bring them straight back.
    on_kick(p, m) {
      if (!this.isHost(p)) return;
      const t = this.player(m.pid);
      if (!t || t.isBot || t.id === p.id) return;
      if (t.token) (this.state.banned = this.state.banned || []).push(t.token);
      delete this.state.players[t.id];
      this.state.order = this.state.order.filter((x) => x !== t.id);
      this.sys(`${t.name} was removed by the host.`);
      this.emit('kick', t.id);
      this.syncBots();
      this.touch();
    }

    // Final standings -> "Play again": same room, same people (and their cars
    // and paint), fresh money, parts and stats. Nobody has to rejoin.
    on_rematch(p) {
      const st = this.state;
      if (!this.isHost(p) || st.phase !== 'final') return;
      for (const id of Object.keys(st.players)) {
        const q = st.players[id];
        if (!q.isBot && !q.connected && id !== st.hostId) {
          delete st.players[id];
          st.order = st.order.filter((x) => x !== id);
          continue;
        }
        const look = q.garage.look;
        q.money = START_MONEY;
        q.garage = Parts.newGarage(q.carId);
        q.garage.look = look;
        q.stats = newPlayer({}).stats;
        q.ready = !!q.isBot;
        q.entry = null;
      }
      Object.assign(st, { raceNo: 0, schedule: [], race: null, results: null, final: null, bets: [], sideBets: [], odds: {}, stipend: [], casino: null });
      this.syncBots();
      this.sys(`${p.name} started a rematch: fresh cars and ${U.fmtMoney(START_MONEY)} each.`);
      st.lobbySince = Date.now();
      this.setPhase('lobby', 0);
    }

    on_setColor(p, m) {
      if (!['lobby', 'carselect', 'sandbox'].includes(this.state.phase)) return;
      const c = +m.color;
      const taken = Object.values(this.state.players).some((o) => o.id !== p.id && o.color === c);
      if (taken) return this.toast(p.id, 'Someone already has that colour.', 'bad');
      if (G.CarModel.PALETTE.includes(c)) {
        p.color = c;
        this.touch();
      }
    }

    // Wear from a practice drive is written back to the car.
    applyWear(pid, wear) {
      const p = this.player(pid);
      if (!p) return;
      for (const k of ['tyre', 'engine', 'body']) p.garage.wear[k] = U.clamp(U.round(wear[k] || 0, 4), 0, 1);
      this.touch();
    }
  }

  G.HostSession = HostSession;
  G.SESSION = { START_MONEY, SANDBOX_MONEY, MAX_PLAYERS, T, newPlayer };
})(window.G);
