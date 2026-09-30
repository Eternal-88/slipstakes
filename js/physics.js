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
    engBrake: 0.35, // v5.8.2 engine braking off the throttle, as a share of peak torque (through the gearing)
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
    // v5.6.1 hazards that stay with you. A patch used to matter only while a
    // wheel was ON it - a quarter of a second at speed, and low grip hardly
    // matters going straight, so you drove through oil and felt nothing.
    oilHold: 1.6, // s the tyres stay oily after the last touch (grip and brakes come back as it wears off)
    oilGrip: 0.5, // grip lost to fresh oil on the tyres (fading to none)
    oilBrake: 0.45, // brake force lost to fresh oil
    oilKick: 0.75, // rad/s of yaw when oil catches one side (x speed / 28, up to 1.2x)
    mudHold: 1.3, // s of clogged tread after mud
    mudGrip: 0.22, // grip lost to fresh mud in the tread
    mudDrag: 0.12, // extra rolling resistance from a clogged tread (fading)
    aqua: 0.72, // front grip a tyre loses aquaplaning on standing water (from 19 m/s, all of it by 31)
  };
  const SI_OIL = G.SI.oil, SI_MUD = G.SI.mud, SI_WATER = G.SI.water;
  const _drv = [0, 0, 0, 0]; // per-wheel drive force scratch

  function createCar(x, z, h) {
    return {
      x, z, h, vx: 0, vz: 0, w: 0,
      steer: 0, rpm: 0.14, gear: 1, shiftT: 0, kickT: 0,
      boost: 0, heat: 0, overheat: 0, ax: 0, ay: 0, revCut: 0,
      fy: [0, 0, 0, 0], slip: [0, 0, 0, 0], surf: [0, 0, 0, 0], fz: [0, 0, 0, 0],
      hint: -1, spin: 0, lock: 0, offT: 0, wallHit: 0, backfire: 0,
      tyreWear: 0, engineWear: 0, body: 0, fuel: 0, odo: 0, thr: 0, brk: 0, hb: 0,
      ghost: 0, // seconds of no car-car collision after a respawn
      // v5.1 crosswind, for the picture only (never networked): how hard the
      // gust is pushing right now in m/s² (+ = toward the left of the road)
      // and the road normal it pushes along.
      gust: 0, gnx: 0, gnz: 0,
      bt: 0, // brake temperature (0 cold .. ~1.4); see §7b
      // v4 race assists, all set by the HOST (race.js) and replicated: a
      // client's prediction just holds the last value it was sent.
      draft: 0, // slipstream 0..1 (a car close ahead)
      cu: 0, // catch-up power bonus 0..~0.25 (trailing the leader)
      nos: 1, // nitrous bottle 0..1 (only with a Nitrous part)
      nosOn: 0, // nitrous firing this step (visual/sound)
      padT: 0, // cooldown after a speed pad
      // v5 endurance (only drain when the race env has `endu`): fuel left in
      // the tank 0..1, tyre wear since the last change 0..1+, held in the pit box
      tank: 1, tw: 0, pit: 0,
      oilT: 0, mudT: 0, // v5.6.1: oil on the tyres / mud in the tread, s left
      wallT: 0, // v5.8: s of lost drive left after a proper hit on a wall
      // v5.8 manual box: the gear the driver has asked for, the shift presses
      // seen so far (running counts mod 16), 1 once the driver has taken the
      // box over, and s left of a perfect shift's kick
      // (gu/gd start at -1: the first input only syncs the counts)
      sel: 1, gu: -1, gd: -1, man: 0, pk: 0, limT: 0,
      pkM: 0, // v5.8.2: how big the kick of the last good shift is (a PERFECT one kicks harder than a GOOD one)
    };
  }

  // Core state that must round-trip for prediction/reconciliation.
  const CORE = ['x', 'z', 'h', 'vx', 'vz', 'w', 'steer', 'rpm', 'gear', 'shiftT', 'kickT', 'boost', 'heat', 'overheat', 'ax', 'ay', 'tyreWear', 'engineWear', 'body', 'fuel', 'odo', 'ghost', 'bt', 'draft', 'cu', 'nos', 'padT', 'tank', 'tw', 'pit', 'revCut', 'oilT', 'mudT', 'wallT', 'sel', 'gu', 'gd', 'man', 'pk', 'limT', 'pkM'];
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
  //   opts.env: v5 race environment {t: race seconds, wet: 0..1 rain on the
  //             track, endu: {fuelK, tyreK} in an endurance race} — the same
  //             on host and clients (race.js RaceEnv)
  // ---------------------------------------------------------------------------
  const SI_WET = G.SI.wet;
  function step(car, s, inp, track, dt, opts) {
    const frozen = opts && opts.frozen;
    const env = opts && opts.env;
    if (env) track.t = env.t; // (v5.7: tide patches come and go with race time)
    const wetEnv = env ? env.wet || 0 : 0;
    const endu = env && env.endu;
    // v5 pit stop: the host holds the car in the box while it's serviced
    if (car.pit) {
      car.vx = car.vz = car.w = 0;
      car.ax = car.ay = 0;
      car.steer *= 0.8;
      car.rpm += (s.idle - car.rpm) * Math.min(1, dt * 4);
      car.boost = 0;
      car.thr = 0; car.brk = 1; car.hb = 0;
      for (let i = 0; i < 4; i++) car.slip[i] = 0;
      car.heat = Math.max(0, car.heat - dt * s.coolRate * 2);
      if (car.ghost > 0) car.ghost -= dt;
      car.wallHit = 0;
      return;
    }
    // v5 endurance: worn tyres lose grip — little until ~30% worn, then up
    // to a quarter of it on a completely finished set
    const twGrip = endu ? 1 - 0.25 * Math.pow(U.clamp((car.tw - 0.3) / 0.8, 0, 1), 1.4) : 1;
    let thr = U.clamp(inp.t || 0, 0, 1);
    let brk = U.clamp(inp.b || 0, 0, 1);
    // v5.8: a proper hit on a wall knocks the drive out for a moment - the
    // walls turned you for free before, so bouncing round beat driving
    if (car.wallT > 0) {
      thr *= 1 - 0.75 * Math.min(1, car.wallT / 0.25);
      car.wallT = Math.max(0, car.wallT - dt);
    }
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
      else if (car.gear === -1 && thr > 0.1 && vLong > -0.6) car.gear = car.sel = 1;
    }
    let driveThr = thr, brakeAmt = brk;
    if (car.gear === -1) {
      driveThr = brk;
      brakeAmt = thr;
    }
    // v5 endurance: an empty tank only splutters (enough to limp to the pits)
    if (endu && car.tank <= 0) driveThr *= 0.2;
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
    // v5.6.1 oil coats the tyres and mud clogs the tread: both stay with you
    // for a moment after the patch. Oil that catches one side more than the
    // other snaps the car round (grip gone on one side, not the other).
    let oilL = 0, oilR = 0, mudN = 0;
    for (let i = 0; i < 4; i++) {
      const id = car.surf[i];
      if (id === SI_OIL) {
        if (_lv[i] > 0) oilL++;
        else oilR++;
      } else if (id === SI_MUD) mudN++;
    }
    if (oilL + oilR > 0 && !frozen) {
      if (!(car.oilT > 0) && speed > 6) {
        const side = Math.sign(oilL - oilR) || Math.sign(car.w) || Math.sign(car.steer) || 1;
        car.w += side * U.clamp(speed / 28, 0.3, 1.2) * TUNE.oilKick;
      }
      car.oilT = TUNE.oilHold;
    } else if (car.oilT > 0) car.oilT = Math.max(0, car.oilT - dt);
    if (mudN > 0 && !frozen) car.mudT = TUNE.mudHold;
    else if (car.mudT > 0) car.mudT = Math.max(0, car.mudT - dt);
    const oilK = car.oilT > 0 ? car.oilT / TUNE.oilHold : 0, mudK = car.mudT > 0 ? car.mudT / TUNE.mudHold : 0;

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
    // (v5: a car swapped mid-drive can be in a gear its new box doesn't have —
    // the one-speed Volt in 3rd turned every number into NaN)
    if (car.gear > nG) car.gear = nG;
    // (v5.8.2: catch-up (car.cu) lengthens the gearing a little - the extra
    // power and the drag cut used to run straight into the rev limiter)
    const ratio = (car.gear > 0 ? s.gears[car.gear - 1] * s.finalDrive : s.revRatio * s.finalDrive) / (1 + 0.2 * (car.cu || 0));
    // Driven wheels turn at roughly ROAD speed even when the car is sideways.
    // (Using vLong alone made a slide look like "slowing down": the box
    // downshifted to 1st, torque spiked, the rears lit up and the slide fed
    // itself into a donut. Keep this max() — it's what makes drifts settle.)
    const wheelW = Math.max(Math.abs(vLong), speed * 0.95) / s.wheelR;
    let r = (wheelW * ratio) / s.redlineW; // normalised rpm from road speed
    // Launch / clutch slip: at low road speed the clutch lets the engine rev.
    const clutchR = s.ev ? 0 : s.idle + driveThr * 0.55; // (v5: an electric motor pulls from zero, no clutch)
    const rEng = Math.max(r, car.gear === 1 || car.gear === -1 ? clutchR : s.idle);
    if (car.shiftT > 0) car.shiftT -= dt;
    if (car.kickT > 0) car.kickT -= dt;
    if (car.pk > 0) car.pk -= dt;
    // v5.8 manual box. Shift presses arrive as running counts (inp.gu /
    // inp.gd, mod 16), so a lost packet can't lose one; the first press hands
    // the box to the driver for the rest of the race.
    if (s.manual && inp.gu != null) {
      let du = ((inp.gu | 0) - car.gu) & 15, dd = ((inp.gd | 0) - car.gd) & 15;
      // (a first input, or a jump no hand could make in one input block - a
      // reloaded page counting from 0 again - only resyncs the counts)
      if (car.gu < 0 || du > 4 || dd > 4) du = dd = 0;
      car.gu = inp.gu & 15;
      car.gd = (inp.gd | 0) & 15;
      if ((du || dd) && car.gear > 0 && !frozen) {
        if (!car.man) { car.man = 1; car.sel = car.gear; }
        car.sel = U.clamp(car.sel + du - dd, 1, nG);
      }
    }
    const upAt = s.upRs ? s.upRs[Math.max(0, car.gear - 1)] : s.upR;
    if (s.manual && car.gear > 0 && !frozen) {
      // The driver's box - and ONLY the driver's (v5.8.1): it never shifts by
      // itself. Sit on the limiter and you stay on it until you shift. Quicker
      // than any automatic, and up on the light (just short of the limiter)
      // is a perfect shift that kicks. A downshift goes in when you ask for
      // it, even one that over-revs: the engine takes the hit and you sit on
      // the limiter until the speed comes down to the gear.
      car.limT = r >= 0.995 && driveThr > 0.5 ? car.limT + dt : 0; // (the HUD's "shift up" call)
      if (car.shiftT <= 0) {
        if (car.sel > car.gear) {
          // (v5.8.2: graded - PERFECT within 0.025 of the gear's shift point
          // (or past it, short of the limiter), GOOD within 0.07; early is
          // nothing, and the limiter is nothing)
          const early = upAt - r;
          if (r < 1.0 && early <= 0.025) { car.pk = 0.6; car.pkM = 0.22; }
          else if (r < 1.0 && early <= 0.07) { car.pk = 0.4; car.pkM = 0.09; }
          car.gear++;
          car.shiftT = s.shiftTime * 0.5;
          car.kickT = car.shiftT + 0.07;
          car.limT = 0;
          if (car.boost > 0.4) car.backfire = 0.15;
        } else if (car.sel < car.gear) {
          const rLow = (wheelW * s.gears[car.gear - 2] * s.finalDrive) / s.redlineW;
          if (rLow > 1.05) car.engineWear += Math.min(0.03, (rLow - 1.05) * 0.04); // (a money shift)
          car.gear--;
          car.shiftT = s.shiftTime * 0.45;
        }
      }
    } else if (car.gear > 0 && car.shiftT <= 0 && !frozen) {
      // Automatic box: up at this car's own shift point, down when bogging.
      if (r > upAt && car.gear < nG) {
        car.gear++;
        car.sel = car.gear;
        car.shiftT = s.shiftTime;
        car.kickT = car.shiftT + 0.07; // shift shock window (sequential box)
        if (car.boost > 0.4) car.backfire = 0.15;
      } else if (car.gear > 1) {
        const lower = s.gears[car.gear - 2] * s.finalDrive;
        const rLow = (wheelW * lower) / s.redlineW;
        if (r < s.downR && rLow < 0.9 && Math.abs(beta) < 0.25) {
          car.gear--;
          car.sel = car.gear;
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
      // v5 anti-lag: the turbo stays lit off the throttle (bangs included)
      car.boost += (bTarget - car.boost) * Math.min(1, dt / (s.antilag && !frozen ? 1.6 : 0.12));
      if (s.antilag && car.boost > 0.3 && driveThr < 0.1 && speed > 5) car.backfire = Math.max(car.backfire, 0.06);
    }
    // Heat: rises with boost*throttle, cooled by airflow. >1 => limp mode until <0.65.
    const cool = s.coolRate * (0.55 + 0.45 * Math.min(speed / 40, 1));
    car.heat = Math.max(0, car.heat + dt * (s.heatRate * car.boost * (s.antilag ? Math.max(driveThr, 0.55) : driveThr) + (s.evHeat || 0) * driveThr * U.clamp(rEng, 0, 1) - cool));
    if (car.heat >= 1) car.overheat = 1;
    else if (car.overheat && car.heat < 0.65) car.overheat = 0;
    // v5.1: an electric motor doesn't run flat out and then fall off a cliff —
    // it derates. Past 55% temperature the Volt bleeds power smoothly (down to
    // -45% at the top of the gauge), so a long flat-out run is a thing to
    // manage: lift early, brake earlier and let regen cool it. A combustion
    // engine still has the hard limp mode.
    const limp = s.ev
      ? car.overheat
        ? 0.5
        : 1 - 0.45 * U.clamp((car.heat - 0.55) / 0.45, 0, 1)
      : car.overheat
        ? 0.55
        : 1;
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
    // v5 launch control: boost is pre-spooled on the grid, and the first 3 s
    // of the race get +15% torque, quick shifts and perfect traction (below)
    const launching = s.launch && env && env.t > 0 && env.t < 3 && car.gear >= 1;
    if (s.launch && frozen && thr > 0.5 && s.boostKind !== 'none') car.boost = Math.max(car.boost, G.Parts.boostAvail(s, 0.8));
    if (launching && car.shiftT > s.shiftTime * 0.5) car.shiftT = s.shiftTime * 0.5;
    let T = s.peakTorque * G.Parts.torqueAt(s, rClamped) * (1 + s.boostGain * car.boost) * s.engineHealth * limp * (1 + (car.cu || 0) + nos) * (launching ? 1.15 : 1);
    const limiter = r >= 1.0 && car.gear > 0; // fuel cut at redline
    let Fdrive = 0;
    if (!limiter && !frozen) {
      Fdrive = (T * ratio * 0.9 * driveThr) / s.wheelR;
      // (v5.8: an automatic or a dual-clutch keeps some drive through a shift)
      if (car.shiftT > 0) Fdrive *= s.shiftKeep || 0;
      // a perfect manual shift: a shove as the next gear bites
      if (car.pk > 0 && car.shiftT <= 0) Fdrive *= 1 + (car.pkM || 0.22) * Math.min(1, car.pk / 0.25);
    }
    if (car.gear === -1) Fdrive = -Math.min(Fdrive, vLong < -8 ? 0 : Fdrive);
    // Sequential box "shift shock": a brief torque spike right after an upshift.
    if (car.kickT > 0 && car.shiftT <= 0 && s.shiftKick > 1) Fdrive *= s.shiftKick;
    // v5.8.2 engine braking: off the throttle (and off the brake - under full
    // braking the tyres are already at their limit) the engine holds the car
    // back through the driven wheels, harder in a low gear and at high revs,
    // so a downshift slows you and one that over-revs snatches at them. An
    // automatic's torque converter slips (half), a dual-clutch less so.
    if (car.gear > 0 && car.shiftT <= 0 && !frozen && !s.ev && driveThr < 0.3 && brakeAmt < 0.1 && vLong > 1) {
      const over = Math.max(0, r - 1);
      const box = s.boxKind === 'auto' ? 0.5 : s.boxKind === 'dct' ? 0.7 : 1;
      Fdrive -= ((s.peakTorque * TUNE.engBrake * box * (0.25 + 0.75 * Math.min(1, r)) * (1 + over * 6) * ratio) / s.wheelR) * (1 - driveThr / 0.3) * (1 - brakeAmt / 0.1);
    }
    // ---- 6b. Free revving on the grid ------------------------------------
    // Off the clutch and going nowhere, the engine answers the throttle with
    // its OWN inertia: it takes a moment to wind up, falls back on its own
    // when you lift, and bounces off the limiter if you pin it. A small
    // engine spins up faster than a big one, so this sounds different car to
    // car for free (revUp scales with how much the flywheel has to turn).
    if (frozen && s.gears) {
      const revUp = s.ev ? 9 : U.clamp(26 / Math.max(1, s.redline / 1000), 2.2, 5.2);
      const tgt = driveThr > 0.02 ? s.idle + driveThr * (1.02 - s.idle) : s.idle;
      const up = driveThr > 0.02;
      car.rpm += (tgt - car.rpm) * Math.min(1, dt * (up ? revUp : revUp * 0.62));
      if (car.rpm >= 1.0) {
        // fuel cut: it drops off the limiter and catches again, over and over
        car.revCut = 0.055;
        car.rpm = 1.0;
      }
      if (car.revCut > 0) {
        car.revCut -= dt;
        car.rpm = Math.max(s.idle, car.rpm - dt * 5.5);
      }
      car.rpm = U.clamp(car.rpm, s.idle, 1.02);
    } else {
      car.revCut = 0;
      car.rpm = rClamped;
    }
    // Wear + fuel bookkeeping (money is settled from these after the race).
    const load = driveThr * rClamped;
    car.engineWear += dt * s.engineWearRate * load * (1 + car.boost);
    if (car.heat > 0.85) car.engineWear += dt * s.heatDamage * (car.heat - 0.85) / 0.15;
    car.fuel += dt * s.fuelRate * (0.15 + 0.85 * load) * (1 + s.boostGain * car.boost);
    // v5 endurance tank: the same load curve. Thirsty builds (turbos, race
    // maps) still drink more, softened so they plan an extra stop rather than
    // live in the pits; a fuel cell (s.tankM) makes the tank bigger.
    if (endu && !frozen) {
      car.tank = Math.max(0, car.tank - dt * 0.85 * Math.pow(s.fuelRate / 0.85, 0.6) * (0.15 + 0.85 * load) * (1 + s.boostGain * car.boost) * endu.fuelK / (s.tankM || 1));
      // EV regen: braking (and lifting) at speed puts charge back
      if (s.regen && speed > 4) car.tank = Math.min(1, car.tank + dt * s.regen * (brakeAmt * 0.8 + (1 - driveThr) * 0.2) * Math.min(1, speed / 35) * endu.fuelK / (s.tankM || 1));
    }
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
    const brakeTot = s.brakeForce * brakeAmt * brakeEff * (1 - TUNE.oilBrake * oilK); // (v5.6.1: oily tyres barely stop)
    let spinMask = 0, lockMask = 0, slipSum = 0, dryWheels = 0;
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
      let mu = s.mu * s.surfMul[sf.code] * twGrip;
      // v5 rain: dry tarmac, concrete and kerbs drift toward this car's own
      // wet-road grip as the track gets wetter (narrow tyres cope better)
      if (wetEnv > 0 && !sf.wet && !sf.loose && !sf.icy) mu = U.lerp(mu, s.mu * s.surfMul[SI_WET] * (sf.rough > 0.5 ? 0.92 : 1), wetEnv * 0.6);
      if ((sf.wet || wetEnv > 0.6) && s.aqua) mu *= 1 - 0.3 * U.clamp((speed - 18) / 25, 0, 1); // wide tyres aquaplane
      mu *= 1 - s.loadSens * (Fz / s.fzNom - 1);
      mu *= 1 - sf.rough * s.roughGrip;
      if (oilK > 0) mu *= 1 - TUNE.oilGrip * oilK; // v5.6.1: oil on the tyres, wearing off
      if (mudK > 0) mu *= 1 - TUNE.mudGrip * mudK; // v5.6.1: mud in the tread
      if (!front) mu *= s.rearGrip * TUNE.rearGrip;
      if (car.cu > 0) mu *= 1 + 0.1 * car.cu; // (v5.8.2 catch-up: a little grip too - power alone does nothing in a corner)
      // Setup multipliers (pressure, camber) differ for lateral and
      // longitudinal grip — camber helps cornering but costs braking/traction.
      const Fmax = mu * Fz * (front ? s.latF || 1 : s.latR || 1);

      // Longitudinal: drive, brakes, rolling resistance. Tyres have ~10% more
      // grip longitudinally than laterally (FmaxL).
      const FmaxL = mu * Fz * TUNE.longGrip * (front ? s.lonF || 1 : s.lonR || 1);
      let Fx = _drv[i];
      // Traction control (setup: Assists, on by default): trim DRIVE so the
      // tyre stays inside its friction circle. It never goes past the spin
      // point, and gets less drive mid-corner, where the tyre is also holding
      // the car sideways. A keyboard's all-or-nothing throttle spun every
      // rear-drive car off the line and out of corners, so the two AWD cars
      // won almost every track for keyboard players (quarter mile 15.0-15.8 s
      // vs 18.7-20.8 s for the RWD cars).
      if ((s.tcs || launching) && car.gear > 0 && Fx * Math.sign(wl || 1) > 0) {
        const latUse = Math.min(0.95, Math.abs(car.fy[i]) / (Fmax || 1));
        const cap = FmaxL * 0.93 * Math.sqrt(1 - latUse * latUse);
        if (Math.abs(Fx) > cap) Fx = Math.sign(Fx) * cap;
      }
      const bw = brakeTot * (front ? s.brakeFront : 1 - s.brakeFront) * 0.5;
      if (bw > 0) {
        // Near zero speed brakes act like a damper so the car doesn't jitter.
        Fx += Math.abs(wl) > 0.5 ? -Math.sign(wl) * bw : -U.clamp(wl * bw * 2, -bw, bw);
      }
      Fx -= U.clamp(wl * 4, -1, 1) * Fz * (sf.rr + TUNE.mudDrag * mudK);
      // ABS (every car — it's an arcade racer): when the BRAKE asks a tyre for
      // more than it can give, hold it just under its peak instead of locking.
      // Full pedal (all a keyboard can do) is then the shortest stop and still
      // leaves ~60% of lateral grip to steer with. Because fresh brakes are now
      // grip-limited rather than lock-limited, FADE (§7b) genuinely lengthens
      // stops and brake upgrades / bias matter. The handbrake bypasses it.
      const absCap = FmaxL * TUNE.abs;
      if (bw > 0 && (front || !hb) && Fx * wl < 0 && Math.abs(Fx) > absCap) Fx = Math.sign(Fx) * absCap;
      let latScale = 1;
      // v5.6.1 aquaplaning: a front tyre on standing water at speed rides up
      // on it and stops steering - the car ploughs straight on
      if (front && sf.code === SI_WATER) latScale *= 1 - TUNE.aqua * U.clamp((speed - 19) / 12, 0, 1);
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
      if (!sf.wet && !sf.icy && !sf.loose) dryWheels++;
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
    // v5 crosswind zones (bridges, causeways): a gusting push across the road,
    // from race time so host and clients feel the same gust
    if (track.WZ && env && !frozen) {
      const wi = track.WZ[Q.i];
      if (wi >= 0) {
        const W = track.winds[wi];
        // (v5.7: a launch's blast zone only blows while the rocket lifts off)
        const acc = (W.blast ? W.str * track.blastK(W, env.t) : W.str * (0.55 + 0.45 * Math.sin((env.t * 2 * Math.PI) / W.period + W.ph))) * W.dir;
        gwx += Q.nx * acc * s.mass;
        gwz += Q.nz * acc * s.mass;
        // (visual only: the world blows grit across the road and the HUD says
        //  CROSSWIND, so the push reads as wind and not as the car misbehaving)
        car.gust = acc;
        car.gnx = Q.nx;
        car.gnz = Q.nz;
      } else car.gust = 0;
    } else if (car.gust) car.gust = 0;

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
    // (v5 rain tyres shred on a dry road: s.dryWear on the dry wheels, unless it's raining)
    const wearK = s.dryWear && wetEnv < 0.4 ? 1 + ((s.dryWear - 1) * dryWheels) / 4 : 1;
    car.tyreWear += dt * s.tyreWearRate * (0.0004 + 0.00003 * speed + 0.0025 * (slipSum / 4)) * (s.mass / 1200) * wearK;
    if (endu) car.tw += dt * s.tyreWearRate * (0.0004 + 0.00003 * speed + 0.0025 * (slipSum / 4)) * (s.mass / 1200) * endu.tyreK * wearK;
    if (car.ghost > 0) car.ghost -= dt;

    // ---- 10. Walls ---------------------------------------------------------
    car.wallHit = 0;
    collideWalls(car, s, track, env, dt);
  }

  // Walls sit at |lateral| = halfWidth + runoff. Check the four body corners;
  // push out along the track normal and apply an impulse at the contact point
  // (so a glancing hit spins you a bit, a head-on one stops you).
  const CQ = Object.assign({}, Q);
  const _dyn = { x: 0, z: 0, r: 0, vx: 0, vz: 0, fall: 0 };
  function collideWalls(car, s, track, env, dt) {
    const sinH = Math.sin(car.h), cosH = Math.cos(car.h);
    const hl = s.len / 2, hw = s.wid / 2;
    let worst = 0, wn = null, wu = 0, wv = 0, wnx = 0, wnz = 0;
    let ovx = 0, ovz = 0; // velocity of what we hit (v5: moving hazards)
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
    // v5 moving hazards (rockfall, wrecking ball): the same circle test at
    // where they are right now, and they hit with their own speed too
    const dl = env && track.DYL ? track.DYL[car.hint] : null;
    if (dl) {
      for (let k = 0; k < dl.length; k++) {
        const o = track.dynPos(dl[k], env.t, _dyn);
        if (!o || o.fall > 0) continue;
        const dx = o.x - car.x, dz = o.z - car.z;
        const u = dx * sinH + dz * cosH, v = dx * cosH - dz * sinH;
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
          const du = hl - Math.abs(u), dv = hw - Math.abs(v);
          if (du < dv) { pen = du + o.r; nu = -(Math.sign(u) || 1); nv = 0; } else { pen = dv + o.r; nu = 0; nv = -(Math.sign(v) || 1); }
        }
        if (pen > worst) {
          worst = pen; wn = true; wu = pu; wv = pv;
          wnx = sinH * nu + cosH * nv;
          wnz = cosH * nu - sinH * nv;
          soft = dl[k].k === 'swing' ? 0.6 : 1;
          ovx = o.vx;
          ovz = o.vz;
        }
      }
    }
    if (!wn) return;
    car.x += wnx * worst;
    car.z += wnz * worst;
    // v5.8: scraping along a wall drags - every moment on it costs speed along it
    {
      const tx = -wnz, tz = wnx;
      const vt = (car.vx - ovx) * tx + (car.vz - ovz) * tz;
      const lose = vt * Math.min(1, 1.4 * dt * soft);
      car.vx -= tx * lose;
      car.vz -= tz * lose;
      car.wallHit = Math.max(car.wallHit, 1);
    }
    // contact point offset in world
    const rx = sinH * wu + cosH * wv, rz = cosH * wu - sinH * wv;
    // velocity of contact point: v + w × r (2-D, w about +Y with our left-positive convention)
    // d/dt of world offset r = w * (dr/dh) ; dr/dh = (cos h*u - sin h*v, -sin h*u - cos h*v)
    const dvx = car.w * (cosH * wu - sinH * wv), dvz = car.w * (-sinH * wu - cosH * wv);
    const pvx = car.vx + dvx - ovx, pvz = car.vz + dvz - ovz;
    const vn = pvx * wnx + pvz * wnz;
    if (vn >= 0) return;
    // effective mass along normal including rotation: (r × n) in our convention
    const rxn = (rx * wnz - rz * wnx);
    const e = 0.25;
    const j = (-(1 + e) * vn) / (1 / s.mass + (rxn * rxn) / s.Iz);
    car.vx += (j * wnx) / s.mass;
    car.vz += (j * wnz) / s.mass;
    car.w += (-rxn * j) / s.Iz * 0.6;
    // wall friction scrubs tangential speed (v5.8: much more of it - 0.35 let a
    // glancing hit keep nearly all your speed and turn you for nothing)
    const tx = -wnz, tz = wnx;
    const vt = (car.vx - ovx) * tx + (car.vz - ovz) * tz;
    const scrub = Math.min(Math.abs(vt), (j / s.mass) * 0.8) * Math.sign(vt);
    car.vx -= tx * scrub;
    car.vz -= tz * scrub;
    car.wallHit = j;
    if (j > 1500) car.wallT = Math.max(car.wallT, Math.min(0.45, 0.12 + (j - 1500) / 20000) * soft);
    car.body = Math.min(1, car.body + Math.max(0, j - 2500) * 0.000012 * soft * (s.wallDmg || 1));
  }

  // ------------------------------------------------------------------ contact
  // ONE car-vs-car contact pair. Each car is three circles along its length;
  // we resolve the deepest overlap with a positional split by mass and an
  // impulse (restitution + friction) at the contact point — so a light car
  // genuinely gets shoved and spun by a heavy one.
  //
  // A and B are {st, spec}. The host calls this with no options. A CLIENT
  // predicting its own half of a shunt passes:
  //   onlyA  move A alone — it does not own B, and the host's half of the
  //          answer arrives with the next snapshot.
  //   noPush skip the positional push-out and apply the impulse only. The
  //          push-out is a POSITION claim, and a client's idea of where the
  //          other car is, is a guess: two cars running nose-to-tail would
  //          have it shoving itself off a guessed overlap every tick while the
  //          host did nothing, which reconciliation then had to undo (measured
  //          at 0.4-0.7 m of average correction — an invisible bumper).
  //   minVn  only predict a real bump: ignore contact closing slower than this
  //          (m/s), which is the resting rub the host can settle by itself.
  //
  // Returns the normal impulse (0 = no contact, or the pair was already
  // separating); the contact point is left in P.HIT for callers that want to
  // spark or bang there. Damage and events are the caller's business.
  const HIT = { x: 0, z: 0 };
  function contact(A, B, o) {
    const onlyA = !!(o && o.onlyA);
    const a = A.st, b = B.st;
    if (a.ghost > 0 || b.ghost > 0) return 0;
    const dx0 = b.x - a.x, dz0 = b.z - a.z;
    const reach = (A.spec.len + B.spec.len) * 0.5 + 0.5;
    if (dx0 * dx0 + dz0 * dz0 > reach * reach) return 0;
    let best = 0, bn = null;
    const ra = A.spec.wid * 0.5, rb = B.spec.wid * 0.5;
    const sa = Math.sin(a.h), ca = Math.cos(a.h), sb = Math.sin(b.h), cb = Math.cos(b.h);
    for (let ka = -1; ka <= 1; ka++) {
      const ua = ka * A.spec.len * 0.3;
      const ax = a.x + sa * ua, az = a.z + ca * ua;
      for (let kb = -1; kb <= 1; kb++) {
        const ub = kb * B.spec.len * 0.3;
        const bx = b.x + sb * ub, bz = b.z + cb * ub;
        const dx = bx - ax, dz = bz - az;
        const d = Math.hypot(dx, dz);
        const pen = ra + rb - d;
        if (pen > best && d > 1e-4) {
          best = pen;
          bn = [dx / d, dz / d, (ax + bx) / 2, (az + bz) / 2];
        }
      }
    }
    if (!bn) return 0;
    const [nx, nz, px, pz] = bn;
    HIT.x = px;
    HIT.z = pz;
    const ma = A.spec.mass, mb = B.spec.mass;
    // positional correction split by inverse mass
    const wa = mb / (ma + mb), wb = ma / (ma + mb);
    if (!(o && o.noPush)) {
      a.x -= nx * best * wa; a.z -= nz * best * wa;
      if (!onlyA) { b.x += nx * best * wb; b.z += nz * best * wb; }
    }
    // contact-point velocities: v + w * (rz, -rx)
    const rax = px - a.x, raz = pz - a.z, rbx = px - b.x, rbz = pz - b.z;
    const vax = a.vx + a.w * raz, vaz = a.vz - a.w * rax;
    const vbx = b.vx + b.w * rbz, vbz = b.vz - b.w * rbx;
    const rvx = vbx - vax, rvz = vbz - vaz;
    const vn = rvx * nx + rvz * nz;
    if (vn >= 0 || (o && o.minVn && vn > -o.minVn)) return 0;
    const ka2 = nx * raz - nz * rax, kb2 = nx * rbz - nz * rbx;
    const Ia = A.spec.Iz, Ib = B.spec.Iz;
    const e = 0.3;
    const jn = (-(1 + e) * vn) / (1 / ma + 1 / mb + (ka2 * ka2) / Ia + (kb2 * kb2) / Ib);
    a.vx -= (jn * nx) / ma; a.vz -= (jn * nz) / ma; a.w -= (jn * ka2) / Ia;
    if (!onlyA) { b.vx += (jn * nx) / mb; b.vz += (jn * nz) / mb; b.w += (jn * kb2) / Ib; }
    // tangential friction (rubbing)
    const tx = -nz, tz = nx;
    const vt = rvx * tx + rvz * tz;
    const jt = U.clamp(-vt / (1 / ma + 1 / mb), -jn * 0.25, jn * 0.25);
    a.vx -= (jt * tx) / ma; a.vz -= (jt * tz) / ma;
    if (!onlyA) { b.vx += (jt * tx) / mb; b.vz += (jt * tz) / mb; }
    return jn;
  }

  G.Physics = { DT, createCar, step, copyCore, CORE, tyreCurve, TUNE, contact, HIT };
})(window.G);
