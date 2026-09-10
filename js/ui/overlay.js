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
  const TABS = [['graphics', '🖥 Graphics'], ['audio', '🔊 Audio'], ['controls', '⌨ Controls'], ['camera', '🎥 Camera & HUD']];

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
      this.corner.innerHTML = `<button data-c="menu" title="Menu (Esc)">☰</button><button data-c="sound" class="${snd ? '' : 'off'}" title="Sound on/off (M)">${snd ? '🔊' : '🔇'}</button><button data-c="fs" title="Fullscreen">${fs ? '🗗' : '⛶'}</button>`;
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
      if (sess) btns += b('leaveSession', G.Game.role === 'host' ? '✖ Close room & leave' : '✖ Leave session', 'red');
      if (!sess && mode !== 'menu') btns += b('mainMenu', '⌂ Main menu', 'ghost');
      return `<div class="ov-card pause"><h1>${title}</h1>${sub ? `<p class="muted">${U.esc(sub)}</p>` : ''}<div class="ov-btns">${btns}</div><p class="muted small ov-foot">Esc closes · M sound · F3 frame-rate</p></div>`;
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
          row('Engines', rng('vEngine', 0, 100, 5, '%')) +
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
          `<div class="ov-row"><label></label><div class="ov-ctl"><button class="btn small ghost" data-oact="resetKeys">Reset keys to default</button></div></div>` +
          `<p class="muted small">Fixed keys: <b>Esc</b> menu · <b>M</b> sound · <b>F3</b> fps · spectating: <b>1–8</b>/<b>Tab</b> follow a car, <b>WASD Q E</b> free camera, mouse wheel zoom.<br>Gamepad: left stick steer · RT throttle · LT brake · A handbrake · Y reset · RB camera · Start menu.</p>`;
      } else {
        body =
          row('Camera', sel('cam', [['follow', 'Chase'], ['near', 'Close chase'], ['far', 'High chase'], ['fixed', 'Fixed north']]), `Also the ${S().keyName(s.keys.cam)} key while driving.`) +
          row('Speed FOV', chk('fovKick'), 'The view widens as you go faster.') +
          row('Camera shake', chk('shake'), 'Impacts, kerbs, rough ground, high speed.') +
          row('Units', sel('units', [['kmh', 'km/h'], ['mph', 'mph']])) +
          row('Name tags', chk('tags')) +
          row('Minimap', chk('minimap')) +
          row('Control hints', chk('hints'), 'The key reminder on the starting grid.') +
          row('HUD size', rng('hudScale', 80, 120, 5, '%'));
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
        this.tab = el.dataset.t;
        return this.render();
      }
      if (a === 'back') {
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
      if (a === 'leaveSession') {
        const host = G.Game.role === 'host';
        UI.confirm(host ? 'Close the room?' : 'Leave the session?', host ? 'Everyone in the room is disconnected. The session is autosaved — you can reopen it from the main menu with <b>Resume hosted session</b>.' : 'Your seat, car and money are kept for a while — use <b>Rejoin</b> on the main menu to come back.', host ? 'Close room' : 'Leave', true).then((ok) => {
          if (!ok) return;
          this.hide();
          if (host && G.Game.session) G.Game._save && G.Game._save();
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
