// stats.js — v5.8.4 your driver stats: races, wins, podiums, your favourite
// car, time raced and your best lap on every track. They are kept on this
// device, like your personal-best laps - money, cars and parts still start
// fresh every visit. The main menu shows them (My stats). If you choose to
// share them (Settings.shareStats, on by default), a summary rides on your
// online card (online.js), so other players can open them from the list.
'use strict';
(function (G) {
  const U = G.U;
  const KEY = 'ss.stats';
  const blank = () => ({ v: 1, races: 0, wins: 0, podiums: 0, dnfs: 0, solo: 0, online: 0, secs: 0, cars: {}, best: {}, since: Date.now() });
  const num = (v, max) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);

  const Stats = {
    d: null,
    load() {
      const s = U.store.get(KEY, null);
      this.d = Object.assign(blank(), s && typeof s === 'object' && s.v === 1 ? s : {});
      return this.d;
    },
    save() {
      U.store.set(KEY, this.d);
      if (G.Online && G.Online.statsChanged) G.Online.statsChanged();
    },

    // A race you took part in. o = {carId, pos, total, dnf, online, secs}.
    // Practice and test drives aren't races (no field, no result).
    race(o) {
      if (!o || !(o.total >= 2)) return;
      const d = this.d;
      d.races++;
      if (o.dnf) d.dnfs++;
      else {
        if (o.pos === 1) d.wins++;
        if (o.pos >= 1 && o.pos <= 3) d.podiums++;
      }
      if (o.online) d.online++;
      else d.solo++;
      if (o.carId) d.cars[o.carId] = (d.cars[o.carId] || 0) + 1;
      d.secs += Math.max(0, Math.min(3600, o.secs || 0));
      this.save();
    },
    // A timed lap (a sprint's or a drag's run time counts as its lap).
    lap(trackId, carId, ms) {
      if (!trackId || !(ms > 1000)) return;
      const b = this.d.best[trackId];
      if (b && b[0] <= ms) return;
      this.d.best[trackId] = [Math.round(ms), carId || ''];
      this.save();
    },
    favCar(cars) {
      let best = null, n = 0;
      for (const id in cars || {}) if (cars[id] > n) (best = id), (n = cars[id]);
      return best;
    },

    // What rides on the online card when sharing: the counts, the favourite
    // car and the best laps (at most 16 tracks, so the card stays small).
    summary() {
      const d = this.d;
      const best = Object.keys(d.best)
        .filter((t) => G.getTrack(t))
        .sort((a, b) => d.best[a][0] - d.best[b][0])
        .slice(0, 16)
        .map((t) => [t, d.best[t][0], d.best[t][1]]);
      return { r: d.races, w: d.wins, p: d.podiums, x: d.dnfs, o: d.online, m: Math.round(d.secs / 60), c: this.favCar(d.cars) || '', b: best };
    },
    // Someone else's summary, straight off the network: never trust it.
    clean(s) {
      if (!s || typeof s !== 'object') return null;
      const r = num(s.r, 1e6);
      const o = { r, w: Math.min(num(s.w, 1e6), r), p: Math.min(num(s.p, 1e6), r), x: Math.min(num(s.x, 1e6), r), o: Math.min(num(s.o, 1e6), r), m: num(s.m, 1e7), c: G.Parts.CARS[s.c] ? s.c : '', b: [] };
      if (Array.isArray(s.b))
        for (const e of s.b.slice(0, 16)) {
          if (!Array.isArray(e) || !G.getTrack(e[0])) continue;
          const ms = num(e[1], 36e5);
          if (ms > 1000) o.b.push([e[0], ms, G.Parts.CARS[e[2]] ? e[2] : '']);
        }
      return o;
    },

    // The stats panel: yours (mine = true) or another player's summary.
    html(s, name, mine) {
      const car = (id) => (id && G.Parts.CARS[id] ? G.Parts.CARS[id].name : '');
      const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '-');
      const hrs = s.m >= 60 ? (s.m / 60).toFixed(1) + ' h' : s.m + ' min';
      const tiles = [['Races', s.r], ['Wins', s.w], ['Podiums', s.p], ['Win rate', pct(s.w, s.r)], ['Podium rate', pct(s.p, s.r)], ['Time raced', hrs]]
        .map(([k, v]) => `<div class="st-t"><b>${v}</b><span>${k}</span></div>`)
        .join('');
      const laps = s.b.length
        ? `<table class="st-laps"><tr><th>Track</th><th>Best</th><th>Car</th></tr>${s.b
            .slice()
            .sort((a, b) => G.getTrack(a[0]).name.localeCompare(G.getTrack(b[0]).name))
            .map(([t, ms, c]) => `<tr><td>${U.esc(G.getTrack(t).name)}</td><td class="num">${U.fmtTime(ms)}</td><td class="muted">${U.esc(car(c))}</td></tr>`)
            .join('')}</table>`
        : `<p class="muted small">${mine ? 'No timed laps yet - race or practise and your best lap on each track shows up here.' : 'No timed laps yet.'}</p>`;
      const extra = [s.c ? `Favourite car: <b>${U.esc(car(s.c))}</b>` : '', s.o ? `${s.o} online race${s.o === 1 ? '' : 's'}` : '', s.x ? `${s.x} DNF${s.x === 1 ? '' : 's'}` : '']
        .filter(Boolean)
        .join(' · ');
      return `<div class="st-panel">${name ? `<h3 class="st-name">${U.esc(name)}</h3>` : ''}<div class="st-tiles">${tiles}</div>${extra ? `<p class="st-extra">${extra}</p>` : ''}<h4>Best laps</h4>${laps}</div>`;
    },

    // The main menu's My stats window, with the share switch.
    open() {
      const share = G.Settings.s.shareStats !== false;
      const note = `<p class="muted small st-note">Kept on this device, like your personal bests. ${share ? 'Other players can see these from the players list.' : 'Hidden from other players.'}</p>`;
      // (Close first: Escape picks the first button)
      G.UI.modal('My stats', this.html(this.summary(), '', true) + note, [
        { label: 'Close', value: 1, cls: 'primary' },
        { label: share ? 'Hide from other players' : 'Show to other players', value: 'share' },
      ]).then((r) => {
        if (!r || r.value !== 'share') return;
        G.Settings.set('shareStats', !share);
        if (G.Online && G.Online.statsChanged) G.Online.statsChanged();
        this.open();
      });
    },
  };
  Stats.load();
  G.Stats = Stats;
})(window.G);
