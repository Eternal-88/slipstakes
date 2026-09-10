// audio.js — everything synthesised with WebAudio (no audio files to load).
// OFF by default (brief requirement). Toggle in Settings or press M.
// Browsers only allow audio after a user gesture, so the context is created
// lazily on the first click/keypress after sound is enabled.
'use strict';
(function (G) {
  const U = G.U;

  const Audio = {
    enabled: !!U.store.get('ss.sound', false),
    ctx: null,
    eng: null,
    lastBackfire: 0,
    lastCd: null,

    _init() {
      if (this.ctx) return true;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try {
        this.ctx = new AC();
      } catch (e) {
        return false;
      }
      const c = this.ctx;
      this.master = c.createGain();
      this.master.gain.value = 0.55;
      const comp = c.createDynamicsCompressor();
      this.master.connect(comp);
      comp.connect(c.destination);
      // one second of white noise, reused by screech / blow-off / thud
      const buf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
      return true;
    },

    setEnabled(v) {
      this.enabled = !!v;
      U.store.set('ss.sound', this.enabled);
      if (this.enabled) {
        if (this._init() && this.ctx.state === 'suspended') this.ctx.resume();
      } else if (this.ctx) {
        this._stopEngine();
        this.ctx.suspend();
      }
    },

    toggle() {
      this.setEnabled(!this.enabled);
      if (G.UI) G.UI.toast(this.enabled ? '🔊 Sound on (M to mute)' : '🔇 Sound off', 'info');
    },

    ok() {
      if (!this.enabled) return false;
      if (!this._init()) return false;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    },

    // ---- continuous voices for the player's own car -----------------------
    _startEngine() {
      const c = this.ctx;
      const e = {};
      e.o1 = c.createOscillator();
      e.o1.type = 'sawtooth';
      e.o2 = c.createOscillator();
      e.o2.type = 'square';
      e.f = c.createBiquadFilter();
      e.f.type = 'lowpass';
      e.f.Q.value = 3;
      e.g = c.createGain();
      e.g.gain.value = 0;
      e.o1.connect(e.f);
      e.o2.connect(e.f);
      e.f.connect(e.g);
      e.g.connect(this.master);
      // turbo whistle
      e.w = c.createOscillator();
      e.w.type = 'sine';
      e.wg = c.createGain();
      e.wg.gain.value = 0;
      e.w.connect(e.wg);
      e.wg.connect(this.master);
      // tyre screech: band-passed noise
      e.n = c.createBufferSource();
      e.n.buffer = this.noise;
      e.n.loop = true;
      e.nf = c.createBiquadFilter();
      e.nf.type = 'bandpass';
      e.nf.frequency.value = 1100;
      e.nf.Q.value = 6;
      e.ng = c.createGain();
      e.ng.gain.value = 0;
      e.n.connect(e.nf);
      e.nf.connect(e.ng);
      e.ng.connect(this.master);
      e.o1.start();
      e.o2.start();
      e.w.start();
      e.n.start();
      this.eng = e;
    },
    _stopEngine() {
      const e = this.eng;
      if (!e) return;
      for (const n of [e.o1, e.o2, e.w, e.n]) {
        try {
          n.stop();
        } catch (x) {}
      }
      this.eng = null;
    },

    // Called every frame with the player's car render state (or null).
    update(rs, dt) {
      if (!rs || !this.ok()) {
        if (this.eng && this.ctx) {
          const t = this.ctx.currentTime;
          this.eng.g.gain.setTargetAtTime(0, t, 0.1);
          this.eng.wg.gain.setTargetAtTime(0, t, 0.1);
          this.eng.ng.gain.setTargetAtTime(0, t, 0.05);
        }
        return;
      }
      if (!this.eng) this._startEngine();
      const e = this.eng, t = this.ctx.currentTime;
      const rpm = U.clamp(rs.rpm || 0.14, 0.1, 1.05);
      const f = 38 + rpm * 190; // fundamental, Hz
      e.o1.frequency.setTargetAtTime(f, t, 0.03);
      e.o2.frequency.setTargetAtTime(f * 0.5, t, 0.03);
      const thr = rs.thr != null ? rs.thr : 0.5;
      e.f.frequency.setTargetAtTime(300 + rpm * 1400 + thr * 900, t, 0.05);
      e.g.gain.setTargetAtTime(0.045 + thr * 0.06, t, 0.05);
      const b = rs.boost || 0;
      e.w.frequency.setTargetAtTime(1600 + b * 2600, t, 0.08);
      e.wg.gain.setTargetAtTime(b * 0.02, t, 0.08);
      let slip = 0;
      if (rs.slip) for (let i = 0; i < 4; i++) {
        const sf = G.SURF[rs.surf[i] || 0];
        if (sf && (sf.fx === 'smoke' || sf.fx === 'spray')) slip = Math.max(slip, rs.slip[i]);
      }
      e.ng.gain.setTargetAtTime(Math.max(0, slip - 0.25) * 0.22, t, 0.04);
      if (rs.backfire > 0 && !this.lastBackfire) this.pop();
      this.lastBackfire = rs.backfire > 0 ? 1 : 0;
    },

    // ---- one-shots --------------------------------------------------------
    tone(freq, dur, type, vol, slide) {
      if (!this.ok()) return;
      const c = this.ctx, t = c.currentTime;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(vol || 0.12, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(this.master);
      o.start(t);
      o.stop(t + dur + 0.02);
    },
    noiseHit(dur, freq, vol, type) {
      if (!this.ok()) return;
      const c = this.ctx, t = c.currentTime;
      const s = c.createBufferSource();
      s.buffer = this.noise;
      const f = c.createBiquadFilter();
      f.type = type || 'lowpass';
      f.frequency.value = freq;
      const g = c.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f);
      f.connect(g);
      g.connect(this.master);
      s.start(t, Math.random() * 0.5);
      s.stop(t + dur + 0.02);
    },
    beep(freq, dur) {
      this.tone(freq || 440, dur || 0.18, 'square', 0.1);
    },
    countdown(n) {
      if (n > 0) this.beep(520, 0.16);
      else this.beep(1040, 0.4);
    },
    thud(k) {
      this.noiseHit(0.25, 180, 0.5 * (0.4 + (k || 0.5)));
      this.tone(70, 0.2, 'sine', 0.3 * (k || 0.5), 40);
    },
    pop() {
      this.noiseHit(0.08, 900, 0.35, 'bandpass');
    },
    blowoff() {
      this.noiseHit(0.35, 2500, 0.15, 'highpass');
    },
    click() {
      this.tone(1400, 0.04, 'square', 0.05);
    },
    chip() {
      this.tone(2300, 0.05, 'triangle', 0.07);
      setTimeout(() => this.tone(2800, 0.04, 'triangle', 0.05), 45);
    },
    card() {
      this.noiseHit(0.06, 3000, 0.12, 'highpass');
    },
    win() {
      [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.18, 'square', 0.08), i * 90));
    },
    lose() {
      [392, 330, 262].forEach((f, i) => setTimeout(() => this.tone(f, 0.22, 'sawtooth', 0.06), i * 120));
    },
  };

  // Unlock on the first gesture if sound was left enabled last time.
  const unlock = () => {
    if (Audio.enabled) Audio.ok();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  G.Audio = Audio;
})(window.G);
