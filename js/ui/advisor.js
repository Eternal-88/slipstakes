// advisor.js — the pit crew: short, actionable tips shown in the garage (click
// one to jump to the fix), on the menu's car card, before a race and once on
// the grid. "Your tyres are shot", "you can afford X now — good for the next
// track", "this build will overheat on the Mile", "the Apex is within reach".
'use strict';
(function (G) {
  const U = G.U, Parts = G.Parts;

  // What pays off most on each kind of track, in the order we suggest it.
  const PRIO = {
    drag: [['induction', 'sc'], ['gearing', 'short'], ['weight', 'w1'], ['induction', 't1'], ['ecu', 'stage1'], ['nitrous', 'n1'], ['weight', 'w2'], ['cooling', 'radiator'], ['induction', 't2']],
    circuit: [['compound', 'medium'], ['suspension', 'sport'], ['brakes', 'sport'], ['aero', 'a1'], ['weight', 'w1'], ['ecu', 'stage1'], ['compound', 'soft'], ['aero', 'a2'], ['nitrous', 'n1']],
    sprint: [['suspension', 'rally'], ['compound', 'medium'], ['width', 'narrow'], ['weight', 'w1'], ['ecu', 'stage1'], ['brakes', 'sport'], ['nitrous', 'n1']],
  };
  const pc = (v) => Math.round(v * 100) + '%';

  // me = player, next = next Track (or null). Returns [{lvl, ic, txt, tab, slot}].
  function tips(me, next, max) {
    if (!me || !me.garage) return [];
    const g = me.garage, w = Object.assign({ tyre: 0, engine: 0, body: 0 }, g.wear);
    const out = [];
    const q = Parts.repairQuote(g.installed, w);
    // 1. wear that is costing you (same formulas as parts.computeSpec)
    if (w.tyre > 0.45) out.push({ lvl: w.tyre > 0.7 ? 'bad' : 'warn', ic: '🛞', tab: 'service', txt: `Tyres at ${pc(1 - w.tyre)}: ${Math.round(32 * Math.pow(w.tyre, 1.6))}% less grip. A new set is ${U.fmtMoney(q.tyre)}.` });
    if (w.engine > 0.3) out.push({ lvl: w.engine > 0.6 ? 'bad' : 'warn', ic: '🔧', tab: 'service', txt: `Engine at ${pc(1 - w.engine)}: ${Math.round(38 * Math.pow(w.engine, 1.3))}% down on power. A rebuild is ${U.fmtMoney(q.engine)}.` });
    if (w.body > 0.3) out.push({ lvl: w.body > 0.6 ? 'bad' : 'warn', ic: '🚗', tab: 'service', txt: `Bodywork at ${pc(1 - w.body)}: extra drag and a pull to one side. Fixing it is ${U.fmtMoney(q.body)}.` });
    const repairs = (w.tyre > 0.45 ? q.tyre : 0) + (w.engine > 0.3 ? q.engine : 0) + (w.body > 0.3 ? q.body : 0);
    const budget = me.money - repairs - Parts.BASIC_REPAIR;
    // 2. a boosted build that will cook on a long, flat-out track
    const spec = Parts.computeSpec(me.carId, g.installed, w, g.tune);
    if (spec.heatRate > 0 && next && (next.format === 'drag' || next.raceDistance > 2000)) {
      const secs = 1 / Math.max(0.001, spec.heatRate - spec.coolRate * 0.75);
      if (secs < 30) out.push({ lvl: 'warn', ic: '🌡', tab: 'parts', slot: 'cooling', txt: `${next.name} is flat-out for ages: this build overheats after ~${Math.round(secs)} s. Fit better cooling, or turn the boost down in Tuning.` });
    }
    // 3. an upgrade you can afford right now, picked for the next track
    const fmt = next ? next.format : 'circuit';
    for (const [slot, id] of PRIO[fmt] || PRIO.circuit) {
      if ((g.owned[slot] || []).includes(id)) continue;
      if (slot !== 'compound' && slot !== 'induction' && g.installed[slot] !== Parts.STOCK[slot]) continue; // that slot is already upgraded
      const o = Parts.opt(slot, id);
      if (Parts.opt(slot, g.installed[slot]).price >= o.price) continue; // not an upgrade on what's fitted (a Supercharger isn't one over a turbo)
      if (o.price <= budget) {
        out.push({ lvl: 'good', ic: '💰', tab: 'parts', slot, txt: `You can afford ${o.name} (${U.fmtMoney(o.price)})${next ? ' — it suits ' + next.name : ''}. ${o.desc}` });
        break;
      }
    }
    // 4. a premium chassis within reach
    for (const id of Parts.CAR_ORDER) {
      const c = Parts.CARS[id];
      if (!c.price || (g.cars || []).includes(id)) continue;
      if (c.price + Parts.CAR_SWAP <= me.money - Parts.BASIC_REPAIR) {
        out.push({ lvl: 'good', ic: '🚙', tab: 'car', txt: `The ${c.name} is within reach (${U.fmtMoney(c.price)}): ${c.tag}.` });
        break;
      }
    }
    return out.slice(0, max || 4);
  }

  // clickable = data-act="tiptab" (the screen decides what that does)
  function html(list, clickable) {
    return list
      .map((t) => `<div class="tip ${t.lvl}" ${clickable && t.tab ? `data-act="tiptab" data-tab="${t.tab}"${t.slot ? ` data-slot="${t.slot}"` : ''} title="Open the ${t.tab} tab"` : ''}><span>${t.ic}</span><p>${U.esc(t.txt)}</p>${clickable && t.tab ? '<em>›</em>' : ''}</div>`)
      .join('');
  }

  G.Advisor = { tips, html };
})(window.G);
