// ops.js — maintenance console for whoever maintains the game: live stats,
// every room in play (private ones too), room and driver controls, network
// test tools, announcements and a room diary.
//
// Access: Ctrl+Shift+` (or hold the version badge on the menu for 3 s), then
// a passphrase. The passphrase decrypts the maintainer's key (P-256, wrapped
// with PBKDF2 -> AES-GCM in KEY below) into this tab's memory only; nothing
// is saved. The one key does two jobs:
//  * signing — in anyone else's room every command is signed, and commands
//    sent through the relay (no need to be in the room) are signed too. The
//    host's game checks the signature against the public key before acting.
//  * reading — every host seals its room's code and drivers into its server-
//    list card for the public key (ECDH + AES-GCM), so only this key can list
//    private rooms and their codes.
// Opening this panel from dev tools without the passphrase gets you nothing
// beyond your own screen.
'use strict';
(function (G) {
  const U = G.U;
  // From tools/ops-setup.html (kept local): the public key and the private key
  // encrypted with the passphrase. Useless without the passphrase.
  const KEY = { v: 1, it: 600000, pub: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEuzZVDmO+yJvQoRBDOV/x4f1RcUOUlUAFsNye3ZaS0M4JDdwTextkYgEWNrlVtv/THDu4yCdqoX4ow56UJe1UWQ==', salt: 'rHMr8xbH7cn1mYwbF3iLFw==', iv: 'Nte/zv3SD4bFYiAZ', ct: '/7LdoyirwbBD3OXj0WyK559WantxLt1C/HLoiMEziCx78rX2tN8j8gM7WM+GMHfP9lTNma1f9MhW762jlQoKvPL2jhxpEJibBYsu9ydH5VqmJe9uE9xjkiN2LX7iDwp/fZzv8pt8TosTElALUiKp2CVyUgYOcnPklS9NEdaDiZlrfxpJXY5IvPNc/dNKj2EMpe+Jn9k5KA9Qvg==' };

  const enc = new TextEncoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const EC = { name: 'ECDSA', namedCurve: 'P-256' };
  const DH = { name: 'ECDH', namedCurve: 'P-256' };
  const SIG = { name: 'ECDSA', hash: 'SHA-256' };
  const subtle = () => (window.crypto && crypto.subtle) || null; // https / localhost only
  const signed = (code, pid, n, seq, c) => `ss-ops1|${code}|${pid}|${n}|${seq}|${c}`;
  const signedMq = (o) => `ss-opsmq1|${o.id}|${o.at}|${o.lid}|${o.k}|${o.a}`;
  // A skin grant, signed for a named driver. Checked by whichever host they
  // race with next (checkGrant), so it is theirs wherever they go.
  const signedSkin = (t) => `ss-skin1|${t.id}|${t.who}|${t.at}`;

  async function openKey(K, pass) {
    const S = subtle();
    const base = await S.importKey('raw', enc.encode(String(pass).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    const wk = await S.deriveKey({ name: 'PBKDF2', salt: unb64(K.salt), iterations: K.it, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const raw = await S.decrypt({ name: 'AES-GCM', iv: unb64(K.iv) }, wk, unb64(K.ct));
    const sign = await S.importKey('pkcs8', raw, EC, false, ['sign']);
    let dh = null;
    try {
      dh = await S.importKey('pkcs8', raw, DH, false, ['deriveKey']); // the same P-256 key, for reading sealed cards
    } catch (e) {}
    return { sign, dh };
  }
  let pubFor = null, pubKey = null;
  async function verify(str, sig) {
    const K = Ops.KEY, S = subtle();
    if (!K || !S) return false;
    try {
      if (pubFor !== K.pub) {
        pubKey = await S.importKey('spki', unb64(K.pub), EC, false, ['verify']);
        pubFor = K.pub;
      }
      return await S.verify(SIG, pubKey, unb64(sig), enc.encode(str));
    } catch (e) {
      return false;
    }
  }
  // the public key as a raw point (the last 65 bytes of a P-256 SPKI), for sealing
  const rawPub = () => b64(unb64(Ops.KEY.pub).slice(-65));

  // ------------------------------------------------------------- commands
  // What a command acts on: the room we host, or the solo sandbox / practice.
  // (In someone else's room their host runs it, after checking the signature.)
  function ctx() {
    const g = G.Game;
    if (g.role === 'host') return { s: g.session, race: g.hostRace, sim: g.hostRace ? g.hostRace.sim : null };
    if (!g.role) return { s: G.App.host, race: null, sim: G.App.mode === 'drive' ? G.App.sim : null };
    return null;
  }
  const who = (X, id) => X.s.player(String(id || ''));
  const hostOf = (X) => X.s.player(X.s.state.hostId) || X.s.player('me');
  const nextIdx = (st) => (st.phase === 'race' ? st.raceNo + 1 : st.raceNo);

  const CMDS = {
    stats: (c, X) => hostStats(X),
    endRace(c, X) {
      if (!X.sim || X.sim.phase === 'done') return 'No race is running.';
      X.sim.end();
      return 'Race ended: results follow.';
    },
    skipCd(c, X) {
      if (!X.sim || X.sim.phase !== 'grid') return 'Not on the starting grid.';
      if (X.race) X.race.holdT = 1e9; // stop waiting for slow loaders too
      X.sim.hold = false;
      X.sim.countdown = Math.min(X.sim.countdown, 0.05);
      return 'Lights out!';
    },
    advance(c, X) {
      const ph = X.s.state.phase;
      if (ph === 'race') return 'During a race, use End race.';
      if (ph === 'final') return 'The session is over.';
      X.s.on_start(hostOf(X)); // the host's big button: skips this phase's timer
      return 'Moved on from ' + ph + '.';
    },
    // Give or take a skin. It lands on the driver's session garage now, and
    // their own device remembers it so it is still theirs next time.
    skin(c, X) {
      const P = G.Parts, id = String(c.id || '');
      if (!P.SKINS[id]) return 'Unknown skin.';
      const p = X.s.player(String(c.pid || ''));
      if (!p) return 'No such driver.';
      const g = p.garage;
      g.skins = Array.isArray(g.skins) ? g.skins : [];
      const car = P.CARS[P.SKINS[id].car].name;
      if (c.take) {
        g.skins = g.skins.filter((x) => x !== id);
        if (g.look.skin === id) g.look.skin = 'none';
        X.s.emit('toPlayer', p.id, { t: 'skin', id, take: 1 });
        return `Took ${P.SKINS[id].name} from ${p.name}.`;
      }
      if (!g.skins.includes(id)) g.skins.push(id);
      // ...and send them a signed copy so it is still theirs tomorrow.
      Ops.signGrant(id, p.name).then((tok) => X.s.emit('toPlayer', p.id, { t: 'skin', id, tok }));
      X.s.toast(p.id, `Unlocked: ${P.SKINS[id].name} for the ${car}. Fit it in Tune & paint.`, 'money');
      return `Gave ${P.SKINS[id].name} to ${p.name}.`;
    },

    nextTrack(c, X) {
      const st = X.s.state, def = G.TrackDefs.byId(String(c.id));
      if (!def || def.id === 'proving') return 'Unknown track.';
      const i = nextIdx(st);
      if (!st.schedule || i >= st.schedule.length) return 'Works once the session has started (and a race is left).';
      st.schedule[i] = def.id;
      return 'Next race: ' + def.name + '.';
    },
    kick(c, X, from) {
      const t = who(X, c.pid);
      if (!t || t.isBot) return 'No such driver.';
      if (t.id === X.s.state.hostId) return "Can't remove the host.";
      if (t.id === from) return "That's you.";
      X.s.on_kick(hostOf(X), { pid: t.id }); // bans their seat token for this room too
      return t.name + ' removed (and banned from this room).';
    },
    unban(c, X) {
      const n = (X.s.state.banned || []).length;
      X.s.state.banned = [];
      return n + ' ban(s) cleared.';
    },
    mute(c, X) {
      const t = who(X, c.pid);
      if (!t) return 'No such driver.';
      const m = (X.s._opsMuted = X.s._opsMuted || new Set());
      if (m.has(t.id)) {
        m.delete(t.id);
        return t.name + ' can chat again.';
      }
      m.add(t.id);
      return t.name + ' is muted.';
    },
    respawn(c, X) {
      const car = X.sim && X.sim.byId[String(c.pid)];
      if (!car || X.sim.phase === 'done') return 'Not in a running race.';
      X.sim.respawn(car);
      return 'Respawned.';
    },
    money(c, X) {
      const t = who(X, c.pid), v = Math.round(+c.v);
      if (!t || !isFinite(v)) return 'No such driver.';
      t.money = U.clamp(c.set ? v : t.money + v, 0, 10000000);
      return `${t.name}: ${U.fmtMoney(t.money)}.`;
    },
    giveCar(c, X) {
      const t = who(X, c.pid), car = G.Parts.CARS[String(c.car)];
      if (!t || !car) return 'No such driver or car.';
      G.Parts.fixGarage(t.garage);
      if (!t.garage.cars.includes(car.id)) t.garage.cars.push(car.id);
      return `${t.name} owns the ${car.name} (switch in the garage).`;
    },
    giveParts(c, X) {
      const t = who(X, c.pid);
      if (!t) return 'No such driver.';
      for (const sl of G.Parts.SLOTS) {
        const own = t.garage.owned[sl.id] || (t.garage.owned[sl.id] = []);
        for (const o of sl.options) if (!own.includes(o.id)) own.push(o.id);
      }
      return `${t.name} owns every part (fit them in the garage).`;
    },
    repair(c, X) {
      const t = who(X, c.pid);
      if (!t) return 'No such driver.';
      t.garage.wear.tyre = t.garage.wear.engine = t.garage.wear.body = 0;
      return `${t.name}'s car is like new.`;
    },
    bots(c, X) {
      if (X.s.state.phase === 'race') return 'Bots change between races.';
      X.s.on_settings(hostOf(X), { bots: +c.n });
      return 'Bots: ' + X.s.state.settings.bots + '.';
    },
    botSkill(c, X) {
      if (!G.BotKit.LEVELS[c.v]) return 'Unknown level.';
      X.s.on_settings(hostOf(X), { botLevel: c.v });
      return `Bots: ${G.BotKit.LEVELS[c.v].name} (from the next race).`;
    },
    vis(c, X) {
      X.s.on_settings(hostOf(X), { vis: c.v === 'public' ? 'public' : 'private' });
      return 'The room is ' + X.s.state.settings.vis + '.';
    },
    max(c, X) {
      X.s.on_settings(hostOf(X), { maxPlayers: +c.n });
      return 'Max drivers: ' + X.s.state.settings.maxPlayers + '.';
    },
    extend(c, X) {
      X.s.lastActive = Date.now();
      if (X.s.state.phase === 'lobby') X.s.state.lobbySince = Date.now();
      G.Game._idleWarned = null;
      return 'Idle timers reset.';
    },
    close() {
      if (G.Game.role !== 'host') return 'Only in a room.';
      setTimeout(() => G.Game.closeRoom('An admin closed the room.'), 300); // (the reply goes out first)
      return 'Closing the room…';
    },
    // v5.5.7 the lobby's catch-up and weather, from here (from the next race)
    roomSet(c, X) {
      const st = X.s.state;
      if (c.catchup != null && String(c.catchup).trim() !== '') {
        const p = G.Settings.cuPct(c.catchup);
        if (p == null || +c.catchup > 100) return 'Catch-up: a number from 0 to 100.';
        st.settings.catchup = p;
      }
      if (c.weather && G.RaceEnv.MODES.includes(c.weather)) st.settings.weather = c.weather;
      return `Catch-up ${G.Settings.cuLabel(st.settings.catchup)}, ${st.settings.weather || 'auto'} weather (from the next race).`;
    },
    // v5.5.7 the bot editor: c.pid and whatever one section changed
    bot(c, X) {
      const t = who(X, c.pid);
      if (!t || !t.isBot) return 'No such bot.';
      const K = G.BotKit, P = G.Parts, g = t.garage, done = [];
      P.fixGarage(g);
      if (c.name != null) {
        const n = String(c.name).replace(/⚙/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
        if (n) {
          t.name = n + ' ⚙';
          done.push('name');
        }
      }
      if (c.style && K.STYLES[c.style]) {
        t.botStyle = c.style;
        done.push('style');
      }
      if (c.level != null) {
        t.botLevel = K.LEVELS[c.level] ? c.level : null; // '' = the room's level
        if (c.skill == null) t.botSkill = K.skillFor(t.botLevel || X.s.state.settings.botLevel || 'normal');
        done.push('level');
      }
      if (c.skill != null && String(c.skill).trim() !== '' && isFinite(+c.skill)) {
        t.botSkill = +U.clamp(+c.skill, 0.6, 1.1).toFixed(3);
        t.botLock = true; // (a room-wide level change would undo it otherwise)
        done.push('skill ' + t.botSkill);
      }
      if (c.car && P.CARS[c.car]) {
        if (!g.cars.includes(c.car)) g.cars.push(c.car);
        t.carId = g.carId = c.car;
        for (const sl of P.SLOTS) if (!P.optAllowed(c.car, sl.id, g.installed[sl.id])) g.installed[sl.id] = P.STOCK[sl.id]; // parts that don't fit it come off
        done.push(P.CARS[c.car].name);
      }
      const fit = (slot, id) => {
        if (!P.optAllowed(t.carId, slot, id)) return false;
        if (!g.owned[slot].includes(id)) g.owned[slot].push(id);
        g.installed[slot] = id;
        return true;
      };
      if (c.parts && typeof c.parts === 'object') {
        let n = 0;
        for (const sl of P.SLOTS) if (c.parts[sl.id] != null && fit(sl.id, String(c.parts[sl.id]))) n++;
        if (n) {
          t.botLock = true;
          done.push(n + ' part' + (n === 1 ? '' : 's'));
        }
      }
      if (c.preset) {
        for (const sl of P.SLOTS) {
          const legal = sl.options.filter((o) => P.optAllowed(t.carId, sl.id, o.id));
          if (c.preset === 'stock') fit(sl.id, P.STOCK[sl.id]);
          else if (c.preset === 'max' && legal.length) fit(sl.id, legal[legal.length - 1].id);
        }
        if (c.preset === 'style') {
          for (const sl of P.SLOTS) fit(sl.id, P.STOCK[sl.id]);
          const lv = K.level(t.botLevel || X.s.state.settings.botLevel);
          const b = K.parts(t.botStyle || 'allround', lv.budget || 2200, Math.random, t.carId);
          for (const s in b.parts) fit(s, b.parts[s]);
        }
        t.botLock = c.preset !== 'style' || t.botLock;
        done.push({ stock: 'stock parts', max: 'every best part', style: 'a new ' + (K.STYLE_NAMES[t.botStyle] || 'all-round') + ' build' }[c.preset] || 'parts');
      }
      if (c.sound && typeof c.sound === 'object') {
        const s = {};
        for (const k of P.SOUND_KEYS) if (c.sound[k] != null) s[k] = String(c.sound[k]);
        g.look = P.cleanLook(g.look, s, t.carId, g.skins);
        done.push('sound');
      }
      if (c.look && typeof c.look === 'object') {
        const l = {};
        for (const k of ['paint', 'accent', 'livery', 'rims', 'kit', 'spoiler', 'num', 'finish']) if (k in c.look) l[k] = c.look[k];
        g.look = P.cleanLook(g.look, l, t.carId, g.skins);
        done.push('looks');
      }
      if (c.reroll === 'look') {
        g.look = P.cleanLook(g.look, K.look(), t.carId, g.skins);
        done.push('new looks');
      } else if (c.reroll === 'sound') {
        g.look = P.cleanLook(g.look, K.sound(t.botStyle), t.carId, g.skins);
        done.push('a new sound');
      } else if (c.reroll === 'traits') {
        t.botTraits = K.traits();
        done.push('new habits');
      }
      if (c.traits && typeof c.traits === 'object') {
        const T = c.traits, n = (v, lo, hi, d) => (isFinite(+v) ? U.clamp(+v, lo, hi) : d);
        t.botTraits = { brake: n(T.brake, -0.04, 0.04, 0), line: n(T.line, -0.4, 0.4, 0), mistake: n(T.mistake, 0.2, 3, 1), rival: ['on', 'off'].includes(T.rival) ? T.rival : 'auto' };
        done.push('habits');
      }
      if (c.lock != null) {
        t.botLock = !!c.lock;
        done.push(t.botLock ? 'build kept' : 'shops again');
      }
      if (!done.length) return 'Nothing changed.';
      return `${t.name.replace(' ⚙', '')}: ${done.join(', ')}${X.s.state.phase === 'race' ? ' (from the next race)' : ''}.`;
    },
    botAdd(c, X) {
      const st = X.s.state;
      if (st.phase === 'race') return 'Bots join between races.';
      if (X.s.bots().length + X.s.humans().length >= 8) return 'The grid is full (8 cars).';
      X.s.on_settings(hostOf(X), { bots: (st.settings.bots || 0) + 1 });
      const b = X.s.bots().slice(-1)[0];
      return b ? `${b.name.replace(' ⚙', '')} joined.` : 'No room for a bot.';
    },
    botDel(c, X) {
      const t = who(X, c.pid), st = X.s.state;
      if (!t || !t.isBot) return 'No such bot.';
      if (st.phase === 'race') return 'Bots leave between races.';
      delete st.players[t.id];
      st.order = st.order.filter((x) => x !== t.id);
      st.settings.bots = Math.max(0, (st.settings.bots || 0) - 1);
      return `${t.name.replace(' ⚙', '')} left.`;
    },
    announce(c, X) {
      const text = String(c.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      if (!text) return 'Type a message first.';
      X.s.sys('📢 ' + text, 'notify');
      if (G.Game.role === 'host' && G.Game.net) G.Game.net.broadcastCtrl({ t: 'ops_ann', text });
      Ops.banner(text);
      return 'Announced.';
    },
  };

  // The room as its host sees it (the Room / Drivers tabs; sent to a remote admin).
  function hostStats(X) {
    const s = X.s, st = s.state, now = Date.now();
    const net = G.Game.role === 'host' ? G.Game.net : null;
    return {
      code: G.Game.role === 'host' ? G.Game.code : null, epoch: st.epoch || 0, phase: st.phase, raceNo: st.raceNo || 0, races: st.settings.races,
      vis: st.settings.vis, max: st.settings.maxPlayers || 8, bots: st.settings.bots || 0, next: (st.schedule || [])[nextIdx(st)] || null,
      idle: Math.round((now - (s.lastActive || now)) / 1000), lobby: st.phase === 'lobby' ? Math.round((now - (st.lobbySince || st.createdAt || now)) / 1000) : 0,
      banned: (st.banned || []).length,
      cu: G.Settings.cuPct(st.settings.catchup) == null ? 10 : G.Settings.cuPct(st.settings.catchup), wx: st.settings.weather || 'auto', lvl: st.settings.botLevel || 'normal',
      players: (st.order || Object.keys(st.players)).map((id) => st.players[id]).filter(Boolean).map((p) => {
        const L = net && net.byPid ? net.byPid.get(p.id) : null;
        return {
          id: p.id, name: p.name, bot: !!p.isBot, on: !!(p.isBot || p.connected || p.id === st.hostId || p.id === 'me'), host: p.id === st.hostId,
          money: p.money, car: p.carId, w: (p.stats && p.stats.wins) || 0, pod: (p.stats && p.stats.podiums) || 0, r: (p.stats && p.stats.races) || 0,
          rtt: L ? Math.round(L.rtt || 0) : null, via: L ? (L.ctrl && L.ctrl.route ? 'relay' : 'direct') : null,
          muted: !!(s._opsMuted && s._opsMuted.has(p.id)), color: p.color,
          // v5.5.7 what the Bots tab edits
          b: p.isBot ? { style: p.botStyle || 'allround', level: p.botLevel || null, skill: p.botSkill, lock: !!p.botLock, traits: p.botTraits || null,
            parts: Object.assign({}, p.garage.installed), look: Object.fromEntries(['paint', 'accent', 'livery', 'rims', 'kit', 'spoiler', 'num', 'finish', 'tone', 'over', 'bov', 'idle', 'lim'].map((k) => [k, p.garage.look[k]])) } : undefined,
        };
      }),
      race: X.sim ? { phase: X.sim.phase } : null,
    };
  }

  function exec(c, from) {
    const X = ctx();
    if (!X || !X.s) return 'Not available here.';
    const f = Object.prototype.hasOwnProperty.call(CMDS, c.k) ? CMDS[c.k] : null;
    if (!f) return 'Unknown command.';
    try {
      const r = f(c, X, from);
      X.s.touch();
      return r;
    } catch (e) {
      return 'Failed: ' + e.message;
    }
  }

  // ------------------------------------------- host side (every copy of the game)
  const HS = G.HostSession.prototype;
  const toPid = (pid, msg) => {
    const n = G.Game.role === 'host' && G.Game.net;
    if (n) n.sendCtrl(pid, msg);
  };
  // A joiner asks for a one-time number to sign commands with (anyone may ask:
  // it's worthless without the key).
  HS.on_ops_n = function (p) {
    if (!Ops.KEY || !subtle() || G.Game.role !== 'host') return;
    const n = b64(crypto.getRandomValues(new Uint8Array(16)));
    (this._ops = this._ops || {})[p.id] = { n, seq: 0, t: 0, k: 0 };
    toPid(p.id, { t: 'ops_n', n });
  };
  HS.on_ops_do = function (p, m) {
    if (G.Game.role !== 'host' || typeof m.c !== 'string' || typeof m.sig !== 'string' || typeof m.seq !== 'number' || m.c.length > 1000 || m.sig.length > 200) return;
    const o = this._ops && this._ops[p.id];
    if (!o) return toPid(p.id, { t: 'ops_r', seq: m.seq, ok: 0, r: 'nonce' });
    if (!(m.seq > o.seq)) return;
    const now = Date.now();
    if (now - o.t > 1000) {
      o.t = now;
      o.k = 0;
    }
    if (++o.k > 10) return; // each one costs a signature check
    verify(signed(G.Game.code, p.id, o.n, m.seq, m.c), m.sig).then((ok) => {
      if (!ok || !(m.seq > o.seq)) return toPid(p.id, { t: 'ops_r', seq: m.seq, ok: 0, r: 'Refused: bad signature.' });
      o.seq = m.seq;
      let c = null;
      try {
        c = JSON.parse(m.c);
      } catch (e) {}
      const r = c && typeof c === 'object' ? exec(c, p.id) : 'Bad command.';
      if (c && c.k !== 'stats') console.info('[ops]', p.name, c.k);
      toPid(p.id, { t: 'ops_r', seq: m.seq, ok: 1, r });
    });
  };
  const onChat = HS.on_chat;
  HS.on_chat = function (p, m) {
    if (this._opsMuted && this._opsMuted.has(p.id)) return;
    return onChat.call(this, p, m);
  };

  // What a host seals into its server-list card: enough to find anyone and join.
  function roomDetails(game, st) {
    const s = st.settings || {};
    return {
      v: 1, code: game.code, name: s.name || '', vis: s.vis || 'private', max: s.maxPlayers || 8, phase: st.phase, race: st.raceNo || 0, races: s.races || 0,
      track: (st.race && st.race.trackId) || (st.schedule || [])[st.raceNo] || null, since: st.createdAt || 0,
      p: (st.order || Object.keys(st.players)).map((id) => st.players[id]).filter(Boolean)
        .map((p) => [p.id, p.name, p.isBot ? 1 : 0, p.isBot || p.connected ? 1 : 0, p.money || 0, p.id === st.hostId ? 1 : 0, p.carId]),
    };
  }

  // ------------------------------------------------------------ room diary
  // A diary of the rooms THIS browser hosted or joined (when, how long, who,
  // what they raced), plus every room seen in the directory while unlocked.
  // It runs for everyone but is only written to disk on a computer where the
  // passphrase has been used: every other player's game still keeps nothing.
  const HKEY = 'ss.ops.hist', HON = 'ss.ops.on', BGKEY = 'ss.ops.bg';
  const Hist = {
    rooms: [], // oldest first
    seen: {}, // lid -> other rooms noticed on the server list
    // the roll-ups: who plays, when they play, and what they race
    people: {}, // name -> {first, last, n, ms, host, cars:{}, days:{}}
    days: {}, // YYYY-MM-DD -> {rooms, drivers:{}, races, peak, peakAt}
    tracks: {}, // trackId -> races finished
    cars: {}, // carId -> times a driver was seen in one
    hours: null, // 24 buckets: when rooms are busy, local time
    peak: { players: 0, at: 0, rooms: 0, roomsAt: 0 },
    cur: null,
    load() {
      const d = U.store.get(HKEY, null);
      if (d && Array.isArray(d.rooms)) {
        this.rooms = d.rooms;
        this.seen = d.seen || {};
        this.people = d.people || {};
        this.days = d.days || {};
        this.tracks = d.tracks || {};
        this.cars = d.cars || {};
        this.hours = Array.isArray(d.hours) && d.hours.length === 24 ? d.hours : null;
        this.peak = d.peak || this.peak;
      }
      if (!this.hours) this.hours = new Array(24).fill(0);
    },
    // ---- roll-ups. `name` is what the log is keyed on: a driver's id only
    // lasts as long as their session, but the name is what you recognise.
    day(now) {
      const d = new Date(now);
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      return this.days[k] || (this.days[k] = { rooms: 0, drivers: {}, races: 0, peak: 0, peakAt: 0 });
    },
    person(name, now) {
      name = String(name || '').slice(0, 24);
      if (!name) return null;
      const P = this.people[name] || (this.people[name] = { first: now, last: now, n: 0, ms: 0, host: 0, cars: {}, days: {} });
      P.last = now;
      const d = new Date(now);
      P.days[d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')] = 1;
      this.day(now).drivers[name] = 1;
      return P;
    },
    trim() {
      const cut = (obj, max, keyOf) => {
        const ids = Object.keys(obj);
        if (ids.length <= max) return;
        ids.sort((a, b) => keyOf(obj[a]) - keyOf(obj[b])).slice(0, ids.length - max).forEach((k) => delete obj[k]);
      };
      cut(this.people, 800, (x) => x.last || 0);
      cut(this.days, 400, (x) => 0); // (days are tiny; the sort key is the key itself)
      const dk = Object.keys(this.days).sort();
      while (dk.length > 400) delete this.days[dk.shift()];
    },
    kept() {
      return !!U.store.get(HON, 0);
    },
    save() {
      if (!this.kept()) return;
      this.trim();
      U.store.set(HKEY, {
        rooms: this.rooms.slice(-120), seen: this.seen, people: this.people,
        days: this.days, tracks: this.tracks, cars: this.cars, hours: this.hours, peak: this.peak,
      });
    },
    keep() {
      U.store.set(HON, 1);
      this.save();
    },
    clear() {
      this.rooms = [];
      this.seen = {};
      this.people = {};
      this.days = {};
      this.tracks = {};
      this.cars = {};
      this.hours = new Array(24).fill(0);
      this.peak = { players: 0, at: 0, rooms: 0, roomsAt: 0 };
      this.cur = null;
      U.store.del(HKEY);
    },
    end(now) {
      if (!this.cur) return;
      this.cur.t1 = now;
      for (const p of Object.values(this.cur.players)) p._t = 0;
      this.cur = null;
      this.save();
    },
    tick() {
      const g = G.Game, st = G.Client.state, now = Date.now();
      if (g.role && g.code) {
        const c0 = this.cur;
        if (!c0 || c0.code !== g.code || c0.role !== g.role) {
          // host migration carries the same room on under a new code
          if (c0 && !c0.t1 && st && c0.rid && st.rid === c0.rid) {
            c0.code = g.code;
            c0.role = g.role;
          } else {
            this.end(now);
            this.cur = { code: g.code, role: g.role, t0: now, players: {}, races: [] };
            this.rooms.push(this.cur);
            if (this.rooms.length > 120) this.rooms.shift();
          }
        }
        const c = this.cur;
        c.t1 = 0;
        if (st) {
          const s = st.settings || {};
          c.rid = st.rid || c.rid;
          c.name = s.name || c.name;
          c.vis = s.vis || c.vis;
          c.max = s.maxPlayers || c.max;
          c.bots = s.bots != null ? s.bots : c.bots;
          c.total = s.races || c.total;
          const h = st.players[st.hostId];
          if (h) c.host = h.name;
          for (const p of Object.values(st.players)) {
            const r = c.players[p.id] || (c.players[p.id] = { name: p.name, bot: !!p.isBot, first: now, ms: 0, _t: 0 });
            r.name = p.name;
            r.money = p.money;
            if (p.isBot || p.connected) {
              if (r._t) r.ms += now - r._t;
              r._t = now;
              r.last = now;
              if (!p.isBot) {
                const P = this.person(p.name, now);
                if (P) {
                  if (!c._counted) c._counted = {};
                  if (!c._counted[p.name]) {
                    c._counted[p.name] = 1;
                    P.n++;
                    if (p.id === st.hostId) P.host++;
                  }
                  if (r._t0) P.ms += now - r._t0;
                  r._t0 = now;
                  if (p.carId) P.cars[p.carId] = (P.cars[p.carId] || 0) + 1;
                }
              }
            } else {
              r._t = 0;
              r._t0 = 0;
            }
          }
          if (st.results && st.results.no !== c.lastRes) {
            c.lastRes = st.results.no;
            const w = (st.results.rows || [])[0];
            c.races.push({ no: st.results.no, track: st.results.trackId, winner: w ? w.name : '?', at: now });
            if (st.results.trackId) this.tracks[st.results.trackId] = (this.tracks[st.results.trackId] || 0) + 1;
            this.day(now).races++;
          }
          if (st.final && !c.final) c.final = (st.final.rows || []).slice(0, 8).map((r) => ({ name: r.name, worth: r.worth }));
        }
      } else if (this.cur) this.end(now);
      // other rooms: the directory while unlocked, or the server-list screen
      const scr = G.UI.screens && G.UI.screens.rooms;
      const board = Ops.board || (scr && scr.board);
      if (board && board.list) {
        for (const r of board.list()) {
          if (!r.lid) continue;
          const fresh = !this.seen[r.lid];
          const s = this.seen[r.lid] || (this.seen[r.lid] = { first: now });
          if (fresh) {
            this.day(now).rooms++;
            this.hours[new Date(now).getHours()]++;
          }
          if (r.name) s.name = r.name;
          if (r.host) s.host = r.host;
          if (r.code) s.code = r.code;
          s.vis = r.vis;
          s.peak = Math.max(s.peak || 0, r.players || 0);
          s.last = now;
          const d = r.ops && Ops.dir.get(r.ops.ct);
          if (d && typeof d === 'object') {
            s.code = d.code;
            s.races = d.race;
            const names = s.drivers || (s.drivers = {});
            for (const p of d.p) {
              if (p[2]) continue; // a bot
              names[p[1]] = 1;
              const P = this.person(p[1], now);
              if (P) {
                if (!s._counted) s._counted = {};
                if (!s._counted[p[1]]) {
                  s._counted[p[1]] = 1;
                  P.n++;
                  if (p[5]) P.host++;
                }
                if (p[6]) {
                  P.cars[p[6]] = (P.cars[p[6]] || 0) + 1;
                  this.cars[p[6]] = (this.cars[p[6]] || 0) + 1;
                }
              }
            }
            if (d.track) this.tracks[d.track] = (this.tracks[d.track] || 0) + 1;
          }
        }
        // all-time peaks, and the busiest the server has been today
        let live = 0, rooms = 0;
        for (const r of board.list()) {
          live += r.players || 0;
          rooms++;
        }
        if (live > this.peak.players) {
          this.peak.players = live;
          this.peak.at = now;
        }
        if (rooms > this.peak.rooms) {
          this.peak.rooms = rooms;
          this.peak.roomsAt = now;
        }
        const D = this.day(now);
        if (live > D.peak) {
          D.peak = live;
          D.peakAt = now;
        }
        const ids = Object.keys(this.seen);
        if (ids.length > 400) ids.sort((a, b) => (this.seen[a].last || 0) - (this.seen[b].last || 0)).slice(0, ids.length - 400).forEach((k) => delete this.seen[k]);
      }
      if (now - (this._saveT || 0) > 10000) {
        this._saveT = now;
        this.save();
      }
    },
  };

  // ------------------------------------------------------------------ panel
  // [id, icon, name]
  // v5.5.7: labelled tabs, in two rows (the old row of eight emoji was guesswork)
  const TABS = [['dir', 'globe', 'Rooms'], ['room', 'checker', 'Room'], ['players', 'users', 'Drivers'], ['bots', 'bot', 'Bots'], ['stats', 'gauge', 'Stats'], ['data', 'chart-column', 'Activity'], ['hist', 'history', 'History'], ['debug', 'terminal', 'Tools'], ['log', 'scroll-text', 'Log'], ['notes', 'notebook-text', 'Changes']];
  const ic = (n) => G.ic(n);
  const PHASES = { lobby: 'Lobby', carselect: 'Picking cars', entry: 'Entry', betting: 'Betting', race: 'Racing', results: 'Results', intermission: 'Garage break', final: 'Finished' };
  const enc64 = (a) => encodeURIComponent(JSON.stringify(a || {}));
  const btn = (k, label, cls, a) => `<button class="btn small ${cls || ''}" data-o="cmd" data-k="${k}" data-a="${enc64(a)}">${label}</button>`;
  const btnL = (k, label, cls, a) => `<button class="btn small ${cls || ''}" data-o="loc" data-k="${k}" data-a="${enc64(a)}">${label}</button>`;
  const kv = (rows) => '<div class="kv">' + rows.filter(Boolean).map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('') + '</div>';
  const pct = (v, d) => ((v || 0) * 100).toFixed(d || 0) + '%';
  const trackName = (id) => {
    const t = id && G.TrackDefs.byId(id);
    return t ? U.esc(t.name) : '—';
  };
  const carName = (id) => (G.Parts.CARS[id] ? U.esc(G.Parts.CARS[id].name) : '');
  const fmtSecs = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  };
  const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function myRs() {
    const g = G.Game;
    if (G.App.mode === 'drive' && G.App.sim && G.App.sim.byId.me) return G.App.sim.byId.me.st;
    if (g.hostRace && g.hostRace.sim.byId[g.myPid]) return g.hostRace.sim.byId[g.myPid].st;
    return g.lastView && g.lastView.me ? g.lastView.me.rs : null;
  }

  // --- All rooms (the directory)
  function dirControls(O) {
    return `<div class="row"><input data-f="q" placeholder="Find a room, code or driver" value="${U.esc(O.q || '')}" class="grow"></div>
      <div class="row"><input data-f="annAll" maxlength="140" placeholder="Message to every room" class="grow">${btnL('dirAnnAll', 'Send', 'primary')}</div>
      <div class="row"><label class="tog"><input type="checkbox" data-o="alerts"${O.alerts ? ' checked' : ''}><span></span>Alert me when a room opens</label></div>`;
  }
  function dirList(O) {
    if (!O.dh) return "<p class=\"note\">This browser can't open room details with your key.</p>";
    const b = O.board;
    if (!b) return '<p class="note">Connecting to the room servers…</p>';
    const q = (O.q || '').trim().toLowerCase();
    const rooms = b.list().map((r) => ({ r, d: r.ops ? O.dir.get(r.ops.ct) : null }));
    const online = rooms.reduce((a, x) => a + (x.r.players || 0), 0);
    const hit = (v) => v && String(v).toLowerCase().includes(q);
    const shown = !q ? rooms : rooms.filter(({ r, d }) => hit(r.name) || hit(r.host) || hit(r.code) || (d && typeof d === 'object' && (hit(d.code) || d.p.some((p) => hit(p[1])))));
    let h = `<p class="note">${rooms.length} room${rooms.length === 1 ? '' : 's'} · ${online} driver${online === 1 ? '' : 's'} online${b.reached() ? '' : ' · no room server reached yet'}${q ? ` · ${shown.length} match` : ''}</p>`;
    if (!shown.length) return h + `<p class="note">${rooms.length ? 'Nothing matches.' : 'No rooms open right now.'}</p>`;
    for (const { r, d } of shown) {
      const det = d && typeof d === 'object' ? d : null;
      const code = det ? det.code : r.code;
      const open = O.rsel === r.lid;
      h += `<div class="dr${open ? ' sel' : ''}" data-o="loc" data-k="rsel" data-a="${enc64({ v: r.lid })}"><span>${ic(r.vis === 'public' ? 'globe' : 'lock')} ${U.esc(r.name)}</span><code>${code ? U.esc(code) : '·····'}</code><em>${r.players}/${r.max}${r.bots ? ' +' + r.bots + '⚙' : ''}</em></div>`;
      if (!open) continue;
      const now = PHASES[r.phase] || r.phase;
      let body = kv([
        ['Host', U.esc(r.host || '—')],
        ['Now', `${U.esc(now)}${r.races ? ` · race ${Math.min(r.race + (r.phase === 'race' ? 1 : 0), r.races)}/${r.races}` : ''}${det && det.track ? ' · ' + trackName(det.track) : ''}`],
        det && det.since ? ['Open for', fmtSecs(Date.now() - det.since)] : null,
        ['Version', U.esc(r.ver || '?')],
      ]);
      if (det)
        body += '<div class="dps">' + det.p
            .map(([id, name, bot, on, money, host, car]) => `<div class="dp${on ? '' : ' off'}"><span title="${carName(car)}">${host ? ic('crown') + ' ' : bot ? ic('bot') + ' ' : ''}${U.esc(String(name).replace(' ⚙', ''))}</span><b>${U.fmtMoney(money)}</b>${bot || host ? '<i></i>' : `<button class="op-mini" data-o="loc" data-k="dirKick" data-a="${enc64({ lid: r.lid, pid: id, name })}" title="Remove from the room">${ic('x')}</button>`}</div>`)
            .join('') + '</div>';
      else body += `<p class="note">${d === 'bad' ? "Couldn't open this room's details." : r.ops ? 'Opening…' : 'No details: this room runs an older version.'}</p>`;
      body += `<div class="row">${code ? btnL('dirJoin', 'Join', 'primary', { code, name: r.name }) + btnL('dirCopy', 'Copy code', 'ghost', { code }) : ''}${det ? btnL('dirAnn', 'Announce', 'ghost', { lid: r.lid, name: r.name }) + btnL('dirClose', 'Close', 'red', { lid: r.lid, name: r.name }) : ''}</div>`;
      h += `<div class="dd">${body}</div>`;
    }
    return h;
  }

  function statsHtml() {
    const w = G.App.world, ws = w ? w.stats() : null, g = G.Game, st = G.Client.state, A = G.Audio;
    const z = getComputedStyle(document.documentElement).getPropertyValue('--uiz').trim() || '1';
    let h = '<h4>Performance</h4>' + kv([
      ['Frame rate', ws ? `${ws.fps.toFixed(0)} fps · ${ws.ms.toFixed(1)} ms` : '—'],
      ['Drawing', ws ? `${ws.calls} calls · ${(ws.tris / 1000).toFixed(0)}k tris · ${ws.parts} fx` : '—'],
      ['Quality', ws ? `${ws.tier} · level ${ws.level} · ${ws.pr.toFixed(2)}×` : '—'],
      ['GPU', ws ? U.esc(String(ws.gpu || '?').replace(/^ANGLE \(/, '').slice(0, 48)) : '—'],
      ['JS heap', performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB' : '—'],
      ['Screen', `${innerWidth}×${innerHeight} · menus ${(+z).toFixed(2)}× · HUD ${((G.App.hud && G.App.hud.z) || 1).toFixed(2)}×`],
      ['Audio', A && A.ctx ? `${A.ctx.state} · ${A.others.length} car voices` : 'off'],
    ]);
    const net = g.net, rows = [['Role', g.role ? (g.role === 'host' ? 'host' : 'joiner') + (g.code ? ` · <code>${U.esc(g.code)}</code> ` + btnL('copyCode', 'Copy', 'ghost') : '') : 'solo']];
    if (g.role === 'client' && net) rows.push(['Link', `${net.via || '?'} · ping ${Math.round(net.rtt || 0)} ms`]);
    if (g.role === 'host' && net && net.byPid) {
      const ls = Array.from(net.byPid.values());
      const relay = ls.filter((L) => L.ctrl && L.ctrl.route).length;
      rows.push(['Links', `${ls.length} (${relay} relay) · avg ${ls.length ? Math.round(ls.reduce((a, L) => a + (L.rtt || 0), 0) / ls.length) : 0} ms`]);
    }
    if (g.clientRace) {
      const s = g.clientRace.stats;
      rows.push(['Snapshots', `${s.snaps} in · ${s.snapsDropped} late`], ['Prediction', `err ${s.lastErr.toFixed(2)} m · ${s.corrections} fixes`]);
    }
    if (g.hostRace) rows.push(['Snapshots', `${g.hostRace.stats.snaps} sent`]);
    if (G.NetStat) rows.push(['Weak-link skips', String(G.NetStat.skipped)]);
    const sn = G.NetSim;
    if (sn && (sn.lag || sn.jitter || sn.loss || sn.forceRelay)) rows.push(['Simulating', `${sn.lag} ms ±${sn.jitter} · ${pct(sn.loss)} loss${sn.forceRelay ? ' · relay' : ''}`]);
    h += '<h4>Network</h4>' + kv(rows);
    if (st && g.role) {
      const hs = Object.values(st.players).filter((p) => !p.isBot);
      const left = st.phaseEnds ? Math.max(0, Math.round((st.phaseEnds - G.Client.hostNow()) / 1000)) : 0;
      const X = ctx(), H = X && X.s && g.role === 'host' ? hostStats(X) : null;
      h += '<h4>Session</h4>' + kv([
        ['Phase', (PHASES[st.phase] || st.phase) + (left ? ` · ${left} s left` : '')],
        ['Races', `${st.raceNo || 0}/${st.settings.races} · next ${trackName((st.schedule || [])[nextIdx(st)])}`],
        ['Drivers', `${hs.filter((p) => p.connected).length}/${hs.length} online · ${Object.keys(st.players).length - hs.length} bots`],
        ['Next hosts', (st.heirs || []).map((id) => (st.players[id] ? U.esc(st.players[id].name) : id)).join(', ') || '—'],
        H && ['Idle', `${H.idle} s${H.lobby ? ` · lobby ${H.lobby} s` : ''}`],
      ]);
    }
    const rs = myRs();
    if (rs) {
      const sp = Math.hypot(rs.vx || 0, rs.vz || 0);
      h += '<h4>My car</h4>' + kv([
        ['Speed', `${(sp * 3.6).toFixed(0)} km/h · ${pct(rs.rpm)} revs · gear ${rs.gear}`],
        ['Wheel slip', (rs.slip || []).map((v) => (+v).toFixed(2)).join(' · ') || '—'],
        ['Surface', (rs.surf || []).map((i) => (G.SURF[i] || {}).id || '?').join(' · ') || '—'],
        ['Slipstream', `${((rs.draft || 0) * 45).toFixed(0)}% less drag · catch-up +${pct(rs.cu)}`],
        ['Boost · heat', `${pct(rs.boost)} · ${pct(rs.heat)}${rs.nos != null ? ' · N2O ' + pct(rs.nos) : ''}`],
        ['Wear', `tyres ${pct(rs.tyreWear, 1)} · engine ${pct(rs.engineWear, 1)} · body ${pct(rs.body, 1)}`],
      ]);
    }
    return h;
  }

  function roomHtml(O, S) {
    const g = G.Game, X = ctx();
    let h = `<h4>Race</h4><div class="row">${btn('endRace', ic('checker') + ' End race')}${btn('skipCd', ic('traffic-cone') + ' Skip countdown', 'ghost')}${g.role ? btn('advance', ic('skip-forward') + ' Skip phase', 'ghost') : ''}</div>`;
    if (!g.role) return h + `<p class="note">${X && X.sim ? 'Practice: these act on your drive.' : 'These work in a room you host or join. To act on any room without joining, use the Rooms tab.'}</p>`;
    if (!S) return h + `<p class="note">${O.remoteErr ? U.esc(O.remoteErr) : 'Asking the host…'}</p>`;
    h += `<div class="row"><span class="lbl">Next track</span><select data-f="track" class="grow">${G.TrackDefs.TRACKS.map((t) => `<option value="${t.id}"${S.next === t.id ? ' selected' : ''}>${U.esc(t.name)}</option>`).join('')}</select>${btn('nextTrack', 'Set', 'ghost')}</div>`;
    h += '<h4>Room</h4>';
    h += `<div class="seg">${btn('vis', ic('lock') + ' Private', S.vis === 'public' ? 'ghost' : 'on', { v: 'private' })}${btn('vis', ic('globe') + ' Public', S.vis === 'public' ? 'on' : 'ghost', { v: 'public' })}</div>`;
    h += `<div class="grid2"><div class="stp"><span>Max drivers</span>${btn('max', '−', 'ghost', { n: S.max - 1 })}<b class="num">${S.max}</b>${btn('max', '+', 'ghost', { n: S.max + 1 })}</div>
      <div class="stp"><span>Bots</span>${btn('bots', '−', 'ghost', { n: S.bots - 1 })}<b class="num">${S.bots}</b>${btn('bots', '+', 'ghost', { n: S.bots + 1 })}</div></div>`;
    h += `<div class="row"><span class="lbl">Bot level</span><select data-f="skill" data-k="botSkill" data-auto="1" class="grow">${G.BotKit.LEVEL_ORDER.map((k) => `<option value="${k}"${k === S.lvl ? ' selected' : ''}>${G.BotKit.LEVELS[k].name}</option>`).join('')}</select></div>`;
    h += `<div class="row"><span class="lbl">Catch-up</span><input data-f="cu" type="number" min="0" max="100" step="1" value="${S.cu}" class="w52"><span class="note">%</span><select data-f="wx" class="grow">${[['auto', 'Changeable weather'], ['dry', 'Always dry'], ['rain', 'Rain']].map(([k, l]) => `<option value="${k}"${k === S.wx ? ' selected' : ''}>${l}</option>`).join('')}</select>${btn('roomSet', 'Set', 'ghost')}</div>`;
    h += `<div class="row">${btn('extend', ic('hourglass') + ' Reset idle', 'ghost')}${btn('unban', `Clear bans (${S.banned})`, 'ghost')}${btn('close', ic('x') + ' Close room', 'red')}</div>`;
    h += `<h4>Announce</h4><div class="row"><input data-f="ann" maxlength="140" placeholder="A message on everyone's screen" class="grow">${btn('announce', ic('megaphone') + ' Send', 'primary')}</div>`;
    return h;
  }

  function playersHtml(O, S) {
    if (!S) return `<p class="note">${O.remoteErr ? U.esc(O.remoteErr) : G.Game.role ? 'Asking the host…' : 'Nobody here.'}</p>`;
    const rows = S.players
      .map((p) => `<div class="pl${O.sel === p.id ? ' sel' : ''}" data-o="sel" data-id="${U.esc(p.id)}"><span class="${p.on ? '' : 'off'}">${p.host ? ic('crown') + ' ' : p.bot ? ic('bot') + ' ' : ''}${U.esc(p.name.replace(' ⚙', ''))}${p.muted ? ' ' + ic('volume-x') : ''}</span><b>${U.fmtMoney(p.money)}</b><em>${p.bot ? 'bot' : !p.on ? 'offline' : p.rtt != null ? `${p.rtt} ms ${p.via}` : ''}</em></div>`)
      .join('');
    const t = S.players.find((p) => p.id === O.sel);
    let act = '<p class="note">Pick a driver.</p>';
    if (t) {
      const a = { pid: t.id }, s = { s: t.id };
      act = `<h4>${U.esc(t.name.replace(' ⚙', ''))}</h4><p class="note">${carName(t.car)} · ${t.w} win${t.w === 1 ? '' : 's'}, ${t.pod} podium${t.pod === 1 ? '' : 's'} in ${t.r} race${t.r === 1 ? '' : 's'}</p>
        <div class="row"><span class="lbl">Money</span>${btn('money', '+$1k', 'ghost', { pid: t.id, v: 1000 })}${btn('money', '+$10k', 'ghost', { pid: t.id, v: 10000 })}${btn('money', '−$1k', 'ghost', { pid: t.id, v: -1000 })}<input data-f="money" data-s="${U.esc(t.id)}" type="number" min="0" step="100" placeholder="$" class="w72">${btn('moneySet', 'Set', 'ghost', a)}</div>
        <div class="row"><span class="lbl">Car</span><select data-f="car" data-s="${U.esc(t.id)}" class="grow">${G.Parts.CAR_ORDER.map((id) => `<option value="${id}"${id === t.car ? ' selected' : ''}>${U.esc(G.Parts.CARS[id].name)}</option>`).join('')}</select>${btn('giveCar', 'Give', 'ghost', a)}</div>
        <div class="row">${btn('giveParts', ic('cog') + ' All parts', 'ghost', a)}${btn('repair', ic('wrench') + ' Repair', 'ghost', a)}${btn('respawn', ic('refresh-cw') + ' Respawn', 'ghost', a)}</div>
        <div class="row">${t.bot ? btnL('toBots', ic('bot') + ' Edit this bot →', '', a) : btn('mute', ic(t.muted ? 'volume-2' : 'volume-x') + (t.muted ? ' Unmute' : ' Mute'), 'ghost', a) + (t.host ? '' : btn('kick', ic('ban') + ' Kick & ban', 'red', a))}</div>
        <div class="row"><span class="lbl">Skin</span><select data-f="skin" data-s="${U.esc(t.id)}" class="grow">${Object.values(G.Parts.SKINS).map((k) => `<option value="${k.id}">${U.esc(k.name)} · ${U.esc(G.Parts.CARS[k.car].name)}</option>`).join('')}</select>${btn('skin', 'Give', 'ghost', a)}${btn('skinTake', 'Take', 'ghost', a)}</div>`;
      void s;
    }
    return `<div class="pls">${rows}</div>${act}`;
  }

  // v5.5.7 Bots: every bot in the room, and everything about the one picked -
  // who it is and how good, its car and parts, how it sounds and looks, and
  // its habits at the wheel. Each section sends only its own changes.
  const BRAKE = [[-0.03, 'Much earlier'], [-0.015, 'Earlier'], [0, 'As its level'], [0.015, 'Later'], [0.03, 'Much later']];
  const LINE = [[-0.3, 'Much looser'], [-0.15, 'Looser'], [0, 'As its level'], [0.15, 'Tidier'], [0.3, 'Much tidier']];
  const MISTAKE = [[0.3, 'Almost never'], [0.6, 'Fewer'], [1, 'As its level'], [1.5, 'More'], [2.5, 'Lots']];
  const nearest = (list, v) => list.reduce((b, x) => (Math.abs(x[0] - v) < Math.abs(b[0] - v) ? x : b), list[0])[0];
  const colHex = (c) => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
  function botsHtml(O, S) {
    const K = G.BotKit, P = G.Parts;
    if (!G.Game.role) return '<p class="note">Bots are edited in a room you host or join (quick races make a new field every time).</p>';
    if (!S) return `<p class="note">${O.remoteErr ? U.esc(O.remoteErr) : 'Asking the host…'}</p>`;
    const bots = S.players.filter((p) => p.bot && p.b);
    let h = `<div class="row">${btn('botAdd', ic('user-plus') + ' Add a bot', '')}<span class="note">${bots.length} bot${bots.length === 1 ? '' : 's'} · room level ${U.esc(K.level(S.lvl).name)}</span></div>`;
    h += '<div class="pls">' + bots
        .map((p) => `<div class="pl${O.bsel === p.id ? ' sel' : ''}" data-o="bsel" data-id="${U.esc(p.id)}"><span><i class="dot" style="background:${colHex(p.color)}"></i>${U.esc(p.name.replace(' ⚙', ''))}${p.b.lock ? ' ' + ic('lock') : ''}</span><b>${carName(p.car)}</b><em>${U.esc(K.level(p.b.level || S.lvl).name)} ${(+p.b.skill || 0).toFixed(2)}</em></div>`)
        .join('') + '</div>';
    const t = bots.find((p) => p.id === O.bsel);
    if (!t) return h + `<p class="note">${bots.length ? 'Pick a bot to edit it.' : 'No bots in this room.'}</p>`;
    const b = t.b, a = { pid: t.id }, sc = `data-s="${U.esc(t.id)}"`, L = b.look || {}, T = Object.assign({ brake: 0, line: 0, mistake: 1, rival: 'auto' }, b.traits || {});
    const sel = (f, list, cur, cls) => `<select data-f="${f}" ${sc}${cls ? ` class="${cls}"` : ''}>${list.map(([v, l]) => `<option value="${U.esc(String(v))}"${String(v) === String(cur) ? ' selected' : ''}>${U.esc(l)}</option>`).join('')}</select>`;
    const sec = (d, title, body, open) => `<details data-d="${d}"${O.dOpen[d] != null ? (O.dOpen[d] ? ' open' : '') : open ? ' open' : ''}><summary>${title}</summary>${body}</details>`;
    const lvRange = K.level(b.level || S.lvl).skill;
    h += `<h4>${U.esc(t.name.replace(' ⚙', ''))}</h4><p class="note">${U.esc(K.STYLE_NAMES[b.style] || 'All-rounder')} driver${K.traitText(b.traits) ? ' · ' + U.esc(K.traitText(b.traits)) : ''}${b.lock ? ' · build kept' : ''}</p>`;
    h += sec('who', ic('user') + ' Driver', `
      <div class="fg"><label>Name</label><input data-f="bName" ${sc} maxlength="16" value="${U.esc(t.name.replace(' ⚙', ''))}">
        <label>Style</label>${sel('bStyle', Object.keys(K.STYLES).map((k) => [k, K.STYLE_NAMES[k] || k]), b.style)}
        <label>Level</label>${sel('bLevel', [['', `Room level (${K.level(S.lvl).name})`]].concat(K.LEVEL_ORDER.map((k) => [k, K.LEVELS[k].name])), b.level || '')}
        <label>Skill</label><span><input data-f="bSkill" ${sc} type="number" min="0.6" max="1.1" step="0.01" value="${(+b.skill || 0).toFixed(2)}" class="w72"> <span class="note">its level: ${lvRange[0]}–${lvRange[1]}</span></span></div>
      <label class="tog"><input type="checkbox" data-f="bLock" ${sc}${b.lock ? ' checked' : ''}><span></span>Keep this build: no shopping between races, room level changes leave it alone</label>
      <div class="row">${btn('botWho', 'Apply', 'primary', a)}${btn('botDel', ic('trash-2') + ' Remove this bot', 'red', a)}</div>`, true);
    const slots = P.SLOTS.filter((s) => P.partAllowed(t.car, s.id));
    h += sec('parts', ic('cog') + ' Car and parts', `
      <div class="row"><span class="lbl">Car</span>${sel('bCar', P.CAR_ORDER.map((id) => [id, P.CARS[id].name]), t.car, 'grow')}${btn('botCar', 'Fit', 'ghost', a)}</div>
      <div class="fg">${slots.map((s) => `<label>${U.esc(s.name)}</label>${sel('bp-' + s.id, s.options.filter((o) => P.optAllowed(t.car, s.id, o.id)).map((o) => [o.id, o.name + (o.price ? ' · ' + U.fmtMoney(o.price) : '')]), (b.parts || {})[s.id] || P.STOCK[s.id])}`).join('')}</div>
      <div class="row">${btn('botParts', 'Fit parts', 'primary', a)}${btn('bot', 'Stock', 'ghost', { pid: t.id, preset: 'stock' })}${btn('bot', 'Best of everything', 'ghost', { pid: t.id, preset: 'max' })}${btn('bot', 'New style build', 'ghost', { pid: t.id, preset: 'style' })}</div>`);
    const SND = [['tone', 'Tone'], ['over', 'Overrun'], ['bov', 'Blow-off'], ['idle', 'Idle'], ['lim', 'Limiter']];
    const need = (k, v) => (P.soundAllowed(k, v, t.car, b.parts) ? '' : ' (needs parts)');
    h += sec('sound', ic('volume-2') + ' Sound', `
      <div class="fg">${SND.map(([k, l]) => `<label>${l}</label>${sel('bs-' + k, P.LOOK[k].map(([v, n]) => [v, n.split(' — ')[0] + need(k, v)]), L[k] || P.LOOK[k][0][0])}`).join('')}</div>
      <p class="note">A sound that needs a part (a straight pipe, a turbo) plays once the bot has it.</p>
      <div class="row">${btn('botSound', 'Set sound', 'primary', a)}${btn('bot', ic('shuffle') + ' Random', 'ghost', { pid: t.id, reroll: 'sound' })}</div>`);
    const LK = P.LOOK;
    h += sec('look', ic('palette') + ' Looks', `
      <div class="fg"><label>Paint</label><span><input type="color" data-f="bPaint" ${sc} value="${colHex(L.paint == null ? t.color : L.paint)}"> ${btn('bot', 'Team colour', 'ghost', { pid: t.id, look: { paint: null } })}</span>
        <label>Accent</label><input type="color" data-f="bAccent" ${sc} value="${colHex(L.accent == null ? 0xf5f5f5 : L.accent)}">
        <label>Livery</label>${sel('bLivery', LK.liveries, L.livery)}
        <label>Finish</label>${sel('bFinish', LK.finishes, L.finish)}
        <label>Wheels</label>${sel('bRims', LK.rims, L.rims)}
        <label>Body kit</label>${sel('bKit', LK.kits, L.kit)}
        <label>Spoiler</label>${sel('bSpoiler', LK.spoilers, L.spoiler)}
        <label>Number</label><input data-f="bNum" ${sc} type="number" min="0" max="99" value="${+L.num || 0}" class="w52"></div>
      <div class="row">${btn('botLook', 'Set looks', 'primary', a)}${btn('bot', ic('shuffle') + ' Random', 'ghost', { pid: t.id, reroll: 'look' })}</div>`);
    h += sec('habits', ic('steer') + ' Habits', `
      <div class="fg"><label>Braking</label>${sel('hBrake', BRAKE, nearest(BRAKE, T.brake))}
        <label>Lines</label>${sel('hLine', LINE, nearest(LINE, T.line))}
        <label>Mistakes</label>${sel('hMis', MISTAKE, nearest(MISTAKE, T.mistake))}
        <label>Rival</label>${sel('hRival', [['auto', 'Its level\'s odds'], ['on', 'Always hunts someone'], ['off', 'Never']], T.rival)}</div>
      <div class="row">${btn('botHabits', 'Set habits', 'primary', a)}${btn('bot', ic('shuffle') + ' Random', 'ghost', { pid: t.id, reroll: 'traits' })}</div>`);
    return h;
  }

  // v5.5.7 Changes: the whole changelog, public and hidden. The hidden half
  // (the console, skins, messages - what the public one leaves out) is
  // sealed for the maintainer's key like a room card: only an unlocked
  // console can read it.
  function notesHtml(O) {
    const hid = O.notes || {};
    let h = `<div class="row"><label class="tog"><input type="checkbox" data-o="hidOnly"${O.hidOnly ? ' checked' : ''}><span></span>Only what the public changelog leaves out</label></div>`;
    if (!O.notes) h += `<p class="note">${O.notesErr ? "The hidden notes didn't open with this key." : 'Opening the hidden notes…'}</p>`;
    for (const c of G.CHANGELOG) {
      const extra = hid[c.v] || [];
      if (O.hidOnly && !extra.length) continue;
      h += `<div class="nv"><h4>v${U.esc(c.v)} · ${U.esc(c.name)}</h4>`;
      h += extra.map(([t, d]) => `<div class="ni hid">${ic('lock')}<div><b>${U.esc(t)}</b><p>${U.esc(d)}</p></div></div>`).join('');
      if (!O.hidOnly) h += c.items.map(([e, t, d]) => `<div class="ni"><span>${G.Icon.fromEmoji(e)}</span><div><b>${U.esc(t)}</b><p>${U.esc(d)}</p></div></div>`).join('');
      h += '</div>';
    }
    return h;
  }

  function histHtml(O) {
    const now = Date.now();
    const rooms = Hist.rooms.slice().reverse();
    const sel = rooms.find((r) => r.t0 === O.hsel) || null;
    let h = `<div class="row">${btnL('histCopy', 'Copy all', 'ghost')}${btnL('histClear', 'Clear', 'ghost')}<span class="note">${Hist.kept() ? 'kept on this computer' : 'this visit only'}</span></div>`;
    h += `<h4>Your rooms (${rooms.length})</h4>`;
    if (!rooms.length) h += '<p class="note">Rooms you host or join show up here.</p>';
    else
      h += '<div class="pls">' + rooms
          .map((r) => `<div class="pl${sel && sel.t0 === r.t0 ? ' sel' : ''}" data-o="loc" data-k="histSel" data-a="${enc64({ v: r.t0 })}"><span>${r.role === 'host' ? ic('crown') + ' ' : ''}${U.esc(r.code || '?')}${r.name ? ' · ' + U.esc(r.name) : ''}</span><b>${Object.keys(r.players || {}).length}</b><em>${r.t1 ? fmtSecs(r.t1 - r.t0) : 'open'}</em></div>`)
          .join('') + '</div>';
    if (sel) {
      const ps = Object.values(sel.players || {}).sort((a, b) => (b.ms || 0) - (a.ms || 0));
      h += '<div class="dd">' + kv([
        ['Opened', when(sel.t0)],
        ['Lasted', fmtSecs((sel.t1 || now) - sel.t0) + (sel.t1 ? '' : ' · still open')],
        ['You were', sel.role === 'host' ? 'the host' : 'a driver'],
        ['Host', U.esc(sel.host || '—')],
        ['Room', `${sel.vis || '?'} · max ${sel.max || '?'} · ${sel.bots || 0} bots · ${sel.total || '?'} races`],
      ]);
      h += '<h4>Drivers</h4><div class="kv">' + ps.map((p) => `<span>${U.esc(p.name)}${p.bot ? ' ⚙' : ''}</span><b>${fmtSecs(p.ms || 0)} · ${U.fmtMoney(p.money || 0)}</b>`).join('') + '</div>';
      if ((sel.races || []).length) h += '<h4>Races</h4><div class="kv">' + sel.races.map((x) => `<span>${x.no}. ${trackName(x.track)}</span><b>won by ${U.esc(x.winner || '?')}</b>`).join('') + '</div>';
      if (sel.final) h += '<h4>Final</h4><div class="kv">' + sel.final.map((f, i) => `<span>${i + 1}. ${U.esc(f.name)}</span><b>${U.fmtMoney(f.worth)}</b>`).join('') + '</div>';
      h += '</div>';
    }
    const seen = Object.values(Hist.seen || {}).sort((a, b) => (b.last || 0) - (a.last || 0));
    h += `<h4>Other rooms seen (${seen.length})</h4>`;
    if (!seen.length) h += '<p class="note">Rooms in the Rooms tab are logged here while you\'re unlocked.</p>';
    h += seen
      .slice(0, 30)
      .map((s) => `<div class="hs"><div><b>${U.esc(s.name || '?')}</b>${s.code ? ` <code>${U.esc(s.code)}</code>` : ''} <span>${ic(s.vis === 'public' ? 'globe' : 'lock')}</span></div><span>${U.esc(s.host || '?')} · ${when(s.first)} · seen for ${fmtSecs((s.last || s.first) - s.first)} · up to ${s.peak || 0} online${s.races ? ` · ${s.races} races` : ''}</span>${s.drivers ? `<em>${U.esc(Object.keys(s.drivers).join(', '))}</em>` : ''}</div>`)
      .join('');
    return h;
  }

  // --- Activity: who plays, when they play, and what they race.
  // Everything here is rolled up from what THIS browser has seen, so it only
  // knows about rooms that reached the relay — a solo quick race never does.
  // Turn on background logging and leave the game open somewhere and it keeps
  // counting; driver names need the console unlocked to read the sealed cards.
  const DAYMS = 86400000;
  const dayKey = (t) => {
    const d = new Date(t);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const bar = (v, max, cls) => `<i class="bar${cls ? ' ' + cls : ''}" style="width:${max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0}%"></i>`;

  function dataHtml(O) {
    const now = Date.now();
    const ppl = Object.entries(Hist.people || {});
    const active = (ms) => ppl.filter(([, P]) => (P.last || 0) >= now - ms).length;
    const returning = ppl.filter(([, P]) => Object.keys(P.days || {}).length > 1).length;
    const mine = Hist.rooms.length;
    const seenN = Object.keys(Hist.seen || {}).length;
    const racesLogged = Object.values(Hist.tracks || {}).reduce((a, b) => a + b, 0);
    const pk = Hist.peak || {};

    let h = `<div class="row">${btnL('dataJson', 'Export JSON', 'ghost')}${btnL('dataCsv', 'Drivers CSV', 'ghost')}${btnL('dataCopy', 'Copy summary', 'ghost')}${btnL('histClear', 'Clear log', 'ghost')}</div>`;
    h += `<div class="row"><label class="tog"><input type="checkbox" data-o="bglog"${Ops.bgLog ? ' checked' : ''}><span></span>Keep logging in the background</label><span class="note">${Hist.kept() ? 'kept on this computer' : 'this visit only — use “keep” in 🕘 History'}</span></div>`;

    h += '<h4>Drivers</h4>' + kv([
      ['Seen in all', `${ppl.length}${returning ? ` · ${returning} came back another day` : ''}`],
      ['Last 24 hours', String(active(DAYMS))],
      ['Last 7 days', String(active(7 * DAYMS))],
      ['Last 30 days', String(active(30 * DAYMS))],
    ]);
    h += '<h4>Rooms</h4>' + kv([
      ['Logged', `${seenN} on the server list · ${mine} you were in`],
      ['Races', racesLogged ? String(racesLogged) : '—'],
      ['Peak drivers', pk.players ? `${pk.players} · ${when(pk.at)}` : '—'],
      ['Peak rooms', pk.rooms ? `${pk.rooms} · ${when(pk.roomsAt)}` : '—'],
    ]);

    // last 14 days
    const dayRows = [];
    for (let i = 13; i >= 0; i--) {
      const t = now - i * DAYMS, k = dayKey(t), d = Hist.days[k];
      dayRows.push({ k, t, r: (d && d.rooms) || 0, p: d ? Object.keys(d.drivers || {}).length : 0, peak: (d && d.peak) || 0 });
    }
    const maxR = Math.max(1, ...dayRows.map((d) => d.r));
    if (dayRows.some((d) => d.r || d.p)) {
      h += '<h4>Last 14 days</h4><div class="bars">';
      for (const d of dayRows) {
        const lab = new Date(d.t).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
        h += `<div class="br"><span>${U.esc(lab)}</span><div>${bar(d.r, maxR)}</div><b>${d.r} room${d.r === 1 ? '' : 's'}${d.p ? ` · ${d.p} driver${d.p === 1 ? '' : 's'}` : ''}${d.peak ? ` · peak ${d.peak}` : ''}</b></div>`;
      }
      h += '</div>';
    }

    // when people play
    const hrs = Hist.hours || [];
    const maxH = Math.max(1, ...hrs);
    if (hrs.some(Boolean)) {
      h += '<h4>When rooms open (your local time)</h4><div class="hrs">';
      for (let i = 0; i < 24; i++) h += `<div class="hr" title="${i}:00 — ${hrs[i]} rooms"><i style="height:${Math.max(2, Math.round((hrs[i] / maxH) * 34))}px"></i><span>${i % 6 === 0 ? i : ''}</span></div>`;
      h += '</div>';
    }

    const top = (obj, name, n) => {
      const es = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n || 6);
      if (!es.length) return '';
      const max = es[0][1];
      return `<h4>${name}</h4><div class="bars">` + es.map(([k, v]) => `<div class="br"><span>${name === 'Cars' ? carName(k) || U.esc(k) : trackName(k)}</span><div>${bar(v, max, 'alt')}</div><b>${v}</b></div>`).join('') + '</div>';
    };
    h += top(Hist.tracks, 'Tracks', 8);
    h += top(Hist.cars, 'Cars', 9);

    // people
    const q = (O.pq || '').toLowerCase();
    const list = ppl
      .filter(([n]) => !q || n.toLowerCase().includes(q))
      .sort((a, b) => (b[1].last || 0) - (a[1].last || 0));
    h += `<h4>People (${list.length})</h4>`;
    h += `<div class="row"><input data-f="pq" placeholder="Find a driver…" value="${U.esc(O.pq || '')}" class="grow"></div>`;
    if (!list.length) h += '<p class="note">Nobody logged yet. Open 🌐 All rooms, or turn on background logging.</p>';
    else
      h += '<div class="pps">' + list.slice(0, 60).map(([n, P]) => {
        const car = Object.entries(P.cars || {}).sort((a, b) => b[1] - a[1])[0];
        const dn = Object.keys(P.days || {}).length;
        return `<div class="pp"><span>${U.esc(n)}${P.host ? ' 👑' : ''}</span><b>${P.n || 1} room${(P.n || 1) === 1 ? '' : 's'}${P.ms ? ' · ' + fmtSecs(P.ms) : ''}</b><em>${dn} day${dn === 1 ? '' : 's'} · last ${when(P.last)}${car ? ' · ' + (carName(car[0]) || car[0]) : ''}</em></div>`;
      }).join('') + '</div>';
    return h;
  }

  function debugHtml(O) {
    const sn = G.NetSim || {}, s = G.Settings.s, g = G.Game;
    return `<h4>Network simulator</h4><p class="note">Adds lag and loss to what this browser sends as a joiner.</p>
      <div class="row">Lag <input data-f="lag" type="number" min="0" max="1000" step="10" value="${sn.lag || 0}" class="w52"> ± <input data-f="jit" type="number" min="0" max="500" step="10" value="${sn.jitter || 0}" class="w52"> ms · loss <input data-f="loss" type="number" min="0" max="50" value="${Math.round((sn.loss || 0) * 100)}" class="w44">%</div>
      <div class="row">${btnL('simApply', 'Apply')}${btnL('simOff', 'Off', 'ghost')}<label class="tog"><input type="checkbox" data-o="relay"${sn.forceRelay ? ' checked' : ''}><span></span>Next join via relay</label></div>
      <div class="row">${g.role === 'client' ? btnL('dropLink', 'Drop my link', 'ghost') : ''}${g.role === 'host' ? btnL('dropHost', 'Drop out as host', 'ghost') : ''}</div>
      <h4>Practice</h4><div class="row">Time ${[0.25, 0.5, 1, 2].map((v) => btnL('time', v + '×', O.timeScale === v ? '' : 'ghost', { v })).join('')}</div>
      <h4>Display</h4><div class="row">Cap ${[0, 30, 60].map((v) => btnL('cap', v ? v + '' : 'off', O.fpsCap === v ? '' : 'ghost', { v })).join('')} · ${btnL('fps', s.showFps ? 'Hide FPS' : 'Show FPS', 'ghost')}</div>
      <div class="row">Quality ${['auto', 'high', 'medium', 'low'].map((v) => btnL('quality', v, s.quality === v ? '' : 'ghost', { v })).join('')}</div>
      <h4>Sounds</h4><div class="row">${['request', 'join', 'leave', 'drop', 'host', 'warn', 'notify'].map((k) => btnL('snd', k, 'ghost', { v: k })).join('')}</div><div class="row">${[['blowoff', 'blow-off'], ['atmo', 'atmo valve'], ['flutter', 'flutter'], ['flutterBig', 'big flutter'], ['crackle', 'crackle'], ['bangs', 'bangs']].map(([v, l]) => btnL('snd', l, 'ghost', { v })).join('')}</div>`;
  }

  function logHtml(O) {
    const t = (at) => new Date(at).toTimeString().slice(0, 8);
    return `<div class="row">${btnL('logClear', 'Clear', 'ghost')}<span class="note">${O.logs.length} lines</span></div>` +
      O.logs.slice(-150).reverse().map((l) => `<div class="lg ${l.kind}">${t(l.at)} ${U.esc(l.txt)}</div>`).join('');
  }

  const CSS = `
#ops { position: fixed; top: 54px; right: 10px; z-index: 72; width: 372px; height: 520px; max-height: calc(88vh / var(--uiz, 1)); min-width: 270px; min-height: 60px; zoom: var(--uiz, 1);
  display: flex; flex-direction: column; resize: both; overflow: hidden; background: rgba(13,18,33,.95); border-radius: 12px;
  box-shadow: 0 12px 36px rgba(0,0,0,.5), inset 0 0 0 1px rgba(255,204,0,.3); font-family: var(--body); font-size: 12px; color: var(--ink); }
#ops[hidden] { display: none; }
#ops .op-h { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 6px 6px 5px 10px; border-bottom: 1px solid var(--line); cursor: move; user-select: none; touch-action: none; }
#ops .op-h > b { font: 400 13px var(--display); color: var(--yellow); letter-spacing: 2px; }
#ops .op-w { flex: 1; min-width: 0; color: var(--muted); font-size: 11px; font-weight: 900; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#ops .op-x { width: 22px; height: 22px; border: 0; border-radius: 6px; background: rgba(255,255,255,.08); color: var(--ink); cursor: pointer; font-size: 11px; line-height: 1; }
#ops .op-x:hover { background: rgba(255,255,255,.16); }
#ops .op-tabs { display: grid; grid-template-columns: repeat(5, 1fr); gap: 3px; width: 100%; margin-top: 4px; }
#ops .op-tabs button { display: flex; align-items: center; justify-content: center; gap: 4px; min-width: 0; padding: 4px 2px; border: 0; border-radius: 6px; background: rgba(255,255,255,.06); color: #c9d3ea; font: 800 10.5px var(--body); cursor: pointer; }
#ops .op-tabs button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#ops .op-tabs button .svi { width: 13px; height: 13px; flex: none; }
#ops .op-tabs button:hover { background: rgba(255,255,255,.12); }
#ops .op-tabs button.on { background: var(--yellow); color: #1a1300; }
#ops .op-x .svi { width: 13px; height: 13px; vertical-align: middle; }
#ops .btn .svi { width: 12px; height: 12px; vertical-align: -2px; margin-right: 1px; }
#ops .lbl { min-width: 64px; color: var(--muted); font: 800 11px var(--body); letter-spacing: 0; text-transform: none; }
#ops .seg { display: flex; gap: 4px; margin: 4px 0; }
#ops .seg .btn { flex: 1; }
#ops .btn.small.on { background: var(--yellow); color: #1a1300; }
#ops .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 4px 0; }
#ops .stp { display: flex; align-items: center; gap: 4px; padding: 3px 6px; border-radius: 8px; background: rgba(255,255,255,.04); }
#ops .stp > span { flex: 1; color: var(--muted); font-weight: 800; font-size: 11px; }
#ops details { margin: 6px 0; border-radius: 8px; background: rgba(255,255,255,.035); }
#ops summary { padding: 6px 8px; cursor: pointer; font-weight: 900; list-style: none; display: flex; align-items: center; gap: 6px; }
#ops summary::-webkit-details-marker { display: none; }
#ops summary::after { content: '›'; margin-left: auto; color: var(--muted); transition: transform .15s; }
#ops details[open] summary::after { transform: rotate(90deg); }
#ops details > :not(summary) { margin-left: 8px; margin-right: 8px; }
#ops details > .row:last-child { margin-bottom: 8px; }
#ops .fg { display: grid; grid-template-columns: 74px 1fr; gap: 4px 8px; align-items: center; margin: 4px 0; }
#ops .fg > label { color: var(--muted); font: 800 11px var(--body); letter-spacing: 0; text-transform: none; }
#ops .pl em { white-space: nowrap; }
#ops .pl { grid-template-columns: 1fr auto 84px; }
#ops .fg select, #ops .fg input:not([type=color]):not(.w72):not(.w52) { width: 100%; min-width: 0; box-sizing: border-box; }
#ops input[type=color] { width: 44px; height: 24px; padding: 1px 2px; vertical-align: middle; }
#ops .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }
#ops .pl .svi { width: 12px; height: 12px; vertical-align: -2px; }
#ops .nv { padding: 2px 0 6px; border-bottom: 1px solid rgba(255,255,255,.05); }
#ops .ni { display: grid; grid-template-columns: 18px 1fr; gap: 6px; padding: 4px 0; }
#ops .ni .svi { width: 14px; height: 14px; }
#ops .ni b { display: block; font-weight: 900; }
#ops .ni p { margin: 1px 0 0; color: #b7c1da; font-size: 11px; line-height: 1.35; }
#ops .ni.hid { margin: 2px -4px; padding: 5px 4px; border-radius: 6px; background: rgba(255,204,0,.07); }
#ops .ni.hid > .svi { color: var(--yellow); margin-top: 2px; }
#ops .op-b { flex: 1; min-height: 0; overflow: auto; padding: 2px 10px 10px; }
#ops.min { height: auto !important; min-height: 0; resize: none; }
#ops.min .op-tabs, #ops.min .op-b { display: none; }
#ops.min .op-h { border-bottom: 0; }
#ops h4 { margin: 9px 0 4px; font: 400 11px var(--display); color: var(--cyan); letter-spacing: 1px; text-transform: uppercase; }
#ops .kv { display: grid; grid-template-columns: 88px 1fr; gap: 2px 8px; font-variant-numeric: tabular-nums; }
#ops .kv span { color: var(--muted); }
#ops .kv b { font-weight: 800; overflow-wrap: anywhere; }
#ops code { font: 800 12px ui-monospace, Consolas, monospace; color: var(--yellow); letter-spacing: 1px; }
#ops .row { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin: 4px 0; }
#ops .row .gap { width: 8px; }
#ops .num { min-width: 16px; text-align: center; font-variant-numeric: tabular-nums; }
#ops .btn.small { padding: 3px 8px; font-size: 11px; border-radius: 7px; }
#ops input, #ops select { padding: 3px 6px; border: 1px solid rgba(255,255,255,.18); border-radius: 6px; background: #0b1020; color: var(--ink); font: 700 12px var(--body); }
#ops input:focus, #ops select:focus { outline: none; border-color: var(--yellow); }
#ops .grow { flex: 1; min-width: 0; } #ops .w72 { width: 72px; } #ops .w52 { width: 52px; } #ops .w44 { width: 44px; }
#ops .tog { font-size: 11px; gap: 6px; }
#ops .tog span { transform: scale(.8); }
#ops .pls { display: flex; flex-direction: column; gap: 1px; margin-top: 6px; }
#ops .pl { display: grid; grid-template-columns: 1fr auto 72px; gap: 6px; align-items: center; padding: 4px 6px; border-radius: 7px; cursor: pointer; }
#ops .pl:hover, #ops .dr:hover { background: rgba(255,255,255,.05); }
#ops .pl.sel, #ops .dr.sel { background: rgba(255,204,0,.12); box-shadow: inset 0 0 0 1px rgba(255,204,0,.45); }
#ops .pl span, #ops .dr span, #ops .dp span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#ops .pl b, #ops .dp b { font-variant-numeric: tabular-nums; }
#ops .pl em, #ops .dr em { font-style: normal; color: var(--muted); font-size: 11px; text-align: right; }
#ops .pl .off { opacity: .5; }
#ops .dr { display: grid; grid-template-columns: 1fr auto 52px; gap: 6px; align-items: center; padding: 5px 6px; border-radius: 7px; cursor: pointer; }
#ops .dd { margin: 3px 0 8px 6px; padding: 2px 0 2px 8px; border-left: 2px solid rgba(255,204,0,.35); }
#ops .dps { display: flex; flex-direction: column; gap: 1px; margin: 5px 0; }
#ops .dp { display: grid; grid-template-columns: 1fr auto 20px; gap: 6px; align-items: center; min-height: 20px; }
#ops .dp.off span, #ops .dp.off b { opacity: .45; }
#ops .op-mini { width: 20px; height: 18px; border: 0; border-radius: 5px; background: rgba(255,74,61,.18); color: #ff8a80; cursor: pointer; font-size: 10px; }
#ops .op-mini:hover { background: rgba(255,74,61,.4); }
/* v5.1 Activity: day and top-N bars, and an hour-of-day histogram. */
#ops .bars { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
#ops .br { display: grid; grid-template-columns: 74px 1fr auto; gap: 8px; align-items: center; }
#ops .br > span { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#ops .br > div { background: rgba(255,255,255,.07); border-radius: 4px; height: 9px; overflow: hidden; }
#ops .br b { font-size: 11px; font-variant-numeric: tabular-nums; color: #c9d3ea; white-space: nowrap; }
#ops .bar { display: block; height: 100%; background: linear-gradient(90deg, #2f6bff, #39d6ff); border-radius: 4px; }
#ops .bar.alt { background: linear-gradient(90deg, #14b8a6, #7fe0ff); }
#ops .hrs { display: grid; grid-template-columns: repeat(24, 1fr); gap: 2px; align-items: end; margin-top: 6px; }
#ops .hr { display: flex; flex-direction: column; align-items: center; gap: 2px; }
#ops .hr i { display: block; width: 100%; background: #2f6bff; border-radius: 2px 2px 0 0; }
#ops .hr span { font-size: 9px; color: var(--muted); }
#ops .pps { display: flex; flex-direction: column; margin-top: 4px; }
#ops .pp { display: grid; grid-template-columns: 1fr auto; gap: 1px 8px; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,.05); }
#ops .pp > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#ops .pp b { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; color: #c9d3ea; }
#ops .pp em { grid-column: 1 / -1; font-style: normal; font-size: 11px; color: var(--muted); }
#ops .hs { padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,.05); }
#ops .hs > span { display: block; color: var(--muted); font-size: 11px; }
#ops .hs em { display: block; font-style: normal; font-size: 11px; color: #c9d3ea; overflow-wrap: anywhere; }
#ops .lg { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,.04); color: #c9d3ea; font: 11px/1.35 ui-monospace, Consolas, monospace; overflow-wrap: anywhere; }
#ops .lg.bad { color: #ff8a80; } #ops .lg.warn { color: #ffd66b; } #ops .lg.ok { color: #8ff0b4; }
#ops .note { margin: 4px 0; color: var(--muted); font-size: 11px; line-height: 1.35; }
#ops-ann { position: fixed; left: 50%; top: 64px; z-index: 71; zoom: var(--uiz, 1); max-width: min(720px, calc(90vw / var(--uiz, 1))); padding: 12px 20px; border: 2px solid var(--yellow); border-radius: 14px;
  background: rgba(14,19,34,.95); color: #fff; font: 900 18px var(--body); text-align: center; box-shadow: 0 10px 34px rgba(0,0,0,.5); pointer-events: none; opacity: 0; transform: translate(-50%, -12px); transition: opacity .25s, transform .25s; }
#ops-ann.on { opacity: 1; transform: translate(-50%, 0); }`;

  const Ops = {
    KEY,
    key: null, // the unlocked signing key: this tab's memory only
    dh: null, // the same key for opening sealed room cards
    open: false,
    tab: 'dir',
    sel: null,
    logs: [],
    timeScale: 1, // practice only (main.js)
    fpsCap: 0, // main.js
    nonce: null,
    nonceNet: null,
    seq: 0,
    wait: new Map(),
    remote: null,
    board: null, // the room directory, while unlocked
    bgLog: false, // keep the directory running (and logging) with the panel shut
    dir: new Map(), // sealed card ciphertext -> details (or null while opening, 'bad')
    known: new Set(),
    alerts: true,
    form: {}, // v5.5.7: typed or picked, not sent yet (survives redraws)
    dOpen: {}, // open sections of the bot editor
    bsel: null, // the bot being edited
    hidOnly: false,
    notes: null, // the hidden changelog, once opened
    NOTES: { hpub: 'BGw6jiNqcd/sm7QAKeH8IHiHdDdLWeZR2cKPjlO82sS0KHLuykL1leMmsTC8DtG/hhK+xpbgmmStZKwelbKIT94=', iv: 'qpdMu+zfLJE2Jnwm', ct: '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' }, // sealed hidden notes: tools/harness/sealnotes.py writes this line

    init() {
      const css = document.createElement('style');
      css.textContent = CSS;
      document.head.appendChild(css);
      const el = (this.el = document.createElement('div'));
      el.id = 'ops';
      el.hidden = true;
      el.innerHTML = `<div class="op-h"><b>OPS</b><span class="op-w"></span><button class="op-x" data-o="min" title="Shrink to one line">${ic('minus')}</button><button class="op-x" data-o="lock" title="Lock (forget the key)">${ic('lock')}</button><button class="op-x" data-o="hide" title="Hide (Ctrl+Shift+\`)">${ic('x')}</button><div class="op-tabs">${TABS.map(([k, i, l]) => `<button data-o="tab" data-t="${k}" title="${l}">${ic(i)}<span>${l}</span></button>`).join('')}</div></div><div class="op-b"></div>`;
      document.body.appendChild(el);
      this.whereEl = el.querySelector('.op-w');
      this.body = el.querySelector('.op-b');
      el.addEventListener('click', (e) => this._click(e));
      el.addEventListener('change', (e) => {
        const o = e.target.dataset.o;
        this._remember(e.target);
        if (o === 'relay' && G.NetSim) G.NetSim.forceRelay = e.target.checked;
        if (o === 'alerts') this.alerts = e.target.checked;
        if (o === 'bglog') this.setBgLog(e.target.checked);
        if (o === 'hidOnly') {
          this.hidOnly = e.target.checked;
          this.render(true);
        }
        if (e.target.dataset.auto) this._cmd(e.target, {}); // (a pick that applies at once)
      });
      // v5.5.7: an open section stays open when the panel redraws
      el.addEventListener('toggle', (e) => {
        const d = e.target.dataset && e.target.dataset.d;
        if (d) this.dOpen[d] = e.target.open;
      }, true);
      // ...and nothing redraws under a click (the button it started on would vanish)
      el.addEventListener('pointerdown', () => (this._ptr = true), true);
      window.addEventListener('pointerup', () => setTimeout(() => (this._ptr = false), 60), true);
      el.addEventListener('focusout', () => setTimeout(() => this._flush(), 0));
      el.addEventListener('input', (e) => {
        this._remember(e.target);
        const f = e.target.dataset.f;
        if (f === 'pq') {
          this.pq = e.target.value;
          this.render();
          return;
        }
        if (f !== 'q') return;
        this.q = e.target.value;
        this.render();
      });
      el.addEventListener('keydown', (e) => {
        e.stopPropagation(); // typing in here never drives, mutes or opens the chat
        const f = e.target.dataset.f;
        if (e.key === 'Enter' && (f === 'ann' || f === 'annAll')) {
          const b = el.querySelector(f === 'ann' ? '[data-k="announce"]' : '[data-k="dirAnnAll"]');
          if (b) b.click();
        } else if (e.key === 'Escape') this.hide();
      });
      this._dragging(el);
      el.addEventListener('pointerup', () => setTimeout(() => this._savePos(), 0)); // (after a resize too)
      window.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.code === 'Backquote') {
          e.preventDefault();
          this.toggle();
        }
      });
      // no keyboard (touch): hold the version badge on the main menu for 3 s
      let holdT = null;
      document.addEventListener('pointerdown', (e) => {
        if (!e.target.closest || !e.target.closest('.logo .ver, .ov-foot .ver')) return;
        clearTimeout(holdT);
        holdT = setTimeout(() => {
          this._held = true;
          this.toggle();
        }, 3000);
      }, true);
      const cancel = () => clearTimeout(holdT);
      document.addEventListener('pointerup', cancel, true);
      document.addEventListener('pointercancel', cancel, true);
      document.addEventListener('click', (e) => {
        if (!this._held || !e.target.closest || !e.target.closest('.logo .ver, .ov-foot .ver')) return;
        this._held = false; // (that long press isn't also a "What's new" click)
        e.stopImmediatePropagation();
        e.preventDefault();
      }, true);
      window.addEventListener('error', (e) => this._log((e.message || 'Error') + (e.filename ? ` (${e.filename.split('/').pop().split('?')[0]}:${e.lineno})` : ''), 'bad'));
      window.addEventListener('unhandledrejection', (e) => this._log('Unhandled: ' + ((e.reason && e.reason.message) || e.reason), 'bad'));
      setInterval(() => this._tick(), 500);
      // the room diary runs whether or not anyone unlocks (and never breaks the game)
      Hist.load();
      this.bgLog = !!U.store.get(BGKEY, 0);
      if (this.bgLog && Hist.kept()) this._boardOn();
      setInterval(() => {
        try {
          Hist.tick();
        } catch (e) {}
      }, 1000);
    },

    _log(txt, kind) {
      this.logs.push({ at: Date.now(), txt: String(txt).slice(0, 300), kind: kind || '' });
      if (this.logs.length > 300) this.logs.shift();
    },

    // Drag the panel by its title bar; the corner grip resizes it.
    _dragging(el) {
      const head = el.querySelector('.op-h');
      let d = null;
      head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button, input, select')) return;
        const r = el.getBoundingClientRect();
        d = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        head.setPointerCapture(e.pointerId);
      });
      head.addEventListener('pointermove', (e) => {
        if (!d) return;
        const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--uiz')) || 1;
        const r = el.getBoundingClientRect();
        const x = U.clamp(e.clientX - d.dx, 0, Math.max(0, innerWidth - r.width));
        const y = U.clamp(e.clientY - d.dy, 0, Math.max(0, innerHeight - 30));
        el.style.left = x / z + 'px';
        el.style.top = y / z + 'px';
        el.style.right = 'auto';
      });
      const end = () => {
        if (!d) return;
        d = null;
        this._savePos();
      };
      head.addEventListener('pointerup', end);
      head.addEventListener('pointercancel', end);
    },
    // (position, size and one-line mode are remembered on your own computer only)
    _savePos() {
      if (!Hist.kept() || !this.el) return;
      const s = this.el.style;
      U.store.set('ss.ops.ui', { left: s.left, top: s.top, w: s.width, h: s.height, min: this.el.classList.contains('min'), tab: this.tab });
    },
    _loadPos() {
      const p = Hist.kept() ? U.store.get('ss.ops.ui', null) : null;
      if (!p || this._posLoaded) return;
      this._posLoaded = true;
      const s = this.el.style;
      if (p.left) {
        s.left = p.left;
        s.top = p.top;
        s.right = 'auto';
      }
      if (p.w) s.width = p.w;
      if (p.h) s.height = p.h;
      this.el.classList.toggle('min', !!p.min);
      if (p.tab && TABS.some((t) => t[0] === p.tab)) this.tab = p.tab;
    },
    _onScreen() {
      const r = this.el.getBoundingClientRect();
      if (r.right < 40 || r.left > innerWidth - 40 || r.top > innerHeight - 20 || r.top < 0) {
        this.el.style.left = this.el.style.top = '';
        this.el.style.right = '10px';
      }
    },

    // ------------------------------------------------------- locking
    toggle() {
      if (!this.key) return this.prompt();
      if (this.open) this.hide();
      else this.show();
    },
    async prompt() {
      if (this._prompting || !this.KEY || !subtle()) return; // no key in this build: the shortcut does nothing
      if (Date.now() < (this._coolT || 0)) return G.UI.toast('Wait a moment.', 'bad');
      this._prompting = true;
      const r = await G.UI.modal('Maintenance', '<input name="pass" type="password" autocomplete="off" spellcheck="false" placeholder="Passphrase" style="width:100%">', [
        { label: 'Cancel', value: 0, cls: 'ghost' },
        { label: 'Unlock', value: 1, cls: 'primary' },
      ]);
      this._prompting = false;
      if (!r.value || !r.inputs.pass) return;
      if (await this._unlock(r.inputs.pass)) this.show();
      else {
        this._coolT = Date.now() + 3000;
        G.UI.toast('Wrong passphrase.', 'bad');
      }
    },
    async _unlock(pass) {
      try {
        const k = await openKey(this.KEY, pass);
        this.key = k.sign;
        this.dh = k.dh;
        this._log('Unlocked', 'ok');
        Hist.keep(); // from now on this computer keeps the room diary
        this._boardOn();
        return true;
      } catch (e) {
        return false;
      }
    },
    show() {
      this.open = true;
      this.el.hidden = false;
      this._loadPos();
      this._onScreen();
      this._key = null;
      this._bodyTab = null;
      this.render(true);
    },
    hide() {
      this.open = false;
      this.el.hidden = true;
    },
    lock() {
      this.key = this.dh = null;
      this.nonce = null;
      this.remote = null;
      this._boardOff();
      this.hide();
      G.UI.toast('Locked.', 'info', false);
    },

    // v5.1: with this on, the room directory keeps running after the panel is
    // closed, so the activity log keeps counting while the game sits open on
    // this computer. Only rooms and player counts — reading the sealed cards
    // for driver names still needs the key, which lives in one tab's memory.
    setBgLog(on) {
      this.bgLog = !!on;
      U.store.set(BGKEY, this.bgLog ? 1 : 0);
      if (this.bgLog) {
        Hist.keep();
        this._boardOn();
      } else if (!this.open) this._boardOff();
      this.render(true);
    },

    // ---------------------------------------------------- directory
    _boardOn() {
      if (this.board || !G.Relay || !G.Relay.RoomBoard) return;
      this.board = new G.Relay.RoomBoard().start();
      this.boardAt = Date.now();
    },
    _boardOff() {
      if (!this.board) return;
      this.board.close();
      this.board = null;
    },
    async _openCard(blob) {
      const S = subtle();
      const pub = await S.importKey('raw', unb64(blob.hpub), DH, false, []);
      const k = await S.deriveKey({ name: 'ECDH', public: pub }, this.dh, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const d = JSON.parse(new TextDecoder().decode(await S.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, k, unb64(blob.ct))));
      if (!d || !Array.isArray(d.p) || typeof d.code !== 'string') throw new Error('bad');
      return d;
    },
    _dirScan() {
      if (!this.board || !this.dh) return;
      const list = this.board.list(), now = Date.now(), live = new Set();
      for (const r of list) {
        if (r.ops) {
          live.add(r.ops.ct);
          if (!this.dir.has(r.ops.ct)) {
            this.dir.set(r.ops.ct, null);
            this._openCard(r.ops).then((d) => this.dir.set(r.ops.ct, d), () => this.dir.set(r.ops.ct, 'bad'));
          }
        }
        if (!this.known.has(r.lid)) {
          this.known.add(r.lid);
          const mine = G.Game.role === 'host' && G.Game.session && G.Game.session.state.lid === r.lid;
          if (this.alerts && !mine && now - this.boardAt > 9000) {
            G.UI.toast(`🆕 Room opened: ${r.name}${r.host ? ' · ' + r.host : ''}`, 'info', 'notify');
            this._log(`Room opened: ${r.name} (${r.vis}) · host ${r.host || '?'}`, 'ok');
          }
        }
      }
      if (this.dir.size > 200) for (const k of Array.from(this.dir.keys())) if (!live.has(k)) this.dir.delete(k);
    },
    // A signed command for one room (lid) or every room ('*'), through the
    // relay: no need to be in the room. Hosts check it (onRelay).
    async _relaySend(k, lid, a) {
      if (!this.key) throw new Error('Locked.');
      const ms = this.board ? this.board.ms : [];
      if (!ms.length) throw new Error("Can't reach the room servers from here.");
      const o = { id: U.uid(14), at: Date.now(), lid, k, a: JSON.stringify(a || {}) };
      o.sig = b64(await subtle().sign(SIG, this.key, enc.encode(signedMq(o))));
      const topic = G.Relay.OPS + (lid === '*' ? 'all' : 'do/' + lid);
      const s = JSON.stringify(o);
      for (const m of ms) m.publish(topic, s);
      return ms.length;
    },

    // ------------------------------------------------- host side: relay
    // The sealed details for this room's server-list card (game.js). Re-sealed
    // only when they change; the fresh seal is picked up on the next announce.
    cardFor(game, st) {
      if (!this.KEY || !subtle() || !G.Relay || !G.Relay.sealFor) return null;
      const plain = JSON.stringify(roomDetails(game, st));
      const S = this._seal || (this._seal = {});
      if (S.plain !== plain && !S.busy) {
        S.busy = true;
        G.Relay.sealFor(rawPub(), plain).then(
          (b) => {
            S.plain = plain;
            S.blob = b;
            S.busy = false;
            game._annKey = null; // announce the new card
          },
          () => {
            S.plain = plain;
            S.busy = false;
          }
        );
      }
      return S.blob || null;
    },
    // A signed maintainer message arrived through the relay (relay.js RelayHost).
    onRelay(s) {
      const g = G.Game;
      if (g.role !== 'host' || !g.session || !this.KEY) return;
      let o = null;
      try {
        o = JSON.parse(s);
      } catch (e) {}
      if (!o || typeof o.id !== 'string' || o.id.length > 40 || typeof o.sig !== 'string' || o.sig.length > 200 || typeof o.a !== 'string' || o.a.length > 600 || typeof o.k !== 'string' || typeof o.at !== 'number') return;
      const lid = g.session.state.lid || g.code;
      if (o.lid !== lid && !(o.lid === '*' && o.k === 'announce')) return;
      if (Math.abs(Date.now() - o.at) > 5 * 60000) return; // stale (or a replay)
      const seen = this._mq || (this._mq = new Map());
      if (seen.has(o.id)) return; // the same message via another broker
      seen.set(o.id, Date.now());
      if (seen.size > 200) for (const [k, t] of seen) if (Date.now() - t > 15 * 60000) seen.delete(k);
      verify(signedMq(o), o.sig).then((ok) => {
        if (!ok) return seen.delete(o.id);
        let a = {};
        try {
          a = JSON.parse(o.a) || {};
        } catch (e) {}
        if (o.k === 'announce') exec({ k: 'announce', text: a.text }, null);
        else if (o.k === 'close') exec({ k: 'close' }, null);
        else if (o.k === 'kick') exec({ k: 'kick', pid: a.pid }, null);
        console.info('[ops] relay', o.k);
      });
    },

    // Sign a skin grant for this driver. Needs the console unlocked.
    async signGrant(id, who) {
      if (!this.key || !subtle() || !G.Parts.SKINS[id]) return null;
      const t = { id, who: String(who || '').slice(0, 24), at: Date.now() };
      t.sig = b64(await subtle().sign(SIG, this.key, enc.encode(signedSkin(t))));
      return t;
    },
    // Anyone can check one: it is the public key that ships with the game.
    async checkGrant(t) {
      if (!t || !G.Parts.SKINS[t.id] || typeof t.sig !== 'string' || t.sig.length > 200 || typeof t.at !== 'number') return false;
      return verify(signedSkin(t), t.sig);
    },

    // -------------------------------------------------------- display
    _tick() {
      if (!this.key) return;
      this._chatScan();
      this._dirScan();
      if (!this.open) return;
      if (G.Game.role === 'client' && (this.tab === 'room' || this.tab === 'players' || this.tab === 'stats') && performance.now() - (this._fetchT || 0) > 2000) this._fetch();
      this.render();
    },
    // joins, leaves, drops and warnings from the room, into the log
    _chatScan() {
      const chat = (G.Client.state && G.Client.state.chat) || [];
      const last = this._chatAt || 0;
      for (const c of chat) if (c.at > last && c.sys) this._log('💬 ' + c.text, c.snd === 'drop' || c.snd === 'warn' ? 'warn' : '');
      if (chat.length) this._chatAt = Math.max(last, chat[chat.length - 1].at);
    },
    _S() {
      if (G.Game.role === 'client') return this.remote;
      const X = ctx();
      return X && X.s ? hostStats(X) : null;
    },
    _summary() {
      const w = G.App.world, ws = w ? w.stats() : null, g = G.Game, parts = [];
      if (ws) parts.push(ws.fps.toFixed(0) + ' fps');
      if (g.role === 'client' && g.net) parts.push(Math.round(g.net.rtt || 0) + ' ms');
      if (g.role && g.code) parts.push((g.role === 'host' ? 'hosting ' : 'in ') + g.code);
      if (this.board) {
        const l = this.board.list();
        parts.push(`${l.length} rooms · ${l.reduce((a, r) => a + (r.players || 0), 0)} online`);
      }
      return parts.join(' · ');
    },
    render(force) {
      if (!this.open) return;
      const g = G.Game, min = this.el.classList.contains('min');
      const name = (TABS.find((t) => t[0] === this.tab) || [])[2] || '';
      this.whereEl.textContent = min ? this._summary() : name + (g.role ? ` · ${g.role === 'host' ? 'hosting' : 'in'} ${g.code || ''}` : '');
      if (min) return;
      for (const b of this.el.querySelectorAll('.op-tabs button')) b.classList.toggle('on', b.dataset.t === this.tab);
      if (this.tab === 'dir') {
        // the search box stays put while the list under it updates
        if (this._bodyTab !== 'dir') {
          this._bodyTab = 'dir';
          this.body._html = null;
          this.body.innerHTML = dirControls(this) + '<div class="op-dl"></div>';
        }
        this._patch(this.body.querySelector('.op-dl'), dirList(this));
        return;
      }
      if (this._bodyTab === 'dir' || this._bodyTab === 'data') this.body._html = null;
      this._bodyTab = this.tab;
      let html;
      if (this.tab === 'notes') {
        this._openNotes();
        html = notesHtml(this);
      } else if (this.tab === 'stats') html = statsHtml();
      else if (this.tab === 'log') html = logHtml(this);
      else if (this.tab === 'hist') html = histHtml(this);
      else if (this.tab === 'data') {
        // the search box stays put while the list under it updates
        if (this._bodyTab !== 'data') {
          this._bodyTab = 'data';
          this.body.innerHTML = dataHtml(this);
          return;
        }
        const el = this.body.querySelector('[data-f="pq"]');
        const foc = el && document.activeElement === el;
        const pos = foc ? el.selectionStart : 0;
        G.UI.patch(this.body, dataHtml(this));
        const el2 = this.body.querySelector('[data-f="pq"]');
        if (foc && el2) {
          el2.focus();
          try { el2.setSelectionRange(pos, pos); } catch (e) {}
        }
        return;
      }
      else {
        // This room / Drivers / Tools re-render only when their data changes
        // (a re-render would reset a half-picked dropdown or a typed amount)
        const S = this.tab === 'debug' ? null : this._S();
        // (ping times change every second: not a reason to redraw)
        const still = S && JSON.stringify(S, (kk, v) => (kk === 'rtt' || kk === 'idle' || kk === 'lobby' ? undefined : v));
        const key = [this.tab, this.sel, this.bsel, g.role, !!(ctx() && ctx().sim), this.remoteErr, still, this.tab === 'debug' && JSON.stringify([G.NetSim, this.timeScale, this.fpsCap, G.Settings.s.quality, G.Settings.s.showFps]), force && Math.random()].join('|');
        if (key === this._key) return;
        this._key = key;
        html = this.tab === 'room' ? roomHtml(this, S) : this.tab === 'players' ? playersHtml(this, S) : this.tab === 'bots' ? botsHtml(this, S) : debugHtml(this);
      }
      this._patch(this.body, html);
    },
    // v5.5.7 redraws that don't fight you. The old one could land between
    // picking something and clicking its button: Give handed over the first
    // car in the list, Set money set $0, and a click on a button that had
    // just been redrawn went nowhere. Now a redraw waits while a box or a
    // list has focus or a button is being pressed, and puts back anything
    // typed or picked but not sent yet.
    _fk(e) {
      return e.dataset.f + '|' + (e.dataset.s || '');
    },
    _remember(e) {
      if (!e || !e.dataset || !e.dataset.f || e.dataset.auto) return;
      this.form[this._fk(e)] = e.type === 'checkbox' ? e.checked : e.value;
    },
    _restore(root) {
      for (const e of root.querySelectorAll('[data-f]')) {
        const k = this._fk(e);
        if (!(k in this.form)) continue;
        if (e.type === 'checkbox') e.checked = !!this.form[k];
        else e.value = this.form[k];
      }
    },
    _busy(el) {
      if (this._ptr) return true;
      const a = document.activeElement;
      if (!a || !el.contains(a)) return false;
      return a.tagName === 'SELECT' || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'range', 'color'].includes(a.type));
    },
    _patch(el, html) {
      if (!el) return;
      if (el._html === html) {
        if (this._later && this._later[0] === el) this._later = null;
        return;
      }
      if (this._busy(el)) {
        this._later = [el, html];
        return;
      }
      this._later = null;
      const top = el.scrollTop;
      el._html = html;
      el.innerHTML = html;
      this._restore(el);
      el.scrollTop = top;
    },
    _flush() {
      if (this._later && !this._busy(this._later[0])) this._patch(this._later[0], this._later[1]);
    },
    // v5.5.7 the hidden half of the changelog (see notesHtml)
    async _openNotes() {
      if (this.notes || this.notesErr || this._notesBusy || !this.dh) return;
      const blob = this.NOTES;
      if (!blob) {
        this.notesErr = true;
        return;
      }
      this._notesBusy = true;
      try {
        const S = subtle();
        const pub = await S.importKey('raw', unb64(blob.hpub), DH, false, []);
        const k = await S.deriveKey({ name: 'ECDH', public: pub }, this.dh, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        const d = JSON.parse(new TextDecoder().decode(await S.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, k, unb64(blob.ct))));
        if (!d || typeof d !== 'object') throw new Error('bad');
        this.notes = d;
      } catch (e) {
        this.notesErr = true;
      }
      this._notesBusy = false;
      if (this.tab === 'notes') this.render(true);
    },
    banner(text) {
      text = String(text || '').slice(0, 140);
      if (!text) return;
      let el = document.getElementById('ops-ann');
      if (!el) {
        el = document.createElement('div');
        el.id = 'ops-ann';
        document.body.appendChild(el);
      }
      el.textContent = '📢 ' + text;
      el.classList.remove('on');
      void el.offsetWidth;
      el.classList.add('on');
      clearTimeout(this._annT);
      this._annT = setTimeout(() => el.classList.remove('on'), 9000);
    },

    // ------------------------------------------------------- actions
    _click(e) {
      const b = e.target.closest('[data-o]');
      if (!b || b.tagName === 'INPUT') return;
      const o = b.dataset.o;
      const a = () => JSON.parse(decodeURIComponent(b.dataset.a || '%7B%7D'));
      if (o === 'tab') {
        this.tab = b.dataset.t;
        this._savePos();
        this.render(true);
      } else if (o === 'hide') this.hide();
      else if (o === 'lock') this.lock();
      else if (o === 'min') {
        this.el.classList.toggle('min');
        this._savePos();
        this._bodyTab = null;
        this.render(true);
      } else if (o === 'sel') {
        this.sel = b.dataset.id;
        this.render(true);
      } else if (o === 'bsel') {
        this.bsel = b.dataset.id;
        this.render(true);
      } else if (o === 'cmd') this._cmd(b, a());
      else if (o === 'loc') {
        this.local(b.dataset.k, a());
        this.render(true);
      }
    },
    async _cmd(b, a) {
      const k = b.dataset.k, f = (n) => this.el.querySelector(`[data-f="${n}"]`);
      const c = Object.assign({ k }, a);
      // v5.5.7 the bot editor sends what was changed in its section
      const scope = a.pid || '', used = [];
      const dirty = (n) => (n + '|' + scope) in this.form;
      const val = (n) => {
        used.push(n + '|' + scope);
        const e = f(n);
        return e ? (e.type === 'checkbox' ? e.checked : e.value) : undefined;
      };
      if (k === 'botWho') {
        c.k = 'bot';
        for (const [n, key] of [['bName', 'name'], ['bStyle', 'style'], ['bLevel', 'level'], ['bSkill', 'skill'], ['bLock', 'lock']]) if (dirty(n)) c[key] = val(n);
      }
      if (k === 'botCar') Object.assign(c, { k: 'bot', car: val('bCar') });
      if (k === 'botParts') {
        c.k = 'bot';
        c.parts = {};
        for (const e of this.el.querySelectorAll('[data-f^="bp-"]')) if (dirty(e.dataset.f)) c.parts[e.dataset.f.slice(3)] = val(e.dataset.f);
      }
      if (k === 'botSound') {
        c.k = 'bot';
        c.sound = {};
        for (const s of G.Parts.SOUND_KEYS) c.sound[s] = val('bs-' + s);
      }
      if (k === 'botLook') {
        c.k = 'bot';
        c.look = {};
        const hexN = (v) => parseInt(String(v).replace('#', ''), 16);
        for (const [n, key, conv] of [['bPaint', 'paint', hexN], ['bAccent', 'accent', hexN], ['bLivery', 'livery'], ['bFinish', 'finish'], ['bRims', 'rims'], ['bKit', 'kit'], ['bSpoiler', 'spoiler'], ['bNum', 'num', (v) => U.clamp(Math.round(+v || 0), 0, 99)]])
          if (dirty(n)) c.look[key] = conv ? conv(val(n)) : val(n);
      }
      if (k === 'botHabits') Object.assign(c, { k: 'bot', traits: { brake: +val('hBrake'), line: +val('hLine'), mistake: +val('hMis'), rival: val('hRival') } });
      if (k === 'roomSet') Object.assign(c, { catchup: val('cu'), weather: val('wx') });
      if (k === 'botDel' && !(await G.UI.confirm('Remove this bot?', 'It leaves the room now (between races).', 'Remove', true))) return;
      if (k === 'nextTrack') c.id = val('track');
      if (k === 'botSkill') c.v = val('skill');
      if (k === 'announce') c.text = val('ann');
      if (k === 'giveCar') c.car = val('car');
      if (k === 'moneySet') Object.assign(c, { k: 'money', set: 1, v: +val('money') });
      if (k === 'skin' || k === 'skinTake') Object.assign(c, { k: 'skin', id: val('skin'), take: k === 'skinTake' ? 1 : 0 });
      if (k === 'close' && !(await G.UI.confirm('Close this room?', 'Everyone goes back to the main menu.', 'Close room', true))) return;
      if (k === 'kick' && !(await G.UI.confirm('Kick and ban?', "They can't come back into this room.", 'Kick', true))) return;
      b.disabled = true;
      try {
        const r = await this.run(c);
        this._log(`✓ ${c.k}: ${r}`, 'ok');
        G.UI.toast(String(r), 'info', false);
        for (const u of used) delete this.form[u]; // sent: the host's value shows from now on
        if (k === 'botDel' && this.bsel === a.pid) this.bsel = null;
        if (k === 'announce' && f('ann')) f('ann').value = '';
      } catch (e) {
        this._log(`✗ ${c.k}: ${e.message}`, 'bad');
        G.UI.toast(e.message, 'bad');
      }
      b.disabled = false;
      if (G.Game.role === 'client') this._fetch();
      this._key = null;
      setTimeout(() => this.render(true), 120);
    },
    local(k, a) {
      const sn = G.NetSim, f = (n) => this.el.querySelector(`[data-f="${n}"]`);
      if (k.slice(0, 3) === 'dir') return void this._dirAct(k, a);
      if (k === 'rsel') this.rsel = this.rsel === a.v ? null : a.v;
      else if (k === 'toBots') {
        this.tab = 'bots';
        this.bsel = a.pid;
      }
      else if (k === 'copyCode') this._copy(G.Game.code);
      else if (k === 'simApply' && sn) {
        sn.lag = U.clamp(+f('lag').value || 0, 0, 1000);
        sn.jitter = U.clamp(+f('jit').value || 0, 0, 500);
        sn.loss = U.clamp((+f('loss').value || 0) / 100, 0, 0.5);
      } else if (k === 'simOff' && sn) sn.lag = sn.jitter = sn.loss = 0;
      else if (k === 'dropLink' && G.Game.role === 'client') G.Game._lost('error');
      else if (k === 'dropHost' && G.Game.role === 'host' && G.Game.net) G.Game.net.close();
      else if (k === 'time') this.timeScale = a.v;
      else if (k === 'cap') this.fpsCap = a.v;
      else if (k === 'quality') G.Settings.set('quality', a.v);
      else if (k === 'fps') G.Settings.set('showFps', !G.Settings.s.showFps);
      else if (k === 'snd' && G.Audio) {
        if (!G.Audio.enabled) G.Audio.setEnabled(true);
        if (a.v === 'blowoff') G.Audio.blowoff(1);
        else if (a.v === 'atmo') G.Audio.blowoffAtmo(1);
        else if (a.v === 'flutter') G.Audio.flutter(1);
        else if (a.v === 'flutterBig') G.Audio.flutter(1, null, true);
        else if (a.v === 'crackle') G.Audio.crackle(1, 1, true);
        else if (a.v === 'bangs') G.Audio.bangBurst(1);
        else {
          G.Audio._ntT = 0;
          G.Audio.notify(a.v);
        }
      } else if (k === 'logClear') this.logs = [];
      else if (k === 'histSel') this.hsel = this.hsel === a.v ? null : a.v;
      else if (k === 'histClear') {
        Hist.clear();
        this.hsel = null;
      } else if (k === 'histCopy') this._copy(JSON.stringify({ rooms: Hist.rooms, seen: Hist.seen }, (kk, v) => (kk === '_t' ? undefined : v), 1), 'History copied.');
      else if (k === 'dataJson') {
        const blob = JSON.stringify({
          exported: new Date().toISOString(), version: G.VERSION,
          people: Hist.people, days: Hist.days, tracks: Hist.tracks, cars: Hist.cars,
          hours: Hist.hours, peak: Hist.peak, rooms: Hist.rooms, seen: Hist.seen,
        }, (kk, v) => (kk === '_t' || kk === '_t0' || kk === '_counted' ? undefined : v), 1);
        this._download('slipstakes-activity-' + new Date().toISOString().slice(0, 10) + '.json', blob, 'application/json');
      } else if (k === 'dataCsv') {
        const esc = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
        const rows = [['name', 'first seen', 'last seen', 'rooms', 'minutes', 'days', 'times hosting', 'top car'].join(',')];
        for (const [n, P] of Object.entries(Hist.people)) {
          const car = Object.entries(P.cars || {}).sort((a, b) => b[1] - a[1])[0];
          rows.push([esc(n), esc(new Date(P.first).toISOString()), esc(new Date(P.last).toISOString()), P.n || 1,
            Math.round((P.ms || 0) / 60000), Object.keys(P.days || {}).length, P.host || 0, esc(car ? car[0] : '')].join(','));
        }
        this._download('slipstakes-drivers-' + new Date().toISOString().slice(0, 10) + '.csv', rows.join('\n'), 'text/csv');
      } else if (k === 'dataCopy') {
        const ppl = Object.values(Hist.people), now = Date.now();
        const act = (ms) => ppl.filter((P) => (P.last || 0) >= now - ms).length;
        this._copy([
          'SLIPSTAKES activity',
          `drivers: ${ppl.length} all time, ${act(86400000)} in 24 h, ${act(7 * 86400000)} in 7 days`,
          `rooms logged: ${Object.keys(Hist.seen).length} (you were in ${Hist.rooms.length})`,
          `peak: ${(Hist.peak || {}).players || 0} drivers at once, ${(Hist.peak || {}).rooms || 0} rooms at once`,
        ].join('\n'), 'Summary copied.');
      }
      if (['simApply', 'simOff', 'dropLink', 'dropHost', 'time', 'cap', 'quality', 'histClear'].includes(k)) this._log('· ' + k + (a.v != null ? ' ' + a.v : ''));
    },
    _download(name, text, mime) {
      try {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        G.UI.toast('Saved ' + name, 'info', false);
      } catch (e) {
        this._copy(text, 'Could not save a file — copied instead.');
      }
    },
    _copy(text, done) {
      if (!text) return;
      navigator.clipboard.writeText(String(text)).then(() => G.UI.toast(done || 'Copied.', 'info', false), () => G.UI.toast('Could not copy.', 'bad'));
    },
    async _dirAct(k, a) {
      const f = (n) => this.el.querySelector(`[data-f="${n}"]`);
      try {
        if (k === 'dirCopy') return this._copy(a.code, `Code ${a.code} copied.`);
        if (k === 'dirJoin') {
          const here = G.Game.role ? (G.Game.role === 'host' ? ' This closes or hands over the room you host.' : ' You leave the room you are in.') : '';
          if (!(await G.UI.confirm(`Join ${a.name}?`, `You join room ${U.esc(a.code)} as a driver.${here}`, 'Join'))) return;
          if (G.Game.role) G.Game.leave();
          if (G.App.mode === 'drive') G.App.endDrive(true);
          G.UI.toast('Connecting to ' + a.code + '…', 'info', false);
          await new Promise((r) => setTimeout(r, 300));
          await G.Game.join(a.code, G.App.name());
          this._log('Joined ' + a.code, 'ok');
          return;
        }
        if (k === 'dirAnnAll') {
          const el = f('annAll'), text = el.value.trim().slice(0, 140);
          if (!text) return G.UI.toast('Type a message first.', 'bad');
          await this._relaySend('announce', '*', { text });
          el.value = '';
          this._log('Announced to every room: ' + text, 'ok');
          return G.UI.toast('Sent to every room.', 'info', false);
        }
        if (k === 'dirAnn') {
          const r = await G.UI.modal(`Announce in ${a.name}`, '<input name="text" maxlength="140" placeholder="Message" style="width:100%">', [
            { label: 'Cancel', value: 0, cls: 'ghost' },
            { label: 'Send', value: 1, cls: 'primary' },
          ]);
          const text = r.value && String(r.inputs.text || '').trim();
          if (!text) return;
          await this._relaySend('announce', a.lid, { text });
          this._log(`Announced in ${a.name}: ${text}`, 'ok');
          return G.UI.toast('Sent.', 'info', false);
        }
        if (k === 'dirClose') {
          if (!(await G.UI.confirm(`Close ${a.name}?`, 'Everyone in it goes back to the main menu.', 'Close room', true))) return;
          await this._relaySend('close', a.lid, {});
          this._log('Closed ' + a.name, 'ok');
          return G.UI.toast('Close sent.', 'info', false);
        }
        if (k === 'dirKick') {
          if (!(await G.UI.confirm(`Remove ${a.name}?`, "They're taken out of the room and can't rejoin it.", 'Remove', true))) return;
          await this._relaySend('kick', a.lid, { pid: a.pid });
          this._log('Removed ' + a.name, 'ok');
          return G.UI.toast('Remove sent.', 'info', false);
        }
      } catch (e) {
        this._log(`✗ ${k}: ${e.message}`, 'bad');
        G.UI.toast(e.message, 'bad');
      }
    },

    // Run a command: here if we host (or are solo), else signed, by the host.
    run(c) {
      if (G.Game.role === 'client') return this.send(c);
      return Promise.resolve(exec(c, G.Game.role ? G.Game.myPid : 'me'));
    },
    // One at a time, so the counter always arrives in order.
    send(c) {
      const p = (this._chain || Promise.resolve()).then(() => this._send(c));
      this._chain = p.catch(() => {});
      return p;
    },
    async _send(c, again) {
      const g = G.Game, net = g.net;
      if (!this.key) throw new Error('Locked.');
      if (!net || !net.open) throw new Error('Not connected to the host.');
      if (!this.nonce || this.nonceNet !== net) await this._getNonce(net);
      const seq = ++this.seq, cs = JSON.stringify(c);
      const sig = b64(await subtle().sign(SIG, this.key, enc.encode(signed(g.code, g.myPid, this.nonce, seq, cs))));
      const m = await new Promise((res, rej) => {
        const to = setTimeout(() => {
          this.wait.delete(seq);
          rej(new Error("The host didn't answer."));
        }, 5000);
        this.wait.set(seq, (x) => {
          clearTimeout(to);
          res(x);
        });
        net.sendCtrl({ t: 'ops_do', seq, c: cs, sig });
      });
      if (!m.ok && m.r === 'nonce' && !again) {
        this.nonce = null; // the host changed (migration) or forgot us: start again
        return this._send(c, true);
      }
      if (!m.ok) throw new Error(m.r || 'Refused.');
      return m.r;
    },
    _getNonce(net) {
      this.nonce = null;
      return new Promise((res, rej) => {
        const to = setTimeout(() => {
          this._nw = null;
          rej(new Error("The host didn't answer."));
        }, 4000);
        this._nw = () => {
          clearTimeout(to);
          res();
        };
        this.nonceNet = net;
        net.sendCtrl({ t: 'ops_n' });
      });
    },
    _fetch() {
      if (this._fetching || !this.key) return;
      this._fetching = true;
      this._fetchT = performance.now();
      this.send({ k: 'stats' })
        .then((r) => {
          if (r && typeof r === 'object') this.remote = r;
          this.remoteErr = null;
        }, (e) => (this.remoteErr = e.message))
        .then(() => (this._fetching = false));
    },
    // Messages from the host (game.js passes every 'ops_*' ctrl message here).
    onMsg(m) {
      if (m.t === 'ops_n' && typeof m.n === 'string') {
        this.nonce = m.n;
        this.seq = 0;
        if (this._nw) {
          const f = this._nw;
          this._nw = null;
          f();
        }
      } else if (m.t === 'ops_r') {
        const f = this.wait.get(m.seq);
        if (f) {
          this.wait.delete(m.seq);
          f(m);
        }
      } else if (m.t === 'ops_ann') this.banner(m.text); // announcements: everyone sees these
    },
  };

  G.Ops = Ops;
  window.addEventListener('load', () => Ops.init());
})(window.G);
