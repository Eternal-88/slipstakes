// physics.js — the arcade vehicle model. THIS IS WHERE THE BUGS LIVE: read the
// comments before touching anything.
//
// Model summary
// -------------
// * The car is a 2-D rigid body on the ground plane (x, z) with yaw `h`.
//   Pitch/roll are NOT simulated as degrees of freedom; they are derived from
//   smoothed load transfer and only drive (a) per-wheel vertical load and
//   (b) the visual body tilt. This keeps the sim cheap and stable at 120 Hz.
// * Four wheels, each with its own vertical load Fz, surface, grip, slip angle
//   and friction circle. Surfaces are looked up per wheel, so putting two wheels
//   on the grass really does yank the car.
// * Rear slip is allowed and encouraged: drive force is applied first and eats
//   into the lateral grip budget (friction circle), so full throttle in a low
//   gear breaks the rear loose -> powerslide. A mild countersteer assist and a
//   spin-recovery yaw torque keep it forgiving without masking part downsides.
//
// Conventions (critical — sign errors here make the car turn the wrong way)
// -------------------------------------------------------------------------
//   forward f = ( sin h, cos h)      left l = ( cos h, -sin h)
//   +yawRate (w) rotates the nose toward the LEFT.
//   Local velocity: vLong = v·f, vLat = v·l   (vLat > 0 => sliding left)
//   Steer angle `steer` > 0 = front wheels pointed LEFT. Input s > 0 = steer RIGHT.
//   A point at local offset (u fwd, v left) moves with  (vLong - w*v, vLat + w*u).
//   A local force (Fu, Fv) at (u, v) gives yaw torque  u*Fv - v*Fu.
//
// Determinism: step() is a pure function of (state, spec, input, track, dt).
// The host runs it authoritatively; clients run the same code for their own
// car only (prediction), then get corrected. Car-vs-car contacts are host-only
// (see race.js); wall contacts are in here so prediction doesn't clip walls.
'use strict';
(function (G) {
  const U = G.U;
  const G_ACC = 9.81, RHO = 1.2;
  const DT = 1 / 120; // fixed simulation step (s)
  const LOW_V = 2.5; // m/s floor used in slip-angle denominators
  // Live-tunable constants (exposed as G.Physics.TUNE so feel can be iterated
  // from the console). Identical on every peer — never tune per-player.
  const TUNE = {
    lsd: 0.6, // 0 = open diff (50/50), 1 = torque fully follows wheel load
    longGrip: 1.05, // longitudinal / lateral peak grip ratio
    hbLat: 0.22, // rear lateral grip multiplier with the handbrake on
    circle: 0.88, // friction-circle ellipticity (<1 = a little forgiving)
    // Chosen from sweeps (tools/telemetry.js): 1.00 gives the best slides but
    // makes powerful RWD cars scrappy for bots and keyboard players; 1.04 was
    // stable but stock slides shrank to ~8° after the torque-curve change.
    // 1.03: stock Vandal full-throttle full-lock slides ~10°, Mule ~13°, Big
    // Turbo + Race Shell ~52° (wild), handbrake flick ~40°.
    rearGrip: 1.03, // global rear/front grip balance (>1 = more understeer)
    rearPeak: 1.08, // rear peak slip angle vs front (>1 = rear takes a bigger slip angle => drift look)
    // Brake heat: tuned with a full-pedal (keyboard) driver on Kerbside City —
    // road brakes reach ~0.85 on lap 1 and ~1.1 by lap 3 (≈25% fade); the big
    // brake kit stays under 0.55 (no fade); carbon warms up in 1–2 stops.
    bHeat: 0.66, // brake heating per second at full pedal, 30 m/s, bCap 1
    bCool: 0.06, // brake cooling rate (× temperature)
    abs: 0.9, // ABS holds braking tyres at this fraction of peak grip (>= 0.95 = off)
    // Steering assist, chosen from sweeps with a keyboard-proxy driver
    // (tools/telemetry.js T.kbSuite): gated to understeer (|β| < 0.05) it cut
    // time off-track 102 s -> 74 s over seven test runs, spins 0.1 -> 1.2 s,
    // and left powerslide / handbrake angles and bot lap times unchanged.
    // Ungated it halved off-track time but spun 6 s and doubled slide angles.
    steerAssist: 1.3, // front slip-angle window, × peak slip (0 = off) — see §3
    saV0: 8, // m/s: assist starts fading in…
    saV1: 8.01, // …and is fully on (a speed fade measured no benefit)
    saBeta: 0.05, // only while body slip |β| < this (rad): understeer, not slides
  };
  const _drv = [0, 0, 0, 0]; // per-wheel drive force scratch

  function createCar(x, z, h) {
    return {
      x, z, h, vx: 0, vz: 0, w: 0,
      steer: 0, rpm: 0.14, gear: 1, shiftT: 0, kickT: 0,
      boost: 0, heat: 0, overheat: 0, ax: 0, ay: 0,
      fy: [0, 0, 0, 0], slip: [0, 0, 0, 0], surf: [0, 0, 0, 0], fz: [0, 0, 0, 0],
      hint: -1, spin: 0, lock: 0, offT: 0, wallHit: 0, backfire: 0,
      tyreWear: 0, engineWear: 0, body: 0, fuel: 0, odo: 0, thr: 0, brk: 0, hb: 0,
      ghost: 0, // seconds of no car-car collision after a respawn
      bt: 0, // brake temperature (0 cold .. ~1.4); see §7b
      // v4 race assists, all set by the HOST (race.js) and replicated: a
      // client's prediction just holds the last value it was sent.
      draft: 0, // slipstream 0..1 (a car close ahead)
      cu: 0, // catch-up power bonus 0..~0.25 (trailing the leader)
      nos: 1, // nitrous bottle 0..1 (only with a Nitrous part)
      nosOn: 0, // nitrous firing this step (visual/sound)
      padT: 0, // cooldown after a speed pad
    };
  }

  // Core state that must round-trip for prediction/reconciliation.
  const CORE = ['x', 'z', 'h', 'vx', 'vz', 'w', 'steer', 'rpm', 'gear', 'shiftT', 'kickT', 'boost', 'heat', 'overheat', 'ax', 'ay', 'tyreWear', 'engineWear', 'body', 'fuel', 'odo', 'ghost', 'bt', 'draft', 'cu', 'nos', 'padT'];
  function copyCore(dst, src) {
    for (let i = 0; i < CORE.length; i++) dst[CORE[i]] = src[CORE[i]];
    for (let i = 0; i < 4; i++) dst.fy[i] = src.fy[i];
    dst.hint = src.hint;
    return dst;
  }

  // Normalised lateral tyre curve. Rises to 1.0 at the peak slip angle, then
  // falls smoothly to `slide` — that fall-off is what makes a slide a slide
  // rather than infinite grip, and what makes it recoverable (it doesn't go to 0).
  function tyreCurve(a, peak, slide) {
    const x = a / peak;
    if (x < 1) return x * (2 - x);
    const k = Math.min((x - 1) / 2.5, 1);
    return 1 - (1 - slide) * k * k * (3 - 2 * k);
  }

  const Q = { i: 0, along: 0, lat: 0, hw: 0, bank: 0, tx: 0, tz: 0, nx: 0, nz: 0, wall: 0, surf: 0, gr: 0 };
  const WQ = [{}, {}, {}, {}].map(() => Object.assign({}, Q));
  const _lu = [0, 0, 0, 0], _lv = [0, 0, 0, 0];

  // ---------------------------------------------------------------------------
  // step(car, spec, input, track, dt, opts)
  //   input: { s: steer -1..1 (+right), t: throttle 0..1, b: brake 0..1, hb: 0/1, n: nitrous 0/1 }
  //   opts.frozen: grid hold (brakes locked, engine can rev)
  // ---------------------------------------------------------------------------
  function step(car, s, inp, track, dt, opts) {
    const frozen = opts && opts.frozen;
    let thr = U.clamp(inp.t || 0, 0, 1);
    let brk = U.clamp(inp.b || 0, 0, 1);
    const steerIn = U.clamp(inp.s || 0, -1, 1);
    const hb = inp.hb ? 1 : 0;

    // ---- 1. Car frame -------------------------------------------------------
    const sinH = Math.sin(car.h), cosH = Math.cos(car.h);
    const fx = sinH, fz = cosH, lx = cosH, lz = -sinH;
    const vLong = car.vx * fx + car.vz * fz;
    const vLat = car.vx * lx + car.vz * lz;
    const speed = Math.hypot(car.vx, car.vz);

    // ---- 2. Reverse logic ---------------------------------------------------
    // Brake held while (nearly) stopped engages reverse; throttle cancels it.
    // Brake + HANDBRAKE together = "park": never selects reverse. The host uses
    // that for disconnected/DNF cars — plain brake would make an unattended
    // car reverse at full power (in reverse the brake pedal is the throttle).
    if (!frozen) {
      if (car.gear > 0 && brk > 0.5 && thr < 0.1 && vLong < 0.6 && !hb) car.gear = -1;
      else if (car.gear === -1 && thr > 0.1 && vLong > -0.6) car.gear = 1;
    }
    let driveThr = thr, brakeAmt = brk;
    if (car.gear === -1) {
      driveThr = brk;
      brakeAmt = thr;
    }
    if (frozen) {
      brakeAmt = 1;
    }
    car.thr = thr; car.brk = brk; car.hb = hb;

    // ---- 3. Steering --------------------------------------------------------
    // Lock shrinks with speed so keyboard players don't spin at 150 km/h.
    const lock = s.steerLock / (1 + speed / s.steerFalloff);
    let target = -steerIn * lock;
    // Countersteer assist: β is the angle between the nose and the direction of
    // travel. Adding k*β points the front wheels toward travel, which is exactly
    // what a driver does to catch a slide. Stronger when the player isn't steering.
    const beta = speed > 3 && vLong > 0 ? Math.atan2(vLat, Math.abs(vLong)) : 0;
    target += beta * s.csAssist * (Math.abs(steerIn) < 0.1 ? 1.0 : 0.55);
    target = U.clamp(target, -s.steerLock, s.steerLock);
    // Grip-limited steering (arcade assist, identical for every car, input
    // device and peer): never ask the front tyres for more slip angle than
    // just past their peak. Beyond the peak the tyre curve FALLS (§7), so
    // extra lock means LESS grip and the car runs wide — exactly what a
    // keyboard's all-or-nothing full lock did in every fast corner. The
    // window is centred on the front axle's actual direction of travel, so
    // countersteering a slide is never limited.
    // It fades in with speed (saV0→saV1): at low speed it would stop you
    // throwing the car into a hairpin, and it made full-lock powerslides much
    // bigger (the fronts always had grip to spare) — measured, not guessed.
    // saBeta gates it to UNDERSTEER: once the rear is sliding (|β| past the
    // gate) the player gets full lock back, so the assist never feeds a slide.
    if (TUNE.steerAssist && speed > TUNE.saV0 && vLong > 4 && (!TUNE.saBeta || Math.abs(beta) < TUNE.saBeta)) {
      const bf = Math.atan2(vLat + car.w * s.cgF, vLong);
      const fadeIn = U.clamp((speed - TUNE.saV0) / Math.max(0.01, TUNE.saV1 - TUNE.saV0), 0, 1);
      const pk = s.peakSlip * (s.peakF || 1) * TUNE.steerAssist * (1 + 2.5 * (1 - fadeIn));
      target = U.clamp(target, bf - pk, bf + pk);
    }
    const rate = s.steerRate * (Math.abs(target) < Math.abs(car.steer) ? 1.6 : 1);
    car.steer += U.clamp(target - car.steer, -rate * dt, rate * dt);
    car.steer += s.bodyPull * dt * 0.2 * (speed > 5 ? 1 : 0); // bent chassis pulls left

    // ---- 4. Aero ------------------------------------------------------------
    // Slipstream: race.js sets car.draft (0..1) when a car is close ahead;
    // it cuts drag by up to 45%. Catch-up (car.cu, only while trailing the
    // leader with the host's Catch-up setting on) trims drag a little too.
    const q = 0.5 * RHO * speed * speed;
    const down = q * s.clA;
    const drag = q * s.cdA * (1 - 0.45 * (car.draft || 0)) * (1 - 0.6 * (car.cu || 0));

    // ---- 5. Vertical loads (static + smoothed load transfer + downforce) ---
    // car.ax/car.ay are LAST step's smoothed local accelerations. Using the lagged
    // values avoids an algebraic loop (load -> grip -> accel -> load) and the lag
    // time constant IS the suspension stiffness: stiff = fast weight transfer =
    // sharp turn-in; soft = lazy.
    const L = s.wheelbase, a = s.cgF, b = s.cgR;
    const mg = s.mass * G_ACC;
    const FzF = (mg * b) / L, FzR = (mg * a) / L;
    const dLong = (s.mass * car.ax * s.cgH) / L; // + when accelerating (rear gains)
    const dLat = (s.mass * car.ay * s.cgH) / s.track; // + when accelerating left (right gains)
    // Front share of roll stiffness (anti-roll bar setup; 0.55 = default).
    // The axle with the bigger share carries more of the lateral load
    // transfer, and through tyre load sensitivity loses grip first.
    const rf = s.rollF != null ? s.rollF : 0.55;
    const dF = down * s.aeroFront, dR = down * (1 - s.aeroFront);
    const fzs = car.fz;
    fzs[0] = FzF / 2 - dLong / 2 - dLat * rf + dF / 2; // FL
    fzs[1] = FzF / 2 - dLong / 2 + dLat * rf + dF / 2; // FR
    fzs[2] = FzR / 2 + dLong / 2 - dLat * (1 - rf) + dR / 2; // RL
    fzs[3] = FzR / 2 + dLong / 2 + dLat * (1 - rf) + dR / 2; // RR

    // Wheel positions in car frame (u forward, v left).
    const ht = s.track / 2;
    _lu[0] = a; _lv[0] = ht;
    _lu[1] = a; _lv[1] = -ht;
    _lu[2] = -b; _lv[2] = ht;
    _lu[3] = -b; _lv[3] = -ht;

    // Car-centre query first (for hint), then each wheel uses the same hint.
    track.query(car.x, car.z, car.hint, Q);
    car.hint = Q.i;
    let off = 0;
    for (let i = 0; i < 4; i++) {
      const px = car.x + fx * _lu[i] + lx * _lv[i];
      const pz = car.z + fz * _lu[i] + lz * _lv[i];
      track.query(px, pz, car.hint, WQ[i]);
      const sf = WQ[i].surf;
      car.surf[i] = sf;
      const rough = G.SURF[sf].rough;
      // "Off track" = physically outside the road edge (a gravel ROAD is on track).
      if (Math.abs(WQ[i].lat) > WQ[i].hw + 1.0) off++;
      // Surface bumps: deterministic noise from world position. Amplitude scales
      // with suspension stiffness — stiff springs make wheels skip on kerbs/dirt.
      if (rough > 0) {
        const n = U.bump(px, pz);
        fzs[i] *= 1 + rough * s.bumpSens * 0.7 * n;
      }
      if (fzs[i] < 0) fzs[i] = 0;
    }
    car.offT = off >= 2 ? car.offT + dt : 0;

    // ---- 5b. Speed pads (v4) ------------------------------------------------
    // Driving over a pad kicks the car forward along the track (+dv m/s, never
    // past the pad's vmax), then a short cooldown so one pad = one kick.
    if (car.padT > 0) car.padT -= dt;
    else if (track.PD && !frozen) {
      const pd = track.padAt(Q.i, Q.lat);
      if (pd) {
        const vt = car.vx * Q.tx + car.vz * Q.tz;
        if (vt > 2) {
          const add = U.clamp(pd.vmax - vt, 0, pd.dv);
          car.vx += Q.tx * add;
          car.vz += Q.tz * add;
          car.padT = 0.9;
        }
      }
    }

    // ---- 6. Engine, gearbox, boost, heat -------------------------------------
    const nG = s.gears.length;
    const ratio = car.gear > 0 ? s.gears[car.gear - 1] * s.finalDrive : s.revRatio * s.finalDrive;
    // Driven wheels turn at roughly ROAD speed even when the car is sideways.
    // (Using vLong alone made a slide look like "slowing down": the box
    // downshifted to 1st, torque spiked, the rears lit up and the slide fed
    // itself into a donut. Keep this max() — it's what makes drifts settle.)
    const wheelW = Math.max(Math.abs(vLong), speed * 0.95) / s.wheelR;
    let r = (wheelW * ratio) / s.redlineW; // normalised rpm from road speed
    // Launch / clutch slip: at low road speed the clutch lets the engine rev.
    const clutchR = s.idle + driveThr * 0.55;
    const rEng = Math.max(r, car.gear === 1 || car.gear === -1 ? clutchR : s.idle);
    if (car.shiftT > 0) car.shiftT -= dt;
    if (car.kickT > 0) car.kickT -= dt;
    // Automatic box. Upshift near the limiter, downshift when bogging.
    if (car.gear > 0 && car.shiftT <= 0 && !frozen) {
      if (r > s.upR && car.gear < nG) {
        car.gear++;
        car.shiftT = s.shiftTime;
        car.kickT = s.shiftTime + 0.07; // shift shock window (sequential box)
        if (car.boost > 0.4) car.backfire = 0.15;
      } else if (car.gear > 1) {
        const lower = s.gears[car.gear - 2] * s.finalDrive;
        const rLow = (wheelW * lower) / s.redlineW;
        if (r < s.downR && rLow < 0.9 && Math.abs(beta) < 0.25) {
          car.gear--;
          car.shiftT = s.shiftTime * 0.6;
        }
      }
    }
    const rClamped = U.clamp(rEng, s.idle, 1.02);
    // Boost: first-order spool toward target. Target needs throttle AND revs
    // (turbo). Spool-up uses boostLag; lifting dumps boost fast (blow-off).
    const bTarget = driveThr * G.Parts.boostAvail(s, U.clamp(rEng, 0, 1));
    if (bTarget > car.boost) car.boost += (bTarget - car.boost) * Math.min(1, dt / s.boostLag);
    else {
      if (car.boost > 0.5 && bTarget < 0.1) car.backfire = 0.12;
      car.boost += (bTarget - car.boost) * Math.min(1, dt / 0.12);
    }
    // Heat: rises with boost*throttle, cooled by airflow. >1 => limp mode until <0.65.
    const cool = s.coolRate * (0.55 + 0.45 * Math.min(speed / 40, 1));
    car.heat = Math.max(0, car.heat + dt * (s.heatRate * car.boost * driveThr - cool));
    if (car.heat >= 1) car.overheat = 1;
    else if (car.overheat && car.heat < 0.65) car.overheat = 0;
    const limp = car.overheat ? 0.55 : 1;
    // Nitrous (v4): while the button is held with the throttle down, burn the
    // bottle for +nosGain power. It adds heat and engine wear, costs money
    // (billed with the fuel) and refills while you sit in someone's slipstream.
    let nos = 0;
    if (s.nosGain && inp.n && car.nos > 0 && driveThr > 0.3 && car.gear > 0 && !frozen && !car.overheat) {
      nos = s.nosGain;
      car.nos = Math.max(0, car.nos - dt / s.nosDur);
      car.fuel += (dt * s.nosCost) / s.nosDur;
      car.heat += dt * s.nosHeat;
      car.engineWear += dt * s.nosWear;
    } else if (s.nosGain && car.draft > 0.05 && car.nos < 1) {
      car.nos = Math.min(1, car.nos + dt * s.nosRefill * car.draft);
    }
    car.nosOn = nos > 0 ? 1 : 0;
    // catch-up (car.cu) adds power when trailing the leader — see race.js
    let T = s.peakTorque * G.Parts.torqueAt(s, rClamped) * (1 + s.boostGain * car.boost) * s.engineHealth * limp * (1 + (car.cu || 0) + nos);
    const limiter = r >= 1.0 && car.gear > 0; // fuel cut at redline
    let Fdrive = 0;
    if (car.shiftT <= 0 && !limiter && !frozen) Fdrive = (T * ratio * 0.9 * driveThr) / s.wheelR;
    if (car.gear === -1) Fdrive = -Math.min(Fdrive, vLong < -8 ? 0 : Fdrive);
    // Sequential box "shift shock": a brief torque spike right after an upshift.
    if (car.kickT > 0 && car.shiftT <= 0 && s.shiftKick > 1) Fdrive *= s.shiftKick;
    car.rpm = rClamped;
    // Wear + fuel bookkeeping (money is settled from these after the race).
    const load = driveThr * rClamped;
    car.engineWear += dt * s.engineWearRate * load * (1 + car.boost);
    if (car.heat > 0.85) car.engineWear += dt * s.heatDamage * (car.heat - 0.85) / 0.15;
    car.fuel += dt * s.fuelRate * (0.15 + 0.85 * load) * (1 + s.boostGain * car.boost);
    if (car.backfire > 0) car.backfire -= dt;

    // Drive split: rear share = rearBias. Within an axle the torque goes to the
    // wheels mostly in proportion to their vertical load (a limited-slip diff).
    // With a 50/50 open-diff split the unloaded INSIDE wheel spun on every
    // corner exit even in a stock car; with the LSD, wheelspin happens only
    // when total drive genuinely exceeds the axle's grip — which is exactly
    // the "too much turbo" failure mode we want upgrades to provoke.
    // Lock comes from the fitted differential (+ its setup); TUNE.lsd is the
    // fallback for specs built before diffs existed.
    const LSD = s.lsd != null ? s.lsd : TUNE.lsd;
    const axR = Fdrive * s.rearBias, axF = Fdrive * (1 - s.rearBias);
    const sumR = fzs[2] + fzs[3] || 1, sumF = fzs[0] + fzs[1] || 1;
    _drv[0] = axF * ((1 - LSD) * 0.5 + (LSD * fzs[0]) / sumF);
    _drv[1] = axF * ((1 - LSD) * 0.5 + (LSD * fzs[1]) / sumF);
    _drv[2] = axR * ((1 - LSD) * 0.5 + (LSD * fzs[2]) / sumR);
    _drv[3] = axR * ((1 - LSD) * 0.5 + (LSD * fzs[3]) / sumR);

    // ---- 7b. Brake temperature ---------------------------------------------
    // Every stop dumps energy (∝ pedal × speed) into the brakes, divided by the
    // part's heat capacity bCap; airflow cools them in proportion to their
    // temperature (Newton cooling). Above bt≈0.65 they FADE: up to −40% force
    // at 1.15. Race pads / carbon discs also have poor COLD bite (bCold): full
    // force only after ~0.45 of absorbed energy (a couple of big stops).
    // Road brakes: full bite cold, fade when abused.
    const bCap = s.bCap || 1;
    if (brakeAmt > 0 && speed > 1 && !frozen) car.bt += (dt * brakeAmt * (speed / 30) * TUNE.bHeat) / bCap;
    car.bt -= dt * TUNE.bCool * car.bt * (0.35 + 0.65 * Math.min(speed / 30, 1));
    if (car.bt < 0) car.bt = 0;
    else if (car.bt > 1.4) car.bt = 1.4;
    const bWarm = U.clamp((car.bt * bCap) / 0.45, 0, 1); // warmth = absorbed energy, not % of capacity
    const bCold = s.bCold == null ? 1 : s.bCold;
    const brakeEff = (bCold + (1 - bCold) * bWarm) * (1 - 0.4 * U.clamp((car.bt - 0.65) / 0.5, 0, 1));

    // ---- 7. Per-wheel tyre forces -------------------------------------------
    let FU = 0, FV = 0, TQ = 0;
    const brakeTot = s.brakeForce * brakeAmt * brakeEff;
    let spinMask = 0, lockMask = 0, slipSum = 0;
    const wet = car.surf;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const lu = _lu[i], lv = _lv[i];
      // contact-patch velocity in car frame
      const cu = vLong - car.w * lv;
      const cv = vLat + car.w * lu;
      // rotate into wheel frame (front wheels steered)
      const d = front ? car.steer : 0;
      const cd = Math.cos(d), sd = Math.sin(d);
      const wl = cu * cd + cv * sd;
      const wlat = -cu * sd + cv * cd;
      const Fz = fzs[i];
      const sf = G.SURF[wet[i]];
      // Grip = compound*wear * surface/width multiplier * load sensitivity * bump penalty.
      let mu = s.mu * s.surfMul[sf.code];
      if (sf.wet && s.aqua) mu *= 1 - 0.3 * U.clamp((speed - 18) / 25, 0, 1); // wide tyres aquaplane
      mu *= 1 - s.loadSens * (Fz / s.fzNom - 1);
      mu *= 1 - sf.rough * s.roughGrip;
      if (!front) mu *= s.rearGrip * TUNE.rearGrip;
      // Setup multipliers (pressure, camber) differ for lateral and
      // longitudinal grip — camber helps cornering but costs braking/traction.
      const Fmax = mu * Fz * (front ? s.latF || 1 : s.latR || 1);

      // Longitudinal: drive, brakes, rolling resistance. Tyres have ~10% more
      // grip longitudinally than laterally (FmaxL).
      const FmaxL = mu * Fz * TUNE.longGrip * (front ? s.lonF || 1 : s.lonR || 1);
      let Fx = _drv[i];
      const bw = brakeTot * (front ? s.brakeFront : 1 - s.brakeFront) * 0.5;
      if (bw > 0) {
        // Near zero speed brakes act like a damper so the car doesn't jitter.
        Fx += Math.abs(wl) > 0.5 ? -Math.sign(wl) * bw : -U.clamp(wl * bw * 2, -bw, bw);
      }
      Fx -= U.clamp(wl * 4, -1, 1) * Fz * sf.rr;
      // ABS (every car — it's an arcade racer): when the BRAKE asks a tyre for
      // more than it can give, hold it just under its peak instead of locking.
      // Full pedal (all a keyboard can do) is then the shortest stop and still
      // leaves ~60% of lateral grip to steer with. Because fresh brakes are now
      // grip-limited rather than lock-limited, FADE (§7b) genuinely lengthens
      // stops and brake upgrades / bias matter. The handbrake bypasses it.
      const absCap = FmaxL * TUNE.abs;
      if (bw > 0 && (front || !hb) && Fx * wl < 0 && Math.abs(Fx) > absCap) Fx = Math.sign(Fx) * absCap;
      let latScale = 1;
      if (!front && hb) {
        // Handbrake: rear wheels lock. Sliding friction, lateral grip collapses.
        Fx = -U.clamp(wl * 3, -1, 1) * Fmax * 0.75;
        latScale = TUNE.hbLat;
        lockMask |= 1 << i;
      }
      // Traction limit. Asking for more than ~95% of grip means the wheel is
      // spinning (drive) or locking (brake): cap at sliding friction.
      if (Math.abs(Fx) > FmaxL * 0.95) {
        Fx = Math.sign(Fx) * FmaxL * 0.9;
        if (_drv[i] * Math.sign(wl || 1) > 0 && driveThr > 0.2) spinMask |= 1 << i;
        else lockMask |= 1 << i;
      }
      // Friction circle (slightly elliptical for forgiveness): lateral grip left
      // over after longitudinal demand. THIS is the powerslide mechanism: a
      // spinning rear wheel (fr≈0.9) keeps only ~53% of its lateral grip.
      const fr = Fx / (FmaxL || 1);
      const FyMax = Fmax * Math.sqrt(Math.max(0, 1 - fr * fr * TUNE.circle)) * latScale;
      const alpha = Math.atan2(wlat, Math.max(Math.abs(wl), LOW_V));
      const peak = s.peakSlip * (front ? s.peakF || 1 : TUNE.rearPeak * (s.peakR || 1));
      let Fy = -Math.sign(alpha) * FyMax * tyreCurve(Math.abs(alpha), peak, s.slideRatio);
      // Low speed: blend toward pure damping of lateral velocity (kills creep).
      if (speed < 3) {
        const damp = -wlat * (Fz / G_ACC) * 10;
        const k = speed / 3;
        Fy = Fy * k + U.clamp(damp, -FyMax, FyMax) * (1 - k);
      }
      // Tyre relaxation / spring lag: lateral force builds over latTau seconds.
      car.fy[i] += (Fy - car.fy[i]) * Math.min(1, dt / ((front ? s.latTauF : s.latTauR) || s.latTau));
      Fy = car.fy[i];
      // back to car frame, accumulate force + yaw torque
      const Fu = Fx * cd - Fy * sd;
      const Fv = Fx * sd + Fy * cd;
      FU += Fu;
      FV += Fv;
      TQ += lu * Fv - lv * Fu;
      // slip metric for smoke/dust/sound/wear: lateral sliding + wheelspin
      const lateralSlide = Math.max(0, Math.abs(alpha) - peak * 0.9) * Math.abs(wl) * 0.25;
      const sm = U.clamp(lateralSlide + ((spinMask | lockMask) & (1 << i) ? 0.8 : 0), 0, 1);
      car.slip[i] = sm;
      slipSum += sm;
    }
    car.spin = spinMask;
    car.lock = lockMask;
    // Locked diff / spool: both driven wheels are forced to the same speed, so
    // in a turn the inside tyre scrubs and resists rotation — an understeer
    // yaw moment, strongest at low speed. Much weaker once the rears are
    // spinning (that's why a spool drifts so predictably).
    if (s.diffYaw && s.rearBias > 0.5 && speed > 1) {
      TQ -= s.diffYaw * car.w * U.clamp(1.2 - speed / 35, 0.25, 1) * (spinMask & 12 ? 0.25 : 1);
    }

    // ---- 8. Body forces -----------------------------------------------------
    if (speed > 0.01) {
      FU -= (drag * vLong) / speed;
      FV -= (drag * vLat) / speed;
    }
    // Banking: gravity component along the tilted surface pulls toward the low
    // side. bk > 0 => right side high => pull toward the left normal.
    let gwx = 0, gwz = 0;
    if (Q.bank !== 0 && Math.abs(Q.lat) < Q.hw + 2) {
      const gl = mg * Math.sin(Q.bank);
      gwx = Q.nx * gl;
      gwz = Q.nz * gl;
    }
    // Hills (v4): gravity along the slope. gr = rise per metre along the
    // track, so climbing costs speed and a descent lengthens braking zones.
    if (Q.gr) {
      const gs = (-mg * Q.gr) / Math.sqrt(1 + Q.gr * Q.gr);
      gwx += Q.tx * gs;
      gwz += Q.tz * gs;
    }

    // ---- 9. Integrate (semi-implicit Euler) ---------------------------------
    const Fwx = FU * fx + FV * lx + gwx;
    const Fwz = FU * fz + FV * lz + gwz;
    car.vx += (Fwx / s.mass) * dt;
    car.vz += (Fwz / s.mass) * dt;
    car.w += (TQ / s.Iz) * dt;
    // Arcade assists (constant for every build — they never hide a part's downside):
    //  * light yaw damping
    //  * spin recovery: past spinAngle of body slip, torque the nose back toward
    //    the direction of travel. A 180° spin still happens if you provoke it.
    car.w -= car.w * s.yawDamp * dt;
    // (no spin recovery while the handbrake is held: the player is asking to pivot)
    if (speed > 6 && vLong > 0 && !hb) {
      const over = Math.abs(beta) - s.spinAngle;
      if (over > 0) car.w += Math.sign(beta) * over * s.spinAssist * dt * 4;
    }
    // Parking: kill residual drift when stopped with no throttle.
    if (speed < 0.4 && driveThr < 0.05) {
      car.vx *= 0.85;
      car.vz *= 0.85;
      car.w *= 0.8;
    }
    car.x += car.vx * dt;
    car.z += car.vz * dt;
    car.h = U.wrapAngle(car.h + car.w * dt);
    car.odo += speed * dt;

    // Smoothed local accelerations -> next step's load transfer + visual roll/pitch.
    const axL = FU / s.mass, ayL = FV / s.mass;
    const kT = Math.min(1, dt / s.loadTau);
    car.ax += (U.clamp(axL, -14, 14) - car.ax) * kT;
    car.ay += (U.clamp(ayL, -14, 14) - car.ay) * kT;

    // Tyre wear: distance + sliding energy, scaled by compound.
    car.tyreWear += dt * s.tyreWearRate * (0.0004 + 0.00003 * speed + 0.0025 * (slipSum / 4)) * (s.mass / 1200);
    if (car.ghost > 0) car.ghost -= dt;

    // ---- 10. Walls ---------------------------------------------------------
    car.wallHit = 0;
    collideWalls(car, s, track);
  }

  // Walls sit at |lateral| = halfWidth + runoff. Check the four body corners;
  // push out along the track normal and apply an impulse at the contact point
  // (so a glancing hit spins you a bit, a head-on one stops you).
  const CQ = Object.assign({}, Q);
  function collideWalls(car, s, track) {
    const sinH = Math.sin(car.h), cosH = Math.cos(car.h);
    const hl = s.len / 2, hw = s.wid / 2;
    let worst = 0, wn = null, wu = 0, wv = 0, wnx = 0, wnz = 0;
    for (let k = 0; k < 4; k++) {
      const u = k < 2 ? hl : -hl, v = k % 2 === 0 ? hw : -hw;
      const px = car.x + sinH * u + cosH * v;
      const pz = car.z + cosH * u - sinH * v;
      track.query(px, pz, car.hint, CQ);
      let pen = 0, nx = 0, nz = 0;
      const over = Math.abs(CQ.lat) - CQ.wall;
      if (over > 0) {
        pen = over;
        const sg = CQ.lat > 0 ? -1 : 1; // push back toward the centreline
        nx = CQ.nx * sg;
        nz = CQ.nz * sg;
      }
      if (!track.closed) {
        // end caps on open tracks
        if (CQ.along < 1 && CQ.i <= 1) {
          const p = 1 - CQ.along;
          if (p > pen) { pen = p; nx = CQ.tx; nz = CQ.tz; }
        } else if (CQ.along > track.length - 1 && CQ.i >= track.N - 2) {
          const p = CQ.along - (track.length - 1);
          if (p > pen) { pen = p; nx = -CQ.tx; nz = -CQ.tz; }
        }
      }
      if (pen > worst) {
        worst = pen; wn = true; wu = u; wv = v; wnx = nx; wnz = nz;
      }
    }
    // Solid obstacles (v4: barrels, tyre stacks, rocks): circle vs the car's
    // rectangle. Find the closest point of the body to the obstacle centre (in
    // the car frame) and push out along it — the same impulse as a wall hit.
    const ol = track.OBL ? track.OBL[car.hint] : null;
    let soft = 1; // damage factor: tyre stacks and barrels give (25%), rocks don't
    if (ol) {
      for (let k = 0; k < ol.length; k++) {
        const o = ol[k];
        const dx = o.x - car.x, dz = o.z - car.z;
        const u = dx * sinH + dz * cosH, v = dx * cosH - dz * sinH; // centre in car frame (u fwd, v left)
        const pu = U.clamp(u, -hl, hl), pv = U.clamp(v, -hw, hw);
        const ex = u - pu, ev = v - pv;
        const d = Math.hypot(ex, ev);
        let pen, nu, nv;
        if (d > 1e-4) {
          if (d >= o.r) continue;
          pen = o.r - d;
          nu = -ex / d;
          nv = -ev / d;
        } else {
          // centre inside the body: out along the shallower axis
          const du = hl - Math.abs(u), dv = hw - Math.abs(v);
          if (du < dv) { pen = du + o.r; nu = -(Math.sign(u) || 1); nv = 0; } else { pen = dv + o.r; nu = 0; nv = -(Math.sign(v) || 1); }
        }
        if (pen > worst) {
          worst = pen; wn = true; wu = pu; wv = pv;
          wnx = sinH * nu + cosH * nv;
          wnz = cosH * nu - sinH * nv;
          soft = o.k === 'rock' ? 1 : 0.25;
        }
      }
    }
    if (!wn) return;
    car.x += wnx * worst;
    car.z += wnz * worst;
    // contact point offset in world
    const rx = sinH * wu + cosH * wv, rz = cosH * wu - sinH * wv;
    // velocity of contact point: v + w × r (2-D, w about +Y with our left-positive convention)
    // d/dt of world offset r = w * (dr/dh) ; dr/dh = (cos h*u - sin h*v, -sin h*u - cos h*v)
    const dvx = car.w * (cosH * wu - sinH * wv), dvz = car.w * (-sinH * wu - cosH * wv);
    const pvx = car.vx + dvx, pvz = car.vz + dvz;
    const vn = pvx * wnx + pvz * wnz;
    if (vn >= 0) return;
    // effective mass along normal including rotation: (r × n) in our convention
    const rxn = (rx * wnz - rz * wnx);
    const e = 0.25;
    const j = (-(1 + e) * vn) / (1 / s.mass + (rxn * rxn) / s.Iz);
    car.vx += (j * wnx) / s.mass;
    car.vz += (j * wnz) / s.mass;
    car.w += (-rxn * j) / s.Iz * 0.6;
    // wall friction scrubs tangential speed
    const tx = -wnz, tz = wnx;
    const vt = car.vx * tx + car.vz * tz;
    const scrub = Math.min(Math.abs(vt), (j / s.mass) * 0.35) * Math.sign(vt);
    car.vx -= tx * scrub;
    car.vz -= tz * scrub;
    car.wallHit = j;
    car.body = Math.min(1, car.body + Math.max(0, j - 2500) * 0.000012 * soft);
  }

  G.Physics = { DT, createCar, step, copyCore, CORE, tyreCurve, TUNE };
})(window.G);
