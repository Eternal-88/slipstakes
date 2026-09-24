// chat.js — session chat on EVERY screen (car select, garage, entry, betting,
// results and during races), not only the lobby and intermission panels.
//   T or Enter opens it (unless you're already typing somewhere), Enter
//   sends, Esc closes. While the box is open your keys type instead of drive.
// Closed, the latest lines show in the corner for a few seconds and fade;
// the 💬 button counts what you missed. Hidden on screens that already have a
// big chat panel (lobby, intermission) and outside multiplayer.
// v5.5: speech to text - hold V (or tap 🎤), speak, and it goes into chat.
// v5.5.1: push to talk, tap to talk or voice activated (Settings -> Voice).
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
      el.innerHTML = `<div class="cb-log"></div><div class="cb-in"><input maxlength="140" placeholder="Say something… Enter sends · Esc closes"></div><div class="cb-row"><button class="cb-btn" title="Chat (T or Enter)">💬 <span>Chat</span><b></b></button><button class="cb-btn stt-mic" title="Speech to text">🎤</button></div>`;
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
    // speech to text, "check it first": the words go into a chat box to
    // fix up and send with Enter (the lobby's own panel if it has one)
    review(text) {
      const pin = this.panel() && document.querySelector('#ui .chat-in input');
      const box = pin || this.inp;
      if (!pin && !this.open) this.show();
      box.value = (box.value.trim() ? box.value.trim() + ' ' : '') + text;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    },
    send() {
      const v = this.inp.value.trim();
      if (v) G.Client.act({ t: 'chat', text: v });
      this.inp.value = '';
      this.close();
    },

    update() {
      const on = this.available() && !this.panel();
      const stt = Talk.ready();
      document.body.classList.toggle('stt', stt);
      if (!stt && Talk.on && !Talk.recTest) Talk.cancel();
      // the chat box and every 🎤 say how speech to text works right now
      const tk = G.Settings.s.keys.talk, kn = tk ? G.Settings.keyName(tk) : '', m = Talk.mode();
      const tip = !stt ? '' : m === 'voice' ? (Talk.muted ? ' · voice chat muted' : ' · voice chat on') + (kn ? ` (${kn} mutes)` : '') : kn ? ` · ${m === 'ptt' ? 'hold' : 'tap'} ${kn} to talk` : '';
      const ph = 'Say something… Enter sends · Esc closes' + tip;
      if (this.inp.placeholder !== ph) this.inp.placeholder = ph;
      if (stt) {
        const mt = m === 'voice' ? `Voice chat: click to ${Talk.muted ? 'unmute' : 'mute'}${kn ? ' (' + kn + ')' : ''}` : `Speech to text: click, then speak${kn ? ` (or ${m === 'ptt' ? 'hold' : 'tap'} ${kn})` : ''}`;
        for (const b of document.querySelectorAll('.stt-mic')) if (b.title !== mt) b.title = mt;
        Talk.paint();
      }
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
  // For players who want to talk but can't wear a headset: speak, and what
  // you said goes into the chat as a 🎤 line. Four ways to use it (Settings ->
  // Voice, v5.5.1):
  //   Push to talk    hold the talk key (V); letting go sends
  //   Tap to talk     tap the key or a 🎤 once; it sends when you pause
  //   Voice activated always listening while you're in a session; each
  //                   sentence goes when you pause, anything quieter than
  //                   the sensitivity is ignored, the talk key mutes it
  //   Off
  // It is the browser's own recogniser - Chrome and Edge send the audio to
  // their speech service, so it needs a connection and the page's microphone
  // permission, and a school Chromebook may have the microphone blocked.
  // Chrome stars out swear words itself.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const FAIL = {
    'not-allowed': 'Microphone blocked. Allow it from the icon at the left of the address bar (a school Chromebook may not let you).',
    'service-not-allowed': 'Speech to text is switched off in this browser.',
    'audio-capture': 'No microphone found.',
    network: 'Speech to text needs the internet (it uses your browser\'s speech service).',
    'language-not-supported': 'Speech to text does not support that language. Pick another in Settings → Voice.',
  };
  // the languages offered in Settings -> Voice ('auto' = the browser's own)
  const LANGS = [
    ['auto', 'Same as the browser'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['en-IN', 'English (India)'],
    ['es-ES', 'Español (España)'], ['es-MX', 'Español (México)'], ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['it-IT', 'Italiano'],
    ['pt-BR', 'Português (Brasil)'], ['pt-PT', 'Português (Portugal)'], ['nl-NL', 'Nederlands'], ['sv-SE', 'Svenska'], ['pl-PL', 'Polski'],
    ['ru-RU', 'Русский'], ['uk-UA', 'Українська'], ['tr-TR', 'Türkçe'], ['ar-SA', 'العربية'], ['hi-IN', 'हिन्दी'], ['zh-CN', '中文（普通话）'],
    ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['vi-VN', 'Tiếng Việt'], ['id-ID', 'Bahasa Indonesia'], ['fil-PH', 'Filipino'],
  ];
  const SS = () => G.Settings.s;
  // a lone "uh" or "hmm" on an open mic isn't a message
  const FILLER = /^(u+h+|u+m+|e+r+m*|a+h+|h+m+|m+h*m+|e+h+|o+h+|mhm|uhhuh)$/;
  // voice activation's loudness gate: sensitivity 0..100 -> the level (dBFS)
  // an utterance has to reach somewhere in it to be sent
  const gateDb = (sens) => -62 + (100 - sens) * 0.5;
  const meter01 = (db) => U.clamp((db + 65) / 60, 0, 1);

  const Talk = {
    supported: !!SR,
    LANGS,
    on: false, // a recogniser is running
    held: null, // push to talk: the key being held
    muted: false, // voice activation, switched off for now (talk key / 🎤)
    blocked: false, // the browser refused the microphone: stop retrying until asked
    test: false, // Settings -> Voice -> Test (nothing is sent)
    level: -99, // microphone level, dBFS, while the meter is open
    heard: '', // the test's last result, for the settings panel
    init() {
      const bar = document.createElement('div');
      bar.id = 'sttbar';
      bar.innerHTML = '<i></i><div><b></b><span></span></div>';
      document.body.appendChild(bar);
      this.bar = bar;
      this.lbl = bar.querySelector('b');
      this.txt = bar.querySelector('span');
      window.addEventListener('keydown', (e) => {
        const k = SS().keys.talk;
        if (!k || e.code !== k || e.repeat || !this.ready()) return;
        const a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
        if (document.querySelector('.modal-bg') || (G.Overlay && G.Overlay.isOpen)) return;
        e.preventDefault();
        const m = this.mode();
        if (m === 'voice') this.toggleMute();
        else if (this.on && !this.recTest) this.stop(); // tap to talk: a second tap sends now
        else if (!this.on) this.start(m === 'ptt' ? k : null);
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
        if (!this.supported) return G.UI.toast('Speech to text needs Chrome or Edge.', 'bad');
        if (!this.ready()) return;
        if (this.mode() === 'voice') return this.toggleMute();
        if (this.on && !this.recTest) this.stop();
        else if (!this.on) this.start(null);
      });
      G.Settings.on((k) => {
        if (typeof k !== 'string' || !k.startsWith('stt')) return;
        if (k === 'sttMode' || k === 'sttLang') {
          // a new mode or language starts clean (and may ask again)
          this.blocked = false;
          this.muted = false;
          if (this.on && !this.recTest) this.cancel();
          else if (this.on && this.recTest && k === 'sttLang') {
            this._restart = true; // (the test carries on in the new language)
            this.rec.stop();
          }
        }
      });
      setInterval(() => this._tick(), 60);
    },
    // what the RUNNING recogniser is for (this.test is the test being wanted,
    // which can be waiting for voice activation's recogniser to close)
    get recTest() {
      return !!(this.rec && this.rec._test);
    },
    get recVoice() {
      return !!(this.rec && this.rec._voice);
    },
    mode() {
      const m = SS().sttMode;
      return m === 'tap' || m === 'voice' || m === 'off' ? m : 'ptt';
    },
    ready() {
      return this.supported && this.mode() !== 'off' && Chat.available();
    },
    lang() {
      const l = SS().sttLang;
      return l && l !== 'auto' ? l : navigator.language || 'en-US';
    },
    // Voice activation: should the microphone be open right now?
    _want() {
      if (this.mode() !== 'voice' || this.muted || this.blocked || this.test || document.hidden || !this.ready()) return false;
      const racing = document.body.classList.contains('racing');
      const w = SS().sttWhere;
      return w === 'race' ? racing : w === 'menus' ? !racing : true;
    },
    toggleMute() {
      this.muted = !this.muted;
      this.blocked = false;
      if (this.muted && this.on) this.cancel();
      this._cue(!this.muted);
      G.UI.toast(this.muted ? '🎤 Voice chat muted. ' + this._keyHint('unmute') : '🎤 Voice chat on. ' + this._keyHint('mute'), 'info', false);
      this.paint();
    },
    _keyHint(what) {
      const k = SS().keys.talk;
      return k ? `Press ${G.Settings.keyName(k)} to ${what}.` : `Click 🎤 to ${what}.`;
    },

    // held: the key being held (push to talk), else null
    start(held, test) {
      if (this.on) return;
      let r;
      try {
        r = new SR();
        r.lang = this.lang();
        r.continuous = true;
        r.interimResults = true;
        r.maxAlternatives = 1;
      } catch (e) {
        return G.UI.toast('Speech to text could not start.', 'bad');
      }
      this.rec = r;
      this.held = held || null;
      r._test = !!test;
      r._voice = !test && this.mode() === 'voice';
      this.err = null;
      this._n = 0;
      this._utter(0);
      r.onresult = (ev) => this._onResult(ev);
      r.onerror = (ev) => {
        this.err = ev.error;
      };
      r.onend = () => this._onEnd(r);
      try {
        r.start();
      } catch (e) {
        this.rec = null;
        this.held = null;
        return G.UI.toast('Speech to text could not start.', 'bad');
      }
      this.on = true;
      this.startedAt = performance.now();
      if (!r._voice && !r._test) {
        this._cue(true);
        this._duck(true);
      }
      if (r._voice || r._test) this._meter(true);
      this.paint();
    },
    // new utterance: results from index `base` on are what we're building
    _utter(base) {
      this.base = base;
      this.fin = '';
      this.mid = '';
      this.conf = [];
      this.peak = -99;
      this.heardAt = 0;
    },
    _onResult(ev) {
      let fin = '', mid = '';
      const conf = [];
      for (let i = this.base; i < ev.results.length; i++) {
        const x = ev.results[i];
        if (x.isFinal) {
          fin += x[0].transcript;
          if (x[0].confidence > 0) conf.push(x[0].confidence);
        } else mid += x[0].transcript;
      }
      this.fin = fin;
      this.mid = mid;
      this.conf = conf;
      this._n = ev.results.length;
      if ((fin + mid).trim()) {
        if (!this.heardAt && this.recVoice) this._duck(true);
        this.heardAt = performance.now();
      }
      this.paint();
    },
    _text() {
      return (this.fin + ' ' + this.mid).replace(/\s+/g, ' ').trim();
    },
    // Send what we have (tap to talk and voice activation: after a pause).
    // `last`: the recogniser has stopped, nothing more is coming.
    _flush(last) {
      let text = this._text();
      const peak = this.peak, conf = this.conf, test = this.recTest, voice = this.recVoice;
      this._utter(this._n || this.base);
      if (voice) this._duck(false);
      if (!text) return false;
      if (test) {
        this.heard = text;
        this.heardOk = !(this.meterOk && peak < gateDb(SS().sttSens));
        this._paintTest();
        return true;
      }
      if (voice) {
        // voice activation: quiet chatter from across the room, a mumble the
        // recogniser itself barely believed, a lone "uh" - not a message
        if (this.meterOk && peak < gateDb(SS().sttSens)) return false;
        if (conf.length && conf.reduce((a, b) => a + b, 0) / conf.length < 0.3) return false;
        const bare = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        if (bare.length < 2 || FILLER.test(bare)) return false;
      }
      text = text[0].toUpperCase() + text.slice(1);
      this._send(text, voice);
      return true;
    },
    _send(text, voice) {
      if (!Chat.available()) return;
      if (SS().sttSend === 'review') return Chat.review(text);
      const mark = SS().sttMark !== false;
      G.Client.act({ t: 'chat', text: (mark ? '🎤 ' : '') + text.slice(0, mark ? 136 : 140) });
      if (voice && SS().sttBeep !== false && G.Audio) G.Audio.tone(1500, 0.05, 'sine', 0.035, 1900, 'ui');
    },
    // push to talk let go / tap to talk tapped again: finish and send
    stop() {
      this.held = null;
      if (!this.rec) return;
      this.sending = true;
      this.paint();
      try {
        this.rec.stop();
      } catch (e) {
        this._onEnd(this.rec);
      }
    },
    // the mode changed, the session ended, muted: drop it unsent
    cancel() {
      this._drop = true;
      this.held = null;
      if (this.rec) {
        try {
          this.rec.abort();
        } catch (e) {
          this._onEnd(this.rec);
        }
      }
    },
    _onEnd(r) {
      if (r !== this.rec || !this.on) return;
      const wasVoice = !!r._voice, wasTest = !!r._test, err = this.err, drop = this._drop;
      const sent = drop ? false : this._flush(true); // (while this.rec is still r)
      this.on = false;
      this.rec = null;
      this.held = null;
      this.sending = false;
      this._drop = false;
      this._duck(false);
      if (!wasVoice && !wasTest) this._cue(false);
      if (!wasTest && !this._want()) this._meter(false);
      if ((this._restart && wasTest) || (this._pendingTest && this.test)) {
        // the test's language changed (carry on in the new one), or the test
        // was waiting for voice activation's recogniser to close
        this._restart = this._pendingTest = false;
        this.paint();
        return this.start(null, true);
      }
      if (wasTest) {
        this.test = false;
        // (the test ended by itself - an error, or the browser's time limit)
        if (G.Overlay && G.Overlay.isOpen && G.Overlay.tab === 'voice') G.Overlay.render();
      }
      this.paint();
      if (drop || err === 'aborted') return;
      if (FAIL[err] && (err !== 'network' || !wasVoice || !this._netTold)) {
        if (err === 'network') this._netTold = true;
        if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') this.blocked = true;
        G.UI.toast(FAIL[err], 'bad');
        this.retryAt = performance.now() + 8000;
        return;
      }
      if (wasVoice) {
        // Chrome ends a long session by itself (a minute or so, or after a
        // quiet spell): voice activation just carries on
        this.retryAt = performance.now() + (err === 'network' ? 6000 : 250);
        return;
      }
      if (!sent && !wasTest && !(err === 'no-speech' && performance.now() - this.startedAt < 600)) {
        const k = SS().keys.talk;
        G.UI.toast("🎤 Didn't catch that. " + (this.mode() === 'ptt' && k ? 'Hold ' + G.Settings.keyName(k) + ' while you speak.' : 'Speak after the blip.'), 'info', false);
      }
    },

    // Settings -> Voice -> Test microphone
    startTest() {
      if (!this.supported) return G.UI.toast('Speech to text needs Chrome or Edge.', 'bad');
      this.test = true; // (voice activation stands down from now)
      this.heard = '';
      this.heardOk = true;
      if (this.on) {
        this._pendingTest = true;
        this.cancel();
      } else this.start(null, true);
    },
    stopTest() {
      if (!this.test) return;
      this.test = false;
      this._restart = this._pendingTest = false;
      if (this.recTest) this.cancel();
      else this._meter(false);
    },

    // the microphone level meter: voice activation's loudness gate, and the
    // needle in the test. Its own stream, closed again when it isn't needed
    // so the browser's "microphone in use" light goes out.
    _meter(on) {
      if (!on) {
        if (this._ms) for (const t of this._ms.getTracks()) t.stop();
        this._ms = null;
        this.meterOk = false;
        this.level = -99;
        if (this._mctx) this._mctx.close().catch(() => {});
        this._mctx = null;
        return;
      }
      if (this._ms || this._mOpening || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
      this._mOpening = true;
      navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .then((ms) => {
          this._mOpening = false;
          if (!this.on || !(this.recTest || this.recVoice)) {
            for (const t of ms.getTracks()) t.stop();
            return;
          }
          const AC = window.AudioContext || window.webkitAudioContext;
          const c = new AC();
          const an = c.createAnalyser();
          an.fftSize = 1024;
          c.createMediaStreamSource(ms).connect(an);
          this._ms = ms;
          this._mctx = c;
          this._an = an;
          this._buf = new Float32Array(an.fftSize);
          this.meterOk = true;
        })
        .catch(() => {
          this._mOpening = false;
          this.meterOk = false; // no gate: every sentence the recogniser hears goes
        });
    },
    _tick() {
      if (this._an && this._ms) {
        this._an.getFloatTimeDomainData(this._buf);
        let s = 0;
        for (let i = 0; i < this._buf.length; i += 2) s += this._buf[i] * this._buf[i];
        this.level = 10 * Math.log10(s / (this._buf.length / 2) + 1e-12);
        if (this.on && this.level > this.peak) this.peak = this.level;
      }
      const now = performance.now();
      // tap to talk / voice / test: a pause ends the message
      if (this.on && !this.held && this.heardAt && now - this.heardAt > (SS().sttPause || 1.2) * 1000) {
        if (this.recVoice || this.recTest) this._flush(false);
        else this.stop();
      }
      // tapped and then said nothing, or a key held down forever: give up
      if (this.on && !this.recVoice && !this.recTest && !this.sending && ((!this.held && !this.heardAt && now - this.startedAt > 8000) || now - this.startedAt > 20000)) this.stop();
      // voice activation opens and closes itself
      const want = this._want();
      if (want && !this.on && now > (this.retryAt || 0)) this.start(null);
      else if (!want && this.on && this.recVoice && !this._drop) this.cancel();
      if (!this.on && this._ms && !this.test && !want) this._meter(false);
      if (this.recTest) this._paintTest();
    },
    // the test's needle and transcript in Settings -> Voice
    _paintTest() {
      const m = document.querySelector('.stt-meter');
      if (m) {
        const gate = gateDb(SS().sttSens);
        m.firstElementChild.style.width = (meter01(this.level) * 100).toFixed(1) + '%';
        m.classList.toggle('over', this.level >= gate);
        m.lastElementChild.style.left = (meter01(gate) * 100).toFixed(1) + '%';
      }
      const h = document.querySelector('.stt-heard');
      if (!h) return;
      const live = this._text();
      const t = live ? '… ' + live : this.heard ? '“' + this.heard + '”' + (this.mode() === 'voice' && !this.heardOk ? '  (too quiet for voice activation at this sensitivity)' : '') : this.on ? 'Say something…' : '';
      if (h.textContent !== t) h.textContent = t;
      h.classList.toggle('bad', !live && !!this.heard && this.mode() === 'voice' && !this.heardOk);
    },
    _duck(on) {
      const v = SS().sttDuck == null ? 25 : SS().sttDuck;
      if (G.Audio && G.Audio.duck) G.Audio.duck(on && v < 100 ? v / 100 : false);
    },
    _cue(up) {
      if (SS().sttBeep === false || !G.Audio) return;
      G.Audio.tone(up ? 880 : 1320, 0.06, 'sine', 0.05, up ? 1320 : 880, 'ui');
    },
    paint() {
      const listening = this.on && !this.recTest;
      const talking = listening && (!this.recVoice || !!this._text());
      this.bar.classList.toggle('on', talking && SS().sttBar !== false);
      for (const b of document.querySelectorAll('.stt-mic')) {
        b.classList.toggle('live', talking);
        b.classList.toggle('armed', listening && this.recVoice && !talking);
        b.classList.toggle('muted', this.mode() === 'voice' && (this.muted || this.blocked));
      }
      if (!talking) return;
      const k = this.held ? G.Settings.keyName(this.held) : '';
      const review = SS().sttSend === 'review';
      this.lbl.textContent = this.sending
        ? 'Sending…'
        : this.held
          ? `Listening. Let go of ${k} to ${review ? 'check it' : 'send'}`
          : this.recVoice
            ? `Voice chat. ${review ? 'Goes to the chat box' : 'Sends'} when you pause`
            : `Listening. ${review ? 'Goes to the chat box' : 'Sends'} when you pause`;
      const t = this._text();
      this.txt.textContent = t || 'Speak now';
      this.txt.classList.toggle('hint', !t);
    },
    // for the settings panel's meter
    gate01() {
      return meter01(gateDb(SS().sttSens));
    },
  };
  Chat.Talk = Talk;

  G.Chat = Chat;
  window.addEventListener('load', () => Chat.init());
})(window.G);
