// ops.js — maintenance console for whoever maintains the game: live stats,
// room and driver controls, network test tools and announcements.
//
// Access: Ctrl+Shift+` (or hold the version badge on the menu for 3 s), then
// a passphrase. The passphrase decrypts a signing key (ECDSA P-256, wrapped
// with PBKDF2 -> AES-GCM in KEY below) into this tab's memory only; nothing
// is saved. In a room you host, commands run directly. In anyone else's room
// every command is signed — bound to that room's code, your seat, a one-time
// number from the host and a counter — and the host's game checks it against
// the public key before doing anything. So opening this panel from dev tools
// only ever affects your own screen.
'use strict';
(function (G) {
  const U = G.U;
  // From tools/ops-setup.html (kept local): the public key and the private key
  // encrypted with the passphrase. Useless without the passphrase. null = no
  // key in this build, and the shortcut does nothing.
  const KEY = { v: 1, it: 600000, pub: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEuzZVDmO+yJvQoRBDOV/x4f1RcUOUlUAFsNye3ZaS0M4JDdwTextkYgEWNrlVtv/THDu4yCdqoX4ow56UJe1UWQ==', salt: 'rHMr8xbH7cn1mYwbF3iLFw==', iv: 'Nte/zv3SD4bFYiAZ', ct: '/7LdoyirwbBD3OXj0WyK559WantxLt1C/HLoiMEziCx78rX2tN8j8gM7WM+GMHfP9lTNma1f9MhW762jlQoKvPL2jhxpEJibBYsu9ydH5VqmJe9uE9xjkiN2LX7iDwp/fZzv8pt8TosTElALUiKp2CVyUgYOcnPklS9NEdaDiZlrfxpJXY5IvPNc/dNKj2EMpe+Jn9k5KA9Qvg==' };

  const enc = new TextEncoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const EC = { name: 'ECDSA', namedCurve: 'P-256' };
  const SIG = { name: 'ECDSA', hash: 'SHA-256' };
  const subtle = () => (window.crypto && crypto.subtle) || null; // https / localhost only
  const signed = (code, pid, n, seq, c) => `ss-ops1|${code}|${pid}|${n}|${seq}|${c}`;

  async function openKey(K, pass) {
    const S = subtle();
    const base = await S.importKey('raw', enc.encode(String(pass).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    const wk = await S.deriveKey({ name: 'PBKDF2', salt: unb64(K.salt), iterations: K.it, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const raw = await S.decrypt({ name: 'AES-GCM', iv: unb64(K.iv) }, wk, unb64(K.ct));
    return S.importKey('pkcs8', raw, EC, false, ['sign']);
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
      const v = U.clamp(+c.v || 0.9, 0.6, 1.1);
      for (const b of X.s.bots()) b.botSkill = v;
      return `Bot skill ${Math.round(v * 100)}% (from the next race).`;
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
      players: (st.order || Object.keys(st.players)).map((id) => st.players[id]).filter(Boolean).map((p) => {
        const L = net && net.byPid ? net.byPid.get(p.id) : null;
        return {
          id: p.id, name: p.name, bot: !!p.isBot, on: !!(p.isBot || p.connected || p.id === st.hostId || p.id === 'me'), host: p.id === st.hostId,
          money: p.money, car: p.carId, rtt: L ? Math.round(L.rtt || 0) : null, via: L ? (L.ctrl && L.ctrl.route ? 'relay' : 'direct') : null,
          muted: !!(s._opsMuted && s._opsMuted.has(p.id)),
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

  // ------------------------------------------------------------------ panel
  const TABS = [['stats', 'Stats'], ['room', 'Room'], ['players', 'Drivers'], ['hist', 'History'], ['debug', 'Tools'], ['log', 'Log']];
  const enc64 = (a) => encodeURIComponent(JSON.stringify(a || {}));
  const btn = (k, label, cls, a) => `<button class="btn small ${cls || ''}" data-o="cmd" data-k="${k}" data-a="${enc64(a)}">${label}</button>`;
  const btnL = (k, label, cls, a) => `<button class="btn small ${cls || ''}" data-o="loc" data-k="${k}" data-a="${enc64(a)}">${label}</button>`;
  const kv = (rows) => '<div class="kv">' + rows.filter(Boolean).map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('') + '</div>';
  const pct = (v, d) => ((v || 0) * 100).toFixed(d || 0) + '%';
  const trackName = (id) => {
    const t = id && G.TrackDefs.byId(id);
    return t ? U.esc(t.name) : '—';
  };

  function myRs() {
    const g = G.Game;
    if (G.App.mode === 'drive' && G.App.sim && G.App.sim.byId.me) return G.App.sim.byId.me.st;
    if (g.hostRace && g.hostRace.sim.byId[g.myPid]) return g.hostRace.sim.byId[g.myPid].st;
    return g.lastView && g.lastView.me ? g.lastView.me.rs : null;
  }

  function statsHtml() {
    const w = G.App.world, ws = w ? w.stats() : null, g = G.Game, st = G.Client.state, A = G.Audio;
    const z = getComputedStyle(document.documentElement).getPropertyValue('--uiz').trim() || '1';
    let h = '<h4>Performance</h4>' + kv([
      ['Frame rate', ws ? `${ws.fps.toFixed(0)} fps · render call ${ws.ms.toFixed(1)} ms` : '—'],
      ['Drawing', ws ? `${ws.calls} calls · ${(ws.tris / 1000).toFixed(0)}k tris · ${ws.parts} particles` : '—'],
      ['Quality', ws ? `${ws.tier} · step-down level ${ws.level} · pixel ratio ${ws.pr.toFixed(2)}` : '—'],
      ['GPU', ws ? U.esc(String(ws.gpu || '?').replace(/^ANGLE \(/, '').slice(0, 64)) : '—'],
      ['JS heap', performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB' : '—'],
      ['Screen', `${innerWidth}×${innerHeight} · dpr ${devicePixelRatio} · menus ${(+z).toFixed(2)}× · HUD ${((G.App.hud && G.App.hud.z) || 1).toFixed(2)}×`],
      ['Audio', A && A.ctx ? `${A.ctx.state} · ${A.others.length} car voices` : 'off'],
    ]);
    const net = g.net, rows = [['Role', g.role ? (g.role === 'host' ? 'host' : 'joiner') + (g.code ? ' · room ' + U.esc(g.code) : '') : 'solo']];
    if (g.role === 'client' && net) rows.push(['Link', `${net.via || '?'} · ping ${Math.round(net.rtt || 0)} ms`]);
    if (g.role === 'host' && net && net.byPid) {
      const ls = Array.from(net.byPid.values());
      const relay = ls.filter((L) => L.ctrl && L.ctrl.route).length;
      rows.push(['Links', `${ls.length} (${relay} relay) · avg ping ${ls.length ? Math.round(ls.reduce((a, L) => a + (L.rtt || 0), 0) / ls.length) : 0} ms`]);
    }
    if (g.clientRace) {
      const s = g.clientRace.stats;
      rows.push(['Snapshots', `${s.snaps} in · ${s.snapsDropped} late or dropped`], ['Prediction', `last error ${s.lastErr.toFixed(2)} m · ${s.corrections} corrections`]);
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
        ['Phase', st.phase + (left ? ` · ${left} s left` : '')],
        ['Races', `${st.raceNo || 0} of ${st.settings.races} done · next ${trackName((st.schedule || [])[nextIdx(st)])}`],
        ['Drivers', `${hs.filter((p) => p.connected).length}/${hs.length} online · ${Object.keys(st.players).length - hs.length} bots`],
        ['Next hosts', (st.heirs || []).map((id) => (st.players[id] ? U.esc(st.players[id].name) : id)).join(', ') || '—'],
        ['Room', `${st.settings.vis} · max ${st.settings.maxPlayers || 8}${st.settings.name ? ' · ' + U.esc(st.settings.name) : ''}`],
        H && ['Idle', `${H.idle} s since anyone played${H.lobby ? ` · ${H.lobby} s in the lobby` : ''}`],
      ]);
    }
    const rs = myRs();
    if (rs) {
      const sp = Math.hypot(rs.vx || 0, rs.vz || 0);
      h += '<h4>My car</h4>' + kv([
        ['Speed', `${(sp * 3.6).toFixed(0)} km/h · revs ${pct(rs.rpm)} · gear ${rs.gear}`],
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
    let h = '<h4>Race</h4><div class="row">' + btn('endRace', '🏁 End race') + btn('skipCd', '🚦 Skip countdown', 'ghost') + (g.role ? btn('advance', '⏭ Skip phase', 'ghost') : '') + '</div>';
    if (!g.role) return h + `<p class="note">${X && X.sim ? 'Practice: these act on your drive.' : 'Room controls appear in a room you host or join.'}</p>`;
    if (!S) return h + `<p class="note">${O.remoteErr ? U.esc(O.remoteErr) : 'Asking the host…'}</p>`;
    h += `<div class="row"><select data-f="track">${G.TrackDefs.TRACKS.map((t) => `<option value="${t.id}"${S.next === t.id ? ' selected' : ''}>${U.esc(t.name)}</option>`).join('')}</select>${btn('nextTrack', 'Set as next track', 'ghost')}</div>`;
    h += '<h4>Room</h4>';
    h += `<div class="row">${btn('vis', S.vis === 'public' ? '🌐 Public · make private' : '🔒 Private · make public', 'ghost', { v: S.vis === 'public' ? 'private' : 'public' })}</div>`;
    h += `<div class="row">Max drivers ${btn('max', '−', 'ghost', { n: S.max - 1 })}<b class="num">${S.max}</b>${btn('max', '+', 'ghost', { n: S.max + 1 })}<span class="sp"></span>Bots ${btn('bots', '−', 'ghost', { n: S.bots - 1 })}<b class="num">${S.bots}</b>${btn('bots', '+', 'ghost', { n: S.bots + 1 })}</div>`;
    h += `<div class="row">Bot skill <select data-f="skill"><option value="0.8">Easy</option><option value="0.9" selected>Normal</option><option value="1">Hard</option><option value="1.06">Brutal</option></select>${btn('botSkill', 'Set', 'ghost')}</div>`;
    h += `<div class="row">${btn('extend', '⏳ Reset idle timers', 'ghost')}${btn('unban', `Clear bans (${S.banned})`, 'ghost')}${btn('close', '✖ Close room', 'red')}</div>`;
    h += '<h4>Announce</h4><div class="row"><input data-f="ann" maxlength="140" placeholder="A message on everyone\'s screen" class="grow">' + btn('announce', 'Send', 'primary') + '</div>';
    return h;
  }

  function playersHtml(O, S) {
    if (!S) return `<p class="note">${O.remoteErr ? U.esc(O.remoteErr) : 'Asking the host…'}</p>`;
    const rows = S.players
      .map((p) => `<div class="pl${O.sel === p.id ? ' sel' : ''}" data-o="sel" data-id="${U.esc(p.id)}"><span class="${p.on ? '' : 'off'}">${p.host ? '👑 ' : p.bot ? '⚙ ' : ''}${U.esc(p.name.replace(' ⚙', ''))}${p.muted ? ' 🔇' : ''}</span><b>${U.fmtMoney(p.money)}</b><em>${p.bot ? 'bot' : !p.on ? 'offline' : p.rtt != null ? `${p.rtt} ms ${p.via}` : ''}</em></div>`)
      .join('');
    const t = S.players.find((p) => p.id === O.sel);
    let act = '<p class="note">Pick a driver.</p>';
    if (t) {
      const a = { pid: t.id };
      act = `<h4>${U.esc(t.name)}</h4>
        <div class="row">${btn('money', '+$1,000', 'ghost', { pid: t.id, v: 1000 })}${btn('money', '+$10,000', 'ghost', { pid: t.id, v: 10000 })}${btn('money', '−$1,000', 'ghost', { pid: t.id, v: -1000 })}<input data-f="money" type="number" min="0" step="100" placeholder="$ amount" class="w90">${btn('moneySet', 'Set', 'ghost', a)}</div>
        <div class="row"><select data-f="car">${G.Parts.CAR_ORDER.map((id) => `<option value="${id}">${U.esc(G.Parts.CARS[id].name)}</option>`).join('')}</select>${btn('giveCar', 'Give car', 'ghost', a)}${btn('giveParts', 'Every part', 'ghost', a)}${btn('repair', 'Repair', 'ghost', a)}</div>
        <div class="row">${btn('respawn', 'Respawn', 'ghost', a)}${t.bot ? '' : btn('mute', t.muted ? 'Unmute' : 'Mute chat', 'ghost', a) + (t.host ? '' : btn('kick', 'Kick & ban', 'red', a))}</div>`;
    }
    return `<div class="pls">${rows}</div>${act}`;
  }

  function debugHtml(O) {
    const sn = G.NetSim || {}, s = G.Settings.s, g = G.Game;
    return `<h4>Network simulator</h4><p class="note">Adds lag and loss to what this browser sends as a joiner, to test the netcode.</p>
      <div class="row">Lag <input data-f="lag" type="number" min="0" max="1000" step="10" value="${sn.lag || 0}" class="w64"> ms ± <input data-f="jit" type="number" min="0" max="500" step="10" value="${sn.jitter || 0}" class="w64"> loss <input data-f="loss" type="number" min="0" max="50" value="${Math.round((sn.loss || 0) * 100)}" class="w52">%</div>
      <div class="row">${btnL('simApply', 'Apply')}${btnL('simOff', 'Off', 'ghost')}<label class="tog"><input type="checkbox" data-o="relay"${sn.forceRelay ? ' checked' : ''}><span></span>Next join uses the relay</label></div>
      <div class="row">${g.role === 'client' ? btnL('dropLink', 'Drop my link (test reconnect)', 'ghost') : ''}${g.role === 'host' ? btnL('dropHost', 'Drop out as host (test migration)', 'ghost') : ''}${!g.role ? '<span class="note">Link tests appear in a room.</span>' : ''}</div>
      <h4>Practice</h4><div class="row">Time ${[0.25, 0.5, 1, 2].map((v) => btnL('time', v + '×', O.timeScale === v ? '' : 'ghost', { v })).join('')}</div>
      <h4>Display</h4><div class="row">Frame cap ${[0, 30, 60].map((v) => btnL('cap', v ? v + ' fps' : 'off', O.fpsCap === v ? '' : 'ghost', { v })).join('')}</div>
      <div class="row">Quality ${['auto', 'high', 'medium', 'low'].map((v) => btnL('quality', v, s.quality === v ? '' : 'ghost', { v })).join('')}</div>
      <div class="row">${btnL('fps', s.showFps ? 'Hide FPS counter' : 'Show FPS counter', 'ghost')}</div>
      <h4>Sounds</h4><div class="row">${['request', 'join', 'leave', 'drop', 'host', 'warn', 'notify'].map((k) => btnL('snd', k, 'ghost', { v: k })).join('')}${btnL('snd', 'blow-off', 'ghost', { v: 'blowoff' })}${btnL('snd', 'flutter', 'ghost', { v: 'flutter' })}</div>`;
  }

  function logHtml(O) {
    const t = (at) => new Date(at).toTimeString().slice(0, 8);
    return `<div class="row">${btnL('logClear', 'Clear', 'ghost')}<span class="note">${O.logs.length} lines · errors, joins and drops, commands</span></div>` +
      O.logs.slice(-150).reverse().map((l) => `<div class="lg ${l.kind}">${t(l.at)} ${U.esc(l.txt)}</div>`).join('');
  }

  // ----------------------------------------------------------- room history
  // There is no server, so this is a diary of the rooms THIS browser hosted or
  // joined: when, how long, who was in them and what they raced. It runs for
  // everyone, but is only written to disk on a computer where the passphrase
  // has been used — every other player's game still keeps nothing.
  const HKEY = 'ss.ops.hist', HON = 'ss.ops.on';
  const Hist = {
    rooms: [], // oldest first
    seen: {}, // public rooms noticed on the server list
    cur: null,
    load() {
      const d = U.store.get(HKEY, null);
      if (d && Array.isArray(d.rooms)) {
        this.rooms = d.rooms;
        this.seen = d.seen || {};
      }
    },
    kept() {
      return !!U.store.get(HON, 0);
    },
    save() {
      if (!this.kept()) return;
      U.store.set(HKEY, { rooms: this.rooms.slice(-40), seen: this.seen });
    },
    keep() {
      U.store.set(HON, 1);
      this.save();
    },
    clear() {
      this.rooms = [];
      this.seen = {};
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
            if (this.rooms.length > 40) this.rooms.shift();
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
            } else r._t = 0;
          }
          if (st.results && st.results.no !== c.lastRes) {
            c.lastRes = st.results.no;
            const w = (st.results.rows || [])[0];
            c.races.push({ no: st.results.no, track: st.results.trackId, winner: w ? w.name : '?', at: now });
          }
          if (st.final && !c.final) c.final = (st.final.rows || []).slice(0, 8).map((r) => ({ name: r.name, worth: r.worth }));
        }
        if (now - (this._saveT || 0) > 10000) {
          this._saveT = now;
          this.save();
        }
      } else if (this.cur) this.end(now);
      // public rooms on the server list, while that screen is open
      const scr = G.UI.screens && G.UI.screens.rooms;
      const board = scr && scr.board;
      if (board && board.list) {
        for (const r of board.list()) {
          const id = r.code || r.lid;
          if (!id) continue;
          const s = this.seen[id] || (this.seen[id] = { first: now });
          if (r.name) s.name = r.name;
          if (r.host || r.hostName) s.host = r.host || r.hostName;
          const n = r.players != null ? r.players : r.n;
          if (n != null) s.players = n;
          if (r.vis) s.vis = r.vis;
          s.last = now;
        }
      }
    },
  };

  const fmtSecs = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  };
  function histHtml(O) {
    const now = Date.now();
    const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const rooms = Hist.rooms.slice().reverse();
    const sel = rooms.find((r) => r.t0 === O.hsel) || null;
    let h = `<div class="row">${btnL('histCopy', 'Copy all', 'ghost')}${btnL('histClear', 'Clear', 'ghost')}<span class="note">${Hist.kept() ? 'kept on this computer' : 'this visit only'} · ${rooms.length} room${rooms.length === 1 ? '' : 's'}</span></div>`;
    if (!rooms.length) h += '<p class="note">Rooms you host or join are listed here, with who was in them.</p>';
    else
      h += '<div class="pls">' + rooms
          .map((r) => `<div class="pl${sel && sel.t0 === r.t0 ? ' sel' : ''}" data-o="loc" data-k="histSel" data-a="${enc64({ v: r.t0 })}"><span>${r.role === 'host' ? '👑 ' : ''}${U.esc(r.code || '?')}${r.name ? ' · ' + U.esc(r.name) : ''}</span><b>${Object.keys(r.players || {}).length}</b><em>${r.t1 ? fmtSecs(r.t1 - r.t0) : 'open now'}</em></div>`)
          .join('') + '</div>';
    if (sel) {
      const ps = Object.values(sel.players || {}).sort((a, b) => (b.ms || 0) - (a.ms || 0));
      h += `<h4>${U.esc(sel.code || '')}${sel.name ? ' · ' + U.esc(sel.name) : ''}</h4>` + kv([
        ['Opened', when(sel.t0)],
        ['Lasted', fmtSecs((sel.t1 || now) - sel.t0) + (sel.t1 ? ' · ended ' + when(sel.t1) : ' · still open')],
        ['You were', sel.role === 'host' ? 'the host' : 'a driver'],
        ['Host', U.esc(sel.host || '—')],
        ['Room', `${sel.vis || '?'} · max ${sel.max || '?'} · ${sel.bots || 0} bots · ${sel.total || '?'} races`],
      ]);
      h += '<h4>Drivers</h4><div class="kv">' +
        ps.map((p) => `<span>${U.esc(p.name)}${p.bot ? ' ⚙' : ''}</span><b>${fmtSecs(p.ms || 0)} · ${U.fmtMoney(p.money || 0)}</b>`).join('') + '</div>';
      if ((sel.races || []).length)
        h += '<h4>Races</h4><div class="kv">' + sel.races.map((x) => `<span>${x.no}. ${trackName(x.track)}</span><b>won by ${U.esc(x.winner || '?')}</b>`).join('') + '</div>';
      if (sel.final)
        h += '<h4>Final standings</h4><div class="kv">' + sel.final.map((f, i) => `<span>${i + 1}. ${U.esc(f.name)}</span><b>${U.fmtMoney(f.worth)}</b>`).join('') + '</div>';
    }
    const seen = Object.entries(Hist.seen || {});
    if (seen.length)
      h += '<h4>Public rooms seen</h4><div class="kv">' +
        seen.sort((a, b) => (b[1].last || 0) - (a[1].last || 0)).slice(0, 12)
          .map(([code, s]) => `<span>${U.esc(code)}${s.name ? ' · ' + U.esc(s.name) : ''}</span><b>${s.players != null ? s.players + ' in · ' : ''}${when(s.last || s.first)}</b>`)
          .join('') + '</div>';
    return h;
  }

  const CSS = `
#ops { position: fixed; top: 56px; right: 10px; z-index: 72; width: 410px; max-height: calc(86vh / var(--uiz, 1)); display: flex; flex-direction: column; zoom: var(--uiz, 1);
  background: rgba(13,18,33,.97); border-radius: 16px; box-shadow: 0 18px 50px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,204,0,.35); font-family: var(--body); font-size: 13px; color: var(--ink); }
#ops[hidden] { display: none; }
#ops .op-h { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 10px 10px 8px 14px; border-bottom: 1px solid var(--line); }
#ops .op-h > b { font: 400 15px var(--display); color: var(--yellow); letter-spacing: 3px; }
#ops .op-w { margin-right: auto; color: var(--muted); font-size: 11px; font-weight: 900; }
#ops .op-x { width: 28px; height: 28px; border: 0; border-radius: 8px; background: rgba(255,255,255,.08); color: var(--ink); cursor: pointer; }
#ops .op-tabs { display: flex; gap: 4px; width: 100%; }
#ops .op-tabs button { flex: 1; padding: 6px 4px; border: 0; border-radius: 8px; background: rgba(255,255,255,.06); color: var(--muted); font: 900 12px var(--body); cursor: pointer; }
#ops .op-tabs button.on { background: var(--yellow); color: #1a1300; }
#ops .op-b { overflow: auto; padding: 4px 12px 12px; }
#ops h4 { margin: 12px 0 5px; font: 400 12px var(--display); color: var(--cyan); letter-spacing: 1px; text-transform: uppercase; }
#ops .kv { display: grid; grid-template-columns: 112px 1fr; gap: 3px 10px; font-variant-numeric: tabular-nums; }
#ops .kv span { color: var(--muted); }
#ops .kv b { font-weight: 800; overflow-wrap: anywhere; }
#ops .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 5px 0; }
#ops .row .sp { width: 10px; }
#ops .num { min-width: 18px; text-align: center; font-variant-numeric: tabular-nums; }
#ops .btn.small { padding: 5px 9px; font-size: 12px; }
#ops input, #ops select { padding: 4px 7px; border: 1px solid rgba(255,255,255,.18); border-radius: 7px; background: #0b1020; color: var(--ink); font: 700 12px var(--body); }
#ops input:focus, #ops select:focus { outline: none; border-color: var(--yellow); }
#ops .grow { flex: 1; min-width: 0; } #ops .w90 { width: 90px; } #ops .w64 { width: 64px; } #ops .w52 { width: 52px; }
#ops .tog { font-size: 12px; gap: 8px; }
#ops .pls { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
#ops .pl { display: grid; grid-template-columns: 1fr auto 86px; gap: 8px; align-items: center; padding: 5px 8px; border-radius: 8px; cursor: pointer; }
#ops .pl:hover { background: rgba(255,255,255,.05); }
#ops .pl.sel { background: rgba(255,204,0,.13); box-shadow: inset 0 0 0 1px rgba(255,204,0,.5); }
#ops .pl b { font-variant-numeric: tabular-nums; }
#ops .pl em { font-style: normal; color: var(--muted); font-size: 11px; text-align: right; }
#ops .pl .off { opacity: .5; }
#ops .lg { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,.04); color: #c9d3ea; font: 11px/1.35 ui-monospace, Consolas, monospace; overflow-wrap: anywhere; }
#ops .lg.bad { color: #ff8a80; } #ops .lg.warn { color: #ffd66b; } #ops .lg.ok { color: #8ff0b4; }
#ops .note { margin: 4px 0; color: var(--muted); font-size: 11.5px; line-height: 1.35; }
#ops-ann { position: fixed; left: 50%; top: 64px; z-index: 71; zoom: var(--uiz, 1); max-width: min(720px, calc(90vw / var(--uiz, 1))); padding: 12px 20px; border: 2px solid var(--yellow); border-radius: 14px;
  background: rgba(14,19,34,.95); color: #fff; font: 900 18px var(--body); text-align: center; box-shadow: 0 10px 34px rgba(0,0,0,.5); pointer-events: none; opacity: 0; transform: translate(-50%, -12px); transition: opacity .25s, transform .25s; }
#ops-ann.on { opacity: 1; transform: translate(-50%, 0); }`;

  const Ops = {
    KEY,
    key: null, // the unlocked signing key: this tab's memory only
    open: false,
    tab: 'stats',
    sel: null,
    logs: [],
    timeScale: 1, // practice only (main.js)
    fpsCap: 0, // main.js
    nonce: null,
    nonceNet: null,
    seq: 0,
    wait: new Map(),
    remote: null,

    init() {
      const css = document.createElement('style');
      css.textContent = CSS;
      document.head.appendChild(css);
      const el = (this.el = document.createElement('div'));
      el.id = 'ops';
      el.hidden = true;
      el.innerHTML = `<div class="op-h"><b>OPS</b><span class="op-w"></span><button class="op-x" data-o="lock" title="Lock (forget the key)">🔒</button><button class="op-x" data-o="hide" title="Hide (Ctrl+Shift+\`)">✕</button><div class="op-tabs">${TABS.map(([k, l]) => `<button data-o="tab" data-t="${k}">${l}</button>`).join('')}</div></div><div class="op-b"></div>`;
      document.body.appendChild(el);
      this.whereEl = el.querySelector('.op-w');
      this.body = el.querySelector('.op-b');
      el.addEventListener('click', (e) => this._click(e));
      el.addEventListener('change', (e) => {
        if (e.target.dataset.o === 'relay' && G.NetSim) G.NetSim.forceRelay = e.target.checked;
      });
      el.addEventListener('keydown', (e) => {
        e.stopPropagation(); // typing in here never drives, mutes or opens the chat
        if (e.key === 'Enter' && e.target.dataset.f === 'ann') {
          const b = el.querySelector('[data-k="announce"]');
          if (b) b.click();
        } else if (e.key === 'Escape') this.hide();
      });
      window.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.code === 'Backquote') {
          e.preventDefault();
          this.toggle();
        }
      });
      // no keyboard (touch): hold the version badge on the main menu for 3 s
      let holdT = null;
      document.addEventListener('pointerdown', (e) => {
        if (!e.target.closest || !e.target.closest('.logo .ver')) return;
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
        if (!this._held || !e.target.closest || !e.target.closest('.logo .ver')) return;
        this._held = false; // (that long press isn't also a "What's new" click)
        e.stopImmediatePropagation();
        e.preventDefault();
      }, true);
      window.addEventListener('error', (e) => this._log((e.message || 'Error') + (e.filename ? ` (${e.filename.split('/').pop().split('?')[0]}:${e.lineno})` : ''), 'bad'));
      window.addEventListener('unhandledrejection', (e) => this._log('Unhandled: ' + ((e.reason && e.reason.message) || e.reason), 'bad'));
      setInterval(() => this._tick(), 500);
      // the room diary runs whether or not anyone unlocks (never breaks the game)
      Hist.load();
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
        this.key = await openKey(this.KEY, pass);
        this._log('Unlocked', 'ok');
        Hist.keep(); // from now on this computer keeps the room history
        return true;
      } catch (e) {
        return false;
      }
    },
    show() {
      this.open = true;
      this.el.hidden = false;
      this._key = null;
      this.render(true);
    },
    hide() {
      this.open = false;
      this.el.hidden = true;
    },
    lock() {
      this.key = null;
      this.nonce = null;
      this.remote = null;
      this.hide();
      G.UI.toast('Locked.', 'info', false);
    },

    // -------------------------------------------------------- display
    _tick() {
      if (!this.key) return;
      this._chatScan();
      if (!this.open) return;
      if (G.Game.role === 'client' && this.tab !== 'debug' && this.tab !== 'log' && performance.now() - (this._fetchT || 0) > 2000) this._fetch();
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
    render(force) {
      if (!this.open) return;
      const g = G.Game;
      this.whereEl.textContent = g.role === 'host' ? 'hosting ' + (g.code || '') : g.role === 'client' ? 'joined ' + (g.code || '') : G.App.mode || '';
      for (const b of this.el.querySelectorAll('.op-tabs button')) b.classList.toggle('on', b.dataset.t === this.tab);
      let html;
      if (this.tab === 'stats') html = statsHtml();
      else if (this.tab === 'log') html = logHtml(this);
      else if (this.tab === 'hist') html = histHtml(this);
      else {
        // Room / Drivers / Tools re-render only when their data changes (a
        // re-render would reset a half-picked dropdown or a typed amount)
        const S = this.tab === 'debug' ? null : this._S();
        const key = [this.tab, this.sel, g.role, !!(ctx() && ctx().sim), this.remoteErr, S && JSON.stringify(Object.assign({}, S, { idle: 0, lobby: 0 })), this.tab === 'debug' && JSON.stringify([G.NetSim, this.timeScale, this.fpsCap, G.Settings.s.quality, G.Settings.s.showFps]), force && Math.random()].join('|');
        if (key === this._key) return;
        this._key = key;
        html = this.tab === 'room' ? roomHtml(this, S) : this.tab === 'players' ? playersHtml(this, S) : debugHtml(this);
      }
      G.UI.patch(this.body, html);
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
        this.render(true);
      } else if (o === 'hide') this.hide();
      else if (o === 'lock') this.lock();
      else if (o === 'sel') {
        this.sel = b.dataset.id;
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
      if (k === 'nextTrack') c.id = f('track').value;
      if (k === 'botSkill') c.v = +f('skill').value;
      if (k === 'announce') c.text = f('ann').value;
      if (k === 'giveCar') c.car = f('car').value;
      if (k === 'moneySet') Object.assign(c, { k: 'money', set: 1, v: +f('money').value });
      if (k === 'close' && !(await G.UI.confirm('Close this room?', 'Everyone goes back to the main menu.', 'Close room', true))) return;
      if (k === 'kick' && !(await G.UI.confirm('Kick and ban?', "They can't come back into this room.", 'Kick', true))) return;
      b.disabled = true;
      try {
        const r = await this.run(c);
        this._log(`✓ ${c.k}: ${r}`, 'ok');
        G.UI.toast(String(r), 'info', false);
        if (k === 'announce') f('ann').value = '';
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
      if (k === 'simApply' && sn) {
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
        else if (a.v === 'flutter') G.Audio.flutter(1);
        else {
          G.Audio._ntT = 0;
          G.Audio.notify(a.v);
        }
      } else if (k === 'logClear') this.logs = [];
      else if (k === 'histSel') this.hsel = this.hsel === a.v ? null : a.v;
      else if (k === 'histClear') {
        Hist.clear();
        this.hsel = null;
      } else if (k === 'histCopy') {
        const text = JSON.stringify({ rooms: Hist.rooms, seen: Hist.seen }, (kk, v) => (kk === '_t' ? undefined : v), 1);
        navigator.clipboard.writeText(text).then(() => G.UI.toast('History copied.', 'info', false), () => G.UI.toast('Could not copy.', 'bad'));
      }
      if (!['snd', 'logClear', 'histSel', 'histCopy'].includes(k)) this._log('· ' + k + (a.v != null ? ' ' + a.v : ''));
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
