// prerace.js — before every race: RACE or SIT OUT, then the betting window
// (odds board + bet slip for spectators, side bets between racers).
'use strict';
(function (G) {
  const U = G.U, UI = G.UI, Parts = G.Parts;
  const hex = (c) => UI.colorHex(c);
  const left = (st) => (st.phaseEnds ? Math.max(0, Math.ceil((st.phaseEnds - G.Client.hostNow()) / 1000)) : 0);
  const E = () => G.Econ;

  function trackHead(st, label) {
    const id = st.schedule[st.raceNo];
    const tr = id ? G.getTrack(id) : null;
    if (!tr) return '';
    const laps = tr.format === 'circuit' ? `${tr.laps} laps` : tr.format === 'drag' ? `${tr.def.dragLength} m` : `${Math.round(tr.raceDistance)} m`;
    return `<div class="pr-track"><div><span class="muted">RACE ${st.raceNo + 1}/${st.settings.races}</span><h1>${U.esc(tr.name)}</h1></div><em class="fmt fmt-${tr.format}">${tr.format.toUpperCase()}</em><span class="muted">${laps}</span><div class="pr-timer">${label} <b>${left(st)} s</b></div></div><p class="muted pr-blurb">${U.esc(tr.blurb)}</p>`;
  }

  // ------------------------------------------------------------ entry
  const Entry = {
    mount(root) {
      root.innerHTML = `<div class="prerace"><div class="panel pr-card"><div class="pr-head"></div><div class="pr-body"></div><div class="pr-foot"></div></div></div>`;
      this.el = { head: root.querySelector('.pr-head'), body: root.querySelector('.pr-body'), foot: root.querySelector('.pr-foot') };
    },
    render() {
      const st = G.Client.state, me = G.Client.me;
      if (!st || !me) return;
      UI.patch(this.el.head, trackHead(st, 'Decide in'));
      const tr = G.getTrack(st.schedule[st.raceNo]);
      const spec = Parts.computeSpec(me.carId, me.garage.installed, me.garage.wear);
      const cost = Parts.computeStats(spec).cost;
      const warns = Parts.warnings(spec, tr).filter((w) => w[0] === 'bad').slice(0, 3);
      const prizes = E().PRIZES.map((p) => U.fmtMoney(Math.round((p * E().mult(st.raceNo + 1)) / 10) * 10));
      const w = me.garage.wear;
      UI.patch(
        this.el.body,
        `<div class="choice ${me.entry === 'race' ? 'on' : ''}" data-act="race">
           <div class="ch-t">🏁 RACE</div>
           <p>Paid by placement: <b>${prizes[0]}</b> · ${prizes[1]} · ${prizes[2]} … last ${prizes[prizes.length - 1]}. +${U.fmtMoney(E().GAIN_BONUS)} per place gained from the grid, ${U.fmtMoney(E().FASTEST_LAP)} fastest lap.</p>
           <p class="muted">Your ${U.esc(Parts.CARS[me.carId].name)}: tyres ${Math.round((1 - w.tyre) * 100)}% · engine ${Math.round((1 - w.engine) * 100)}% · running cost ~${U.fmtMoney(cost)} (fuel + wear)</p>
           ${warns.map((x) => `<div class="wn bad">⚠ ${U.esc(x[1])}</div>`).join('')}
         </div>
         <div class="choice ${me.entry === 'sit' ? 'on' : ''}" data-act="sit">
           <div class="ch-t">🎲 SIT OUT & BET</div>
           <p>No prize, no wear, no fuel. Watch live with a free camera and bet on the racers — odds come from recent form and each car's stats on <b>this</b> track.</p>
           <p class="muted">Bets ${U.fmtMoney(E().BET_MIN)}–${U.fmtMoney(E().BET_MAX)}, max ${U.fmtMoney(E().BET_TOTAL)} per race. You always keep ${U.fmtMoney(E().FLOOR)} for repairs.</p>
         </div>`
      );
      const hs = Object.values(st.players).filter((p) => !p.isBot && p.connected);
      UI.patch(this.el.foot, hs.map((p) => `<span class="rd ${p.entry ? 'y' : ''}" style="border-color:${hex(p.color)}">${U.esc(p.name)} ${p.entry === 'race' ? '🏁' : p.entry === 'sit' ? '🎲' : '…'}</span>`).join('') + `<span class="muted small">Undecided at the buzzer = racing. Bots always race.</span>`);
    },
    update() {
      if (Math.floor(performance.now() / 500) !== this._t) {
        this._t = Math.floor(performance.now() / 500);
        UI.refresh();
      }
    },
    acts: {
      race() { G.Client.act({ t: 'entry', v: 'race' }); },
      sit() { G.Client.act({ t: 'entry', v: 'sit' }); },
    },
  };
  UI.register('entry', Entry);

  // ---------------------------------------------------------- betting
  const Betting = {
    mount(root) {
      this.stake = this.stake || 250;
      this.sel = null; // {racer, type}
      this.side = this.side || { to: null, stake: 250 };
      root.innerHTML = `<div class="prerace wide"><div class="panel pr-card"><div class="pr-head"></div><div class="bt-grid"><div class="bt-board"></div><div class="bt-slip"></div></div><div class="pr-foot"></div></div></div>`;
      this.el = { head: root.querySelector('.pr-head'), board: root.querySelector('.bt-board'), slip: root.querySelector('.bt-slip'), foot: root.querySelector('.pr-foot') };
    },
    render() {
      const st = G.Client.state, me = G.Client.me;
      if (!st || !me) return;
      const sitting = me.entry === 'sit';
      UI.patch(this.el.head, trackHead(st, 'Lights out in'));
      const racers = Object.keys(st.odds).map((id) => st.players[id]).filter(Boolean).sort((a, b) => st.odds[a.id].win - st.odds[b.id].win);
      const stip = new Set(st.stipend || []);
      const rows = racers
        .map((p) => {
          const o = st.odds[p.id];
          const form = o.form.length ? o.form.map((x) => `<i class="f f${Math.min(x, 4)}">${x}</i>`).join('') : '<span class="muted">new</span>';
          const cell = (type, v) => {
            if (!v) return '<td class="od">–</td>';
            const on = this.sel && this.sel.racer === p.id && this.sel.type === type;
            return sitting ? `<td class="od"><button class="odb ${on ? 'on' : ''}" data-act="pick" data-r="${p.id}" data-type="${type}">${v.toFixed(2)}x</button></td>` : `<td class="od">${v.toFixed(2)}x</td>`;
          };
          return `<tr class="${p.id === me.id ? 'me' : ''}"><td><i class="dot" style="background:${hex(p.color)}"></i>${U.esc(p.name)}${stip.has(p.id) ? ' <em class="tag-sti" title="Sponsor stipend: poorest racers get a bonus">+$300</em>' : ''}</td><td class="muted">${Parts.CARS[p.carId].name}</td><td>${form}</td><td><div class="sc"><i style="width:${o.score * 10}%"></i></div></td>${cell('win', o.win)}${cell('podium', o.podium)}</tr>`;
        })
        .join('');
      UI.patch(this.el.board, `<table class="odds"><tr><th>Racer</th><th>Car</th><th>Form</th><th>Car on this track</th><th>WIN</th><th>PODIUM</th></tr>${rows}</table>${this.publicBets(st)}`);
      UI.patch(this.el.slip, sitting ? this.slipHtml(st, me) : this.sideHtml(st, me));
      UI.patch(this.el.foot, `<span class="muted">${G.Game.readyLine()}</span><button class="btn ${me.ready ? 'green' : 'primary'}" data-act="ready">${me.ready ? '✓ Ready' : sitting ? 'Done betting' : 'Ready to race'}</button>`);
    },
    publicBets(st) {
      const bets = st.bets.map((b) => `<div>🎲 <b>${U.esc(b.name)}</b> ${U.fmtMoney(b.stake)} on ${U.esc(b.racerName)} to ${b.type === 'win' ? 'win' : 'podium'} @${b.odds.toFixed(2)}x</div>`);
      const sides = st.sideBets.map((s) => `<div>⚔ <b>${U.esc(s.fromName)}</b> vs <b>${U.esc(s.toName)}</b> ${U.fmtMoney(s.stake)} — ${s.status}</div>`);
      const all = bets.concat(sides);
      return all.length ? `<div class="pub"><h3>On the book</h3>${all.join('')}</div>` : '';
    },
    chips(sel, act) {
      return [50, 100, 250, 500, 1000].map((v) => `<button class="chip ${sel === v ? 'on' : ''}" data-act="${act}" data-v="${v}">$${v}</button>`).join('');
    },
    slipHtml(st, me) {
      const E_ = E();
      const mine = st.bets.filter((b) => b.pid === me.id);
      const staked = mine.reduce((a, b) => a + b.stake, 0);
      const maxOk = Math.max(0, Math.min(E_.BET_MAX, E_.BET_TOTAL - staked, me.money - E_.FLOOR));
      let pick = '<p class="muted">Pick an odds button on the board.</p>';
      if (this.sel) {
        const r = st.players[this.sel.racer], o = st.odds[this.sel.racer];
        const odds = this.sel.type === 'win' ? o.win : o.podium;
        const ok = this.stake <= maxOk && this.stake >= E_.BET_MIN;
        pick = `<div class="pick"><b>${U.esc(r.name)}</b> to ${this.sel.type === 'win' ? 'WIN' : 'finish on the PODIUM'} @ ${odds.toFixed(2)}x<br><span class="muted">Stake ${U.fmtMoney(this.stake)} → returns ${U.fmtMoney(this.stake * odds)}</span></div>
          <button class="btn primary" data-act="place" ${ok ? '' : 'disabled'}>Place bet</button>${ok ? '' : `<p class="bad small">${this.stake > me.money - E_.FLOOR ? 'That would take you below the ' + U.fmtMoney(E_.FLOOR) + ' repair floor.' : 'Over the per-race limit.'}</p>`}`;
      }
      return `<h3>Bet slip</h3><div class="money-line">Cash <b>${U.fmtMoney(me.money)}</b> · stakeable <b>${U.fmtMoney(maxOk)}</b></div>
        <div class="chips">${this.chips(this.stake, 'stake')}</div>${pick}
        <h3 style="margin-top:14px">Your bets</h3>${mine.length ? mine.map((b) => `<div class="mybet">${U.fmtMoney(b.stake)} · ${U.esc(b.racerName)} ${b.type} @${b.odds.toFixed(2)}x → ${U.fmtMoney(b.stake * b.odds)}</div>`).join('') : '<p class="muted small">None yet.</p>'}`;
    },
    sideHtml(st, me) {
      const E_ = E();
      const racers = Object.keys(st.odds).filter((id) => id !== me.id).map((id) => st.players[id]).filter(Boolean);
      if (!this.side.to || !st.odds[this.side.to] || this.side.to === me.id) this.side.to = racers[0] ? racers[0].id : null;
      const incoming = st.sideBets.filter((s) => s.to === me.id && s.status === 'pending');
      const mine = st.sideBets.filter((s) => (s.from === me.id || s.to === me.id) && s.status !== 'pending');
      const inc = incoming.map((s) => `<div class="incoming"><b>${U.esc(s.fromName)}</b>: "I'll beat you, ${U.fmtMoney(s.stake)}." <button class="btn small green" data-act="accept" data-id="${s.id}">Accept</button><button class="btn small ghost" data-act="decline" data-id="${s.id}">Decline</button></div>`).join('');
      return `<h3>You're racing</h3><p class="muted small">Racers can't use the bookie, but you can challenge a rival: whoever finishes ahead takes both stakes.</p>
        ${inc}
        <div class="side-row"><select data-input="sideTo">${racers.map((p) => `<option value="${p.id}" ${p.id === this.side.to ? 'selected' : ''}>${U.esc(p.name)}</option>`).join('')}</select></div>
        <div class="chips">${this.chips(this.side.stake, 'sstake')}</div>
        <button class="btn pink" data-act="challenge" ${me.money - this.side.stake < E_.FLOOR || !this.side.to ? 'disabled' : ''}>"I'll beat you, ${U.fmtMoney(this.side.stake)}"</button>
        <h3 style="margin-top:14px">Your side bets</h3>${mine.length ? mine.map((s) => `<div class="mybet">vs ${U.esc(s.from === me.id ? s.toName : s.fromName)} ${U.fmtMoney(s.stake)} — ${s.status}</div>`).join('') : '<p class="muted small">None.</p>'}`;
    },
    input(k, el) {
      if (k === 'sideTo') this.side.to = el.value;
    },
    update() {
      if (Math.floor(performance.now() / 500) !== this._t) {
        this._t = Math.floor(performance.now() / 500);
        UI.refresh();
      }
    },
    acts: {
      pick(el) {
        this.sel = { racer: el.dataset.r, type: el.dataset.type };
        UI.refresh(true);
      },
      stake(el) { this.stake = +el.dataset.v; UI.refresh(true); },
      sstake(el) { this.side.stake = +el.dataset.v; UI.refresh(true); },
      place() {
        if (!this.sel) return;
        G.Client.act({ t: 'bet', racer: this.sel.racer, type: this.sel.type, stake: this.stake });
        this.sel = null;
      },
      challenge() { if (this.side.to) G.Client.act({ t: 'sideBet', to: this.side.to, stake: this.side.stake }); },
      accept(el) { G.Client.act({ t: 'sideReply', id: el.dataset.id, accept: true }); },
      decline(el) { G.Client.act({ t: 'sideReply', id: el.dataset.id, accept: false }); },
      ready() { G.Client.act({ t: 'ready', v: !G.Client.me.ready }); },
    },
  };
  UI.register('betting', Betting);
})(window.G);
