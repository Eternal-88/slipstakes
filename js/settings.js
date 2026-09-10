// settings.js — player preferences (localStorage 'ss.settings') with defaults
// and change listeners. Comfort / cosmetic only: nothing here can touch the
// simulation, so settings never need to be synced between players.
'use strict';
(function (G) {
  const U = G.U;

  const DEF = {
    // graphics
    quality: 'auto', // auto | high | medium | low  (antialiasing needs a reload)
    resScale: 100, // % of the quality tier's pixel ratio
    shadows: true,
    particles: 'high', // low | medium | high
    scenery: 'auto', // auto | high | medium | low  (prop density, next track load; auto follows the GPU tier)
    weather: true, // rain on wet tracks, drifting clouds
    showFps: false,
    // audio
    sound: false, // the original brief: OFF until the player turns it on
    vMaster: 80, vEngine: 80, vOthers: 70, vSfx: 85, vUi: 60, vMusic: 45,
    raceMusic: false,
    // camera / HUD
    cam: 'follow', // follow | near | far | fixed
    fovKick: true,
    shake: true,
    units: 'kmh', // kmh | mph
    tags: true,
    minimap: true,
    hudScale: 100,
    hints: true,
    // controls
    steerSpeed: 'normal', // slow | normal | fast (keyboard steering ramp)
    touch: 'auto', // auto (after the first screen touch) | on | off
    botLevel: 'normal', // easy | normal | hard (single-player bots)
    keys: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', hb: 'Space', reset: 'KeyR', cam: 'KeyC' },
  };
  const KEY_LABELS = { up: 'Throttle', down: 'Brake / reverse', left: 'Steer left', right: 'Steer right', hb: 'Handbrake', reset: 'Reset car', cam: 'Change camera' };

  const saved = U.store.get('ss.settings', null) || {};
  const s = Object.assign({}, DEF, saved);
  s.keys = Object.assign({}, DEF.keys, saved.keys || {});
  // one-time migration of the pre-settings keys
  if (!saved.quality && U.store.get('ss.quality', null)) s.quality = U.store.get('ss.quality');
  if (saved.sound == null && U.store.get('ss.sound', null) != null) s.sound = !!U.store.get('ss.sound');
  if (!saved.cam && U.store.get('ss.cam', null)) s.cam = U.store.get('ss.cam');

  const subs = [];
  const Settings = {
    DEF, KEY_LABELS, s,
    get(k) {
      return s[k];
    },
    set(k, v) {
      if (s[k] === v) return;
      s[k] = v;
      U.store.set('ss.settings', s);
      for (const f of subs) {
        try {
          f(k, v);
        } catch (e) {
          console.warn('[settings] listener failed', e);
        }
      }
    },
    setKey(action, code) {
      // a key can only do one thing: swap with whatever had it
      for (const a in s.keys) if (s.keys[a] === code && a !== action) s.keys[a] = s.keys[action];
      s.keys[action] = code;
      U.store.set('ss.settings', s);
      subs.forEach((f) => f('keys', s.keys));
    },
    resetKeys() {
      s.keys = Object.assign({}, DEF.keys);
      U.store.set('ss.settings', s);
      subs.forEach((f) => f('keys', s.keys));
    },
    on(fn) {
      subs.push(fn);
    },
    // "KeyW" -> "W", "ArrowUp" -> "↑", "Space" -> "Space"
    keyName(code) {
      if (!code) return '—';
      if (code.startsWith('Key')) return code.slice(3);
      if (code.startsWith('Digit')) return code.slice(5);
      return { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', Enter: 'Enter', Backspace: 'Backspace' }[code] || code;
    },
    speed(ms) {
      return s.units === 'mph' ? ms * 2.23694 : ms * 3.6;
    },
    unit() {
      return s.units === 'mph' ? 'mph' : 'km/h';
    },
  };

  G.Settings = Settings;
})(window.G);
