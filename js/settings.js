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
    sound: true, // v4.4: on by default (browsers still wait for your first click or key)
    vMaster: 80, vEngine: 80, vOthers: 70, vSfx: 85, vUi: 60, vMusic: 58,
    raceMusic: true, // v5: proper race songs now (race / night / rally / endurance)
    // camera / HUD
    cam: 'follow', // follow | near | far | fixed
    fovKick: true,
    shake: true,
    units: 'kmh', // kmh | mph
    tags: true,
    minimap: true,
    hudScale: 100,
    uiScale: 100, // v4.5: menu size, on top of the automatic fit to the screen
    hints: true,
    // controls
    steerSpeed: 'normal', // slow | normal | fast (keyboard steering ramp)
    touch: 'auto', // auto (after the first screen touch) | on | off
    botLevel: 'normal', // rookie | easy | normal | hard | pro | legend (single-player bots; bot.js LEVELS)
    catchup: 'mild', // off | mild | wild (single-player quick races; the host picks for multiplayer)
    raceWeather: 'auto', // v5 auto (sometimes a shower mid-race) | dry | rain (single-player quick races)
    keys: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', hb: 'Space', nitro: 'ShiftLeft', reset: 'KeyR', cam: 'KeyC', horn: 'KeyH' },
  };
  const KEY_LABELS = { up: 'Throttle', down: 'Brake / reverse', left: 'Steer left', right: 'Steer right', hb: 'Handbrake', nitro: 'Nitrous', reset: 'Reset car', cam: 'Change camera', horn: 'Horn' };
  // Catch-up strength per setting: the most extra power a car far behind gets.
  const CATCHUP = { off: 0, mild: 0.1, wild: 0.25 };

  const saved = U.store.get('ss.settings', null) || {};
  const s = Object.assign({}, DEF, saved);
  s.keys = Object.assign({}, DEF.keys, saved.keys || {});
  // one-time migration of the pre-settings keys
  if (!saved.quality && U.store.get('ss.quality', null)) s.quality = U.store.get('ss.quality');
  if (saved.sound == null && U.store.get('ss.sound', null) != null) s.sound = !!U.store.get('ss.sound');
  if (!saved.cam && U.store.get('ss.cam', null)) s.cam = U.store.get('ss.cam');
  // v4.4: sound on by default. Switch it on once for everyone (a saved "off"
  // was just the old default for most players); after that their choice sticks.
  if (!saved.sound44) {
    s.sound = true;
    s.sound44 = true;
    U.store.set('ss.settings', s);
  }

  // v5.1: the music was mixed too low to hear under the engines (and the
  // saved settings of anyone who had played before pinned it there). Lift a
  // level that is still the old default to the new one, once. Anyone who
  // chose a different number keeps their choice.
  if (!saved.music51) {
    if (s.vMusic === 45) s.vMusic = DEF.vMusic;
    s.music51 = true;
    U.store.set('ss.settings', s);
  }

  const subs = [];
  const Settings = {
    DEF, KEY_LABELS, CATCHUP, s,
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
