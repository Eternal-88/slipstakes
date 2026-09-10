// economy.js — money rules: payouts, running costs, odds, bets, side bets,
// bot shopping. Installed as methods on HostSession (host-only).
//
// Design intent (tuned with tools/econ.js):
//  * Pay by placement, not winner-take-all: 2nd gets 77% of 1st, 3rd 62%, last
//    still covers a stock car's running costs — nobody is eliminated.
//  * Catch-up is ECONOMIC only (never a speed boost): reverse-standings grid,
//    a bonus for positions gained from the grid, a small sponsor stipend for
//    the two poorest racers, fuel/repair bills that scale with how extreme a
//    car is, and betting odds that pay less on the favourite.
//  * Gambling is gated by a FLOOR: you can never stake money you'd need for a
//    basic repair.
'use strict';
(function (G) {
  const U = G.U, Parts = G.Parts;
  const HS = G.HostSession.prototype;

  const E = {
    PRIZES: [2600, 2000, 1600, 1250, 1000, 800, 650, 500],
    DNF_PAY: 250,
    FASTEST_LAP: 300,
    GAIN_BONUS: 100, // per place gained from the grid
    GAIN_CAP: 500,
    STIPEND: 300, // two poorest racers (by net worth) each race, if 4+ racers
    GROWTH: 0.06, // purses grow 6% per race
    BET_MIN: 50, BET_MAX: 1000, BET_TOTAL: 2000,
    SIDE_MIN: 100, SIDE_MAX: 1000,
    MARGIN: 0.12, // bookmaker margin on odds
    FLOOR: Parts.BASIC_REPAIR,
    T: { entry: 20000, betting: 25000 },
  };
  E.mult = (raceNo) => 1 + E.GROWTH * (raceNo - 1);
  E.prize = (pos, dnf, raceNo) => Math.round(((dnf ? E.DNF_PAY : E.PRIZES[pos - 1] || 400) * E.mult(raceNo)) / 10) * 10;
  E.canStake = (p, amount) => p.money - amount >= E.FLOOR;

  // --------------------------------------------------------------- odds
  // Performance score 0..10 of a car on a specific track: weights depend on
  // the format (drags reward acceleration + top speed; sprints reward loose
  // surface grip + stability; circuits reward cornering).
  const _perf = {};
  function perfScore(carId, parts, wear, track) {
    const key = carId + JSON.stringify(parts) + JSON.stringify(wear) + track.id;
    if (_perf[key] != null) return _perf[key];
    const st = Parts.computeStats(Parts.computeSpec(carId, parts, wear));
    const b = {};
    st.bars.forEach((x) => (b[x.k] = x.v));
    const grip = (b['Fast-corner grip'] + b['Slow-corner grip']) / 2;
    const acc = b['Acceleration'], top = b['Top speed'], stab = b['Stability'], wet = b['Wet / dirt grip'];
    let loose = 0;
    for (let i = 0; i < track.N; i++) if (G.SURF[track.S[i]].wet || G.SURF[track.S[i]].loose) loose++;
    const lf = loose / track.N;
    let s;
    if (track.format === 'drag') s = 0.55 * acc + 0.35 * top + 0.1 * stab;
    else if (track.format === 'sprint') s = 0.22 * grip * (1 - lf) + 0.3 * wet * lf + 0.2 * acc + 0.1 * top + 0.2 * stab;
    else s = 0.32 * grip * (1 - lf) + 0.32 * wet * lf + 0.22 * acc + 0.14 * top + 0.2 * stab;
    return (_perf[key] = s);
  }

  // Strength = exp(car score + recent form + bot skill). Recent form = mean
  // finishing position over the last 3 races, scaled to an 8-car field.
  function strength(p, track) {
    const sc = perfScore(p.carId, p.garage.installed, p.garage.wear, track);
    const f = p.stats.form;
    const formAdj = f.length ? 0.5 - (f.reduce((a, b) => a + b, 0) / f.length - 1) / 7 : 0;
    const skill = p.isBot ? (p.botSkill - 0.9) * 8 : 0;
    return Math.exp(0.42 * sc + 1.7 * formAdj + skill);
  }

  // Plackett-Luce Monte Carlo: sample finishing orders proportional to
  // strength; count wins and podiums. Deterministic seed so every refresh of
  // the odds board shows the same numbers.
  function computeOdds(racers, track, seed) {
    const str = racers.map((p) => strength(p, track));
    const k = racers.length, N = 6000;
    const rng = U.rng(seed);
    const win = new Array(k).fill(0), pod = new Array(k).fill(0);
    const idx = new Array(k);
    for (let n = 0; n < N; n++) {
      for (let i = 0; i < k; i++) idx[i] = i;
      let tot = str.reduce((a, b) => a + b, 0);
      let left = k;
      for (let place = 0; place < Math.min(3, k); place++) {
        let r = rng() * tot, j = 0;
        for (; j < left - 1; j++) {
          r -= str[idx[j]];
          if (r <= 0) break;
        }
        const w = idx[j];
        if (place === 0) win[w]++;
        pod[w]++;
        tot -= str[w];
        idx[j] = idx[left - 1];
        left--;
      }
    }
    const out = {};
    racers.forEach((p, i) => {
      const pw = Math.max(win[i] / N, 0.01), pp = Math.max(pod[i] / N, 0.02);
      out[p.id] = {
        pWin: +pw.toFixed(3), pPod: +pp.toFixed(3),
        win: +U.clamp((1 - E.MARGIN) / pw, 1.1, 30).toFixed(2),
        podium: k > 3 ? +U.clamp((1 - E.MARGIN) / pp, 1.05, 12).toFixed(2) : null,
        score: +perfScore(p.carId, p.garage.installed, p.garage.wear, track).toFixed(1),
        form: p.stats.form.slice(),
      };
    });
    return out;
  }

  // ------------------------------------------------------- phase flow
  HS.startEntry = function () {
    const st = this.state;
    if (!this.nextTrackId()) return this.toFinal();
    if (this.casinoClose) this.casinoClose(); // settle/refund tables before anyone races
    for (const p of Object.values(st.players)) {
      p.entry = p.isBot ? 'race' : p.connected ? null : 'sit';
      p.ready = !!p.isBot;
    }
    st.bets = [];
    st.sideBets = [];
    st.odds = {};
    this.setPhase('entry', E.T.entry);
  };

  HS.on_entry = function (p, m) {
    if (this.state.phase !== 'entry' || p.isBot) return;
    p.entry = m.v === 'sit' ? 'sit' : 'race';
    this.touch();
    const hs = this.humans().filter((x) => x.connected);
    if (hs.every((x) => x.entry)) this.state.phaseEnds = Math.min(this.state.phaseEnds || Infinity, Date.now() + 1500);
  };

  HS.startBetting = function () {
    const st = this.state;
    for (const p of Object.values(st.players)) {
      if (!p.isBot && !p.connected) p.entry = 'sit';
      if (!p.entry) p.entry = 'race'; // undecided at the buzzer = racing
      p.ready = !!p.isBot;
    }
    const racers = this.racers();
    if (!racers.length) {
      this.sys('Nobody entered — race skipped.');
      st.raceNo++;
      return this.toIntermission();
    }
    const track = G.getTrack(this.nextTrackId());
    st.odds = computeOdds(racers, track, U.hashStr(st.code + ':' + st.raceNo));
    // Stipend goes to the two poorest racers (decided now, shown on the board).
    st.stipend = racers.length >= 4 ? racers.slice().sort((a, b) => this.netWorth(a) - this.netWorth(b)).slice(0, 2).map((p) => p.id) : [];
    this.setPhase('betting', E.T.betting);
  };

  // ------------------------------------------------------------- bets
  HS.on_bet = function (p, m) {
    const st = this.state;
    if (st.phase !== 'betting') return this.toast(p.id, 'Betting is closed.', 'bad');
    if (p.entry !== 'sit') return this.toast(p.id, 'Racers can only make side bets.', 'bad');
    const o = st.odds[m.racer];
    const r = this.player(m.racer);
    if (!o || !r) return;
    const type = m.type === 'podium' ? 'podium' : 'win';
    const odds = type === 'win' ? o.win : o.podium;
    if (!odds) return this.toast(p.id, 'No podium bets with 3 or fewer racers.', 'bad');
    const stake = Math.round(+m.stake);
    if (!(stake >= E.BET_MIN && stake <= E.BET_MAX)) return this.toast(p.id, `Bets are ${U.fmtMoney(E.BET_MIN)}–${U.fmtMoney(E.BET_MAX)}.`, 'bad');
    const mine = st.bets.filter((b) => b.pid === p.id).reduce((a, b) => a + b.stake, 0);
    if (mine + stake > E.BET_TOTAL) return this.toast(p.id, `Max ${U.fmtMoney(E.BET_TOTAL)} in bets per race.`, 'bad');
    if (!E.canStake(p, stake)) return this.toast(p.id, `You must keep ${U.fmtMoney(E.FLOOR)} for a basic repair.`, 'bad');
    p.money -= stake;
    st.bets.push({ id: U.uid(6), pid: p.id, name: p.name, racer: r.id, racerName: r.name, type, stake, odds });
    this.sys(`${p.name} bet ${U.fmtMoney(stake)} on ${r.name} to ${type === 'win' ? 'WIN' : 'PODIUM'} @ ${odds.toFixed(2)}x`);
    this.toast(p.id, `Bet placed: ${U.fmtMoney(stake)} → pays ${U.fmtMoney(stake * odds)}.`, 'money');
    this.touch();
  };

  HS.on_sideBet = function (p, m) {
    const st = this.state;
    if (st.phase !== 'betting') return this.toast(p.id, 'Side bets are made before the race.', 'bad');
    const t = this.player(m.to);
    if (p.entry !== 'race' || !t || t.id === p.id || t.entry !== 'race') return this.toast(p.id, 'Side bets are between two racers.', 'bad');
    const stake = Math.round(+m.stake);
    if (!(stake >= E.SIDE_MIN && stake <= E.SIDE_MAX)) return this.toast(p.id, `Side bets are ${U.fmtMoney(E.SIDE_MIN)}–${U.fmtMoney(E.SIDE_MAX)}.`, 'bad');
    if (!E.canStake(p, stake)) return this.toast(p.id, `You must keep ${U.fmtMoney(E.FLOOR)} for a basic repair.`, 'bad');
    const open = st.sideBets.some((s) => (s.status === 'pending' || s.status === 'accepted') && ((s.from === p.id && s.to === t.id) || (s.from === t.id && s.to === p.id)));
    if (open) return this.toast(p.id, `You already have a side bet with ${t.name}.`, 'bad');
    const sb = { id: U.uid(6), from: p.id, fromName: p.name, to: t.id, toName: t.name, stake, status: 'pending' };
    st.sideBets.push(sb);
    if (t.isBot) {
      // Bots take a punt if it's not a big chunk of their bankroll.
      const ok = E.canStake(t, stake) && stake <= t.money * 0.2 && U.hashStr(sb.id) % 10 < 7;
      if (ok) this._acceptSide(sb);
      else sb.status = 'declined';
      this.sys(`${t.name} ${sb.status === 'accepted' ? 'ACCEPTED' : 'declined'} ${p.name}'s ${U.fmtMoney(stake)} side bet.`);
    } else {
      this.sys(`${p.name} challenges ${t.name}: "I'll beat you, ${U.fmtMoney(stake)}."`);
      this.toast(t.id, `${p.name} challenges you for ${U.fmtMoney(stake)}!`, 'money');
    }
    this.touch();
  };

  HS._acceptSide = function (sb) {
    const a = this.player(sb.from), b = this.player(sb.to);
    if (!a || !b || !E.canStake(a, sb.stake) || !E.canStake(b, sb.stake)) {
      sb.status = 'declined';
      return false;
    }
    a.money -= sb.stake;
    b.money -= sb.stake;
    sb.status = 'accepted';
    return true;
  };

  HS.on_sideReply = function (p, m) {
    const sb = this.state.sideBets.find((s) => s.id === m.id);
    if (!sb || sb.to !== p.id || sb.status !== 'pending' || this.state.phase !== 'betting') return;
    if (m.accept) {
      if (!this._acceptSide(sb)) this.toast(p.id, 'Can\'t accept: one of you would drop below the repair floor.', 'bad');
      else this.sys(`${p.name} accepted ${sb.fromName}'s ${U.fmtMoney(sb.stake)} side bet. Game on.`);
    } else {
      sb.status = 'declined';
      this.sys(`${p.name} declined ${sb.fromName}'s side bet.`);
    }
    this.touch();
  };

  // Called when a race starts: unanswered side bets are void.
  HS.voidPendingSide = function () {
    for (const sb of this.state.sideBets) if (sb.status === 'pending') sb.status = 'void';
  };

  // Autosave restore of a race in progress: give every stake back.
  HS.refundBets = function (why) {
    const st = this.state;
    for (const b of st.bets || []) {
      const p = this.player(b.pid);
      if (p) p.money += b.stake;
    }
    for (const sb of st.sideBets || []) {
      if (sb.status !== 'accepted') continue;
      const a = this.player(sb.from), b = this.player(sb.to);
      if (a) a.money += sb.stake;
      if (b) b.money += sb.stake;
    }
    st.bets = [];
    st.sideBets = [];
    if (why) this.sys(why + ' — all bets refunded.');
  };

  // ------------------------------------------------------ settlement
  // Hook called by finishRace() with the classified results.
  HS.onRaceResults = function (R, sim) {
    const st = this.state;
    const no = st.race.no;
    const stipend = new Set(st.stipend || []);
    // Anti-AFK: a DNF is only paid (appearance fee + stipend) if the car covered
    // at least half the race. Otherwise parking on the grid every race would
    // out-earn finishing last, with zero wear.
    const need = G.getTrack(R.trackId).raceDistance * 0.5;
    for (const row of R.rows) {
      const p = this.player(row.id);
      const ran = !row.dnf || (row.dist || 0) >= need;
      const prize = ran ? E.prize(row.pos, row.dnf, no) : 0;
      const fast = R.fastest && R.fastest.id === row.id ? E.FASTEST_LAP : 0;
      const gain = row.dnf ? 0 : U.clamp((row.grid - row.pos) * E.GAIN_BONUS, 0, E.GAIN_CAP);
      const sti = ran && stipend.has(row.id) ? E.STIPEND : 0;
      const fuel = row.fuel || 0;
      const net = prize + fast + gain + sti - fuel;
      row.payout = { prize, fast, gain, stipend: sti, fuel, net };
      if (p) {
        p.money = Math.max(0, p.money + net);
        p.stats.earned += prize + fast + gain + sti;
        p.stats.fuel += fuel;
      }
    }
    const pos = {};
    R.rows.forEach((r) => (pos[r.id] = r));
    R.bets = (st.bets || []).map((b) => {
      const r = pos[b.racer];
      const won = r && !r.dnf && (b.type === 'win' ? r.pos === 1 : r.pos <= 3);
      const payout = won ? Math.round(b.stake * b.odds) : 0;
      const p = this.player(b.pid);
      if (p) {
        p.money += payout;
        p.stats.bets += payout - b.stake;
      }
      return Object.assign({}, b, { won, payout });
    });
    R.sideBets = (st.sideBets || [])
      .filter((s) => s.status === 'accepted')
      .map((s) => {
        const a = pos[s.from], b = pos[s.to];
        let winner = null;
        if (a && b && !(a.dnf && b.dnf)) winner = a.pos < b.pos ? s.from : s.to;
        const pa = this.player(s.from), pb = this.player(s.to);
        if (winner) {
          const w = this.player(winner);
          if (w) w.money += s.stake * 2;
          if (pa) pa.stats.bets += winner === s.from ? s.stake : -s.stake;
          if (pb) pb.stats.bets += winner === s.to ? s.stake : -s.stake;
        } else {
          if (pa) pa.money += s.stake;
          if (pb) pb.money += s.stake;
        }
        return Object.assign({}, s, { winner });
      });
    st.bets = [];
    st.sideBets = [];
  };

  // --------------------------------------------------------- bots
  // Bots are cautious: repair when worn, then maybe buy one sensible upgrade
  // while keeping a cash reserve. They never gamble.
  const BOT_PREFS = [['compound', 'medium'], ['suspension', 'sport'], ['aero', 'a1'], ['weight', 'w1'], ['induction', 'sc'], ['gearing', 'short'], ['aero', 'a2'], ['weight', 'w2'], ['induction', 't1'], ['compound', 'soft']];
  HS.botsShop = function () {
    const st = this.state;
    for (const b of this.bots()) {
      const g = b.garage;
      const q = Parts.repairQuote(g.installed, g.wear);
      if (g.wear.tyre > 0.55 && b.money > q.tyre + 500) { b.money -= q.tyre; b.stats.repairs += q.tyre; g.wear.tyre = 0; }
      if (g.wear.engine > 0.35 && b.money > q.engine + 500) { b.money -= q.engine; b.stats.repairs += q.engine; g.wear.engine = 0; }
      if (g.wear.body > 0.3 && b.money > q.body + 500) { b.money -= q.body; b.stats.repairs += q.body; g.wear.body = 0; }
      const roll = U.hashStr(b.id + ':' + st.raceNo) % 100;
      if (roll < 55) {
        for (const [slot, opt] of BOT_PREFS) {
          if (g.owned[slot].includes(opt)) continue;
          const o = Parts.opt(slot, opt);
          if (b.money - o.price >= 1500) {
            b.money -= o.price;
            b.stats.spent += o.price;
            g.owned[slot].push(opt);
            g.installed[slot] = opt;
            if (slot === 'compound' || slot === 'width') g.wear.tyre = 0;
          }
          break;
        }
      }
    }
    this.touch();
  };

  // Money leaderboard (net worth = cash + half the parts' value).
  HS.standings = function () {
    return Object.values(this.state.players)
      .map((p) => ({ id: p.id, name: p.name, color: p.color, isBot: p.isBot, money: p.money, worth: this.netWorth(p), stats: p.stats }))
      .sort((a, b) => b.worth - a.worth);
  };

  G.Econ = Object.assign(E, { perfScore, computeOdds, strength });
})(window.G);
