// intermission.js — between races: tab strip (Garage / Standings / Casino),
// the standings screen, and the final standings screen.
'use strict';
(function (G) {
  const U = G.U, UI = G.UI, Parts = G.Parts;
  const hex = (c) => UI.colorHex(c);

  // Tab strip shared by every intermission screen (garage renders it too).
  UI.interTabs = function () {
    const cur = (G.Game && G.Game.interTab) || 'garage';
    const tabs = [['garage', '🔧 Garage'], ['standings', '🏆 Standings']];
    if (UI.screens.casino) tabs.push(['casino', '🎰 Casino']);
    return `<div class="itabs">${tabs.map(([k, l]) => `<button class="${cur === k ? 'on' : ''}" data-act="itab" data-tab="${k}">${l}</button>`).join('')}</div>`;
  };
  UI.globalActs.itab = (el) => {
    G.Game.interTab = el.dataset.tab;
    G.Game.syncScreen();
  };
  UI.globalActs.ready = () => {
    const me = G.Client.me;
    if (me) G.Client.act({ t: 'ready', v: !me.ready });
  };

  function standingsRows(st, me) {
    const list = Object.values(st.players).map((p) => ({ p, worth: p.money + Math.round(Parts.partsValue(p.garage) * 0.5) })).sort((a, b) => b.worth - a.worth);
    return list
      .map(({ p, worth }, i) => {
        const s = p.stats;
        const hist = s.history.slice(-8).map((x) => `<i class="f ${x === 'DNF' ? 'fd' : 'f' + Math.min(x, 4)}">${x === 'DNF' ? '×' : x}</i>`).join('');
        return `<tr class="${me && p.id === me.id ? 'me' : ''}"><td class="p">${i + 1}</td><td><i class="dot" style="background:${hex(p.color)}"></i>${U.esc(p.name)}${p.isBot ? ' <em class="tag-bot">BOT</em>' : ''}${!p.isBot && !p.connected ? ' <em class="tag-off">OFF</em>' : ''}</td><td class="num">${U.fmtMoney(worth)}</td><td class="num">${U.fmtMoney(p.money)}</td><td>${s.wins}</td><td>${s.podiums}</td><td>${hist}</td><td class="num ${s.bets + s.casino >= 0 ? 'pos' : 'neg'}">${U.fmtSigned(s.bets + s.casino)}</td></tr>`;
      })
      .join('');
  }

  const Standings = {
    mount(root) {
      root.innerHTML = `<div class="inter"><div class="panel in-card"><div class="in-head"></div><div class="in-body"></div>
        <div class="in-chat"><h3>Chat & trash talk</h3><div class="chat-log"></div><div class="chat-in"><input maxlength="140" placeholder="Say something…" data-enter="send"><button class="btn small" data-act="send">Send</button></div></div></div></div>`;
      this.el = { head: root.querySelector('.in-head'), body: root.querySelector('.in-body'), log: root.querySelector('.chat-log'), inp: root.querySelector('.chat-in input') };
    },
    acts: {
      send() {
        const v = this.el.inp.value.trim();
        if (v) G.Client.act({ t: 'chat', text: v });
        this.el.inp.value = '';
      },
    },
    render() {
      const st = G.Client.state, me = G.Client.me;
      if (!st || !me) return;
      const nid = st.schedule[st.raceNo];
      const nt = nid ? G.getTrack(nid) : null;
      UI.patch(this.el.head, `${UI.interTabs()}<div class="in-next">${nt ? `Next: <b>${U.esc(nt.name)}</b> <em class="fmt fmt-${nt.format}">${nt.format.toUpperCase()}</em>` : ''}</div><span class="muted">${G.Game.readyLine()}</span><button class="btn ${me.ready ? 'green' : 'primary'}" data-act="ready">${me.ready ? '✓ Ready' : 'Ready'}</button>`);
      const sched = st.schedule
        .map((id, i) => {
          const t = G.getTrack(id);
          return `<span class="sch ${i < st.raceNo ? 'done' : i === st.raceNo ? 'next' : ''}"><em class="fmt fmt-${t.format}">${t.format[0].toUpperCase()}</em>${U.esc(t.name)}</span>`;
        })
        .join('');
      UI.patch(
        this.el.body,
        `<h2>Standings after race ${st.raceNo}/${st.settings.races}</h2>
         <table class="stand"><tr><th>#</th><th>Driver</th><th>Net worth</th><th>Cash</th><th>Wins</th><th>Pods</th><th>Results</th><th>Bets+casino</th></tr>${standingsRows(st, me)}</table>
         <p class="muted small">Net worth = cash + half the value of owned parts (their resale value). The richest start at the BACK of the grid.</p>
         <h3>Schedule</h3><div class="sched">${sched}</div>`
      );
      const log = st.chat
        .slice(-20)
        .map((c) => (c.sys ? `<div class="cm sys">${U.esc(c.text)}</div>` : `<div class="cm"><b style="color:${hex(c.color)}">${U.esc(c.name)}</b> ${U.esc(c.text)}</div>`))
        .join('');
      if (this.el.log._html !== log) {
        UI.patch(this.el.log, log);
        this.el.log.scrollTop = 1e6;
      }
    },
    update() {
      if (Math.floor(performance.now() / 1000) !== this._t) {
        this._t = Math.floor(performance.now() / 1000);
        UI.refresh();
      }
    },
  };
  UI.register('standings', Standings);

  // ------------------------------------------------------------------ final
  const Final = {
    mount(root) {
      root.innerHTML = `<div class="inter"><div class="panel in-card final"><div class="fin-body"></div></div></div>`;
      this.body = root.querySelector('.fin-body');
    },
    render() {
      const st = G.Client.state, me = G.Client.me;
      if (!st || !st.final) return;
      const rows = st.final.rows;
      const pod = rows.slice(0, 3);
      const podium = [1, 0, 2]
        .filter((i) => pod[i])
        .map((i) => `<div class="pod pod${i + 1}"><div class="pn" style="border-color:${hex(pod[i].color)}">${U.esc(pod[i].name)}</div><div class="pw">${U.fmtMoney(pod[i].worth)}</div><div class="pb">${i + 1}</div></div>`)
        .join('');
      const by = (f, dir) => rows.slice().sort((a, b) => (dir || -1) * (f(a) - f(b)))[0];
      const aw = [];
      const w = by((r) => r.stats.wins);
      if (w && w.stats.wins) aw.push(['🏁 Most wins', w.name, w.stats.wins + ' wins']);
      const sp = by((r) => r.stats.spent);
      if (sp && sp.stats.spent) aw.push(['🛠 Biggest spender', sp.name, U.fmtMoney(sp.stats.spent) + ' on parts']);
      const rp = by((r) => r.stats.repairs);
      if (rp && rp.stats.repairs) aw.push(['🔩 Scrapyard regular', rp.name, U.fmtMoney(rp.stats.repairs) + ' in repairs']);
      const ob = by((r) => r.stats.bets);
      if (ob && ob.stats.bets > 0) aw.push(['🔮 Oracle', ob.name, U.fmtSigned(ob.stats.bets) + ' from bets']);
      const cw = by((r) => r.stats.casino, 1);
      if (cw && cw.stats.casino < 0) aw.push(['🎰 House favourite', cw.name, U.fmtSigned(cw.stats.casino) + ' at the tables']);
      const fu = by((r) => r.stats.fuel);
      if (fu && fu.stats.fuel) aw.push(['⛽ Thirstiest', fu.name, U.fmtMoney(fu.stats.fuel) + ' of fuel']);
      const table = rows
        .map((r, i) => `<tr class="${me && r.id === me.id ? 'me' : ''}"><td class="p">${i + 1}</td><td><i class="dot" style="background:${hex(r.color)}"></i>${U.esc(r.name)}${r.isBot ? ' <em class="tag-bot">BOT</em>' : ''}</td><td class="num">${U.fmtMoney(r.worth)}</td><td>${r.stats.wins}</td><td>${r.stats.podiums}</td><td class="num">${U.fmtMoney(r.stats.earned)}</td><td class="num">${U.fmtMoney(r.stats.spent)}</td><td class="num">${U.fmtMoney(r.stats.repairs + r.stats.fuel)}</td><td class="num ${r.stats.bets >= 0 ? 'pos' : 'neg'}">${U.fmtSigned(r.stats.bets)}</td><td class="num ${r.stats.casino >= 0 ? 'pos' : 'neg'}">${U.fmtSigned(r.stats.casino)}</td></tr>`)
        .join('');
      UI.patch(
        this.body,
        `<h1 class="fin-t">FINAL STANDINGS</h1><div class="podium">${podium}</div>
         <div class="awards">${aw.map((a) => `<div class="aw"><span>${a[0]}</span><b>${U.esc(a[1])}</b><em>${a[2]}</em></div>`).join('')}</div>
         <table class="stand"><tr><th>#</th><th>Driver</th><th>Net worth</th><th>Wins</th><th>Pods</th><th>Prize money</th><th>Parts</th><th>Fuel+repairs</th><th>Bets</th><th>Casino</th></tr>${table}</table>
         <div class="fin-btns"><button class="btn primary big" data-act="menu">Back to menu</button></div>`
      );
    },
    acts: {
      menu() { G.Game.leave(); },
    },
  };
  UI.register('final', Final);
})(window.G);
