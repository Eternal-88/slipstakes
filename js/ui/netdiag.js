// netdiag.js — v5.5.5 connection report (Esc → 📶 Connection).
//
// What a player can copy and paste to whoever runs the room when their
// connection misbehaves: versions, host or joiner, direct or relay, ping,
// how many of the host's updates are arriving, every drop and reconnect with
// its reason, recent errors, and the device. It is kept in this tab's memory
// only and sent nowhere: the "Copy" button puts it on the clipboard, and
// that's all. (A reload counter lives in sessionStorage, so a tab that
// crashed and came back shows up in the report.)
'use strict';
(function (G) {
  const U = G.U;
  const MAX_EV = 60;
  const WIN = 10000; // ms: "in the last 10 s"

  const clock = (t) => {
    const d = new Date(t);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  };
  const WHY = {
    silent: 'no word from the host for 10 s',
    closed: 'the link closed',
    error: 'link error',
    'host-left': 'the host left',
    timeout: 'no word from them for 20 s',
    close: 'their link closed',
    replaced: 'replaced by a newer connection',
    kicked: 'removed by the host',
    outdated: 'their game is an older version',
    rejected: 'turned away',
  };

  let loads = 1;
  try {
    loads = (+sessionStorage.getItem('ss.loads') || 0) + 1;
    sessionStorage.setItem('ss.loads', String(loads));
  } catch (e) {}

  const D = {
    born: Date.now(),
    loads,
    events: [], // {at, text}
    errors: [], // {at, text}
    lost: 0, // times we lost the host (joiner)
    snaps: [], // arrival times of the host's snapshots (joiner)
    inputs: new Map(), // pid -> arrival times of their inputs (host)
    players: new Map(), // pid -> {ver, since, drops, last} (host)

    note(text) {
      this.events.push({ at: Date.now(), text: String(text) });
      if (this.events.length > MAX_EV) this.events.shift();
      if (G.Overlay && G.Overlay.isOpen && G.Overlay.view === 'conn') G.Overlay.render();
    },
    why(w) {
      return WHY[w] || String(w || 'unknown');
    },
    // joiner: a snapshot arrived / host: a player's input arrived
    snap(now) {
      this.snaps.push(now);
      if (this.snaps.length > 800) this.snaps.splice(0, 300);
    },
    input(pid, now) {
      let a = this.inputs.get(pid);
      if (!a) this.inputs.set(pid, (a = []));
      a.push(now);
      if (a.length > 800) a.splice(0, 300);
    },
    rate(a, now) {
      let n = 0;
      for (let i = a.length - 1; i >= 0 && now - a[i] <= WIN; i--) n++;
      return n / (WIN / 1000);
    },
    // host side: a player joined / dropped
    joined(pid, name, ver, route, back) {
      const p = this.players.get(pid) || { drops: 0, last: '' };
      p.ver = ver || 'older than 5.5.5';
      p.since = Date.now();
      p.name = name;
      this.players.set(pid, p);
      this.note(`${name} ${back ? 'is back' : 'joined'} (${route}, v${p.ver})`);
    },
    dropped(pid, name, why) {
      const p = this.players.get(pid) || { drops: 0 };
      p.drops++;
      p.last = this.why(why);
      p.name = name || p.name;
      this.players.set(pid, p);
      this.note(`${p.name || pid} dropped: ${p.last}`);
    },

    // ---------------------------------------------------------- the report
    device() {
      const ua = navigator.userAgent || '';
      const os = /CrOS/.test(ua) ? 'ChromeOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
      const br = (ua.match(/(Edg|Chrome|Firefox|Version)\/(\d+)/) || [])[0] || 'unknown browser';
      const w = G.App && G.App.world;
      const gpu = w && w.gpu ? w.gpu.name.replace(/^ANGLE \(|\)$/g, '').replace(/\s*\(0x[0-9a-f]+\)|Direct3D\S*|\b[vp]s_\S+|,\s*D3D\d+/gi, '').replace(/[\s,]+$/, '').replace(/\s{2,}/g, ' ').slice(0, 70) : '?';
      return `${os} · ${br.replace('Edg', 'Edge').replace('/', ' ')} · ${navigator.hardwareConcurrency || '?'} cores · ${navigator.deviceMemory ? navigator.deviceMemory + ' GB' : '? GB'} · ${gpu} · ${innerWidth}x${innerHeight} @${(devicePixelRatio || 1).toFixed(2)}`;
    },
    // plain lines, used for the panel and for the clipboard
    lines() {
      const g = G.Game, st = G.Client && G.Client.state, now = performance.now();
      const L = [];
      L.push(`SLIPSTAKES connection report · ${new Date().toLocaleString()}`);
      L.push(`Version: ${G.VERSION}${g.role === 'client' ? ` · host on ${g.hostVer || 'an older version (5.5.4 or before)'}` : ''}`);
      const me = st && st.players && st.players[G.Client.meId];
      if (!g.role) L.push('Not in a room.');
      else {
        L.push(`Role: ${g.role === 'host' ? 'host' : 'joiner'} in room ${g.code || '?'}${me ? ` as ${me.name}` : ''} · phase ${st ? st.phase : '?'}${st && st.phase === 'race' && st.race ? ' (race ' + st.race.no + ')' : ''}`);
        if (g.role === 'client') {
          const n = g.net;
          const relay = n && n.via === 'relay';
          if (g.lost) L.push(`Link: RECONNECTING (${this.why(g.lost.why)}, ${Math.round((Date.now() - g.lost.since) / 1000)} s, try ${g.lost.tries})`);
          else if (n) {
            const bid = relay && n.fast && n.fast.bid ? ' via ' + n.fast.bid : '';
            L.push(`Link: ${relay ? 'backup relay' + bid : 'direct (WebRTC)'} · ping ${Math.round(n.rtt || 0)} ms · ${n.stalls || 0} freezes of this tab`);
          }
          if (g.clientRace && st && st.phase === 'race') {
            const got = this.rate(this.snaps, now), want = relay ? 22 : 30;
            L.push(`Host updates: ${got.toFixed(1)}/s of about ${want}/s in the last 10 s (${Math.min(100, Math.round((got / want) * 100))}%) · ${g.clientRace.stats.snapsDropped || 0} arrived out of order · ${(G.NetStat && G.NetStat.skipped) || 0} held back (link backed up)`);
          }
          L.push(`Lost the host: ${this.lost} time${this.lost === 1 ? '' : 's'} this session`);
        } else if (g.role === 'host' && g.net) {
          const n = g.net;
          L.push(`Hosting: ${n.relayOnly ? 'backup relay only (the matchmaking server is blocked here)' : 'direct + backup relay'} · ${n.stalls || 0} freezes of this tab`);
          const racing = st && st.phase === 'race';
          for (const [pid, Lk] of n.byPid) {
            const p = st && st.players[pid];
            const d = this.players.get(pid) || {};
            const route = n.route(pid) === 'relay' ? 'relay' + (Lk.fast && Lk.fast.bid ? ' ' + Lk.fast.bid : '') : 'direct';
            const inp = racing && g.hostRace && g.hostRace.sim.byId[pid] ? ` · inputs ${Math.round((this.rate(this.inputs.get(pid) || [], now) / 30) * 100)}%` : '';
            L.push(`  ${p ? p.name : pid}: ${route} · ping ${Math.round(Lk.rtt || 0)} ms${inp} · v${Lk.ver || d.ver || '?'} · drops ${d.drops || 0}${d.last ? ' (last: ' + d.last + ')' : ''}`);
          }
          if (!n.byPid.size) L.push('  nobody else connected');
        }
      }
      const w = G.App && G.App.world, ws = w && w.stats ? w.stats() : null;
      if (ws) L.push(`Frame rate: ${Math.round(ws.fps)} fps · graphics ${ws.tier}${ws.level ? ' (auto-lowered ' + ws.level + ' steps)' : ''}`);
      L.push(`Device: ${this.device()}`);
      L.push(`This tab: open ${Math.round((Date.now() - this.born) / 60000)} min · loaded ${this.loads} time${this.loads === 1 ? '' : 's'} this session${this.loads > 1 ? ' (reloaded or crashed)' : ''}`);
      L.push('Events:');
      if (!this.events.length) L.push('  none yet');
      for (const e of this.events.slice(-25)) L.push(`  ${clock(e.at)} ${e.text}`);
      L.push(`Errors: ${this.errors.length ? '' : 'none'}`);
      for (const e of this.errors.slice(-6)) L.push(`  ${clock(e.at)} ${e.text}`);
      return L;
    },
    html() {
      const L = this.lines();
      return `<div class="ov-card conn"><div class="ov-head"><button class="btn small ghost" data-oact="back">←</button><h1>CONNECTION</h1><button class="btn small primary" data-oact="copyDiag">📋 Copy debug info</button></div><p class="muted small">If you keep dropping out, copy this and paste it to whoever runs the room. It stays on this computer until you do.</p><pre class="diag">${U.esc(L.join('\n'))}</pre></div>`;
    },
    copy() {
      const text = this.lines().join('\n');
      const done = () => G.UI.toast('Copied — paste it into a message.', 'good');
      const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
          ok = document.execCommand('copy');
        } catch (e) {}
        ta.remove();
        ok ? done() : G.UI.toast("Couldn't copy: select the text and press Ctrl+C.", 'bad');
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    },
  };

  // Recent errors, so a crash that broke the game shows up in the report
  window.addEventListener('error', (e) => {
    if (!e.message) return; // (a resource that failed to load: not ours to report)
    D.errors.push({ at: Date.now(), text: `${e.message}${e.filename ? ' (' + e.filename.split('/').pop().split('?')[0] + ':' + e.lineno + ')' : ''}`.slice(0, 200) });
    if (D.errors.length > 20) D.errors.shift();
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    D.errors.push({ at: Date.now(), text: ('Unhandled: ' + ((r && r.message) || r)).slice(0, 200) });
    if (D.errors.length > 20) D.errors.shift();
  });

  G.NetDiag = D;
})(window.G);
