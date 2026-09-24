// overlay.js — the in-game menu (Esc, ☰ button, or gamepad Start) and the
// full Settings panel. Available on every screen: resume / restart, garage,
// change car, settings, controls (with key rebinding), fullscreen, leave /
// main menu (with confirmation). Plus the always-visible corner buttons
// (menu, sound, fullscreen).
//
// Single-player practice really PAUSES (the sim stops). In a multiplayer
// race nothing can pause the host's clock, so your car coasts while it's open.
'use strict';
(function (G) {
  const U = G.U, UI = G.UI;
  const S = () => G.Settings;
  const opt = (v, cur, label) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
  const TABS = [['graphics', '🖥 Graphics'], ['audio', '🔊 Audio'], ['controls', '⌨ Controls'], ['voice', '🎤 Voice'], ['camera', '🎥 Camera & HUD']];

  function fullscreen() {
    const d = document;
    if (d.fullscreenElement) d.exitFullscreen && d.exitFullscreen();
    else if (d.documentElement.requestFullscreen) d.documentElement.requestFullscreen().catch(() => UI.toast('Fullscreen was blocked by the browser.', 'bad'));
  }

  const Overlay = {
    isOpen: false,
    view: 'pause',
    tab: 'graphics',
    capturing: null,

    init() {
      this.root = document.getElementById('overlay');
      this.corner = document.getElementById('corner');
      this.root.addEventListener('click', (e) => {
        const el = e.target.closest('[data-oact]');
        if (el && !el.disabled) {
          if (G.Audio) G.Audio.click();
          this.act(el.dataset.oact, el);
          return;
        }
        if (e.target.classList.contains('ov-bg')) this.hide();
      });
      const onSet = (e) => {
        const el = e.target.closest('[data-set]');
        if (!el) return;
        const k = el.dataset.set;
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.type === 'range') v = +el.value;
        else v = el.value;
        if (k === 'sound') {
          G.Audio.setEnabled(!!v);
          if (v) G.Audio.good();
          this.render();
          return;
        }
        if (e.type === 'input' && el.type !== 'range') return; // selects/checkboxes: act on change
        S().set(k, v);
        const out = el.closest('.ov-row') && el.closest('.ov-row').querySelector('output');
        if (out) out.textContent = v + (el.dataset.unit || '');
        if (k === 'sttMode' && e.type === 'change') this.render();
        if (k === 'quality' && e.type === 'change') UI.toast('Graphics quality: ' + v + '. Antialiasing changes apply after a reload.', 'info');
        if (k === 'scenery' && e.type === 'change') UI.toast('Scenery detail applies from the next track load.', 'info');
      };
      this.root.addEventListener('input', onSet);
      this.root.addEventListener('change', onSet);
      this.corner.addEventListener('click', (e) => {
        const b = e.target.closest('[data-c]');
        if (!b) return;
        const c = b.dataset.c;
        if (c === 'menu') this.isOpen ? this.hide() : this.show('pause');
        else if (c === 'online' && G.Online) G.Online.toggle();
        else if (c === 'sound') G.Audio.toggle();
        else if (c === 'fs') fullscreen();
        if (G.Audio && c !== 'sound') G.Audio.click();
      });
      G.Settings.on((k) => {
        if (k === 'sound') this.renderCorner();
      });
      document.addEventListener('fullscreenchange', () => {
        this.renderCorner();
        if (this.isOpen) this.render();
      });
      this.renderCorner();
    },

    renderCorner() {
      const snd = G.Audio && G.Audio.enabled;
      const fs = !!document.fullscreenElement;
      this.corner.innerHTML = `${G.Online ? G.Online.cornerHtml() : ''}<button data-c="menu" title="Menu (Esc)">☰</button><button data-c="sound" class="${snd ? '' : 'off'}" title="Sound on/off (M)">${snd ? '🔊' : '🔇'}</button><button data-c="fs" title="Fullscreen">${fs ? '🗗' : '⛶'}</button>`;
    },

    // Esc: close key capture / sub-view / overlay, or open it.
    escape() {
      if (this.isOpen) {
        if (this.view !== 'pause' && this.fromPause) {
          this.view = 'pause';
          this.render();
        } else this.hide();
      } else this.show('pause');
    },

    show(view, tab) {
      this.isOpen = true;
      this.view = view || 'pause';
      this.fromPause = this.view === 'pause';
      if (tab) this.tab = tab;
      const A = G.App;
      const racingLocal = A.mode === 'drive' || (A.mode === 'session' && G.Game.racing && G.Game.racing());
      G.Input.blocked = racingLocal;
      A.paused = A.mode === 'drive' && !G.Game.role; // only single-player can truly pause
      this.root.style.display = '';
      this.render();
      if (G.Audio) G.Audio.tab();
    },

    hide() {
      this.isOpen = false;
      if (G.Chat && G.Chat.Talk) G.Chat.Talk.stopTest();
      this.capturing = null;
      G.Input.captureNext(null);
      G.Input.blocked = false;
      G.App.paused = false;
      this.root.style.display = 'none';
      this.root.innerHTML = '';
    },

    render() {
      if (!this.isOpen) return;
      const html = this.view === 'settings' ? this.settingsHtml() : this.pauseHtml();
      this.root.innerHTML = `<div class="ov-bg">${html}</div>`;
    },

    pauseHtml() {
      const A = G.App, mode = A.mode, sess = !!G.Game.role, st = G.Client.state;
      const inRace = sess && st && st.phase === 'race';
      const drive = mode === 'drive';
      const test = drive && A.drive && A.drive.test;
      let title = 'MENU', sub = '';
      if (drive && !sess) {
        title = 'PAUSED';
        sub = test ? 'Test drive of your candidate build' : 'Free practice — nothing moves until you resume';
      } else if (sess) {
        sub = (inRace ? 'The race keeps running while this is open — your car coasts. ' : '') + `Room ${G.Game.code || ''} · ${G.Game.role === 'host' ? 'you are the host' : 'connected'}`;
      }
      const b = (act, label, cls, dis) => `<button class="btn ${cls || ''}" data-oact="${act}" ${dis ? 'disabled' : ''}>${label}</button>`;
      let btns = b('resume', '▶ Resume', 'primary big');
      if (drive) btns += b('restart', '↻ Restart');
      const canGarage = (mode === 'menu' || mode === 'garage' || (drive && !sess && !test)) && !sess;
      if (canGarage && mode !== 'garage') btns += b('garage', '🔧 Garage, tuning & paint');
      const carOk = !sess ? mode !== 'drive' || !test : st && ['lobby', 'carselect', 'intermission', 'results'].includes(st.phase) && mode === 'session';
      if (carOk) btns += b('car', '🚗 Change car');
      if (sess && st && ['lobby', 'carselect'].includes(st.phase) && mode === 'session') btns += b('paint', '🎨 Tune & paint');
      btns += b('settings', '⚙ Settings') + b('controls', '⌨ Controls');
      btns += b('fullscreen', document.fullscreenElement ? '🗗 Exit fullscreen' : '⛶ Fullscreen');
      if (drive) btns += b('leaveDrive', test ? '← Back to garage' : sess ? '← Back to the session' : '← Leave practice', 'ghost');
      // host: who can get in, room size and bots — any time (bots not mid-race)
      if (sess && G.Game.role === 'host' && st) {
        const s = st.settings;
        btns += b('roomVis', s.vis === 'public' ? '🌐 Public room — make private' : '🔒 Private room — make public');
        btns += b('roomMax', `👥 Max drivers: ${s.maxPlayers || 8}`);
        btns += b('roomBots', `🤖 Bots: ${s.bots}`, '', st.phase === 'race');
      }
      if (sess) btns += b('leaveSession', G.Game.role === 'host' ? '✖ Leave room' : '✖ Leave session', 'red');
      if (!sess && mode !== 'menu') btns += b('mainMenu', '⌂ Main menu', 'ghost');
      return `<div class="ov-card pause"><h1>${title}</h1>${sub ? `<p class="muted">${U.esc(sub)}</p>` : ''}<div class="ov-btns">${btns}</div><p class="muted small ov-foot">Esc closes · M sound · F3 frame-rate · <span class="ver">v${G.VERSION}</span></p></div>`;
    },

    settingsHtml() {
      const s = S().s;
      const row = (label, ctl, hint) => `<div class="ov-row"><label>${label}</label><div class="ov-ctl">${ctl}</div>${hint ? `<div class="ov-hint">${hint}</div>` : ''}</div>`;
      const rng = (k, min, max, step, unit) => `<input type="range" data-set="${k}" min="${min}" max="${max}" step="${step}" value="${s[k]}" data-unit="${unit || ''}"><output>${s[k]}${unit || ''}</output>`;
      const chk = (k, label) => `<label class="tog"><input type="checkbox" data-set="${k}" ${s[k] ? 'checked' : ''}><span></span>${label || ''}</label>`;
      const sel = (k, opts) => `<select data-set="${k}">${opts.map(([v, l]) => opt(v, s[k], l)).join('')}</select>`;
      let body = '';
      if (this.tab === 'graphics') {
        const w = G.App.world;
        const st = w ? w.stats() : null;
        body =
          row('Quality', sel('quality', [['auto', 'Auto (adapts to hold 60 fps)'], ['high', 'High'], ['medium', 'Medium (Chromebook)'], ['low', 'Low']]), st ? `Detected: <b>${st.tier}</b> tier${st.gpu ? ' · ' + U.esc(st.gpu.slice(0, 48)) : ''} · now ${st.fps.toFixed(0)} fps` : '') +
          row('Resolution', rng('resScale', 50, 100, 5, '%'), 'Lower = faster on weak graphics chips.') +
          row('Shadows', chk('shadows'), 'Car shadows. Off saves the most GPU time.') +
          row('Particles', sel('particles', [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]), 'Smoke, dust, sparks, confetti.') +
          row('Scenery detail', sel('scenery', [['auto', 'Auto (follows the graphics tier)'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]), 'Trees, grass and props (next track load).') +
          row('Weather', chk('weather'), 'Rain on wet tracks.') +
          row('Show FPS', chk('showFps'), 'Frame-rate counter in races (also F3).');
      } else if (this.tab === 'audio') {
        body =
          row('Sound', chk('sound', s.sound ? 'On' : 'Off'), 'Off by default. Everything is synthesised — no downloads.') +
          row('Master', rng('vMaster', 0, 100, 5, '%')) +
          row('Your engine', rng('vEngine', 0, 100, 5, '%')) +
          row('Other cars', rng('vOthers', 0, 100, 5, '%'), 'Engines, tyre squeal, backfires and crashes of nearby cars.') +
          row('Effects', rng('vSfx', 0, 100, 5, '%'), 'Tyres, crashes, crowd, countdown.') +
          row('Interface', rng('vUi', 0, 100, 5, '%'), 'Clicks, purchases, casino.') +
          row('Music', rng('vMusic', 0, 100, 5, '%')) +
          row('Music during races', chk('raceMusic')) +
          `<div class="ov-row"><label></label><div class="ov-ctl"><button class="btn small" data-oact="testsnd">▶ Test sound</button></div></div>`;
      } else if (this.tab === 'controls') {
        const K = s.keys;
        const keys = Object.keys(S().KEY_LABELS)
          .map((a) => `<div class="kb"><span>${S().KEY_LABELS[a]}</span><button class="key ${this.capturing === a ? 'cap' : ''}" data-oact="bind" data-a="${a}">${this.capturing === a ? 'Press a key…' : S().keyName(K[a])}</button>${['up', 'down', 'left', 'right'].includes(a) ? `<em>+ ${{ up: '↑', down: '↓', left: '←', right: '→' }[a]}</em>` : ''}</div>`)
          .join('');
        body =
          `<div class="kbs">${keys}</div>` +
          row('Keyboard steering', sel('steerSpeed', [['slow', 'Smooth (slow ramp)'], ['normal', 'Normal'], ['fast', 'Quick (fast ramp)']]), 'How fast a held key reaches full lock. Taps always give partial steering.') +
          row('Bot difficulty', sel('botLevel', G.BotKit.LEVEL_ORDER.map((k) => [k, G.BotKit.LEVELS[k].name])), 'Quick race and practice bots. Higher levels take better lines, bring better cars and parts, and sometimes play dirty.') +
          row('Race weather', sel('raceWeather', [['auto', 'Changeable (showers sometimes)'], ['dry', 'Always dry'], ['rain', 'Rain']]), 'Quick races. In the rain dry roads lose grip: narrow tyres cope best, wide slicks can aquaplane.') +
          row('Touch controls', sel('touch', [['auto', 'Auto (appear once you touch the screen)'], ['on', 'Always show'], ['off', 'Off']]), 'On-screen steer, gas, brake and handbrake buttons for touchscreen Chromebooks.') +
          row('Speech to text', `<button class="btn small" data-oact="stab" data-t="voice">🎤 Voice settings →</button>`, 'Push to talk, tap to talk or voice activated, the language, sensitivity and a microphone test.') +
          `<div class="ov-row"><label></label><div class="ov-ctl"><button class="btn small ghost" data-oact="resetKeys">Reset keys to default</button></div></div>` +
          `<p class="muted small">Fixed keys: <b>Esc</b> menu · <b>M</b> sound · <b>F3</b> fps · spectating: <b>1–8</b>/<b>Tab</b> follow a car, <b>WASD Q E</b> free camera, mouse wheel zoom.<br>Gamepad: left stick steer · RT throttle · LT brake · A handbrake · Y reset · RB camera · Start menu.</p>`;
      } else if (this.tab === 'voice') {
        const T = G.Chat && G.Chat.Talk, ok = !!(T && T.supported), m = s.sttMode || 'ptt';
        const kn = s.keys.talk ? S().keyName(s.keys.talk) : 'the talk key';
        const bind = `<button class="key ${this.capturing === 'talk' ? 'cap' : ''}" data-oact="bind" data-a="talk">${this.capturing === 'talk' ? 'Press a key…' : S().keyName(s.keys.talk)}</button>`;
        const how = {
          ptt: `Hold ${kn} (or click 🎤) and speak; letting go sends it.`,
          tap: `Tap ${kn} or 🎤 once and speak; it sends when you pause. Tap again to send straight away.`,
          voice: `Always listening while you are in a multiplayer session: each sentence goes into the chat when you pause. ${kn} or 🎤 mutes and unmutes it.`,
          off: 'No microphone at all, and no 🎤 buttons.',
        }[m];
        const on = m !== 'off';
        body =
          (ok ? '' : `<p class="ov-warn">This browser has no speech recognition. Speech to text works in Chrome and Edge.</p>`) +
          row('Speech to text', sel('sttMode', [['ptt', 'Push to talk'], ['tap', 'Tap to talk'], ['voice', 'Voice activated'], ['off', 'Off']]), how) +
          (on
            ? row(m === 'voice' ? 'Mute key' : 'Talk key', bind, 'The same key as in Controls.') +
              row('When you finish', sel('sttSend', [['auto', 'Send it'], ['review', 'Put it in the chat box to check first']]), 'Checking first lets you fix a word it misheard; Enter sends it.') +
              row('Language', sel('sttLang', T ? T.LANGS : [['auto', 'Same as the browser']]), `The language you speak. “Same as the browser” is ${U.esc(navigator.language || 'en-US')} here.`) +
              (m !== 'ptt' ? row('Pause before sending', rng('sttPause', 0.6, 3, 0.1, ' s'), 'How long a silence ends a message. Shorter sends sooner; longer lets you stop and think mid-sentence.') : '') +
              (m === 'voice'
                ? row('Voice sensitivity', rng('sttSens', 0, 100, 5, '%'), 'Lower ignores quieter voices and the room around you; higher picks up quiet speech. Set it with the test below.') +
                  row('Listen during', sel('sttWhere', [['all', 'The whole session'], ['race', 'Races only'], ['menus', 'Everything but races']]))
                : '') +
              row('Game volume while talking', rng('sttDuck', 0, 100, 5, '%'), 'Turns the game down while you talk, so laptop speakers don’t drown you out. 100% leaves it alone.') +
              row('Live captions', chk('sttBar'), 'Shows what it is hearing while you talk.') +
              row('Mark spoken messages', chk('sttMark'), 'Puts 🎤 in front of them, so everyone knows a misheard word wasn’t typed.') +
              row('Listening sounds', chk('sttBeep'), 'A short blip when it starts and stops listening.')
            : '') +
          `<div class="ov-row"><label>Test your microphone</label><div class="ov-ctl"><button class="btn small" data-oact="stttest" ${ok ? '' : 'disabled'}>${T && T.test ? '■ Stop test' : '▶ Test'}</button></div><div class="ov-hint"><div class="stt-meter"><i></i><b style="left:${T ? (T.gate01() * 100).toFixed(1) : 50}%"></b></div><span class="stt-heard"></span><br>The bar is your voice and the line is where voice activation starts listening. Nothing is sent while you test.</div></div>` +
          `<p class="muted small">Speech to text works in multiplayer. Your browser does the listening with its own online speech service (Chrome and Edge send the audio to it); SLIPSTAKES never records anything. The first time, the browser asks to use your microphone.</p>`;
      } else {
        body =
          row('Camera', sel('cam', [['follow', 'Chase'], ['near', 'Close chase'], ['far', 'High chase'], ['fixed', 'Fixed north']]), `Also the ${S().keyName(s.keys.cam)} key while driving.`) +
          row('Speed FOV', chk('fovKick'), 'The view widens as you go faster.') +
          row('Camera shake', chk('shake'), 'Impacts, kerbs, rough ground, high speed.') +
          row('Units', sel('units', [['kmh', 'km/h'], ['mph', 'mph']])) +
          row('Name tags', chk('tags')) +
          row('Minimap', chk('minimap')) +
          row('Control hints', chk('hints'), 'The key reminder on the starting grid.') +
          row('HUD size', rng('hudScale', 70, 130, 5, '%'), 'On top of the automatic fit to your screen.') +
          row('Menu size', rng('uiScale', 80, 130, 5, '%'), 'Menus and pop-ups, on top of the automatic fit.');
      }
      return `<div class="ov-card settings"><div class="ov-head"><button class="btn small ghost" data-oact="back">←</button><h1>SETTINGS</h1><div class="ov-tabs">${TABS.map(([k, l]) => `<button class="${this.tab === k ? 'on' : ''}" data-oact="stab" data-t="${k}">${l}</button>`).join('')}</div></div><div class="ov-body">${body}</div></div>`;
    },

    act(a, el) {
      const A = G.App;
      if (a === 'resume') return this.hide();
      if (a === 'restart') {
        this.hide();
        return A.restartDrive();
      }
      if (a === 'garage') {
        this.hide();
        if (A.mode === 'drive') A.endDrive(true);
        return A.openGarage();
      }
      if (a === 'car' || a === 'paint') {
        this.hide();
        return A.openCarTab(a === 'paint' ? 'paint' : 'car');
      }
      if (a === 'settings' || a === 'controls') {
        this.view = 'settings';
        this.tab = a === 'controls' ? 'controls' : this.tab === 'controls' ? 'graphics' : this.tab;
        return this.render();
      }
      if (a === 'stab') {
        if (G.Chat && G.Chat.Talk) G.Chat.Talk.stopTest();
        this.tab = el.dataset.t;
        return this.render();
      }
      if (a === 'stttest') {
        const T = G.Chat && G.Chat.Talk;
        if (!T) return;
        if (T.test) T.stopTest();
        else T.startTest();
        return setTimeout(() => this.render(), 60);
      }
      if (a === 'back') {
        if (G.Chat && G.Chat.Talk) G.Chat.Talk.stopTest();
        if (this.fromPause) {
          this.view = 'pause';
          return this.render();
        }
        return this.hide();
      }
      if (a === 'fullscreen') {
        fullscreen();
        return;
      }
      if (a === 'leaveDrive') {
        this.hide();
        return A.endDrive();
      }
      if (a === 'mainMenu') {
        this.hide();
        if (A.mode === 'drive') A.endDrive(true);
        return A.showMenu();
      }
      if (a === 'roomVis' || a === 'roomMax' || a === 'roomBots') {
        const s = G.Client.state && G.Client.state.settings;
        if (!s) return;
        if (a === 'roomVis') G.Client.act({ t: 'settings', vis: s.vis === 'public' ? 'private' : 'public' });
        if (a === 'roomMax') G.Client.act({ t: 'settings', maxPlayers: (s.maxPlayers || 8) >= 8 ? 2 : (s.maxPlayers || 8) + 1 });
        if (a === 'roomBots') G.Client.act({ t: 'settings', bots: (s.bots + 1) % 8 });
        return setTimeout(() => this.render(), 60);
      }
      if (a === 'leaveSession') {
        const host = G.Game.role === 'host';
        const st = G.Client.state;
        const heir = host && st && (st.heirs || [])[0] && st.players[st.heirs[0]];
        const body = !host ? 'Your seat, car and money are kept for a while — use <b>Rejoin</b> on the main menu to come back.' : heir ? `<b>${U.esc(heir.name)}</b> takes over as host and the room carries on without you. Nothing is saved on this computer.` : 'Nobody else is here, so the room closes. Nothing is saved.';
        UI.confirm(host ? 'Leave your room?' : 'Leave the session?', body, host ? (heir ? 'Hand over & leave' : 'Close room') : 'Leave', true).then((ok) => {
          if (!ok) return;
          this.hide();
          G.Game.leave();
        });
        return;
      }
      if (a === 'bind') {
        const action = el.dataset.a;
        this.capturing = action;
        this.render();
        G.Input.captureNext((code) => {
          if (code) S().setKey(action, code);
          this.capturing = null;
          this.render();
        });
        return;
      }
      if (a === 'resetKeys') {
        S().resetKeys();
        return this.render();
      }
      if (a === 'testsnd') {
        if (!G.Audio.enabled) G.Audio.setEnabled(true);
        G.Audio.buy();
        setTimeout(() => G.Audio.countdown(1), 350);
        setTimeout(() => G.Audio.go(), 800);
        this.render();
      }
    },
  };

  G.Overlay = Overlay;
})(window.G);
