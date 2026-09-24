// chat.js — session chat on EVERY screen (car select, garage, entry, betting,
// results and during races), not only the lobby and intermission panels.
//   T or Enter opens it (unless you're already typing somewhere), Enter
//   sends, Esc closes. While the box is open your keys type instead of drive.
// Closed, the latest lines show in the corner for a few seconds and fade;
// the 💬 button counts what you missed. Hidden on screens that already have a
// big chat panel (lobby, intermission) and outside multiplayer.
// v5.5: speech to text - hold V (or tap 🎤), speak, and it goes into chat.
'use strict';
(function (G) {
  const U = G.U;
  const SHOW_MS = 12000; // how long a new line stays visible while the box is closed
  const SND_RANK = { notify: 1, leave: 2, drop: 2, join: 3, warn: 4, host: 5 };

  const Chat = {
    init() {
      const el = document.createElement('div');
      el.id = 'chatbox';
      el.style.display = 'none';
      el.innerHTML = `<div class="cb-log"></div><div class="cb-in"><input maxlength="140" placeholder="Say something… Enter sends · Esc closes"></div><div class="cb-row"><button class="cb-btn" title="Chat (T or Enter)">💬 <span>Chat</span><b></b></button><button class="cb-btn stt-mic" title="Speech to text: hold the talk key or tap here, then speak">🎤</button></div>`;
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
      Talk.init();
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
      const stt = Talk.supported && !!G.Settings.s.stt && this.available();
      document.body.classList.toggle('stt', stt);
      if (!stt && Talk.on) Talk.cancel();
      const tk = G.Settings.s.keys.talk;
      const ph = 'Say something… Enter sends · Esc closes' + (stt && tk ? ' · hold ' + G.Settings.keyName(tk) + ' to talk' : '');
      if (this.inp.placeholder !== ph) this.inp.placeholder = ph;
      this.el.style.display = on ? '' : 'none';
      document.body.classList.toggle('chatting', on && this.open);
      if (!on && this.open) this.close();
      const chat = (G.Client.state && G.Client.state.chat) || [];
      const now = performance.now();
      // new lines since last time (a fresh session starts clean)
      const newest = chat.length ? chat[chat.length - 1].at : null;
      if (this.lastAt == null || (newest != null && newest < this.lastAt)) this.lastAt = newest != null ? newest - 1 : 0;
      let fresh = 0, snd = null;
      for (const c of chat) {
        if (c.at <= this.lastAt) continue;
        this.arrived.set(c.at + '|' + c.text, now);
        if (!c.sys && c.from !== G.Client.meId) fresh++;
        // v4.5: system lines can carry a sound (someone joined / left / is
        // the new host / the room is closing): the most important one plays
        if (c.snd && (!snd || (SND_RANK[c.snd] || 0) > (SND_RANK[snd] || 0))) snd = c.snd;
      }
      if (newest != null && newest > this.lastAt) this.lastAt = newest;
      if (fresh && !this.open) this.unread += fresh;
      // (on every session screen, lobby panels included)
      if (snd && G.Audio && G.Audio.notify && this.available()) G.Audio.notify(snd);
      else if (fresh && G.Audio && G.Audio.chat && on) G.Audio.chat();
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

  // ---- v5.5 speech to text --------------------------------------------------
  // For players who want to talk but can't wear a headset: hold the talk key
  // (V) or tap a 🎤, speak, and what you said goes into the chat as a 🎤
  // line. It is the browser's own recogniser - Chrome and Edge send the audio
  // to their speech service, so it needs a connection and the page's
  // microphone permission, and a school Chromebook may have the microphone
  // blocked. Chrome stars out swear words itself.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const FAIL = {
    'not-allowed': 'Microphone blocked. Allow it from the icon at the left of the address bar (a school Chromebook may not let you).',
    'service-not-allowed': 'Speech to text is switched off in this browser.',
    'audio-capture': 'No microphone found.',
    network: 'Speech to text needs the internet (it uses your browser\'s speech service).',
    'language-not-supported': 'Speech to text does not support your browser\'s language.',
  };
  const Talk = {
    supported: !!SR,
    on: false, // listening
    init() {
      const bar = document.createElement('div');
      bar.id = 'sttbar';
      bar.innerHTML = '<i></i><div><b></b><span></span></div>';
      document.body.appendChild(bar);
      this.bar = bar;
      this.lbl = bar.querySelector('b');
      this.txt = bar.querySelector('span');
      window.addEventListener('keydown', (e) => {
        const k = G.Settings.s.keys.talk;
        if (!k || e.code !== k || e.repeat || this.on || !this.ready()) return;
        const a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
        if (document.querySelector('.modal-bg') || (G.Overlay && G.Overlay.isOpen)) return;
        e.preventDefault();
        this.start(k);
      });
      window.addEventListener('keyup', (e) => {
        if (this.held && e.code === this.held) this.stop();
      });
      window.addEventListener('blur', () => this.held && this.stop());
      // every 🎤 button (the chat corner, the lobby and results panels)
      document.addEventListener('click', (e) => {
        const b = e.target.closest && e.target.closest('.stt-mic');
        if (!b) return;
        e.preventDefault();
        if (this.on) this.stop();
        else if (!this.supported) G.UI.toast('Speech to text needs Chrome or Edge.', 'bad');
        else if (this.ready()) this.start(null);
      });
    },
    ready() {
      return this.supported && !!G.Settings.s.stt && Chat.available();
    },
    // held: the key being held (talk until it's let go), or null for a tap
    // on the mic (one sentence, sent when you pause)
    start(held) {
      let r;
      try {
        r = new SR();
        r.lang = navigator.language || 'en-US';
        r.continuous = !!held;
        r.interimResults = true;
        r.maxAlternatives = 1;
      } catch (e) {
        return G.UI.toast('Speech to text could not start.', 'bad');
      }
      this.rec = r;
      this.held = held;
      this.fin = '';
      this.mid = '';
      this.err = null;
      r.onresult = (ev) => {
        let fin = '', mid = '';
        for (let i = 0; i < ev.results.length; i++) {
          const x = ev.results[i];
          if (x.isFinal) fin += x[0].transcript;
          else mid += x[0].transcript;
        }
        this.fin = fin;
        this.mid = mid;
        this.paint();
      };
      r.onerror = (ev) => {
        this.err = ev.error;
      };
      r.onend = () => this.finish();
      try {
        r.start();
      } catch (e) {
        this.rec = null;
        this.held = null;
        return G.UI.toast('Speech to text could not start.', 'bad');
      }
      this.on = true;
      // a key held down forever (or a tab switch mid-sentence) can't leave
      // the microphone open
      clearTimeout(this.cap);
      this.cap = setTimeout(() => this.stop(), 15000);
      if (G.Audio && G.Audio.duck) G.Audio.duck(true);
      this.paint();
    },
    stop() {
      this.held = null;
      if (!this.rec) return;
      this.sending = true;
      this.paint();
      try {
        this.rec.stop();
      } catch (e) {
        this.finish();
      }
    },
    // the setting was switched off or the session ended: drop it unsent
    cancel() {
      this.fin = this.mid = '';
      this.err = 'aborted';
      this.held = null;
      if (this.rec) {
        try {
          this.rec.abort();
        } catch (e) {
          this.finish();
        }
      }
    },
    finish() {
      if (!this.on) return;
      clearTimeout(this.cap);
      this.on = false;
      this.held = null;
      this.rec = null;
      this.sending = false;
      if (G.Audio && G.Audio.duck) G.Audio.duck(false);
      this.paint();
      // (stopped mid-word, Chrome may still hold the last words as interim)
      let text = (this.fin + ' ' + this.mid).replace(/\s+/g, ' ').trim();
      if (this.err === 'aborted') return;
      if (!text) {
        if (this.err && FAIL[this.err]) return G.UI.toast(FAIL[this.err], 'bad');
        const k = G.Settings.s.keys.talk;
        return G.UI.toast("🎤 Didn't catch that. " + (k ? 'Hold ' + G.Settings.keyName(k) + ' while you speak.' : 'Tap 🎤 and speak.'), 'info', false);
      }
      text = text[0].toUpperCase() + text.slice(1);
      if (Chat.available()) G.Client.act({ t: 'chat', text: '🎤 ' + text.slice(0, 136) });
    },
    paint() {
      this.bar.classList.toggle('on', this.on);
      for (const b of document.querySelectorAll('.stt-mic')) b.classList.toggle('live', this.on);
      if (!this.on) return;
      const k = this.held ? G.Settings.keyName(this.held) : '';
      this.lbl.textContent = this.sending ? 'Sending…' : this.held ? `Listening. Let go of ${k} to send` : 'Listening. Sends when you pause';
      const t = (this.fin + ' ' + this.mid).trim();
      this.txt.textContent = t || 'Speak now';
      this.txt.classList.toggle('hint', !t);
    },
  };
  Chat.Talk = Talk;

  G.Chat = Chat;
  window.addEventListener('load', () => Chat.init());
})(window.G);
