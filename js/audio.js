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
    // v5.5.6: each one now moves what you would actually notice on a real
    // car, by enough to hear it (tools/harness/soundlab.py measures them).
    // Before, Deep / Raspy / Standard nudged a few gains that the filter
    // after them mostly undid: they measured within 13 Hz of each other.
    //   deep : a resonated, big-bore note - the filter closes right down, the
    //          pipe rings an octave lower and harder, the half-order and the
    //          drone come up, less combustion hiss
    //   rasp : a hard, tinny note - the filter opens, the ring moves up, much
    //          more distortion and combustion grit, less bass
    //   loud : the same note, louder and freer everywhere (and on the overrun)
    let cutK = 1, resK = 1, resG = 0, gritK = 1, noiseK = 1;
    if (L.tone === 'deep') { sub *= 2.2; rasp *= 0.6; drone += 0.35; cutK = 0.6; resK = 0.58; resG = 5; gritK = 0.5; noiseK = 0.7; }
    else if (L.tone === 'rasp') { rasp *= 2.3; sub *= 0.5; cutK = 1.6; resK = 1.75; resG = 3; gritK = 1.8; noiseK = 1.4; }
    else if (L.tone === 'loud') { loud *= 1.45; rasp *= 1.15; sub *= 1.2; cutK = 1.18; resG = 2; gritK = 1.3; }

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
      loud, rasp, q: ex.q, cut: ex.cut, drone, sub, lope, lopeAbs, cutK, resK, resG, gritK, noiseK,
      lopeCam: L.idle === 'lope', quiet: L.over === 'quiet',
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

  // v5.5.5: every voice re-sends its ramp targets every frame, and most of
  // them haven't moved (a gain sitting at 0, a filter that only changes with
  // the car's parts, an engine note held on a straight). A joiner's page
  // made 15,000-18,000 of these calls a second, each one handed to the audio
  // thread. A target already on its way to (nearly) the same value is now
  // left alone: within 0.2% (a few cents of pitch, a hundredth of a
  // decibel), same time constant. Anything else that touches the parameter
  // (a set value, a ramp, a cancel, .value =) clears the memory, so those
  // keep working exactly as before.
  if (typeof AudioParam !== 'undefined' && !AudioParam.prototype._ssOnce) {
    const AP = AudioParam.prototype, setT = AP.setTargetAtTime;
    AP._ssOnce = true;
    AP.setTargetAtTime = function (v, t, tc) {
      const l = this._ssV;
      if (l !== undefined && tc === this._ssC && Math.abs(v - l) <= Math.abs(l) * 0.002 + 1e-5) return this;
      this._ssV = v;
      this._ssC = tc;
      return setT.call(this, v, t, tc);
    };
    for (const k of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime', 'setValueCurveAtTime']) {
      const f = AP[k];
      if (f)
        AP[k] = function () {
          this._ssV = undefined;
          return f.apply(this, arguments);
        };
    }
    const d = Object.getOwnPropertyDescriptor(AP, 'value');
    if (d && d.set && d.configurable)
      Object.defineProperty(AP, 'value', {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set(v) {
          this._ssV = undefined;
          d.set.call(this, v);
        },
      });
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
      // v5.5.5: sound is scheduled only while the audio is really RUNNING.
      // Before the first click or key (the browser's autoplay rule), or when
      // the audio device goes away, the context sits suspended and plays
      // nothing - but the engine, tyre and wind voices kept scheduling a few
      // thousand ramps a second into it. Nothing ever used them up, so each
      // new one cost more than the last: a few minutes in, a Chromebook
      // spent whole seconds per frame on sound it wasn't playing, froze, and
      // the host timed it out. (A context can also say "running" with its
      // clock stuck: that counts as not running.)
      const c = this.ctx, now = performance.now();
      if (c.state !== 'running') {
        if (c.state === 'suspended' && now - (this._resumeT || 0) > 1000) {
          this._resumeT = now; // (at most once a second: each call is a promise)
          c.resume().catch(() => {});
        }
        return false;
      }
      if (c.currentTime !== this._ctT) {
        this._ctT = c.currentTime;
        this._ctAt = now;
      } else if (now - this._ctAt > 1000) return false;
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
      this._fxProf = prof; // (the overrun / valve one-shots are voiced for this engine)
      // firing frequency: crank revs per second * cylinders/2
      const crank = (rpm * car.redline) / 60;
      let f0 = crank * (prof.cyl / 2);
      if (prof.ev) f0 = 90 + crank * 3.2; // v5 EV: the motor's electrical order, climbing with speed
      // v4.5: a real idle hunts a little instead of sitting on one pitch
      if (rpm < 0.3) f0 *= 1 + (0.3 - rpm) * (Math.sin(this._limT * 2.3) * 0.05 + Math.sin(this._limT * 6.1) * 0.025);
      // v5.5.6 lopey cam: an idle that goes "lump-lump-lump" - the note sags
      // and drops in pitch once every third turn of the crank (3-6 times a
      // second at idle; slower than a V8's own burble, so it is heard on top
      // of it), by a different amount each time, then picks up again. It
      // fades out as the revs come up.
      let chop = 1;
      if (ms.lopeCam && !prof.ev && rpm < 0.36 && thr < 0.35) {
        this._lopePh = (this._lopePh || 0) + dt * (crank / 3);
        if (this._lopePh >= 1) {
          this._lopePh %= 1;
          this._lopeK = 0.15 + Math.random() * 0.35;
        }
        const w = U.clamp((0.36 - rpm) / 0.14, 0, 1);
        const dip = this._lopePh < 0.6 ? Math.sin((this._lopePh / 0.6) * Math.PI) : 0;
        chop = 1 - w * dip * (1 - (this._lopeK || 0.4));
        f0 *= 1 - w * dip * 0.08;
      }
      // v5.5.6 rev limiter, soft and hard now different things (they were the
      // same 15 Hz wobble at two depths):
      //   soft : fuel trim - a smooth "wah-wah" about 7 times a second, the
      //          note hovering just under the limit
      //   hard : ignition cut - dead-silent gaps about 11 times a second, the
      //          note dropping in each gap and snapping back ("brap-brap"),
      //          and a spit in the pipe on the cut if it flows
      this._limT += dt;
      let limG = 1;
      if (rpm > 0.985 && thr > 0.5 && rs.gear > 0 && !prof.ev) {
        if (ms.limHard) {
          const cut = (this._limT * 11) % 1 < 0.42;
          if (cut) {
            limG = 0.02;
            f0 *= 0.95;
            if (!this._limCut && ms.pops > 0) this.snap(master * (0.35 + Math.random() * 0.3), prof);
          }
          this._limCut = cut;
        } else {
          const w = 0.5 + 0.5 * Math.sin(this._limT * 2 * Math.PI * 7);
          limG = 0.5 + 0.5 * w;
          f0 *= 0.991 + 0.009 * w;
        }
      }
      e.o1.frequency.setTargetAtTime(f0, t, 0.025);
      e.o2.frequency.setTargetAtTime(f0 * 0.5, t, 0.025);
      e.o3.frequency.setTargetAtTime(f0 * 2, t, 0.025);
      e.lfo.frequency.setTargetAtTime(f0 / (prof.lopeDiv || 4), t, 0.05);
      const loud = ms.loud;
      e.f.frequency.setTargetAtTime((350 + rpm * 2300 * prof.cut + thr * 1300) * ms.cut * ms.cutK, t, 0.04);
      const over = thr < 0.1 && rpm > 0.3; // lifted at speed: the overrun
      let g = (0.04 + thr * 0.075) * loud * master * (rs.nosOn ? 1.25 : 1) * (over ? (ms.quiet ? 0.55 : 0.8) : 1) * chop * limG * (this._gurgle || 1);
      // v4.5 combustion rasp (see _startEngine): gritty under load, a softer
      // burble on the overrun; stronger for rougher engines and freer pipes
      const grit = prof.ev ? 0 : Math.min(1.6, (prof.grit == null ? 1 : prof.grit) * ms.rasp) * ms.gritK; // (v5: an EV has no combustion to rasp)
      const rl = (0.14 + thr * 0.46 + (over ? (0.16 * ms.lope + ms.lopeAbs * 0.5) * (ms.quiet ? 0.3 : 1) : 0)) * (0.4 + 0.6 * rpm) * grit * chop * limG;
      e.cng.gain.setTargetAtTime(rl * 0.5, t, 0.04);
      e.amg.gain.setTargetAtTime(rl * 0.5, t, 0.04);
      e.am.frequency.setTargetAtTime(f0, t, 0.025);
      e.cnf.frequency.setTargetAtTime((650 + rpm * 2400 * prof.cut + thr * 700) * ms.noiseK, t, 0.05);
      // exhaust body: a freer pipe rings higher and harder
      e.pk.frequency.setTargetAtTime((prof.res || 400) * (ms.q > 3 ? 1.15 : ms.q > 2 ? 1.05 : 0.9) * ms.resK, t, 0.2);
      e.pk.gain.setTargetAtTime(2.5 + ms.q * 1.1 + ms.resG, t, 0.2);
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
      // (rev limiter: see above - v5.5.6)
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
      // (a lope or a limiter cut has to land within a frame, or the 30 ms
      // smoothing turns it back into a gentle wobble)
      e.amp.gain.setTargetAtTime(g, t, chop < 1 || limG < 1 ? 0.005 : 0.03);
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
      // v5.5.6: the valve opens when you LIFT with boost up - the throttle
      // closing is what makes a real one blow. It used to wait for boost to
      // fall from 0.45 to 0.25 inside one frame, which it never does (it
      // decays over a tenth of a second): the valve you picked was never
      // heard at all, in the race or in the garage.
      //
      // v5.5.7: ...and a lift is now "the pedal was down within the last 0.4 s
      // and is up now". The physics eases the pedal, so a real lift takes
      // several frames; the old test wanted all of it inside ONE frame, which
      // only the garage's Listen ever did (it drops the pedal instantly). In a
      // race the valve, the lift crackle, burble and bangs almost never fired.
      const lift = this._liftCheck(thr);
      this._bPk = Math.max(b, (this._bPk || 0) * Math.exp(-dt / 0.35));
      if (kind === 'turbo' && lift && this._bPk > 0.28 && performance.now() - (this._bovT || 0) > 350) {
        this._bovT = performance.now();
        this.bov(ms.bov, big, master * (0.55 + 0.45 * Math.min(1, this._bPk)), null, prof);
      }
      if (kind === 'sc' && lift && rpm > 0.4) this.noiseHit(0.3, 1800, 0.08 * master, 'bandpass', 'sfx', 0, 600, 0.8);
      this._lastBoost = b;
      // overrun crackle (free-flowing exhausts), backfire pops on shifts
      const pops = ms.pops;
      const lifting = lift && rpm > 0.45;
      if (lifting) this._ovT = performance.now(); // an overrun starts HERE and is over in a couple of seconds
      if (thr > 0.25) this._ovT = 0; // back on the throttle: it is over now
      if (lifting && pops > 0 && !ms.crackle && !ms.burble) (ms.bang ? this.bangBurst(master, null, prof) : this.crackle(pops, master, false, null, prof));
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
          if (Math.random() < 0.22 + rpm * 0.3) this.bang(amp, null, prof);
          else this.pop(amp * 1.15, null, prof);
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
          if (Math.random() < 0.45 * fade) this.bang(amp, null, prof);
          else this.pop(amp * 1.2, null, prof);
        }
      }
      // v5.5.6 crackle and burble tunes, both for the whole overrun and both
      // voiced for THIS engine (a V8's burble is a deep gurgle, a four's a
      // rattle). They were two slightly different handfuls of the same pop.
      //   crackle: fast, dry, bright snaps like a fire catching - 15-35 a
      //            second, often in twos and threes, thinning as it dies
      //   burble : a low, wet "brap-ap-ap" - soft rounded thumps a few to a
      //            dozen a second, and the engine note itself gurgles between
      //            them - lasting longer, right down to near idle
      this._gurgle = 1;
      if (!prof.ev && thr < 0.12 && speed > 1 && this._ovT) {
        if (ms.crackle && ovAge < OVERRUN && rpm > 0.3) {
          const fade = 1 - ovAge / OVERRUN, rate = (15 + 20 * rpm) * fade;
          if (Math.random() < rate * dt) {
            const n = Math.random() < 0.4 ? 2 + Math.floor(Math.random() * 2) : 1;
            for (let i = 0; i < n; i++) this.snap(master * (0.3 + Math.random() * 0.7) * (0.5 + 0.5 * fade), prof, null, i * (0.012 + Math.random() * 0.02));
          }
        }
        if (ms.burble && ovAge < OVERRUN * 1.6 && rpm > 0.2) {
          const fade = 1 - ovAge / (OVERRUN * 1.6);
          if (now - (this._buT || 0) > (1000 / (5 + 9 * rpm)) * (0.5 + Math.random() * 1.1)) {
            this._buT = now;
            this.burble(master * (0.35 + Math.random() * 0.45) * (0.45 + 0.55 * fade), prof);
            this._gurgleK = 0.35 + Math.random() * 0.4;
          }
          // the note ducks right after each thump and swells back
          this._gurgle = 1 - (1 - (this._gurgleK || 1)) * Math.exp(-(now - (this._buT || 0)) / 45);
        }
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
      if (!this.ctx || this.ctx.state !== 'running') return; // (v5.5.5: see ok() - nothing to silence in a stopped context)
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
      // (v5.8: 30 times a second is plenty for the other cars - every value
      // glides to its target between updates anyway - and doing it every
      // frame was a tenth of the game's own time per frame)
      const nowO = performance.now();
      if (this._oT && nowO - this._oT < 30) return;
      const t = this.ctx.currentTime;
      const dt = Math.min(0.1, (nowO - (this._oT || nowO)) / 1000);
      this._oT = nowO;
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
        const liftNow = this._liftCheck(rs.thr || 0, v); // (v5.5.7: as for your own car - their pedal eases up too)
        if (!prof.ev && oms.pops > 0.4 && liftNow && fall > 0.2 && performance.now() - (v.crT || 0) > 700) {
          v.crT = performance.now();
          if (oms.bang) this.bangBurst(fall * 0.8, 'others', prof);
          else if (oms.burble) this.burbleBurst(fall * 0.8, prof, 'others');
          else this.crackle(oms.pops * 0.6, fall * 0.7, oms.crackle, 'others', prof);
        }
        // their anti-lag, banging away as they come past
        if (!prof.ev && rs.backfire > 0 && fall > 0.15) {
          const gap = 1000 / (4 + rpm * 13); // as above, a touch sparser at a distance
          if (performance.now() - (v.bfT || 0) > gap * (0.6 + Math.random() * 1.0)) {
            v.bfT = performance.now();
            const amp = fall * (0.4 + Math.random() * 0.6);
            if (Math.random() < 0.3) this.bang(amp, 'others', prof);
            else this.pop(amp * 1.1, 'others', prof);
          }
        }
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
          // (v5.5.6: on their lift with boost up - see update())
          v.bPk = Math.max(bst, (v.bPk || 0) * Math.exp(-dt / 0.35)); // (per second, not per frame)
          if (liftNow && v.bPk > 0.28 && fall > 0.15 && performance.now() - (v.bovT || 0) > 500) {
            v.bovT = performance.now();
            this.bov(oms.bov, ind === 't2', fall, 'others');
          }
        } else v.wg.gain.setTargetAtTime(0, t, 0.06);
        v.lb = bst;
        if (rs.backfire > 0 && !v.bf && fall > 0.12) this.pop(fall * 0.8, 'others', prof);
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
    // v5.7 knockables: what a thing sounds like when a car sends it flying
    knock(kind, k) {
      if (!this.ok() || k < 0.03) return;
      if (kind === 'card') {
        this.noiseHit(0.16, 420, 0.3 * k, 'lowpass', 'sfx', 0, 180);
        this.noiseHit(0.08, 1600, 0.08 * k, 'bandpass', 'sfx', 0.01, 0, 1.5);
      } else if (kind === 'wood') {
        this.noiseHit(0.12, 900, 0.25 * k, 'bandpass', 'sfx', 0, 400, 3);
        this.tone(220, 0.08, 'triangle', 0.08 * k, 160);
      } else if (kind === 'metal') {
        for (let i = 0; i < 4; i++) this.noiseHit(0.07, 1800 + Math.random() * 1600, 0.08 * k, 'bandpass', 'sfx', i * 0.05, 0, 8);
        this.tone(640, 0.25, 'triangle', 0.03 * k, 600);
      } else if (kind === 'plastic') {
        this.tone(330, 0.07, 'triangle', 0.1 * k, 260);
        this.noiseHit(0.05, 2400, 0.06 * k, 'bandpass', 'sfx', 0, 0, 2);
      } else {
        this.tone(170, 0.22, 'sine', 0.12 * k, 320); // soft: a boing
        this.noiseHit(0.1, 300, 0.12 * k, 'lowpass');
      }
    },
    // v5.6.1 crossings that aren't railways: a forklift's reversing beeper,
    // a tractor's horn and diesel; and concrete cracking off a building
    forkBeep(k) {
      if (!this.ok() || k < 0.03) return;
      for (let i = 0; i < 5; i++) this.tone(1040, 0.24, 'square', 0.03 * k, 0, 'sfx', i * 0.5);
      this.noiseHit(1.6, 500, 0.05 * k, 'bandpass', 'sfx', 0, 900, 2);
    },
    tractorHorn(k) {
      if (!this.ok() || k < 0.03) return;
      for (const f of [196, 247]) {
        this.tone(f, 0.35, 'sawtooth', 0.045 * k);
        this.tone(f, 0.5, 'sawtooth', 0.045 * k, 0, 'sfx', 0.5);
      }
      for (let i = 0; i < 10; i++) this.noiseHit(0.09, 160, 0.12 * k, 'lowpass', 'sfx', 1.1 + i * 0.13, 90);
    },
    // v5.7: a delivery robot's chirp
    robotChirp(k) {
      if (!this.ok() || k < 0.03) return;
      this.tone(1800, 0.06, 'square', 0.03 * k, 2400, 'sfx');
      this.tone(2400, 0.08, 'square', 0.025 * k, 1600, 'sfx', 0.09);
      this.tone(2000, 0.05, 'square', 0.02 * k, 2600, 'sfx', 0.2);
    },
    // v5.7: a wave breaking over the causeway wall, and a rocket's roar
    wave(k) {
      if (!this.ok() || k < 0.03) return;
      this.noiseHit(1.4, 900, 0.3 * k, 'lowpass', 'sfx', 0, 300, 0.7);
      this.noiseHit(0.9, 3000, 0.08 * k, 'highpass', 'sfx', 0.1);
    },
    launchRoar(k) {
      if (!this.ok() || k < 0.03) return;
      this.noiseHit(6, 120, 0.55 * k, 'lowpass', 'sfx', 0, 60);
      this.noiseHit(4, 500, 0.18 * k, 'bandpass', 'sfx', 0.2, 250, 0.6);
      this.tone(38, 5, 'sine', 0.3 * k, 30);
    },
    debrisCrack(k) {
      if (!this.ok() || k < 0.03) return;
      this.noiseHit(0.18, 2600, 0.14 * k, 'bandpass', 'sfx', 0, 900, 3);
      this.tone(140, 0.7, 'sawtooth', 0.03 * k, 70, 'sfx', 0.05);
      this.glass(0.5 * k);
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
    // v5.5.6: the exhaust one-shots are voiced by the engine they come out of
    // (prof = PROFILES): its exhaust ring sets how deep the body of a pop is
    // and how bright a crackle snaps - a V8's pop is a thud, a small four's
    // a crack. Without a profile they sound as they always did.
    _fxv(prof) {
      const r = (prof && prof.res) || 450;
      return { body: U.clamp(r * 2.1, 380, 1900), thump: U.clamp(r / 3.2, 42, 150), snap: 1900 + r * 2.6 };
    },
    pop(m, bus, prof, when) {
      const v = this._fxv(prof), k = m || 1;
      this.noiseHit(0.07, v.body * (0.9 + Math.random() * 0.2), 0.34 * k, 'bandpass', bus || 'sfx', when, 0, 1.2);
      this.tone(v.thump * 1.8, 0.06, 'square', 0.12 * k, v.thump, bus || 'sfx', when);
    },
    // one crack of an overrun crackle: 6-16 ms of dry, bright noise and no
    // thump under it - many of these in a row is the "crackle"
    snap(m, prof, bus, when) {
      const v = this._fxv(prof), k = m || 1;
      this.noiseHit(0.006 + Math.random() * 0.01, v.snap * (0.8 + Math.random() * 0.45), 0.42 * k, 'bandpass', bus || 'sfx', when, 0, 1.6);
    },
    // one lump of a burble: a soft, rounded, low thump (no sharp edge)
    burble(m, prof, bus, when) {
      const v = this._fxv(prof), k = m || 1;
      this.noiseHit(0.09 + Math.random() * 0.05, v.body * 0.45, 0.5 * k, 'lowpass', bus || 'sfx', when, v.body * 0.18, 0.9);
      this.tone(v.thump, 0.09, 'sine', 0.22 * k, v.thump * 0.7, bus || 'sfx', when);
    },
    // A burst of pops as you lift (a free-flowing exhaust with no tune), or,
    // `dense`, a burst of crackle - used for the cars going past you.
    crackle(amount, m, dense, bus, prof) {
      const now = performance.now();
      if (now - (this._crT || 0) < 150) return; // several cars lifting at once: one burst is plenty
      this._crT = now;
      const n = dense ? 10 + Math.round(amount * 12) : 2 + Math.round(amount * 4);
      const span = dense ? 0.9 : 0.49;
      for (let i = 0; i < n; i++) {
        const w = 0.04 + Math.random() * span;
        if (dense) this.snap((0.3 + Math.random() * 0.6) * (m || 1) * (1 - w / (span + 0.1)), prof, bus, w);
        else this.pop((0.35 + Math.random() * 0.5) * (m || 1), bus, prof, w);
      }
    },
    // ...and of burble, for the cars going past you
    burbleBurst(m, prof, bus) {
      const n = 5 + Math.floor(Math.random() * 5);
      let w = 0.03;
      for (let i = 0; i < n; i++) {
        this.burble((m || 1) * (0.4 + Math.random() * 0.5) * (1 - i / (n + 2)), prof, bus, w);
        w += 0.07 + Math.random() * 0.12;
      }
    },
    // v5.5.7 lift detector (see update): true once when the pedal comes up
    // within 0.4 s of last being properly down. `o` keeps the state (a car).
    _liftCheck(thr, o) {
      o = o || this;
      const now = performance.now();
      if (thr > 0.5) o._downAt = now;
      const lift = thr < 0.15 && o._downAt > 0 && now - o._downAt < 400;
      if (lift) o._downAt = 0;
      return lift;
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
    // v5.5.6 the three valves, rebuilt so they are three different noises:
    //   recirculated: the air goes back into the intake - a soft, muffled
    //                 "whoosh", mostly heard as the whistle dropping away
    //   atmospheric : vented to the air - a sharp "tsh" chirp as it snaps open
    //                 and then a loud bright hiss that falls away
    //   flutter     : no valve, the compressor surges - a fast "stu-tu-tu-tu",
    //                 each chirp lower and further apart as the turbo slows
    blowoff(m, bus, big) {
      const k = m || 1, f = big ? 0.72 : 1; // a big turbo moves more air: a deeper, longer whoosh
      this.noiseHit(0.32 / f, 1900 * f, 0.2 * k, 'bandpass', bus || 'sfx', 0, 520 * f, 0.8);
      this.noiseHit(0.22 / f, 3400 * f, 0.05 * k, 'highpass', bus || 'sfx', 0.02, 1800 * f);
    },
    blowoffAtmo(m, bus) {
      const k = m || 1;
      this.noiseHit(0.035, 5600, 0.5 * k, 'bandpass', bus || 'sfx', 0, 4200, 4);
      this.noiseHit(0.5, 3400, 0.42 * k, 'highpass', bus || 'sfx', 0.012, 1500);
      this.noiseHit(0.34, 7200, 0.16 * k, 'highpass', bus || 'sfx', 0.012, 4000);
    },
    // The valve a player picked, with the turbo's own character as the default.
    // (v5.5.7: 'stock' is the recirculated whoosh on every turbo. A big
    //  turbo used to flutter on stock too, so picking Flutter changed nothing.)
    bov(kind, big, m, bus) {
      if (kind === 'atmo') return this.blowoffAtmo(m, bus);
      if (kind === 'flutter') return this.flutter(m, bus, big);
      return this.blowoff(m, bus, big);
    },
    // v5.3 anti-lag / bang tune: a hard crack with real bottom end, not the
    // little pop used for an overrun crackle. Three layers - the body of it,
    // a low thump you feel, and a sharp transient on top so it cuts through
    // the engine note rather than sitting under it.
    bang(m, bus, prof, when) {
      const k = m || 1, v = this._fxv(prof);
      this.noiseHit(0.16, v.body * 0.6, 0.95 * k, 'bandpass', bus || 'sfx', when, 0, 1.4);
      this.tone(v.thump * 0.62, 0.15, 'square', 0.52 * k, v.thump * 0.33, bus || 'sfx', when);
      this.noiseHit(0.05, v.snap * 0.95, 0.42 * k, 'highpass', bus || 'sfx', when, 1500);
    },
    // The bang-pop map on a lift: one hard crack, then a scatter of smaller
    // ones chasing it down. A single bang was what made this option feel like
    // nothing was fitted.
    bangBurst(m, bus, prof) {
      const k = m || 1;
      this.bang(k, bus, prof);
      const n = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) {
        const w = 0.06 + Math.random() * 0.55;
        if (Math.random() < 0.4) this.bang(k * (0.45 + Math.random() * 0.4), bus, prof, w);
        else this.pop(k * (0.5 + Math.random() * 0.5), bus, prof, w);
      }
    },
    // v5.5.7 compressor surge - "stu-tu-tu-tu". With no valve, the boost
    // that is left pushes back through the compressor, which stalls and
    // catches again and again: a burst of air each time, ~20 a second at
    // first, slowing and fading as the pressure goes (a big turbo lower,
    // slower and longer). Each burst is a "t" of bright air and a hollow "u"
    // under it, and the turbo's whistle chops down with it. The old one
    // fired 38 tiny pitched ticks a second - a short buzz, not a flutter.
    flutter(m, bus, big) {
      if (!this.ok()) return;
      const c = this.ctx, k = Math.min(1.4, m || 1), out = this.bus[bus || 'sfx'];
      const t0 = c.currentTime + 0.005;
      const src = c.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const body = c.createBiquadFilter(), air = c.createBiquadFilter(), gB = c.createGain(), gA = c.createGain();
      body.type = 'bandpass';
      body.Q.value = 2.2;
      air.type = 'bandpass';
      air.Q.value = 0.8;
      air.frequency.value = big ? 2600 : 3300;
      src.connect(body).connect(gB).connect(out);
      src.connect(air).connect(gA).connect(out);
      const wh = c.createOscillator(), gW = c.createGain(); // the whistle, chopped by the surge
      wh.type = 'sine';
      wh.connect(gW).connect(out);
      for (const g of [gB, gA, gW]) g.gain.setValueAtTime(0.0001, t0);
      // the "s": the throttle snapping shut on a charged pipe
      gA.gain.linearRampToValueAtTime(0.16 * k, t0 + 0.012);
      gA.gain.exponentialRampToValueAtTime(0.004, t0 + 0.07);
      const n = Math.round((big ? 7 : 6) + 4 * Math.min(1, k)); // more boost, more bursts
      let t = t0 + 0.06, rate = big ? 17 : 22, f = big ? 620 : 900, wf = big ? 2300 : 3400;
      for (let i = 0; i < n; i++) {
        const a = k * Math.pow(1 - i / (n + 1), 1.3) * (0.85 + 0.3 * Math.random());
        const len = 0.55 / rate; // sound for about half the gap, silence for the rest
        body.frequency.setValueAtTime(f, t);
        body.frequency.exponentialRampToValueAtTime(f * 0.8, t + len);
        gB.gain.setValueAtTime(0.0001, t);
        gB.gain.linearRampToValueAtTime(0.9 * a, t + 0.004);
        gB.gain.exponentialRampToValueAtTime(0.0008, t + len);
        gA.gain.setValueAtTime(0.0001, t);
        gA.gain.linearRampToValueAtTime(0.2 * a, t + 0.002);
        gA.gain.exponentialRampToValueAtTime(0.0008, t + 0.018);
        wh.frequency.setValueAtTime(wf, t);
        gW.gain.setValueAtTime(0.0001, t);
        gW.gain.linearRampToValueAtTime(0.022 * a, t + 0.005);
        gW.gain.exponentialRampToValueAtTime(0.0003, t + len * 0.8);
        t += (1 / rate) * (0.94 + 0.12 * Math.random());
        rate *= big ? 0.93 : 0.94;
        f *= 0.965;
        wf *= 0.95;
      }
      src.start(t0, Math.random() * 1.2);
      src.stop(t + 0.1);
      wh.start(t0);
      wh.stop(t + 0.1);
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
      // (v5.7: two notes, a little louder - one quiet tick was easy to miss)
      this.tone(1200, 0.07, 'sine', 0.06, 1500, 'ui');
      this.tone(1600, 0.09, 'sine', 0.05, 1800, 'ui', 0.08);
    },
    // a direct message: a bright two-note chime
    dm() {
      this.tone(988, 0.16, 'sine', 0.09, 0, 'ui');
      this.tone(1319, 0.3, 'sine', 0.08, 0, 'ui', 0.13);
      this.tone(1976, 0.22, 'sine', 0.025, 0, 'ui', 0.13);
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
    // v5.5.7 the garage playlist. The user's favourite was the garage theme
    // above ("that vibe - like the music in 3008"), so four more in the same
    // world: warm jazz chords played on a Rhodes-style electric piano, soft
    // kits, a little room reverb, and a tune that is WRITTEN from a motif
    // (see _melody) rather than dice rolls. Each chord is [bass, voicing...]:
    // rootless voicings in the middle of the keyboard, the way a jazz
    // pianist leaves the root to the bass player.
    //
    // F major bossa nova at 132: I-VI-ii-V, then the minor iv on the way
    // home - vibes on the tune, rim clicks and a shaker
    showroom: { chill: 'bossa', bpm: 132, key: 5, scale: [0, 2, 4, 5, 7, 9, 11], lead: { inst: 'vibes', lo: 65, hi: 86 },
      prog: [[41, 57, 60, 64, 67], [50, 54, 57, 60, 63], [43, 58, 62, 65, 69], [48, 58, 64, 69, 74], [45, 55, 60, 64, 71], [50, 54, 57, 60, 63], [43, 58, 62, 65, 69], [48, 58, 64, 69, 74],
        [46, 57, 60, 62, 65], [46, 55, 58, 61, 65], [45, 55, 60, 64, 71], [50, 54, 57, 60, 63], [43, 58, 62, 65, 69], [48, 58, 64, 69, 74], [41, 60, 64, 67, 69], [48, 58, 62, 65, 69]] },
    // C major lo-fi at 78, swung: IV-iii-ii-I, then the E7#9 and a borrowed
    // bVII - a celesta on the tune, rolled chords, dusty kit, vinyl crackle
    nightshift: { chill: 'lofi', bpm: 78, swing: 0.3, key: 0, scale: [0, 2, 4, 5, 7, 9, 11], lead: { inst: 'bell', lo: 69, hi: 88, sparse: 1 }, crackle: 1,
      prog: [[41, 57, 60, 64, 67], [40, 55, 59, 62, 66], [38, 53, 57, 60, 64], [48, 52, 55, 59, 62], [41, 57, 60, 64, 67], [40, 56, 59, 62, 67], [45, 55, 59, 60, 64], [46, 57, 60, 62, 64]] },
    // Eb major smooth funk at 100: IV-iii-ii-V-I-vi-ii-V (no chromatic ninths: every chord sits in the key) with a flute on
    // the tune, tight kit with ghost notes, a bass that walks about
    spareparts: { chill: 'funk', bpm: 100, swing: 0.1, key: 3, scale: [0, 2, 4, 5, 7, 9, 11], lead: { inst: 'flute', lo: 67, hi: 87 },
      prog: [[44, 55, 58, 60, 63], [43, 53, 58, 60, 62], [41, 51, 55, 56, 60], [46, 56, 60, 62, 67], [39, 55, 58, 62, 65], [48, 55, 58, 62, 63], [41, 51, 55, 56, 60], [46, 56, 60, 63, 65]] },
    // Db major at 70, slow and dreamy: I-vi-IV-V, iii-vi-ii and an Ab7b9 that
    // leaves the door open - pads, the piano rolling in eighths, vibes, brushes
    closingtime: { chill: 'ballad', bpm: 70, key: 1, scale: [0, 2, 4, 5, 7, 9, 11], lead: { inst: 'vibes', lo: 65, hi: 85, sparse: 1 }, pad: 1,
      prog: [[37, 53, 56, 60, 63], [46, 56, 60, 61, 65], [42, 53, 56, 58, 61], [44, 54, 58, 61, 65], [41, 51, 56, 58, 60], [46, 56, 60, 61, 65], [39, 54, 58, 61, 65], [44, 54, 57, 60, 63]] },
    // v5.5.8 more of the same band beyond the garage. `race` songs skip the
    // breakdown (the kit never drops out mid-race) and follow the race's
    // intensity: hats double up, the filter opens and the tune jumps an
    // octave on the final lap.
    //
    // Bb major store jazz-funk at 112 for the Megastore: vibes on the tune
    megastore: { chill: 'funk', race: 1, bpm: 112, swing: 0.08, key: 10, scale: [0, 2, 4, 5, 7, 9, 11], lead: { inst: 'vibes', lo: 65, hi: 86 },
      prog: [[46, 57, 60, 62, 65], [43, 53, 57, 58, 62], [48, 55, 58, 62, 63], [41, 51, 57, 62, 67], [50, 53, 55, 57, 60], [43, 53, 57, 58, 62], [51, 55, 58, 62, 65], [41, 51, 55, 58, 60]] },
    // D minor at 100 for Harrow City: a ticking kit, an ostinato bass, a
    // celesta and the A7b9 that never quite resolves
    evacuation: { chill: 'dark', race: 1, bpm: 100, key: 2, scale: [0, 2, 3, 5, 7, 8, 10], lead: { inst: 'bell', lo: 69, hi: 86, sparse: 1 }, pad: 1,
      prog: [[38, 53, 57, 60, 64], [46, 53, 57, 60, 62], [43, 53, 57, 58, 62], [45, 55, 58, 61, 64], [38, 53, 57, 60, 64], [41, 53, 57, 60, 64], [46, 53, 57, 60, 62], [45, 55, 58, 61, 64]] },
    // G major at 104 for the South Valley: guitar on the offbeat, a flute
    southvalley: { chill: 'sunny', race: 1, bpm: 104, swing: 0.12, key: 7, scale: [0, 2, 4, 5, 7, 9, 11], lead: { inst: 'flute', lo: 67, hi: 88 },
      prog: [[43, 54, 57, 59, 62], [40, 54, 55, 59, 62], [48, 55, 59, 62, 64], [50, 55, 57, 60, 64], [47, 54, 57, 59, 62], [40, 54, 55, 59, 62], [45, 55, 59, 60, 64], [50, 54, 57, 60, 64]] },
    // A major city pop at 118 for any race: four on the floor, claps, octave
    // bass, electric piano stabs, brass and a synth on the tune
    sunsetdrive: { chill: 'citypop', race: 1, bpm: 118, key: 9, scale: [0, 2, 4, 5, 7, 9, 11], lead: { inst: 'synth', lo: 69, hi: 88 }, brass: 1,
      prog: [[50, 57, 61, 64, 66], [49, 56, 59, 61, 64], [47, 57, 61, 62, 66], [52, 56, 61, 62, 66], [50, 57, 61, 64, 66], [49, 56, 59, 61, 64], [42, 57, 61, 64, 68], [52, 57, 59, 62, 66]] },
    // C minor liquid drum and bass at 172 for any race (and the night)
    nightline: { chill: 'dnb', race: 1, bpm: 172, key: 0, scale: [0, 2, 3, 5, 7, 8, 10], lead: { inst: 'bell', lo: 72, hi: 91, sparse: 1 }, pad: 1,
      prog: [[48, 58, 62, 63, 67], [44, 55, 58, 60, 63], [41, 55, 56, 60, 63], [43, 53, 56, 59, 63], [48, 58, 62, 63, 67], [51, 55, 58, 62, 65], [44, 55, 58, 60, 63], [43, 53, 55, 60, 62]] },
    // v5.7: D major city pop at 122 for Launch Coast, brass on the lift
    liftoff: { chill: 'citypop', race: 1, bpm: 122, key: 2, scale: [0, 2, 4, 5, 7, 9, 11], lead: { inst: 'synth', lo: 66, hi: 86 }, brass: 1,
      prog: [[50, 57, 61, 64, 66], [47, 54, 57, 61, 62], [43, 54, 57, 59, 62], [45, 52, 54, 59, 61], [40, 54, 55, 59, 62], [42, 52, 57, 61, 64], [43, 54, 59, 62, 66], [45, 52, 57, 61, 64]] },
    // B minor, dark and pulsing at 118 for the Server Farm
    uptime: { chill: 'dark', race: 1, bpm: 118, key: 11, scale: [0, 2, 3, 5, 7, 8, 10], lead: { inst: 'synth', lo: 66, hi: 86, sparse: 1 }, pad: 1,
      prog: [[47, 54, 57, 61, 62], [43, 54, 59, 62, 66], [40, 54, 55, 59, 62], [42, 52, 57, 61, 64], [47, 54, 57, 62, 64], [50, 54, 57, 61, 66], [43, 54, 57, 59, 62], [45, 52, 54, 57, 61]] },
    // F major bossa at 104 by the sea for Low Tide
    lowtide: { chill: 'bossa', race: 1, bpm: 104, swing: 0.1, key: 5, scale: [0, 2, 4, 5, 7, 9, 11], lead: { inst: 'flute', lo: 65, hi: 86 },
      prog: [[41, 52, 55, 57, 60], [38, 52, 53, 57, 60], [43, 53, 57, 58, 62], [48, 52, 55, 58, 62], [45, 52, 55, 60, 64], [38, 53, 57, 60, 62], [46, 53, 57, 60, 62], [48, 53, 55, 58, 62]] },
    // E major lounge at 86 for the menu (it takes turns with the title theme)
    welcome: { chill: 'lofi', bpm: 86, swing: 0.2, key: 4, scale: [0, 2, 4, 5, 7, 9, 11], lead: { inst: 'vibes', lo: 64, hi: 85, sparse: 1 },
      prog: [[45, 56, 59, 61, 64], [44, 54, 56, 59, 63], [42, 52, 56, 57, 61], [47, 57, 61, 63, 68], [45, 56, 59, 61, 64], [49, 52, 56, 59, 63], [42, 52, 56, 57, 61], [47, 52, 54, 57, 61]] },
  };
  // ======================================================================
  // v5.5.7 the chill songs (SONGS with `chill`): a second band for the
  // garage playlist. Same look-ahead scheduler; its own instruments:
  //   ep     : a Rhodes-style electric piano - FM, a sine bent by another
  //            sine at the same pitch whose depth dies away (the "bark" of
  //            the hammer), plus a quiet high tine that rings for a moment
  //   vibes  : vibraphone - a sine with its fourth-harmonic bar mode, through
  //            a shared tremolo (the motor-driven fans of a real one)
  //   bell   : celesta - a soft FM bell
  //   flute  : breathy triangle with a slow vibrato
  //   bass   : a round, plucked sine-and-triangle, like an upright or a P-bass
  //            with the tone rolled off
  //   pad    : two detuned saws, filtered dark, slow to swell
  //   kits   : soft kick, rim click, shaker, brushes, a dusty lo-fi snare, hats
  // Everything goes through a small room reverb (a convolver on noise that
  // dies away in under two seconds) and a gentle top cut, so it sits back like
  // a record playing in the next room.
  // Form, per pass through the chords: intro (piano and bass come in, the
  // kit joins halfway) -> the tune -> the tune's answer -> a breakdown (kit
  // down, the piano rolls arpeggios, no tune) -> back to the tune, forever.
  // ======================================================================
  const CHILL = ['garage', 'showroom', 'nightshift', 'spareparts', 'closingtime'];
  // What the music player shows: title, style, where it plays
  const SONG_INFO = {
    menu: ['Slipstakes', 'Title theme', 'Main menu'],
    garage: ['Shop Floor', 'Jazz house', 'Garage and between races'],
    showroom: ['Showroom', 'Bossa nova', 'Garage and between races'],
    nightshift: ['Night Shift', 'Lo-fi', 'Garage and between races'],
    spareparts: ['Spare Parts', 'Smooth funk', 'Garage and between races'],
    closingtime: ['Closing Time', 'Slow and dreamy', 'Garage and between races'],
    welcome: ['Welcome In', 'Lounge', 'Main menu'],
    megastore: ['Aisle Infinity', 'Store jazz-funk', 'Megastore'],
    evacuation: ['Evacuation', 'Dark and tense', 'Harrow City'],
    southvalley: ['Garlic Summer', 'Sunny groove', 'Harvest Run'],
    liftoff: ['Liftoff', 'City pop', 'Launch Coast'],
    uptime: ['Uptime', 'Dark and pulsing', 'Server Farm'],
    lowtide: ['Low Tide', 'Bossa by the sea', 'Low Tide'],
    sunsetdrive: ['Sunset Drive', 'City pop', 'Races'],
    nightline: ['Night Line', 'Liquid drum and bass', 'Races, day or night'],
    final: ['Champion', 'Anthem', 'The final standings'],
    race: ['Green Light', 'Race', 'Races'],
    night: ['Night Drive', 'Synthwave', 'Night races'],
    rally: ['Loose Surface', 'Breakbeat', 'Dirt, gravel and snow'],
    street: ['Wall to Wall', 'Street', 'Street circuits'],
    endurance: ['Long Haul', 'Steady groove', 'Endurance races'],
  };
  // Drum patterns: [step, velocity]. rim: two bars of the bossa clave.
  const KITS = {
    bossa: { kick: [[0, 0.8], [6, 0.45], [8, 0.7], [14, 0.45]], rim: [[0, 6, 12], [4, 10]], shaker: 1 },
    lofi: { kick: [[0, 1], [10, 0.8]], kick2: [[7, 0.45]], snare: [[4, 1], [12, 1]], hat: 16, hatO: 14 },
    funk: { kick: [[0, 1], [3, 0.5], [8, 0.9], [11, 0.55]], snare: [[4, 1], [12, 1], [7, 0.2], [15, 0.24]], hat: 8, hat16: [13, 15] },
    ballad: { brush: [4, 12], kick: [[0, 0.5]] },
    citypop: { kick: [[0, 1], [4, 0.9], [8, 1], [12, 0.9]], clap: [[4, 1], [12, 1]], hat: 16, hatO: [2, 6, 10, 14] },
    dnb: { kick: [[0, 1], [10, 0.9]], snare: [[4, 1], [12, 1], [7, 0.2], [15, 0.25]], hat: 16 },
    dark: { kick: [[0, 1], [7, 0.45], [10, 0.8]], snare: [[12, 0.75]], hat: 8, rim: [[3, 11], [3, 11, 14]] },
    sunny: { kick: [[0, 1], [7, 0.5], [8, 0.9]], snare: [[4, 1], [12, 1]], hat: 8, shaker: 1 },
  };
  // Bass lines: [step, semitones above the root, length in steps]
  const BASS = {
    bossa: [[0, 0, 5], [6, 7, 2], [8, 0, 5], [14, 7, 2]],
    lofi: [[0, 0, 6], [7, 0, 2], [10, 7, 5]],
    funk: [[0, 0, 2], [3, 12, 1], [6, 7, 2], [8, 0, 2], [10, 10, 1], [11, 12, 2], [14, 7, 2]],
    ballad: [[0, 0, 10], [10, 7, 6]],
    citypop: [[0, 0, 1], [2, 12, 1], [3, 0, 1], [6, 12, 1], [8, 0, 1], [10, 12, 1], [11, 7, 1], [14, 12, 1]],
    dnb: [[0, 0, 6], [6, 0, 2], [10, 7, 6]],
    dark: [[0, 0, 2], [2, 0, 2], [4, 0, 2], [6, 0, 2], [8, 0, 2], [10, 0, 2], [12, 1, 2], [14, 0, 2]],
    sunny: [[0, 0, 3], [4, 7, 2], [6, 0, 2], [8, 0, 3], [12, 7, 2], [14, 5, 2]],
  };
  // How the piano comps: [step, length]. Two bars of each, alternating.
  const COMP = {
    bossa: [[[0, 2], [3, 2], [6, 3], [10, 2], [12, 3]], [[2, 2], [6, 2], [8, 3], [11, 2], [14, 2]]],
    lofi: [[[0, 14]], [[0, 9], [10, 5]]],
    funk: [[[0, 2], [3, 1], [6, 2], [8, 2], [11, 1], [14, 2]], [[0, 2], [4, 2], [6, 1], [10, 2], [12, 3]]],
    citypop: [[[2, 1], [6, 1], [10, 1], [14, 1]], [[2, 1], [6, 1], [8, 2], [14, 1]]],
    dnb: [[[0, 12]], [[0, 6], [8, 7]]],
    sunny: [[[0, 7], [8, 7]], [[0, 7], [8, 7]]],
  };
  // (v5.5.8) the guitar's offbeat chops (sunny) and the brass stabs (citypop)
  const PLUCK = [[[2, 1], [6, 1], [10, 1], [14, 1]], [[2, 1], [5, 1], [10, 1], [13, 1]]];
  const BRASS = [[[0, 2], [11, 3]], [[0, 1], [3, 1], [6, 2]]];
  // Tune rhythms, one bar each: [step, length]. OPEN states a motif,
  // ANSWER replies to it, CLOSE lands at the end of a phrase.
  const RH = {
    open: [[[0, 3], [3, 3], [6, 2], [8, 6]], [[2, 2], [4, 2], [6, 4], [12, 4]], [[0, 6], [6, 2], [8, 2], [10, 6]], [[3, 3], [6, 3], [9, 3], [12, 4]], [[0, 2], [2, 2], [4, 4], [10, 2], [12, 4]]],
    answer: [[[0, 8], [10, 2], [12, 4]], [[4, 2], [6, 2], [8, 8]], [[0, 4], [6, 4], [12, 4]], [[2, 3], [5, 3], [8, 8]]],
    close: [[[0, 4], [4, 12]], [[0, 2], [2, 2], [4, 12]], [[0, 16]]],
  };

  const Chill = {
    // A tune over the whole chord sequence, written from a motif: the first
    // bar of each four states it, the third repeats its SHAPE from a note
    // of the new chord, the second answers and the fourth lands. Long notes
    // and the first of each bar are chord tones; the notes between walk
    // through the scale, never a semitone off a note the band is holding.
    melody(S_, seed) {
      const rng = U.rng(seed), L = S_.prog.length, out = [];
      const pick = (a) => a[Math.floor(rng() * a.length)];
      const scale = S_.scale.map((x) => (x + S_.key) % 12);
      const { lo, hi } = S_.lead;
      const rOpen = pick(RH.open), rAns = pick(RH.answer), rAns2 = pick(RH.answer), rClose = pick(RH.close), rEnd = RH.close[2];
      let prev = Math.round((lo + hi) / 2), motif = null;
      for (let b = 0; b < L; b++) {
        const ph = b % 4;
        const rh = ph === 0 || ph === 2 ? rOpen : ph === 1 ? rAns : b === L - 1 ? rEnd : ph === 3 && b % 8 === 7 ? rClose : rAns2;
        if (S_.lead.sparse && (ph === 1 || ph === 3) && b !== L - 1 && rng() < 0.45) continue; // room to breathe
        const ch = S_.prog[b];
        const pcs = ch.map((m) => m % 12);
        const tense = (pc) => pcs.some((q) => Math.abs(((pc - q + 18) % 12) - 6) === 5); // a semitone off a chord note
        const ok = (m, strong) => {
          const pc = m % 12;
          return m >= lo && m <= hi && (pcs.includes(pc) || (!strong && scale.includes(pc) && !tense(pc)));
        };
        const near = (target, strong) => {
          let best = null, bd = 1e9;
          for (let m = lo; m <= hi; m++) {
            if (!ok(m, strong)) continue;
            const d = Math.abs(m - target) + (m === prev ? 1.5 : 0) + rng() * 1.2;
            if (d < bd) (bd = d), (best = m);
          }
          return best == null ? prev : best;
        };
        const ints = [];
        for (let i = 0; i < rh.length; i++) {
          const [s, d] = rh[i];
          const strong = i === 0 || d >= 4 || s % 8 === 0;
          let m;
          if (ph === 2 && motif && motif.length === rh.length && i > 0) m = near(prev + motif[i - 1], strong); // the motif's shape again
          else if (i === 0) m = near(prev + (rng() < 0.5 ? -2 : 3), true);
          else m = near(prev + pick([-4, -2, -1, 1, 2, 3, 5]), strong);
          if (i > 0) ints.push(m - prev);
          out.push({ at: b * 16 + s, dur: d, m });
          prev = m;
        }
        if (ph === 0) motif = ints;
      }
      return out;
    },

    // --- instruments (t: start, dur: seconds held, v: level)
    ep(M, m, t, dur, v, dest) {
      const c = Audio.ctx, f = mtof(m);
      const car = c.createOscillator(), mod = c.createOscillator(), mg = c.createGain(), tine = c.createOscillator(), tg = c.createGain(), g = c.createGain();
      car.frequency.value = f;
      mod.frequency.value = f;
      // (the bark: louder notes bend harder, and it dies in a moment)
      mg.gain.setValueAtTime(f * (0.9 + v * 14), t);
      mg.gain.setTargetAtTime(f * 0.12, t, 0.09);
      mod.connect(mg).connect(car.frequency);
      tine.frequency.value = f * 7.02;
      tg.gain.setValueAtTime(v * 0.05, t);
      tg.gain.setTargetAtTime(0, t, 0.05);
      tine.connect(tg).connect(g);
      const end = t + dur;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(v, t + 0.004);
      g.gain.setTargetAtTime(v * 0.25, t + 0.004, 0.2 + 60 / f); // low notes ring longer
      g.gain.setTargetAtTime(0.0001, end, 0.09);
      car.connect(g);
      g.connect(dest || M.dry);
      g.connect(M.rev);
      for (const o of [car, mod, tine]) {
        o.start(t);
        o.stop(end + 0.5);
      }
    },
    vibes(M, m, t, dur, v) {
      const c = Audio.ctx, f = mtof(m);
      const o = c.createOscillator(), o4 = c.createOscillator(), g = c.createGain(), g4 = c.createGain();
      o.frequency.value = f;
      o4.frequency.value = f * 3.99; // the bar's second mode, a hair flat
      g4.gain.setValueAtTime(v * 0.28, t);
      g4.gain.setTargetAtTime(0, t, 0.12);
      o4.connect(g4).connect(g);
      o.connect(g);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(v, t + 0.003);
      g.gain.setTargetAtTime(v * 0.3, t + 0.003, 0.9);
      g.gain.setTargetAtTime(0.0001, t + Math.max(dur, 0.6), 0.25); // a mallet note rings past its written length
      g.connect(M.trem);
      g.connect(M.rev);
      if (M.send) g.connect(M.send);
      const stop = t + Math.max(dur, 0.6) + 1.2;
      o.start(t);
      o4.start(t);
      o.stop(stop);
      o4.stop(stop);
    },
    bell(M, m, t, dur, v) {
      const c = Audio.ctx, f = mtof(m);
      const car = c.createOscillator(), mod = c.createOscillator(), mg = c.createGain(), g = c.createGain();
      car.frequency.value = f;
      mod.frequency.value = f * 3.5;
      mg.gain.setValueAtTime(f * 2.4, t);
      mg.gain.setTargetAtTime(f * 0.3, t, 0.25);
      mod.connect(mg).connect(car.frequency);
      car.connect(g);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(v, t + 0.002);
      g.gain.setTargetAtTime(0.0001, t + 0.002, 0.55);
      g.connect(M.dry);
      g.connect(M.rev);
      if (M.send) g.connect(M.send);
      car.start(t);
      mod.start(t);
      car.stop(t + 3);
      mod.stop(t + 3);
    },
    flute(M, m, t, dur, v) {
      const c = Audio.ctx, f = mtof(m);
      const o = c.createOscillator(), o2 = c.createOscillator(), g2 = c.createGain(), vib = c.createOscillator(), vg = c.createGain(), g = c.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      o2.frequency.value = f * 2;
      g2.gain.value = 0.18;
      o2.connect(g2).connect(g);
      vib.frequency.value = 5.1;
      vg.gain.setValueAtTime(0, t);
      vg.gain.linearRampToValueAtTime(f * 0.006, t + Math.min(0.5, dur)); // the vibrato comes in as the note settles
      vib.connect(vg);
      vg.connect(o.frequency);
      vg.connect(o2.frequency);
      o.connect(g);
      const end = t + dur;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(v, t + 0.06);
      g.gain.setValueAtTime(v, Math.max(t + 0.06, end - 0.08));
      g.gain.linearRampToValueAtTime(0.0001, end + 0.06);
      g.connect(M.dry);
      g.connect(M.rev);
      if (M.send) g.connect(M.send);
      // breath: a little filtered air at the start of each note
      const n = c.createBufferSource(), nf = c.createBiquadFilter(), ng = c.createGain();
      n.buffer = Audio.noise;
      nf.type = 'bandpass';
      nf.frequency.value = f * 2;
      nf.Q.value = 1.2;
      ng.gain.setValueAtTime(v * 0.35, t);
      ng.gain.setTargetAtTime(v * 0.06, t + 0.03, 0.08);
      ng.gain.setTargetAtTime(0.0001, end, 0.05);
      n.connect(nf).connect(ng).connect(M.dry);
      for (const x of [o, o2, vib]) {
        x.start(t);
        x.stop(end + 0.2);
      }
      n.start(t, Math.random());
      n.stop(end + 0.2);
    },
    brass(M, m, t, dur, v) {
      const c = Audio.ctx, f = mtof(m), lp = c.createBiquadFilter(), g = c.createGain();
      lp.type = 'lowpass';
      lp.Q.value = 1.2;
      lp.frequency.setValueAtTime(600, t);
      lp.frequency.linearRampToValueAtTime(2600, t + 0.03); // the blat of the attack
      lp.frequency.setTargetAtTime(1100, t + 0.04, 0.12);
      lp.connect(g);
      const end = t + dur;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(v, t + 0.02);
      g.gain.setTargetAtTime(v * 0.7, t + 0.02, 0.1);
      g.gain.setTargetAtTime(0.0001, end, 0.05);
      g.connect(M.dry);
      g.connect(M.rev);
      for (const d of [-9, 9]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = d;
        o.connect(lp);
        o.start(t);
        o.stop(end + 0.3);
      }
    },
    pluck(M, m, t, dur, v) {
      const c = Audio.ctx, f = mtof(m), o = c.createOscillator(), o2 = c.createOscillator(), hp = c.createBiquadFilter(), g = c.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      o2.type = 'square';
      o2.frequency.value = f * 2;
      const g2 = c.createGain();
      g2.gain.value = 0.12;
      hp.type = 'highpass';
      hp.frequency.value = 220;
      o.connect(hp);
      o2.connect(g2).connect(hp);
      hp.connect(g);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(v, t + 0.003);
      g.gain.setTargetAtTime(0.0001, t + 0.004, 0.07); // a muted chop
      g.connect(M.dry);
      g.connect(M.rev);
      o.start(t);
      o2.start(t);
      o.stop(t + 0.5);
      o2.stop(t + 0.5);
    },
    synth(M, m, t, dur, v) {
      const c = Audio.ctx, f = mtof(m), lp = c.createBiquadFilter(), g = c.createGain(), vib = c.createOscillator(), vg = c.createGain();
      lp.type = 'lowpass';
      lp.frequency.value = 2400 + (M.intensity || 0) * 1800;
      lp.connect(g);
      vib.frequency.value = 5.6;
      vg.gain.setValueAtTime(0, t);
      vg.gain.linearRampToValueAtTime(f * 0.008, t + Math.min(0.4, dur));
      vib.connect(vg);
      const end = t + dur;
      for (const [type, d, lv] of [['sawtooth', -6, 0.6], ['square', 6, 0.4]]) {
        const o = c.createOscillator(), og = c.createGain();
        o.type = type;
        o.frequency.value = f;
        o.detune.value = d;
        og.gain.value = lv;
        vg.connect(o.frequency);
        o.connect(og).connect(lp);
        o.start(t);
        o.stop(end + 0.3);
      }
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(v, t + 0.012);
      g.gain.setTargetAtTime(v * 0.75, t + 0.012, 0.2);
      g.gain.setTargetAtTime(0.0001, end, 0.06);
      g.connect(M.dry);
      g.connect(M.rev);
      if (M.send) g.connect(M.send);
      vib.start(t);
      vib.stop(end + 0.3);
    },
    bass(M, m, t, dur, v, pluck) {
      const c = Audio.ctx, f = mtof(m);
      const o = c.createOscillator(), o2 = c.createOscillator(), g2 = c.createGain(), lp = c.createBiquadFilter(), g = c.createGain();
      o.frequency.value = f;
      o2.type = 'triangle';
      o2.frequency.value = f;
      g2.gain.value = 0.55;
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.setTargetAtTime(380, t, 0.08); // the pluck's brightness goes first
      o.connect(lp);
      o2.connect(g2).connect(lp);
      lp.connect(g);
      const end = t + dur;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(v, t + 0.006);
      g.gain.setTargetAtTime(v * (pluck ? 0.25 : 0.6), t + 0.006, pluck ? 0.28 : 0.9);
      g.gain.setTargetAtTime(0.0001, end, 0.05);
      g.connect(M.dry);
      o.start(t);
      o2.start(t);
      o.stop(end + 0.4);
      o2.stop(end + 0.4);
    },
    pad(M, ch, t, dur, v) {
      const c = Audio.ctx, lp = c.createBiquadFilter(), g = c.createGain();
      lp.type = 'lowpass';
      lp.frequency.value = 950;
      lp.Q.value = 0.4;
      lp.connect(g);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(v, t + Math.min(1.2, dur * 0.4));
      g.gain.setValueAtTime(v, t + dur * 0.85);
      g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.8);
      g.connect(M.dry);
      g.connect(M.rev);
      for (const m of ch) {
        for (const d of [-7, 7]) {
          const o = c.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = mtof(m);
          o.detune.value = d;
          o.connect(lp);
          o.start(t);
          o.stop(t + dur + 1);
        }
      }
    },
    // soft kit
    drum(M, kind, t, v) {
      const c = Audio.ctx;
      if (kind === 'kick') {
        const o = c.createOscillator(), g = c.createGain();
        o.frequency.setValueAtTime(110, t);
        o.frequency.exponentialRampToValueAtTime(46, t + 0.12);
        g.gain.setValueAtTime(0.34 * v, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
        o.connect(g).connect(M.dry);
        o.start(t);
        o.stop(t + 0.3);
        return;
      }
      const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = Audio.noise;
      let len = 0.04;
      if (kind === 'snare') {
        // (lo-fi: dark and papery, rolled off above 4 kHz)
        f.type = 'bandpass';
        f.frequency.value = 1500;
        f.Q.value = 0.7;
        len = 0.17;
        g.gain.setValueAtTime(0.13 * v, t);
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 4200;
        s.connect(f).connect(lp).connect(g);
        const o = c.createOscillator(), og = c.createGain();
        o.frequency.setValueAtTime(190, t);
        o.frequency.exponentialRampToValueAtTime(150, t + 0.05);
        og.gain.setValueAtTime(0.07 * v, t);
        og.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
        o.connect(og).connect(M.dry);
        o.start(t);
        o.stop(t + 0.09);
        g.connect(M.rev);
      } else if (kind === 'rim') {
        const o = c.createOscillator(), og = c.createGain();
        o.type = 'triangle';
        o.frequency.value = 1700;
        og.gain.setValueAtTime(0.06 * v, t);
        og.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
        o.connect(og).connect(M.dry);
        og.connect(M.rev);
        o.start(t);
        o.stop(t + 0.03);
        f.type = 'bandpass';
        f.frequency.value = 3200;
        f.Q.value = 2;
        len = 0.015;
        g.gain.setValueAtTime(0.05 * v, t);
        s.connect(f).connect(g);
      } else if (kind === 'shaker') {
        f.type = 'bandpass';
        f.frequency.value = 6000;
        f.Q.value = 1;
        len = 0.07;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.022 * v, t + 0.012);
        s.connect(f).connect(g);
      } else if (kind === 'brush') {
        f.type = 'lowpass';
        f.frequency.value = 3800;
        len = 0.3;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.035 * v, t + 0.035);
        s.connect(f).connect(g);
        g.connect(M.rev);
      } else if (kind === 'clap') {
        // a handclap: three quick bursts of filtered noise, then the room
        f.type = 'bandpass';
        f.frequency.value = 1150;
        f.Q.value = 0.9;
        len = 0.16;
        g.gain.setValueAtTime(0.0001, t);
        for (const [dt, lv] of [[0, 0.12], [0.011, 0.1], [0.022, 0.14]]) {
          g.gain.setValueAtTime(lv * v, t + dt);
          g.gain.exponentialRampToValueAtTime(0.01 * v, t + dt + 0.009);
        }
        g.gain.setValueAtTime(0.1 * v, t + 0.033);
        s.connect(f).connect(g);
        g.connect(M.rev);
      } else if (kind === 'crackle') {
        f.type = 'highpass';
        f.frequency.value = 2500;
        len = 0.004;
        g.gain.setValueAtTime(0.03 * v, t);
        s.connect(f).connect(g);
      } else {
        // hats (hatO: open)
        f.type = 'highpass';
        f.frequency.value = 7500;
        len = kind === 'hatO' ? 0.2 : 0.035;
        g.gain.setValueAtTime((kind === 'hatO' ? 0.03 : 0.024) * v, t);
        s.connect(f).connect(g);
      }
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      g.connect(M.dry);
      s.start(t, Math.random() * 1.8);
      s.stop(t + len + 0.05);
    },

    // one 16th of a chill song
    step(M, n, t0, sp) {
      const S_ = M.song, L = S_.prog.length, st = n % 16, barN = Math.floor(n / 16), bar = barN % L, style = S_.chill;
      // section: 0 intro (the first half of the first pass), 1 the tune (it
      // comes in halfway through), 2 the answer, 3 breakdown, then 1 again
      const pass = Math.floor(barN / L), I = M.intensity || 0;
      // (race songs: no breakdown - the kit never drops out mid-race)
      const sec = pass === 0 ? (bar < L / 2 ? 0 : 1) : (S_.race ? [2, 1] : [2, 3, 1])[(pass - 1) % (S_.race ? 2 : 3)];
      if (st === 0 && M.warm) M.warm.frequency.setTargetAtTime(M.warmBase + I * 3500, t0, 0.3); // the final lap opens it up
      const ch = S_.prog[bar], root = ch[0], voic = ch.slice(1);
      const R = M.rng, hum = () => (R() - 0.5) * 0.008;
      const t = t0 + (st % 2 ? (S_.swing || 0) * sp : 0);
      const K = KITS[style];
      const kitOn = sec === 0 ? bar >= L / 4 : sec !== 3;
      const last = bar === L - 1;
      // kit
      if (K) {
        if (kitOn && K.kick) for (const [s, v] of K.kick) if (s === st && !(style === 'ballad' && sec !== 2)) this.drum(M, 'kick', t + hum(), v);
        if (kitOn && K.kick2 && bar % 2) for (const [s, v] of K.kick2) if (s === st) this.drum(M, 'kick', t + hum(), v);
        if (kitOn && K.snare) for (const [s, v] of K.snare) if (s === st) this.drum(M, 'snare', t + hum(), v * (0.9 + R() * 0.2));
        if (kitOn && K.clap) for (const [s, v] of K.clap) if (s === st) this.drum(M, 'clap', t + hum(), v);
        if (K.rim && (sec !== 0 || bar >= 2) && K.rim[barN % 2].includes(st)) this.drum(M, 'rim', t + hum(), 0.8 + R() * 0.3);
        if (K.shaker && (sec !== 0 || bar >= 1)) this.drum(M, 'shaker', t + hum(), [1, 0.45, 0.7, 0.45][st % 4]);
        if (K.hat && (sec !== 0 || bar >= 1)) {
          const openHat = Array.isArray(K.hatO) ? K.hatO.includes(st) : K.hatO === st && bar % 2 && sec !== 3;
          if (K.hat === 16 || I > 0.5 || st % 2 === 0 || (K.hat16 && K.hat16.includes(st))) this.drum(M, openHat ? 'hatO' : 'hat', t + hum(), (st % 2 ? 0.45 : st % 4 ? 0.7 : 1) * (0.85 + R() * 0.3));
        }
        if (K.brush && sec !== 0 && K.brush.includes(st)) this.drum(M, 'brush', t + hum(), 0.9);
        // a lift into the next section: a soft snare pickup on the last bar
        if (last && sec !== 3 && st >= 12 && K.snare && st % 2 === 0) this.drum(M, 'snare', t, 0.25 + (st - 12) * 0.08);
      }
      if (S_.crackle && R() < 0.35) this.drum(M, 'crackle', t0 + R() * sp, 0.3 + R() * 0.7);
      // bass (from the second bar of the intro)
      if (sec !== 0 || bar >= 1) {
        for (const [s, iv, len] of BASS[style]) {
          if (s !== st) continue;
          if (sec === 3 && style !== 'ballad' && s !== 0) continue; // breakdown: just the downbeat
          let m = root + iv;
          while (m > 52) m -= 12;
          this.bass(M, m, t + hum(), len * sp, 0.065, style !== 'ballad' && style !== 'lofi' && style !== 'dnb');
        }
      }
      // piano: comp in the band sections, roll arpeggios in the breakdown and the ballad
      const arp = style === 'ballad' || style === 'dark' || sec === 3;
      if (arp) {
        if (st % 2 === 0) {
          const k = st / 2, notes = voic.concat(voic.map((m) => m + 12));
          const m = notes[(k < 4 ? k : 7 - (k - 4)) % notes.length];
          this.ep(M, m, t + hum(), sp * 5, 0.05 + R() * 0.012);
        }
      } else {
        const pat = COMP[style][barN % 2];
        for (const [s, len] of pat) {
          if (s !== st) continue;
          const roll = style === 'lofi' ? 0.022 : 0.006; // lo-fi chords are rolled, low to high
          voic.forEach((m, i) => this.ep(M, m, t + hum() + i * roll, len * sp * 0.95, (s === 0 ? 0.055 : 0.042) * (0.9 + R() * 0.2)));
        }
      }
      if (S_.pad && st === 0) this.pad(M, voic.slice(0, 3).map((m) => m - 12), t, sp * 16, 0.014);
      // the guitar's offbeat chops, and brass stabs on the accents
      if (style === 'sunny' && sec !== 0) for (const [s] of PLUCK[barN % 2]) if (s === st) voic.forEach((m, i) => this.pluck(M, m + 12, t + hum() + i * 0.008, sp, 0.03));
      if (S_.brass && kitOn) for (const [s, len] of BRASS[barN % 2]) if (s === st) voic.slice(1).forEach((m) => this.brass(M, m + 12, t + hum(), len * sp * 0.9, 0.024));
      // the tune (sections 1 and 2)
      if (sec === 1 || sec === 2) {
        const mel = sec === 1 ? M.melA : M.melB, at = bar * 16 + st;
        for (const x of mel) {
          if (x.at !== at) continue;
          const v = { vibes: 0.07, bell: 0.05, flute: 0.045, synth: 0.03 }[S_.lead.inst] * (0.9 + R() * 0.2);
          this[S_.lead.inst](M, x.m + (I > 0.7 ? 12 : 0), t + hum(), x.dur * sp, v);
        }
      }
    },

    // the song's own chain: dry + reverb + tremolo, a gentle top cut
    setup(M, c) {
      const S_ = M.song;
      M.warm = c.createBiquadFilter();
      M.warm.type = 'lowpass';
      M.warmBase = S_.chill === 'lofi' ? 5200 : S_.chill === 'dark' ? 4200 : 8500;
      M.warm.frequency.value = M.warmBase;
      M.trim = c.createGain();
      M.trim.gain.value = S_.race ? 0.9 : 0.62; // (level with the other songs - race songs with the old race songs: tools/harness/songmeter.py)
      M.gain.disconnect();
      M.gain.connect(M.warm).connect(M.trim).connect(Audio.bus.music);
      M.dry = c.createGain();
      M.dry.connect(M.gain);
      if (!Chill._ir || Chill._ir.sampleRate !== c.sampleRate) {
        // (one channel, 1.8 s: half the work of a stereo room for a weak
        //  Chromebook's audio thread, and the songs are mono anyway)
        const n = Math.round(c.sampleRate * 1.8), ir = c.createBuffer(1, n, c.sampleRate);
        for (let ch = 0; ch < 1; ch++) {
          const d = ir.getChannelData(ch);
          let lp = 0;
          for (let i = 0; i < n; i++) {
            lp += (Math.random() * 2 - 1 - lp) * 0.35; // a darker tail than white noise
            d[i] = lp * Math.exp(-i / (c.sampleRate * 0.55)) * (i < c.sampleRate * 0.012 ? 0 : 1);
          }
        }
        Chill._ir = ir;
      }
      M.conv = c.createConvolver();
      M.conv.buffer = Chill._ir;
      M.rev = c.createGain();
      M.rev.gain.value = S_.chill === 'ballad' ? 0.5 : 0.3;
      M.rev.connect(M.conv).connect(M.gain);
      // the vibraphone's tremolo, shared by every bar
      M.trem = c.createGain();
      M.trem.gain.value = 0.78;
      M.tremL = c.createOscillator();
      M.tremL.frequency.value = 4.6;
      const tg = c.createGain();
      tg.gain.value = 0.22;
      M.tremL.connect(tg).connect(M.trem.gain);
      M.tremL.start();
      M.trem.connect(M.dry);
      M.melA = Chill.melody(S_, U.hashStr(M.cur) + 1);
      M.melB = Chill.melody(S_, U.hashStr(M.cur) + 7);
    },
  };
  const Music = {
    cur: null,
    timer: null,
    step: 0,
    next: 0,
    gain: null,
    intensity: 0, // v5: 0..1, the final lap turns it up
    pinned: null, // v5.5.7: a song picked in the music player (plays instead, until stopped)
    CHILL,
    SONG_INFO,
    // the music player's order: the menu, the garage playlist, the rest
    list() {
      return ['menu', 'welcome'].concat(CHILL, Object.keys(SONGS).filter((k) => k !== 'menu' && k !== 'welcome' && !CHILL.includes(k)));
    },
    age() {
      return this.cur && Audio.ctx ? Audio.ctx.currentTime - this.startedAt : 0;
    },
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
      this.startedAt = c.currentTime;
      if (this.song.chill) {
        this.send.gain.value = 0.16; // (a lighter echo: the room reverb does most of it)
        Chill.setup(this, c);
      }
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
      if (this.tremL) {
        try {
          this.tremL.stop(Audio.ctx.currentTime + 0.8);
        } catch (e) {}
        this.tremL = null;
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
      if (this.song.chill) return Chill.step(this, n, t, sp);
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
    Audio._resumeT = 0; // (resume right now, inside the click or key)
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
