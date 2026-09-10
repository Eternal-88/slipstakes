// casino.js (UI) — shared blackjack table and roulette wheel. Everything
// shown is the host's public state; the wheel animation is purely cosmetic
// and always lands on the host's result.
'use strict';
(function (G) {
  const U = G.U, UI = G.UI;
  const hex = (c) => UI.colorHex(c);
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SUITS = ['♠', '♥', '♦', '♣'];
  const CZ = () => G.Casino;

  function card(c) {
    if (c < 0) return '<div class="card back"></div>';
    const s = Math.floor(c / 13) % 4;
    return `<div class="card ${s === 1 || s === 2 ? 'red' : ''}"><b>${RANKS[c % 13]}</b><i>${SUITS[s]}</i></div>`;
  }
  const secs = (deadline) => (deadline ? Math.max(0, Math.ceil((deadline - G.Client.hostNow()) / 1000)) : null);
  const EMPTY = {
    bj: { phase: 'betting', deadline: 0, seats: [null, null, null, null, null], dealer: { cards: [] }, turn: null, round: 0, msg: 'Take a seat and place a bet.', shoeLeft: 312 },
    rl: { phase: 'betting', deadline: 0, bets: [], result: null, round: 0, history: [], last: {} },
  };

  const Casino = {
    mount(root) {
      this.tab = this.tab || 'bj';
      this.chip = this.chip || 100;
      this.bjChip = this.bjChip || 100;
      root.innerHTML = `<div class="casino"><div class="panel cz-head"></div><div class="cz-body"></div></div>`;
      this.el = { head: root.querySelector('.cz-head'), body: root.querySelector('.cz-body') };
      this.built = null;
      this.wheel = { angle: 0, round: -1, start: 0, from: 0, to: 0 };
    },

    render() {
      const st = G.Client.state, me = G.Client.me;
      if (!st || !me) return;
      // Before the host has opened the tables, show empty ones (seats are
      // clickable — sitting creates the host-side table). Never a dead end.
      const cz = st.casino || EMPTY;
      const sandbox = st.phase === 'sandbox';
      UI.patch(
        this.el.head,
        `${sandbox ? '<button class="btn ghost" data-act="czback">← Menu</button><h1 class="cz-title">CASINO <small>practice chips</small></h1>' : UI.interTabs()}<div class="cz-tabs"><button class="${this.tab === 'bj' ? 'on' : ''}" data-act="ctab" data-t="bj">🃏 Blackjack</button><button class="${this.tab === 'rl' ? 'on' : ''}" data-act="ctab" data-t="rl">🎡 Roulette</button></div>
         <div class="cz-money"><span>CASH</span><b>${U.fmtMoney(me.money)}</b><em>floor ${U.fmtMoney(G.Econ.FLOOR)}</em></div>
         ${sandbox ? '' : `<span class="muted small">${G.Game.readyLine()}</span><button class="btn ${me.ready ? 'green' : 'primary'}" data-act="ready">${me.ready ? '✓ Ready' : 'Ready'}</button>`}`
      );
      if (this.built !== this.tab) {
        this.built = this.tab;
        this.el.body.innerHTML =
          this.tab === 'bj'
            ? `<div class="bj"><div class="bj-felt"><div class="bj-dealer"></div><div class="bj-msg"></div><div class="bj-seats"></div></div><div class="panel bj-ctl"></div></div>`
            : `<div class="rl"><div class="rl-left"><canvas class="rl-wheel" width="340" height="340"></canvas><div class="rl-status"></div><div class="rl-hist"></div></div><div class="rl-right"><div class="rl-board"></div><div class="panel rl-ctl"></div></div></div>`;
        const q = (s) => this.el.body.querySelector(s);
        this.b = this.tab === 'bj' ? { dealer: q('.bj-dealer'), msg: q('.bj-msg'), seats: q('.bj-seats'), ctl: q('.bj-ctl') } : { canvas: q('.rl-wheel'), status: q('.rl-status'), hist: q('.rl-hist'), board: q('.rl-board'), ctl: q('.rl-ctl') };
      }
      if (this.tab === 'bj') this.renderBJ(cz.bj, me, st);
      else this.renderRL(cz.rl, me, st);
      this.sounds(cz, me);
    },

    // Jingles for MY outcomes (once per round).
    sounds(cz, me) {
      const A = G.Audio;
      if (!A) return;
      const bj = cz.bj, rl = cz.rl;
      const seat = bj.seats.find((s) => s && s.pid === me.id);
      if (bj.phase === 'settled' && seat && seat.hands.length && this._bjRound !== bj.round) {
        this._bjRound = bj.round;
        if (seat.lastNet > 0) A.win();
        else if (seat.lastNet < 0) A.lose();
      }
      const n = bj.seats.reduce((a, s) => a + (s ? s.hands.reduce((b, h) => b + h.cards.length, 0) : 0), bj.dealer.cards.length);
      if (n > (this._cards || 0)) A.card();
      this._cards = n;
      if (rl.phase === 'result' && this._rlRound !== rl.round && rl.last && rl.last[me.id] != null) {
        this._rlRound = rl.round;
        if (rl.last[me.id] > 0) A.win();
        else A.lose();
      }
    },

    // ---------------------------------------------------------- blackjack
    renderBJ(bj, me, st) {
      const Cz = CZ();
      const dt = Cz.total(bj.dealer.cards);
      UI.patch(this.b.dealer, `<div class="lbl">DEALER ${bj.dealer.cards.length ? '· ' + dt.t + (bj.dealer.cards.includes(-1) ? '+?' : '') : ''}</div><div class="cards">${bj.dealer.cards.map(card).join('')}</div>`);
      const left = secs(bj.deadline);
      UI.patch(this.b.msg, `${U.esc(bj.msg || '')}${left != null && bj.phase !== 'dealer' ? ` <b>${left}s</b>` : ''}<span class="shoe">shoe ${bj.shoeLeft || 312}/${Cz.C.BJ.decks * 52}</span>`);
      const mySeat = bj.seats.findIndex((s) => s && s.pid === me.id);
      UI.patch(
        this.b.seats,
        bj.seats
          .map((s, i) => {
            if (!s) return `<div class="seat empty">${mySeat < 0 ? `<button class="btn small ghost" data-act="sit" data-i="${i}">Sit</button>` : ''}</div>`;
            const turnSeat = bj.turn && bj.turn.seat === i;
            const hands = s.hands
              .map((h, hi) => {
                const t = Cz.total(h.cards);
                const active = turnSeat && bj.turn.hand === hi;
                const res = h.result ? `<em class="res r-${h.result}">${h.result.toUpperCase()}${h.payout ? ' ' + U.fmtMoney(h.payout) : ''}</em>` : '';
                return `<div class="hand ${active ? 'act' : ''}"><div class="cards">${h.cards.map(card).join('')}</div><div class="ht">${t.t}${t.soft && t.t < 21 ? ' soft' : ''} · $${h.bet}${h.doubled ? ' ×2' : ''}</div>${res}</div>`;
              })
              .join('');
            return `<div class="seat ${s.pid === me.id ? 'mine' : ''} ${turnSeat ? 'turn' : ''}"><div class="sn" style="border-color:${hex(s.color)}">${U.esc(s.name)}</div>${hands || (s.bet ? `<div class="chipstack">$${s.bet}</div>` : '<div class="muted small">no bet</div>')}${s.insurance ? `<div class="small">insured $${s.insurance}</div>` : ''}${bj.phase === 'settled' && s.lastNet != null && s.hands.length ? `<div class="net ${s.lastNet >= 0 ? 'pos' : 'neg'}">${U.fmtSigned(s.lastNet)}</div>` : ''}</div>`;
          })
          .join('')
      );
      // controls
      const B = Cz.C.BJ;
      let ctl = `<div class="rules">6 decks · dealer stands on all 17 · blackjack pays 3:2 · double any two · split to 4 · insurance 2:1 · ${U.fmtMoney(B.min)}–${U.fmtMoney(B.max)}</div>`;
      if (mySeat < 0) ctl += '<p class="muted">Pick an empty seat to play. Up to 5 players share the table.</p>';
      else {
        const s = bj.seats[mySeat];
        if (bj.phase === 'betting') {
          ctl += `<div class="chips">${[25, 50, 100, 250, 500].map((v) => `<button class="chip ${this.bjChip === v ? 'on' : ''}" data-act="bjchip" data-v="${v}">$${v}</button>`).join('')}</div>
            <div class="row"><button class="btn primary" data-act="bjbet" ${me.money - this.bjChip + s.bet < G.Econ.FLOOR ? 'disabled' : ''}>Bet $${this.bjChip}</button><button class="btn green" data-act="bjdeal" ${s.bet ? '' : 'disabled'}>Deal</button><button class="btn ghost" data-act="bjleave">Leave seat</button></div>`;
        } else if (bj.phase === 'insurance' && s.hands.length && !s.insDone) {
          ctl += `<div class="row"><button class="btn primary" data-act="ins" data-y="1">Insurance $${Math.floor(s.hands[0].bet / 2)}</button><button class="btn ghost" data-act="ins" data-y="0">No thanks</button></div>`;
        } else if (bj.phase === 'playing' && bj.turn && bj.turn.seat === mySeat) {
          const h = s.hands[bj.turn.hand];
          const canDbl = h.cards.length === 2 && !h.splitAces && me.money - h.bet >= G.Econ.FLOOR;
          const canSplit = h.cards.length === 2 && Cz.cardVal(h.cards[0]) === Cz.cardVal(h.cards[1]) && s.hands.length < 4 && !h.splitAces && me.money - h.bet >= G.Econ.FLOOR;
          ctl += `<div class="row big"><button class="btn green big" data-act="bj" data-a="hit">Hit</button><button class="btn red big" data-act="bj" data-a="stand">Stand</button><button class="btn primary" data-act="bj" data-a="double" ${canDbl ? '' : 'disabled'}>Double</button><button class="btn pink" data-act="bj" data-a="split" ${canSplit ? '' : 'disabled'}>Split</button></div>`;
        } else ctl += `<p class="muted">${bj.phase === 'settled' ? 'Next round in a moment…' : 'Waiting…'}</p>`;
      }
      UI.patch(this.b.ctl, ctl);
    },

    // ----------------------------------------------------------- roulette
    renderRL(rl, me, st) {
      const Cz = CZ();
      const mine = rl.bets.filter((b) => b.pid === me.id);
      const stakeOn = (type, n) => rl.bets.filter((b) => b.type === type && b.n === n);
      const spot = (type, n, label, cls) => {
        const all = stakeOn(type, n);
        const my = all.filter((b) => b.pid === me.id).reduce((a, b) => a + b.stake, 0);
        const others = all.filter((b) => b.pid !== me.id);
        const hit = rl.phase !== 'betting' && rl.phase !== 'spinning' && rl.result != null && Cz.rlWins(type, n, rl.result);
        return `<div class="sp ${cls || ''} ${hit ? 'hit' : ''}" data-act="rl" data-type="${type}" data-n="${n}">${label}${my ? `<span class="mychip">${my}</span>` : ''}${others.length ? `<span class="odots">${others.map((b) => `<i style="background:${hex(b.color)}"></i>`).join('')}</span>` : ''}</div>`;
      };
      let grid = '<div class="rl-grid">' + spot('straight', 0, '0', 'zero');
      for (let row = 3; row >= 1; row--) {
        for (let col = 0; col < 12; col++) {
          const n = col * 3 + row;
          grid += spot('straight', n, String(n), Cz.REDSET.has(n) ? 'red' : 'black');
        }
        grid += spot('column', 4 - row, '2:1', 'col');
      }
      grid += '</div><div class="rl-out">';
      grid += spot('dozen', 1, '1st 12') + spot('dozen', 2, '2nd 12') + spot('dozen', 3, '3rd 12');
      grid += '</div><div class="rl-out">' + spot('low', 0, '1–18') + spot('even', 0, 'EVEN') + spot('red', 0, '◆', 'red') + spot('black', 0, '◆', 'black') + spot('odd', 0, 'ODD') + spot('high', 0, '19–36') + '</div>';
      UI.patch(this.b.board, grid);
      const left = secs(rl.deadline);
      let status = '';
      if (rl.phase === 'betting') status = rl.deadline ? `Bets close in <b>${left}s</b>` : 'Place a chip to start the next spin';
      else if (rl.phase === 'spinning') status = 'No more bets… spinning';
      else {
        const r = rl.result;
        const my = rl.last && rl.last[me.id];
        status = `<span class="num ${r === 0 ? 'g' : Cz.REDSET.has(r) ? 'r' : 'b'}">${r}</span> ${my != null ? `you ${my >= 0 ? 'won' : 'lost'} <b class="${my >= 0 ? 'pos' : 'neg'}">${U.fmtMoney(Math.abs(my))}</b>` : ''}`;
      }
      UI.patch(this.b.status, status);
      UI.patch(this.b.hist, rl.history.map((r) => `<i class="${r === 0 ? 'g' : Cz.REDSET.has(r) ? 'r' : 'b'}">${r}</i>`).join(''));
      const staked = mine.reduce((a, b) => a + b.stake, 0);
      UI.patch(
        this.b.ctl,
        `<div class="chips">${[10, 25, 100, 250, 500].map((v) => `<button class="chip ${this.chip === v ? 'on' : ''}" data-act="rlchip" data-v="${v}">$${v}</button>`).join('')}</div>
         <div class="row"><span>On the table: <b>${U.fmtMoney(staked)}</b> / ${U.fmtMoney(Cz.C.RL.maxTotal)}</span><button class="btn small ghost" data-act="rlclear" ${staked && rl.phase === 'betting' ? '' : 'disabled'}>Clear</button><button class="btn small green" data-act="rlspin" ${staked && rl.phase === 'betting' ? '' : 'disabled'}>Spin now</button></div>
         <div class="rules">European single zero · straight 35:1 · dozens/columns 2:1 · even-money 1:1 · max ${U.fmtMoney(Cz.C.RL.max)} a spot</div>`
      );
    },

    // Wheel: idles slowly; on a new spin eases 5 turns onto the host's result.
    drawWheel(dt) {
      const cz = G.Client.state && G.Client.state.casino;
      const cv = this.b && this.b.canvas;
      if (!cz || !cv) return;
      const rl = cz.rl, Cz = CZ(), W = Cz.C.WHEEL, n = W.length, seg = (Math.PI * 2) / n;
      const w = this.wheel;
      if (rl.phase === 'spinning' && w.round !== rl.round) {
        w.round = rl.round;
        w.start = performance.now();
        w.from = w.angle;
        const idx = W.indexOf(rl.result);
        // pocket idx should end at the top (-PI/2)
        const target = -Math.PI / 2 - idx * seg - seg / 2;
        let to = target;
        while (to < w.from + Math.PI * 10) to += Math.PI * 2;
        w.to = to;
      }
      if (rl.phase === 'spinning' || (rl.phase === 'result' && w.round === rl.round)) {
        const k = U.clamp((performance.now() - w.start) / Cz.C.RL.spinTime, 0, 1);
        const e = 1 - Math.pow(1 - k, 3);
        const prev = w.angle;
        w.angle = w.from + (w.to - w.from) * e;
        // ball clicks over the pocket frets, slowing with the wheel
        const pk = Math.floor(w.angle / seg), pp = Math.floor(prev / seg);
        if (pk !== pp && k < 0.995 && G.Audio) G.Audio.wheelTick();
      } else w.angle += dt * 0.25;
      const c = cv.getContext('2d');
      const R = cv.width / 2;
      c.clearRect(0, 0, cv.width, cv.height);
      c.save();
      c.translate(R, R);
      c.beginPath();
      c.arc(0, 0, R - 2, 0, Math.PI * 2);
      c.fillStyle = '#5a3a1e';
      c.fill();
      for (let i = 0; i < n; i++) {
        const a0 = w.angle + i * seg, a1 = a0 + seg;
        c.beginPath();
        c.moveTo(0, 0);
        c.arc(0, 0, R - 14, a0, a1);
        c.closePath();
        const num = W[i];
        c.fillStyle = num === 0 ? '#1f9d55' : Cz.REDSET.has(num) ? '#d7263d' : '#15171c';
        c.fill();
        c.save();
        c.rotate(a0 + seg / 2);
        c.fillStyle = '#fff';
        c.font = 'bold 12px Nunito, sans-serif';
        c.textAlign = 'center';
        c.fillText(String(num), R - 30, 4);
        c.restore();
      }
      c.beginPath();
      c.arc(0, 0, R * 0.42, 0, Math.PI * 2);
      c.fillStyle = '#6b4424';
      c.fill();
      c.beginPath();
      c.arc(0, 0, R * 0.14, 0, Math.PI * 2);
      c.fillStyle = '#d9b44a';
      c.fill();
      c.restore();
      // ball marker at the top
      c.beginPath();
      c.arc(R, 20, 7, 0, Math.PI * 2);
      c.fillStyle = '#fff';
      c.fill();
      c.strokeStyle = '#222';
      c.stroke();
    },

    update(dt) {
      if (this.tab === 'rl') this.drawWheel(dt);
      if (Math.floor(performance.now() / 500) !== this._t) {
        this._t = Math.floor(performance.now() / 500);
        UI.refresh();
      }
    },

    acts: {
      ctab(el) { this.tab = el.dataset.t; UI.refresh(true); },
      sit(el) { G.Client.act({ t: 'bjSit', seat: +el.dataset.i }); },
      bjleave() { G.Client.act({ t: 'bjLeave' }); },
      bjchip(el) { this.bjChip = +el.dataset.v; UI.refresh(true); },
      bjbet() { G.Client.act({ t: 'bjBet', amount: this.bjChip }); if (G.Audio) G.Audio.chip(); },
      bjdeal() { G.Client.act({ t: 'bjDeal' }); },
      ins(el) { G.Client.act({ t: 'bjInsure', yes: el.dataset.y === '1' }); },
      bj(el) { G.Client.act({ t: 'bjAct', a: el.dataset.a }); if (G.Audio) G.Audio.click(); },
      rlchip(el) { this.chip = +el.dataset.v; UI.refresh(true); },
      rl(el) { G.Client.act({ t: 'rlBet', type: el.dataset.type, n: +el.dataset.n, stake: this.chip }); if (G.Audio) G.Audio.chip(); },
      rlclear() { G.Client.act({ t: 'rlClear' }); },
      rlspin() { G.Client.act({ t: 'rlSpin' }); },
      czback() { G.App.showMenu(); },
    },
  };
  UI.register('casino', Casino);
})(window.G);
