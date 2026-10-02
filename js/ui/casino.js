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
        `${sandbox ? '<button class="btn ghost" data-act="czback">← Menu</button><h1 class="cz-title">CASINO <small>practice chips</small></h1>' : UI.interTabs()}<div class="cz-tabs"><button class="${this.tab === 'bj' ? 'on' : ''}" data-act="ctab" data-t="bj">${G.ic('spade')} Blackjack</button><button class="${this.tab === 'rl' ? 'on' : ''}" data-act="ctab" data-t="rl">${G.ic('target')} Roulette</button></div><button class="btn small ghost" data-act="czrules">${G.ic('circle-help')} ${this.tab === 'bj' ? 'Blackjack' : 'Roulette'} rules</button>
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
      let ctl = `<div class="rules">6 decks · dealer stands on all 17 · blackjack pays 3:2 · double any two · split to 4 · surrender · insurance 2:1 · ${U.fmtMoney(B.min)}–${U.fmtMoney(B.max)} <button class="linkish" data-act="czrules">Full rules</button></div>`;
      if (mySeat < 0) ctl += '<p class="muted">Pick an empty seat to play. Up to 5 players share the table.</p>';
      else {
        const s = bj.seats[mySeat];
        if (bj.phase === 'betting') {
          // v5.8.5: chips stack onto the bet like at a real table (it was one
          // chip a bet, and the $500 chip was over the $350 table limit)
          if (s.bet) this._bjLast = s.bet;
          const room = Math.min(B.max - s.bet, me.money - G.Econ.FLOOR);
          const re = this._bjLast && !s.bet && this._bjLast <= Math.min(B.max, me.money - G.Econ.FLOOR) ? `<button class="btn small" data-act="bjrebet">Rebet ${U.fmtMoney(this._bjLast)}</button>` : '';
          ctl += `<div class="chips">${[25, 50, 100, 250].map((v) => `<button class="chip" data-act="bjadd" data-v="${v}" ${v > room ? 'disabled' : ''}>+$${v}</button>`).join('')}</div>
            <div class="row"><span>Your bet <b>${U.fmtMoney(s.bet)}</b></span><button class="btn small ghost" data-act="bjclear" ${s.bet ? '' : 'disabled'}>Clear</button>${re}<button class="btn green" data-act="bjdeal" ${s.bet ? '' : 'disabled'}>Deal</button><button class="btn ghost" data-act="bjleave">Leave seat</button></div>`;
        } else if (bj.phase === 'insurance' && s.hands.length && !s.insDone) {
          ctl += `<div class="row"><button class="btn primary" data-act="ins" data-y="1">Insurance $${Math.floor(s.hands[0].bet / 2)}</button><button class="btn ghost" data-act="ins" data-y="0">No thanks</button></div>`;
        } else if (bj.phase === 'playing' && bj.turn && bj.turn.seat === mySeat) {
          const h = s.hands[bj.turn.hand];
          const canDbl = h.cards.length === 2 && !h.splitAces && me.money - h.bet >= G.Econ.FLOOR;
          const canSplit = h.cards.length === 2 && Cz.cardVal(h.cards[0]) === Cz.cardVal(h.cards[1]) && s.hands.length < 4 && !h.splitAces && me.money - h.bet >= G.Econ.FLOOR;
          const canSur = h.cards.length === 2 && !h.fromSplit && s.hands.length === 1;
          ctl += `<div class="row big"><button class="btn green big" data-act="bj" data-a="hit">Hit</button><button class="btn red big" data-act="bj" data-a="stand">Stand</button><button class="btn primary" data-act="bj" data-a="double" ${canDbl ? '' : 'disabled'}>Double</button><button class="btn pink" data-act="bj" data-a="split" ${canSplit ? '' : 'disabled'}>Split</button><button class="btn ghost" data-act="bj" data-a="surrender" ${canSur ? '' : 'disabled'} title="Give up this hand for half your bet back">Surrender</button></div>`;
        } else ctl += `<p class="muted">${bj.phase === 'settled' ? 'Next round in a moment…' : 'Waiting…'}</p>`;
      }
      UI.patch(this.b.ctl, ctl);
    },

    // ----------------------------------------------------------- roulette
    renderRL(rl, me, st) {
      const Cz = CZ();
      const mine = rl.bets.filter((b) => b.pid === me.id);
      const stakeOn = (type, n) => rl.bets.filter((b) => b.type === type && b.n === n);
      const settled = rl.phase !== 'betting' && rl.phase !== 'spinning' && rl.result != null;
      const chipsOn = (type, n) => {
        const all = stakeOn(type, n);
        const my = all.filter((b) => b.pid === me.id).reduce((a, b) => a + b.stake, 0);
        const others = all.filter((b) => b.pid !== me.id);
        return { my, html: `${my ? `<span class="mychip">${my}</span>` : ''}${others.length ? `<span class="odots">${others.map((b) => `<i style="background:${hex(b.color)}"></i>`).join('')}</span>` : ''}` };
      };
      const spot = (type, n, label, cls, kids) => {
        const hit = settled && Cz.rlWins(type, n, rl.result);
        return `<div class="sp ${cls || ''} ${hit ? 'hit' : ''}" data-act="rl" data-type="${type}" data-n="${n}">${label}${chipsOn(type, n).html}${kids || ''}</div>`;
      };
      // v5.8.5 inside bets: hot spots on the lines and corners between numbers
      const ib = (type, n, cls, title) => {
        const c = chipsOn(type, n);
        const hit = settled && Cz.rlWins(type, n, rl.result);
        return `<i class="ib ${cls} ${hit ? 'hit' : ''} ${c.my ? 'has' : ''}" data-act="rl" data-type="${type}" data-n="${n}" title="${title}">${c.html}</i>`;
      };
      let grid = '<div class="rl-grid">' + spot('straight', 0, '0', 'zero');
      for (let row = 3; row >= 1; row--) {
        for (let col = 0; col < 12; col++) {
          const n = col * 3 + row;
          let kids = '';
          if (col < 11) kids += ib('split', n * 37 + n + 3, 'e-r', `Split ${n} and ${n + 3} · pays 17:1`);
          if (row < 3) kids += ib('split', n * 37 + n + 1, 'e-t', `Split ${n} and ${n + 1} · pays 17:1`);
          if (row < 3 && col < 11) kids += ib('corner', n, 'c-tr', `Corner ${n}, ${n + 1}, ${n + 3}, ${n + 4} · pays 8:1`);
          if (row === 1) kids += ib('street', n, 'e-b', `Street ${n}-${n + 2} · pays 11:1`);
          if (row === 1 && col < 11) kids += ib('line', n, 'c-br', `Six line ${n}-${n + 5} · pays 5:1`);
          if (col === 0) kids += ib('split', n, 'e-l', `Split 0 and ${n} · pays 17:1`);
          grid += spot('straight', n, String(n), Cz.REDSET.has(n) ? 'red' : 'black', kids);
        }
        // (v5.8.5: each 2:1 now pays on the row it sits at the end of - the
        // top and bottom ones were swapped, so the one next to 36 paid on 34)
        grid += spot('column', row, '2:1', 'col');
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
      // (v5.8.5: the $500 chip was over the $350 a spot limit and did nothing)
      if (![10, 25, 50, 100, 250].includes(this.chip)) this.chip = 25;
      if (rl.phase === 'spinning' && mine.length) this._rlLast = mine.map((b) => ({ type: b.type, n: b.n, stake: b.stake }));
      const lastTot = (this._rlLast || []).reduce((a, b) => a + b.stake, 0);
      const re = rl.phase === 'betting' && !staked && lastTot && me.money - lastTot >= G.Econ.FLOOR ? `<button class="btn small" data-act="rlrebet">Rebet ${U.fmtMoney(lastTot)}</button>` : '';
      UI.patch(
        this.b.ctl,
        `<div class="chips">${[10, 25, 50, 100, 250].map((v) => `<button class="chip ${this.chip === v ? 'on' : ''}" data-act="rlchip" data-v="${v}">$${v}</button>`).join('')}</div>
         <div class="row"><span>On the table: <b>${U.fmtMoney(staked)}</b> / ${U.fmtMoney(Cz.C.RL.maxTotal)}</span><button class="btn small ghost" data-act="rlclear" ${staked && rl.phase === 'betting' ? '' : 'disabled'}>Clear</button>${re}<button class="btn small green" data-act="rlspin" ${staked && rl.phase === 'betting' ? '' : 'disabled'}>Spin now</button></div>
         <div class="rules">European single zero · straight 35:1 · split 17:1 · street 11:1 · corner 8:1 · six line 5:1 · dozens and rows 2:1 · even money 1:1, half back on 0 · ${U.fmtMoney(Cz.C.RL.min)}–${U.fmtMoney(Cz.C.RL.max)} a spot <button class="linkish" data-act="czrules">Full rules</button></div>`
      );
    },

    // v5.8.5: the full house rules, one window per game (the one-line summary
    // under each table was all there was)
    rulesHtml(tab) {
      const Cz = CZ(), B = Cz.C.BJ, RL = Cz.C.RL, m = U.fmtMoney;
      if (tab === 'bj')
        return `<div class="rules-doc">
          <p>Beat the dealer: finish closer to 21 than the dealer does without going over. Everyone at the table plays against the dealer, not each other.</p>
          <h4>Cards</h4>
          <ul><li>2 to 10 count their number; J, Q and K count 10.</li><li>An Ace counts 11, or 1 if 11 would take you over 21. A hand with an Ace counting 11 is <b>soft</b> (soft 17 = Ace + 6).</li><li><b>Blackjack</b> is an Ace and a ten-card as your first two cards. 21 on a split hand is just 21.</li></ul>
          <h4>A round</h4>
          <ul><li>Take a seat, add chips to your bet (${m(B.min)} to ${m(B.max)}) and press Deal. The deal starts ${B.betWindow / 1000} s after the first bet, or as soon as everyone seated has bet.</li>
          <li>You get two cards face up. The dealer gets one up and one face down.</li>
          <li>Dealer showing an Ace: you may take <b>insurance</b> for half your bet. It pays 2:1 if the dealer has blackjack.</li>
          <li>Dealer showing an Ace or a ten-card: the dealer checks for blackjack. If it is there the round ends at once - a blackjack of yours pushes, every other hand loses its bet.</li>
          <li>Then each hand plays in turn. You have ${B.turnTime / 1000} s to act, or you stand.</li></ul>
          <h4>Your choices</h4>
          <ul><li><b>Hit</b>: take a card. Over 21 is a bust - you lose, whatever the dealer gets.</li>
          <li><b>Stand</b>: keep what you have.</li>
          <li><b>Double</b>: double your bet on your first two cards and take exactly one more card (also after a split).</li>
          <li><b>Split</b>: two cards of the same value become two hands, each with its own bet. Split up to ${4} hands. Split Aces get one card each and cannot be split again.</li>
          <li><b>Surrender</b>: give up your first two cards and get half your bet back (not after a split).</li></ul>
          <h4>The dealer</h4>
          <p>Turns the hidden card over, then draws until reaching 17 or more, and <b>stands on every 17</b>, soft 17 too. The dealer has no choices.</p>
          <h4>Payouts</h4>
          <table class="rules-pay"><tr><td>Win</td><td>1:1</td></tr><tr><td>Blackjack</td><td>3:2</td></tr><tr><td>Push (same total)</td><td>bet back</td></tr><tr><td>Insurance</td><td>2:1</td></tr><tr><td>Surrender</td><td>half back</td></tr></table>
          <h4>Shoe and edge</h4>
          <p>${B.decks} decks, shuffled with a fair random draw and reshuffled once ${Math.round(B.penetration * 100)}% has been dealt. With these rules the house edge is about 0.3% if you play perfect basic strategy - the best bet in the casino - and about 2% playing by feel.</p>
          <h4>Basic strategy, short version</h4>
          <ul><li>Hard 17 or more: stand. 13-16: stand against 2-6, hit against 7-A. 12: stand against 4-6, otherwise hit.</li>
          <li>11: double (hit against an Ace). 10: double against 2-9. 9: double against 3-6. 8 or less: hit.</li>
          <li>Soft 19 or more: stand. Soft 18: double against 3-6, stand against 2, 7, 8, hit against 9-A. Soft 13-17: hit, but double soft 17 against 3-6, soft 15-16 against 4-6, soft 13-14 against 5-6.</li>
          <li>Always split Aces and 8s. Never split 5s or tens. Split 2s, 3s and 7s against 2-7, 6s against 2-6, 9s against 2-9 except 7, 4s against 5-6.</li>
          <li>Surrender 16 against 9, 10 or Ace, and 15 against a 10. Never take insurance.</li></ul>
        </div>`;
      return `<div class="rules-doc">
          <p>A European wheel: 37 pockets, numbers 1 to 36 (half red, half black) and a single green 0. Bet on where the ball lands; every winning bet is paid, the rest are taken.</p>
          <h4>Placing chips</h4>
          <ul><li>Pick a chip, then click a spot. Click again to add more.</li>
          <li>On a number: that number. On the line between two numbers: both (a <b>split</b>). Where four numbers meet: a <b>corner</b>. On the bottom edge of a column of three: that <b>street</b>. On the bottom edge where two streets meet: a <b>six line</b>. On the left edge next to the 0: a split with 0.</li>
          <li>Rebet puts last spin's chips down again; Clear takes yours back before the spin.</li>
          <li>The first chip starts a ${RL.betWindow / 1000} s betting window ("Spin now" closes it in 2 s). No more bets once the ball is spinning.</li></ul>
          <h4>Payouts</h4>
          <table class="rules-pay"><tr><td>Straight - one number</td><td>35:1</td></tr><tr><td>Split - two numbers</td><td>17:1</td></tr><tr><td>Street - three</td><td>11:1</td></tr><tr><td>Corner - four</td><td>8:1</td></tr><tr><td>Six line - six</td><td>5:1</td></tr><tr><td>Dozen, or a 2:1 row of twelve</td><td>2:1</td></tr><tr><td>Red / Black, Odd / Even, 1-18 / 19-36</td><td>1:1</td></tr></table>
          <h4>The zero</h4>
          <p>0 is neither red nor black, odd nor even, low nor high. When it comes up, dozens and rows lose, and the even-money bets lose only half (the French <b>la partage</b> rule): half your stake comes back.</p>
          <h4>Limits and edge</h4>
          <p>${m(RL.min)} to ${m(RL.max)} on a spot, ${m(RL.maxTotal)} a spin. The house edge is 2.70% on every bet, 1.35% on the even-money ones. The number is drawn by a fair random draw before the wheel spins; the wheel just shows it.</p>
        </div>`;
    },
    rules(tab) {
      UI.modal(tab === 'bj' ? 'Blackjack rules' : 'Roulette rules', this.rulesHtml(tab), [{ label: 'Close', value: 0, cls: 'primary' }]);
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
      // (v5.8.5: a chip adds to the bet; the total goes to the host, and a
      //  quick second click builds on the first before the state comes back)
      bjadd(el) {
        const st = G.Client.state, cz = st && st.casino;
        const s = cz && cz.bj.seats.find((x) => x && x.pid === G.Client.meId);
        if (!s) return;
        const now = performance.now();
        const base = this._bjPend != null && now < this._bjPendT && this._bjPend >= s.bet ? this._bjPend : s.bet;
        const amt = Math.min(CZ().C.BJ.max, base + +el.dataset.v);
        this._bjPend = amt;
        this._bjPendT = now + 1200;
        G.Client.act({ t: 'bjBet', amount: amt });
        if (G.Audio) G.Audio.chip();
      },
      bjclear() { this._bjPend = null; G.Client.act({ t: 'bjBet', amount: 0 }); },
      bjrebet() { if (this._bjLast) { G.Client.act({ t: 'bjBet', amount: this._bjLast }); if (G.Audio) G.Audio.chip(); } },
      czrules() { this.rules(this.tab); },
      bjdeal() { G.Client.act({ t: 'bjDeal' }); },
      ins(el) { G.Client.act({ t: 'bjInsure', yes: el.dataset.y === '1' }); },
      bj(el) { G.Client.act({ t: 'bjAct', a: el.dataset.a }); if (G.Audio) G.Audio.click(); },
      rlchip(el) { this.chip = +el.dataset.v; UI.refresh(true); },
      rl(el) { G.Client.act({ t: 'rlBet', type: el.dataset.type, n: +el.dataset.n, stake: this.chip }); if (G.Audio) G.Audio.chip(); },
      rlclear() { G.Client.act({ t: 'rlClear' }); },
      rlrebet() {
        for (const b of this._rlLast || []) G.Client.act({ t: 'rlBet', type: b.type, n: b.n, stake: b.stake });
        if (G.Audio) G.Audio.chip();
      },
      rlspin() { G.Client.act({ t: 'rlSpin' }); },
      czback() { G.App.showMenu(); },
    },
  };
  UI.register('casino', Casino);
})(window.G);
