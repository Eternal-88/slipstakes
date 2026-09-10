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
      // weightFront 0.52 -> 0.50, inertiaK 1.06 -> 0.98: a keyboard-proxy
      // driver ran wide 46 s over three tracks (worst car by far) -> 33 s,
      // and bot laps moved ~1 s closer to the field (it was slowest
      // everywhere but drags). Spins 0 -> 2.2 s; full-lock slide 27° -> 21°.
      mass: 1440, powerKW: 178, redline: 6300, rearBias: 1.0, wheelbase: 2.8, weightFront: 0.5,
      cgH: 0.54, track: 1.66, cdA: 0.98, vTop: 57, inertiaK: 0.98, body: 'muscle', len: 4.75, wid: 1.96,
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
    // Brakes have a temperature model (physics.js §7b): every stop heats them,
    // airflow cools them. Past ~70% they FADE (up to −35% force). Race pads and
    // carbon discs trade cold bite for heat capacity — so they're worse for
    // the first corner of a race and better for the rest of it.
    {
      id: 'brakes', name: 'Brakes', icon: '⛔',
      options: [
        { id: 'stock', name: 'Road Brakes', price: 0, desc: 'Full bite from cold. Predictable.', cons: 'Fade after repeated heavy stops — braking zones grow late in a race.', bForce: 1.0, bCap: 1.0, bCold: 1.0, kg: 0, caliper: 0x8c939c },
        { id: 'sport', name: 'Sport Pads', price: 900, desc: '+12% stopping power, 30% more heat capacity.', cons: 'Weak bite when cold: the first big stop of every race is long.', bForce: 1.12, bCap: 1.3, bCold: 0.8, kg: 0, caliper: 0xe8322b },
        { id: 'bbk', name: 'Big Brake Kit', price: 2400, desc: '+25% clamping force, 4-piston calipers, very hard to fade.', cons: '+14 kg of unsprung weight: heavier, and it skips more over kerbs and bumps.', bForce: 1.25, bCap: 1.9, bCold: 0.95, kg: 14, bumpM: 1.12, caliper: 0xffc400 },
        { id: 'carbon', name: 'Carbon-Ceramic', price: 4600, desc: '+32% stopping power, −6 kg, never fades.', cons: 'Almost no bite until warm: the first two stops of a race are scary.', bForce: 1.32, bCap: 3.0, bCold: 0.6, kg: -6, caliper: 0xd4a017 },
      ],
    },
    // Exhaust + ECU reshape the torque curve (torqueAt below) rather than just
    // adding a percentage: a straight pipe gains at the top and LOSES low down.
    {
      id: 'exhaust', name: 'Exhaust', icon: '♨',
      options: [
        { id: 'stock', name: 'Stock Muffler', price: 0, desc: 'Full low-end torque. Quiet.', cons: 'Chokes the top end.', tqLow: 1.0, tqHigh: 1.0, kg: 0, pops: 0 },
        { id: 'sport', name: 'Sport Cat-back', price: 800, desc: '+5% power at the top end, −5 kg.', cons: '−2% torque below half revs.', tqLow: 0.98, tqHigh: 1.05, kg: -5, pops: 0.4 },
        { id: 'straight', name: 'Straight Pipe', price: 1800, desc: '+10% top-end power, −9 kg. Pops and bangs on the overrun.', cons: 'Torque hole below half revs (−8%): bogs out of slow corners.', tqLow: 0.92, tqHigh: 1.1, kg: -9, pops: 1 },
      ],
    },
    {
      id: 'ecu', name: 'Engine Map', icon: '⌁',
      options: [
        { id: 'stock', name: 'Factory Map', price: 0, desc: 'Safe timing. Long engine life.', cons: 'Leaves power on the table.', pMul: 1.0, wearM: 1.0, heatM: 1.0, fuelM: 1.0 },
        { id: 'stage1', name: 'Stage 1 Remap', price: 1400, desc: '+8% power everywhere.', cons: 'Engine wear +25%, fuel +10%.', pMul: 1.08, wearM: 1.25, heatM: 1.05, fuelM: 1.1 },
        { id: 'stage2', name: 'Stage 2 Race Map', price: 3200, desc: '+16% power everywhere.', cons: 'Engine wear +60%, boost heat +20%, fuel +22%. Rebuilds get expensive.', pMul: 1.16, wearM: 1.6, heatM: 1.2, fuelM: 1.22 },
      ],
    },
    {
      id: 'cooling', name: 'Cooling', icon: '❄',
      options: [
        { id: 'stock', name: 'Stock Radiator', price: 0, desc: 'Fine for a naturally aspirated car.', cons: 'Boosted engines overheat on long straights.', coolM: 1.0, kg: 0, cdA: 0 },
        { id: 'radiator', name: 'Alloy Radiator', price: 700, desc: '+45% cooling: boost lasts much longer before limp mode.', cons: '+7 kg in the nose.', coolM: 1.45, kg: 7, cdA: 0 },
        { id: 'race', name: 'Race Cooling Pack', price: 1800, desc: '+100% cooling with an oil cooler. Turbo cars can run flat out.', cons: '+12 kg, and the big front opening adds drag.', coolM: 2.0, kg: 12, cdA: 0.03 },
      ],
    },
    // The diff decides how drive torque splits between the driven wheels
    // (physics.js §6): more lock = more traction and more stable powerslides,
    // but a locked axle resists turning, so the car pushes on corner entry.
    {
      id: 'diff', name: 'Differential', icon: '⧓',
      options: [
        { id: 'stock', name: 'Viscous LSD', price: 0, desc: 'Mild lock. Friendly on and off power.', cons: 'The inside wheel can spin on tight exits with lots of power.', lsd: 0.6, diffYaw: 0 },
        { id: 'clutch', name: '2-Way Clutch LSD', price: 1600, desc: 'Adjustable lock (Tuning tab). Big traction out of slow corners.', cons: 'High lock pushes the nose on turn-in and snaps when it lets go.', lsd: 0.8, diffYaw: 0, adjustable: 1 },
        { id: 'spool', name: 'Welded Spool', price: 500, desc: '100% lock: huge traction in a line, easy long drifts.', cons: 'Scrubs and understeers in slow corners; you must throw it in.', lsd: 1.0, diffYaw: 900 },
      ],
    },
  ];
  const SLOT_MAP = {};
  SLOTS.forEach((s) => {
    SLOT_MAP[s.id] = s;
    s.options.forEach((o) => (o.slot = s.id));
  });
  const STOCK = { induction: 'na', weight: 'stock', aero: 'none', compound: 'hard', width: 'std', gearing: 'stock', suspension: 'stock', brakes: 'stock', exhaust: 'stock', ecu: 'stock', cooling: 'stock', diff: 'stock' };
  const opt = (slot, id) => SLOT_MAP[slot].options.find((o) => o.id === id) || SLOT_MAP[slot].options[0];

  // ------------------------------------------------------------------------
  // SETUP (tuning). Free to change whenever the shop is open, like a real
  // pit-lane setup sheet. Every default maps to a multiplier of exactly 1, so
  // an untouched car drives identically to the pre-tuning game. `need` gates
  // an adjustment behind the part that makes it possible (you can't change
  // ride height on road springs, or wing angle without a wing).
  // lo/hi describe what moving the slider toward that end does — honestly.
  // ------------------------------------------------------------------------
  const TUNES = [
    { id: 'pressF', grp: 'Tyres', name: 'Front pressure', min: -4, max: 4, step: 1, def: 0, unit: 'psi', lo: 'Softer: more grip, lazier response, faster wear', hi: 'Harder: sharper, less grip, lasts longer' },
    { id: 'pressR', grp: 'Tyres', name: 'Rear pressure', min: -4, max: 4, step: 1, def: 0, unit: 'psi', lo: 'Softer: planted rear, slides build slowly', hi: 'Harder: rear slides earlier and snappier' },
    { id: 'camberF', grp: 'Alignment', name: 'Front camber', min: -4, max: 0, step: 0.5, def: -1, unit: '°', lo: 'More cornering grip (peaks near −2.5°), worse braking, more wear', hi: 'Best straight-line braking, less cornering grip' },
    { id: 'camberR', grp: 'Alignment', name: 'Rear camber', min: -4, max: 0, step: 0.5, def: -1, unit: '°', lo: 'Rear holds in corners, weaker traction off the line', hi: 'Best traction, rear lets go sooner mid-corner' },
    { id: 'arbF', grp: 'Anti-roll bars', name: 'Front anti-roll bar', min: 1, max: 9, step: 1, def: 5, unit: '', lo: 'Soft: front bites, car rotates more', hi: 'Stiff: front washes wide (understeer), crisper turn-in' },
    { id: 'arbR', grp: 'Anti-roll bars', name: 'Rear anti-roll bar', min: 1, max: 9, step: 1, def: 5, unit: '', lo: 'Soft: rear planted (understeer)', hi: 'Stiff: rear rotates / steps out (oversteer)' },
    { id: 'rideH', grp: 'Springs', name: 'Ride height', min: -3, max: 3, step: 1, def: 0, unit: 'cm', need: { suspension: ['sport', 'race', 'rally'] }, needTxt: 'Needs coilovers (Sport, Race or Rally suspension)', lo: 'Low: lower CG + more downforce, skips over kerbs/dirt', hi: 'High: rides bumps, more roll, less downforce' },
    { id: 'bias', grp: 'Brakes', name: 'Brake bias (front)', min: 50, max: 75, step: 1, def: 62, unit: '%', lo: 'Rearward: the rear goes light and loose under braking — rotates (or spins)', hi: 'Forward: rock-stable, but pushes wide and stops a little longer' },
    { id: 'lock', grp: 'Differential', name: 'Diff lock', min: 35, max: 95, step: 5, def: 80, unit: '%', need: { diff: ['clutch'] }, needTxt: 'Needs the 2-Way Clutch LSD', lo: 'Open: turns in freely, inside wheel spins on exit', hi: 'Locked: traction + stable slides, pushes on entry' },
    { id: 'fd', grp: 'Gearing', name: 'Final drive', min: -8, max: 8, step: 1, def: 0, unit: '%', lo: 'Longer: higher top speed, softer acceleration', hi: 'Shorter: harder acceleration, earlier limiter' },
    { id: 'wing', grp: 'Aero', name: 'Wing angle', min: 1, max: 9, step: 1, def: 5, unit: '', need: { aero: ['a2', 'a3'] }, needTxt: 'Needs the GT Wing or Full Aero Kit', lo: 'Flat: less drag, less high-speed grip', hi: 'Steep: more downforce, more drag' },
    { id: 'boost', grp: 'Engine', name: 'Boost pressure', min: 1, max: 9, step: 1, def: 5, unit: '', need: { induction: ['sc', 't1', 't2'] }, needTxt: 'Needs a supercharger or turbo', lo: 'Low: cooler and kinder to the engine', hi: 'High: more power, much more heat and wear' },
  ];
  const TUNE_MAP = {};
  TUNES.forEach((t) => (TUNE_MAP[t.id] = t));
  const defaultTune = () => {
    const o = {};
    TUNES.forEach((t) => (o[t.id] = t.def));
    return o;
  };
  const tuneAvailable = (t, installed) => {
    if (!t.need) return true;
    const p = Object.assign({}, STOCK, installed || {});
    return Object.keys(t.need).every((slot) => t.need[slot].includes(p[slot]));
  };
  // Effective setup: clamped, snapped to the step, and reset to default where
  // the enabling part isn't fitted. Host validates with this too.
  function effTune(installed, tune) {
    const out = {};
    for (const t of TUNES) {
      let v = tune && typeof tune[t.id] === 'number' && isFinite(tune[t.id]) ? tune[t.id] : t.def;
      v = U.clamp(Math.round(v / t.step) * t.step, t.min, t.max);
      out[t.id] = tuneAvailable(t, installed) ? +v.toFixed(2) : t.def;
    }
    return out;
  }

  // ------------------------------------------------------------------------
  // APPEARANCE (free, cosmetic only — never touches physics).
  // ------------------------------------------------------------------------
  const LOOK = {
    paints: [0xff3b30, 0xd7263d, 0xff8a00, 0xffc400, 0xf2e94e, 0x9be15d, 0x22c55e, 0x0f9d58, 0x19c3e6, 0x2f6bff, 0x1d3fbb, 0x6c3ce0, 0xa855f7, 0xff2d92, 0xff7eb6, 0xf5f5f5, 0xc9ced6, 0x8a929c, 0x4a4f58, 0x1b1d22, 0x7a4a2a, 0xc49a6c, 0x2f5d50, 0x9e1b32],
    accents: [0xf5f5f5, 0x1b1d22, 0xffc400, 0xff3b30, 0x2f6bff, 0x22c55e, 0x19c3e6, 0xff2d92, 0xff8a00, 0xa855f7, 0x8a929c, 0xd4a017],
    liveries: [['none', 'Plain'], ['stripes', 'Twin stripes'], ['single', 'Centre stripe'], ['side', 'Side stripe'], ['twotone', 'Two-tone'], ['roof', 'Contrast roof'], ['race', 'Race (stripes + roundels)'], ['checker', 'Checker roof']],
    rims: [['five', '5-spoke'], ['mesh', 'Mesh'], ['dish', 'Dish'], ['rally', 'Rally steel'], ['turbine', 'Turbine']],
    rimCols: [0xc9d0d8, 0x2a2d33, 0xd4a017, 0xf5f5f5, 0x5a6270, 0xa0602e, 0xe8322b, 0x19c3e6],
    tints: [['clear', 'Clear'], ['dark', 'Dark'], ['black', 'Limo black']],
    glows: [['none', 'None'], ['cyan', 'Cyan'], ['pink', 'Pink'], ['green', 'Green'], ['yellow', 'Yellow'], ['purple', 'Purple']],
  };
  const GLOW_COL = { cyan: 0x29d3ff, pink: 0xff3d9a, green: 0x2fe07a, yellow: 0xffcc00, purple: 0xa855f7 };
  function defaultLook(num) {
    return { paint: null, accent: 0xf5f5f5, livery: 'none', rims: 'five', rimCol: 0xc9d0d8, num: num || 0, tint: 'dark', glow: 'none' };
  }
  // Validate a look patch from the wire (host side).
  function cleanLook(look, patch) {
    const o = Object.assign(defaultLook(), look || {});
    const ok = (list, v) => list.some((x) => (Array.isArray(x) ? x[0] : x) === v);
    for (const k in patch || {}) {
      const v = patch[k];
      if (k === 'paint' && (v === null || (Number.isInteger(v) && v >= 0 && v <= 0xffffff))) o.paint = v;
      else if (k === 'accent' && Number.isInteger(v) && v >= 0 && v <= 0xffffff) o.accent = v;
      else if (k === 'rimCol' && Number.isInteger(v) && v >= 0 && v <= 0xffffff) o.rimCol = v;
      else if (k === 'livery' && ok(LOOK.liveries, v)) o.livery = v;
      else if (k === 'rims' && ok(LOOK.rims, v)) o.rims = v;
      else if (k === 'tint' && ok(LOOK.tints, v)) o.tint = v;
      else if (k === 'glow' && ok(LOOK.glows, v)) o.glow = v;
      else if (k === 'num' && Number.isInteger(v) && v >= 0 && v <= 99) o.num = v;
    }
    return o;
  }

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
  // Torque at normalised rpm r for a specific build: the base curve reshaped
  // by the exhaust (tqLow below ~half revs, tqHigh toward the redline).
  // Stock parts give exactly torqueShape(r).
  function torqueAt(s, r) {
    const lo = s.tqLow == null ? 1 : s.tqLow, hi = s.tqHigh == null ? 1 : s.tqHigh;
    let f = 1;
    if (r <= 0.45) f = lo;
    else if (r < 0.62) f = U.lerp(lo, 1, (r - 0.45) / 0.17);
    else f = U.lerp(1, hi, Math.min(1, (r - 0.62) / 0.38));
    return torqueShape(r) * f;
  }

  // Boost availability vs normalised rpm (turbos need revs; superchargers don't).
  function boostAvail(spec, r) {
    if (spec.boostKind === 'none') return 0;
    if (spec.boostKind === 'sc') return 0.45 + 0.55 * r;
    return U.smoothstep(spec.boostOn - 0.12, spec.boostOn + 0.12, r);
  }

  // ------------------------------------------------------------------------
  // computeSpec: the ONLY place parts turn into physics numbers.
  // ------------------------------------------------------------------------
  function computeSpec(carId, installed, wear, tune) {
    const c = CARS[carId] || CARS.vandal;
    const p = Object.assign({}, STOCK, installed || {});
    const w = Object.assign({ tyre: 0, engine: 0, body: 0 }, wear || {});
    const ind = opt('induction', p.induction), wt = opt('weight', p.weight), ae = opt('aero', p.aero);
    const cp = opt('compound', p.compound), wd = opt('width', p.width), gr = opt('gearing', p.gearing), su = opt('suspension', p.suspension);
    const br = opt('brakes', p.brakes), ex = opt('exhaust', p.exhaust), ec = opt('ecu', p.ecu), co = opt('cooling', p.cooling), df = opt('diff', p.diff);
    const T = effTune(p, tune);

    const mass = c.mass - wt.kg + (ae.kg || 0) + br.kg + ex.kg + co.kg;
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
    const finalDrive = baseFD * gr.fd * (1 + T.fd / 100);
    const engineHealth = 1 - 0.38 * Math.pow(U.clamp(w.engine, 0, 1), 1.3);
    const peakTorque = ((c.powerKW * 1000) / (POWER_SHAPE_PEAK * redlineW)) * ec.pMul;

    const tyreHealth = 1 - 0.32 * Math.pow(U.clamp(w.tyre, 0, 1), 1.6);
    const mu = 1.12 * cp.mu * tyreHealth;

    // ---- setup (tuning) → per-axle tyre multipliers. Defaults give exactly 1.
    // Pressure (psi, + = harder): softer = more grip but a larger peak slip
    // angle and slower force build-up (sidewall flex), and faster wear.
    const press = (ps) => ({ lat: 1 - 0.006 * ps, peak: 1 - 0.025 * ps, tau: 1 - 0.04 * ps, wear: 1 - 0.05 * ps });
    const pF = press(T.pressF), pR = press(T.pressR);
    // Camber: lateral grip peaks around −2.5°; every degree costs braking /
    // traction grip and a little wear. Normalised to the −1° default.
    const camLat = (cb) => 1 + 0.045 * (1 - Math.pow((cb + 2.5) / 2.5, 2));
    const camLon = (cb) => 1 - 0.02 * Math.abs(cb);
    const cF = T.camberF, cR = T.camberR;
    // Anti-roll bars: the front share of roll stiffness decides which axle's
    // outside tyre carries more of the load transfer. With tyre load
    // sensitivity (loadSens) the more-loaded axle loses grip — stiff front =
    // understeer, stiff rear = oversteer. 0.55 was the old hard-coded value.
    const arbSum = T.arbF + T.arbR - 10;
    const rollF = U.clamp(0.55 + 0.022 * (T.arbF - T.arbR), 0.38, 0.72);
    const rideCm = T.rideH;
    const wingM = 0.7 + 0.075 * (T.wing - 1);
    const boostM = 0.8 + 0.05 * (T.boost - 1);
    const lsd = df.adjustable ? T.lock / 100 : df.lsd;
    const diffYaw = df.diffYaw + (df.adjustable ? Math.max(0, lsd - 0.6) * 1200 : 0);

    // Per-surface grip multipliers (indexed by G.SURF code), built from width + suspension + car.
    const loose = wd.loose * su.looseM * (c.looseBonus || 1);
    const surfMul = G.SURF.map((s) => {
      let m = s.grip;
      if (s.wet) m *= wd.wetM;
      else if (s.loose) m *= loose;
      else m *= wd.dry;
      return m;
    });

    const aeroCl = ae.id === 'a2' || ae.id === 'a3' ? ae.clA * wingM : ae.clA;
    const aeroCd = ae.id === 'a2' || ae.id === 'a3' ? ae.cdA * (0.5 + 0.5 * wingM) : ae.cdA;
    const s = {
      carId: c.id, parts: p, tune: T,
      mass, Iz, wheelbase: c.wheelbase, cgF, cgR, cgH: c.cgH + su.rideH * 0.5 + rideCm * 0.006, track: c.track, wheelR: WHEEL_R,
      len: c.len, wid: c.wid,
      rearBias: c.rearBias, drive: c.drive,
      redline: c.redline, redlineW, idle: 0.14, peakTorque, gears, finalDrive, revRatio: 3.4,
      tqLow: ex.tqLow, tqHigh: ex.tqHigh, pops: ex.pops,
      shiftTime: gr.shift, shiftKick: gr.kick, upR: 0.97, downR: 0.55,
      boostKind: ind.kind, boostGain: ind.boostGain * boostM, boostLag: ind.boostLag, boostOn: ind.boostOn,
      heatRate: ind.heatRate * ec.heatM * boostM * boostM, coolRate: 0.035 * co.coolM, fuelRate: 0.85 * ind.fuelMult * ec.fuelM,
      engineHealth,
      clA: aeroCl * (1 - 0.035 * rideCm), cdA: c.cdA + aeroCd + wd.cdA + co.cdA + w.body * 0.12, aeroFront: 0.42,
      mu, rearGrip: 1.0, peakSlip: cp.peak, slideRatio: 0.8, surfMul, aqua: wd.aqua ? 1 : 0,
      // per-axle setup multipliers (physics.js §7)
      latF: pF.lat * (camLat(cF) / camLat(-1)), latR: pR.lat * (camLat(cR) / camLat(-1)),
      lonF: camLon(cF) / camLon(-1), lonR: camLon(cR) / camLon(-1),
      peakF: pF.peak, peakR: pR.peak,
      latTauF: su.latTau * pF.tau, latTauR: su.latTau * pR.tau,
      rollF, lsd, diffYaw,
      loadSens: 0.16, fzNom: (1200 * G_ACC) / 4,
      tyreWearRate: cp.wear * ((pF.wear + pR.wear) / 2) * (1 + 0.05 * ((Math.abs(cF) + Math.abs(cR)) / 2 - 1)), tyreHealth,
      loadTau: su.loadTau * (1 - 0.015 * arbSum), latTau: su.latTau, rollGain: su.roll * (1 - 0.035 * arbSum),
      bumpSens: su.bump * (1 - 0.07 * rideCm) * (br.bumpM || 1), rideH: su.rideH + rideCm * 0.01, roughGrip: su.roughGrip * (1 - 0.07 * rideCm) * (br.bumpM || 1),
      // brakes: force multiplier, heat capacity, cold bite (physics.js §7b)
      bForce: br.bForce, bCap: br.bCap, bCold: br.bCold, caliper: br.caliper,
      // Lock shrinks with speed: lock = 0.56 / (1 + v/14). At 90 km/h full keyboard
      // lock ≈ 0.16 rad — near the tyres' peak slip, so holding a key at speed
      // turns hard instead of scrubbing the fronts wide. (Falloff 24 -> 14 cut a
      // binary-input driver's off-track time 42 s -> 25 s per 150 s on Harbour;
      // analogue bot lap times unchanged.)
      steerLock: 0.56, steerFalloff: 14, steerRate: 3.4 * su.steer,
      brakeForce: mass * G_ACC * 1.3 * br.bForce, brakeFront: T.bias / 100,
      csAssist: 0.6, yawDamp: 0.9, spinAssist: 2.2, spinAngle: 0.62,
      engineWearRate: 0.00016 * (1 + ind.boostGain * 1.4) * (gr.id === 'seq' ? 1.25 : 1) * ec.wearM * (1 + (boostM - 1) * 1.5),
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
      const T = s.peakTorque * torqueAt(s, r) * (1 + s.boostGain * b) * s.engineHealth;
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
        const T = s.peakTorque * torqueAt(s, rr) * (1 + s.boostGain * boost) * s.engineHealth;
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
    // the weaker axle limits the car; roll-stiffness split moves load (and,
    // through load sensitivity, grip) between them
    const ax = Math.min((s.latF || 1) * (1 - (s.rollF - 0.55) * 0.35), (s.latR || 1) * (1 + (s.rollF - 0.55) * 0.35));
    return ((s.mu * s.surfMul[surf] * sens * (m * G_ACC + D)) / (m * G_ACC)) * 0.94 * (0.5 + 0.5 * ax);
  }

  // Stopping distance 100→0 km/h on dry tarmac (1-D, steady load transfer).
  // Each axle gets bias × brake force, capped by ABS just under the axle's
  // grip. `heat` = energy absorbed in the fade model (0 = cold, ~1.05 = a
  // road-brake car late in a stop-start race; divided by the part's bCap).
  function brakeDist(s, heat) {
    const m = s.mass, L = s.wheelbase, g = G_ACC;
    const bt = heat / (s.bCap || 1);
    const warm = U.clamp(heat / 0.45, 0, 1);
    const abs = G.Physics ? G.Physics.TUNE.abs : 0.85;
    const fade = 1 - 0.4 * U.clamp((bt - 0.65) / 0.5, 0, 1);
    const cold = (s.bCold || 1) + (1 - (s.bCold || 1)) * warm;
    const F = s.brakeForce * fade * cold;
    let v = 27.78, d = 0, a = 9;
    const dt = 0.005;
    for (let k = 0; k < 4000 && v > 0.1; k++) {
      const Dn = 0.5 * RHO * s.clA * v * v;
      const tr = (m * a * s.cgH) / L;
      const fzF = (m * g * s.cgR) / L + tr + Dn * s.aeroFront, fzR = (m * g * s.cgF) / L - tr + Dn * (1 - s.aeroFront);
      const axle = (fz, lon) => {
        const sens = 1 - s.loadSens * (fz / 2 / s.fzNom - 1);
        return s.mu * s.surfMul[0] * sens * fz * 1.05 * lon;
      };
      const gF = axle(fzF, s.lonF || 1), gR = axle(Math.max(0, fzR), s.lonR || 1);
      const dF = F * s.brakeFront, dR = F * (1 - s.brakeFront);
      // ABS caps each axle just under its peak (same rule as physics.js)
      const fF = Math.min(dF, gF * abs), fR = Math.min(dR, gR * abs);
      const drag = 0.5 * RHO * s.cdA * v * v;
      a = (fF + fR + drag) / m;
      v -= a * dt;
      d += v * dt;
    }
    return d;
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
    // setup: roll-stiffness split, rear/front grip balance, brake bias, diff
    stab += (s.rollF - 0.55) * 10;
    stab += ((s.latR || 1) / (s.latF || 1) - 1) * 14;
    stab -= Math.max(0, 0.6 - s.brakeFront) * 14;
    stab += (s.lsd - 0.6) * 1.5;
    stab = U.clamp(stab, 0, 10);
    const rough = ((s.surfMul[G.SI.wet] + s.surfMul[G.SI.dirt] + s.surfMul[G.SI.gravel]) / 3) * s.mu * (1 - s.bumpSens * 0.18);
    const cost = runningCost(s);
    const heatSecs = s.heatRate > 0 ? 1 / Math.max(0.001, s.heatRate - s.coolRate * 0.75) : Infinity;
    // "hot" = the brake energy measured late in a 3-lap race (telemetry: road
    // brakes 1.1 on Kerbside City with a keyboard driver, 1.4 on Harbour Loop)
    const bCold = brakeDist(s, 0), bHot = brakeDist(s, 1.3);
    const bWorst = Math.max(bCold, bHot);
    return {
      vmax, t100, tRoll, tq, gHigh, gLow, ex, heatSecs, cost, bCold, bHot,
      bars: [
        { k: 'Top speed', v: U.clamp((vmax * 3.6 - 150) / 10, 0, 10), txt: Math.round(vmax * 3.6) + ' km/h' },
        { k: 'Acceleration', v: U.clamp((17 - tq) * 2.5, 0, 10), txt: t100.toFixed(1) + ' s 0-100 · ¼ mi ' + tq.toFixed(2) + ' s' },
        { k: 'Braking', v: U.clamp((60 - bWorst) / 2.4, 0, 10), txt: '100-0 ' + Math.round(bCold) + ' m cold · ' + Math.round(bHot) + ' m hot' },
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
    return 900 + 0.35 * opt('induction', p.induction).price + 0.25 * opt('ecu', p.ecu).price;
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
    if (p.brakes === 'carbon' || p.brakes === 'sport') out.push(['warn', 'Race brake pads need heat: the first stops of every race are long — brake early into turn 1.']);
    if (p.brakes === 'stock' && s.boostGain >= 0.5) out.push(['warn', 'Road brakes on a fast car fade late in a race: braking zones grow as they heat up.']);
    if (p.exhaust === 'straight') out.push(['warn', 'Straight pipe: torque hole below half revs — bogs out of hairpins in a high gear.']);
    if (p.ecu === 'stage2') out.push(['warn', 'Race map: engine wear +60% — budget for rebuilds.']);
    if (p.diff === 'spool') out.push(['warn', 'Welded spool: the car pushes in slow corners. Throw it in and drift, or lose time.']);
    const t = s.tune || {};
    if (t.bias != null && t.bias <= 56) out.push(['bad', 'Rear brake bias: the rear tyres are at their limit under hard braking — the car will try to swap ends.']);
    if (t.bias >= 70) out.push(['warn', 'Forward brake bias: the fronts do all the work — the car pushes wide when you brake into a corner.']);
    if (t.arbR - t.arbF >= 4) out.push(['warn', 'Rear bar much stiffer than the front: expect lift-off oversteer.']);
    if (t.arbF - t.arbR >= 4) out.push(['warn', 'Front bar much stiffer than the rear: the nose will wash wide.']);
    if (t.rideH <= -2 && (p.suspension === 'race' || p.suspension === 'sport')) out.push(['warn', 'Slammed on stiff springs: kerbs and dirt will launch it.']);
    if (t.pressF <= -3 || t.pressR <= -3) out.push(['warn', 'Very low tyre pressures: grip up, but tyres wear fast and response goes soft.']);
    if (t.boost >= 8) out.push(['bad', 'Boost turned right up: heat and engine wear climb fast.']);
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
    return { carId, installed: Object.assign({}, STOCK), owned, wear: { tyre: 0, engine: 0, body: 0 }, tune: defaultTune(), look: defaultLook() };
  }

  // Bring a garage from an older save up to date (new slots, tune, look).
  function fixGarage(g) {
    if (!g) return g;
    g.installed = Object.assign({}, STOCK, g.installed || {});
    g.owned = g.owned || {};
    SLOTS.forEach((s) => {
      if (!Array.isArray(g.owned[s.id]) || !g.owned[s.id].length) g.owned[s.id] = [s.options[0].id];
    });
    g.wear = Object.assign({ tyre: 0, engine: 0, body: 0 }, g.wear || {});
    g.tune = Object.assign(defaultTune(), g.tune || {});
    g.look = Object.assign(defaultLook(), g.look || {});
    return g;
  }

  function partsValue(garage) {
    let v = 0;
    SLOTS.forEach((s) => (garage.owned[s.id] || []).forEach((id) => (v += opt(s.id, id).price)));
    return v;
  }

  // Changing chassis between races: parts move over to the new car.
  const CAR_SWAP = 800;

  G.Parts = {
    CARS, CAR_ORDER, SLOTS, SLOT_MAP, STOCK, opt, computeSpec, computeStats, warnings, boostAvail, torqueShape, torqueAt,
    topSpeed, zeroTo100, repairQuote, tyreSetPrice, engineRebuildPrice, BASIC_REPAIR, BODY_REPAIR, newGarage, fixGarage, partsValue,
    TUNES, TUNE_MAP, defaultTune, effTune, tuneAvailable, LOOK, GLOW_COL, defaultLook, cleanLook, brakeDist, CAR_SWAP,
    WHEEL_R, RHO, G_ACC,
  };
})(window.G);
