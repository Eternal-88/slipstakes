// hud.js — in-race HUD: position (animated on overtakes), laps, timers with
// lap delta, a canvas speedo/rev arc with shift light, boost/heat/brake/tyre/
// engine gauges, F1-style start lights, standings tower, heading-arrow
// minimap, race progress bar (sprints/drags), name tags, banners, speed
// vignette and hit flash. Updated every frame with change detection.
'use strict';
(function (G) {
  const U = G.U;
  const ST = () => G.Settings.s;
  // v5.8 cluster geometry, in the 300×196 canvas: the rev dial tucked into
  // the corner (a0..a1, a 270° sweep open at the bottom), the nitrous arc
  // outside its left edge, and to its left the boost dial and a column for
  // the perfect-shift / shift-up call (tx)
  const CLU = { cx: 206, cy: 104, R: 78, a0: Math.PI * 0.75, a1: Math.PI * 2.25, sw: Math.PI * 1.5, n0: Math.PI * 0.8, n1: Math.PI * 1.1, tx: 52, b: { x: 52, y: 146, R: 24, a0: Math.PI * 0.72, a1: Math.PI * 2.28 } };

  class HUD {
    constructor(root) {
      this.root = root;
      root.innerHTML = `
        <div class="hud-vig"></div><div class="hud-flash"></div><div class="hud-draftglow"></div>
        <div class="hud-tl">
          <div class="hud-pos"><span class="pos-n">-</span><span class="pos-of">/-</span><em class="pos-d"></em></div>
          <div class="hud-lap"><span class="lap-w">LAP </span><b class="lap-n">-</b></div>
          <div class="hud-times">
            <div><span>TIME</span><b class="t-cur">-</b></div>
            <div><span>LAST</span><b class="t-last">-</b></div>
            <div><span>BEST</span><b class="t-best">-</b></div>
          </div>
        </div>
        <div class="hud-tower"></div>
        <canvas class="hud-map" width="200" height="200"></canvas>
        <div class="hud-prog"><div class="pg-bar"></div><div class="pg-dots"></div></div>
        <div class="hud-draft"><span class="dr-c">›››</span><div><b class="dr-t">SLIPSTREAM</b><em class="dr-v"></em><i class="dr-m"><u></u></i></div><span class="dr-c">‹‹‹</span></div>
        <div class="hud-br">
          <div class="hud-assist"><span class="as-net"></span><span class="as-wind"></span><span class="as-cu"></span></div>
          <canvas class="speedo" width="300" height="196"></canvas>
          <div class="gauges">
            <div class="gauge nos"><span>N2O</span><div><i></i></div></div>
            <div class="gauge heat"><span>HEAT</span><div><i></i></div></div>
            <div class="gauge brk"><span>BRAKES</span><div><i></i></div></div>
            <div class="gauge tyre"><span>TYRES</span><div><i></i></div></div>
            <div class="gauge eng"><span>ENGINE</span><div><i></i></div></div>
            <div class="gauge fuel"><span>FUEL</span><div><i></i></div></div>
          </div>
        </div>
        <div class="hud-pit"><b class="hp-t"></b><em class="hp-s"></em></div>
        <div class="hud-lights"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="hud-center"><div class="cd"></div><div class="banner"></div><div class="sub"></div></div>
        <div class="hud-tags"></div>
        <div class="hud-help"></div>
        <div class="hud-debug"></div>`;
      const $ = (s) => root.querySelector(s);
      this.el = {
        posN: $('.pos-n'), posOf: $('.pos-of'), posD: $('.pos-d'), lap: $('.lap-n'), lapW: $('.lap-w'), cur: $('.t-cur'), last: $('.t-last'), best: $('.t-best'),
        tower: $('.hud-tower'), map: $('.hud-map'), speedo: $('.speedo'),
        heat: $('.heat i'), heatBox: $('.gauge.heat'), brk: $('.brk i'), brkBox: $('.gauge.brk'), tyre: $('.tyre i'), eng: $('.eng i'),
        cd: $('.cd'), banner: $('.banner'), sub: $('.sub'), tags: $('.hud-tags'), br: $('.hud-br'), tl: $('.hud-tl'), debug: $('.hud-debug'), help: $('.hud-help'),
        lights: root.querySelectorAll('.hud-lights i'), lightsBox: $('.hud-lights'), prog: $('.hud-prog'), pgDots: $('.pg-dots'), vig: $('.hud-vig'), flash: $('.hud-flash'),
        fuel: $('.fuel i'), fuelBox: $('.gauge.fuel'), engBox: $('.gauge.eng'), tyreLbl: $('.gauge.tyre span'), pit: $('.hud-pit'), pitT: $('.hp-t'), pitS: $('.hp-s'),
        nos: $('.nos i'), nosBox: $('.gauge.nos'), dr: $('.hud-draft'), drBar: $('.dr-m u'), drV: $('.dr-v'), drGlow: $('.hud-draftglow'), asCu: $('.as-cu'), asWind: $('.as-wind'), asNet: $('.as-net'),
      };
      this.ctx = this.el.map.getContext('2d');
      this.sctx = this.el.speedo.getContext('2d');
      this.cache = {};
      this.tagEls = {};
      this.bannerT = 0;
      this._p = {};
      this.debugOn = false;
      this.lastPos = 0;
      this.posPopT = 0;
      this._wrongT = 0;
      this._sp = {};
      G.Settings.on(() => this.applySettings());
      window.addEventListener('resize', () => this.applySettings());
      this.applySettings();
    }

    applySettings() {
      const s = ST();
      // v4.5: HUD size × the screen fit (laid out for 1366x768, see ui.js)
      this.z = (s.hudScale / 100) * (G.UI && G.UI.fitScale ? G.UI.fitScale() : 1);
      this.root.style.setProperty('--hud', this.z.toFixed(3));
      this._crisp();
      this.el.map.style.display = s.minimap ? '' : 'none';
      this.el.tags.style.display = s.tags ? '' : 'none';
      const K = s.keys, n = G.Settings.keyName;
      this.el.help.textContent = `${n(K.up)}/↑ throttle · ${n(K.down)}/↓ brake/reverse · ${n(K.left)} ${n(K.right)} steer · ${n(K.hb)} handbrake · ${n(K.nitro)} nitrous · ${K.shiftUp ? n(K.shiftUp) : '-'}/${K.shiftDown ? n(K.shiftDown) : '-'} shift (manual cars) · ${n(K.reset)} reset · ${n(K.cam)} camera · Esc menu · tuck in behind a car to slipstream`;
      this.cache = {};
    }

    // Canvas backing stores at the real on-screen pixel size (HUD zoom ×
    // device pixel ratio), so the minimap and speedo stay sharp at any size.
    _crisp() {
      const k = U.clamp((window.devicePixelRatio || 1) * this.z, 1, 4);
      if (Math.abs(k - (this.k || 0)) < 0.01) return;
      this.k = k;
      this.el.map.width = this.el.map.height = Math.round(200 * k);
      this.el.speedo.width = Math.round(300 * k);
      this.el.speedo.height = Math.round(196 * k);
      this._spk = null;
      this._face = null;
      if (this.track) {
        const keep = [this.bestSeen, this.lastPos, this._wearTold, this.enduT];
        this.setTrack(this.track); // redraw the map background at the new size
        [this.bestSeen, this.lastPos, this._wearTold, this.enduT] = keep;
      }
    }

    set(key, el, val, prop) {
      if (this.cache[key] === val) return;
      this.cache[key] = val;
      // (v5.8: 'className' is the element's, not a style - the pit panel went
      // through here and wrote el.style.className, so it never once showed)
      if (prop === 'className') el.className = val;
      else if (prop) el.style[prop] = val;
      else el.textContent = val;
    }

    show(on) {
      this.root.style.display = on ? '' : 'none';
      document.body.classList.toggle('racing', !!on);
    }

    setTrack(track) {
      this.track = track;
      this.enduT = null; // v5: fuel tracking starts again every race
      this._windTold = false; // v5.1: warn about the crosswind once a race
      // Pre-render the track outline into an offscreen canvas.
      const b = track.bounds;
      const size = 200, pad = 14;
      const s = Math.min((size - pad * 2) / (b.x1 - b.x0 || 1), (size - pad * 2) / (b.z1 - b.z0 || 1));
      this.mapT = { s, ox: size / 2 - b.cx * s, oz: size / 2 + b.cz * s };
      const off = document.createElement('canvas');
      const k = this.k || 1;
      off.width = off.height = Math.round(size * k);
      const c = off.getContext('2d');
      c.scale(k, k);
      const draw = (w, col) => {
        c.beginPath();
        for (let i = 0; i < track.N; i++) {
          const x = -track.X[i] * s + size - this.mapT.ox, y = this.mapT.oz - track.Z[i] * s;
          i ? c.lineTo(x, y) : c.moveTo(x, y);
        }
        if (track.closed) c.closePath();
        c.lineWidth = w;
        c.strokeStyle = col;
        c.lineJoin = 'round';
        c.stroke();
      };
      draw(10, 'rgba(0,0,0,0.55)');
      draw(6, '#e9edf5');
      // colour loose / wet sections on the map
      for (let i = 0; i < track.N - 1; i++) {
        const sf = G.SURF[track.S[i]];
        if (!sf.loose && !sf.wet) continue;
        c.beginPath();
        c.moveTo(-track.X[i] * s + size - this.mapT.ox, this.mapT.oz - track.Z[i] * s);
        c.lineTo(-track.X[i + 1] * s + size - this.mapT.ox, this.mapT.oz - track.Z[i + 1] * s);
        c.lineWidth = 4;
        c.strokeStyle = sf.wet ? '#7fb2ff' : '#d9a066';
        c.stroke();
      }
      // v4 hazards: oil / mud / ice patches, speed pads, obstacles
      const M = (x, z) => [-x * s + size - this.mapT.ox, this.mapT.oz - z * s];
      for (const p of track.patches) {
        const q = track.pointAt(p.at, p.lat);
        const [x, y] = M(q.x, q.z);
        c.fillStyle = p.k === 'oil' ? '#15171c' : p.k === 'mud' ? '#8a5a30' : p.k === 'water' ? '#4f9be0' : '#dff3ff';
        c.beginPath();
        c.arc(x, y, 3.2, 0, Math.PI * 2);
        c.fill();
      }
      for (const p of track.pads) {
        const q = track.pointAt(p.at, p.lat);
        const [x, y] = M(q.x, q.z);
        c.fillStyle = '#39d4ff';
        c.fillRect(x - 2.5, y - 2.5, 5, 5);
      }
      if (track.pit) {
        // v5: the pit box, a white P
        const q = track.pointAt(track.pit.at, track.pit.lat);
        const [x, y] = M(q.x, q.z);
        c.fillStyle = '#f5f7fc';
        c.beginPath();
        if (c.roundRect) c.roundRect(x - 5, y - 5, 10, 10, 2);
        else c.rect(x - 5, y - 5, 10, 10);
        c.fill();
        c.fillStyle = '#0e1322';
        c.font = "bold 8px 'Nunito', sans-serif";
        c.textAlign = 'center';
        c.fillText('P', x, y + 3);
      }
      for (const o of track.dyn || []) {
        // v5 moving hazards: rockfall zones and wrecking balls, orange
        const q = track.pointAt(o.at, 0);
        const [x, y] = M(q.x, q.z);
        c.fillStyle = '#ff9a1f';
        c.beginPath();
        c.moveTo(x, y - 3.6);
        c.lineTo(x + 3.4, y + 2.6);
        c.lineTo(x - 3.4, y + 2.6);
        c.fill();
      }
      for (const o of track.obs) {
        const [x, y] = M(o.x, o.z);
        c.fillStyle = '#ff4a3d';
        c.beginPath();
        c.arc(x, y, 2.4, 0, Math.PI * 2);
        c.fill();
      }
      const st = track.pointAt(track.startDist, 0);
      c.fillStyle = '#ffcc00';
      c.fillRect(-st.x * s + size - this.mapT.ox - 3, this.mapT.oz - st.z * s - 3, 6, 6);
      if (!track.closed) {
        const fn = track.pointAt(track.finishDist, 0);
        c.fillStyle = '#ffffff';
        c.fillRect(-fn.x * s + size - this.mapT.ox - 4, this.mapT.oz - fn.z * s - 4, 8, 8);
        c.fillStyle = '#111';
        c.fillRect(-fn.x * s + size - this.mapT.ox - 4, this.mapT.oz - fn.z * s - 4, 4, 4);
        c.fillRect(-fn.x * s + size - this.mapT.ox, this.mapT.oz - fn.z * s, 4, 4);
      }
      this.mapBg = off;
      this.cache = {};
      this.lastPos = 0;
      this.bestSeen = null;
      this._wearTold = false;
      this.el.prog.style.display = track.closed ? 'none' : '';
    }

    mapXY(x, z) {
      return [-x * this.mapT.s + 200 - this.mapT.ox, this.mapT.oz - z * this.mapT.s];
    }

    // Drawn with world X mirrored so the minimap matches the default camera
    // (looking toward +Z, +X appears on the LEFT of the screen). Cars are
    // arrows pointing along their heading.
    drawMap(cars, meId) {
      if (!ST().minimap) return;
      const c = this.ctx;
      c.setTransform(this.k || 1, 0, 0, this.k || 1, 0, 0);
      c.clearRect(0, 0, 200, 200);
      if (this.mapBg) c.drawImage(this.mapBg, 0, 0, 200, 200);
      const draw = (car, me) => {
        const [x, y] = this.mapXY(car.x, car.z);
        const r = me ? 7.5 : 5.5;
        c.save();
        c.translate(x, y);
        // The arrow is drawn pointing up (screen −y = world +Z). World forward
        // is (sin h, cos h); on this map +X is mirrored to the LEFT, so the
        // screen direction is (−sin h, −cos h) = "up" rotated by −h. (It used
        // to rotate by +h, which pointed sideways-travelling cars backwards.)
        c.rotate(-car.h);
        c.beginPath();
        c.moveTo(0, -r);
        c.lineTo(r * 0.75, r * 0.8);
        c.lineTo(0, r * 0.4);
        c.lineTo(-r * 0.75, r * 0.8);
        c.closePath();
        c.fillStyle = '#' + car.color.toString(16).padStart(6, '0');
        c.fill();
        c.lineWidth = me ? 2.2 : 1.3;
        c.strokeStyle = me ? '#fff' : '#111';
        c.stroke();
        c.restore();
      };
      for (const car of cars) if (car.id !== meId) draw(car, false);
      for (const car of cars) if (car.id === meId) draw(car, true);
    }

    // v5.8 instrument cluster, 300×196. A proper rev counter at last: a
    // 270° dial numbered in each car's own thousands of rpm (a 9,000 rpm
    // rotary and a 6,300 rpm V8 no longer look the same), red from its
    // redline, a needle, and the gear big in the middle with the speed under
    // it - the layout racing games settled on because the eye lands on the
    // gear first. Shift lights run across the top (blue = shift now, which
    // on a manual car is a perfect shift); nitrous is an arc round the dial;
    // boost (or an electric motor's temperature) keeps a dial of its own.
    // The dial face is drawn once per car and size into its own canvas, so a
    // frame is a copy and a handful of strokes.
    _clusterFace(g, k) {
      const key = g.redline + '|' + k + '|' + (g.dial || '') + '|' + (g.nos ? 1 : 0) + '|' + (g.manual ? 1 : 0);
      if (this._face && this._face.key === key) return this._face;
      const cv = document.createElement('canvas');
      cv.width = Math.round(300 * k);
      cv.height = Math.round(196 * k);
      const c = cv.getContext('2d');
      c.setTransform(k, 0, 0, k, 0, 0);
      const D = CLU, maxK = Math.ceil(g.redline / 1000 + 0.3), redF = (g.redline * 0.97) / (maxK * 1000);
      // disc
      const bg = c.createRadialGradient(D.cx, D.cy - 20, 10, D.cx, D.cy, D.R + 8);
      bg.addColorStop(0, 'rgba(22,30,52,0.92)');
      bg.addColorStop(1, 'rgba(6,9,20,0.86)');
      c.fillStyle = bg;
      c.beginPath();
      c.arc(D.cx, D.cy, D.R + 8, 0, Math.PI * 2);
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = 'rgba(160,190,255,0.22)';
      c.stroke();
      // red zone band
      c.lineWidth = 7;
      c.strokeStyle = 'rgba(255,74,61,0.55)';
      c.beginPath();
      c.arc(D.cx, D.cy, D.R - 3.5, D.a0 + D.sw * redF, D.a1);
      c.stroke();
      // ticks: every 1,000 (numbered) and 500
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = "12px 'Russo One', Impact, sans-serif";
      for (let i = 0; i <= maxK * 2; i++) {
        const f = i / (maxK * 2), a = D.a0 + D.sw * f, major = i % 2 === 0, red = f >= redF - 0.001;
        const r0 = D.R - (major ? 13 : 8), r1 = D.R - 1;
        c.lineWidth = major ? 2.2 : 1.2;
        c.strokeStyle = red ? '#ff6a5c' : major ? 'rgba(235,242,255,0.9)' : 'rgba(235,242,255,0.45)';
        c.beginPath();
        c.moveTo(D.cx + Math.cos(a) * r0, D.cy + Math.sin(a) * r0);
        c.lineTo(D.cx + Math.cos(a) * r1, D.cy + Math.sin(a) * r1);
        c.stroke();
        if (major) {
          c.fillStyle = red ? '#ff6a5c' : 'rgba(235,242,255,0.85)';
          c.fillText(String(i / 2), D.cx + Math.cos(a) * (D.R - 23), D.cy + Math.sin(a) * (D.R - 23) + 1);
        }
      }
      c.font = "bold 7px 'Nunito', system-ui, sans-serif";
      c.fillStyle = 'rgba(150,162,196,0.8)';
      c.fillText('×1000 r/min', D.cx, D.cy - 40);
      // nitrous track, round the lower left of the dial
      if (g.nos) {
        c.lineWidth = 4;
        c.lineCap = 'round';
        c.strokeStyle = 'rgba(127,224,255,0.14)';
        c.beginPath();
        c.arc(D.cx, D.cy, D.R + 13, D.n0, D.n1);
        c.stroke();
        c.lineCap = 'butt';
        c.font = "900 7px 'Nunito', system-ui, sans-serif";
        c.fillStyle = 'rgba(127,224,255,0.7)';
        c.fillText('N2O', D.cx + Math.cos(D.n1 + 0.13) * (D.R + 13), D.cy + Math.sin(D.n1 + 0.13) * (D.R + 13));
      }
      // the boost / motor dial's face
      if (g.dial) {
        const B = D.b;
        c.fillStyle = 'rgba(6,10,22,0.78)';
        c.beginPath();
        c.arc(B.x, B.y, B.R + 8, 0, Math.PI * 2);
        c.fill();
        c.lineWidth = 1.2;
        c.strokeStyle = 'rgba(160,190,255,0.2)';
        c.stroke();
        c.lineWidth = 5;
        c.strokeStyle = 'rgba(255,255,255,0.09)';
        c.beginPath();
        c.arc(B.x, B.y, B.R, B.a0, B.a1);
        c.stroke();
        c.strokeStyle = 'rgba(255,74,61,0.3)';
        c.beginPath();
        c.arc(B.x, B.y, B.R, B.a0 + (B.a1 - B.a0) * (g.dial === 'ev' ? 0.55 : 0.8), B.a1);
        c.stroke();
        c.font = "900 7px 'Nunito', system-ui, sans-serif";
        c.fillStyle = '#96a2c4';
        c.fillText(g.dial === 'ev' ? 'MOTOR' : 'BOOST', B.x, B.y - 9);
      }
      this._face = { key, cv, maxK };
      return this._face;
    }

    drawCluster(kmh, rpm, gear, unit, g) {
      const now = performance.now();
      if (now - (this._clAt || 0) < 15) return; // (60 redraws a second is plenty, on a 144 Hz screen too)
      this._clAt = now;
      const flash = Math.floor(now / 70) % 2;
      const up = g.up || 0.975, r = U.clamp(rpm, 0, 1.03);
      const win = r >= up - 0.045; // shift now (the perfect-shift window on a manual car)
      const perfect = this._pkT > 0 ? 1 : 0;
      const key = Math.round(kmh) + '|' + Math.round(r * 200) + '|' + gear + '|' + (g.sel || 0) + '|' + unit + '|' + g.dial
        + '|' + Math.round(g.v * 70) + '|' + Math.round(g.avail * 30) + '|' + (g.over ? 1 : 0) + '|' + Math.round(g.redline) + '|' + Math.round((g.nosV || 0) * 60) + '|' + (g.nosOn ? 1 : 0)
        + '|' + ((win || g.over || g.nosOn || g.hint) ? flash : 0) + '|' + Math.round((this._pkT || 0) * 20) + '|' + (g.hint || '');
      if (this._spk === key) return;
      this._spk = key;
      const k = this.k || 1;
      const face = this._clusterFace(g, k);
      const c = this.sctx;
      const D = CLU;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.el.speedo.width, this.el.speedo.height);
      c.drawImage(face.cv, 0, 0);
      c.setTransform(k, 0, 0, k, 0, 0);
      c.textAlign = 'center';
      c.textBaseline = 'alphabetic';
      const f = U.clamp((r * g.redline) / (face.maxK * 1000), 0, 1);
      const na = D.a0 + D.sw * f;
      // ---- rev arc, lit up to the needle
      const col = r >= 0.995 ? '#ff4a3d' : win ? (g.manual ? '#4db8ff' : '#ff8a5c') : r > up - 0.2 ? '#ffcc00' : '#39d6ff';
      c.lineWidth = 4;
      c.strokeStyle = col;
      c.globalAlpha = 0.85;
      c.beginPath();
      c.arc(D.cx, D.cy, D.R - 17.5, D.a0, na);
      c.stroke();
      c.globalAlpha = 1;
      // ---- needle (from the hub ring out to the ticks) with a soft glow
      const ca = Math.cos(na), sa = Math.sin(na);
      c.lineCap = 'round';
      c.globalAlpha = 0.28; // (a soft halo: a wide faint stroke - canvas shadowBlur is slow)
      c.lineWidth = 8;
      c.strokeStyle = col;
      c.beginPath();
      c.moveTo(D.cx + ca * 34, D.cy + sa * 34);
      c.lineTo(D.cx + ca * (D.R - 4), D.cy + sa * (D.R - 4));
      c.stroke();
      c.globalAlpha = 1;
      c.lineWidth = 3;
      c.strokeStyle = '#ff5a3c';
      c.stroke();
      c.lineCap = 'butt';
      // hub ring
      c.lineWidth = 2;
      c.strokeStyle = perfect ? '#4db8ff' : 'rgba(160,190,255,0.25)';
      c.beginPath();
      c.arc(D.cx, D.cy, 30, 0, Math.PI * 2);
      c.stroke();
      // ---- gear, big, in the middle (a queued shift shows as a small arrow)
      c.fillStyle = gear === -1 ? '#ff8a5c' : perfect ? '#4db8ff' : '#ffcc00';
      c.font = "46px 'Russo One', Impact, sans-serif";
      c.fillText(g.ev ? 'D' : gear === -1 ? 'R' : String(gear), D.cx, D.cy + 16);
      if (g.manual && g.sel && gear > 0 && g.sel !== gear) {
        c.font = "bold 12px 'Nunito', system-ui, sans-serif";
        c.fillStyle = '#4db8ff';
        c.fillText(g.sel > gear ? '▲' : '▼', D.cx + 24, D.cy - 6);
      }
      // ---- speed, in the dial's open bottom
      c.fillStyle = '#f5f7fc';
      c.font = "30px 'Russo One', Impact, sans-serif";
      c.fillText(String(Math.round(kmh)), D.cx, D.cy + 58);
      c.font = "bold 9px 'Nunito', system-ui, sans-serif";
      c.fillStyle = '#96a2c4';
      c.fillText(unit, D.cx, D.cy + 70);
      // ---- shift lights across the top: green, amber, red, then all blue
      // (flashing) when it's time to shift; red/white on the limiter
      const n = 10, lit = U.clamp((r - (up - 0.3)) / (0.3 - 0.045), 0, 1) * n;
      for (let i = 0; i < n; i++) {
        const x = D.cx - ((n - 1) / 2) * 12.5 + i * 12.5, y = 9;
        let fill = 'rgba(255,255,255,0.08)';
        if (r >= 0.995) fill = flash ? '#ffffff' : '#ff4a3d';
        else if (win) fill = g.manual ? (flash ? '#4db8ff' : '#1e6fd9') : '#ff4a3d';
        else if (i < lit) fill = i < 4 ? '#2fe07a' : i < 7 ? '#ffcc00' : '#ff4a3d';
        c.fillStyle = fill;
        c.beginPath();
        c.arc(x, y, 4, 0, Math.PI * 2);
        c.fill();
      }
      // ---- nitrous left in the bottle
      if (g.nos) {
        const nv = U.clamp(g.nosV == null ? 1 : g.nosV, 0, 1);
        if (nv > 0.01) {
          c.lineWidth = 4;
          c.lineCap = 'round';
          c.strokeStyle = g.nosOn ? (flash ? '#ffffff' : '#7fe0ff') : '#3b9dff';
          c.beginPath();
          c.arc(D.cx, D.cy, D.R + 13, D.n1 - (D.n1 - D.n0) * nv, D.n1);
          c.stroke();
          c.lineCap = 'butt';
        }
      }
      // ---- right-hand column: a perfect shift, or the shift key when you
      // are sitting on the limiter in a manual car
      if (perfect) {
        c.globalAlpha = U.clamp(this._pkT / 0.25, 0, 1);
        c.font = "15px 'Russo One', Impact, sans-serif";
        c.fillStyle = '#4db8ff';
        c.fillText('PERFECT', D.tx, 52);
        c.font = "900 8px 'Nunito', system-ui, sans-serif";
        c.fillText('SHIFT', D.tx, 64);
        c.globalAlpha = 1;
      } else if (g.hint) {
        c.font = "13px 'Russo One', Impact, sans-serif";
        c.fillStyle = flash ? '#ffffff' : '#4db8ff';
        c.fillText('SHIFT ▲', D.tx, 52);
        c.font = "900 8px 'Nunito', system-ui, sans-serif";
        c.fillStyle = '#96a2c4';
        c.fillText(g.hint, D.tx, 64);
      }
      if (g.box) {
        c.font = "900 7px 'Nunito', system-ui, sans-serif";
        c.fillStyle = g.manual ? '#4db8ff' : 'rgba(150,162,196,0.75)'; // (a manual car says so, in blue, all race)
        c.fillText(g.box.toUpperCase(), D.cx, D.cy + 81);
      }
      // ---- boost (or motor temperature) needle
      if (g.dial) {
        const B = D.b, ev = g.dial === 'ev';
        const val = U.clamp(g.v, 0, 1), hot = ev ? 0.55 : 0.8, bs = B.a1 - B.a0;
        // a tick where the turbo COULD be at these revs: the gap between it
        // and the lit arc is the lag you are waiting out
        c.lineWidth = 5;
        if (!ev && g.avail > 0.02) {
          const aa = B.a0 + bs * U.clamp(g.avail, 0, 1);
          c.strokeStyle = 'rgba(255,255,255,0.33)';
          c.beginPath();
          c.arc(B.x, B.y, B.R, aa - 0.05, aa + 0.05);
          c.stroke();
        }
        const bc = g.over ? '#ff4a3d' : val > hot ? '#ff8a5c' : ev ? '#7fe0ff' : '#39d6ff';
        c.strokeStyle = bc;
        c.lineCap = 'round';
        c.beginPath();
        c.arc(B.x, B.y, B.R, B.a0, B.a0 + bs * Math.max(0.004, val));
        c.stroke();
        c.lineCap = 'butt';
        const ba = B.a0 + bs * val;
        c.beginPath();
        c.arc(B.x + Math.cos(ba) * B.R, B.y + Math.sin(ba) * B.R, 3.4, 0, Math.PI * 2);
        c.fillStyle = g.over && flash ? '#ffffff' : bc;
        c.fill();
        c.font = "13px 'Russo One', Impact, sans-serif";
        c.fillStyle = val > hot ? '#ff8a5c' : '#e8eefc';
        // (boost gain is a share of engine power; +100% reads as about 1.4 bar
        //  of manifold pressure, which is the number a real gauge shows)
        c.fillText(ev ? Math.round(val * 100) + '%' : (val * (g.gain || 0) * 1.4).toFixed(2), B.x, B.y + 6);
        c.font = "900 7px 'Nunito', system-ui, sans-serif";
        c.fillStyle = g.over ? '#ff6a5c' : '#96a2c4';
        c.fillText(ev ? (g.over ? 'LIMP' : 'TEMP') : 'bar', B.x, B.y + 16);
      }
    }

    banner(text, sub, secs, cls) {
      this.el.banner.textContent = text || '';
      this.el.sub.textContent = sub || '';
      this.el.banner.className = 'banner' + (cls ? ' ' + cls : '');
      void this.el.banner.offsetWidth;
      if (text) this.el.banner.classList.add('pop');
      this.bannerT = secs || 2.5;
    }

    flash(kind) {
      const f = this.el.flash;
      f.className = 'hud-flash ' + (kind || 'hit');
      void f.offsetWidth;
      f.classList.add('on');
    }

    // view: see RaceView.build*
    update(v, dt, world) {
      const me = v.me;
      const el = this.el;
      const s = ST();
      this.lastView = v;
      this.bannerT -= dt;
      if (this.bannerT <= 0 && this.cache.bannerOn) {
        el.banner.textContent = '';
        el.sub.textContent = '';
      }
      this.cache.bannerOn = this.bannerT > 0;
      // countdown + start lights
      let cd = '';
      let lit = 0, green = false;
      if (v.phase === 'grid') {
        // Ten on the clock, the five start lights coming on one a second over
        // the last five, and all of them out for the go.
        cd = v.hold ? 'WAITING' : v.countdown > 10 ? 'READY' : String(Math.ceil(v.countdown)); // hold: a racer is still loading the track
        lit = U.clamp(Math.ceil(5 - v.countdown), 0, 5);
      } else if (v.phase === 'race' && v.raceTime < 1.2) {
        cd = 'GO!';
        green = true;
      }
      this.set('cd', el.cd, cd);
      el.cd.className = 'cd' + (cd === 'GO!' ? ' go' : cd ? ' on' : '');
      const lk = green ? 'g' : String(lit);
      if (this.cache.lights !== lk) {
        this.cache.lights = lk;
        el.lights.forEach((l, i) => (l.className = green ? 'g' : i < lit ? 'r' : ''));
        el.lightsBox.style.opacity = v.phase === 'grid' || green ? '1' : '0';
      }
      if (world) world.setStartLights(lit, green);
      const spectate = !me;
      this.set('spec', el.br, spectate ? 'none' : '', 'display');
      if (this.cache.specCls !== spectate) {
        this.cache.specCls = spectate;
        el.posN.parentElement.classList.toggle('spec', spectate);
      }
      this.set('help', el.help, v.phase === 'grid' && !spectate && s.hints ? '' : 'none', 'display');
      // v4: one heads-up on the grid if the car is worn (you can't fix it now,
      // but you should know why it feels slow)
      if (me && v.phase === 'grid' && !this._wearTold && s.hints) {
        this._wearTold = true;
        const tw = me.rs.tyreWear || 0, ew = me.rs.engineWear || 0, bw = me.rs.body || 0;
        const bits = [];
        if (tw > 0.45) bits.push(`tyres −${Math.round(32 * Math.pow(tw, 1.6))}% grip`);
        if (ew > 0.3) bits.push(`engine −${Math.round(38 * Math.pow(ew, 1.3))}% power`);
        if (bw > 0.3) bits.push('bodywork damaged');
        if (bits.length) this.banner('CAR NEEDS WORK', bits.join(' · ') + ' — repair in the garage after this race', 3.5, 'warn');
      }
      if (me) {
        // position, with a pop + arrow when it changes mid-race
        if (me.pos && this.lastPos && me.pos !== this.lastPos && v.phase === 'race' && v.raceTime > 2) {
          const up = me.pos < this.lastPos;
          el.posD.textContent = up ? '▲' : '▼';
          el.posD.className = 'pos-d ' + (up ? 'up' : 'down');
          el.posN.classList.remove('pop');
          void el.posN.offsetWidth;
          el.posN.classList.add('pop');
          this.posPopT = 1.6;
          if (G.Audio) G.Audio.overtake(up);
        }
        this.lastPos = me.pos || this.lastPos;
        this.posPopT -= dt;
        if (this.posPopT <= 0 && el.posD.textContent) el.posD.textContent = '';
        this.set('pos', el.posN, me.pos ? String(me.pos) : '-');
        this.set('posOf', el.posOf, '/' + v.total);
        const lapTxt = v.practice ? (v.format === 'circuit' ? String(Math.max(1, me.lapCount)) : 'PRACTICE')
          : v.format === 'circuit' ? Math.max(1, Math.min(me.lapCount, v.laps)) + '/' + v.laps : v.format === 'drag' ? 'DRAG' : 'SPRINT';
        this.set('lap', el.lap, lapTxt);
        // (v5.5.6: a sprint or drag race has no laps: it read "LAP SPRINT"
        // over LAST / BEST times that could only ever show dashes)
        const laps = v.format === 'circuit' || v.practice;
        this.set('lapW', el.lapW, v.format === 'circuit' ? '' : 'none', 'display');
        this.set('lastRow', el.last.parentElement, laps ? '' : 'none', 'display');
        this.set('bestRow', el.best.parentElement, laps ? '' : 'none', 'display');
        this.set('cur', el.cur, U.fmtTime(me.curMs));
        this.set('last', el.last, U.fmtTime(me.lastLap));
        this.set('best', el.best, U.fmtTime(me.bestLap));
        if (me.bestLap != null) this.bestSeen = me.bestLap;
        const rs = me.rs;
        const sp = Math.hypot(rs.vx, rs.vz);
        // v5.8: a perfect manual shift lights the cluster up for a moment
        if ((rs.pk || 0) > (this._lastPk || 0) + 0.2) this._pkT = 0.8;
        this._lastPk = rs.pk || 0;
        this._pkT = Math.max(0, (this._pkT || 0) - dt);
        const man = !!me.manual;
        if (G.Touch) G.Touch.setManual(man);
        this.drawCluster(G.Settings.speed(sp), rs.rpm || 0, rs.gear, G.Settings.unit(), {
          // v5.1 dial: boost on a turbo, motor temperature on an electric car
          dial: me.hasBoost ? 'boost' : me.ev ? 'ev' : '',
          v: me.hasBoost ? rs.boost || 0 : U.clamp(rs.heat || 0, 0, 1),
          avail: me.hasBoost ? me.boostAvail || 0 : 0,
          gain: me.boostGain || 0, redline: me.redline || 7000, ev: !!me.ev,
          over: !!rs.overheat,
          // v5.8: where this gear wants shifting, the box, nitrous, and the
          // shift key if a manual car is sitting on its limiter
          up: me.upRs ? me.upRs[U.clamp((rs.gear || 1) - 1, 0, me.upRs.length - 1)] : 0.975,
          manual: man, sel: rs.sel, box: me.boxLabel || '',
          nos: !!me.hasNos, nosV: rs.nos == null ? 1 : rs.nos, nosOn: !!rs.nosOn,
          hint: man && (rs.limT || 0) > 0.15 && rs.gear > 0 && me.upRs && rs.gear < me.upRs.length ? (ST().keys.shiftUp ? G.Settings.keyName(ST().keys.shiftUp) : 'B / D-pad ▲') : '',
        });
        this.set('heatBox', el.heatBox, me.hasBoost ? '' : 'none', 'display');
        this.set('heat', el.heat, Math.round(U.clamp(rs.heat || 0, 0, 1) * 100) + '%', 'width');
        el.heatBox.className = 'gauge heat' + (rs.overheat ? ' over' : (rs.heat || 0) > 0.8 ? ' warn' : '');
        const bt = U.clamp((rs.bt || 0) / 1.2, 0, 1);
        this.set('brk', el.brk, Math.round(bt * 100) + '%', 'width');
        el.brkBox.className = 'gauge brk' + ((rs.bt || 0) > 0.7 ? ' warn' : (rs.bt || 0) < 0.12 && me.coldBrakes ? ' cold' : '');
        // v4: nitrous bottle, slipstream strength, catch-up bonus
        this.set('nosBox', el.nosBox, 'none', 'display'); // (v5.8: nitrous is an arc round the rev dial now)
        this.set('nos', el.nos, Math.round(U.clamp(rs.nos == null ? 1 : rs.nos, 0, 1) * 100) + '%', 'width');
        el.nosBox.className = 'gauge nos' + (rs.nosOn ? ' on' : (rs.nos || 0) < 0.05 ? ' empty' : '');
        // v4.4.2: slipstream badge (top centre), blue edge glow and a whoosh
        // on catching a tow. The old meter went through set(..., 'className'),
        // which wrote el.style.className, so it never actually appeared.
        const dr = rs.draft || 0, drOn = dr > 0.12, drMax = drOn && dr > 0.7;
        const drCls = 'hud-draft' + (drOn ? ' on' : '') + (drMax ? ' max' : '');
        if (this.cache.drCls !== drCls) { this.cache.drCls = drCls; el.dr.className = drCls; }
        this.set('drW', el.drBar, Math.round(dr * 100) + '%', 'width');
        if (drOn) this.set('drV', el.drV, (drMax ? 'MAX TOW  ' : '') + '−' + Math.round(dr * 45) + '% DRAG');
        this.set('drGlow', el.drGlow, drOn ? (dr * 0.9).toFixed(2) : '0', 'opacity');
        if (dr > 0.35 && !this._drIn) { this._drIn = true; if (G.Audio) G.Audio.draftIn(); }
        else if (dr < 0.1) this._drIn = false;
        const cu = rs.cu || 0;
        this.set('cu', el.asCu, cu > 0.012 ? 'CATCH-UP +' + Math.round(cu * 100) + '%' : '');
        // v5.2 link: a slow or relayed connection is the one thing that makes
        // the other cars feel wrong however good the netcode is, so say so
        // instead of leaving the player to guess. Host/practice: no chip.
        const lk = v.link;
        const bad = lk && (lk.relay || lk.rtt > 160);
        this.set('net', el.asNet, bad ? (lk.relay ? 'RELAY ' : 'SLOW LINK ') + lk.rtt + 'ms' : '');
        const netCls = 'as-net' + (bad && lk.rtt > 320 ? ' hard' : '');
        if (el.asNet.className !== netCls) el.asNet.className = netCls;
        // v5.1 crosswind: the gust pushes you sideways, so say so, and say
        // which way. (You could feel it before but nothing told you why.)
        const gust = rs.gust || 0, gAbs = Math.abs(gust);
        this.set('wind', el.asWind, gAbs > 0.5 ? (gust > 0 ? '⟵ ' : '') + 'CROSSWIND' + (gust < 0 ? ' ⟶' : '') : '');
        if (el.asWind.className !== (gAbs > 3.5 ? 'as-wind hard' : 'as-wind')) el.asWind.className = gAbs > 3.5 ? 'as-wind hard' : 'as-wind';
        if (gAbs > 1 && !this._windTold && v.phase === 'race') {
          this._windTold = true;
          this.banner('CROSSWIND', 'Gusts across the road here — lean on the wheel', 2.4, 'warn');
        }
        // v5.4 level crossings: at chase-camera height the flashing lights are
        // only in view a few car lengths out, which at speed is too late - so
        // the HUD calls it from 170 m while they are flashing.
        const trk = this.track;
        if (trk && trk.xings && trk.xings.length && v.phase === 'race' && this.bannerT <= 0.05) {
          const q = this._xq || (this._xq = {});
          trk.query(rs.x, rs.z, this._xh == null ? -1 : this._xh, q);
          this._xh = q.i;
          for (const xg of trk.xings) {
            let ahead = xg.at - q.along;
            if (trk.closed && ahead < 0) ahead += trk.length;
            if (ahead < 4 || ahead > 170) continue;
            const o = trk.dyn.find((d) => d.k === 'train' && d.i === xg.i && !d.car);
            if (!o) continue;
            const t = v.raceTime || 0, c = t + o.off, ph = c - Math.floor(c / o.every) * o.every;
            const pass = (2 * o.span + o.cars * o.gap) / o.speed;
            if (ph < pass || ph > o.every - 2.5) {
              const m = Math.round(ahead) + ' m';
              if (o.look === 'forklift') this.banner('FORKLIFT CROSSING', 'Forklift coming out — ' + m, 0.3, 'warn');
              else if (o.look === 'tractor') this.banner('TRACTOR CROSSING', 'Tractor and trailers — ' + m, 0.3, 'warn');
              else if (o.look === 'robot') this.banner('ROBOT CROSSING', 'Delivery robots coming through — ' + m, 0.3, 'warn');
              else this.banner('LEVEL CROSSING', 'Train coming — ' + m, 0.3, 'warn');
              break;
            }
          }
        }
        // v5.7 the launch: a countdown as you come up on the blast zone
        const L = trk && trk.launch;
        if (L && v.phase === 'race' && this.bannerT <= 0.05) {
          const q = this._xq || (this._xq = {});
          trk.query(rs.x, rs.z, this._xh == null ? -1 : this._xh, q);
          let ahead = L.at - L.hl - q.along;
          if (trk.closed && ahead < -L.hl * 2) ahead += trk.length;
          const t = v.raceTime || 0, ph = (((t + L.off) % L.every) + L.every) % L.every, toGo = L.every - ph;
          if (t > 0 && ahead > -L.hl * 2 && ahead < 420) {
            if (ph < L.dur) this.banner('LIFTOFF', 'The blast is on the road by the pad', 0.3, 'warn');
            else if (toGo < 8) this.banner('ROCKET LAUNCH IN ' + Math.ceil(toGo), 'Blast wind by the pad - hold on', 0.3, 'warn');
          }
        }
        // v5.7 the tide: once per lap as you come up on a causeway that floods
        if (trk && trk.patches && trk.patches.length && v.phase === 'race' && this.bannerT <= 0.05) {
          const q = this._xq || (this._xq = {});
          trk.query(rs.x, rs.z, this._xh == null ? -1 : this._xh, q);
          const lap = me ? me.lap || 0 : 0;
          for (const pt of trk.patches) {
            if (!pt.tide) continue;
            const ahead = pt.at - pt.hl - q.along;
            if (ahead > 0 && ahead < 160 && this._tideTold !== lap) {
              this._tideTold = lap;
              this.banner('HIGH TIDE', 'Waves wash over the causeway - lift through the water', 2.2, 'warn');
              break;
            }
          }
        }
        // v5.6.1 falling concrete: once per lap as you come up on it
        if (trk && trk.dyn && trk.dyn.length && v.phase === 'race' && this.bannerT <= 0.05) {
          const q = this._xq || (this._xq = {});
          trk.query(rs.x, rs.z, this._xh == null ? -1 : this._xh, q);
          for (const o of trk.dyn) {
            if (o.look !== 'debris' || o.stream) continue;
            let ahead = o.at - o.len / 2 - q.along;
            if (trk.closed && ahead < -o.len) ahead += trk.length;
            const lap = me ? me.lap || 0 : 0;
            if (ahead > 0 && ahead < 140 && this._debTold !== o.at + ':' + lap) {
              this._debTold = o.at + ':' + lap;
              this.banner('FALLING CONCRETE', 'Watch the road for shadows', 2.2, 'warn');
              break;
            }
          }
        }
        // v5 endurance: this set of tyres (not the race-long wear) and the tank
        const endu = !!v.endu;
        this.set('tyre', el.tyre, Math.round((1 - U.clamp(endu ? rs.tw || 0 : rs.tyreWear || 0, 0, 1)) * 100) + '%', 'width');
        this.set('eng', el.eng, Math.round((1 - U.clamp(rs.engineWear || 0, 0, 1)) * 100) + '%', 'width');
        this.set('engBox', el.engBox, endu ? 'none' : '', 'display');
        this.set('fuelBox', el.fuelBox, endu ? '' : 'none', 'display');
        if (endu) {
          this.set('fuel', el.fuel, Math.round(U.clamp(rs.tank, 0, 1) * 100) + '%', 'width');
          const fc = 'gauge fuel' + (rs.tank <= 0 ? ' over' : this.pitCall ? ' call' : rs.tank < 0.15 ? ' warn' : ''); // (v5.8 call: time to pit)
          if (this.cache.fuelCls !== fc) { this.cache.fuelCls = fc; el.fuelBox.className = fc; }
          this._pitAdvice(v, me, rs);
        } else {
          this.set('pitOn', el.pit, '', 'className');
          this.pitCall = false;
        }
        if (world && world.pitCall) world.pitCall(!!this.pitCall, dt);
        this._wrongT -= dt;
        if (me.wrong && this.bannerT <= 0) {
          this.banner('WRONG WAY', 'Press ' + G.Settings.keyName(s.keys.reset) + ' to reset', 0.5, 'warn');
          if (this._wrongT <= 0 && G.Audio) {
            G.Audio.wrongWay();
            this._wrongT = 2;
          }
        }
        // speed vignette
        const vg = U.clamp((sp - 30) / 25, 0, 1) * 0.55;
        this.set('vig', el.vig, vg.toFixed(2), 'opacity');
      } else {
        this.set('pos', el.posN, '👁 LIVE');
        this.set('posOf', el.posOf, '');
        this.set('lap', el.lap, v.format === 'circuit' ? v.leaderLap + '/' + v.laps : v.format.toUpperCase());
        this.set('cur', el.cur, U.fmtTime(v.raceTime * 1000));
        this.set('vig', el.vig, '0', 'opacity');
        if (this.cache.drCls !== 'hud-draft') { this.cache.drCls = 'hud-draft'; el.dr.className = 'hud-draft'; }
        this.set('drGlow', el.drGlow, '0', 'opacity');
      }
      // standings tower
      const tower = v.order.map((c, i) => `${i + 1}|${c.name}|${c.color}|${c.finished ? 1 : 0}|${c.dnf ? 1 : 0}|${c.id === (me && me.id) ? 1 : 0}|${c.bet || ''}|${v.endu ? (c.stops || 0) + (c.pit ? 'p' : '') : ''}`).join(';');
      if (this.cache.tower !== tower) {
        this.cache.tower = tower;
        el.tower.innerHTML = v.order
          .map((c, i) => `<div class="row${me && c.id === me.id ? ' me' : ''}${c.finished ? ' fin' : ''}"><span class="p">${i + 1}</span><i style="background:#${c.color.toString(16).padStart(6, '0')}"></i><span class="n">${U.esc(c.name)}</span>${c.bet ? `<em>${U.esc(c.bet)}</em>` : ''}${v.endu ? (c.pit ? '<s class="pit">PIT</s>' : c.stops ? `<s>${c.stops}×</s>` : '') : ''}${c.finished ? `<b>${G.ic('checker')}</b>` : c.dnf ? '<b>DNF</b>' : ''}</div>`)
          .join('');
      }
      // (v5.8: the minimap at 30 fps - dots don't need more - and no fresh
      // array of fresh objects every frame)
      const nowM = performance.now();
      if (!this._mapAt || nowM - this._mapAt > 32) {
        this._mapAt = nowM;
        const mc = this._mapCars || (this._mapCars = []);
        mc.length = v.cars.length;
        for (let i = 0; i < v.cars.length; i++) {
          const c = v.cars[i], o = mc[i] || (mc[i] = {});
          o.x = c.rs.x; o.z = c.rs.z; o.h = c.rs.h; o.color = c.color; o.id = c.id;
        }
        this.drawMap(mc, me && me.id);
      }
      // progress bar (open tracks)
      if (this.track && !this.track.closed) {
        const L = this.track.raceDistance || 1;
        const dots = v.cars.map((c) => `${c.id}:${Math.round(U.clamp((c.dist || 0) / L, 0, 1) * 400)}`).join(',');
        if (this.cache.pg !== dots) {
          this.cache.pg = dots;
          el.pgDots.innerHTML = v.cars
            .map((c) => `<i class="${me && c.id === me.id ? 'me' : ''}" style="left:${(U.clamp((c.dist || 0) / L, 0, 1) * 100).toFixed(1)}%;background:#${c.color.toString(16).padStart(6, '0')}"></i>`)
            .join('');
        }
      }
      // name tags over other cars (fade with distance)
      if (world && s.tags) {
        const seen = {};
        for (const c of v.cars) {
          if (me && c.id === me.id) continue;
          seen[c.id] = 1;
          let t = this.tagEls[c.id];
          if (!t) {
            t = this.tagEls[c.id] = document.createElement('div');
            t.className = 'tag';
            el.tags.appendChild(t);
          }
          if (t._name !== c.name) {
            t._name = c.name;
            t.textContent = c.name;
            t.style.borderColor = '#' + c.color.toString(16).padStart(6, '0');
          }
          // above the car MODEL, which sits on the road's real height (hills,
          // banking). A fixed 2.4 m left tags floating off cars on Summit Pass.
          const m = world.models.get(c.id);
          const p = m ? world.project(m.root.position.x, m.root.position.y + 2.4, m.root.position.z, this._p) : world.project(c.rs.x, world.groundAt(c.rs.x, c.rs.z) + 2.4, c.rs.z, this._p);
          // v4.4.2: only touch the DOM when something visibly changed, and
          // hide tags for cars more than ~250 m away (depth 0.98). Writing
          // every tag's style every frame (with a CSS opacity transition
          // restarting each time) cost ~20% of the frame rate with 7 cars
          // round you, even on a fast PC.
          const vis = p.vis && p.depth < 0.98;
          if (t._vis !== vis) {
            t._vis = vis;
            t.style.display = vis ? '' : 'none';
          }
          if (vis) {
            const x = p.x | 0, y = p.y | 0;
            if (x !== t._x || y !== t._y) {
              t._x = x;
              t._y = y;
              t.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%,-100%)`;
            }
            const op = Math.round(U.clamp(1.35 - (p.depth - 0.94) * 12, 0.25, 1) * 20) / 20;
            if (op !== t._op) {
              t._op = op;
              t.style.opacity = op;
            }
          }
        }
        for (const id in this.tagEls) {
          if (!seen[id]) {
            this.tagEls[id].remove();
            delete this.tagEls[id];
          }
        }
      } else if (!s.tags && Object.keys(this.tagEls).length) this.clearTags();
      const dbg = this.debugOn || s.showFps;
      if (dbg && world) {
        const w = world.stats();
        el.debug.textContent = `${w.fps.toFixed(0)} fps · ${w.ms.toFixed(1)} ms · ${w.calls} calls · ${(w.tris / 1000).toFixed(0)}k tris · ${w.parts} fx · q${w.level} pr${w.pr.toFixed(2)} ${w.tier}` + (v.net ? ' · ' + v.net : '');
      }
      this.set('dbg', el.debug, dbg ? '' : 'none', 'display');
    }

    // v5 endurance: how many laps the fuel is good for, and when to box.
    // Fuel use is measured as you go (what's gone from the tank, plus what
    // the crew put in, per metre driven), like the bots' strategy (race.js).
    _pitAdvice(v, me, rs) {
      const tr = this.track, el = this.el;
      if (!tr || !tr.pit) return;
      const E = this.enduT || (this.enduT = { fuelIn: 1 });
      const d = Math.max(0, (v.cars.find((c) => c.id === me.id) || {}).dist || 0);
      const L = tr.length, total = L * v.laps;
      const used = E.fuelIn - rs.tank;
      const perM = used > 0.02 ? used / Math.max(250, d) : 1 / (total * 0.6);
      const rem = Math.max(0, total - d), need = perM * rem;
      const lapsOfFuel = rs.tank / Math.max(1e-6, perM * L);
      // (v5.8: where the car really is, for the parking guide below)
      const pq = tr.query(rs.x, rs.z, rs.hint || 0, this._pq || (this._pq = {}));
      const B = tr.pit, ahead = G.RaceEnv.pitAhead(tr, pq.along);
      const side = this._pitSide(tr), arrow = side === 'left' ? '◀' : '▶';
      const need2 = G.RaceEnv.shouldPit(rs, need, rem / L), tyres = rs.tw > 0.8 && rem > L * 1.3;
      const near = Math.abs(ahead) < B.hl + 40 && Math.hypot(rs.vx, rs.vz) < 16;
      const apron = Math.abs(pq.lat - B.lat) < B.hw + 5;
      let t = '', sub = '', cls = 'hud-pit', call = false;
      if (rs.pit) {
        t = 'IN THE PIT';
        cls += ' on';
        E.called = false;
      } else if (me.finished || v.phase !== 'race') {
        t = '';
      } else if (near && apron && (need2 || tyres || rs.tank <= 0 || Math.hypot(rs.vx, rs.vz) < 9)) {
        // v5.8 parking guide: in the box (a little past either end counts), or which way it is
        const inBox = Math.abs(ahead) <= B.hl + 6 && Math.abs(pq.lat - B.lat) <= B.hw + 2;
        t = inBox ? 'STOP HERE' : ahead > 0 ? `BOX AHEAD ▲ ${Math.round(ahead - B.hl)} m` : `BOX BEHIND ▼ ${Math.round(-ahead - B.hl)} m`;
        sub = inBox ? 'brake to a stop - you\'re in the box' : ahead > 0 ? 'keep rolling, then stop anywhere in it' : 'hold brake to reverse back into it';
        cls += inBox ? ' on good big' : ' on warn big';
        call = true;
      } else if (rs.tank <= 0) {
        t = 'OUT OF FUEL';
        sub = ahead > 0 ? `limp to the pit box · ${Math.round(ahead)} m · on the ${side}` : `limp round to the pit box (on the ${side})`;
        cls += ' on bad';
        call = true;
      } else if (need2 || tyres) {
        const close = ahead > 0 && ahead < 450;
        t = close ? `PIT ${arrow} ${Math.round(ahead)} m` : need2 ? 'BOX THIS LAP' : 'TYRES GONE';
        sub = close ? `pit box on the ${side} · stop anywhere in it` : need2 ? `fuel for ${lapsOfFuel.toFixed(1)} laps · pit box on the ${side}` : `pit for a fresh set · box on the ${side}`;
        cls += ' on warn' + (close ? ' big' : '');
        call = true;
        // the first time it's time to come in: say it big, once, with a sound
        if (!E.called) {
          E.called = true;
          this.banner(need2 ? 'BOX THIS LAP' : 'TYRES GONE', need2 ? `Fuel for ${lapsOfFuel.toFixed(1)} laps - the pit box is on the ${side}, follow the beacon` : `Pit for a fresh set - the box is on the ${side}`, 3.2, 'warn');
          if (G.Audio && G.Audio.notify) G.Audio.notify('warn');
        }
      } else if (rem > L * 0.3) {
        t = `FUEL ${lapsOfFuel >= 9.95 ? Math.round(lapsOfFuel) : lapsOfFuel.toFixed(1)} LAPS`;
        sub = rs.tank >= need ? 'enough to the flag' : `${Math.max(0, need - rs.tank).toFixed(2) * 100 | 0}% short of the flag`;
        cls += ' on quiet';
      }
      this.set('pitT', el.pitT, t);
      this.set('pitS', el.pitS, sub);
      this.set('pitOn', el.pit, cls, 'className');
      E.info = { tank: rs.tank, tw: rs.tw, need, lapsLeft: rem / L };
      this.pitCall = call; // (the fuel gauge flashes and a beacon stands over the box while it's time)
    }

    // which side of the road the pit box is on, seen driving the right way
    _pitSide(tr) {
      if (this._pitSideTr === tr) return this._pitSideV;
      const B = tr.pit, i = B.ic;
      const p0 = tr.pointAt(B.at, 0), p1 = tr.pointAt(B.at, B.lat);
      const dx = p1.x - p0.x, dz = p1.z - p0.z;
      this._pitSideTr = tr;
      return (this._pitSideV = dx * tr.TZ[i] - dz * tr.TX[i] > 0 ? 'left' : 'right');
    }

    clearTags() {
      for (const id in this.tagEls) this.tagEls[id].remove();
      this.tagEls = {};
    }
  }

  G.HUD = HUD;
})(window.G);
