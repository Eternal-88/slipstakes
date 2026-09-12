// audio.js — every sound is synthesised with WebAudio: no audio files to load
// (works offline from file://, nothing extra for a school filter to block).
//
// OFF by default (original brief) — the player turns it on with the 🔊
// button, Settings, or M. Browsers only allow audio after a user gesture, so
// the context is created lazily on the first click / key press.
//
// Mix: four buses (engine, sfx, ui, music) -> master -> compressor -> out,
// each with its own volume slider in Settings.
//
// Voices
//   own car   : 3-oscillator engine (fundamental = firing frequency, so a V8
//               and a four-cylinder at the same rpm sound different), a
//               waveshaper for rasp, rpm/throttle-tracking lowpass, V8 lope
//               LFO, rev-limiter stutter, shift dips, turbo whistle + blow-off,
//               supercharger whine, overrun crackle on free-flowing exhausts.
//   surfaces  : one looping noise source feeding filters for tyre screech,
//               road roar, gravel crunch, grass swish, wet hiss, wind, kerb
//               rumble and wall scrape.
//   others    : the two nearest other cars get a cheap engine voice, panned
//               and attenuated from the camera.
//   one-shots : impacts, countdown, laps, finish, UI clicks, casino, crowd.
//   music     : a tiny step sequencer (menu / garage / final tracks).
'use strict';
(function (G) {
  const U = G.U;
  const S = () => G.Settings.s;

  // Engine character per chassis. cyl sets the firing frequency; lope =
  // uneven-firing amplitude wobble (the V8 burble); rasp = distortion.
  //   vandal: smooth straight-six — clean, little rasp, strong 2nd harmonic
  //   brick : rally four — gravelly distortion, boxer-style burble (lope at f0/2)
  //   sting : high-revving four — thin, bright, screams at the top
  //   mule  : V8 — deep sub, heavy lumpy lope, dark filter
  const PROFILES = {
    vandal: { cyl: 6, cut: 1.05, rasp: 1.6, lope: 0.04, lopeDiv: 4, sub: 0.45, h2: 0.45 },
    brick: { cyl: 4, cut: 1.15, rasp: 7.5, lope: 0.3, lopeDiv: 2, sub: 0.35, h2: 0.3 },
    sting: { cyl: 4, cut: 1.7, rasp: 4.5, lope: 0.0, lopeDiv: 4, sub: 0.16, h2: 0.8 },
    mule: { cyl: 8, cut: 0.68, rasp: 2.4, lope: 0.62, lopeDiv: 4, sub: 1.15, h2: 0.18 },
    // v4: truck = low, gruff, lumpy V6; Apex = high, clean flat-six shriek
    dune: { cyl: 6, cut: 0.72, rasp: 3.4, lope: 0.24, lopeDiv: 3, sub: 0.95, h2: 0.22 },
    apex: { cyl: 6, cut: 2.0, rasp: 3.6, lope: 0.02, lopeDiv: 4, sub: 0.18, h2: 0.95 },
  };
  const vol = (v) => Math.pow(U.clamp(v, 0, 100) / 100, 1.6);

  // v4: how performance mods colour the sound. One place, used by your own
  // engine AND other cars' voices, so a friend's straight-piped Mule sounds
  // like one as it passes.
  //   exhaust : stock is muffled and smooth; sport is throatier with a
  //             resonant drone; a straight pipe is raw, loud and burbly
  //   ecu     : remaps harden the note; Stage 2 pops on lift
  //   weight  : stripped cars lose their sound deadening (engine + road louder)
  //   gearing : a sequential box has straight-cut gear whine
  //   aero    : wings roar in the wind; brakes: race pads squeal near a stop
  function modSound(parts) {
    const p = Object.assign({}, G.Parts.STOCK, parts || {});
    const ex = { stock: { loud: 1, rasp: 0.8, q: 1.2, cut: 0.85, drone: 0, sub: 1, lope: 1 }, sport: { loud: 1.15, rasp: 1.25, q: 2.2, cut: 1, drone: 0.35, sub: 1.1, lope: 1.1 }, straight: { loud: 1.4, rasp: 1.8, q: 3.2, cut: 1.15, drone: 0.2, sub: 1.3, lope: 1.35 } }[p.exhaust] || { loud: 1, rasp: 1, q: 1.6, cut: 1, drone: 0, sub: 1, lope: 1 };
    const ecu = p.ecu === 'stage2' ? 1.18 : p.ecu === 'stage1' ? 1.08 : 1;
    const strip = { w1: 1.08, w2: 1.15, w3: 1.22 }[p.weight] || 1;
    return {
      loud: ex.loud * strip, rasp: ex.rasp * ecu, q: ex.q, cut: ex.cut, drone: ex.drone, sub: ex.sub, lope: ex.lope,
      road: { w1: 1.3, w2: 1.6, w3: 2 }[p.weight] || 1,
      pops: Math.max(G.Parts.opt('exhaust', p.exhaust).pops || 0, p.ecu === 'stage2' ? 0.5 : 0),
      limHard: p.ecu === 'stage2', // harsher limiter bounce
      whine: p.gearing === 'seq' ? 0.014 : p.gearing === 'short' ? 0.006 : 0,
      wind: p.aero === 'a3' ? 1.7 : p.aero === 'a2' ? 1.35 : 1,
      squeal: p.brakes === 'carbon' ? 0.05 : p.brakes === 'sport' ? 0.03 : 0,
      screech: p.compound === 'soft' ? 120 : p.compound === 'medium' ? 50 : 0,
      kerb: p.suspension === 'race' ? 1.45 : p.suspension === 'rally' ? 0.7 : 1,
    };
  }
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function shaperCurve(k) {
    const n = 512, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return c;
  }

  const Audio = {
    enabled: false,
    ctx: null,
    eng: null,
    env: null,
    others: [],
    _fed: false,
    _lastGear: 1,
    _lastBoost: 0,
    _lastThr: 0,
    _hoverT: 0,
    _limT: 0,

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
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp);
      comp.connect(c.destination);
      this.bus = {};
      for (const k of ['engine', 'others', 'sfx', 'ui', 'music']) {
        this.bus[k] = c.createGain();
        this.bus[k].connect(this.master);
      }
      // two seconds of white noise, shared by every noisy voice
      const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
      this.applyVolumes();
      return true;
    },

    applyVolumes() {
      if (!this.ctx) return;
      const s = S();
      const t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(vol(s.vMaster) * 0.9, t, 0.05);
      this.bus.engine.gain.setTargetAtTime(vol(s.vEngine), t, 0.05);
      this.bus.others.gain.setTargetAtTime(vol(s.vOthers == null ? 70 : s.vOthers), t, 0.05);
      this.bus.sfx.gain.setTargetAtTime(vol(s.vSfx), t, 0.05);
      this.bus.ui.gain.setTargetAtTime(vol(s.vUi), t, 0.05);
      this.bus.music.gain.setTargetAtTime(vol(s.vMusic) * 0.55, t, 0.05);
    },

    setEnabled(v) {
      this.enabled = !!v;
      if (G.Settings.s.sound !== this.enabled) G.Settings.set('sound', this.enabled);
      if (this.enabled) {
        if (this._init() && this.ctx.state === 'suspended') this.ctx.resume();
      } else if (this.ctx) {
        this._stopEngine();
        Music.stop();
        this.ctx.suspend();
      }
    },

    toggle() {
      this.setEnabled(!this.enabled);
      if (G.UI) G.UI.toast(this.enabled ? '🔊 Sound on (M to mute)' : '🔇 Sound off (M to unmute)', 'info');
      if (this.enabled) this.good();
    },

    ok() {
      if (!this.enabled) return false;
      if (!this._init()) return false;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    },

    // ------------------------------------------------------------ building
    _osc(type, f) {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.value = f || 100;
      return o;
    },
    _gain(v) {
      const g = this.ctx.createGain();
      g.gain.value = v || 0;
      return g;
    },
    _filt(type, f, q) {
      const b = this.ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q == null ? 1 : q;
      return b;
    },

    _startEngine(prof) {
      const c = this.ctx, E = this.bus.engine, X = this.bus.sfx;
      const e = { prof };
      e.o1 = this._osc('sawtooth');
      e.o2 = this._osc('square');
      e.o3 = this._osc('sawtooth');
      e.o3.detune.value = 9;
      e.g1 = this._gain(0.55);
      e.g2 = this._gain(prof.sub * 0.5);
      e.g3 = this._gain(prof.h2 * 0.5);
      e.mix = this._gain(1);
      e.o1.connect(e.g1).connect(e.mix);
      e.o2.connect(e.g2).connect(e.mix);
      e.o3.connect(e.g3).connect(e.mix);
      e.sh = c.createWaveShaper();
      e.sh.curve = shaperCurve(prof.rasp);
      e.f = this._filt('lowpass', 800, 1.6);
      e.amp = this._gain(0);
      e.mix.connect(e.sh).connect(e.f).connect(e.amp).connect(E);
      // lope: uneven firing -> amplitude wobble at ~1/4 firing frequency
      e.lfo = this._osc('sine', 10);
      e.lfoG = this._gain(0);
      e.lfo.connect(e.lfoG).connect(e.amp.gain);
      // forced induction
      e.tw = this._osc('sine', 2000);
      e.twg = this._gain(0);
      e.tw.connect(e.twg).connect(E);
      // supercharger: two rev-locked gear-whine partials through a nasal bandpass
      e.swf = this._filt('bandpass', 2500, 1.2);
      e.swf.connect(E);
      e.sw = this._osc('triangle', 900);
      e.swg = this._gain(0);
      e.sw.connect(e.swg).connect(e.swf);
      e.sw2 = this._osc('sine', 1800);
      e.sw2g = this._gain(0);
      e.sw2.connect(e.sw2g).connect(e.swf);
      // turbo intake whoosh (high-passed noise, follows boost)
      e.hs = c.createBufferSource();
      e.hs.buffer = this.noise;
      e.hs.loop = true;
      e.hf = this._filt('highpass', 2600, 0.8);
      e.hg = this._gain(0);
      e.hs.connect(e.hf).connect(e.hg).connect(E);
      // v4 mods: exhaust drone (resonant band on the raw mix) and straight-cut
      // gear whine (sequential box)
      e.dr = this._filt('bandpass', 120, 6);
      e.drg = this._gain(0);
      e.mix.connect(e.dr).connect(e.drg).connect(E);
      e.gw = this._osc('triangle', 400);
      e.gwg = this._gain(0);
      e.gw.connect(e.gwg).connect(E);
      e.exKey = null;
      for (const o of [e.o1, e.o2, e.o3, e.lfo, e.tw, e.sw, e.sw2, e.hs, e.gw]) o.start();
      this.eng = e;
      this._startEnv();
    },
    _stopEngine() {
      const e = this.eng;
      if (e) {
        for (const n of [e.o1, e.o2, e.o3, e.lfo, e.tw, e.sw, e.sw2, e.hs, e.gw]) {
          try {
            n.stop();
          } catch (x) {}
        }
        try {
          e.amp.disconnect();
        } catch (x) {}
      }
      this.eng = null;
      this._stopEnv();
      for (const v of this.others) this._killVoice(v);
      this.others = [];
    },

    // Surface / environment voices: one noise source, many filters.
    _startEnv() {
      if (this.env) return;
      const c = this.ctx, X = this.bus.sfx;
      const v = {};
      v.src = c.createBufferSource();
      v.src.buffer = this.noise;
      v.src.loop = true;
      const chain = (type, f, q, out) => {
        const fl = this._filt(type, f, q);
        const g = this._gain(0);
        v.src.connect(fl).connect(g).connect(out || X);
        return { f: fl, g };
      };
      v.scr1 = chain('bandpass', 950, 7);
      v.scr2 = chain('bandpass', 1650, 9);
      v.road = chain('lowpass', 260, 0.7);
      v.loose = chain('bandpass', 620, 0.9);
      v.grass = chain('highpass', 2200, 0.7);
      v.wet = chain('highpass', 3600, 0.7);
      v.wind = chain('bandpass', 520, 0.45);
      v.kerb = chain('lowpass', 170, 1);
      v.scrape = chain('bandpass', 2700, 3);
      v.nos = chain('bandpass', 4600, 0.7); // v4 nitrous hiss
      v.buffet = chain('lowpass', 150, 1.2); // v4 slipstream buffeting
      v.squeal = chain('bandpass', 3300, 18); // v4 race-pad brake squeal
      // kerb rumble: square LFO gating the low thump
      v.kl = this._osc('square', 12);
      v.klg = this._gain(0);
      v.kl.connect(v.klg).connect(v.kerb.g.gain);
      v.src.start();
      v.kl.start();
      this.env = v;
    },
    _stopEnv() {
      const v = this.env;
      if (!v) return;
      try {
        v.src.stop();
        v.kl.stop();
      } catch (e) {}
      this.env = null;
    },

    // Another car: engine (two oscillators, rasp, lowpass) + its own tyre
    // screech, both through a stereo panner into the "others" bus.
    _voice(prof) {
      const v = { prof, id: null };
      v.o1 = this._osc('sawtooth');
      v.o2 = this._osc('square');
      v.o3 = this._osc('sawtooth');
      v.o3.detune.value = 11;
      v.m3 = this._gain(0.3);
      v.f = this._filt('lowpass', 700, 1.4);
      v.g = this._gain(0);
      v.p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      v.o1.connect(v.f);
      v.o2.connect(v.f);
      v.o3.connect(v.m3).connect(v.f);
      v.f.connect(v.g);
      const out = v.p || this.bus.others;
      if (v.p) v.p.connect(this.bus.others);
      v.g.connect(out);
      // screech
      v.n = this.ctx.createBufferSource();
      v.n.buffer = this.noise;
      v.n.loop = true;
      v.nf = this._filt('bandpass', 1100, 6);
      v.ng = this._gain(0);
      v.n.connect(v.nf).connect(v.ng).connect(out);
      // their turbo whistle / supercharger whine
      v.w = this._osc('sine', 2000);
      v.wg = this._gain(0);
      v.w.connect(v.wg).connect(out);
      v.o1.start();
      v.o2.start();
      v.o3.start();
      v.w.start();
      v.n.start(0, Math.random() * 1.5);
      return v;
    },
    _killVoice(v) {
      try {
        v.o1.stop();
        v.o2.stop();
        v.o3.stop();
        v.n.stop();
        v.w.stop();
        v.g.disconnect();
        v.ng.disconnect();
        v.wg.disconnect();
      } catch (e) {}
    },
    // 0..1 loudness for a sound at (x, z) relative to the listener (camera focus).
    near(x, z) {
      if (this._lx == null) return 0.5;
      return 1 / (1 + Math.hypot(x - this._lx, z - this._lz) / 14);
    },

    // ------------------------------------------------------- per frame
    // Own car. rs = render state; meta = {carId, parts, vol}. rs null = silence.
    update(rs, dt, meta) {
      // a garage rev demo owns the engine voice until it ends
      if (this._demoUntil && performance.now() < this._demoUntil && !(meta && meta.demo)) return;
      if (!rs || !this.ok()) {
        if (this.eng && this.ctx) {
          const t = this.ctx.currentTime;
          this.eng.amp.gain.setTargetAtTime(0, t, 0.08);
          this.eng.lfoG.gain.setTargetAtTime(0, t, 0.08);
          this.eng.twg.gain.setTargetAtTime(0, t, 0.08);
          this.eng.swg.gain.setTargetAtTime(0, t, 0.08);
          this.eng.sw2g.gain.setTargetAtTime(0, t, 0.08);
          this.eng.hg.gain.setTargetAtTime(0, t, 0.08);
          this.eng.drg.gain.setTargetAtTime(0, t, 0.08);
          this.eng.gwg.gain.setTargetAtTime(0, t, 0.08);
          if (this.env) for (const k of ['scr1', 'scr2', 'road', 'loose', 'grass', 'wet', 'wind', 'kerb', 'scrape', 'nos', 'buffet', 'squeal']) this.env[k].g.gain.setTargetAtTime(0, t, 0.06);
          this.env && this.env.klg.gain.setTargetAtTime(0, t, 0.06);
        }
        return;
      }
      meta = meta || {};
      const car = G.Parts.CARS[meta.carId] || G.Parts.CARS.vandal;
      const prof = PROFILES[car.id] || PROFILES.vandal;
      if (this.eng && this.eng.prof !== prof) this._stopEngine();
      if (!this.eng) this._startEngine(prof);
      const e = this.eng, t = this.ctx.currentTime;
      const parts = Object.assign({}, G.Parts.STOCK, meta.parts || {});
      const ms = modSound(parts);
      this._ms = ms;
      const master = meta.vol == null ? 1 : meta.vol;
      const rpm = U.clamp(rs.rpm || 0.14, 0.1, 1.05);
      const thr = rs.thr != null ? U.clamp(rs.thr, 0, 1) : 0.5;
      const speed = Math.hypot(rs.vx || 0, rs.vz || 0);
      // exhaust / ECU character: distortion amount (shaper curve, rebuilt only
      // when the parts change), filter resonance, sub and lope
      const exKey = prof.rasp * ms.rasp;
      if (e.exKey !== exKey) {
        e.exKey = exKey;
        e.sh.curve = shaperCurve(exKey);
      }
      e.f.Q.setTargetAtTime(ms.q, t, 0.1);
      e.g2.gain.setTargetAtTime(prof.sub * 0.5 * ms.sub, t, 0.1);
      // firing frequency: rpm/60 * cylinders/2
      const f0 = ((rpm * car.redline) / 60) * (prof.cyl / 2);
      e.o1.frequency.setTargetAtTime(f0, t, 0.025);
      e.o2.frequency.setTargetAtTime(f0 * 0.5, t, 0.025);
      e.o3.frequency.setTargetAtTime(f0 * 2, t, 0.025);
      e.lfo.frequency.setTargetAtTime(f0 / (prof.lopeDiv || 4), t, 0.05);
      const loud = ms.loud;
      e.f.frequency.setTargetAtTime((350 + rpm * 2300 * prof.cut + thr * 1300) * ms.cut, t, 0.04);
      let g = (0.04 + thr * 0.075) * loud * master * (rs.nosOn ? 1.25 : 1);
      // exhaust drone: a resonant band that follows the firing frequency,
      // strongest at part throttle / cruise (that's when a sport exhaust booms)
      e.dr.frequency.setTargetAtTime(f0 * 1.02, t, 0.05);
      e.drg.gain.setTargetAtTime(ms.drone * (0.4 + 0.6 * (1 - Math.abs(thr - 0.5) * 2)) * 0.09 * master, t, 0.08);
      // straight-cut gears: whine rising with road speed
      e.gw.frequency.setTargetAtTime(180 + speed * 26, t, 0.05);
      e.gwg.gain.setTargetAtTime(ms.whine * Math.min(1, speed / 12) * (0.4 + 0.6 * thr) * master, t, 0.06);
      // nitrous: a sharp "pssht" as it opens
      if (rs.nosOn && !this._nos) this.noiseHit(0.35, 2500, 0.14 * master, 'highpass', 'sfx', 0, 5000);
      this._nos = !!rs.nosOn;
      // rev limiter: fuel-cut stutter (a race map bounces off it harder)
      this._limT += dt;
      if (rpm > 0.985 && thr > 0.5 && rs.gear > 0) g *= Math.sin(this._limT * 95) > 0 ? 1 : ms.limHard ? 0.08 : 0.25;
      // shift: brief dip + click; boost dump on a turbo = blow-off
      if (rs.gear !== this._lastGear) {
        if (rs.gear > this._lastGear && this._lastGear > 0) {
          e.amp.gain.cancelScheduledValues(t);
          e.amp.gain.setValueAtTime(g * 0.35, t);
          this.noiseHit(0.03, 2400, 0.08 * master, 'bandpass', 'sfx');
          if (parts.gearing === 'seq') this.noiseHit(0.05, 900, 0.18 * master, 'bandpass', 'sfx');
        }
        this._lastGear = rs.gear;
      }
      e.amp.gain.setTargetAtTime(g, t, 0.03);
      e.lfoG.gain.setTargetAtTime(g * prof.lope * ms.lope, t, 0.05);
      // Forced induction — deliberately different characters:
      //  supercharger: whine LOCKED to engine speed (it's belt-driven), there
      //                the instant you touch the throttle, no blow-off
      //  street turbo: whistle that follows BOOST (so it lags the revs),
      //                intake whoosh, "pssh" blow-off when you lift
      //  big turbo   : deeper, louder whoosh and a "stu-tu-tu" flutter on lift
      const b = rs.boost || 0;
      const kind = G.Parts.opt('induction', parts.induction).kind;
      const big = parts.induction === 't2';
      e.tw.frequency.setTargetAtTime((big ? 1100 : 1750) + b * (big ? 2300 : 3100), t, 0.08);
      e.twg.gain.setTargetAtTime(kind === 'turbo' ? b * (big ? 0.036 : 0.026) * master : 0, t, 0.06);
      e.hg.gain.setTargetAtTime(kind === 'turbo' ? b * (0.3 + 0.7 * thr) * (big ? 0.055 : 0.03) * master : 0, t, 0.06);
      e.sw.frequency.setTargetAtTime(f0 * 3.3, t, 0.02);
      e.sw2.frequency.setTargetAtTime(f0 * 6.6, t, 0.02);
      e.swf.frequency.setTargetAtTime(1200 + rpm * 3200, t, 0.03);
      const scg = kind === 'sc' ? (0.012 + thr * 0.034) * (0.3 + 0.7 * rpm) * master : 0;
      e.swg.gain.setTargetAtTime(scg, t, 0.03);
      e.sw2g.gain.setTargetAtTime(scg * 0.5, t, 0.03);
      if (kind === 'turbo' && this._lastBoost > 0.45 && b < 0.25) big ? this.flutter(master) : this.blowoff(master);
      this._lastBoost = b;
      // overrun crackle (free-flowing exhausts), backfire pops on shifts
      const pops = ms.pops;
      if (this._lastThr > 0.6 && thr < 0.15 && rpm > 0.5 && pops > 0) this.crackle(pops, master);
      if (rs.backfire > 0 && !this._bf) this.pop(master);
      this._bf = rs.backfire > 0;
      this._lastThr = thr;
      this._env(rs, speed, master, t);
    },

    _env(rs, speed, master, t) {
      const v = this.env;
      if (!v) return;
      const ms = this._ms || modSound(null);
      let screech = 0, loose = 0, grass = 0, wet = 0, kerb = 0, road = 0;
      for (let i = 0; i < 4; i++) {
        const sf = G.SURF[(rs.surf && rs.surf[i]) || 0];
        const sl = (rs.slip && rs.slip[i]) || 0;
        if (!sf) continue;
        if (sf.id === 'tarmac' || sf.id === 'concrete' || sf.id === 'kerb') {
          screech = Math.max(screech, sl);
          road += 0.25;
        }
        if (sf.loose && sf.id !== 'grass') loose += 0.25 * (0.5 + sl);
        if (sf.id === 'grass') grass += 0.25 * (0.6 + sl);
        if (sf.wet || sf.icy) wet += 0.25;
        if (sf.id === 'kerb') kerb += 0.25;
        if (sf.id === 'oil') screech = Math.max(screech, sl * 0.6);
      }
      const sp = Math.min(speed / 40, 1.3);
      const sc = Math.max(0, screech - 0.25) * 0.16 * master;
      v.scr1.g.gain.setTargetAtTime(sc, t, 0.03);
      v.scr2.g.gain.setTargetAtTime(sc * 0.6, t, 0.03);
      v.scr1.f.frequency.setTargetAtTime(850 + ms.screech + screech * 400 + Math.sin(this._limT * 13) * 60, t, 0.05);
      v.road.g.gain.setTargetAtTime(road * sp * 0.05 * master * ms.road, t, 0.08);
      // race pads / carbon squeal as the car rolls to a stop under braking
      const sq = (rs.brk || 0) > 0.3 && speed > 1.5 && speed < 13 ? ms.squeal * (1 - speed / 13) * master : 0;
      v.squeal.g.gain.setTargetAtTime(sq, t, 0.05);
      v.loose.g.gain.setTargetAtTime(loose * sp * 0.22 * master, t, 0.05);
      v.grass.g.gain.setTargetAtTime(grass * sp * 0.08 * master, t, 0.05);
      v.wet.g.gain.setTargetAtTime(wet * sp * 0.09 * master, t, 0.06);
      // in a slipstream the wind noise drops and the air buffets instead
      const dr = rs.draft || 0;
      v.wind.g.gain.setTargetAtTime(sp * sp * 0.05 * master * (1 - 0.65 * dr) * ms.wind, t, 0.15);
      v.buffet.g.gain.setTargetAtTime(dr * sp * 0.16 * master * (0.8 + 0.2 * Math.sin(this._limT * 17)), t, 0.06);
      v.nos.g.gain.setTargetAtTime(rs.nosOn ? 0.075 * master : 0, t, 0.04);
      v.kl.frequency.setTargetAtTime(Math.max(4, speed / 1.9), t, 0.05);
      const kg = kerb > 0 && speed > 4 ? 0.22 * Math.min(1, speed / 20) * master * ms.kerb : 0;
      v.kerb.g.gain.setTargetAtTime(kg * 0.5, t, 0.03);
      v.klg.gain.setTargetAtTime(kg * 0.5, t, 0.03);
      const scr = rs.wallHit > 0 && speed > 3 ? Math.min(0.2, speed / 120) * master : 0;
      v.scrape.g.gain.setTargetAtTime(scr, t, scr ? 0.01 : 0.12);
    },

    // Other cars: the two nearest to the listener (camera focus).
    // cars: [{rs, carId}], lx/lz/lyaw = listener position + facing.
    silenceOthers() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      for (const v of this.others) {
        v.g.gain.setTargetAtTime(0, t, 0.1);
        v.ng.gain.setTargetAtTime(0, t, 0.06);
        // v4.4.1: their turbo whistle / supercharger whine too. It was left
        // out, so after a race next to a boosted bot the whine played on at
        // its last level through the whole main menu.
        v.wg.gain.setTargetAtTime(0, t, 0.06);
        v.id = null;
        v.o = null;
      }
    },
    // The nearest (up to 4) other cars within 120 m of the listener get a
    // voice: their own engine character, throttle, Doppler pitch shift as
    // they pass, stereo position, tyre screech, and backfire pops. Roughly
    // half your own car's level up close (plus its own volume slider).
    // cars: [{id, rs, carId}], lx/lz/lyaw = listener position + facing,
    // lvx/lvz = listener velocity (your car's, when you're racing).
    othersUpdate(cars, lx, lz, lyaw, lvx, lvz) {
      if (!this.ok()) return;
      const t = this.ctx.currentTime;
      this._lx = lx;
      this._lz = lz;
      const near = cars
        .map((c) => ({ c, d: Math.hypot(c.rs.x - lx, c.rs.z - lz) }))
        .filter((o) => o.d < 120)
        .sort((a, b) => a.d - b.d)
        .slice(0, 4);
      while (this.others.length < near.length) this.others.push(this._voice(PROFILES.vandal));
      // keep each car on the same voice while it stays near (no pitch jumps)
      const byId = {};
      for (const o of near) byId[o.c.id] = o;
      const free = [];
      for (const v of this.others) {
        if (v.id != null && byId[v.id]) {
          v.o = byId[v.id];
          delete byId[v.id];
        } else free.push(v);
      }
      for (const id in byId) {
        const v = free.shift();
        if (!v) break;
        v.id = id;
        v.o = byId[id];
        v.bf = false;
      }
      for (const v of free) {
        v.id = null;
        v.o = null;
      }
      const rx = Math.cos(lyaw), rz = -Math.sin(lyaw); // listener's "left" (+x of heading frame)
      for (const v of this.others) {
        const o = v.o;
        if (!o) {
          v.g.gain.setTargetAtTime(0, t, 0.1);
          v.ng.gain.setTargetAtTime(0, t, 0.06);
          v.wg.gain.setTargetAtTime(0, t, 0.06);
          continue;
        }
        const rs = o.c.rs;
        const car = G.Parts.CARS[o.c.carId] || G.Parts.CARS.vandal;
        const prof = PROFILES[car.id] || PROFILES.vandal;
        const rpm = U.clamp(rs.rpm || 0.14, 0.1, 1.05);
        const dx = rs.x - lx, dz = rs.z - lz, d = o.d || 1;
        // Doppler: closing speed along the line between car and listener
        const closing = -(((rs.vx || 0) - (lvx || 0)) * dx + ((rs.vz || 0) - (lvz || 0)) * dz) / d;
        const dop = U.clamp(343 / (343 - closing), 0.82, 1.22);
        const f0 = ((rpm * car.redline) / 60) * (prof.cyl / 2) * dop;
        v.o1.frequency.setTargetAtTime(f0, t, 0.04);
        v.o2.frequency.setTargetAtTime(f0 * 0.5, t, 0.04);
        v.o3.frequency.setTargetAtTime(f0 * 2, t, 0.04);
        // their mods colour their note too (exhaust / ECU / stripped shell)
        // their build's sound profile, worked out once per car (it used to be
        // recomputed for every nearby car on every frame)
        const pc = this._msCache || (this._msCache = new WeakMap());
        let oms = o.c.parts && pc.get(o.c.parts);
        if (!oms) {
          oms = modSound(o.c.parts);
          if (o.c.parts) pc.set(o.c.parts, oms);
        }
        v.f.frequency.setTargetAtTime((320 + rpm * 1900 * prof.cut) * (0.8 + 0.2 * dop) * oms.cut, t, 0.05);
        v.f.Q.setTargetAtTime(1.4 * (oms.q / 1.6), t, 0.1);
        v.m3.gain.setTargetAtTime(0.3 * oms.rasp, t, 0.1);
        const thr = rs.thr ? U.clamp(rs.thr, 0.5, 1) : 0.45;
        const fall = 1 / (1 + d / 11);
        v.g.gain.setTargetAtTime((0.035 + 0.06 * thr) * fall * oms.loud, t, 0.06);
        // straight pipes / race maps crackle as they lift past you
        // (at most every 0.7 s per car: a bot's throttle flickers, and each
        // lift used to fire another burst of pops)
        if (oms.pops > 0.4 && v.lt > 0.5 && !rs.thr && fall > 0.2 && performance.now() - (v.crT || 0) > 700) {
          v.crT = performance.now();
          this.crackle(oms.pops * 0.6, fall * 0.7);
        }
        v.lt = rs.thr ? 1 : 0;
        let slip = 0;
        if (rs.slip) for (let i = 0; i < 4; i++) {
          const sf = G.SURF[(rs.surf && rs.surf[i]) || 0];
          if (sf && sf.fx === 'smoke') slip = Math.max(slip, rs.slip[i]);
        }
        v.ng.gain.setTargetAtTime(Math.max(0, slip - 0.28) * 0.14 * fall, t, 0.04);
        v.nf.frequency.setTargetAtTime(950 + slip * 450, t, 0.05);
        if (v.p) {
          const side = (dx * rx + dz * rz) / d; // + = to the listener's left
          v.p.pan.setTargetAtTime(U.clamp(-side, -0.9, 0.9), t, 0.05);
        }
        // their induction: supercharger whine on the revs, turbo whistle on boost
        const ind = (o.c.parts && o.c.parts.induction) || 'na';
        const okind = G.Parts.opt('induction', ind).kind;
        const bst = rs.boost || 0;
        if (okind === 'sc') {
          if (v.w.type !== 'triangle') v.w.type = 'triangle';
          v.w.frequency.setTargetAtTime(f0 * 3.3, t, 0.03);
          v.wg.gain.setTargetAtTime((0.008 + 0.022 * thr) * rpm * fall, t, 0.04);
        } else if (okind === 'turbo') {
          if (v.w.type !== 'sine') v.w.type = 'sine';
          v.w.frequency.setTargetAtTime(((ind === 't2' ? 1100 : 1750) + bst * (ind === 't2' ? 2300 : 3100)) * dop, t, 0.08);
          v.wg.gain.setTargetAtTime(bst * 0.024 * fall, t, 0.06);
          if (v.lb > 0.45 && bst < 0.25 && fall > 0.15) ind === 't2' ? this.flutter(fall, 'others') : this.blowoff(fall, 'others');
        } else v.wg.gain.setTargetAtTime(0, t, 0.06);
        v.lb = bst;
        if (rs.backfire > 0 && !v.bf && fall > 0.12) this.pop(fall * 0.8, 'others');
        v.bf = rs.backfire > 0;
      }
    },

    // Called by RaceView.apply every frame of a race view.
    race(v, world, dt) {
      const me = v.me && !v.me.finished ? v.me : null;
      this.update(me ? me.rs : null, dt, me ? { carId: me.carId, parts: me.parts } : null);
      this._fed = true;
      if (!this.ok()) return;
      if (!this.env) this._startEnv();
      const c = world.cam;
      const others = v.cars.filter((x) => !me || x.id !== me.id);
      this.othersUpdate(others.map((x) => ({ id: x.id, rs: x.rs, carId: x.carId, parts: x.parts })), c.fx, c.fz, c.yaw, me ? me.rs.vx : 0, me ? me.rs.vz : 0);
    },

    // --------------------------------------------------------- one-shots
    tone(freq, dur, type, v, slide, bus, when) {
      if (!this.ok()) return;
      const c = this.ctx, t = c.currentTime + (when || 0);
      const o = c.createOscillator(), g = c.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v || 0.1, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(this.bus[bus || 'sfx']);
      o.start(t);
      o.stop(t + dur + 0.03);
    },
    noiseHit(dur, freq, v, type, bus, when, sweep, q) {
      if (!this.ok()) return;
      const c = this.ctx, t = c.currentTime + (when || 0);
      const s = c.createBufferSource();
      s.buffer = this.noise;
      const f = c.createBiquadFilter();
      f.type = type || 'lowpass';
      f.frequency.setValueAtTime(freq, t);
      if (q) f.Q.value = q;
      if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f);
      f.connect(g);
      g.connect(this.bus[bus || 'sfx']);
      s.start(t, Math.random() * 1.5);
      s.stop(t + dur + 0.03);
    },

    // --- driving
    beep(freq, dur) {
      this.tone(freq || 440, dur || 0.18, 'square', 0.09);
    },
    countdown(n) {
      if (n > 0) {
        this.tone(520, 0.2, 'square', 0.09);
        this.tone(1040, 0.2, 'sine', 0.04);
      } else this.go();
    },
    go() {
      this.tone(1046, 0.55, 'square', 0.09);
      this.tone(1568, 0.55, 'sine', 0.06);
      this.tone(784, 0.55, 'sawtooth', 0.03);
      this.cheer(0.5);
    },
    thud(k) {
      // at most ~11 crash sounds a second: each one is a dozen audio nodes
      const now = performance.now();
      if (now - (this._thudT || 0) < 90) return;
      this._thudT = now;
      k = U.clamp(k || 0.5, 0.1, 1);
      this.noiseHit(0.28, 190, 0.55 * (0.4 + k));
      this.tone(72, 0.24, 'sine', 0.35 * k, 38);
      if (k > 0.35) this.crunch(k);
    },
    crunch(k) {
      // metal: a cluster of detuned squares through a ringing bandpass
      this.noiseHit(0.35, 2600, 0.22 * k, 'bandpass', 'sfx', 0, 900, 4);
      for (const f of [431, 587, 757]) this.tone(f * (0.9 + Math.random() * 0.2), 0.16, 'square', 0.03 * k, f * 0.6);
    },
    pop(m, bus) {
      this.noiseHit(0.07, 950, 0.34 * (m || 1), 'bandpass', bus || 'sfx', 0, 0, 1.2);
      this.tone(90, 0.06, 'square', 0.12 * (m || 1), 50, bus || 'sfx');
    },
    crackle(amount, m) {
      const now = performance.now();
      if (now - (this._crT || 0) < 150) return; // several cars lifting at once: one burst is plenty
      this._crT = now;
      const n = 2 + Math.round(amount * 4);
      for (let i = 0; i < n; i++) {
        const w = 0.04 + Math.random() * 0.45;
        setTimeout(() => this.pop(0.35 + Math.random() * 0.5 * (m || 1)), w * 1000);
      }
    },
    // v4 garage "Listen": rev the engine with a given build for ~2.4 s —
    // idle blip, a pull to the limiter, then lift (so pops, blow-off and the
    // exhaust's character are all heard). Uses the real engine voice.
    revDemo(carId, parts) {
      if (!this.ok()) return false;
      clearInterval(this._demoT);
      if (!this.env) this._startEnv();
      const t0 = performance.now();
      let last = t0;
      const rs = { rpm: 0.14, thr: 0, gear: 1, vx: 0, vz: 0, boost: 0, surf: [0, 0, 0, 0], slip: [0, 0, 0, 0] };
      const spec = G.Parts.computeSpec(carId, parts, {}, {});
      this._demoUntil = t0 + 2700;
      this._demoT = setInterval(() => {
        const now = performance.now(), dt = (now - last) / 1000, s = (now - t0) / 1000;
        last = now;
        if (s > 2.6) {
          clearInterval(this._demoT);
          this.update(null, dt, { demo: true });
          this._demoUntil = 0;
          return;
        }
        const thr = s < 0.35 ? 1 : s < 0.7 ? 0 : s < 1.9 ? 1 : 0;
        const tgt = thr ? (s < 0.35 ? 0.55 : Math.min(1, 0.3 + (s - 0.7) * 0.75)) : 0.16;
        rs.rpm += (tgt - rs.rpm) * Math.min(1, dt * (thr ? 3.2 : 2.2));
        rs.thr = thr;
        const bt = thr * G.Parts.boostAvail(spec, rs.rpm);
        rs.boost += (bt - rs.boost) * Math.min(1, dt / (bt > rs.boost ? spec.boostLag : 0.12));
        this.update(rs, dt, { carId, parts, demo: true });
      }, 30);
      return true;
    },
    // v4 speed pad: a rising electric zap
    zap(m) {
      if (!this.ok()) return;
      const c = this.ctx, t = c.currentTime, k = m || 1;
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(300, t);
      o.frequency.exponentialRampToValueAtTime(1900, t + 0.22);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.1 * k, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(this.bus.sfx);
      o.start(t);
      o.stop(t + 0.32);
      this.noiseHit(0.25, 3000, 0.08 * k, 'highpass', 'sfx', 0, 6000);
    },
    blowoff(m, bus) {
      this.noiseHit(0.38, 5200, 0.16 * (m || 1), 'highpass', bus || 'sfx', 0, 1400);
    },
    // big-turbo compressor surge: a fast falling "stu-tu-tu-tu"
    flutter(m, bus) {
      for (let i = 0; i < 7; i++) this.noiseHit(0.04, 1500 - i * 110, 0.14 * (m || 1) * (1 - i * 0.11), 'bandpass', bus || 'sfx', i * 0.052, 0, 3);
    },
    lap() {
      this.tone(1318, 0.14, 'triangle', 0.1);
      this.tone(1760, 0.26, 'triangle', 0.1, 0, 'sfx', 0.11);
    },
    lastLap() {
      for (let i = 0; i < 3; i++) this.tone(1480, 0.45, 'sine', 0.12, 0, 'sfx', i * 0.22);
    },
    finish(pos) {
      const notes = pos <= 3 ? [523, 659, 784, 1046, 1318] : [523, 659, 784];
      notes.forEach((f, i) => this.tone(f, 0.24, 'square', 0.07, 0, 'sfx', i * 0.1));
      this.cheer(pos <= 3 ? 1 : 0.5);
    },
    overtake(up) {
      if (up) this.tone(620, 0.12, 'triangle', 0.08, 980);
      else this.tone(520, 0.14, 'triangle', 0.06, 330);
    },
    // v4.4.2: a soft rising whoosh when you catch a slipstream (hud.js)
    draftIn() {
      this.noiseHit(0.4, 600, 0.07, 'bandpass', 'sfx', 0, 2400, 1.2);
      this.tone(520, 0.16, 'sine', 0.025, 880, 'sfx', 0.04);
    },
    wrongWay() {
      this.tone(180, 0.18, 'square', 0.08);
      this.tone(150, 0.2, 'square', 0.08, 0, 'sfx', 0.2);
    },
    respawn() {
      this.noiseHit(0.45, 400, 0.18, 'bandpass', 'sfx', 0, 3200, 2);
    },
    cheer(k) {
      // crowd: band-limited noise with a slow swell plus a few "whoo" tones
      if (!this.ok()) return;
      k = k || 1;
      this.noiseHit(2.2, 1100, 0.12 * k, 'bandpass', 'sfx', 0, 900, 0.7);
      for (let i = 0; i < 4; i++) this.tone(500 + Math.random() * 400, 0.5, 'sine', 0.012 * k, 800 + Math.random() * 500, 'sfx', Math.random() * 0.6);
    },

    // --- interface
    hover() {
      const now = performance.now();
      if (now - this._hoverT < 45) return;
      this._hoverT = now;
      this.tone(2300, 0.025, 'triangle', 0.018, 0, 'ui');
    },
    click() {
      this.tone(1400, 0.035, 'square', 0.04, 900, 'ui');
    },
    back() {
      this.tone(900, 0.06, 'triangle', 0.05, 600, 'ui');
    },
    tab() {
      this.tone(1700, 0.04, 'triangle', 0.05, 0, 'ui');
    },
    buy() {
      // cash register: two bells + a shimmer
      this.tone(1568, 0.3, 'triangle', 0.08, 0, 'ui');
      this.tone(2093, 0.4, 'triangle', 0.07, 0, 'ui', 0.07);
      this.noiseHit(0.25, 6000, 0.05, 'highpass', 'ui', 0.02);
    },
    sell() {
      [1760, 1318, 1046].forEach((f, i) => this.tone(f, 0.1, 'triangle', 0.05, 0, 'ui', i * 0.06));
    },
    repair() {
      for (let i = 0; i < 5; i++) this.noiseHit(0.03, 3000, 0.1, 'bandpass', 'ui', i * 0.07, 0, 6);
    },
    error() {
      this.tone(160, 0.12, 'square', 0.06, 0, 'ui');
      this.tone(130, 0.16, 'square', 0.06, 0, 'ui', 0.13);
    },
    good() {
      this.tone(880, 0.09, 'triangle', 0.06, 0, 'ui');
      this.tone(1320, 0.14, 'triangle', 0.06, 0, 'ui', 0.08);
    },
    money() {
      this.tone(1760, 0.08, 'square', 0.04, 0, 'ui');
      this.tone(2637, 0.18, 'square', 0.04, 0, 'ui', 0.07);
    },
    ready() {
      [660, 990, 1320].forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.06, 0, 'ui', i * 0.07));
    },
    chat() {
      this.tone(1200, 0.06, 'sine', 0.05, 1500, 'ui');
    },
    tick() {
      this.tone(1000, 0.03, 'square', 0.03, 0, 'ui');
    },
    // --- casino
    chip() {
      this.tone(2300, 0.05, 'triangle', 0.07, 0, 'ui');
      this.tone(2800, 0.04, 'triangle', 0.05, 0, 'ui', 0.045);
    },
    card() {
      this.noiseHit(0.06, 3200, 0.14, 'highpass', 'ui');
    },
    wheelTick() {
      this.tone(3000 + Math.random() * 500, 0.015, 'square', 0.02, 0, 'ui');
    },
    win() {
      [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.18, 'square', 0.07, 0, 'ui', i * 0.09));
    },
    lose() {
      [392, 330, 262].forEach((f, i) => this.tone(f, 0.22, 'sawtooth', 0.05, 0, 'ui', i * 0.12));
    },

    // --- music
    music(name) {
      if (!this.enabled) return;
      Music.play(name);
    },
  };

  // ======================================================================
  // Music: a 16-step sequencer with look-ahead scheduling. Chords, bass, an
  // arpeggio, a seeded melody hook and drums — all oscillators + noise.
  // ======================================================================
  const SONGS = {
    // A minor, i–VI–III–VII: driving synth-pop for the menu
    menu: { bpm: 112, prog: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], drums: 'four', arp: 1, lead: 1, bassPat: [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0] },
    // Dm7–G7–Cmaj7–Am7: laid-back garage / intermission groove
    garage: { bpm: 92, prog: [[50, 53, 57, 60], [55, 59, 62, 65], [48, 52, 55, 59], [45, 48, 52, 55]], drums: 'soft', arp: 0, keys: 1, lead: 0, bassPat: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0] },
    // C–G–Am–F: triumphant final standings
    final: { bpm: 124, prog: [[48, 52, 55], [55, 59, 62], [57, 60, 64], [53, 57, 60]], drums: 'four', arp: 1, lead: 1, bright: 1, bassPat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1] },
  };
  const Music = {
    cur: null,
    timer: null,
    step: 0,
    next: 0,
    gain: null,
    play(name) {
      const A = Audio;
      if (!name || !SONGS[name]) return this.stop();
      if (this.cur === name) return;
      if (!A.ok()) return;
      this.stop();
      this.cur = name;
      this.song = SONGS[name];
      this.gain = A.ctx.createGain();
      this.gain.gain.value = 0.0001;
      this.gain.gain.exponentialRampToValueAtTime(1, A.ctx.currentTime + 1.2);
      this.gain.connect(A.bus.music);
      this.step = 0;
      this.next = A.ctx.currentTime + 0.1;
      this.rng = U.rng(U.hashStr(name));
      this.hook = [];
      for (let i = 0; i < 32; i++) this.hook.push(this.rng() < 0.42 ? Math.floor(this.rng() * 5) : -1);
      this.timer = setInterval(() => this._schedule(), 30);
    },
    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (this.gain && Audio.ctx) {
        const g = this.gain, t = Audio.ctx.currentTime;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        setTimeout(() => {
          try {
            g.disconnect();
          } catch (e) {}
        }, 900);
      }
      this.gain = null;
      this.cur = null;
    },
    _schedule() {
      const c = Audio.ctx;
      if (!c || !this.gain) return;
      const sp = 60 / this.song.bpm / 4;
      if (this.next < c.currentTime - 0.25) this.next = c.currentTime + 0.05; // tab was asleep: don't burst
      while (this.next < c.currentTime + 0.14) {
        this._step(this.step, this.next, sp);
        this.next += sp;
        this.step++;
      }
    },
    _note(m, t, dur, type, v, cut) {
      const c = Audio.ctx;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.value = mtof(m);
      let out = o;
      if (cut) {
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = cut;
        o.connect(f);
        out = f;
      }
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + Math.min(0.02, dur * 0.2));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      out.connect(g);
      g.connect(this.gain);
      o.start(t);
      o.stop(t + dur + 0.05);
    },
    _drum(kind, t) {
      const c = Audio.ctx;
      if (kind === 'kick') {
        const o = c.createOscillator(), g = c.createGain();
        o.frequency.setValueAtTime(150, t);
        o.frequency.exponentialRampToValueAtTime(42, t + 0.22);
        g.gain.setValueAtTime(0.5, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.connect(g).connect(this.gain);
        o.start(t);
        o.stop(t + 0.32);
        return;
      }
      const s = c.createBufferSource();
      s.buffer = Audio.noise;
      const f = c.createBiquadFilter();
      const g = c.createGain();
      if (kind === 'snare') {
        f.type = 'bandpass';
        f.frequency.value = 1900;
        g.gain.setValueAtTime(0.22, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      } else {
        f.type = 'highpass';
        f.frequency.value = 7000;
        g.gain.setValueAtTime(kind === 'hatO' ? 0.07 : 0.045, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'hatO' ? 0.14 : 0.04));
      }
      s.connect(f).connect(g).connect(this.gain);
      s.start(t, Math.random());
      s.stop(t + 0.2);
    },
    _step(n, t, sp) {
      const S_ = this.song;
      const st = n % 16, bar = Math.floor(n / 16) % S_.prog.length;
      const ch = S_.prog[bar];
      // drums
      if (S_.drums === 'four') {
        if (st % 4 === 0) this._drum('kick', t);
        if (st === 4 || st === 12) this._drum('snare', t);
        if (st % 2 === 1) this._drum(st === 7 || st === 15 ? 'hatO' : 'hat', t);
      } else {
        if (st === 0 || st === 10) this._drum('kick', t);
        if (st === 8) this._drum('snare', t);
        if (st % 4 === 2) this._drum('hat', t);
      }
      // bass
      if (S_.bassPat[st]) this._note(ch[0] - 12 + (st === 14 ? 12 : 0), t, sp * 1.8, 'sawtooth', 0.09, 420);
      // pad / keys on the bar
      if (st === 0) {
        for (const m of ch) this._note(m, t, sp * 15, S_.keys ? 'triangle' : 'sawtooth', S_.keys ? 0.035 : 0.018, S_.keys ? 2200 : 1100);
      }
      if (S_.keys && (st === 6 || st === 10)) for (const m of ch.slice(1)) this._note(m + 12, t, sp * 2.5, 'sine', 0.025);
      // arpeggio
      if (S_.arp) {
        const m = ch[st % ch.length] + 12 + (Math.floor(st / ch.length) % 2 ? 12 : 0);
        this._note(m, t, sp * 0.9, 'square', 0.016, S_.bright ? 3200 : 2000);
      }
      // melody hook (seeded, repeats every 2 bars)
      if (S_.lead) {
        const h = this.hook[n % 32];
        if (h >= 0 && st % 2 === 0) {
          const scale = [0, 2, 3, 5, 7];
          const m = ch[0] + 24 + scale[h];
          this._note(m, t, sp * 1.9, 'triangle', 0.035);
        }
      }
    },
  };
  Audio.Music = Music;

  // Unlock on the first gesture if sound was left enabled last time.
  Audio.enabled = !!(G.Settings && G.Settings.s.sound);
  const unlock = () => {
    if (Audio.enabled) Audio.ok();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  if (G.Settings) G.Settings.on((k) => {
    if (k[0] === 'v') Audio.applyVolumes();
  });

  G.Audio = Audio;
})(window.G);
