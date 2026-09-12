// garage.js — the shop, with five tabs:
//   Parts    accordion with honest upside/downside text (buy / fit / sell)
//   Tuning   a free setup sheet: tyre pressures, camber, anti-roll bars,
//            ride height, brake bias, diff lock, final drive, wing, boost
//   Paint    paint, livery, accent, race number, rims, tint, underglow (free)
//   Car      switch chassis (free before race 1, a paid swap between races)
//   Service  repairs
// Stat bars compare the CURRENT build (solid) with the CANDIDATE (marker +
// delta), the notes panel explains part/setup interactions, and the live 3D
// preview drives the candidate — or parks as a turntable in the Paint tab.
'use strict';
(function (G) {
  const U = G.U, Parts = G.Parts, UI = G.UI;
  const hex = (c) => UI.colorHex(c);
  const TABS = [['parts', '🔩 Parts'], ['tuning', '🎛 Tuning'], ['paint', '🎨 Paint'], ['car', '🚗 Car'], ['service', '🛠 Service']];
  const signed = (v) => (v > 0 ? '+' : '') + v;
  function fmtTune(t, v) {
    if (t.labels) return t.labels[Math.round(v)] || String(v);
    if (t.unit === '°') return v.toFixed(1) + '°';
    if (t.unit === 'psi' || t.unit === 'cm') return signed(v) + ' ' + t.unit;
    if (t.id === 'fd') return signed(v) + '%';
    if (t.unit === '%') return v + '%';
    return v + ' / 9';
  }
  const tuneEq = (inst, a, b) => JSON.stringify(Parts.effTune(inst, a)) === JSON.stringify(Parts.effTune(inst, b));
  // What switching to a car costs this player now (mirrors session.on_setCar).
  function carFee(me, id, free) {
    const owned = ((me.garage && me.garage.cars) || Parts.BASE_CARS).includes(id);
    const buy = owned ? 0 : Parts.CARS[id].price || 0;
    const swap = free ? 0 : Parts.CAR_SWAP;
    return { buy, swap, total: buy + swap };
  }
  G.carFee = carFee;

  const Garage = {
    mount(root, arg) {
      this.arg = arg || {};
      this.sel = this.sel || 'induction';
      this.pick = null; // {slot, opt} sticky selection
      this.hov = null; // hovered option
      this.carPick = null; // hovered car in the Car tab
      if (this.arg.tab) this.tab = this.arg.tab;
      if (this.nextTab) {
        this.tab = this.nextTab;
        this.nextTab = null;
      }
      this.tab = this.tab || 'parts';
      this.draft = null; // unapplied setup
      this.pending = null; // applied, waiting for the host's state to confirm
      this._tsig = null;
      this._tuneRev = 0;
      this._statsCache = this._statsCache || {};
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
            <div class="tabs">${TABS.map(([k, l]) => `<button data-act="tab" data-tab="${k}">${l}</button>`).join('')}</div>
            <div class="g-body"></div>
          </div>
        </div>`;
      const $ = (s) => root.querySelector(s);
      this.el = { itabs: $('.g-itabs'), car: $('.g-car'), next: $('.g-next'), extra: $('.g-extra'), money: $('.g-money'), btns: $('.g-btns'), stats: $('.g-stats'), warn: $('.g-warn'), body: $('.g-body'), live: $('.g-live'), tabs: root.querySelectorAll('.tabs button') };
      const me = G.Client.me;
      if (me) G.Preview.start(G.App.world, this.candidate(), me.color);
      G.Preview.setShowroom(this.tab === 'paint');
    },

    unmount() {
      clearTimeout(this._tuneTimer);
      G.Preview.stop();
    },

    // Candidate = installed + selected/hovered part, hovered car, setup draft.
    candidate() {
      const me = G.Client.me;
      if (!me) return null;
      const g = me.garage;
      const inst = Object.assign({}, g.installed);
      const o = this.tab === 'parts' ? this.pick || this.hov : null;
      const wear = Object.assign({}, g.wear);
      if (o) {
        inst[o.slot] = o.opt;
        if ((o.slot === 'compound' || o.slot === 'width') && o.opt !== g.installed[o.slot]) wear.tyre = 0;
      }
      const tune = Object.assign({}, this.draft || this.pending || g.tune);
      return { carId: this.carPick || me.carId, installed: inst, wear, tune, look: g.look };
    },

    stats(carId, installed, wear, tune) {
      const k = carId + JSON.stringify(installed) + JSON.stringify(wear) + JSON.stringify(Parts.effTune(installed, tune));
      if (!this._statsCache[k]) {
        const spec = Parts.computeSpec(carId, installed, wear, tune);
        this._statsCache[k] = { spec, st: Parts.computeStats(spec) };
      }
      return this._statsCache[k];
    },

    render() {
      const me = G.Client.me;
      if (!me) return;
      const g = me.garage;
      const car = Parts.CARS[me.carId];
      if (this.pending && tuneEq(g.installed, this.pending, g.tune)) this.pending = null;
      const cand = this.candidate();
      G.Preview.setBuild(cand);
      G.Preview.setShowroom(this.tab === 'paint');
      UI.patch(this.el.itabs, this.arg.tabs && UI.interTabs ? UI.interTabs() : '');
      const paint = g.look && g.look.paint != null ? g.look.paint : me.color;
      UI.patch(this.el.car, `<b style="color:${hex(paint)}">■</b> ${U.esc(car.name)} <span>${car.tag}</span>`);
      UI.patch(this.el.money, `<span>CASH</span><b>${U.fmtMoney(me.money)}</b>`);
      // arg fields may be values or functions (intermission passes live getters)
      const val = (v) => (typeof v === 'function' ? v() : v);
      const next = val(this.arg.nextTrack);
      const doneLabel = val(this.arg.doneLabel);
      UI.patch(this.el.next, next ? `<span>NEXT RACE</span><b>${U.esc(next.name)}</b><em class="fmt fmt-${next.format}">${next.format.toUpperCase()}</em>` : '');
      UI.patch(
        this.el.btns,
        (this.arg.onTestDrive ? `<button class="btn ghost" data-act="testdrive" title="Drive the candidate build on the Proving Ground">▶ Test drive</button>` : '') +
          (doneLabel ? `<button class="btn ${this.arg.back ? 'ghost' : me.ready ? 'green' : 'primary'}" data-act="done">${U.esc(doneLabel)}</button>` : '')
      );
      this.el.tabs.forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
      if (this.tab === 'tuning') {
        // Only rebuild the sliders when something OTHER than the draft
        // changed — re-rendering mid-drag would drop the slider under the mouse.
        const sig = JSON.stringify([g.installed, g.tune, this._tuneRev, !!this.pending]);
        if (this._tsig !== sig) {
          this._tsig = sig;
          this.el.body._html = null;
          this.el.body.innerHTML = this.tuningHtml(me);
        }
      } else {
        this._tsig = null;
        UI.patch(this.el.body, this.tab === 'parts' ? this.partsHtml(me) : this.tab === 'paint' ? this.paintHtml(me) : this.tab === 'car' ? this.carHtml(me) : this.serviceHtml(me));
      }
      // stat bars: current vs candidate
      const cur = this.stats(me.carId, g.installed, g.wear, g.tune).st;
      const cs = this.stats(cand.carId, cand.installed, cand.wear, cand.tune);
      const same = cand.carId === me.carId && JSON.stringify(cand.installed) === JSON.stringify(g.installed) && JSON.stringify(cand.wear) === JSON.stringify(g.wear) && tuneEq(cand.installed, cand.tune, g.tune);
      const bars = cur.bars
        .map((b, i) => {
          const c = cs.st.bars[i];
          const d = c.v - b.v;
          const cls = Math.abs(d) < 0.05 ? '' : d > 0 ? 'up' : 'down';
          return `<div class="sbar ${same ? '' : cls}"><div class="sk">${b.k}</div><div class="st"><i class="cur" style="width:${b.v * 10}%"></i>${same ? '' : `<i class="cand" style="width:${c.v * 10}%"></i>`}</div><div class="sv">${same || b.txt === c.txt ? b.txt : `${b.txt} → <b>${c.txt}</b>`}</div></div>`;
        })
        .join('');
      const what = this.carPick && this.carPick !== me.carId ? Parts.CARS[this.carPick].name : this.tab === 'tuning' ? 'new setup' : 'candidate';
      UI.patch(this.el.stats, `<h3>${same ? 'Current build' : `Current <i class="lg cur"></i> vs ${U.esc(what)} <i class="lg cand"></i>`}</h3>${bars}`);
      const warns = Parts.warnings(cs.spec, next || null);
      if (this.arg.extra) UI.patch(this.el.extra, this.arg.extra());
      // v4 pit crew: repairs due, an affordable upgrade for the next track,
      // heat on long tracks, a premium car in reach — click to jump to the fix
      const tips = G.Advisor ? G.Advisor.tips(me, next || null, 3) : [];
      this.el.tabs.forEach((b) => {
        const t = b.dataset.tab;
        b.classList.toggle('dot', tips.some((x) => x.tab === t && x.lvl !== 'good'));
        b.classList.toggle('dotg', tips.some((x) => x.tab === t && x.lvl === 'good'));
      });
      UI.patch(this.el.warn, (tips.length ? `<h3>Pit crew</h3>${G.Advisor.html(tips, true)}` : '') + `<h3>Handling notes</h3>` + (warns.length ? warns.map((w) => `<div class="wn ${w[0]}">${w[0] === 'bad' ? '⚠' : '•'} ${U.esc(w[1])}</div>`).join('') : '<div class="wn ok">✓ Stock-ish and predictable. No surprises.</div>'));
    },

    // ---------------------------------------------------------------- parts
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
      const listen = '<button class="btn ghost small" data-act="listen" title="Rev the engine with this build: exhaust, induction, engine map and gearbox all change the sound">🔊 Listen</button>';
      if (!p) return `<div class="act-row muted">Hover an option to preview it — click to select. ${listen}</div>`;
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
      return `<div class="act-row">${btns}${listen}</div>`;
    },

    // --------------------------------------------------------------- tuning
    tuningHtml(me) {
      const g = me.garage;
      const d = this.draft || this.pending || g.tune;
      let grp = null;
      let h = `<p class="muted small tn-top">Setup is free and can change every race. Drag a slider: the preview car and the stat bars show the result before you apply it.</p>`;
      for (const t of Parts.TUNES) {
        if (t.grp !== grp) {
          if (grp) h += '</div>';
          grp = t.grp;
          h += `<div class="tn-grp"><h4>${t.grp}</h4>`;
        }
        const avail = Parts.tuneAvailable(t, g.installed);
        const v = avail ? (d[t.id] != null ? d[t.id] : t.def) : t.def;
        const applied = g.tune[t.id] != null ? g.tune[t.id] : t.def;
        const chg = avail && Math.abs(v - applied) > 1e-6;
        h += `<div class="tn ${avail ? '' : 'na'} ${chg ? 'chg' : ''}">
          <div class="tn-h"><b>${t.name}</b><output>${fmtTune(t, v)}</output>${avail && v !== t.def ? `<button class="tn-def" data-act="tdef" data-id="${t.id}" title="Back to default">↺</button>` : ''}</div>
          <input type="range" min="${t.min}" max="${t.max}" step="${t.step}" value="${v}" data-input="tune" data-change="tunec" data-id="${t.id}" ${avail ? '' : 'disabled'}>
          <div class="tn-lh"><span>◀ ${U.esc(t.lo)}</span><span>${U.esc(t.hi)} ▶</span></div>${avail ? '' : `<div class="tn-need">🔒 ${U.esc(t.needTxt)}</div>`}</div>`;
      }
      h += '</div>';
      const dirty = !!this.draft && !tuneEq(g.installed, this.draft, g.tune);
      h += `<div class="act-row sticky"><button class="btn primary" data-act="tapply" ${dirty ? '' : 'disabled'}>Apply setup</button><button class="btn ghost" data-act="trevert" ${dirty ? '' : 'disabled'}>Revert</button><button class="btn ghost" data-act="treset">All defaults</button>${this.pending ? '<span class="muted small">saving…</span>' : ''}</div>`;
      return h;
    },

    _syncTuneButtons() {
      const me = G.Client.me;
      if (!me) return;
      const dirty = !!this.draft && !tuneEq(me.garage.installed, this.draft, me.garage.tune);
      this.el.body.querySelectorAll('[data-act="tapply"],[data-act="trevert"]').forEach((b) => (b.disabled = !dirty));
    },

    // ---------------------------------------------------------------- paint
    paintHtml(me) {
      const L = Object.assign(Parts.defaultLook(), me.garage.look);
      const LK = Parts.LOOK;
      const paint = L.paint != null ? L.paint : me.color;
      const sw = (act, c, on, title) => `<button class="sw ${on ? 'on' : ''}" style="background:${hex(c)}" data-act="${act}" data-c="${c}" title="${title || ''}"></button>`;
      const chip = (act, v, label, on) => `<button class="chipb ${on ? 'on' : ''}" data-act="${act}" data-v="${v}">${label}</button>`;
      return `
        <div class="pt-sec"><h4>Paint</h4><div class="sws">
          <button class="sw team ${L.paint == null ? 'on' : ''}" style="background:${hex(me.color)}" data-act="paint" data-c="team" title="Team colour">★</button>
          ${LK.paints.map((c) => sw('paint', c, L.paint === c)).join('')}</div>
          <label class="pt-custom">Custom colour <input type="color" data-change="paintc" value="${hex(paint)}"></label></div>
        <div class="pt-sec"><h4>Livery</h4><div class="chips2">${LK.liveries.map(([v, l]) => chip('livery', v, l, L.livery === v)).join('')}</div></div>
        <div class="pt-sec"><h4>Accent colour <span class="muted small">stripes, two-tone, roof</span></h4><div class="sws">${LK.accents.map((c) => sw('accent', c, L.accent === c)).join('')}</div></div>
        <div class="pt-sec"><h4>Race number</h4><div class="pt-num"><input type="number" min="0" max="99" data-change="num" value="${L.num}"><button class="btn small ghost" data-act="numr">🎲 Random</button><span class="muted small">On the Side-stripe and Race liveries · 0 hides it</span></div></div>
        <div class="pt-sec"><h4>Wheels</h4><div class="chips2">${LK.rims.map(([v, l]) => chip('rims', v, l, L.rims === v)).join('')}</div><div class="sws">${LK.rimCols.map((c) => sw('rimcol', c, L.rimCol === c)).join('')}</div></div>
        <div class="pt-sec"><h4>Paint finish</h4><div class="chips2">${LK.finishes.map(([v, l]) => chip('finish', v, l, L.finish === v)).join('')}</div></div>
        <div class="pt-sec"><h4>Headlights</h4><div class="chips2">${LK.lights.map(([v, l]) => chip('lights', v, l, L.lights === v)).join('')}</div></div>
        <div class="pt-sec"><h4>Windows</h4><div class="chips2">${LK.tints.map(([v, l]) => chip('tint', v, l, L.tint === v)).join('')}</div></div>
        <div class="pt-sec"><h4>Underglow</h4><div class="chips2">${LK.glows.map(([v, l]) => chip('glow', v, l, L.glow === v)).join('')}</div></div>
        <p class="muted small">Paint is free and cosmetic only. Your team colour still marks you on the minimap, name tags and standings.</p>`;
    },
    look(patch) {
      G.Client.act({ t: 'look', look: patch });
      if (G.Audio) G.Audio.tab();
    },

    // ------------------------------------------------------------------ car
    carHtml(me) {
      const st = G.Client.state;
      const free = ['lobby', 'carselect', 'sandbox'].includes(st.phase);
      const allowed = free || ['intermission', 'results'].includes(st.phase);
      const g = me.garage;
      return (
        Parts.CAR_ORDER.map((id) => {
          const c = Parts.CARS[id];
          const s = this.stats(id, g.installed, g.wear, g.tune).st;
          const cur = me.carId === id;
          const fee = carFee(me, id, free);
          const bars = s.bars.filter((b) => !b.cost).map((b) => `<div class="mini"><span>${b.k}</span><div><i style="width:${b.v * 10}%"></i></div></div>`).join('');
          const label = fee.buy ? `Buy ${U.fmtMoney(fee.total)}` : free ? 'Switch (free)' : 'Swap ' + U.fmtMoney(fee.total);
          const btn = cur
            ? '<em class="t-inst">CURRENT</em>'
            : allowed
            ? `<button class="btn ${fee.total ? 'pink' : 'primary'} small" data-act="swapcar" data-id="${id}" ${me.money < fee.total ? 'disabled' : ''}>${label}</button>`
            : '<span class="muted small">Between races only</span>';
          const tag = c.price ? `<em class="t-new">${fee.buy ? 'PREMIUM ' + U.fmtMoney(c.price) : 'OWNED'}</em>` : '';
          return `<div class="gcar ${cur ? 'on' : ''}" data-hover="1" data-car="${id}"><div class="gc-h"><b>${c.name}</b>${tag}<span>${c.tag}</span>${btn}</div><p>${U.esc(c.blurb)}</p>${bars}</div>`;
        }).join('') + `<p class="muted small">${free ? 'Switching between the four base cars is free before the first race.' : `A chassis swap costs ${U.fmtMoney(Parts.CAR_SWAP)}: every part you own, your setup and your paint move to the new car.`} The Dune Runner and Apex MR are premium: buy one once and it's yours for the session. Stats are shown with your current parts. Hover a car to preview it.</p>`
      );
    },

    // -------------------------------------------------------------- service
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
      if (this.tab === 'car') {
        const id = (el && el.dataset.car) || null;
        if (id !== this.carPick) {
          this.carPick = id;
          UI.refresh();
        }
        return;
      }
      if (this.tab !== 'parts') return;
      const o = el && el.dataset.opt ? { slot: el.dataset.slot, opt: el.dataset.opt } : null;
      const same = (a, b) => (a && b ? a.slot === b.slot && a.opt === b.opt : a === b);
      if (same(o, this.hov)) return;
      this.hov = o;
      if (!this.pick) UI.refresh();
    },

    input(k, el) {
      const me = G.Client.me;
      if (!me || k !== 'tune') return;
      const id = el.dataset.id, t = Parts.TUNE_MAP[id];
      this.draft = this.draft || Object.assign({}, this.pending || me.garage.tune);
      this.draft[id] = +el.value;
      const box = el.closest('.tn');
      const out = box && box.querySelector('output');
      if (out) out.textContent = fmtTune(t, +el.value);
      if (box) box.classList.toggle('chg', Math.abs(+el.value - me.garage.tune[id]) > 1e-6);
      this._syncTuneButtons();
      clearTimeout(this._tuneTimer);
      this._tuneTimer = setTimeout(() => UI.refresh(), 120); // stats + preview, debounced
    },

    change(k, el) {
      if (k === 'paintc') this.look({ paint: parseInt(el.value.slice(1), 16) });
      else if (k === 'num') this.look({ num: U.clamp(Math.round(+el.value || 0), 0, 99) });
      else if (k === 'tunec') UI.refresh(true);
    },

    update() {
      const m = G.Preview.info();
      let html;
      if (this.tab === 'paint') html = `<span>SHOWROOM</span> your ${U.esc(Parts.CARS[(G.Client.me && G.Client.me.carId) || 'vandal'].name)} · <b>drag</b> to turn it · <b>scroll</b> to zoom`;
      else {
        // Live numbers for the lap in progress (updates within a corner), plus
        // the last complete lap time once there is one for this build.
        const what = this.carPick ? Parts.CARS[this.carPick].name : this.tab === 'tuning' && this.draft ? 'new setup' : this.pick || this.hov ? 'candidate' : 'current build';
        html = `<span>LIVE HANDLING PREVIEW</span> ${U.esc(what)} · slide <b>${Math.round(m.curPeak * 57.3)}°</b> · top <b>${Math.round(G.Settings.speed(m.curV))} ${G.Settings.unit()}</b> · last lap <b>${m.lastLap ? U.fmtTime(m.lastLap) : '…'}</b>${m.spins ? ` · <b class="bad">${m.spins} spin${m.spins > 1 ? 's' : ''}</b>` : ''}`;
      }
      UI.patch(this.el.live, html);
      if (this.arg.extra) UI.patch(this.el.extra, this.arg.extra());
    },

    acts: {
      tab(el) {
        this.tab = el.dataset.tab;
        this.pick = null;
        this.hov = null;
        this.carPick = null;
        if (G.Audio) G.Audio.tab();
        UI.refresh(true);
      },
      slot(el) {
        this.sel = this.sel === el.dataset.slot ? null : el.dataset.slot;
        this.pick = null;
        UI.refresh(true);
      },
      // a pit-crew tip: jump to its tab (and open the part's slot)
      tiptab(el) {
        this.tab = el.dataset.tab;
        if (el.dataset.slot) this.sel = el.dataset.slot;
        this.pick = null;
        this.hov = null;
        this.carPick = null;
        if (G.Audio) G.Audio.tab();
        UI.refresh(true);
      },
      pick(el) {
        const o = { slot: el.dataset.slot, opt: el.dataset.opt };
        this.pick = this.pick && this.pick.slot === o.slot && this.pick.opt === o.opt ? null : o;
        UI.refresh(true);
      },
      buy() {
        if (this.pick) {
          G.Client.act({ t: 'buy', slot: this.pick.slot, opt: this.pick.opt });
          if (G.Audio) G.Audio.buy();
        }
        this.pick = null;
      },
      install() {
        if (this.pick) G.Client.act({ t: 'install', slot: this.pick.slot, opt: this.pick.opt });
        if (G.Audio) G.Audio.repair();
        this.pick = null;
      },
      sell() {
        if (this.pick) G.Client.act({ t: 'sell', slot: this.pick.slot, opt: this.pick.opt });
        if (G.Audio) G.Audio.sell();
        this.pick = null;
      },
      repair(el) {
        G.Client.act({ t: 'repair', kind: el.dataset.kind });
        if (G.Audio) G.Audio.repair();
      },
      testdrive() {
        const c = this.candidate();
        if (c && this.arg.onTestDrive) this.arg.onTestDrive(c);
      },
      listen() {
        const c = this.candidate();
        if (!c || !G.Audio) return;
        if (!G.Audio.revDemo(c.carId, c.installed)) UI.toast('Sound is off — press M or the 🔊 button (top right) first.', 'info');
      },
      done() {
        if (this.arg.onDone) this.arg.onDone();
      },
      // tuning
      tapply() {
        const me = G.Client.me;
        if (!this.draft || !me) return;
        this.pending = Parts.effTune(me.garage.installed, this.draft);
        G.Client.act({ t: 'tune', tune: this.draft });
        this.draft = null;
        this._tuneRev++;
        if (G.Audio) G.Audio.repair();
        UI.toast('Setup applied.', 'good');
        UI.refresh(true);
      },
      trevert() {
        this.draft = null;
        this._tuneRev++;
        UI.refresh(true);
      },
      treset() {
        this.draft = Parts.defaultTune();
        this._tuneRev++;
        UI.refresh(true);
      },
      tdef(el) {
        const me = G.Client.me;
        this.draft = this.draft || Object.assign({}, this.pending || me.garage.tune);
        this.draft[el.dataset.id] = Parts.TUNE_MAP[el.dataset.id].def;
        this._tuneRev++;
        UI.refresh(true);
      },
      // paint
      paint(el) {
        this.look({ paint: el.dataset.c === 'team' ? null : +el.dataset.c });
      },
      accent(el) {
        this.look({ accent: +el.dataset.c });
      },
      livery(el) {
        this.look({ livery: el.dataset.v });
      },
      rims(el) {
        this.look({ rims: el.dataset.v });
      },
      rimcol(el) {
        this.look({ rimCol: +el.dataset.c });
      },
      tint(el) {
        this.look({ tint: el.dataset.v });
      },
      glow(el) {
        this.look({ glow: el.dataset.v });
      },
      finish(el) {
        this.look({ finish: el.dataset.v });
      },
      lights(el) {
        this.look({ lights: el.dataset.v });
      },
      numr() {
        this.look({ num: 1 + Math.floor(Math.random() * 99) });
      },
      // car
      async swapcar(el) {
        const id = el.dataset.id;
        const st = G.Client.state;
        const free = ['lobby', 'carselect', 'sandbox'].includes(st.phase);
        const fee = carFee(G.Client.me, id, free);
        if (fee.total) {
          const what = fee.buy ? `Buy the <b>${U.esc(Parts.CARS[id].name)}</b> for <b>${U.fmtMoney(fee.total)}</b>${fee.swap ? ` (${U.fmtMoney(Parts.CARS[id].price)} + ${U.fmtMoney(fee.swap)} swap)` : ''}? Your parts, setup and paint move over, and it stays yours for the session.` : `Move every part you own, your setup and your paint to the <b>${U.esc(Parts.CARS[id].name)}</b> for <b>${U.fmtMoney(fee.total)}</b>?`;
          const ok = await UI.confirm(fee.buy ? 'Buy car?' : 'Swap chassis?', what, (fee.buy ? 'Buy for ' : 'Swap for ') + U.fmtMoney(fee.total));
          if (!ok) return;
        }
        G.Client.act({ t: 'setCar', carId: id });
        this.carPick = null;
        if (G.Audio) G.Audio.buy();
      },
    },
  };

  UI.register('garage', Garage);
})(window.G);
