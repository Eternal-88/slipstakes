// lobby.js — multiplayer screens: lobby (room code, players, settings, chat),
// car select, in-race overlay (spectator controls / connection), results.
'use strict';
(function (G) {
  const U = G.U, UI = G.UI, Parts = G.Parts;
  const hex = (c) => UI.colorHex(c);
  const secsLeft = (st) => (st && st.phaseEnds ? Math.max(0, Math.ceil((st.phaseEnds - G.Client.hostNow()) / 1000)) : null);
  const mmss = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

  function playerRow(p, st, extra) {
    const car = Parts.CARS[p.carId];
    const host = p.id === st.hostId;
    return `<div class="pl ${p.connected || p.isBot ? '' : 'off'}"><i style="background:${hex(p.color)}"></i><b>${U.esc(p.name)}</b>${host ? '<em class="tag-host">HOST</em>' : ''}${p.isBot ? '<em class="tag-bot">BOT</em>' : ''}${!p.connected && !p.isBot ? '<em class="tag-off">OFFLINE</em>' : ''}<span class="car">${car ? car.name : ''}</span>${extra || ''}</div>`;
  }

  function chatHtml(st) {
    return st.chat
      .slice(-30)
      .map((c) => (c.sys ? `<div class="cm sys">${U.esc(c.text)}</div>` : `<div class="cm"><b style="color:${hex(c.color)}">${U.esc(c.name)}</b> ${U.esc(c.text)}</div>`))
      .join('');
  }

  // ------------------------------------------------------------------ lobby
  const Lobby = {
    mount(root) {
      root.innerHTML = `
        <div class="lobby">
          <div class="panel lb-main">
            <div class="lb-code"></div>
            <h3>Drivers</h3>
            <div class="lb-players"></div>
            <div class="lb-set"></div>
            <div class="lb-btns"></div>
          </div>
          <div class="panel lb-chat">
            <h3>Chat & trash talk</h3>
            <div class="chat-log"></div>
            <div class="chat-in"><input maxlength="140" placeholder="Say something…" data-enter="send"><button class="btn small" data-act="send">Send</button></div>
          </div>
        </div>`;
      this.el = { code: root.querySelector('.lb-code'), pl: root.querySelector('.lb-players'), set: root.querySelector('.lb-set'), btns: root.querySelector('.lb-btns'), log: root.querySelector('.chat-log'), inp: root.querySelector('.chat-in input') };
    },
    render() {
      const st = G.Client.state;
      if (!st) return;
      const isHost = G.Client.meId === st.hostId;
      UI.patch(this.el.code, `<span>ROOM CODE</span><b>${U.esc(st.code || '')}</b><button class="btn small ghost" data-act="copy">Copy</button><p class="muted small">Friends open this page, click <b>Join</b> and type the code. Up to 8 drivers.</p>`);
      UI.patch(this.el.pl, st.order.map((id) => st.players[id]).filter(Boolean).map((p) => playerRow(p, st)).join(''));
      const s = st.settings;
      UI.patch(
        this.el.set,
        isHost
          ? `<label class="fld inline"><span>Races</span><select data-input="races">${[4, 6, 8, 10, 12].map((n) => `<option ${n === s.races ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
             <label class="fld inline"><span>Bots</span><select data-input="bots">${[0, 1, 2, 3, 4, 5, 6, 7].map((n) => `<option ${n === s.bots ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
             <span class="muted small">~${Math.round(s.races * 6)} min session · bots fill empty grid slots</span>`
          : `<span class="muted">${s.races} races · ${s.bots} bots · waiting for the host to start</span>`
      );
      UI.patch(this.el.btns, `<button class="btn ghost" data-act="leave">Leave</button>${isHost ? '<button class="btn primary big" data-act="start">Start session →</button>' : ''}`);
      const log = chatHtml(st);
      if (this.el.log._html !== log) {
        UI.patch(this.el.log, log);
        this.el.log.scrollTop = 1e6;
      }
    },
    input(k, el) {
      if (k === 'races') G.Client.act({ t: 'settings', races: +el.value });
      if (k === 'bots') G.Client.act({ t: 'settings', bots: +el.value });
    },
    acts: {
      send() {
        const v = this.el.inp.value.trim();
        if (v) G.Client.act({ t: 'chat', text: v });
        this.el.inp.value = '';
      },
      copy() {
        const c = G.Client.state && G.Client.state.code;
        if (c && navigator.clipboard) navigator.clipboard.writeText(c).then(() => UI.toast('Room code copied.', 'good'), () => {});
      },
      start() { G.Client.act({ t: 'start' }); },
      leave() { G.Game.leave(); },
    },
  };
  UI.register('lobby', Lobby);

  // -------------------------------------------------------------- car select
  const CarSelect = {
    mount(root) {
      root.innerHTML = `<div class="carsel"><div class="cs-head"><h1>PICK YOUR CAR</h1><div class="cs-timer"></div></div><div class="cs-cars"></div><div class="panel cs-foot"></div></div>`;
      this.el = { timer: root.querySelector('.cs-timer'), cars: root.querySelector('.cs-cars'), foot: root.querySelector('.cs-foot') };
      this._stats = {};
    },
    stats(id) {
      return this._stats[id] || (this._stats[id] = Parts.computeStats(Parts.computeSpec(id, {}, {})));
    },
    render() {
      const st = G.Client.state, me = G.Client.me;
      if (!st || !me) return;
      const left = secsLeft(st);
      UI.patch(this.el.timer, left != null ? `Race 1 starts in <b>${mmss(left)}</b>` : '');
      const pickers = {};
      Object.values(st.players).forEach((p) => (pickers[p.carId] = (pickers[p.carId] || []).concat(p)));
      UI.patch(
        this.el.cars,
        Parts.CAR_ORDER.map((id) => {
          const c = Parts.CARS[id], s = this.stats(id);
          const bars = s.bars.filter((b) => !b.cost).slice(0, 6).map((b) => `<div class="mini"><span>${b.k}</span><div><i style="width:${b.v * 10}%"></i></div></div>`).join('');
          const who = (pickers[id] || []).map((p) => `<i title="${U.esc(p.name)}" style="background:${hex(p.color)}"></i>`).join('');
          return `<div class="cs-car ${me.carId === id ? 'on' : ''}" data-act="car" data-id="${id}"><div class="cs-name">${c.name}</div><div class="cs-tag">${c.tag}</div><p>${U.esc(c.blurb)}</p>${bars}<div class="cs-who">${who}</div></div>`;
        }).join('')
      );
      const used = new Set(Object.values(st.players).filter((p) => p.id !== me.id).map((p) => p.color));
      const sw = G.CarModel.PALETTE.map((c, i) => `<button class="sw ${me.color === c ? 'on' : ''} ${used.has(c) ? 'taken' : ''}" style="background:${hex(c)}" title="${G.CarModel.COLOR_NAMES[i]}" data-act="color" data-c="${c}" ${used.has(c) ? 'disabled' : ''}></button>`).join('');
      const hs = Object.values(st.players).filter((p) => !p.isBot && p.connected);
      const ready = hs.map((p) => `<span class="rd ${p.ready ? 'y' : ''}" style="border-color:${hex(p.color)}">${U.esc(p.name)} ${p.ready ? '✓' : '…'}</span>`).join('');
      const isHost = me.id === st.hostId;
      UI.patch(this.el.foot, `<div class="cs-sw">${sw}</div><div class="cs-ready">${ready}</div><div class="cs-btns"><button class="btn ${me.ready ? 'green' : 'primary'} big" data-act="ready">${me.ready ? '✓ Ready' : 'Ready'}</button>${isHost ? '<button class="btn ghost" data-act="start">Start now</button>' : ''}</div>`);
    },
    acts: {
      car(el) { G.Client.act({ t: 'setCar', carId: el.dataset.id }); },
      color(el) { G.Client.act({ t: 'setColor', color: +el.dataset.c }); },
      ready() { G.Client.act({ t: 'ready', v: !G.Client.me.ready }); },
      start() { G.Client.act({ t: 'start' }); },
    },
    update() {
      if (Math.floor(performance.now() / 1000) !== this._sec) {
        this._sec = Math.floor(performance.now() / 1000);
        UI.refresh();
      }
    },
  };
  UI.register('carselect', CarSelect);

  // ---------------------------------------------------- in-race overlay
  const RaceUI = {
    mount(root) {
      root.innerHTML = `<div class="raceui"><div class="ru-top"></div><div class="ru-net"></div></div>`;
      this.el = { top: root.querySelector('.ru-top'), net: root.querySelector('.ru-net') };
    },
    render() {},
    update() {
      const st = G.Client.state;
      if (!st) return;
      const racing = G.Game.racing();
      const tr = st.race ? G.getTrack(st.race.trackId) : null;
      let h = '';
      if (!racing) h = `<b>SPECTATING</b> ${tr ? U.esc(tr.name) : ''} · <span>1–8 / Tab</span> follow · <span>WASD Q E</span> free cam · <span>wheel</span> zoom${G.Game.spectateExtra ? G.Game.spectateExtra() : ''}`;
      else if (st.race) h = `<b>RACE ${st.race.no}/${st.settings.races}</b> ${tr ? U.esc(tr.name) : ''}`;
      UI.patch(this.el.top, h);
      UI.patch(this.el.net, G.Game.lost ? '<span class="bad">⚠ Reconnecting to host…</span>' : '');
    },
  };
  UI.register('raceui', RaceUI);

  // ---------------------------------------------------------------- results
  const Results = {
    mount(root) {
      root.innerHTML = `<div class="results"><div class="panel rs-card"><div class="rs-head"></div><div class="rs-table"></div><div class="rs-extra"></div><div class="rs-foot"></div></div></div>`;
      this.el = { head: root.querySelector('.rs-head'), table: root.querySelector('.rs-table'), extra: root.querySelector('.rs-extra'), foot: root.querySelector('.rs-foot') };
      const st = G.Client.state;
      const mine = st && st.results && st.results.rows.find((r) => r.id === G.Client.meId);
      if (G.Audio && mine) mine.pos <= 3 && !mine.dnf ? G.Audio.win() : mine.payout && mine.payout.net < 0 ? G.Audio.lose() : null;
    },
    render() {
      const st = G.Client.state, me = G.Client.me;
      if (!st || !st.results) return;
      const R = st.results;
      const tr = G.getTrack(R.trackId);
      UI.patch(this.el.head, `<h1>RACE ${R.no} RESULTS</h1><div class="muted">${U.esc(tr.name)} <em class="fmt fmt-${tr.format}">${tr.format.toUpperCase()}</em></div>`);
      const win = R.rows.find((r) => !r.dnf);
      const rows = R.rows
        .map((r) => {
          const pay = r.payout;
          const time = r.dnf ? 'DNF' : r === win ? U.fmtTime(r.ms) : '+' + ((r.ms - win.ms) / 1000).toFixed(3) + 's';
          const fast = R.fastest && R.fastest.id === r.id ? ' <em class="tag-fast">FASTEST LAP</em>' : '';
          return `<tr class="${me && r.id === me.id ? 'me' : ''}"><td class="p">${r.pos}</td><td><i style="background:${hex(r.color)}"></i>${U.esc(r.name)}${fast}</td><td>${time}</td><td>${U.fmtTime(r.bestLap)}</td><td class="gd">${r.grid - r.pos > 0 ? '▲' + (r.grid - r.pos) : r.grid - r.pos < 0 ? '▼' + (r.pos - r.grid) : '–'}</td>${pay ? `<td class="pay">${U.fmtSigned(pay.net)}</td>` : ''}</tr>`;
        })
        .join('');
      const hasPay = R.rows.some((r) => r.payout);
      UI.patch(this.el.table, `<table><tr><th>#</th><th>Driver</th><th>Time</th><th>Best lap</th><th>Grid</th>${hasPay ? '<th>Net</th>' : ''}</tr>${rows}</table>`);
      UI.patch(this.el.extra, G.Game.resultsExtra ? G.Game.resultsExtra(R) : '');
      const left = secsLeft(st);
      UI.patch(this.el.foot, `<span class="muted">${left != null ? 'Garage opens in ' + left + ' s' : ''} · ${G.Game.readyLine()}</span><button class="btn ${me && me.ready ? 'green' : 'primary'}" data-act="ready">${me && me.ready ? '✓ Waiting…' : 'Continue'}</button>`);
    },
    update() {
      if (Math.floor(performance.now() / 1000) !== this._sec) {
        this._sec = Math.floor(performance.now() / 1000);
        UI.refresh();
      }
    },
    acts: {
      ready() { G.Client.act({ t: 'ready', v: !G.Client.me.ready }); },
    },
  };
  UI.register('results', Results);
})(window.G);
