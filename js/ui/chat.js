// chat.js — session chat on EVERY screen (car select, garage, entry, betting,
// results and during races), not only the lobby and intermission panels.
//   T or Enter opens it (unless you're already typing somewhere), Enter
//   sends, Esc closes. While the box is open your keys type instead of drive.
// Closed, the latest lines show in the corner for a few seconds and fade;
// the 💬 button counts what you missed. Hidden on screens that already have a
// big chat panel (lobby, intermission) and outside multiplayer.
'use strict';
(function (G) {
  const U = G.U;
  const SHOW_MS = 12000; // how long a new line stays visible while the box is closed

  const Chat = {
    init() {
      const el = document.createElement('div');
      el.id = 'chatbox';
      el.style.display = 'none';
      el.innerHTML = `<div class="cb-log"></div><div class="cb-in"><input maxlength="140" placeholder="Say something… Enter sends · Esc closes"></div><button class="cb-btn" title="Chat (T or Enter)">💬 <span>Chat</span><b></b></button>`;
      document.body.appendChild(el);
      this.el = el;
      this.logEl = el.querySelector('.cb-log');
      this.inp = el.querySelector('input');
      this.badge = el.querySelector('.cb-btn b');
      this.open = false;
      this.unread = 0;
      this.lastAt = null;
      this.arrived = new Map(); // message key -> local arrival time (for fading)
      el.querySelector('.cb-btn').addEventListener('click', () => (this.open ? this.close() : this.show()));
      this.inp.addEventListener('keydown', (e) => {
        // stopPropagation: the same Enter would otherwise bubble up to the
        // "open chat" hotkey and pop the box straight back open
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          this.send();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.close();
        }
      });
      this.inp.addEventListener('blur', () => setTimeout(() => document.activeElement !== this.inp && this.open && this.close(), 0));
      window.addEventListener('keydown', (e) => this._hotkey(e));
      setInterval(() => this.update(), 200);
    },

    available() {
      return !!(G.Game && G.Game.role && G.Client.state && G.App && G.App.mode !== 'menu');
    },
    // this screen already has its own big chat panel
    panel() {
      return !!document.querySelector('#ui .chat-log');
    },

    _hotkey(e) {
      if (this.open || e.repeat || !this.available() || this.panel()) return;
      if (performance.now() - (this._closedAt || 0) < 250) return; // the key that just closed it
      if (e.code !== 'KeyT' && e.key !== 'Enter') return;
      const a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
      if (e.key === 'Enter' && a && a.tagName === 'BUTTON') return; // Enter on a focused button clicks it
      if (document.querySelector('.modal-bg')) return;
      if (e.code === 'KeyT' && Object.values(G.Settings.s.keys).includes('KeyT')) return; // T is bound to a control
      e.preventDefault(); // don't type the T into the box
      this.show();
    },

    show() {
      this.open = true;
      this.el.classList.add('open');
      this.inp.value = '';
      this.inp.focus();
      this.unread = 0;
      this.render();
    },
    close() {
      this.open = false;
      this._closedAt = performance.now();
      this.el.classList.remove('open');
      if (document.activeElement === this.inp) this.inp.blur();
      this.render();
    },
    send() {
      const v = this.inp.value.trim();
      if (v) G.Client.act({ t: 'chat', text: v });
      this.inp.value = '';
      this.close();
    },

    update() {
      const on = this.available() && !this.panel();
      this.el.style.display = on ? '' : 'none';
      document.body.classList.toggle('chatting', on && this.open);
      if (!on && this.open) this.close();
      const chat = (G.Client.state && G.Client.state.chat) || [];
      const now = performance.now();
      // new lines since last time (a fresh session starts clean)
      const newest = chat.length ? chat[chat.length - 1].at : null;
      if (this.lastAt == null || (newest != null && newest < this.lastAt)) this.lastAt = newest != null ? newest - 1 : 0;
      let fresh = 0;
      for (const c of chat) {
        if (c.at <= this.lastAt) continue;
        this.arrived.set(c.at + '|' + c.text, now);
        if (!c.sys && c.from !== G.Client.meId) fresh++;
      }
      if (newest != null && newest > this.lastAt) this.lastAt = newest;
      if (fresh) {
        if (!this.open) this.unread += fresh;
        if (G.Audio && G.Audio.chat && on) G.Audio.chat();
      }
      if (this.arrived.size > 80) for (const k of Array.from(this.arrived.keys()).slice(0, 40)) this.arrived.delete(k);
      this.chat = chat;
      if (on) this.render();
    },

    render() {
      const chat = this.chat || [];
      const now = performance.now();
      const line = (c, age) => {
        const fade = this.open ? '' : age > SHOW_MS - 2000 ? ' old' : '';
        return c.sys ? `<div class="cm sys${fade}">${U.esc(c.text)}</div>` : `<div class="cm${fade}"><b style="color:${G.UI.colorHex(c.color)}">${U.esc(c.name)}</b> ${U.esc(c.text)}</div>`;
      };
      let html;
      if (this.open) html = chat.slice(-30).map((c) => line(c, 0)).join('');
      else
        html = chat
          .slice(-6)
          .map((c) => [c, now - (this.arrived.get(c.at + '|' + c.text) || -1e9)])
          .filter(([, age]) => age < SHOW_MS)
          .map(([c, age]) => line(c, age))
          .join('');
      if (this.logEl._html !== html) {
        this.logEl._html = html;
        this.logEl.innerHTML = html;
        this.logEl.scrollTop = 1e6;
      }
      const b = this.unread ? String(Math.min(99, this.unread)) : '';
      if (this.badge.textContent !== b) this.badge.textContent = b;
    },
  };

  G.Chat = Chat;
  window.addEventListener('load', () => Chat.init());
})(window.G);
