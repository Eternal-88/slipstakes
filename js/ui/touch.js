// touch.js — on-screen driving buttons for touchscreen Chromebooks / tablets.
// ◀ ▶ bottom-left, GAS / BRAKE / HANDBRAKE bottom-right, reset + camera
// above the steering buttons. They feed input.js exactly like held keys
// (steering still ramps), so the netcode sees the same kind of input.
// Shown while driving when Settings → Touch controls is "on", or "auto" and
// the screen has been touched at least once.
'use strict';
(function (G) {
  const Touch = {
    seen: false,
    visible: false,
    state: { l: 0, r: 0, t: 0, b: 0, hb: 0, n: 0 },

    init() {
      this.root = document.getElementById('touch');
      this.root.innerHTML = `
        <div class="tc-top"><button data-t="rs" title="Reset car">↺</button><button data-t="cam" title="Camera">🎥</button></div>
        <div class="tc-left"><button data-t="l">◀</button><button data-t="r">▶</button></div>
        <div class="tc-right"><button data-t="n" class="nos">N2O</button><button data-t="hb" class="hb">HAND<br>BRAKE</button><button data-t="b" class="br">BRAKE</button><button data-t="t" class="gas">GAS</button></div>`;
      const set = (e, v) => {
        const b = e.target.closest && e.target.closest('[data-t]');
        if (!b) return;
        e.preventDefault();
        const k = b.dataset.t;
        if (k in this.state) {
          this.state[k] = v;
          b.classList.toggle('on', !!v);
        } else if (v) {
          const K = G.Settings.s.keys;
          G.Input.press(k === 'rs' ? K.reset : K.cam);
        }
      };
      this.root.addEventListener('pointerdown', (e) => {
        set(e, 1);
        const b = e.target.closest && e.target.closest('[data-t]');
        if (b && b.setPointerCapture) {
          try {
            b.setPointerCapture(e.pointerId);
          } catch (x) {}
        }
      });
      const up = (e) => set(e, 0);
      this.root.addEventListener('pointerup', up);
      this.root.addEventListener('pointercancel', up);
      this.root.addEventListener('lostpointercapture', up);
      this.root.addEventListener('contextmenu', (e) => e.preventDefault());
      window.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch') this.seen = true;
      }, true);
    },

    update(driving) {
      const m = G.Settings.s.touch;
      const on = !!driving && !G.Overlay.isOpen && (m === 'on' || (m === 'auto' && this.seen));
      if (on === this.visible) return;
      this.visible = on;
      this.root.style.display = on ? '' : 'none';
      document.body.classList.toggle('touchui', on);
      if (!on) {
        for (const k in this.state) this.state[k] = 0;
        this.root.querySelectorAll('.on').forEach((b) => b.classList.remove('on'));
      }
    },
  };
  G.Touch = Touch;
})(window.G);
