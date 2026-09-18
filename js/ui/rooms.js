// rooms.js — the SERVER LIST (find a room from any classroom without passing
// codes around) and, for hosts, the join-request cards of a private room.
//
// The list comes from relay.js RoomBoard: every host publishes a small
// "room card" to the public relay brokers, and this screen shows the fresh
// ones live. Public rooms let you straight in; private rooms (the default)
// send the host an Accept / Decline card first.
'use strict';
(function (G) {
  const U = G.U, UI = G.UI;
  const PHASE = { lobby: 'In the lobby', carselect: 'Picking cars', entry: 'Starting a race', betting: 'Placing bets', race: 'Racing', results: 'Results', intermission: 'In the garage', final: 'Finished', sandbox: 'Sandbox' };
  // status pill colour by what the room is doing
  const TONE = { lobby: 'open', carselect: 'open', sandbox: 'open', race: 'live', entry: 'live', betting: 'live', results: 'break', intermission: 'break', final: 'done' };
  const FILTERS = [['all', 'All rooms'], ['open', 'Can join'], ['public', 'Public'], ['lobby', 'In the lobby'], ['racing', 'Racing now']];

  // v5: the server list, redone. Rows are keyed by room and only rewritten
  // when that room changes, so the list no longer blinks (and loses your
  // hover) every time any host sends an update.
  const Rooms = {
    mount(root) {
      root.innerHTML = `<div class="rooms"><div class="panel rm-card">
        <div class="rm-head">
          <div class="rm-title"><h1>Server list</h1><span class="rm-live"><i></i><span class="rm-status"></span></span></div>
          <p class="muted rm-sub"><b>Public</b> rooms let you straight in. <b>Private</b> rooms ask their host first. You can join mid-session: watch the race in progress, drive from the next one.</p>
        </div>
        <div class="rm-tools">
          <div class="rm-filters"></div>
          <input class="txt-in rm-search" type="search" maxlength="24" placeholder="Search rooms or hosts" data-input="search" aria-label="Search rooms or hosts">
        </div>
        <div class="rm-list" role="list"></div>
        <div class="rm-foot"><button class="btn ghost" data-act="back">← Menu</button><span class="rm-grow"></span><button class="btn" data-act="code">Join with a code</button><button class="btn primary" data-act="host">Host a room</button></div>
      </div></div>`;
      this.el = { status: root.querySelector('.rm-status'), live: root.querySelector('.rm-live'), list: root.querySelector('.rm-list'), filters: root.querySelector('.rm-filters') };
      this.filter = this.filter || 'all';
      this.q = '';
      this.rowEls = new Map();
      this.t0 = performance.now();
      this.board = G.Relay ? new G.Relay.RoomBoard().start() : null;
      this.off = this.board ? this.board.on('change', () => UI.refresh()) : null;
    },
    unmount() {
      if (this._asking) UI.clearNotice();
      this._asking = false;
      if (this.off) this.off();
      if (this.board) this.board.close();
      this.board = this.off = null;
      this.rowEls = new Map();
    },
    input(k, el) {
      if (k !== 'search') return;
      this.q = el.value.trim().toLowerCase();
      this.render();
    },
    _row(r) {
      const old = r.proto !== G.Net.PROTO;
      const full = r.players >= r.max;
      const racing = r.phase === 'race' || r.phase === 'entry' || r.phase === 'betting';
      const where = r.phase === 'lobby' || r.phase === 'final' || r.phase === 'sandbox' ? PHASE[r.phase] || r.phase : `${PHASE[r.phase] || r.phase} · ${Math.min(r.race + (racing ? 1 : 0), r.races)}/${r.races}`;
      const tr = r.track && G.TrackDefs.byId(r.track);
      const lvl = r.lvl && G.BotKit.LEVELS[r.lvl] ? G.BotKit.LEVELS[r.lvl].name : '';
      const btn = old
        ? `<button class="btn small" disabled title="That room runs a different version of the game — both of you should reload the page.">Needs v${U.esc(r.ver)}</button>`
        : full
        ? '<button class="btn small" disabled>Full</button>'
        : `<button class="btn small ${r.vis === 'public' ? 'primary' : ''}" data-act="join" data-lid="${U.esc(r.lid)}">${r.vis === 'public' ? 'Join' : 'Ask to join'}</button>`;
      const seats = Array.from({ length: r.max }, (_, i) => `<i class="${i < r.players ? 'on' : ''}"></i>`).join('');
      const tags = [
        `<span class="rm-tag ${r.vis}">${r.vis === 'public' ? 'Public' : 'Private'}</span>`,
        r.champ === 'points' ? '<span class="rm-tag">Championship</span>' : '',
        r.endu ? '<span class="rm-tag endu">Endurance</span>' : '',
      ].join('');
      const detail = [tr ? `${racing ? 'on' : 'next'} ${U.esc(tr.name)}` : '', r.bots ? `${r.bots} ${lvl ? lvl.toLowerCase() + ' ' : ''}bot${r.bots === 1 ? '' : 's'}` : '', `host ${U.esc(r.host)}`].filter(Boolean).join(' · ');
      return `<div class="rm-main"><div class="rm-line1"><b class="rm-name">${U.esc(r.name)}</b>${tags}</div><div class="rm-line2 muted small">${detail}</div></div>
        <span class="rm-pill ${TONE[r.phase] || 'break'}">${U.esc(where)}</span>
        <div class="rm-seats" title="${r.players} of ${r.max} drivers"><div class="rm-dots">${seats}</div><span class="small"><b>${r.players}</b>/${r.max}</span></div>
        ${btn}`;
    },
    render() {
      const b = this.board;
      if (!b) return UI.patch(this.el.status, 'The server list needs the relay.');
      const all = b.list();
      this._list = all;
      const waited = performance.now() - this.t0 > 3000;
      const blocked = !b.reached() && b.failed >= b.tried;
      UI.patch(this.el.status, blocked ? "Can't reach the room servers from this network — join with a code instead" : !b.reached() ? 'Connecting…' : `${all.length} room${all.length === 1 ? '' : 's'} open · live`);
      this.el.live.className = 'rm-live' + (blocked ? ' bad' : b.reached() ? ' on' : '');
      const n = (f) => all.filter((r) => this._pass(r, f, '')).length;
      UI.patch(this.el.filters, FILTERS.map(([k, l]) => `<button class="chipb ${this.filter === k ? 'on' : ''}" data-act="filter" data-v="${k}">${l}<em>${n(k)}</em></button>`).join(''));
      const list = all.filter((r) => this._pass(r, this.filter, this.q));
      // keyed rows: add, update in place, reorder, remove
      const L = this.el.list, seen = new Set();
      let prev = null;
      for (const r of list) {
        seen.add(r.lid);
        let row = this.rowEls.get(r.lid);
        if (!row) {
          row = document.createElement('div');
          row.className = 'rm-row';
          row.setAttribute('role', 'listitem');
          this.rowEls.set(r.lid, row);
        }
        const html = this._row(r);
        if (row._html !== html) {
          row._html = html;
          row.innerHTML = html;
        }
        row.classList.toggle('old', r.proto !== G.Net.PROTO);
        const want = prev ? prev.nextSibling : L.firstChild;
        if (want !== row) L.insertBefore(row, want);
        prev = row;
      }
      for (const [lid, row] of this.rowEls) {
        if (seen.has(lid)) continue;
        row.remove();
        this.rowEls.delete(lid);
      }
      let empty = L.querySelector('.rm-empty');
      if (!list.length) {
        const msg = all.length
          ? 'No rooms match. <button class="btn small ghost" data-act="filter" data-v="all">Show all rooms</button>'
          : b.reached() && waited
          ? '<b>Nobody is hosting right now.</b><span>Host a room and it shows up here for everyone.</span>'
          : '<span class="rm-spin"></span><span>Looking for rooms…</span>';
        if (!empty) {
          empty = document.createElement('div');
          empty.className = 'rm-empty';
          L.appendChild(empty);
        }
        if (empty._html !== msg) {
          empty._html = msg;
          empty.innerHTML = msg;
        }
      } else if (empty) empty.remove();
    },
    _pass(r, f, q) {
      if (q && !(r.name.toLowerCase().includes(q) || (r.host || '').toLowerCase().includes(q))) return false;
      if (f === 'open') return r.proto === G.Net.PROTO && r.players < r.max && r.phase !== 'final';
      if (f === 'public') return r.vis === 'public';
      if (f === 'lobby') return r.phase === 'lobby';
      if (f === 'racing') return r.phase === 'race' || r.phase === 'entry' || r.phase === 'betting';
      return true;
    },
    update() {
      // "Looking for rooms…" turns into "Nobody is hosting" after a moment
      if (!this._shown && performance.now() - this.t0 > 3200) {
        this._shown = true;
        UI.refresh();
      }
    },
    acts: {
      back() {
        G.App.showMenu();
      },
      filter(el) {
        this.filter = el.dataset.v;
        this.render();
      },
      host() {
        UI.toast('Creating a room…');
        G.Game.hostNew(G.App.name()).catch((e) => {
          G.Game.role = null;
          UI.toast('Could not host: ' + e.message, 'bad');
        });
      },
      code() {
        if (UI.screens.menu && UI.screens.menu.openJoin) UI.screens.menu.openJoin();
      },
      // Public: straight in with the code on the card. Private: ask the host
      // (the card has no code); if they say yes, their encrypted reply carries
      // the code and we join with it.
      async join(el) {
        const r = (this._list || []).find((x) => x.lid === el.dataset.lid);
        if (!r) return;
        let code = r.vis === 'public' ? r.code : null;
        if (!code) {
          if (this._asking || !this.board) return;
          this._asking = true;
          UI.notice(`🔒 Asked the host of <b>${U.esc(r.name)}</b> to let you in…`, () => this.board && this.board.cancelAsk());
          try {
            code = await this.board.ask(r, G.App.name());
            UI.clearNotice();
            UI.toast("You're in — joining…", 'good');
          } catch (e) {
            UI.clearNotice();
            if (e.message !== 'Cancelled.') UI.toast(e.message, 'bad');
          }
          this._asking = false;
          if (!code) return;
        } else UI.toast('Connecting to ' + r.name + '…');
        try {
          await G.Game.join(code, G.App.name());
        } catch (e) {
          G.Game.role = null;
          UI.toast(e.message, 'bad');
        }
      },
    },
  };
  UI.register('rooms', Rooms);

  // Host only: one card per driver asking to join a private room. Visible on
  // every screen (also mid-race — click with the mouse); requests expire
  // after 2 minutes.
  const Requests = {
    init() {
      const el = document.createElement('div');
      el.id = 'requests';
      el.style.display = 'none';
      document.body.appendChild(el);
      this.el = el;
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-id]');
        if (!b) return;
        if (G.Audio) G.Audio.click();
        G.Game.answer(b.dataset.id, b.dataset.ok === '1');
        this.render(true);
      });
      setInterval(() => this.render(), 300);
    },
    render(force) {
      const g = G.Game;
      const on = g.role === 'host' && g.requests && g.requests.size > 0;
      const key = on ? g.reqSeq + ':' + g.requests.size : '';
      if (!force && key === this.key) return;
      this.key = key;
      this.el.style.display = on ? '' : 'none';
      this.el.innerHTML = on
        ? Array.from(g.requests.values())
            .map((r) => `<div class="rq"><span>🔔 <b>${U.esc(r.name)}</b> wants to join</span><button class="btn small green" data-id="${U.esc(r.id)}" data-ok="1">Let in</button><button class="btn small ghost" data-id="${U.esc(r.id)}" data-ok="0">No</button></div>`)
            .join('')
        : '';
    },
  };
  G.Requests = Requests;
  window.addEventListener('load', () => Requests.init());
})(window.G);
