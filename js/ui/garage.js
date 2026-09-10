// garage.js — the shop. Parts accordion with honest upside/downside text,
// stat bars comparing the CURRENT build (solid) with the CANDIDATE build
// (marker + delta), interaction warnings, service/repairs, and a live 3D
// handling preview + test drive of the candidate before you pay.
'use strict';
(function (G) {
  const U = G.U, Parts = G.Parts, UI = G.UI;

  const Garage = {
    mount(root, arg) {
      this.arg = arg || {};
      this.sel = this.sel || 'induction';
      this.pick = null; // {slot, opt} sticky selection
      this.hov = null; // hovered option
      this.tab = 'parts';
      this._statsCache = {};
      root.innerHTML = `
        <div class="garage">
          <div class="g-head">
            <div class="g-title"><h1>GARAGE</h1><div class="g-itabs"></div><div class="g-car"></div></div>
            <div class="g-next"></div>
            <div class="g-extra"></div>
            <div class="g-money"></div>
            <div class="g-btns"></div>
          </div>
          <div class="g-left">
            <div class="panel g-stats"></div>
            <div class="panel g-warn"></div>
          </div>
          <div class="g-center"><div class="g-live"></div></div>
          <div class="panel g-right">
            <div class="tabs"><button data-act="tab" data-tab="parts">Parts</button><button data-act="tab" data-tab="service">Service</button></div>
            <div class="g-body"></div>
          </div>
        </div>`;
      const $ = (s) => root.querySelector(s);
      this.el = { itabs: $('.g-itabs'), car: $('.g-car'), next: $('.g-next'), extra: $('.g-extra'), money: $('.g-money'), btns: $('.g-btns'), stats: $('.g-stats'), warn: $('.g-warn'), body: $('.g-body'), live: $('.g-live'), tabs: root.querySelectorAll('.tabs button') };
      const me = G.Client.me;
      if (me) G.Preview.start(G.App.world, this.candidate(), me.color);
    },

    unmount() {
      G.Preview.stop();
    },

    // Candidate garage = installed + the selected (or hovered) option.
    candidate() {
      const me = G.Client.me;
      if (!me) return null;
      const g = me.garage;
      const inst = Object.assign({}, g.installed);
      const o = this.pick || this.hov;
      let wear = Object.assign({}, g.wear);
      if (o) {
        inst[o.slot] = o.opt;
        if ((o.slot === 'compound' || o.slot === 'width') && o.opt !== g.installed[o.slot]) wear.tyre = 0;
      }
      return { carId: me.carId, installed: inst, wear };
    },

    stats(carId, installed, wear) {
      const k = carId + JSON.stringify(installed) + JSON.stringify(wear);
      if (!this._statsCache[k]) {
        const spec = Parts.computeSpec(carId, installed, wear);
        this._statsCache[k] = { spec, st: Parts.computeStats(spec) };
      }
      return this._statsCache[k];
    },

    render() {
      const me = G.Client.me;
      if (!me) return;
      const g = me.garage;
      const car = Parts.CARS[me.carId];
      const cand = this.candidate();
      G.Preview.setBuild(cand);
      UI.patch(this.el.itabs, this.arg.tabs && UI.interTabs ? UI.interTabs() : '');
      UI.patch(this.el.car, `<b style="color:${UI.colorHex(me.color)}">■</b> ${U.esc(car.name)} <span>${car.tag}</span>`);
      UI.patch(this.el.money, `<span>CASH</span><b>${U.fmtMoney(me.money)}</b>`);
      // arg fields may be values or functions (intermission passes live getters)
      const val = (v) => (typeof v === 'function' ? v() : v);
      const next = val(this.arg.nextTrack);
      const doneLabel = val(this.arg.doneLabel);
      UI.patch(this.el.next, next ? `<span>NEXT RACE</span><b>${U.esc(next.name)}</b><em class="fmt fmt-${next.format}">${next.format.toUpperCase()}</em>` : '');
      UI.patch(
        this.el.btns,
        `<button class="btn ghost" data-act="testdrive">Test drive candidate</button>` +
          (doneLabel ? `<button class="btn ${me.ready ? 'green' : 'primary'}" data-act="done">${U.esc(doneLabel)}</button>` : '')
      );
      this.el.tabs.forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
      UI.patch(this.el.body, this.tab === 'parts' ? this.partsHtml(me) : this.serviceHtml(me));
      // stat bars: current vs candidate
      const cur = this.stats(me.carId, g.installed, g.wear).st;
      const cs = this.stats(cand.carId, cand.installed, cand.wear);
      const same = JSON.stringify(cand.installed) === JSON.stringify(g.installed) && JSON.stringify(cand.wear) === JSON.stringify(g.wear);
      const bars = cur.bars
        .map((b, i) => {
          const c = cs.st.bars[i];
          const d = c.v - b.v;
          const cls = Math.abs(d) < 0.05 ? '' : d > 0 ? 'up' : 'down';
          return `<div class="sbar ${same ? '' : cls}"><div class="sk">${b.k}</div><div class="st"><i class="cur" style="width:${b.v * 10}%"></i>${same ? '' : `<i class="cand" style="width:${c.v * 10}%"></i>`}</div><div class="sv">${same || b.txt === c.txt ? b.txt : `${b.txt} → <b>${c.txt}</b>`}</div></div>`;
        })
        .join('');
      UI.patch(this.el.stats, `<h3>${same ? 'Current build' : 'Current <i class="lg cur"></i> vs candidate <i class="lg cand"></i>'}</h3>${bars}`);
      const warns = Parts.warnings(cs.spec, next || null);
      if (this.arg.extra) UI.patch(this.el.extra, this.arg.extra());
      UI.patch(this.el.warn, `<h3>Handling notes</h3>` + (warns.length ? warns.map((w) => `<div class="wn ${w[0]}">${w[0] === 'bad' ? '⚠' : '•'} ${U.esc(w[1])}</div>`).join('') : '<div class="wn ok">✓ Stock-ish and predictable. No surprises.</div>'));
    },

    partsHtml(me) {
      const g = me.garage;
      return Parts.SLOTS.map((slot) => {
        const inst = Parts.opt(slot.id, g.installed[slot.id]);
        const open = this.sel === slot.id;
        let h = `<div class="slot ${open ? 'open' : ''}"><div class="slot-h" data-act="slot" data-slot="${slot.id}"><span class="ic">${slot.icon}</span><span class="sn">${slot.name}</span><span class="si">${U.esc(inst.name)}</span><span class="chev">${open ? '▾' : '▸'}</span></div>`;
        if (open) {
          h += '<div class="opts">';
          for (const o of slot.options) {
            const owned = g.owned[slot.id].includes(o.id);
            const installed = g.installed[slot.id] === o.id;
            const picked = this.pick && this.pick.slot === slot.id && this.pick.opt === o.id;
            const tag = installed ? '<em class="t-inst">FITTED</em>' : owned ? '<em class="t-own">OWNED</em>' : `<em class="t-price">${U.fmtMoney(o.price)}</em>`;
            h += `<div class="opt ${installed ? 'inst' : ''} ${picked ? 'picked' : ''}" data-act="pick" data-hover="1" data-slot="${slot.id}" data-opt="${o.id}">
              <div class="on">${U.esc(o.name)} ${tag}</div>
              <div class="od">＋ ${U.esc(o.desc)}</div>
              <div class="oc">－ ${U.esc(o.cons)}</div>
            </div>`;
          }
          h += '</div>' + this.actionHtml(me, slot);
        }
        return h + '</div>';
      }).join('');
    },

    actionHtml(me, slot) {
      const g = me.garage;
      const p = this.pick && this.pick.slot === slot.id ? this.pick : null;
      if (!p) return '<div class="act-row muted">Hover an option to preview it — click to select.</div>';
      const o = Parts.opt(slot.id, p.opt);
      const owned = g.owned[slot.id].includes(o.id);
      const installed = g.installed[slot.id] === o.id;
      const tyre = slot.id === 'compound' || slot.id === 'width';
      let btns = '';
      if (installed) btns += `<span class="muted">Fitted.</span>`;
      else if (owned) {
        const cost = tyre ? Parts.tyreSetPrice(Object.assign({}, g.installed, { [slot.id]: o.id })) : 0;
        btns += `<button class="btn primary" data-act="install" ${me.money < cost ? 'disabled' : ''}>Fit ${cost ? '(new set ' + U.fmtMoney(cost) + ')' : '(free)'}</button>`;
      } else {
        btns += `<button class="btn primary" data-act="buy" ${me.money < o.price ? 'disabled' : ''}>Buy & fit ${U.fmtMoney(o.price)}</button>`;
      }
      if (owned && o.id !== slot.options[0].id) btns += `<button class="btn ghost" data-act="sell">Sell ${U.fmtMoney(o.price * 0.5)}</button>`;
      return `<div class="act-row">${btns}</div>`;
    },

    serviceHtml(me) {
      const g = me.garage;
      const q = Parts.repairQuote(g.installed, g.wear);
      const row = (k, label, w, hint, verb) => {
        const pct = Math.round((1 - w) * 100);
        return `<div class="svc"><div class="svc-h"><b>${label}</b><span>${pct}%</span></div><div class="st"><i class="cur ${pct < 40 ? 'bad' : pct < 70 ? 'warn' : ''}" style="width:${pct}%"></i></div><div class="svc-f"><span class="muted">${hint}</span><button class="btn small" data-act="repair" data-kind="${k}" ${!q[k] || me.money < q[k] ? 'disabled' : ''}>${q[k] ? verb + ' ' + U.fmtMoney(q[k]) : 'OK'}</button></div></div>`;
      };
      const total = q.tyre + q.engine + q.body;
      // Tyres are replaced as a whole set (flat price); engine/body are prorated by damage.
      const tyreHint = g.wear.tyre < 0.3 ? 'Still fresh — a new set is full price.' : 'Worn tyres lose up to 32% grip.';
      return (
        row('tyre', 'Tyres', g.wear.tyre, tyreHint, 'New set') +
        row('engine', 'Engine', g.wear.engine, 'Wear + overheating cost up to 38% power.', 'Rebuild') +
        row('body', 'Bodywork', g.wear.body, 'Damage adds drag and a steering pull.', 'Fix') +
        `<div class="act-row"><button class="btn primary" data-act="repair" data-kind="all" ${!total || me.money < total ? 'disabled' : ''}>Repair everything ${U.fmtMoney(total)}</button></div>` +
        `<p class="muted small">Money is the only thing that fixes a car. Every dollar here is a dollar not spent on parts.</p>`
      );
    },

    hover(el) {
      const o = el && el.dataset.opt ? { slot: el.dataset.slot, opt: el.dataset.opt } : null;
      const same = (a, b) => (a && b ? a.slot === b.slot && a.opt === b.opt : a === b);
      if (same(o, this.hov)) return;
      this.hov = o;
      if (!this.pick) UI.refresh();
    },

    update() {
      const m = G.Preview.info();
      // Live numbers for the lap in progress (updates within a corner), plus
      // the last complete lap time once there is one for this build.
      const html = `<span>LIVE HANDLING PREVIEW</span> ${this.pick || this.hov ? 'candidate' : 'current'} build · slide <b>${Math.round(m.curPeak * 57.3)}°</b> · top <b>${Math.round(m.curV * 3.6)} km/h</b> · last lap <b>${m.lastLap ? U.fmtTime(m.lastLap) : '…'}</b>${m.spins ? ` · <b class="bad">${m.spins} spin${m.spins > 1 ? 's' : ''}</b>` : ''}`;
      UI.patch(this.el.live, html);
      if (this.arg.extra) UI.patch(this.el.extra, this.arg.extra());
    },

    acts: {
      tab(el) {
        this.tab = el.dataset.tab;
        UI.refresh(true);
      },
      slot(el) {
        this.sel = this.sel === el.dataset.slot ? null : el.dataset.slot;
        this.pick = null;
        UI.refresh(true);
      },
      pick(el) {
        const o = { slot: el.dataset.slot, opt: el.dataset.opt };
        this.pick = this.pick && this.pick.slot === o.slot && this.pick.opt === o.opt ? null : o;
        UI.refresh(true);
      },
      buy() {
        if (this.pick) G.Client.act({ t: 'buy', slot: this.pick.slot, opt: this.pick.opt });
        this.pick = null;
      },
      install() {
        if (this.pick) G.Client.act({ t: 'install', slot: this.pick.slot, opt: this.pick.opt });
        this.pick = null;
      },
      sell() {
        if (this.pick) G.Client.act({ t: 'sell', slot: this.pick.slot, opt: this.pick.opt });
        this.pick = null;
      },
      repair(el) {
        G.Client.act({ t: 'repair', kind: el.dataset.kind });
      },
      testdrive() {
        const c = this.candidate();
        if (c && this.arg.onTestDrive) this.arg.onTestDrive(c);
      },
      done() {
        if (this.arg.onDone) this.arg.onDone();
      },
    },
  };

  UI.register('garage', Garage);
})(window.G);
