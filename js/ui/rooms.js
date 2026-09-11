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
  const PHASE = { lobby: 'In the lobby', carselect: 'Picking cars', entry: 'Starting a race', betting: 'Placing bets', race: 'Racing', results: 'Results', intermission: 'In the garage', final: 'Finished' };

  const Rooms = {
    mount(root) {
      root.innerHTML = `<div class="rooms"><div class="panel rm-card">
        <div class="rm-head"><h1>🌐 SERVER LIST</h1><p class="muted">Rooms open right now, from any classroom. <b>🌐 Public</b> rooms let you straight in; <b>🔒 Private</b> rooms ask their host first. You can join mid-session: you watch the race in progress and drive from the next one.</p></div>
        <div class="rm-status muted small"></div>
        <div class="rm-list"></div>
        <div class="rm-foot"><button class="btn ghost" data-act="back">← Menu</button><button class="btn" data-act="code">🔗 Join with a code</button><button class="btn primary" data-act="host">👥 Host a room</button></div>
      </div></div>`;
      this.el = { status: root.querySelector('.rm-status'), list: root.querySelector('.rm-list') };
      this.t0 = performance.now();
      this.board = G.Relay ? new G.Relay.RoomBoard().start() : null;
      this.off = this.board ? this.board.on('change', () => UI.refresh()) : null;
    },
    unmount() {
      if (this.off) this.off();
      if (this.board) this.board.close();
      this.board = this.off = null;
    },
    render() {
      const b = this.board;
      if (!b) return UI.patch(this.el.status, 'The server list needs the relay (js/relay.js).');
      const list = b.list();
      const waited = performance.now() - this.t0 > 3000;
      let status;
      if (!b.reached()) status = b.failed >= b.tried ? "⚠ This network blocks the room servers — you can still join with a code." : 'Connecting to the room servers…';
      else status = `${list.length ? `${list.length} room${list.length === 1 ? '' : 's'} open` : 'No rooms open'} · updates live`;
      UI.patch(this.el.status, status);
      const rows = list
        .map((r) => {
          const old = r.proto !== G.Net.PROTO;
          const full = r.players >= r.max;
          const where = r.phase === 'lobby' || r.phase === 'final' ? PHASE[r.phase] : `${PHASE[r.phase] || r.phase} · race ${Math.min(r.race + (r.phase === 'race' || r.phase === 'entry' || r.phase === 'betting' ? 1 : 0), r.races)} of ${r.races}`;
          const btn = old
            ? `<button class="btn small" disabled title="That room runs a different version of the game — both of you should reload.">v${U.esc(r.ver)}</button>`
            : full
            ? '<button class="btn small" disabled>Full</button>'
            : `<button class="btn small ${r.vis === 'public' ? 'primary' : ''}" data-act="join" data-code="${r.code}">${r.vis === 'public' ? 'Join' : '🔒 Ask to join'}</button>`;
          return `<div class="rm-row ${old ? 'old' : ''}"><div class="rm-name"><b>${r.vis === 'public' ? '🌐' : '🔒'} ${U.esc(r.name)}</b><span class="muted small">host ${U.esc(r.host)} · ${U.esc(where)}</span></div><div class="rm-pl"><b>${r.players}/${r.max}</b><span class="muted small">drivers${r.bots ? ` +${r.bots} bot${r.bots === 1 ? '' : 's'}` : ''}</span></div>${btn}</div>`;
        })
        .join('');
      UI.patch(this.el.list, rows || `<div class="rm-empty">${b.reached() && waited ? 'Nobody is hosting right now. <b>Host a room</b> and it shows up here for everyone.' : 'Looking for rooms…'}</div>`);
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
      async join(el) {
        const code = el.dataset.code;
        UI.toast('Connecting to ' + code + '…');
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
