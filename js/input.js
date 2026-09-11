// input.js — keyboard (rebindable) + gamepad. Produces the raw control state
// that is sent to the host. Arrow keys always work as a second binding.
'use strict';
(function (G) {
  const keys = {};
  const pressed = {}; // edge-triggered this frame
  const typing = () => {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  };
  let capture = null; // key-rebind callback (settings screen)
  window.addEventListener('keydown', (e) => {
    if (capture) {
      e.preventDefault();
      e.stopImmediatePropagation(); // the key is being bound — nobody else acts on it
      const cb = capture;
      capture = null;
      cb(e.key === 'Escape' || e.code === 'Escape' || !e.code ? null : e.code);
      return;
    }
    if (typing()) return;
    if (!e.code) return; // synthetic / IME events without a physical key
    if (!keys[e.code]) pressed[e.code] = true;
    keys[e.code] = true;
    const K = G.Settings ? G.Settings.s.keys : {};
    // stop the page scrolling / focus jumping while driving
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(e.code) || e.code === K.hb) {
      const t = e.target;
      if (!(t && (t.tagName === 'BUTTON' || t.tagName === 'SELECT') && e.code === 'Space')) e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });
  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
  });

  let padPrev = {};
  let kbSteer = 0, lastRead = 0;
  const RATE = { slow: 0.7, normal: 1, fast: 1.45 };
  const Input = {
    keys,
    // is the key for `action` held? (bound key or its arrow-key twin)
    down(action) {
      const K = G.Settings.s.keys;
      const alt = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }[action];
      return !!(keys[K[action]] || (alt && keys[alt]));
    },
    // Drive controls. Returns {s,t,b,hb}. Call ONCE per frame.
    read() {
      const now = performance.now();
      const dt = Math.min(0.1, lastRead ? (now - lastRead) / 1000 : 0);
      lastRead = now;
      let s = 0, t = 0, b = 0, hb = 0, n = 0, kb = 0;
      if (!typing() && !Input.blocked) {
        if (this.down('left')) kb -= 1;
        if (this.down('right')) kb += 1;
        if (this.down('up')) t = 1;
        if (this.down('down')) b = 1;
        if (this.down('hb')) hb = 1;
        if (this.down('nitro')) n = 1;
      }
      // on-screen touch buttons (ui/touch.js) behave exactly like keys
      const T = G.Touch && G.Touch.visible ? G.Touch.state : null;
      if (T && !Input.blocked) {
        if (T.l) kb -= 1;
        if (T.r) kb += 1;
        if (T.t) t = 1;
        if (T.b) b = 1;
        if (T.hb) hb = 1;
        if (T.n) n = 1;
      }
      // Keyboard steering ramps in (~0.22 s to full lock) and snaps back
      // faster, so a TAP gives a partial steer. With instant full lock,
      // keyboard players could only saw between 0 and 100% and ran wide
      // everywhere (a binary-input test driver spent ~35% of each lap with two
      // wheels off the road). The ramped value is what gets sent to the host,
      // so host and client prediction see identical inputs.
      const rm = RATE[G.Settings.s.steerSpeed] || 1;
      const rate = (kb === 0 || Math.sign(kb) !== Math.sign(kbSteer) ? 7 : 4.5) * rm;
      kbSteer += Math.max(-rate * dt, Math.min(rate * dt, kb - kbSteer));
      if (kb === 0 && Math.abs(kbSteer) < 0.02) kbSteer = 0;
      s = kbSteer;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) {
        if (!p || !p.connected) continue;
        const ax = p.axes[0] || 0;
        if (Math.abs(ax) > 0.12) s = Math.sign(ax) * Math.min(1, (Math.abs(ax) - 0.12) / 0.8);
        const rt = p.buttons[7] ? p.buttons[7].value : 0;
        const lt = p.buttons[6] ? p.buttons[6].value : 0;
        if (rt > 0.05) t = Math.max(t, rt);
        if (lt > 0.05) b = Math.max(b, lt);
        if (p.buttons[0] && p.buttons[0].pressed) hb = 1;
        if ((p.buttons[2] && p.buttons[2].pressed) || (p.buttons[4] && p.buttons[4].pressed)) n = 1; // X or LB: nitrous
        const K = G.Settings.s.keys;
        if (p.buttons[3] && p.buttons[3].pressed && !padPrev.y) pressed[K.reset] = true;
        if (p.buttons[5] && p.buttons[5].pressed && !padPrev.rb) pressed[K.cam] = true;
        padPrev = { y: p.buttons[3] && p.buttons[3].pressed, rb: p.buttons[5] && p.buttons[5].pressed };
        break;
      }
      if (Input.blocked) return { s: 0, t: 0, b: 0, hb: 0, n: 0 };
      return { s, t, b, hb, n };
    },
    // Gamepad Start opens the menu from ANY screen, so it's polled every
    // frame on its own (read() only runs while driving, and must run once per
    // frame because it advances the keyboard steering ramp).
    pollStart() {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      let down = false;
      for (const p of pads) if (p && p.connected && p.buttons[9] && p.buttons[9].pressed) down = true;
      const hit = down && !this._startPrev;
      this._startPrev = down;
      return hit;
    },
    // Edge-triggered: true once per key press.
    hit(code) {
      if (pressed[code]) {
        pressed[code] = false;
        return true;
      }
      return false;
    },
    // Simulate a key tap (touch buttons).
    press(code) {
      pressed[code] = true;
    },
    // Edge-triggered for a bindable action ('reset', 'cam').
    hitAction(action) {
      return this.hit(G.Settings.s.keys[action]);
    },
    endFrame() {
      for (const k in pressed) pressed[k] = false;
    },
    // Settings screen: the next key press is handed to cb (null = cancelled).
    captureNext(cb) {
      capture = cb;
    },
    blocked: false, // true while the pause menu is open
  };
  G.Input = Input;
})(window.G);
