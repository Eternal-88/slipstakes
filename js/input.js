// input.js — keyboard + gamepad. Produces the raw control state that is sent to
// the host (steer is digital on keyboard; the physics rate-limits it, so host
// and client prediction smooth it identically).
'use strict';
(function (G) {
  const keys = {};
  const pressed = {}; // edge-triggered this frame
  const typing = () => {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  };
  window.addEventListener('keydown', (e) => {
    if (typing()) return;
    if (!keys[e.code]) pressed[e.code] = true;
    keys[e.code] = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });
  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
  });

  let padPrev = {};
  let kbSteer = 0, lastRead = 0;
  const Input = {
    keys,
    // Drive controls. Returns {s,t,b,hb}. Call ONCE per frame.
    read() {
      const now = performance.now();
      const dt = Math.min(0.1, lastRead ? (now - lastRead) / 1000 : 0);
      lastRead = now;
      let s = 0, t = 0, b = 0, hb = 0, kb = 0;
      if (!typing()) {
        if (keys.KeyA || keys.ArrowLeft) kb -= 1;
        if (keys.KeyD || keys.ArrowRight) kb += 1;
        if (keys.KeyW || keys.ArrowUp) t = 1;
        if (keys.KeyS || keys.ArrowDown) b = 1;
        if (keys.Space) hb = 1;
      }
      // Keyboard steering ramps in (~0.22 s to full lock) and snaps back
      // faster, so a TAP gives a partial steer. With instant full lock,
      // keyboard players could only saw between 0 and 100% and ran wide
      // everywhere (a binary-input test driver spent ~35% of each lap with two
      // wheels off the road). The ramped value is what gets sent to the host,
      // so host and client prediction see identical inputs.
      const rate = kb === 0 || Math.sign(kb) !== Math.sign(kbSteer) ? 7 : 4.5;
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
        if (p.buttons[3] && p.buttons[3].pressed && !padPrev.y) pressed.KeyR = true;
        if (p.buttons[5] && p.buttons[5].pressed && !padPrev.rb) pressed.KeyC = true;
        padPrev = { y: p.buttons[3] && p.buttons[3].pressed, rb: p.buttons[5] && p.buttons[5].pressed };
        break;
      }
      return { s, t, b, hb };
    },
    // Edge-triggered: true once per key press.
    hit(code) {
      if (pressed[code]) {
        pressed[code] = false;
        return true;
      }
      return false;
    },
    endFrame() {
      for (const k in pressed) pressed[k] = false;
    },
  };
  G.Input = Input;
})(window.G);
