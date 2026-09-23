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

  // v5.1 money: a race used to pay about what a top-tier part costs, so every
  // player bought the best thing in a slot the moment they wanted it and the
  // cheap end of the catalogue never got touched. Purses are about a third
  // smaller and start smaller still; the growth per race does the work
  // instead, so the first races are spent on $600 pads and a cat-back and the
  // last ones on the big parts.
  const E = {
    PRIZES: [1800, 1400, 1120, 880, 700, 560, 450, 350],
    DNF_PAY: 180,
    FASTEST_LAP: 250,
    GAIN_BONUS: 90, // per place gained from the grid
    GAIN_CAP: 450,
    STIPEND: 220, // two poorest racers (by net worth) each race, if 4+ racers
    GROWTH: 0.085, // purses grow 8.5% per race
    // v5.3: stakes and odds both come down. What matters is the PAYOUT next
    // to what a race pays: a win is 1,800 early on, so a best-case betting
    // race is now about 3,600 instead of 42,000.
    BET_MIN: 50, BET_MAX: 400, BET_TOTAL: 800,
    ODDS_MAX: 9, ODDS_MAX_POD: 4, // was 30x and 12x
    ODDS_SELF: 4.5, // backing yourself: you know things the book does not
    P_FLOOR: 0.05, P_FLOOR_POD: 0.09, // never price off Monte-Carlo noise
    SIDE_MIN: 100, SIDE_MAX: 700,
    MARGIN: 0.12, // bookmaker margin on odds
    FLOOR: Parts.BASIC_REPAIR,
    T: { entry: 20000, betting: 25000 },
    // v4 comeback economy
    BOUNTY: 300, // on the money leader's head: paid to the best finisher who beats them
    DOUBLE_MAX: 1400, // double-or-nothing on a race prize, capped
  };
  // capped at 3.2x (race 27 on): with sessions of up to 100 races, uncapped
  // growth would make a late win worth 7 early ones
  E.mult = (raceNo) => Math.min(3.2, 1 + E.GROWTH * (raceNo - 1));
  E.prize = (pos, dnf, raceNo) => Math.round(((dnf ? E.DNF_PAY : E.PRIZES[pos - 1] || 400) * E.mult(raceNo)) / 10) * 10;
  E.canStake = (p, amount) => p.money - amount >= E.FLOOR;

  // --------------------------------------------------------------- odds
  // Performance score 0..10 of a car on a specific track: weights depend on
  // the format (drags reward acceleration + top speed; sprints reward loose
  // surface grip + stability; circuits reward cornering).
  const _perf = {};
  function perfScore(carId, parts, wear, track, tune) {
    const key = carId + JSON.stringify(parts) + JSON.stringify(wear) + JSON.stringify(tune || {}) + track.id;
    if (_perf[key] != null) return _perf[key];
    const st = Parts.computeStats(Parts.computeSpec(carId, parts, wear, tune));
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
    const sc = perfScore(p.carId, p.garage.installed, p.garage.wear, track, p.garage.tune);
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
      const pw = Math.max(win[i] / N, E.P_FLOOR), pp = Math.max(pod[i] / N, E.P_FLOOR_POD);
      out[p.id] = {
        pWin: +pw.toFixed(3), pPod: +pp.toFixed(3),
        win: +U.clamp((1 - E.MARGIN) / pw, 1.1, E.ODDS_MAX).toFixed(2),
        podium: k > 3 ? +U.clamp((1 - E.MARGIN) / pp, 1.05, E.ODDS_MAX_POD).toFixed(2) : null,
        score: +perfScore(p.carId, p.garage.installed, p.garage.wear, track, p.garage.tune).toFixed(1),
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
    // v4 BOUNTY: from race 2, a price on the richest racer's head. Whoever
    // finishes highest ahead of them collects it (paid by the house).
    st.bounty = null;
    if (st.raceNo >= 1 && racers.length >= 3) {
      const lead = racers.slice().sort((a, b) => this.netWorth(b) - this.netWorth(a))[0];
      st.bounty = { id: lead.id, name: lead.name, amount: Math.round((E.BOUNTY * E.mult(st.raceNo + 1)) / 10) * 10 };
      this.sys(`🎯 Bounty: ${U.fmtMoney(st.bounty.amount)} to whoever finishes highest ahead of ${lead.name} (the money leader).`);
    }
    this.setPhase('betting', E.T.betting);
  };

  // ------------------------------------------------------------- bets
  HS.on_bet = function (p, m) {
    const st = this.state;
    if (st.phase !== 'betting') return this.toast(p.id, 'Betting is closed.', 'bad');
    // v4: racers may BACK THEMSELVES (never anyone else — no betting against
    // your own interests). Spectators can bet on anyone.
    if (p.entry !== 'sit' && m.racer !== p.id) return this.toast(p.id, 'Racers can only back themselves (or make side bets).', 'bad');
    const o = st.odds[m.racer];
    const r = this.player(m.racer);
    if (!o || !r) return;
    const type = m.type === 'podium' ? 'podium' : 'win';
    let odds = type === 'win' ? o.win : o.podium;
    if (!odds) return this.toast(p.id, 'No podium bets with 3 or fewer racers.', 'bad');
    // Backing yourself is priced shorter: the book only sees your car and your
    // recent results, and you know how quick you actually are.
    if (m.racer === p.id) odds = Math.min(odds, E.ODDS_SELF);
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
    const trk = G.getTrack(R.trackId);
    const need = (sim && sim.laps && trk.closed ? trk.length * sim.laps : trk.raceDistance) * 0.5;
    // v5: the endurance race is about twice as long as a normal one
    const km = R.endu ? 1.9 : 1;
    for (const row of R.rows) {
      const p = this.player(row.id);
      const ran = !row.dnf || (row.dist || 0) >= need;
      const prize = ran ? Math.round((E.prize(row.pos, row.dnf, no) * km) / 10) * 10 : 0;
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
    // v4 bounty on the money leader
    const bt = st.bounty && pos[st.bounty.id];
    if (bt) {
      const hunter = R.rows.find((r) => !r.dnf && r.id !== st.bounty.id && r.pos < bt.pos);
      R.bounty = Object.assign({}, st.bounty, { winner: hunter ? hunter.id : null, winnerName: hunter ? hunter.name : null });
      if (hunter) {
        const hp = this.player(hunter.id);
        hunter.payout.bounty = st.bounty.amount;
        hunter.payout.net += st.bounty.amount;
        if (hp) {
          hp.money += st.bounty.amount;
          hp.stats.earned += st.bounty.amount;
        }
        this.sys(`🎯 ${hunter.name} collects the ${U.fmtMoney(st.bounty.amount)} bounty on ${st.bounty.name}!`);
      }
    }
    st.bounty = null;
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

  // v4 DOUBLE OR NOTHING: on the results screen each racer may flip a coin
  // once for this race's prize (capped). A fair 50/50 — no house edge.
  HS.on_double = function (p) {
    const st = this.state;
    if (st.phase !== 'results' || !st.results) return;
    const row = st.results.rows.find((r) => r.id === p.id);
    if (!row || !row.payout || row.dbl) return;
    const amt = Math.min(row.payout.prize, E.DOUBLE_MAX);
    if (amt <= 0) return;
    if (p.money < amt) return this.toast(p.id, 'You no longer have that prize to stake.', 'bad');
    const won = U.cryptoInt(2) === 1;
    p.money += won ? amt : -amt;
    p.stats.casino += won ? amt : -amt;
    row.dbl = won ? 'won' : 'lost';
    row.dblAmt = amt;
    this.sys(`🪙 ${p.name} flipped for ${U.fmtMoney(amt)} — ${won ? 'DOUBLED it!' : 'and lost it.'}`);
    this.emit('toPlayer', p.id, { t: 'toast', msg: won ? `Heads! +${U.fmtMoney(amt)}` : `Tails. −${U.fmtMoney(amt)}`, kind: won ? 'money' : 'bad' });
    this.touch();
  };

  // --------------------------------------------------------- bots
  // Bots are cautious: repair when worn, then maybe buy one sensible upgrade
  // while keeping a cash reserve. They never gamble.
  const BOT_PREFS = [['compound', 'medium'], ['suspension', 'sport'], ['brakes', 'sport'], ['aero', 'a1'], ['exhaust', 'sport'], ['weight', 'w1'], ['ecu', 'stage1'], ['nitrous', 'n1'], ['induction', 'sc'], ['cooling', 'radiator'], ['gearing', 'short'], ['aero', 'a2'], ['weight', 'w2'], ['induction', 't1'], ['compound', 'soft'],
    // v5.1: the bespoke slots (partAllowed skips them on every other car)
    ['motor', 'sport'], ['gbturbo', 'small'], ['motor', 'racem'], ['gbturbo', 'big']];
  HS.botsShop = function () {
    const st = this.state;
    for (const b of this.bots()) {
      const g = b.garage;
      const q = Parts.repairQuote(g.installed, g.wear);
      if (g.wear.tyre > 0.55 && b.money > q.tyre + 500) { b.money -= q.tyre; b.stats.repairs += q.tyre; g.wear.tyre = 0; }
      if (g.wear.engine > 0.35 && b.money > q.engine + 500) { b.money -= q.engine; b.stats.repairs += q.engine; g.wear.engine = 0; }
      if (g.wear.body > 0.3 && b.money > q.body + 500) { b.money -= q.body; b.stats.repairs += q.body; g.wear.body = 0; }
      const roll = (U.hashStr(b.id + ':' + st.raceNo) >>> 0) % 100;
      // v4.4: each bot shops by its own style (bot.js BotKit), and a bot that's
      // doing well may buy its style's premium chassis
      const S = (G.BotKit && G.BotKit.STYLES[b.botStyle]) || null;
      const want = S && S.premium && S.premium.length ? S.premium[(U.hashStr(b.id) >>> 0) % S.premium.length] : null;
      if (want && roll < 30) {
        Parts.fixGarage(g);
        const c = Parts.CARS[want];
        if (!g.cars.includes(want) && b.money - c.price - Parts.CAR_SWAP >= 2500) {
          b.money -= c.price + Parts.CAR_SWAP;
          b.stats.spent += c.price + Parts.CAR_SWAP;
          g.cars.push(want);
          b.carId = g.carId = want;
          this.sys(`${b.name} bought a ${c.name}!`);
          continue;
        }
      }
      if (roll < 60) {
        for (const [slot, opt] of (S ? S.buys.concat(BOT_PREFS) : BOT_PREFS)) {
          if (g.owned[slot].includes(opt) || !Parts.partAllowed(b.carId, slot)) continue;
          const o = Parts.opt(slot, opt);
          // (v5.1: 1500 -> 900. Purses are a third smaller now, and the old
          //  reserve meant bots sat on their money while players spent theirs.)
          if (b.money - o.price >= 900) {
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
