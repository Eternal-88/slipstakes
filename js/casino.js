// casino.js — host-authoritative blackjack and roulette, open between races.
//
// Blackjack rules (standard US, stated on the table):
//   6-deck shoe, reshuffled at 75% penetration; dealer stands on ALL 17s;
//   blackjack pays 3:2; double on any first two cards incl. after split;
//   split equal-value pairs up to 4 hands; split aces get one card each;
//   dealer peeks for blackjack with an Ace or ten up; insurance pays 2:1;
//   ties push; 21 on a split hand is not a blackjack. House edge ≈ 0.4% with
//   perfect basic strategy, ~2% for typical play.
// Roulette: European single-zero wheel (house edge 2.70%). Straight 35:1,
//   dozens/columns 2:1, red/black/odd/even/low/high 1:1, zero loses outside bets.
//
// Why grinding it is worse than racing: every casino bet has negative
// expected value, stakes are capped ($500/hand, $1,500/spin), the tables are
// only open during the intermission, and the repair FLOOR means you can never
// bet the money you need to keep racing. Racing pays $500–$2,600 per race.
//
// Fairness: shuffles and spins use crypto.getRandomValues on the host. The
// shoe AND the dealer's hole card live in host-only fields that publicState()
// strips, so no client can read them from the network.
'use strict';
(function (G) {
  const U = G.U;
  const HS = G.HostSession.prototype;

  const C = {
    BJ: { decks: 6, seats: 5, min: 25, max: 500, betWindow: 12000, turnTime: 15000, insTime: 8000, settleTime: 5500, dealerStep: 750, penetration: 0.75 },
    RL: { min: 10, max: 500, maxTotal: 1500, betWindow: 20000, spinTime: 5500, resultTime: 5000 },
    RED: [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36],
    WHEEL: [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26],
  };
  const REDSET = new Set(C.RED);
  const floor = () => G.Econ.FLOOR;

  // ------------------------------------------------------------ cards
  const rank = (c) => c % 13; // 0 = A, 1..9 = 2..10, 10..12 = J Q K
  const cardVal = (c) => {
    const r = rank(c);
    return r === 0 ? 11 : r >= 9 ? 10 : r + 1;
  };
  function total(cards) {
    let t = 0, aces = 0;
    for (const c of cards) {
      if (c < 0) continue; // face-down card
      const v = cardVal(c);
      t += v;
      if (v === 11) aces++;
    }
    while (t > 21 && aces) {
      t -= 10;
      aces--;
    }
    return { t, soft: aces > 0 };
  }
  const natural = (h) => h.cards.length === 2 && !h.fromSplit && total(h.cards).t === 21;

  function newShoe(decks) {
    const a = [];
    for (let d = 0; d < decks; d++) for (let c = 0; c < 52; c++) a.push(c);
    for (let i = a.length - 1; i > 0; i--) {
      const j = U.cryptoInt(i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function newBJ() {
    return { phase: 'betting', deadline: 0, seats: [null, null, null, null, null], dealer: { cards: [] }, turn: null, round: 0, msg: 'Take a seat and place a bet.', shoe: [], shoeLeft: 0, hole: null };
  }
  function newRL() {
    return { phase: 'betting', deadline: 0, bets: [], result: null, round: 0, history: [], last: {} };
  }

  HS.casino = function () {
    if (!this.state.casino) this.state.casino = { bj: newBJ(), rl: newRL() };
    return this.state.casino;
  };
  HS.casinoOpen = function () {
    return this.state.phase === 'intermission' || this.state.phase === 'results';
  };
  HS._stake = function (p, amount, what) {
    if (!(amount > 0)) return false;
    if (p.money - amount < floor()) {
      this.toast(p.id, `Floor: you must keep ${U.fmtMoney(floor())} for a basic repair — can't ${what}.`, 'bad');
      return false;
    }
    p.money -= amount;
    return true;
  };

  // ======================================================== BLACKJACK
  const seatOf = (bj, pid) => bj.seats.findIndex((s) => s && s.pid === pid);

  HS.on_bjSit = function (p, m) {
    if (!this.casinoOpen()) return this.toast(p.id, 'The casino is closed during races.', 'bad');
    const bj = this.casino().bj;
    const i = +m.seat;
    if (seatOf(bj, p.id) >= 0 || !(i >= 0 && i < C.BJ.seats) || bj.seats[i]) return;
    bj.seats[i] = { pid: p.id, name: p.name, color: p.color, bet: 0, hands: [], insurance: 0, insDone: false, staked: 0 };
    this.touch();
  };

  HS.on_bjLeave = function (p) {
    const bj = this.casino().bj;
    const i = seatOf(bj, p.id);
    if (i < 0) return;
    const s = bj.seats[i];
    if (s.hands.length && bj.phase !== 'settled') return this.toast(p.id, 'Finish the hand first.', 'bad');
    if (s.bet) p.money += s.bet;
    bj.seats[i] = null;
    this.touch();
  };

  HS.on_bjBet = function (p, m) {
    const bj = this.casino().bj;
    const i = seatOf(bj, p.id);
    if (i < 0 || bj.phase !== 'betting' || !this.casinoOpen()) return;
    const s = bj.seats[i];
    const amt = Math.round(+m.amount);
    if (!(amt >= C.BJ.min && amt <= C.BJ.max)) return this.toast(p.id, `Table limits ${U.fmtMoney(C.BJ.min)}–${U.fmtMoney(C.BJ.max)}.`, 'bad');
    p.money += s.bet; // replacing an earlier bet
    const prev = s.bet;
    s.bet = 0;
    if (!this._stake(p, amt, 'bet that much')) {
      if (this._stake(p, prev, 'restore')) s.bet = prev;
      return;
    }
    s.bet = amt;
    if (!bj.deadline) bj.deadline = Date.now() + C.BJ.betWindow;
    bj.msg = 'Betting… dealing soon.';
    this.touch();
  };

  HS.on_bjDeal = function (p) {
    const bj = this.casino().bj;
    if (bj.phase !== 'betting' || seatOf(bj, p.id) < 0) return;
    const seated = bj.seats.filter(Boolean);
    if (!seated.some((s) => s.bet)) return;
    bj.deadline = seated.every((s) => s.bet) ? Date.now() : Math.min(bj.deadline || Infinity, Date.now() + 3000);
    this.touch();
  };

  HS._bjDraw = function () {
    const bj = this.casino().bj;
    if (!bj.shoe.length) bj.shoe = newShoe(C.BJ.decks);
    const c = bj.shoe.pop();
    bj.shoeLeft = bj.shoe.length;
    return c;
  };

  HS._bjDeal = function () {
    const bj = this.casino().bj;
    const live = bj.seats.filter((s) => s && s.bet);
    if (!live.length) {
      bj.deadline = 0;
      return;
    }
    if (bj.shoe.length < 52 * C.BJ.decks * (1 - C.BJ.penetration)) {
      bj.shoe = newShoe(C.BJ.decks);
      bj.msg = 'Fresh shoe shuffled.';
    }
    for (const s of bj.seats) {
      if (!s) continue;
      s.hands = [];
      s.insurance = 0;
      s.insDone = false;
      s.staked = 0;
      if (s.bet) {
        s.hands.push({ cards: [], bet: s.bet, doubled: false, done: false, fromSplit: false, splitAces: false, result: null, payout: 0 });
        s.staked = s.bet;
        s.bet = 0;
      }
    }
    const hands = [];
    bj.seats.forEach((s) => s && s.hands.forEach((h) => hands.push(h)));
    for (const h of hands) h.cards.push(this._bjDraw());
    const up = this._bjDraw();
    for (const h of hands) h.cards.push(this._bjDraw());
    bj.hole = this._bjDraw(); // host-only until revealed
    bj.dealer = { cards: [up, -1] };
    bj.round++;
    if (rank(up) === 0) {
      bj.phase = 'insurance';
      bj.deadline = Date.now() + C.BJ.insTime;
      bj.msg = 'Dealer shows an Ace — insurance?';
    } else if (cardVal(up) === 10) this._bjPeek();
    else this._bjStartPlay();
    this.touch();
  };

  HS.on_bjInsure = function (p, m) {
    const bj = this.casino().bj;
    const i = seatOf(bj, p.id);
    if (bj.phase !== 'insurance' || i < 0) return;
    const s = bj.seats[i];
    if (!s.hands.length || s.insDone) return;
    s.insDone = true;
    if (m.yes) {
      const cost = Math.floor(s.hands[0].bet / 2);
      if (this._stake(p, cost, 'take insurance')) s.insurance = cost;
    }
    if (bj.seats.every((x) => !x || !x.hands.length || x.insDone)) bj.deadline = Date.now();
    this.touch();
  };

  // Dealer checks the hole card for blackjack (Ace or ten showing).
  HS._bjPeek = function () {
    const bj = this.casino().bj;
    if (total([bj.dealer.cards[0], bj.hole]).t === 21) {
      bj.dealer.cards[1] = bj.hole;
      bj.hole = null;
      bj.msg = 'Dealer has BLACKJACK.';
      this._bjSettle();
    } else {
      bj.msg = 'Dealer checks… no blackjack.';
      this._bjStartPlay();
    }
  };

  HS._bjStartPlay = function () {
    const bj = this.casino().bj;
    for (const s of bj.seats) if (s) for (const h of s.hands) if (natural(h)) h.done = true;
    bj.phase = 'playing';
    this._bjNext();
  };

  HS._bjNext = function () {
    const bj = this.casino().bj;
    for (let si = 0; si < bj.seats.length; si++) {
      const s = bj.seats[si];
      if (!s) continue;
      for (let hi = 0; hi < s.hands.length; hi++) {
        if (!s.hands[hi].done) {
          bj.turn = { seat: si, hand: hi };
          bj.deadline = Date.now() + C.BJ.turnTime;
          bj.msg = `${s.name} to act.`;
          return;
        }
      }
    }
    bj.turn = null;
    // Everyone's done: reveal and let the dealer draw (one card per step).
    bj.dealer.cards[1] = bj.hole;
    bj.hole = null;
    bj.phase = 'dealer';
    bj.deadline = Date.now() + C.BJ.dealerStep;
    bj.msg = 'Dealer plays.';
  };

  HS.on_bjAct = function (p, m) {
    const bj = this.casino().bj;
    if (bj.phase !== 'playing' || !bj.turn) return;
    const s = bj.seats[bj.turn.seat];
    if (!s || s.pid !== p.id) return;
    this._bjDo(s, bj.turn.hand, m.a, p);
    this.touch();
  };

  HS._bjDo = function (s, hi, a, p) {
    const bj = this.casino().bj;
    const h = s.hands[hi];
    if (a === 'hit' && !h.splitAces) {
      h.cards.push(this._bjDraw());
      const t = total(h.cards).t;
      if (t > 21) {
        h.done = true;
        h.result = 'bust';
      } else if (t === 21) h.done = true;
    } else if (a === 'double') {
      if (h.cards.length !== 2 || h.splitAces || !p || !this._stake(p, h.bet, 'double')) return;
      s.staked += h.bet;
      h.bet *= 2;
      h.doubled = true;
      h.cards.push(this._bjDraw());
      h.done = true;
      if (total(h.cards).t > 21) h.result = 'bust';
    } else if (a === 'split') {
      if (h.cards.length !== 2 || cardVal(h.cards[0]) !== cardVal(h.cards[1]) || s.hands.length >= 4 || h.splitAces) return;
      if (!p || !this._stake(p, h.bet, 'split')) return;
      s.staked += h.bet;
      const aces = rank(h.cards[0]) === 0;
      const h2 = { cards: [h.cards.pop()], bet: h.bet, doubled: false, done: false, fromSplit: true, splitAces: aces, result: null, payout: 0 };
      h.fromSplit = true;
      h.splitAces = aces;
      h.cards.push(this._bjDraw());
      h2.cards.push(this._bjDraw());
      s.hands.splice(hi + 1, 0, h2);
      for (const x of [h, h2]) if (aces || total(x.cards).t === 21) x.done = true; // split aces: one card only
    } else {
      h.done = true; // stand (also the timeout default)
    }
    if (h.done) this._bjNext();
    else bj.deadline = Date.now() + C.BJ.turnTime;
  };

  // Pay everyone. Returns stake+winnings: natural 2.5x, win 2x, push 1x.
  HS._bjSettle = function () {
    const bj = this.casino().bj;
    const d = bj.dealer.cards;
    const dt = total(d).t;
    const dNat = d.length === 2 && dt === 21;
    const lines = [];
    for (const s of bj.seats) {
      if (!s || !s.hands.length) continue;
      const p = this.player(s.pid);
      let pay = 0;
      for (const h of s.hands) {
        const t = total(h.cards).t;
        const nat = natural(h);
        if (t > 21) { h.result = 'bust'; h.payout = 0; }
        else if (nat && !dNat) { h.result = 'blackjack'; h.payout = h.bet * 2.5; }
        else if (nat && dNat) { h.result = 'push'; h.payout = h.bet; }
        else if (dNat) { h.result = 'lose'; h.payout = 0; }
        else if (dt > 21 || t > dt) { h.result = 'win'; h.payout = h.bet * 2; }
        else if (t === dt) { h.result = 'push'; h.payout = h.bet; }
        else { h.result = 'lose'; h.payout = 0; }
        pay += h.payout;
      }
      if (s.insurance) pay += dNat ? s.insurance * 3 : 0;
      pay = Math.round(pay);
      const net = pay - s.staked - s.insurance;
      if (p) {
        p.money += pay;
        p.stats.casino += net;
      }
      s.lastNet = net;
      lines.push(`${s.name} ${U.fmtSigned(net)}`);
    }
    bj.phase = 'settled';
    bj.turn = null;
    bj.deadline = Date.now() + C.BJ.settleTime;
    bj.msg = (dNat ? 'Dealer blackjack. ' : dt > 21 ? 'Dealer busts! ' : `Dealer ${dt}. `) + lines.join(' · ');
  };

  HS._bjTick = function (now) {
    const bj = this.casino().bj;
    if (!bj.deadline || now < bj.deadline) return;
    if (bj.phase === 'betting') this._bjDeal();
    else if (bj.phase === 'insurance') {
      for (const s of bj.seats) if (s && s.hands.length) s.insDone = true;
      this._bjPeek();
    } else if (bj.phase === 'playing' && bj.turn) {
      const s = bj.seats[bj.turn.seat];
      this._bjDo(s, bj.turn.hand, 'stand', null); // timeout = stand
    } else if (bj.phase === 'dealer') {
      if (total(bj.dealer.cards).t < 17 && this._bjAnyLive()) {
        bj.dealer.cards.push(this._bjDraw());
        bj.deadline = now + C.BJ.dealerStep;
      } else this._bjSettle();
    } else if (bj.phase === 'settled') {
      for (const s of bj.seats) if (s) s.hands = [];
      bj.dealer = { cards: [] };
      bj.phase = 'betting';
      bj.deadline = 0;
      bj.msg = 'Place your bets.';
    }
    this.touch();
  };
  // Dealer only draws if some hand is still alive (not bust, not a natural).
  HS._bjAnyLive = function () {
    return this.casino().bj.seats.some((s) => s && s.hands.some((h) => total(h.cards).t <= 21 && !natural(h)));
  };

  // ========================================================= ROULETTE
  const RL_TYPES = { straight: 35, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1, dozen: 2, column: 2 };
  function rlWins(type, n, r) {
    if (type === 'straight') return r === n;
    if (r === 0) return false;
    switch (type) {
      case 'red': return REDSET.has(r);
      case 'black': return !REDSET.has(r);
      case 'odd': return r % 2 === 1;
      case 'even': return r % 2 === 0;
      case 'low': return r <= 18;
      case 'high': return r >= 19;
      case 'dozen': return Math.ceil(r / 12) === n;
      case 'column': return ((r - 1) % 3) + 1 === n;
    }
    return false;
  }

  HS.on_rlBet = function (p, m) {
    if (!this.casinoOpen()) return this.toast(p.id, 'The casino is closed during races.', 'bad');
    const rl = this.casino().rl;
    if (rl.phase !== 'betting') return this.toast(p.id, 'No more bets — wait for the next spin.', 'bad');
    const type = String(m.type);
    if (!(type in RL_TYPES)) return;
    let n = Math.round(+m.n || 0);
    if (type === 'straight' && !(n >= 0 && n <= 36)) return;
    if ((type === 'dozen' || type === 'column') && !(n >= 1 && n <= 3)) return;
    if (type !== 'straight' && type !== 'dozen' && type !== 'column') n = 0;
    const stake = Math.round(+m.stake);
    if (!(stake >= C.RL.min && stake <= C.RL.max)) return;
    const mine = rl.bets.filter((b) => b.pid === p.id);
    const spot = mine.find((b) => b.type === type && b.n === n);
    if ((spot ? spot.stake : 0) + stake > C.RL.max) return this.toast(p.id, `Max ${U.fmtMoney(C.RL.max)} on one spot.`, 'bad');
    if (mine.reduce((a, b) => a + b.stake, 0) + stake > C.RL.maxTotal) return this.toast(p.id, `Max ${U.fmtMoney(C.RL.maxTotal)} per spin.`, 'bad');
    if (!this._stake(p, stake, 'bet that')) return;
    if (spot) spot.stake += stake;
    else rl.bets.push({ pid: p.id, name: p.name, color: p.color, type, n, stake });
    if (!rl.deadline) rl.deadline = Date.now() + C.RL.betWindow;
    this.touch();
  };

  HS.on_rlClear = function (p) {
    const rl = this.casino().rl;
    if (rl.phase !== 'betting') return;
    let back = 0;
    rl.bets = rl.bets.filter((b) => {
      if (b.pid !== p.id) return true;
      back += b.stake;
      return false;
    });
    p.money += back;
    if (!rl.bets.length) rl.deadline = 0;
    this.touch();
  };

  HS.on_rlSpin = function (p) {
    const rl = this.casino().rl;
    if (rl.phase === 'betting' && rl.bets.some((b) => b.pid === p.id)) rl.deadline = Math.min(rl.deadline, Date.now() + 2000);
    this.touch();
  };

  HS._rlSettle = function () {
    const rl = this.casino().rl;
    const r = rl.result;
    const per = {};
    for (const b of rl.bets) {
      const won = rlWins(b.type, b.n, r);
      const pay = won ? b.stake * (RL_TYPES[b.type] + 1) : 0;
      const p = this.player(b.pid);
      if (p) {
        p.money += pay;
        p.stats.casino += pay - b.stake;
      }
      per[b.pid] = (per[b.pid] || 0) + pay - b.stake;
    }
    rl.last = per;
    rl.history.unshift(r);
    if (rl.history.length > 14) rl.history.pop();
  };

  HS._rlTick = function (now) {
    const rl = this.casino().rl;
    if (!rl.deadline || now < rl.deadline) return;
    if (rl.phase === 'betting') {
      rl.result = U.cryptoInt(37);
      rl.phase = 'spinning';
      rl.round++;
      rl.deadline = now + C.RL.spinTime;
    } else if (rl.phase === 'spinning') {
      this._rlSettle();
      rl.phase = 'result';
      rl.deadline = now + C.RL.resultTime;
    } else if (rl.phase === 'result') {
      rl.bets = [];
      rl.phase = 'betting';
      rl.deadline = 0;
    }
    this.touch();
  };

  HS.casinoTick = function (now) {
    if (!this.state.casino) return;
    this._bjTick(now);
    this._rlTick(now);
  };

  // Called when the intermission ends: nothing is left hanging over a race.
  // Unplayed hands are stood, the dealer plays out, pending bets refunded,
  // and everyone stands up from the tables.
  HS.casinoClose = function () {
    if (!this.state.casino) return;
    const { bj, rl } = this.state.casino;
    if (bj.phase === 'betting') {
      for (const s of bj.seats) if (s && s.bet) { const p = this.player(s.pid); if (p) p.money += s.bet; s.bet = 0; }
    } else if (bj.phase !== 'settled') {
      if (bj.phase === 'insurance') for (const s of bj.seats) if (s) s.insDone = true;
      for (const s of bj.seats) if (s) for (const h of s.hands) h.done = true;
      if (bj.hole != null) { bj.dealer.cards[1] = bj.hole; bj.hole = null; }
      while (total(bj.dealer.cards).t < 17 && this._bjAnyLive()) bj.dealer.cards.push(this._bjDraw());
      this._bjSettle();
    }
    bj.seats = [null, null, null, null, null];
    bj.phase = 'betting';
    bj.deadline = 0;
    bj.dealer = { cards: [] };
    bj.msg = 'Take a seat and place a bet.';
    if (rl.phase === 'betting') {
      for (const b of rl.bets) { const p = this.player(b.pid); if (p) p.money += b.stake; }
    } else if (rl.phase === 'spinning') this._rlSettle();
    rl.bets = [];
    rl.phase = 'betting';
    rl.deadline = 0;
    this.touch();
  };

  G.Casino = { C, total, cardVal, rank, natural, rlWins, RL_TYPES, REDSET, newShoe };
})(window.G);
