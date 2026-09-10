// parts.js — cars, part catalogue, spec derivation, honest stat bars, warnings, wear costs.
//
// A car's handling is a pure function of (car, installed parts, wear). Every peer
// derives the same `spec` from the replicated session state, so the client's
// own-car prediction uses exactly the numbers the host simulates with.
'use strict';
(function (G) {
  const U = G.U;

  const CARS = {
    vandal: {
      id: 'vandal', name: 'Vandal GT', tag: 'RWD coupé', drive: 'RWD',
      blurb: 'Balanced rear-drive coupé. Slides when you ask, grips when you don\'t.',
      mass: 1200, powerKW: 132, redline: 7000, rearBias: 1.0, wheelbase: 2.6, weightFront: 0.52,
      cgH: 0.52, track: 1.6, cdA: 0.86, vTop: 54, inertiaK: 1.0, body: 'coupe', len: 4.3, wid: 1.86, price: 0,
    },
    brick: {
      id: 'brick', name: 'Brick R', tag: 'AWD rally hatch', drive: 'AWD',
      blurb: 'All-wheel-drive hatch. Launches hard and digs in on dirt; pushes wide on tarmac.',
      mass: 1330, powerKW: 125, redline: 7300, rearBias: 0.6, wheelbase: 2.5, weightFront: 0.6,
      cgH: 0.56, track: 1.58, cdA: 0.95, vTop: 50.5, inertiaK: 0.97, body: 'hatch', len: 4.0, wid: 1.82, looseBonus: 1.03,
    },
    sting: {
      id: 'sting', name: 'Sting S', tag: 'RWD roadster', drive: 'RWD',
      blurb: 'Light, low, darty roadster. Carries speed through corners; loses out on straights.',
      mass: 980, powerKW: 104, redline: 7800, rearBias: 1.0, wheelbase: 2.4, weightFront: 0.49,
      cgH: 0.45, track: 1.55, cdA: 0.78, vTop: 52, inertiaK: 0.92, body: 'roadster', len: 3.9, wid: 1.76,
    },
    mule: {
      id: 'mule', name: 'Mule V8', tag: 'RWD muscle', drive: 'RWD',
      blurb: 'Heavy V8 muscle. Monster straight-line shove, lazy nose, long braking zones.',
      mass: 1440, powerKW: 178, redline: 6300, rearBias: 1.0, wheelbase: 2.8, weightFront: 0.52,
      cgH: 0.54, track: 1.66, cdA: 0.98, vTop: 57, inertiaK: 1.06, body: 'muscle', len: 4.75, wid: 1.96,
    },
  };
  const CAR_ORDER = ['vandal', 'brick', 'sting', 'mule'];

  // Every option lists its upside (desc) and its downside (cons) — shown verbatim in the shop.
  const SLOTS = [
    {
      id: 'induction', name: 'Induction', icon: '⚙',
      options: [
        { id: 'na', name: 'Naturally Aspirated', price: 0, desc: 'Linear and predictable. Never overheats.', cons: 'No extra power.', boostGain: 0, boostLag: 0.1, boostOn: 0, heatRate: 0, fuelMult: 1, kind: 'none' },
        { id: 'sc', name: 'Supercharger', price: 2400, desc: '+32% power from low revs, instant response.', cons: 'Heat builds on long straights. Fuel ×1.6.', boostGain: 0.32, boostLag: 0.06, boostOn: 0, heatRate: 0.07, fuelMult: 1.6, kind: 'sc' },
        { id: 't1', name: 'Street Turbo', price: 3200, desc: '+55% power once spooled.', cons: '0.5 s lag, weak below half revs. Fuel ×1.9. Heat.', boostGain: 0.55, boostLag: 0.5, boostOn: 0.45, heatRate: 0.1, fuelMult: 1.9, kind: 'turbo' },
        { id: 't2', name: 'Big Turbo', price: 5800, desc: '+105% power at the top end. Brutal.', cons: '1.1 s lag, nothing below 60% revs, then all at once. Violent heat, fuel ×2.7, engine wear.', boostGain: 1.05, boostLag: 1.1, boostOn: 0.6, heatRate: 0.155, fuelMult: 2.7, kind: 'turbo' },
      ],
    },
    {
      id: 'weight', name: 'Weight', icon: '⚖',
      options: [
        { id: 'stock', name: 'Stock Trim', price: 0, desc: 'Full interior, steel panels.', cons: 'Heavy.', kg: 0 },
        { id: 'w1', name: 'Stripped Interior', price: 1500, desc: '−120 kg. Quicker everywhere.', cons: 'Easier to shove in contact.', kg: 120 },
        { id: 'w2', name: 'Carbon Panels', price: 3400, desc: '−240 kg. Big acceleration and turn-in gains.', cons: 'Gets bullied in contact. Twitchier yaw.', kg: 240 },
        { id: 'w3', name: 'Race Shell', price: 6000, desc: '−340 kg. Featherweight.', cons: 'Pinballs off other cars. Snappy — low inertia means slides happen fast.', kg: 340 },
      ],
    },
    {
      id: 'aero', name: 'Aero', icon: '✈',
      options: [
        { id: 'none', name: 'Clean Body', price: 0, desc: 'Slippery. Best top speed.', cons: 'No downforce — light at speed.', clA: 0.15, cdA: 0 },
        { id: 'a1', name: 'Lip Spoiler', price: 1600, desc: 'Mild downforce at speed.', cons: 'Small drag penalty.', clA: 1.1, cdA: 0.1, kg: 8 },
        { id: 'a2', name: 'GT Wing', price: 3600, desc: 'Real downforce in fast corners.', cons: 'Drag costs top speed. Useless in slow corners.', clA: 2.4, cdA: 0.27, kg: 20 },
        { id: 'a3', name: 'Full Aero Kit', price: 6200, desc: 'Huge high-speed grip. Glued in fast sweepers.', cons: 'Massive drag — slow on straights, terrible for drags. Does nothing below ~60 km/h.', clA: 3.8, cdA: 0.6, kg: 45 },
      ],
    },
    {
      id: 'compound', name: 'Tyre Compound', icon: '◎',
      options: [
        { id: 'hard', name: 'Hard', price: 0, desc: 'Durable. Lasts ~4 races.', cons: 'Least grip.', mu: 1.0, wear: 1.0, peak: 0.165, set: 250, stripe: 0xf4f4f4 },
        { id: 'medium', name: 'Medium', price: 900, desc: '+6% grip.', cons: 'Wears ~1.8× faster.', mu: 1.06, wear: 1.8, peak: 0.155, set: 400, stripe: 0xffd21f },
        { id: 'soft', name: 'Soft', price: 1900, desc: '+13% grip. Sticky.', cons: 'Wears ~3× faster — grip falls off within a race or two.', mu: 1.13, wear: 3.0, peak: 0.145, set: 600, stripe: 0xff3b30 },
      ],
    },
    {
      id: 'width', name: 'Tyre Width', icon: '▮',
      options: [
        { id: 'std', name: 'Standard', price: 0, desc: 'All-rounder.', cons: '—', dry: 1.0, wetM: 1.0, loose: 1.0, cdA: 0, setMul: 1, vis: 1 },
        { id: 'narrow', name: 'Narrow Rally', price: 700, desc: '+14% wet grip, +10% on dirt/gravel.', cons: '−6% dry grip.', dry: 0.94, wetM: 1.14, loose: 1.1, cdA: -0.01, setMul: 0.9, vis: 0.8 },
        { id: 'wide', name: 'Wide', price: 1500, desc: '+9% dry grip.', cons: 'Aquaplanes: −26% wet grip (worse with speed), −10% on dirt. Slight drag.', dry: 1.09, wetM: 0.74, loose: 0.9, cdA: 0.03, setMul: 1.35, vis: 1.3, aqua: 1 },
      ],
    },
    {
      id: 'gearing', name: 'Gearing', icon: '⛭',
      options: [
        { id: 'stock', name: 'Stock 5-Speed', price: 0, desc: 'Balanced ratios.', cons: 'Slowish 0.16 s shifts.', fd: 1.0, gears: [3.25, 2.1, 1.52, 1.17, 0.94], shift: 0.16, kick: 1.0 },
        // Short ratios alone did nothing under full throttle (launches are
        // traction-limited, and the extra upshift ate the torque gain — measured
        // 0.04 s SLOWER over ¼ mile). Bundled with a quick-shift linkage they
        // genuinely launch harder, and still pay with a low limiter.
        { id: 'short', name: 'Short Ratios + Quick-shift', price: 1100, desc: '+22% wheel torque and 0.10 s shifts — quicker off the line and out of corners.', cons: 'Hits the limiter early: much lower top speed. Useless on long straights.', fd: 1.22, gears: [3.25, 2.1, 1.52, 1.17, 0.94], shift: 0.1, kick: 1.0 },
        { id: 'long', name: 'Long Ratios', price: 1100, desc: 'Higher top speed — lets big power keep pulling.', cons: '−16% wheel torque: sluggish out of corners.', fd: 0.84, gears: [3.25, 2.1, 1.52, 1.17, 0.94], shift: 0.16, kick: 1.0 },
        { id: 'seq', name: 'Sequential Race Box', price: 3000, desc: '6 close ratios, 0.05 s shifts.', cons: 'Violent shifts kick the rear loose mid-corner. Extra engine wear.', fd: 1.0, gears: [3.1, 2.2, 1.66, 1.32, 1.09, 0.92], shift: 0.05, kick: 1.7 },
      ],
    },
    {
      id: 'suspension', name: 'Suspension', icon: '⌇',
      options: [
        { id: 'stock', name: 'Road Springs', price: 0, desc: 'Comfortable, soaks up kerbs.', cons: 'Lazy turn-in, lots of roll.', loadTau: 0.1, latTau: 0.05, roll: 1.0, bump: 0.55, rideH: 0, roughGrip: 0.1, steer: 1.0, looseM: 1.0 },
        { id: 'sport', name: 'Sport Coilovers', price: 1300, desc: 'Sharper turn-in, less roll.', cons: 'Kerbs and ruts unsettle it.', loadTau: 0.07, latTau: 0.033, roll: 0.7, bump: 0.95, rideH: -0.03, roughGrip: 0.16, steer: 1.15, looseM: 0.97 },
        { id: 'race', name: 'Race Dampers', price: 2900, desc: 'Razor turn-in, flat cornering.', cons: 'Skips over kerbs/dirt and loses grip there. Snappy at the limit.', loadTau: 0.04, latTau: 0.02, roll: 0.4, bump: 1.5, rideH: -0.06, roughGrip: 0.27, steer: 1.3, looseM: 0.9 },
        { id: 'rally', name: 'Long-Travel Rally', price: 1900, desc: 'Floats over dirt, kerbs and bumps. +7% loose grip.', cons: 'Soggy on tarmac: slow turn-in, big roll.', loadTau: 0.13, latTau: 0.065, roll: 1.4, bump: 0.2, rideH: 0.07, roughGrip: 0.04, steer: 0.92, looseM: 1.07 },
      ],
    },
  ];
  const SLOT_MAP = {};
  SLOTS.forEach((s) => {
    SLOT_MAP[s.id] = s;
    s.options.forEach((o) => (o.slot = s.id));
  });
  const STOCK = { induction: 'na', weight: 'stock', aero: 'none', compound: 'hard', width: 'std', gearing: 'stock', suspension: 'stock' };
  const opt = (slot, id) => SLOT_MAP[slot].options.find((o) => o.id === id) || SLOT_MAP[slot].options[0];

  const G_ACC = 9.81, RHO = 1.2, WHEEL_R = 0.33;

  // Engine torque shape vs normalised rpm: peak torque at 62% revs, and POWER
  // keeps rising all the way to the redline. That matters for gearing: with
  // the old curve (power peak at 89%, shift at 93%) revving higher gained
  // nothing, so Short Ratios were slower than stock at EVERYTHING and Long
  // Ratios were strictly better — no trade-off. Now short gears keep the
  // engine nearer peak power (quicker, but hit the limiter), long gears the
  // opposite.
  const torqueShape = (r) => 1 - 1.0 * (r - 0.62) * (r - 0.62);
  const POWER_SHAPE_PEAK = 0.8556; // r*torqueShape(r) at r = 1 (its maximum on [0,1])

  // Boost availability vs normalised rpm (turbos need revs; superchargers don't).
  function boostAvail(spec, r) {
    if (spec.boostKind === 'none') return 0;
    if (spec.boostKind === 'sc') return 0.45 + 0.55 * r;
    return U.smoothstep(spec.boostOn - 0.12, spec.boostOn + 0.12, r);
  }

  // ------------------------------------------------------------------------
  // computeSpec: the ONLY place parts turn into physics numbers.
  // ------------------------------------------------------------------------
  function computeSpec(carId, installed, wear) {
    const c = CARS[carId] || CARS.vandal;
    const p = Object.assign({}, STOCK, installed || {});
    const w = Object.assign({ tyre: 0, engine: 0, body: 0 }, wear || {});
    const ind = opt('induction', p.induction), wt = opt('weight', p.weight), ae = opt('aero', p.aero);
    const cp = opt('compound', p.compound), wd = opt('width', p.width), gr = opt('gearing', p.gearing), su = opt('suspension', p.suspension);

    const mass = c.mass - wt.kg + (ae.kg || 0);
    const cgF = c.wheelbase * (1 - c.weightFront); // distance CG -> front axle
    const cgR = c.wheelbase - cgF;
    // Yaw inertia via the "dynamic index" k: Iz = m * a * b * k (k≈1 for road
    // cars). Weight comes off high and wide (panels, glass), so a stripped car
    // loses inertia faster than mass — it rotates (and spins) quicker.
    const inertiaScale = 1 - (wt.kg / c.mass) * 0.6;
    const Iz = mass * cgF * cgR * c.inertiaK * inertiaScale;

    const redlineW = (c.redline * 2 * Math.PI) / 60;
    // Final drive chosen so the stock car hits the limiter at vTop in top gear.
    const baseFD = (redlineW * WHEEL_R) / (c.vTop * 0.94);
    const gears = gr.gears.slice();
    const finalDrive = baseFD * gr.fd;
    const engineHealth = 1 - 0.38 * Math.pow(U.clamp(w.engine, 0, 1), 1.3);
    const peakTorque = (c.powerKW * 1000) / (POWER_SHAPE_PEAK * redlineW);

    const tyreHealth = 1 - 0.32 * Math.pow(U.clamp(w.tyre, 0, 1), 1.6);
    const mu = 1.12 * cp.mu * tyreHealth;

    // Per-surface grip multipliers (indexed by G.SURF code), built from width + suspension + car.
    const loose = wd.loose * su.looseM * (c.looseBonus || 1);
    const surfMul = G.SURF.map((s) => {
      let m = s.grip;
      if (s.wet) m *= wd.wetM;
      else if (s.loose) m *= loose;
      else m *= wd.dry;
      return m;
    });

    const s = {
      carId: c.id, parts: p,
      mass, Iz, wheelbase: c.wheelbase, cgF, cgR, cgH: c.cgH + su.rideH * 0.5, track: c.track, wheelR: WHEEL_R,
      len: c.len, wid: c.wid,
      rearBias: c.rearBias, drive: c.drive,
      redline: c.redline, redlineW, idle: 0.14, peakTorque, gears, finalDrive, revRatio: 3.4,
      shiftTime: gr.shift, shiftKick: gr.kick, upR: 0.97, downR: 0.55,
      boostKind: ind.kind, boostGain: ind.boostGain, boostLag: ind.boostLag, boostOn: ind.boostOn,
      heatRate: ind.heatRate, coolRate: 0.035, fuelRate: 0.85 * ind.fuelMult,
      engineHealth,
      clA: ae.clA, cdA: c.cdA + ae.cdA + wd.cdA + w.body * 0.12, aeroFront: 0.42,
      mu, rearGrip: 1.0, peakSlip: cp.peak, slideRatio: 0.8, surfMul, aqua: wd.aqua ? 1 : 0,
      loadSens: 0.16, fzNom: (1200 * G_ACC) / 4,
      tyreWearRate: cp.wear, tyreHealth,
      loadTau: su.loadTau, latTau: su.latTau, rollGain: su.roll, bumpSens: su.bump, rideH: su.rideH, roughGrip: su.roughGrip,
      // Lock shrinks with speed: lock = 0.56 / (1 + v/14). At 90 km/h full keyboard
      // lock ≈ 0.16 rad — near the tyres' peak slip, so holding a key at speed
      // turns hard instead of scrubbing the fronts wide. (Falloff 24 -> 14 cut a
      // binary-input driver's off-track time 42 s -> 25 s per 150 s on Harbour;
      // analogue bot lap times unchanged.)
      steerLock: 0.56, steerFalloff: 14, steerRate: 3.4 * su.steer,
      brakeForce: mass * G_ACC * 1.3, brakeFront: 0.62,
      csAssist: 0.6, yawDamp: 0.9, spinAssist: 2.2, spinAngle: 0.62,
      engineWearRate: 0.00016 * (1 + ind.boostGain * 1.4) * (gr.id === 'seq' ? 1.25 : 1),
      heatDamage: 0.006,
      bodyPull: (w.body || 0) * 0.02,
    };
    return s;
  }

  // Max drive force at speed v over all gears (full throttle, full boost), N.
  function driveForceAt(s, v, boostOverride) {
    let best = 0;
    for (let g = 0; g < s.gears.length; g++) {
      const ratio = s.gears[g] * s.finalDrive;
      const w = (v / s.wheelR) * ratio;
      let r = w / s.redlineW;
      if (r > 1.0) continue;
      r = Math.max(r, 0.3);
      const b = boostOverride != null ? boostOverride : boostAvail(s, r);
      const T = s.peakTorque * torqueShape(r) * (1 + s.boostGain * b) * s.engineHealth;
      const F = (T * ratio * 0.9) / s.wheelR;
      if (F > best) best = F;
    }
    return best;
  }

  function topSpeed(s) {
    for (let v = 5; v < 110; v += 0.25) {
      const drag = 0.5 * RHO * s.cdA * v * v + 0.012 * s.mass * G_ACC;
      if (driveForceAt(s, v) < drag) return v;
    }
    return 110;
  }

  // 1-D launch simulation with boost lag, shift time and a traction cap.
  // Returns seconds from v0 to v1 (m/s). zeroTo100 = accelTime(s, 0, 27.78).
  function zeroTo100(s) {
    return accelTime(s, 0, 27.78);
  }
  function accelTime(s, v0, v1) {
    let v = v0, t = 0, boost = 0, gear = 0, shiftT = 0;
    // start in the gear an automatic box would hold at v0
    while (gear < s.gears.length - 1 && ((v0 / s.wheelR) * s.gears[gear] * s.finalDrive) / s.redlineW > s.upR * 0.9) gear++;
    const dt = 0.01;
    const drivenShare = s.rearBias >= 0.99 ? (s.cgF / s.wheelbase) + 0.1 : 1.0;
    const traction = s.mu * s.surfMul[0] * s.mass * G_ACC * drivenShare * 1.02;
    while (v < v1 && t < 40) {
      const ratio = s.gears[gear] * s.finalDrive;
      let r = ((v / s.wheelR) * ratio) / s.redlineW;
      const rr = Math.max(r, 0.45);
      const target = boostAvail(s, rr);
      boost += (target - boost) * Math.min(1, dt / s.boostLag);
      let F = 0;
      if (shiftT > 0) shiftT -= dt;
      else {
        const T = s.peakTorque * torqueShape(rr) * (1 + s.boostGain * boost) * s.engineHealth;
        F = Math.min((T * ratio * 0.9) / s.wheelR, traction);
      }
      if (r > s.upR && gear < s.gears.length - 1) {
        gear++;
        shiftT = s.shiftTime;
      }
      const drag = 0.5 * RHO * s.cdA * v * v + 0.012 * s.mass * G_ACC;
      v += ((F - drag) / s.mass) * dt;
      t += dt;
    }
    return t;
  }

  // Acceleration measured with the REAL physics: full throttle from rest on a
  // long straight, wheels pointing ahead. Includes wheelspin, boost lag, shift
  // times and straight-line twitchiness — so the shop bar tells the truth
  // (the simplified 1-D model said Short Ratios were slower than stock, while
  // on track they won the quarter-mile). ~8 ms per build; callers cache.
  let _straight = null;
  function straightTrack() {
    return _straight || (_straight = new G.Track({ id: 'statpad', name: 'pad', format: 'drag', theme: 'airstrip', runoff: 6, startAt: 20, finishBack: 0, dragLength: 402, pts: [[0, -20, { w: 40, s: 'tarmac' }], [0, 400], [0, 950]] }));
  }
  function physAccel(s) {
    const P = G.Physics, tr = straightTrack();
    const st = P.createCar(0, 0, 0);
    st.hint = -1;
    const inp = { s: 0, t: 1, b: 0, hb: 0 };
    let t = 0, t30 = null, t100 = null, t130 = null, tq = null;
    for (let i = 0; i < 120 * 25 && (tq == null || t130 == null); i++) {
      P.step(st, s, inp, tr, P.DT, {});
      t += P.DT;
      const v = Math.hypot(st.vx, st.vz);
      if (t30 == null && v >= 8.33) t30 = t;
      if (t100 == null && v >= 27.78) t100 = t;
      if (t130 == null && v >= 36.1) t130 = t;
      if (tq == null && st.z >= 402) tq = t;
    }
    return { t100: t100 || 25, tRoll: t130 && t30 ? t130 - t30 : 25, tq: tq || 25 };
  }

  function lateralG(s, v, surf) {
    const m = s.mass;
    const D = 0.5 * RHO * s.clA * v * v;
    const fz = (m * G_ACC + D) / 4;
    const sens = 1 - s.loadSens * (fz / s.fzNom - 1);
    return (s.mu * s.surfMul[surf] * sens * (m * G_ACC + D)) / (m * G_ACC) * 0.94;
  }

  // Ratio of rear drive force to rear grip at 18 m/s in the best gear. >1 = wheelspin.
  function rearExcess(s) {
    const v = 16;
    const F = driveForceAt(s, v, 1) * s.rearBias;
    const D = 0.5 * RHO * s.clA * v * v * (1 - s.aeroFront);
    const rearLoad = s.mass * G_ACC * (s.cgF / s.wheelbase) + D;
    return F / (s.mu * s.rearGrip * rearLoad);
  }

  // Honest 0..10 bars. `hi` = higher is better for the player; cost bars are inverted.
  function computeStats(s) {
    const vmax = topSpeed(s);
    const acc = physAccel(s);
    const t100 = acc.t100, tRoll = acc.tRoll, tq = acc.tq;
    const gHigh = lateralG(s, 38, 0), gLow = lateralG(s, 13, 0);
    const ex = rearExcess(s);
    const dyn = s.Iz / (s.mass * s.cgF * s.cgR); // dynamic index: <1 = rotates quickly
    // Stability: throttle-vs-rear-grip, yaw inertia, rear downforce, spring rate.
    let stab = 9.2;
    stab -= U.clamp((ex - 0.75) * 5.2, 0, 6.5);
    stab -= U.clamp((1.0 - dyn) * 9, 0, 2.5);
    stab += U.clamp(s.clA * 0.45, 0, 1.6);
    stab -= (0.1 - s.loadTau) * 9;
    if (s.shiftKick > 1.2) stab -= 0.8;
    if (s.boostKind === 'turbo') stab -= s.boostLag * 1.1;
    stab = U.clamp(stab, 0, 10);
    const rough = ((s.surfMul[G.SI.wet] + s.surfMul[G.SI.dirt] + s.surfMul[G.SI.gravel]) / 3) * s.mu * (1 - s.bumpSens * 0.18);
    const cost = runningCost(s);
    const heatSecs = s.heatRate > 0 ? 1 / Math.max(0.001, s.heatRate - s.coolRate * 0.75) : Infinity;
    return {
      vmax, t100, tRoll, tq, gHigh, gLow, ex, heatSecs, cost,
      bars: [
        { k: 'Top speed', v: U.clamp((vmax * 3.6 - 150) / 10, 0, 10), txt: Math.round(vmax * 3.6) + ' km/h' },
        { k: 'Acceleration', v: U.clamp((17 - tq) * 2.5, 0, 10), txt: t100.toFixed(1) + ' s 0-100 · ¼ mi ' + tq.toFixed(2) + ' s' },
        { k: 'Fast-corner grip', v: U.clamp((gHigh - 0.85) * 9, 0, 10), txt: gHigh.toFixed(2) + ' g' },
        { k: 'Slow-corner grip', v: U.clamp((gLow - 0.85) * 9, 0, 10), txt: gLow.toFixed(2) + ' g' },
        { k: 'Wet / dirt grip', v: U.clamp((rough - 0.55) * 18, 0, 10), txt: Math.round(rough * 100) + '%' },
        { k: 'Stability', v: stab, txt: stab < 3 ? 'WILD' : stab < 5.5 ? 'twitchy' : stab < 7.5 ? 'lively' : 'planted' },
        { k: 'Running cost', v: U.clamp(10 - cost / 70, 0, 10), txt: '~' + U.fmtMoney(cost) + '/race', cost: true },
      ],
    };
  }

  // Rough per-race cost of fuel + tyre + engine wear for a typical 150 s race.
  function runningCost(s) {
    // Calibrated against bot telemetry on Harbour Loop (3 laps ≈ 150 s).
    const fuel = 150 * s.fuelRate * (0.15 + 0.85 * 0.42) * (1 + s.boostGain * 0.35);
    const tyreWear = 150 * (0.0004 + 0.00003 * 22 + 0.0025 * 0.12) * s.tyreWearRate * (s.mass / 1200);
    const tyres = tyreWear * tyreSetPrice(s.parts);
    const engWear = 150 * s.engineWearRate * 0.45 * (1 + s.boostGain * 0.4) + (s.heatRate > 0.12 ? 0.02 : 0);
    const eng = engWear * engineRebuildPrice(s.parts);
    return fuel + tyres + eng;
  }

  function tyreSetPrice(parts) {
    const p = Object.assign({}, STOCK, parts);
    return Math.round(opt('compound', p.compound).set * opt('width', p.width).setMul);
  }
  function engineRebuildPrice(parts) {
    const p = Object.assign({}, STOCK, parts);
    return 900 + 0.35 * opt('induction', p.induction).price;
  }
  const BODY_REPAIR = 700;
  const BASIC_REPAIR = 300; // casino / betting floor: you can never gamble below this

  function repairQuote(parts, wear) {
    const w = Object.assign({ tyre: 0, engine: 0, body: 0 }, wear || {});
    return {
      tyre: w.tyre > 0.01 ? Math.round(tyreSetPrice(parts)) : 0,
      engine: w.engine > 0.01 ? Math.round(engineRebuildPrice(parts) * w.engine) : 0,
      body: w.body > 0.01 ? Math.round(BODY_REPAIR * w.body) : 0,
    };
  }

  // Plain-English warnings about part interactions. `next` = next track (or null).
  function warnings(s, next) {
    const out = [];
    const p = s.parts;
    const ex = rearExcess(s);
    if (s.rearBias > 0.9 && ex > 1.25) out.push(['bad', 'Throttle overwhelms the rear tyres (' + Math.round(ex * 100) + '%): wheelspin and snap oversteer out of slow corners.']);
    else if (ex > 1.0) out.push(['warn', 'Rear tyres are near their limit under full throttle — feed it in gently.']);
    if (s.boostGain >= 0.5 && s.clA < 1) out.push(['bad', 'Big boost with no downforce: the rear goes light at speed.']);
    if (opt('weight', p.weight).kg >= 240) out.push(['warn', 'Featherweight: heavier cars will shove you across the track in contact.']);
    if (opt('weight', p.weight).kg >= 240 && s.boostGain >= 1) out.push(['bad', 'Big Turbo on a stripped shell with this aero: genuinely unstable. Good luck.']);
    if (p.width === 'wide') out.push(['warn', 'Wide tyres aquaplane on wet sections and slide on dirt.']);
    if (p.suspension === 'race') out.push(['warn', 'Race dampers skip over kerbs and dirt ruts.']);
    if (p.aero === 'a2' || p.aero === 'a3') out.push(['warn', 'Wing drag costs top speed; downforce does nothing in slow corners.']);
    if (p.compound === 'soft') out.push(['warn', 'Soft tyres wear ~3× faster — expect grip to fade within a race or two.']);
    if (p.gearing === 'short') out.push(['warn', 'Short gears: limiter at ' + Math.round(topSpeed(s) * 3.6) + ' km/h.']);
    if (p.gearing === 'seq') out.push(['warn', 'Sequential shifts kick the rear — careful mid-corner.']);
    if (s.heatRate > 0) {
      const secs = 1 / Math.max(0.001, s.heatRate - s.coolRate * 0.75);
      out.push([secs < 20 ? 'bad' : 'warn', 'Overheats after ~' + Math.round(secs) + ' s of sustained boost → limp mode + engine damage.']);
    }
    if (next) {
      if (next.format === 'drag' && (p.aero === 'a2' || p.aero === 'a3')) out.push(['bad', 'Next race is a DRAG: that wing is pure drag. Swap it out.']);
      if (next.format === 'drag' && p.gearing === 'short' && next.def.dragLength > 500) out.push(['warn', 'Half-mile drag next: short gears will bounce off the limiter.']);
      const hasWet = Array.from(next.S).some((c) => c === G.SI.wet);
      const hasLoose = Array.from(next.S).some((c) => c === G.SI.dirt || c === G.SI.gravel);
      if (hasWet && p.width === 'wide') out.push(['bad', 'Next track has WET sections — wide tyres will aquaplane.']);
      if (hasLoose && p.suspension === 'race') out.push(['warn', 'Next track has dirt — race dampers will skip.']);
    }
    return out;
  }

  // Default (not yet owned) build list for a new player.
  function newGarage(carId) {
    const owned = {};
    SLOTS.forEach((s) => (owned[s.id] = [s.options[0].id]));
    return { carId, installed: Object.assign({}, STOCK), owned, wear: { tyre: 0, engine: 0, body: 0 } };
  }

  function partsValue(garage) {
    let v = 0;
    SLOTS.forEach((s) => (garage.owned[s.id] || []).forEach((id) => (v += opt(s.id, id).price)));
    return v;
  }

  G.Parts = {
    CARS, CAR_ORDER, SLOTS, SLOT_MAP, STOCK, opt, computeSpec, computeStats, warnings, boostAvail, torqueShape,
    topSpeed, zeroTo100, repairQuote, tyreSetPrice, engineRebuildPrice, BASIC_REPAIR, BODY_REPAIR, newGarage, partsValue,
    WHEEL_R, RHO, G_ACC,
  };
})(window.G);
