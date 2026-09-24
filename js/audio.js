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
  // v4.5: res = where the exhaust rings (Hz), grit = combustion rasp amount
  // v5: every car has its own voice, spread further apart. types = the
  // waveforms of [firing order, half order, 2nd order] — a square-heavy stack
  // buzzes, sawtooths rasp, sines and triangles are smooth.
  const PROFILES = {
    // smooth straight-six: clean, even, a strong 2nd order
    vandal: { cyl: 6, types: ['sawtooth', 'triangle', 'sawtooth'], cut: 1.05, rasp: 1.4, lope: 0.03, lopeDiv: 6, sub: 0.35, h2: 0.55, res: 420, grit: 0.5 },
    // boxer-four rally hatch: gravelly, a lumpy burble at half the firing rate
    brick: { cyl: 4, types: ['square', 'square', 'sawtooth'], cut: 1.15, rasp: 7.5, lope: 0.35, lopeDiv: 2, sub: 0.4, h2: 0.3, res: 300, grit: 1.4 },
    // high-revving four: thin and bright, screams at the top
    sting: { cyl: 4, types: ['sawtooth', 'triangle', 'square'], cut: 1.8, rasp: 4.2, lope: 0.0, lopeDiv: 4, sub: 0.12, h2: 0.9, res: 680, grit: 0.9 },
    // cross-plane V8: deep sub, heavy lope
    mule: { cyl: 8, types: ['sawtooth', 'square', 'sawtooth'], cut: 0.62, rasp: 2.6, lope: 0.7, lopeDiv: 4, sub: 1.25, h2: 0.15, res: 180, grit: 1.15 },
    // kei three-cylinder: a buzzy, uneven little thrum
    pip: { cyl: 3, types: ['square', 'square', 'triangle'], cut: 2.1, rasp: 5.5, lope: 0.14, lopeDiv: 3, sub: 0.08, h2: 1.0, res: 780, grit: 1.25 },
    // truck V6: low, gruff and lumpy
    dune: { cyl: 6, types: ['sawtooth', 'square', 'triangle'], cut: 0.7, rasp: 3.6, lope: 0.28, lopeDiv: 3, sub: 1.0, h2: 0.2, res: 230, grit: 1.3 },
    // flat-six supercar: a clean, hard shriek
    apex: { cyl: 6, types: ['square', 'sine', 'sawtooth'], cut: 2.2, rasp: 3.2, lope: 0.02, lopeDiv: 6, sub: 0.15, h2: 1.1, res: 600, grit: 0.8 },
    // Group B inline-five: the off-beat warble (lope at 2/5 of firing)
    storm: { cyl: 5, types: ['sawtooth', 'square', 'sawtooth'], cut: 1.3, rasp: 6.2, lope: 0.4, lopeDiv: 2.5, sub: 0.5, h2: 0.45, res: 340, grit: 1.5 },
    // v5.4 V12 grand tourer: six firing pulses a turn - smooth, high and
    // silky, a clean scream at the top instead of a bark
    regent: { cyl: 12, types: ['sawtooth', 'sine', 'triangle'], cut: 1.55, rasp: 1.9, lope: 0.0, lopeDiv: 6, sub: 0.3, h2: 0.85, res: 520, grit: 0.55 },
    // v5.4 two-rotor rotary: two pulses a turn like a four, but square-heavy
    // and bright - the buzz - with the uneven "brap" at idle
    rotor: { cyl: 4, types: ['square', 'sawtooth', 'triangle'], cut: 2.35, rasp: 5.2, lope: 0.5, lopeDiv: 2, sub: 0.18, h2: 0.7, res: 880, grit: 1.1 },
    // electric: no combustion — a motor tone and an inverter whine
    volt: { cyl: 8, types: ['triangle', 'sine', 'sine'], cut: 3.0, rasp: 0.2, lope: 0.0, lopeDiv: 4, sub: 0.04, h2: 1.4, res: 1800, grit: 0, ev: 1 },
  };
  const _curves = new Map(); // waveshaper curves by amount (shared)
  const curveFor = (k) => {
    const key = Math.round(k * 10) / 10;
    let c = _curves.get(key);
    if (!c) _curves.set(key, (c = shaperCurve(key)));
    return c;
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
  // v5.3: the exhaust amplifies what the ENGINE already is, instead of the
  // same flat multiplier on every car. A straight pipe on the V8 gets rumble
  // and lope because the V8 has rumble and lope to give (prof.sub, prof.lope);
  // on the kei triple the same pipe gets rasp and buzz, because that is what a
  // three-cylinder has. So "should every car burble on a straight pipe?" -
  // no, and now they don't.
  // `look` carries the free sound tuning (tone / overrun / BOV / idle /
  // limiter). It never touches physics.
  function modSound(parts, carId, look) {
    const p = Object.assign({}, G.Parts.STOCK, parts || {});
    // Enforce the hardware gate HERE rather than trusting the garage: a look
    // can be set and the parts changed afterwards, and this is the one place
    // the noise is actually decided, so a bang tune with a stock silencer
    // cannot sneak through whatever route it took to get here.
    const L = {};
    for (const k of G.Parts.SOUND_KEYS) {
      const v = (look || {})[k];
      L[k] = v && G.Parts.soundAllowed(k, v, carId, p) ? v : undefined;
    }
    const prof = PROFILES[carId] || PROFILES.vandal;
    const ex = { stock: { loud: 1, rasp: 0.8, q: 1.2, cut: 0.85, drone: 0, sub: 1, lope: 1 }, sport: { loud: 1.15, rasp: 1.25, q: 2.2, cut: 1, drone: 0.35, sub: 1.1, lope: 1.1 }, straight: { loud: 1.4, rasp: 1.8, q: 3.2, cut: 1.15, drone: 0.2, sub: 1.3, lope: 1.35 } }[p.exhaust] || { loud: 1, rasp: 1, q: 1.6, cut: 1, drone: 0, sub: 1, lope: 1 };
    const ecu = p.ecu === 'stage2' ? 1.18 : p.ecu === 'stage1' ? 1.08 : 1;
    const strip = { w1: 1.08, w2: 1.15, w3: 1.22 }[p.weight] || 1;
    // How much of the pipe's gain lands as BASS and how much as RASP depends on
    // the engine: few big cylinders (prof.sub high) rumble, many small ones
    // (prof.grit / few sub) rasp. `bias` is 0 = rumbly .. 1 = raspy.
    const bias = U.clamp(1 - (prof.sub || 0.3) * 0.7, 0.15, 0.95);
    const gain = ex.sub - 1; // what the pipe adds over stock
    let sub = 1 + gain * (1 - bias) * 2.0;
    let rasp = ex.rasp * ecu * (1 + gain * bias * 1.6);
    let lope = ex.lope * (1 + (prof.lope || 0) * 1.2);
    let loud = ex.loud * strip;
    let drone = ex.drone;
    // ---- sound tuning (free, cosmetic)
    if (L.tone === 'deep') { sub *= 1.5; rasp *= 0.7; drone += 0.2; }
    else if (L.tone === 'rasp') { rasp *= 1.55; sub *= 0.75; }
    else if (L.tone === 'loud') { loud *= 1.3; rasp *= 1.15; sub *= 1.15; }

    let pops = Math.max(G.Parts.opt('exhaust', p.exhaust).pops || 0, p.ecu === 'stage2' ? 0.5 : 0);
    let bang = 0, burble = 0, crackle = 0;
    // A crackle tune is a DENSER, longer burst of small cracks, not simply
    // "more pops" - as a level it did nothing at all on a straight pipe,
    // which already pops as hard as the scale goes.
    if (L.over === 'crackle') { pops = Math.max(pops, 0.8); crackle = 1; }
    else if (L.over === 'bangs') { pops = Math.max(pops, 1); bang = 1; }
    else if (L.over === 'burble') { pops = Math.max(pops, 0.55); burble = 1; }
    else if (L.over === 'quiet') pops = 0;
    // Lope as an ABSOLUTE depth, not a multiplier: a smooth engine has
    // prof.lope 0, and anything times zero is zero - so a lopey-cam idle did
    // nothing at all on the roadster, the mid-engine car or the EV.
    const lopeAbs = (prof.lope || 0) * lope + (L.idle === 'lope' ? 0.26 : 0);
    return {
      loud, rasp, q: ex.q, cut: ex.cut, drone, sub, lope, lopeAbs,
      road: { w1: 1.3, w2: 1.6, w3: 2 }[p.weight] || 1,
      pops, bang, burble, crackle,
      bov: L.bov || 'stock',
      limHard: L.lim === 'hard' || p.ecu === 'stage2', // harsher limiter bounce
      whine: p.gearing === 'seq' ? 0.014 : p.gearing === 'short' ? 0.006 : 0,
      wind: p.aero === 'a3' ? 1.7 : p.aero === 'a2' ? 1.35 : 1,
      squeal: p.brakes === 'carbon' ? 0.05 : p.brakes === 'sport' ? 0.03 : 0,
      screech: p.compound === 'soft' ? 120 : p.compound === 'medium' ? 50 : 0,
      kerb: p.suspension === 'race' ? 1.45 : p.suspension === 'rally' ? 0.7 : 1,
    };
  }
  const OVERRUN = 2.2; // s an overrun keeps cracking after the lift (audio + the smoke in world.js)
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
    modSound, // pure: tools/audit.js checks every sound option changes something
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

    // v5.5: speech to text turns the game down while you talk, so laptop
    // speakers don't drown your voice out in the microphone
    // (v5.5.1: or a number, the share of the volume to keep - Settings -> Voice)
    duck(on) {
      this.duckK = typeof on === 'number' ? Math.max(0, Math.min(1, on)) : on ? 0.22 : 1;
      this.applyVolumes();
    },

    applyVolumes() {
      if (!this.ctx) return;
      const s = S();
      const t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(vol(s.vMaster) * 0.9 * (this.duckK == null ? 1 : this.duckK), t, this.duckK != null ? 0.12 : 0.05);
      this.bus.engine.gain.setTargetAtTime(vol(s.vEngine), t, 0.05);
      this.bus.others.gain.setTargetAtTime(vol(s.vOthers == null ? 70 : s.vOthers), t, 0.05);
      this.bus.sfx.gain.setTargetAtTime(vol(s.vSfx), t, 0.05);
      this.bus.ui.gain.setTargetAtTime(vol(s.vUi), t, 0.05);
      // (v5.1: 0.55 -> 0.7. With the default slider at 45% the songs sat so far
      //  under the engine note that players asked where the music was.)
      this.bus.music.gain.setTargetAtTime(vol(s.vMusic) * 0.7, t, 0.05);
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
      // (v5: an electric motor is tonal and clean — no sawtooth buzz)
      const ty = prof.types || ['sawtooth', 'square', 'sawtooth'];
      e.o1 = this._osc(ty[0]);
      e.o2 = this._osc(ty[1]);
      e.o3 = this._osc(ty[2]);
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
      // v4.5: exhaust body — a resonant peak where the pipe rings
      e.pk = this._filt('peaking', prof.res || 400, 1.6);
      e.pk.gain.value = 5;
      e.mix.connect(e.sh).connect(e.pk).connect(e.f).connect(e.amp).connect(E);
      // v4.5 combustion rasp: every exhaust pulse is a burst of broadband
      // noise, which is what gives a real engine its grit (a pure oscillator
      // stack sounds like a synth). Noise, gated by a pulse train at the
      // firing frequency, into the same amp as the tone, so shifts, the
      // limiter and the lope shape it too.
      e.cn = c.createBufferSource();
      e.cn.buffer = this.noise;
      e.cn.loop = true;
      e.cnf = this._filt('bandpass', 900, 0.9);
      e.cng = this._gain(0);
      e.cn.connect(e.cnf).connect(e.cng).connect(e.amp);
      e.am = this._osc('sawtooth', 50);
      e.amg = this._gain(0);
      e.am.connect(e.amg).connect(e.cng.gain);
      // lope: uneven firing -> amplitude wobble at ~1/4 firing frequency
      e.lfo = this._osc('sine', 10);
      e.lfoG = this._gain(0);
      e.lfo.connect(e.lfoG).connect(e.amp.gain);
      // forced induction
      e.tw = this._osc('sine', 2000);
      e.twg = this._gain(0);
      e.tw.connect(e.twg).connect(E);
      // v4.5: the compressor's blade-pass overtone, and a slight shaft wobble
      e.tw2 = this._osc('sine', 4000);
      e.tw2g = this._gain(0);
      e.tw2.connect(e.tw2g).connect(E);
      e.twl = this._osc('sine', 5.5);
      e.twlg = this._gain(0);
      e.twl.connect(e.twlg);
      e.twlg.connect(e.tw.frequency);
      e.twlg.connect(e.tw2.frequency);
      // supercharger: two rev-locked gear-whine partials through a nasal bandpass
      e.swf = this._filt('bandpass', 2500, 1.2);
      e.swo = this._gain(1);
      e.swf.connect(e.swo).connect(E);
      // v4.5: rotor pulses — a fast whirr riding on the whine
      e.swl = this._osc('sine', 30);
      e.swlg = this._gain(0);
      e.swl.connect(e.swlg).connect(e.swo.gain);
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
      for (const o of [e.o1, e.o2, e.o3, e.lfo, e.tw, e.sw, e.sw2, e.hs, e.gw, e.am, e.tw2, e.twl, e.swl]) o.start();
      e.cn.start(0, Math.random() * 1.5);
      this.eng = e;
      this._startEnv();
    },
    _stopEngine() {
      const e = this.eng;
      if (e) {
        for (const n of [e.o1, e.o2, e.o3, e.lfo, e.tw, e.sw, e.sw2, e.hs, e.gw, e.cn, e.am, e.tw2, e.twl, e.swl]) {
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
      v.road = chain('bandpass', 160, 1.1); // v5: structure-borne rumble (~160 Hz)
      v.tread = chain('bandpass', 1000, 0.9); // v5: tread air-pumping hiss, peaks ~0.7-1.3 kHz
      v.water = chain('lowpass', 900, 0.8); // v5: driving through water
      v.grain = chain('bandpass', 3000, 1.4); // v5: gravel/dirt grit under the tyres
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
      // v5: a squealing tyre stutters (stick-slip) instead of a steady tone
      v.sl = this._osc('sawtooth', 27);
      v.slg = this._gain(0);
      v.sl.connect(v.slg).connect(v.scr1.g.gain);
      // v5: gravel isn't a hiss, it's grains: a fast random gate on the grit
      v.gl = this._osc('square', 31);
      v.glg = this._gain(0);
      v.gl.connect(v.glg).connect(v.grain.g.gain);
      v.src.start();
      v.kl.start();
      v.sl.start();
      v.gl.start();
      this.env = v;
    },
    _stopEnv() {
      const v = this.env;
      if (!v) return;
      try {
        v.src.stop();
        v.kl.stop();
        v.sl.stop();
        v.gl.stop();
      } catch (e) {}
      this.env = null;
    },

    // Another car: engine (two oscillators, rasp, lowpass) + its own tyre
    // screech, both through a stereo panner into the "others" bus.
    // v5: the other car's own character — its waveforms, rasp, exhaust ring,
    // sub / 2nd-order balance and lope — set whenever the voice moves to a
    // different kind of car (_voiceCar), so a passing V8 burbles, a kei car
    // buzzes and the Volt whines instead of every car sounding alike.
    _voice(prof) {
      const v = { prof: null, id: null };
      v.o1 = this._osc('sawtooth');
      v.o2 = this._osc('square');
      v.o3 = this._osc('sawtooth');
      v.o3.detune.value = 11;
      v.g1 = this._gain(0.55);
      v.m2 = this._gain(0.25);
      v.m3 = this._gain(0.3);
      v.mix = this._gain(1);
      v.sh = this.ctx.createWaveShaper();
      v.pk = this._filt('peaking', 400, 1.6);
      v.pk.gain.value = 4;
      v.f = this._filt('lowpass', 700, 1.4);
      v.g = this._gain(0);
      v.p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      v.o1.connect(v.g1).connect(v.mix);
      v.o2.connect(v.m2).connect(v.mix);
      v.o3.connect(v.m3).connect(v.mix);
      v.mix.connect(v.sh).connect(v.pk).connect(v.f);
      v.f.connect(v.g);
      // lope: the uneven-firing wobble, on the voice's own level
      v.lfo = this._osc('sine', 10);
      v.lfoG = this._gain(0);
      v.lfo.connect(v.lfoG).connect(v.g.gain);
      v.lfo.start();
      this._voiceCar(v, prof);
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
      // v5.4: the rest of YOUR engine's recipe, so another car is not a
      // cheaper-sounding thing than yours. Combustion grit: noise gated at the
      // firing frequency (the single biggest difference between an engine
      // and a synth pad); the supercharger's second partial and rotor whirr
      // through the same nasal band; and the turbo's intake whoosh.
      v.cn = this.ctx.createBufferSource();
      v.cn.buffer = this.noise;
      v.cn.loop = true;
      v.cnf = this._filt('bandpass', 900, 0.9);
      v.cng = this._gain(0);
      v.cn.connect(v.cnf).connect(v.cng).connect(v.f);
      v.am = this._osc('sawtooth', 50);
      v.amg = this._gain(0);
      v.am.connect(v.amg).connect(v.cng.gain);
      v.wf = this._filt('bandpass', 2500, 1.2);
      v.wo = this._gain(1);
      v.w2 = this._osc('sine', 4000);
      v.w2g = this._gain(0);
      v.w2.connect(v.w2g).connect(v.wf);
      v.wf.connect(v.wo).connect(out);
      v.wl = this._osc('sine', 30);
      v.wlg = this._gain(0);
      v.wl.connect(v.wlg).connect(v.wo.gain);
      v.hf = this._filt('highpass', 2600, 0.8);
      v.hg = this._gain(0);
      v.n.connect(v.hf).connect(v.hg).connect(out);
      v.gear = 0;
      v.o1.start();
      v.o2.start();
      v.o3.start();
      v.w.start();
      v.w2.start();
      v.wl.start();
      v.am.start();
      v.n.start(0, Math.random() * 1.5);
      v.cn.start(0, Math.random() * 1.5);
      return v;
    },
    _voiceCar(v, prof) {
      if (v.prof === prof) return;
      v.prof = prof;
      const ty = prof.types || ['sawtooth', 'square', 'sawtooth'];
      v.o1.type = ty[0];
      v.o2.type = ty[1];
      v.o3.type = ty[2];
      v.sh.curve = curveFor(prof.ev ? 0 : prof.rasp * 0.8);
      const t = this.ctx.currentTime;
      v.pk.frequency.setValueAtTime(prof.res || 400, t);
      v.m2.gain.setValueAtTime(0.5 * (prof.sub == null ? 0.5 : prof.sub), t);
      v.m3.gain.setValueAtTime(0.45 * (prof.h2 == null ? 0.5 : prof.h2), t);
    },
    _killVoice(v) {
      try {
        for (const n of [v.lfo, v.o1, v.o2, v.o3, v.n, v.w, v.w2, v.wl, v.am, v.cn]) if (n) n.stop();
        for (const n of [v.g, v.ng, v.wg, v.wo, v.hg]) if (n) n.disconnect();
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
        // once is enough: the fades are scheduled (menus call this every frame)
        if (this.eng && this.ctx && !this._hushed) {
          this._hushed = true;
          const t = this.ctx.currentTime;
          for (const k of ['cng', 'amg', 'tw2g', 'twlg', 'swlg']) this.eng[k].gain.setTargetAtTime(0, t, 0.08);
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
      this._hushed = false;
      // the build's sound profile, redone only when the build changes (v4.5:
      // it was rebuilt from scratch every frame — needless garbage)
      const mp = meta.parts || G.Parts.STOCK;
      const lk = meta.look || {};
      const sig = mp.exhaust + '|' + mp.ecu + '|' + mp.weight + '|' + mp.gearing + '|' + mp.aero + '|' + mp.brakes + '|' + mp.compound + '|' + mp.suspension + '|' + mp.induction
        + '|' + meta.carId + '|' + lk.tone + lk.over + lk.bov + lk.idle + lk.lim;
      if (this._pSig !== sig) {
        this._pSig = sig;
        const p = Object.assign({}, G.Parts.STOCK, meta.parts || {});
        this._pk = { parts: p, ms: modSound(p, meta.carId, lk), kind: G.Parts.opt('induction', p.induction).kind };
      }
      const parts = this._pk.parts, ms = this._pk.ms;
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
      // firing frequency: crank revs per second * cylinders/2
      const crank = (rpm * car.redline) / 60;
      let f0 = crank * (prof.cyl / 2);
      if (prof.ev) f0 = 90 + crank * 3.2; // v5 EV: the motor's electrical order, climbing with speed
      // v4.5: a real idle hunts a little instead of sitting on one pitch
      if (rpm < 0.3) f0 *= 1 + (0.3 - rpm) * (Math.sin(this._limT * 2.3) * 0.05 + Math.sin(this._limT * 6.1) * 0.025);
      e.o1.frequency.setTargetAtTime(f0, t, 0.025);
      e.o2.frequency.setTargetAtTime(f0 * 0.5, t, 0.025);
      e.o3.frequency.setTargetAtTime(f0 * 2, t, 0.025);
      e.lfo.frequency.setTargetAtTime(f0 / (prof.lopeDiv || 4), t, 0.05);
      const loud = ms.loud;
      e.f.frequency.setTargetAtTime((350 + rpm * 2300 * prof.cut + thr * 1300) * ms.cut, t, 0.04);
      const over = thr < 0.1 && rpm > 0.3; // lifted at speed: the overrun
      let g = (0.04 + thr * 0.075) * loud * master * (rs.nosOn ? 1.25 : 1) * (over ? 0.8 : 1);
      // v4.5 combustion rasp (see _startEngine): gritty under load, a softer
      // burble on the overrun; stronger for rougher engines and freer pipes
      const grit = prof.ev ? 0 : Math.min(1.6, (prof.grit == null ? 1 : prof.grit) * ms.rasp); // (v5: an EV has no combustion to rasp)
      const rl = (0.14 + thr * 0.46 + (over ? 0.16 * ms.lope + ms.lopeAbs * 0.5 : 0)) * (0.4 + 0.6 * rpm) * grit;
      e.cng.gain.setTargetAtTime(rl * 0.5, t, 0.04);
      e.amg.gain.setTargetAtTime(rl * 0.5, t, 0.04);
      e.am.frequency.setTargetAtTime(f0, t, 0.025);
      e.cnf.frequency.setTargetAtTime(650 + rpm * 2400 * prof.cut + thr * 700, t, 0.05);
      // exhaust body: a freer pipe rings higher and harder
      e.pk.frequency.setTargetAtTime((prof.res || 400) * (ms.q > 3 ? 1.15 : ms.q > 2 ? 1.05 : 0.9), t, 0.2);
      e.pk.gain.setTargetAtTime(2.5 + ms.q * 1.1, t, 0.2);
      // exhaust drone: a resonant band that follows the firing frequency,
      // strongest at part throttle / cruise (that's when a sport exhaust booms)
      e.dr.frequency.setTargetAtTime(f0 * 1.02, t, 0.05);
      e.drg.gain.setTargetAtTime(ms.drone * (0.4 + 0.6 * (1 - Math.abs(thr - 0.5) * 2)) * 0.09 * master, t, 0.08);
      // straight-cut gears: whine rising with road speed
      // (v5 EV: the inverter + reduction gear sing instead — loud on power,
      // a softer regen whine off it)
      const evW = prof.ev ? (0.012 + 0.022 * thr) * Math.min(1, speed / 6 + 0.15) : 0;
      e.gw.frequency.setTargetAtTime(prof.ev ? 700 + speed * 62 : 180 + speed * 26, t, 0.05);
      e.gwg.gain.setTargetAtTime((ms.whine * Math.min(1, speed / 12) * (0.4 + 0.6 * thr) + evW) * master, t, 0.06);
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
      e.lfoG.gain.setTargetAtTime(g * ms.lopeAbs, t, 0.05);
      // Forced induction — deliberately different characters:
      //  supercharger: whine LOCKED to engine speed (it's belt-driven), there
      //                the instant you touch the throttle, no blow-off
      //  street turbo: whistle that follows BOOST (so it lags the revs),
      //                intake whoosh, "pssh" blow-off when you lift
      //  big turbo   : deeper, louder whoosh and a "stu-tu-tu" flutter on lift
      const b = rs.boost || 0;
      const kind = this._pk.kind;
      const big = parts.induction === 't2';
      // v4.5 turbo: the whistle tracks shaft speed (boost, plus exhaust flow
      // with the revs), with its blade-pass overtone and a slight shaft
      // wobble, and sings loudest while it's spooling up under load
      const spool = U.clamp(((b - this._lastBoost) / Math.max(dt, 0.001)) * 0.6, 0, 1);
      const twf = ((big ? 1100 : 1750) + b * (big ? 2300 : 3100)) * (0.85 + 0.15 * rpm);
      const tg = kind === 'turbo' ? b * (big ? 0.036 : 0.026) * (0.55 + 0.45 * thr + 0.5 * spool) * master : 0;
      e.tw.frequency.setTargetAtTime(twf, t, 0.08);
      e.tw2.frequency.setTargetAtTime(twf * 2.02, t, 0.08);
      e.twg.gain.setTargetAtTime(tg, t, 0.06);
      e.tw2g.gain.setTargetAtTime(tg * 0.3, t, 0.06);
      e.twlg.gain.setTargetAtTime(kind === 'turbo' ? twf * 0.004 : 0, t, 0.1);
      e.hg.gain.setTargetAtTime(kind === 'turbo' ? b * (0.3 + 0.7 * thr) * (big ? 0.055 : 0.03) * master : 0, t, 0.06);
      // v4.5 supercharger: belt-driven, so the whine is locked to the crank
      // (pulley ratio × rotor lobes) whatever the cylinder count, with a fast
      // rotor whirr on top; loud on load, and the bypass valve drops it (with
      // a soft whoosh) when you lift
      const fsc = crank * 14;
      e.sw.frequency.setTargetAtTime(fsc, t, 0.02);
      e.sw2.frequency.setTargetAtTime(fsc * 2, t, 0.02);
      e.swf.frequency.setTargetAtTime(900 + rpm * 3000, t, 0.03);
      e.swl.frequency.setTargetAtTime(crank * 2, t, 0.03);
      e.swlg.gain.setTargetAtTime(kind === 'sc' ? 0.3 : 0, t, 0.05);
      // (v5.4: about 1.7x louder - it was the quietest thing a supercharger did)
      const scg = kind === 'sc' ? (0.018 + thr * 0.062) * (0.3 + 0.7 * rpm) * master : 0;
      e.swg.gain.setTargetAtTime(scg, t, 0.03);
      e.sw2g.gain.setTargetAtTime(scg * 0.5, t, 0.03);
      if (kind === 'turbo' && this._lastBoost > 0.45 && b < 0.25) this.bov(ms.bov, big, master);
      if (kind === 'sc' && this._lastThr > 0.6 && thr < 0.15 && rpm > 0.4) this.noiseHit(0.3, 1800, 0.08 * master, 'bandpass', 'sfx', 0, 600, 0.8);
      this._lastBoost = b;
      // overrun crackle (free-flowing exhausts), backfire pops on shifts
      const pops = ms.pops;
      const lifting = this._lastThr > 0.6 && thr < 0.15 && rpm > 0.5;
      if (lifting) this._ovT = performance.now(); // an overrun starts HERE and is over in a couple of seconds
      if (thr > 0.25) this._ovT = 0; // back on the throttle: it is over now
      if (lifting && pops > 0) (ms.bang ? this.bangBurst(master) : this.crackle(pops, master, ms.crackle));
      // SUSTAINED backfire (anti-lag keeps the flag up for as long as you are
      // off the throttle) cracks repeatedly while it lasts. The old edge test
      // gave a whole overrun of flames exactly one pop.
      const now = performance.now();
      if (rs.backfire > 0) {
        if (!this._bf) this._bfT = 0;
        // Anti-lag is combustion in the exhaust, so the RATE follows engine
        // speed - a fast hard stutter up near the limiter, slowing to an
        // uneven mutter as the revs fall - and no two shots are the same
        // size. A fixed interval at one volume read as a machine, which is
        // exactly what it sounded like.
        const gap = 1000 / (4.5 + rpm * 11); // ~210 ms near idle, ~65 ms at the top
        if (now - (this._bfT || 0) > gap * (0.55 + Math.random() * 0.9)) {
          this._bfT = now;
          const amp = master * (0.32 + Math.random() * 0.68) * (0.45 + rpm * 0.55);
          if (Math.random() < 0.22 + rpm * 0.3) this.bang(amp);
          else this.pop(amp * 1.15);
        }
      }
      this._bf = rs.backfire > 0;
      // ...and it keeps banging for as long as you stay off it, not just on
      // the instant you lifted. Sparser and softer than anti-lag, because
      // this is unburnt fuel lighting off on its own rather than a system
      // deliberately keeping the turbine hot.
      // ...and it keeps going for a couple of seconds after the lift, fading
      // as it does - not, as it was, for as long as you stayed off the pedal,
      // which meant it cracked away down every straight until you stopped.
      const ovAge = this._ovT ? (now - this._ovT) / 1000 : 99;
      if (ms.bang && !rs.backfire && thr < 0.12 && rpm > 0.32 && speed > 3 && ovAge < OVERRUN) {
        const fade = 1 - ovAge / OVERRUN;
        const gap = 1000 / (1.6 + rpm * 4.5) / Math.max(0.35, fade); // slows as it dies away
        if (now - (this._bgT || 0) > gap * (0.6 + Math.random() * 1.1)) {
          this._bgT = now;
          const amp = master * (0.4 + Math.random() * 0.6) * (0.4 + rpm * 0.6) * (0.45 + 0.55 * fade);
          if (Math.random() < 0.45 * fade) this.bang(amp);
          else this.pop(amp * 1.2);
        }
      }
      // Burble tune: a lopey, uneven mutter off the throttle at low revs -
      // the one you hear at a junction, not under braking.
      if (ms.burble && thr < 0.08 && rpm < 0.45 && speed > 1 && now - (this._buT || 0) > 210 + Math.random() * 190) {
        this._buT = now;
        this.pop(master * (0.22 + Math.random() * 0.2));
      }
      this._lastThr = thr;
      this._env(rs, speed, master, t);
    },

    _env(rs, speed, master, t) {
      const v = this.env;
      if (!v) return;
      const ms = this._ms || modSound(null);
      let screech = 0, loose = 0, grass = 0, wet = 0, kerb = 0, road = 0, tread = 0, water = 0, gravel = 0;
      for (let i = 0; i < 4; i++) {
        const sf = G.SURF[(rs.surf && rs.surf[i]) || 0];
        const sl = (rs.slip && rs.slip[i]) || 0;
        if (!sf) continue;
        if (sf.id === 'tarmac' || sf.id === 'concrete' || sf.id === 'kerb') {
          screech = Math.max(screech, sl);
          road += 0.25;
          tread += sf.id === 'concrete' ? 0.34 : sf.id === 'kerb' ? 0.3 : 0.25; // concrete is the loud one
        }
        if (sf.id === 'water') water += 0.25;
        if (sf.id === 'gravel' || sf.id === 'dirt' || sf.id === 'sand') gravel += 0.25 * (sf.id === 'gravel' ? 1 : 0.6);
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
      v.road.g.gain.setTargetAtTime(road * sp * 0.07 * master * ms.road, t, 0.08);
      // v5 tread hiss: +6 dB per doubling of speed (amplitude ∝ speed); the
      // rain makes it a sizzle one octave up
      const wetRoad = this._wetEnv || 0;
      v.tread.f.frequency.setTargetAtTime(1000 + wetRoad * 1400 + speed * 6, t, 0.2);
      v.tread.g.gain.setTargetAtTime(tread * Math.min(speed / 40, 1.6) * (0.03 + wetRoad * 0.035) * master * ms.road, t, 0.08);
      v.water.g.gain.setTargetAtTime(water * Math.min(1, speed / 15) * 0.35 * master, t, 0.05);
      if (water > 0 && !this._inWater && speed > 6) this.splash(Math.min(1, speed / 30) * master);
      this._inWater = water > 0;
      v.grain.g.gain.setTargetAtTime(gravel * Math.min(1, speed / 20) * 0.05 * master, t, 0.05);
      v.gl.frequency.setTargetAtTime(18 + Math.random() * 40 + speed * 1.5, t, 0.02);
      v.glg.gain.setTargetAtTime(gravel * Math.min(1, speed / 20) * 0.05 * master, t, 0.05);
      v.slg.gain.setTargetAtTime(Math.max(0, screech - 0.25) * 0.09 * master, t, 0.03);
      v.sl.frequency.setTargetAtTime(22 + Math.random() * 14, t, 0.05);
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
      this._silenceAmb();
      if (this.env) for (const k of ['tread', 'water', 'grain']) this.env[k].g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
      const t = this.ctx.currentTime;
      for (const v of this.others) {
        v.g.gain.setTargetAtTime(0, t, 0.1);
        v.ng.gain.setTargetAtTime(0, t, 0.06);
        // v4.4.1: their turbo whistle / supercharger whine too. It was left
        // out, so after a race next to a boosted bot the whine played on at
        // its last level through the whole main menu.
        v.wg.gain.setTargetAtTime(0, t, 0.06);
        v.lfoG.gain.setTargetAtTime(0, t, 0.06);
        for (const k of ['cng', 'amg', 'w2g', 'wlg', 'hg']) if (v[k]) v[k].gain.setTargetAtTime(0, t, 0.06);
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
    othersUpdate(cars, lx, lz, lyaw, lvx, lvz, skipId) {
      if (!this.ok()) return;
      const t = this.ctx.currentTime;
      this._lx = lx;
      this._lz = lz;
      // The (up to) 5 nearest within 150 m, by insertion into reused arrays.
      // (v4.5: the old map/filter/sort/slice built a dozen objects a frame.)
      const NV = 5;
      const nc = this._nc || (this._nc = [null, null, null, null, null]);
      const nd = this._nd || (this._nd = [0, 0, 0, 0, 0]);
      let n = 0;
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (c.id === skipId) continue;
        const d = Math.hypot(c.rs.x - lx, c.rs.z - lz);
        if (d >= 150 || (n === NV && d >= nd[NV - 1])) continue;
        let k = n < NV ? n++ : NV - 1;
        while (k > 0 && nd[k - 1] > d) {
          nc[k] = nc[k - 1];
          nd[k] = nd[k - 1];
          k--;
        }
        nc[k] = c;
        nd[k] = d;
      }
      while (this.others.length < n) this.others.push(this._voice(PROFILES.vandal));
      // keep each car on the same voice while it stays near (no pitch jumps)
      let taken = 0; // bit k: nc[k] already has its voice
      for (const v of this.others) {
        v.o = null;
        if (v.id == null) continue;
        let k = 0;
        while (k < n && nc[k].id !== v.id) k++;
        if (k < n) {
          v.o = nc[k];
          v.d = nd[k];
          taken |= 1 << k;
        } else v.id = null;
      }
      for (let k = 0; k < n; k++) {
        if (taken & (1 << k)) continue;
        for (const v of this.others) {
          if (v.id != null) continue;
          v.id = nc[k].id;
          v.o = nc[k];
          v.d = nd[k];
          v.bf = false;
          break;
        }
      }
      const rx = Math.cos(lyaw), rz = -Math.sin(lyaw); // listener's "left" (+x of heading frame)
      for (const v of this.others) {
        const o = v.o;
        if (!o) {
          v.g.gain.setTargetAtTime(0, t, 0.1);
          v.lfoG.gain.setTargetAtTime(0, t, 0.06);
          v.ng.gain.setTargetAtTime(0, t, 0.06);
          v.wg.gain.setTargetAtTime(0, t, 0.06);
          for (const k of ['cng', 'amg', 'w2g', 'wlg', 'hg']) v[k].gain.setTargetAtTime(0, t, 0.06);
          continue;
        }
        const rs = o.rs;
        const car = G.Parts.CARS[o.carId] || G.Parts.CARS.vandal;
        const prof = PROFILES[car.id] || PROFILES.vandal;
        this._voiceCar(v, prof);
        const rpm = U.clamp(rs.rpm || 0.14, 0.1, 1.05);
        const dx = rs.x - lx, dz = rs.z - lz, d = v.d || 1;
        // Doppler: closing speed along the line between car and listener
        const closing = -(((rs.vx || 0) - (lvx || 0)) * dx + ((rs.vz || 0) - (lvz || 0)) * dz) / d;
        const dop = U.clamp(343 / (343 - closing), 0.82, 1.22);
        const crank = (rpm * car.redline) / 60;
        const f0 = (prof.ev ? 90 + crank * 3.2 : crank * (prof.cyl / 2)) * dop;
        v.o1.frequency.setTargetAtTime(f0, t, 0.04);
        v.lfo.frequency.setTargetAtTime(f0 / (prof.lopeDiv || 4), t, 0.05);
        v.o2.frequency.setTargetAtTime(f0 * 0.5, t, 0.04);
        v.o3.frequency.setTargetAtTime(f0 * 2, t, 0.04);
        // their mods colour their note too (exhaust / ECU / stripped shell)
        // their build's sound profile, worked out once per car (it used to be
        // recomputed for every nearby car on every frame)
        const pc = this._msCache || (this._msCache = new WeakMap());
        let oms = o.parts && pc.get(o.parts);
        if (!oms) {
          oms = modSound(o.parts, o.carId, o.look);
          if (o.parts) pc.set(o.parts, oms);
        }
        v.f.frequency.setTargetAtTime((320 + rpm * 1900 * prof.cut) * (0.8 + 0.2 * dop) * oms.cut, t, 0.05);
        v.f.Q.setTargetAtTime(1.4 * (oms.q / 1.6), t, 0.1);
        v.pk.gain.setTargetAtTime(2 + oms.q, t, 0.2);
        const thr = rs.thr ? U.clamp(rs.thr, 0.5, 1) : 0.45;
        // v5.4: heard from further off, and closer to your own engine's level
        // up close. At 20 m a car used to play at a sixth of yours.
        const fall = 1 / (1 + d / 17);
        let vg = (0.05 + 0.085 * thr) * fall * oms.loud;
        // their gearchanges: the same short dip yours makes
        if ((rs.gear || 0) > v.gear && v.gear > 0) {
          v.g.gain.cancelScheduledValues(t);
          v.g.gain.setValueAtTime(vg * 0.35, t);
        }
        v.gear = rs.gear || 0;
        // their rev limiter
        if (rpm > 0.985 && rs.thr && Math.sin(performance.now() * 0.095) < 0) vg *= oms.limHard ? 0.1 : 0.3;
        v.g.gain.setTargetAtTime(vg, t, 0.05);
        v.lfoG.gain.setTargetAtTime(vg * oms.lopeAbs, t, 0.08);
        // combustion grit, as on your own engine (none from an electric car)
        const grit = prof.ev ? 0 : Math.min(1.6, (prof.grit == null ? 1 : prof.grit) * oms.rasp);
        const rl = (0.14 + thr * 0.46) * (0.4 + 0.6 * rpm) * grit * fall;
        v.cng.gain.setTargetAtTime(rl * 0.5, t, 0.04);
        v.amg.gain.setTargetAtTime(rl * 0.5, t, 0.04);
        v.am.frequency.setTargetAtTime(f0, t, 0.03);
        v.cnf.frequency.setTargetAtTime(650 + rpm * 2400 * prof.cut + thr * 700, t, 0.05);
        // straight pipes / race maps crackle as they lift past you
        // (at most every 0.7 s per car: a bot's throttle flickers, and each
        // lift used to fire another burst of pops)
        if (!prof.ev && oms.pops > 0.4 && v.lt > 0.5 && !rs.thr && fall > 0.2 && performance.now() - (v.crT || 0) > 700) {
          v.crT = performance.now();
          if (oms.bang) this.bangBurst(fall * 0.8, 'others');
          else this.crackle(oms.pops * 0.6, fall * 0.7, oms.crackle);
        }
        // their anti-lag, banging away as they come past
        if (!prof.ev && rs.backfire > 0 && fall > 0.15) {
          const gap = 1000 / (4 + rpm * 13); // as above, a touch sparser at a distance
          if (performance.now() - (v.bfT || 0) > gap * (0.6 + Math.random() * 1.0)) {
            v.bfT = performance.now();
            const amp = fall * (0.4 + Math.random() * 0.6);
            if (Math.random() < 0.3) this.bang(amp, 'others');
            else this.pop(amp * 1.1, 'others');
          }
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
        const ind = (o.parts && o.parts.induction) || 'na';
        const okind = prof.ev ? 'ev' : G.Parts.opt('induction', ind).kind;
        const bst = rs.boost || 0;
        const fsc = crank * 14 * dop;
        v.w2.frequency.setTargetAtTime(fsc * 2, t, 0.03);
        v.wf.frequency.setTargetAtTime(900 + rpm * 3000, t, 0.04);
        v.wl.frequency.setTargetAtTime(crank * 2, t, 0.04);
        const scW = okind === 'sc' ? (0.022 + 0.06 * thr) * (0.3 + 0.7 * rpm) * fall : 0;
        v.w2g.gain.setTargetAtTime(scW * 0.5, t, 0.04);
        v.wlg.gain.setTargetAtTime(okind === 'sc' ? 0.3 : 0, t, 0.06);
        v.hg.gain.setTargetAtTime(okind === 'turbo' ? bst * (0.3 + 0.7 * thr) * (ind === 't2' ? 0.055 : 0.03) * fall : 0, t, 0.06);
        if (okind === 'ev') {
          // their inverter + reduction gear whine, rising with road speed
          const spd = Math.hypot(rs.vx || 0, rs.vz || 0);
          if (v.w.type !== 'sine') v.w.type = 'sine';
          v.w.frequency.setTargetAtTime((700 + spd * 62) * dop, t, 0.04);
          v.wg.gain.setTargetAtTime((0.01 + 0.02 * thr) * Math.min(1, spd / 6 + 0.15) * fall, t, 0.05);
        } else if (okind === 'sc') {
          if (v.w.type !== 'triangle') v.w.type = 'triangle';
          v.w.frequency.setTargetAtTime(fsc, t, 0.03); // crank-locked, like your own
          v.wg.gain.setTargetAtTime(scW, t, 0.04);
        } else if (okind === 'turbo') {
          if (v.w.type !== 'sine') v.w.type = 'sine';
          v.w.frequency.setTargetAtTime(((ind === 't2' ? 1100 : 1750) + bst * (ind === 't2' ? 2300 : 3100)) * (0.85 + 0.15 * rpm) * dop, t, 0.08);
          v.wg.gain.setTargetAtTime(bst * 0.024 * fall, t, 0.06);
          if (v.lb > 0.45 && bst < 0.25 && fall > 0.15) this.bov(oms.bov, ind === 't2', fall, 'others');
        } else v.wg.gain.setTargetAtTime(0, t, 0.06);
        v.lb = bst;
        if (rs.backfire > 0 && !v.bf && fall > 0.12) this.pop(fall * 0.8, 'others');
        v.bf = rs.backfire > 0;
      }
    },

    // Called by RaceView.apply every frame of a race view.
    race(v, world, dt) {
      const me = v.me && !v.me.finished ? v.me : null;
      this._wetEnv = world.env ? world.env.wet || (world.track && world.track.theme.rain ? 1 : 0) : 0;
      this.update(me ? me.rs : null, dt, me ? { carId: me.carId, parts: me.parts, look: me.look } : null);
      this._fed = true;
      if (!this.ok()) return;
      if (!this.env) this._startEnv();
      const c = world.cam;
      this.othersUpdate(v.cars, c.fx, c.fz, c.yaw, me ? me.rs.vx : 0, me ? me.rs.vz : 0, me ? me.id : null);
      this.ambience(world, dt);
    },

    // v5 ambience: what the place sounds like under the engines. One noise
    // source through a few beds (sea, city, rain, wind gusts) plus sparse
    // one-shots (birds by day, crickets at night, thunder in heavy rain).
    // Quiet on purpose: it fills the gaps, it never competes with the cars.
    _startAmb() {
      const c = this.ctx, a = {};
      a.src = c.createBufferSource();
      a.src.buffer = this.noise;
      a.src.loop = true;
      const bed = (type, f, q) => {
        const fl = this._filt(type, f, q), g = this._gain(0);
        a.src.connect(fl).connect(g).connect(this.bus.sfx);
        return { f: fl, g };
      };
      a.sea = bed('lowpass', 420, 0.6);
      a.city = bed('bandpass', 190, 0.5);
      a.rain = bed('highpass', 2600, 0.5);
      a.drops = bed('bandpass', 1300, 1.5);
      a.gust = bed('bandpass', 320, 0.7);
      a.src.start(0, Math.random() * 1.5);
      a.birdT = 2;
      a.bugT = 1;
      a.thunderT = 20;
      this.amb = a;
    },
    ambience(world, dt) {
      const tr = world.track;
      if (!tr || !this.ok()) return;
      if (!this.amb) this._startAmb();
      const a = this.amb, th = tr.theme, t = this.ctx.currentTime, env = world.env || {};
      const m = 1; // (the sfx bus volume applies on top)
      const night = env.night || 0, wet = th.rain ? 1 : env.wet || 0;
      this._ambT = (this._ambT || 0) + dt;
      const sw = 0.6 + 0.4 * Math.sin(this._ambT * 0.23) * Math.sin(this._ambT * 0.071 + 1);
      a.sea.g.gain.setTargetAtTime(th.sea ? 0.045 * sw * m : 0, t, 0.5);
      a.city.g.gain.setTargetAtTime(th.props === 'city' ? 0.035 * m : 0, t, 0.5);
      a.rain.g.gain.setTargetAtTime(wet * 0.04 * m, t, 0.6);
      a.drops.g.gain.setTargetAtTime(wet * 0.02 * (0.7 + 0.3 * Math.random()) * m, t, 0.1);
      // crosswind zones: gusting air when the camera is in one
      let gust = 0;
      if (tr.WZ) {
        const q = tr.query(world.cam.fx, world.cam.fz, this._ambHint == null ? -1 : this._ambHint, this._ambQ || (this._ambQ = {}));
        this._ambHint = q.i;
        const wi = tr.WZ[q.i];
        if (wi >= 0) {
          const W = tr.winds[wi];
          gust = 0.5 + 0.5 * Math.sin(((env.t || 0) * 2 * Math.PI) / W.period + W.ph);
        }
      }
      a.gust.g.gain.setTargetAtTime(gust * 0.09 * m, t, 0.25);
      a.gust.f.frequency.setTargetAtTime(260 + gust * 260, t, 0.3);
      // birds: daytime, trees about, not raining
      a.birdT -= dt;
      if (a.birdT <= 0) {
        a.birdT = 2.5 + Math.random() * 5;
        if (night < 0.35 && wet < 0.3 && th.trees && th.trees !== 'none' && th.props !== 'city') {
          const f = 2600 + Math.random() * 2200, n = 2 + Math.floor(Math.random() * 3);
          for (let i = 0; i < n; i++) this.tone(f * (1 + (Math.random() - 0.5) * 0.25), 0.07, 'sine', 0.012, f * (1.15 + Math.random() * 0.3), 'sfx', i * 0.11);
        }
      }
      // crickets: warm nights away from the city
      a.bugT -= dt;
      if (a.bugT <= 0) {
        a.bugT = 0.7 + Math.random() * 0.9;
        if (night > 0.5 && wet < 0.4 && th.props !== 'city') for (let i = 0; i < 3; i++) this.tone(4300 + Math.random() * 300, 0.03, 'sine', 0.008, 0, 'sfx', i * 0.06);
      }
      // thunder in a real downpour
      a.thunderT -= dt;
      if (a.thunderT <= 0) {
        a.thunderT = 25 + Math.random() * 40;
        if (wet > 0.8) {
          this.noiseHit(3.2, 160, 0.3, 'lowpass', 'sfx', 0, 60, 0.7);
          this.noiseHit(0.4, 900, 0.08, 'bandpass', 'sfx', 0, 300, 1);
        }
      }
    },
    _silenceAmb() {
      const a = this.amb;
      if (!a || !this.ctx) return;
      const t = this.ctx.currentTime;
      for (const k of ['sea', 'city', 'rain', 'drops', 'gust']) a[k].g.gain.setTargetAtTime(0, t, 0.3);
    },

    // --------------------------------------------------------- one-shots
    // v5 horn: a two-note chord per car (the kei beeps, the truck blares, the
    // EV chirps), louder the nearer it is. vol 0..1.
    horn(carId, vol) {
      if (!this.ok() || !(vol > 0.02)) return;
      const H = {
        vandal: [410, 520, 'square'], brick: [500, 630, 'square'], sting: [560, 705, 'square'], mule: [300, 380, 'sawtooth'],
        pip: [640, 800, 'square'], dune: [250, 315, 'sawtooth'], apex: [470, 590, 'square'], volt: [620, 780, 'triangle'], storm: [440, 555, 'sawtooth'],
        regent: [350, 440, 'sawtooth'], rotor: [520, 655, 'square'],
      }[carId] || [410, 520, 'square'];
      const c = this.ctx, t = c.currentTime, dur = 0.42;
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 2600;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09 * vol, t + 0.02);
      g.gain.setValueAtTime(0.09 * vol, t + dur - 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      f.connect(g);
      g.connect(this.bus.sfx);
      for (const fr of [H[0], H[1]]) {
        const o = c.createOscillator();
        o.type = H[2];
        o.frequency.value = fr;
        o.detune.value = (Math.random() - 0.5) * 8;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.02);
      }
    },

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
      // a soft tick for the long count, the full beep with each start light
      if (n > 5) this.tone(440, 0.07, 'sine', 0.035);
      else if (n > 0) {
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
      // v5 layers: a hard hit breaks glass, then bits of car bounce away
      if (k > 0.7) this.glass(k);
      if (k > 0.5) for (let i = 0; i < 3; i++) this.noiseHit(0.05, 700 + Math.random() * 900, 0.08 * k * (1 - i * 0.25), 'bandpass', 'sfx', 0.18 + i * (0.12 + Math.random() * 0.1), 0, 5);
    },
    // v5: shattering glass — bright random pings and a shimmer of fine noise
    glass(k) {
      if (!this.ok()) return;
      for (let i = 0; i < 6; i++) this.tone(2600 + Math.random() * 3800, 0.08 + Math.random() * 0.2, 'sine', 0.018 * k, 0, 'sfx', 0.03 + Math.random() * 0.25);
      this.noiseHit(0.5, 6500, 0.08 * k, 'highpass', 'sfx', 0.02, 9000);
    },
    // v5: hitting water
    splash(k) {
      if (!this.ok() || k < 0.05) return;
      this.noiseHit(0.55, 700, 0.3 * k, 'lowpass', 'sfx', 0, 2400, 0.8);
      this.noiseHit(0.35, 3200, 0.1 * k, 'highpass', 'sfx', 0.05);
    },
    // v5 hazards: a boulder landing (rumble + crack), a wrecking ball swishing past
    rockImpact(k) {
      if (!this.ok() || k < 0.03) return;
      this.noiseHit(0.9, 140, 0.5 * k, 'lowpass', 'sfx', 0, 60);
      this.tone(48, 0.5, 'sine', 0.35 * k, 32);
      this.noiseHit(0.12, 1800, 0.18 * k, 'bandpass', 'sfx', 0, 700, 2);
      for (let i = 0; i < 4; i++) this.noiseHit(0.06, 900 + Math.random() * 700, 0.06 * k, 'bandpass', 'sfx', 0.2 + i * 0.13, 0, 4);
    },
    // v5.4 level crossing: a two-tone air horn and the rumble of the train
    trainHorn(k) {
      if (!this.ok() || k < 0.03) return;
      for (const f of [311, 370]) {
        this.tone(f, 1.1, 'sawtooth', 0.05 * k);
        this.tone(f, 0.5, 'sawtooth', 0.045 * k, 0, 'sfx', 1.3);
      }
      this.noiseHit(3.2, 90, 0.35 * k, 'lowpass', 'sfx', 0.2, 60);
    },
    whoosh(k) {
      if (!this.ok() || k < 0.03) return;
      this.noiseHit(0.7, 300, 0.2 * k, 'bandpass', 'sfx', 0, 1100, 1.2);
    },
    // v5 pit crew: wheel gun, jack, fuel hose
    pitGun() {
      if (!this.ok()) return;
      for (let i = 0; i < 9; i++) this.noiseHit(0.018, 2400, 0.16, 'bandpass', 'sfx', i * 0.028, 0, 3);
      this.tone(210, 0.26, 'square', 0.04, 160, 'sfx');
    },
    pitJack(up) {
      if (!this.ok()) return;
      this.noiseHit(0.12, 300, 0.3, 'lowpass', 'sfx');
      this.tone(up ? 90 : 120, 0.12, 'square', 0.08, up ? 140 : 70, 'sfx', 0.02);
    },
    fuel(on) {
      if (!this.ok()) return;
      if (on && !this._fuelN) {
        const c = this.ctx, s = c.createBufferSource(), f = this._filt('bandpass', 380, 2.2), g = this._gain(0), l = this._osc('sine', 6), lg = this._gain(0.035);
        s.buffer = this.noise;
        s.loop = true;
        l.connect(lg).connect(g.gain);
        s.connect(f).connect(g).connect(this.bus.sfx);
        g.gain.setTargetAtTime(0.07, c.currentTime, 0.05);
        s.start();
        l.start();
        this._fuelN = { s, l, g };
      } else if (!on && this._fuelN) {
        const n = this._fuelN, t = this.ctx.currentTime;
        n.g.gain.setTargetAtTime(0, t, 0.04);
        setTimeout(() => { try { n.s.stop(); n.l.stop(); } catch (e) {} }, 300);
        this._fuelN = null;
        this.tone(1100, 0.05, 'square', 0.05, 800, 'sfx'); // nozzle click
      }
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
    // `dense` (the crackle tune): more cracks, spread over longer, and
    // quieter individually - a rattle rather than a handful of bangs.
    crackle(amount, m, dense) {
      const now = performance.now();
      if (now - (this._crT || 0) < 150) return; // several cars lifting at once: one burst is plenty
      this._crT = now;
      const n = dense ? 7 + Math.round(amount * 9) : 2 + Math.round(amount * 4);
      const span = dense ? 0.8 : 0.49;
      for (let i = 0; i < n; i++) {
        const w = 0.04 + Math.random() * span;
        const a = dense ? 0.2 + Math.random() * 0.35 : 0.35 + Math.random() * 0.5;
        setTimeout(() => this.pop(a * (m || 1)), w * 1000);
      }
    },
    // v4 garage "Listen": rev the engine with a given build for ~2.4 s —
    // idle blip, a pull to the limiter, then lift (so pops, blow-off and the
    // exhaust's character are all heard). Uses the real engine voice.
    revDemo(carId, parts, look) {
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
        rs.backfire = !thr && s > 1.9 && rs.rpm > 0.3 ? 0.1 : 0; // overrun: let a bang/anti-lag tune be heard
        const bt = thr * G.Parts.boostAvail(spec, rs.rpm);
        rs.boost += (bt - rs.boost) * Math.min(1, dt / (bt > rs.boost ? spec.boostLag : 0.12));
        this.update(rs, dt, { carId, parts, look, demo: true });
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
    // v5.3 vented to atmosphere: shorter, sharper, much louder than a recirc
    blowoffAtmo(m, bus) {
      this.noiseHit(0.26, 4200, 0.34 * (m || 1), 'bandpass', bus || 'sfx', 0, 900, 1.8);
      this.noiseHit(0.5, 6800, 0.15 * (m || 1), 'highpass', bus || 'sfx', 0.02, 2200);
    },
    // The valve a player picked, with the turbo's own character as the default.
    bov(kind, big, m, bus) {
      if (kind === 'atmo') return this.blowoffAtmo(m, bus);
      if (kind === 'flutter') return this.flutter(m, bus);
      return big ? this.flutter(m, bus) : this.blowoff(m, bus);
    },
    // v5.3 anti-lag / bang tune: a hard crack with real bottom end, not the
    // little pop used for an overrun crackle. Three layers - the body of it,
    // a low thump you feel, and a sharp transient on top so it cuts through
    // the engine note rather than sitting under it.
    bang(m, bus) {
      const k = m || 1;
      this.noiseHit(0.16, 520, 0.95 * k, 'bandpass', bus || 'sfx', 0, 0, 1.4);
      this.tone(54, 0.15, 'square', 0.52 * k, 28, bus || 'sfx');
      this.noiseHit(0.05, 3200, 0.42 * k, 'highpass', bus || 'sfx', 0, 1500);
    },
    // The bang-pop map on a lift: one hard crack, then a scatter of smaller
    // ones chasing it down. A single bang was what made this option feel like
    // nothing was fitted.
    bangBurst(m, bus) {
      const k = m || 1;
      this.bang(k, bus);
      const n = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) {
        const w = 0.06 + Math.random() * 0.55;
        const hard = Math.random() < 0.4;
        setTimeout(() => (hard ? this.bang(k * (0.45 + Math.random() * 0.4), bus) : this.pop(k * (0.5 + Math.random() * 0.5), bus)), w * 1000);
      }
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
    // v4.5: session notifications — toasts (ui.js) and system lines in the
    // chat (chat.js: someone joined / left / took over as host, the room is
    // about to close). Each one is recognisable without looking.
    notify(kind) {
      const now = performance.now();
      if (now - (this._ntT || 0) < 120) return; // two at once: one is plenty
      this._ntT = now;
      const T = (f, d, ty, v, sl, w) => this.tone(f, d, ty, v, sl, 'ui', w);
      if (kind === 'request') {
        // someone at the door: two knocks, then a bell
        this.noiseHit(0.07, 420, 0.22, 'bandpass', 'ui', 0, 0, 3);
        this.noiseHit(0.07, 400, 0.2, 'bandpass', 'ui', 0.15, 0, 3);
        T(1568, 0.55, 'sine', 0.07, 0, 0.33);
        T(2349, 0.45, 'sine', 0.035, 0, 0.33);
        T(3136, 0.3, 'sine', 0.015, 0, 0.33);
      } else if (kind === 'join') {
        T(784, 0.12, 'triangle', 0.06);
        T(1175, 0.22, 'triangle', 0.06, 0, 0.09);
      } else if (kind === 'leave') {
        T(880, 0.12, 'triangle', 0.045);
        T(587, 0.24, 'triangle', 0.045, 0, 0.1);
      } else if (kind === 'drop') {
        // lost connection: a falling tone that breaks up
        T(740, 0.09, 'square', 0.035);
        T(523, 0.07, 'square', 0.03, 0, 0.11);
        T(392, 0.24, 'triangle', 0.045, 260, 0.2);
        this.noiseHit(0.12, 2600, 0.03, 'bandpass', 'ui', 0.1, 0, 2);
      } else if (kind === 'host') {
        [659, 880, 1109, 1319].forEach((f, i) => T(f, 0.16, 'square', 0.035, 0, i * 0.07));
      } else if (kind === 'warn') {
        T(330, 0.18, 'square', 0.05);
        T(330, 0.18, 'square', 0.05, 0, 0.24);
        T(247, 0.32, 'square', 0.05, 0, 0.48);
      } else if (kind === 'notify') {
        T(1320, 0.1, 'sine', 0.05);
        T(1760, 0.18, 'sine', 0.04, 0, 0.08);
      } else T(1500, 0.05, 'sine', 0.03, 1900); // info: a soft blip
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
    // v5: 0..1 — the race turns the song up on the final lap
    musicIntensity(k) {
      Music.intensity = U.clamp(k || 0, 0, 1);
    },
  };

  // ======================================================================
  // Music: a 16-step sequencer with look-ahead scheduling. Chords, bass, an
  // arpeggio, a seeded melody hook and drums — all oscillators + noise.
  // v5: songs have sections (intro → drop → breakdown → build, every 16
  // bars), a tempo-synced echo on the lead and arp, pads that pump against
  // the kick, drum fills, and an `intensity` the race turns up on the final
  // lap (open filters, 16th hats, the hook an octave up).
  // ======================================================================
  const SONGS = {
    // v5.1: the menu, garage and results themes were the only music left from
    // v4 — four bars on a loop with no sections, no echo and no pump, next to
    // race songs that had all three. They are rewritten here on eight-chord
    // progressions with the same machinery the race songs use, so the game
    // sounds like one record from the title screen on.
    //
    // A minor over eight bars, i–VI–III–VII then i–iv–VI–V: the title theme
    menu: { bpm: 118, prog: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62], [57, 60, 64], [50, 53, 57], [53, 57, 60], [52, 56, 59]], drums: 'drive', arp: 1, lead: 1, sections: 1, pump: 1, wide: 1, bright: 1, scale: [0, 2, 3, 7, 10], bassPat: [1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0], octBass: 1 },
    // Dm7–G7–Cmaj7–Am7 then Fmaj7–Em7–A7–Dm7: the garage, eight bars of
    // shop-floor jazz-house with wide pads and a hook that comes and goes
    garage: { bpm: 94, prog: [[50, 53, 57, 60], [55, 59, 62, 65], [48, 52, 55, 59], [45, 48, 52, 55], [53, 57, 60, 64], [52, 55, 59, 62], [57, 61, 64, 67], [50, 53, 57, 60]], drums: 'soft', arp: 0, keys: 1, lead: 1, sections: 1, wide: 1, scale: [0, 2, 5, 7, 9], bassPat: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0] },
    // C–G–Am–F twice, the second time round through iv and V: the champion
    final: { bpm: 126, prog: [[48, 52, 55], [55, 59, 62], [57, 60, 64], [53, 57, 60], [48, 52, 55], [53, 57, 60], [50, 53, 57], [55, 59, 62]], drums: 'four', arp: 1, lead: 1, bright: 1, sections: 1, pump: 1, wide: 1, scale: [0, 2, 4, 7, 9], bassPat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1] },
    // v5 race songs (Settings: Music during races)
    // E minor, i–VI–III–VII at 128: four-on-the-floor, octave-pumping bass
    race: { bpm: 128, prog: [[52, 55, 59], [48, 52, 55], [55, 59, 62], [50, 54, 57]], drums: 'drive', arp: 1, lead: 1, bright: 1, sections: 1, pump: 1, scale: [0, 3, 5, 7, 10], bassPat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], octBass: 1 },
    // F# minor synthwave at 100 for night tracks: big gated snare, wide saw pads
    night: { bpm: 100, prog: [[54, 57, 61, 64], [50, 54, 57, 61], [57, 61, 64, 68], [52, 56, 59, 63]], drums: 'wave', arp: 1, lead: 1, sections: 1, pump: 1, wide: 1, scale: [0, 3, 5, 7, 10], bassPat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0], octBass: 1 },
    // D dorian breakbeat at 140 for dirt, gravel and snow
    rally: { bpm: 140, prog: [[50, 53, 57], [55, 59, 62], [50, 53, 57], [48, 52, 55]], drums: 'break', arp: 1, lead: 1, sections: 1, scale: [0, 2, 3, 7, 9], bassPat: [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1] },
    // v5.1 street circuits: D minor at 134, half-time kick, snarling saw bass —
    // walls close either side and no room to breathe
    street: { bpm: 134, prog: [[50, 53, 57], [57, 60, 64], [48, 52, 55], [55, 58, 62]], drums: 'wave', arp: 1, lead: 1, sections: 1, pump: 1, bright: 1, scale: [0, 3, 5, 6, 10], bassPat: [1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 0], octBass: 1 },
    // A minor at 116, steady and long-breathed for endurance races
    endurance: { bpm: 116, prog: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62], [57, 60, 64], [50, 53, 57], [53, 57, 60], [52, 56, 59]], drums: 'drive', arp: 1, lead: 1, sections: 1, pump: 1, scale: [0, 2, 3, 7, 8], bassPat: [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0] },
  };
  const Music = {
    cur: null,
    timer: null,
    step: 0,
    next: 0,
    gain: null,
    intensity: 0, // v5: 0..1, the final lap turns it up
    play(name) {
      const A = Audio;
      if (!name || !SONGS[name]) return this.stop();
      if (this.cur === name) return;
      if (!A.ok()) return;
      this.stop();
      const c = A.ctx;
      this.cur = name;
      this.song = SONGS[name];
      this.intensity = 0;
      this.gain = c.createGain();
      this.gain.gain.value = 0.0001;
      this.gain.gain.exponentialRampToValueAtTime(1, c.currentTime + 1.2);
      this.gain.connect(A.bus.music);
      // pads through their own gain (pumped against the kick)
      this.pad = c.createGain();
      this.pad.connect(this.gain);
      // echo: 3/16 of a beat-bar, filtered, fed back
      const beat = 60 / this.song.bpm;
      this.dly = c.createDelay(2);
      this.dly.delayTime.value = beat * 0.75;
      this.fb = c.createGain();
      this.fb.gain.value = 0.32;
      const df = c.createBiquadFilter();
      df.type = 'lowpass';
      df.frequency.value = 2600;
      this.send = c.createGain();
      this.send.gain.value = 0.35;
      this.send.connect(this.dly);
      this.dly.connect(df);
      df.connect(this.fb);
      this.fb.connect(this.dly);
      df.connect(this.gain);
      this.step = 0;
      this.next = c.currentTime + 0.1;
      this.rng = U.rng(U.hashStr(name));
      this.hook = [];
      for (let i = 0; i < 32; i++) this.hook.push(this.rng() < 0.42 ? Math.floor(this.rng() * 5) : -1);
      this.timer = setInterval(() => this._schedule(), 30);
    },
    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (this.gain && Audio.ctx) {
        const g = this.gain, t = Audio.ctx.currentTime, fb = this.fb;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        setTimeout(() => {
          try {
            g.disconnect();
            if (fb) fb.disconnect();
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
    _note(m, t, dur, type, v, cut, dest, echo) {
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
      g.connect(dest || this.gain);
      if (echo && this.send) g.connect(this.send);
      o.start(t);
      o.stop(t + dur + 0.05);
      return o;
    },
    _drum(kind, t, vel) {
      const c = Audio.ctx;
      const k = vel == null ? 1 : vel;
      if (kind === 'kick') {
        const o = c.createOscillator(), g = c.createGain();
        o.frequency.setValueAtTime(150, t);
        o.frequency.exponentialRampToValueAtTime(42, t + 0.22);
        g.gain.setValueAtTime(0.5 * k, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.connect(g).connect(this.gain);
        o.start(t);
        o.stop(t + 0.32);
        // pads duck under the kick (the "pump")
        if (this.song.pump && this.pad) {
          this.pad.gain.setValueAtTime(0.35, t);
          this.pad.gain.linearRampToValueAtTime(1, t + 0.22);
        }
        return;
      }
      const s = c.createBufferSource();
      s.buffer = Audio.noise;
      const f = c.createBiquadFilter();
      const g = c.createGain();
      if (kind === 'snare' || kind === 'gate') {
        f.type = 'bandpass';
        f.frequency.value = kind === 'gate' ? 1500 : 1900;
        const len = kind === 'gate' ? 0.32 : 0.16;
        g.gain.setValueAtTime(0.22 * k, t);
        if (kind === 'gate') g.gain.setValueAtTime(0.18 * k, t + len - 0.02); // gated: holds, then chops
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        s.connect(f).connect(g).connect(this.gain);
        s.start(t, Math.random());
        s.stop(t + len + 0.05);
        const o = c.createOscillator(), og = c.createGain(); // body
        o.frequency.setValueAtTime(220, t);
        o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
        og.gain.setValueAtTime(0.12 * k, t);
        og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
        o.connect(og).connect(this.gain);
        o.start(t);
        o.stop(t + 0.12);
        return;
      }
      f.type = 'highpass';
      f.frequency.value = 7000;
      g.gain.setValueAtTime((kind === 'hatO' ? 0.07 : 0.045) * k, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'hatO' ? 0.14 : 0.04));
      s.connect(f).connect(g).connect(this.gain);
      s.start(t, Math.random());
      s.stop(t + 0.2);
    },
    _step(n, t, sp) {
      const S_ = this.song;
      const st = n % 16, barN = Math.floor(n / 16), bar = barN % S_.prog.length;
      const ch = S_.prog[bar];
      const I = this.intensity || 0;
      // sections (16-bar cycle): 0-1 intro, 2-11 drop, 12-13 breakdown, 14-15 build
      const sec = S_.sections ? barN % 16 : 5;
      const intro = sec < 2, breakdown = sec === 12 || sec === 13, build = sec >= 14;
      const fillBar = barN % 4 === 3 && st >= 12;
      // drums
      if (!breakdown) {
        if (S_.drums === 'four') {
          if (st % 4 === 0) this._drum('kick', t);
          if ((st === 4 || st === 12) && !intro) this._drum('snare', t);
          if (st % 2 === 1) this._drum(st === 7 || st === 15 ? 'hatO' : 'hat', t);
        } else if (S_.drums === 'drive') {
          if (st % 4 === 0) this._drum('kick', t);
          if ((st === 4 || st === 12) && !intro) this._drum('snare', t);
          if (!intro && (st % 2 === 1 || I > 0.5)) this._drum(st % 4 === 2 ? 'hatO' : 'hat', t, st % 2 ? 1 : 0.6);
          if (fillBar && !build && st % 2 === 0) this._drum('snare', t, 0.5 + st / 32);
        } else if (S_.drums === 'wave') {
          if (st === 0 || st === 8 || st === 11) this._drum('kick', t);
          if ((st === 4 || st === 12) && !intro) this._drum('gate', t);
          if (st % 2 === 0) this._drum('hat', t, 0.7);
        } else if (S_.drums === 'break') {
          if (st === 0 || st === 10 || (st === 7 && barN % 2)) this._drum('kick', t);
          if ((st === 4 || st === 12 || (st === 15 && barN % 2)) && !intro) this._drum('snare', t, st === 15 ? 0.5 : 1);
          if (st % 2 === 0 || I > 0.5) this._drum(st === 14 ? 'hatO' : 'hat', t, 0.8);
        } else {
          if (st === 0 || st === 10) this._drum('kick', t);
          if (st === 8) this._drum('snare', t);
          if (st % 4 === 2) this._drum('hat', t);
        }
        // build: a snare roll that tightens and rises
        if (build && sec === 15 && (st % 2 === 0 || st >= 8)) this._drum('snare', t, 0.35 + st / 20);
      }
      // bass
      if (S_.bassPat[st] && !breakdown) {
        const oct = S_.octBass && st % 2 ? 12 : 0;
        this._note(ch[0] - 12 + oct + (st === 14 && !S_.octBass ? 12 : 0), t, sp * (S_.octBass ? 0.9 : 1.8), 'sawtooth', S_.octBass ? 0.07 : 0.09, 420 + I * 400);
      }
      // pad / keys on the bar
      if (st === 0) {
        const padV = (S_.keys ? 0.035 : 0.018) * (breakdown ? 1.4 : 1);
        for (const m of ch) {
          this._note(m, t, sp * 15, S_.keys ? 'triangle' : 'sawtooth', padV, S_.keys ? 2200 : 1100 + I * 900, this.pad);
          if (S_.wide) this._note(m + 0.12, t, sp * 15, 'sawtooth', padV * 0.7, 1300, this.pad).detune.value = 14;
        }
      }
      if (S_.keys && (st === 6 || st === 10)) for (const m of ch.slice(1)) this._note(m + 12, t, sp * 2.5, 'sine', 0.025);
      // arpeggio (16ths at full intensity or in a breakdown)
      if (S_.arp && !intro && (st % 2 === 0 || I > 0.5 || breakdown || S_.drums === 'drive')) {
        const m = ch[st % ch.length] + 12 + (Math.floor(st / ch.length) % 2 ? 12 : 0);
        this._note(m, t, sp * 0.9, 'square', 0.016, (S_.bright ? 3200 : 2000) + I * 1500, null, true);
      }
      // melody hook (seeded, repeats every 2 bars) — sits out the intro and
      // breakdown, jumps an octave at full intensity
      if (S_.lead && !intro && !breakdown) {
        const h = this.hook[n % 32];
        if (h >= 0 && st % 2 === 0) {
          const scale = S_.scale || [0, 2, 3, 5, 7];
          const m = ch[0] + 24 + scale[h] + (I > 0.7 ? 12 : 0);
          this._note(m, t, sp * 1.9, 'triangle', 0.035, 0, null, true);
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
