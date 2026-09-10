// hud.js — in-race HUD: position (animated on overtakes), laps, timers with
// lap delta, a canvas speedo/rev arc with shift light, boost/heat/brake/tyre/
// engine gauges, F1-style start lights, standings tower, heading-arrow
// minimap, race progress bar (sprints/drags), name tags, banners, speed
// vignette and hit flash. Updated every frame with change detection.
'use strict';
(function (G) {
  const U = G.U;
  const ST = () => G.Settings.s;

  class HUD {
    constructor(root) {
      this.root = root;
      root.innerHTML = `
        <div class="hud-vig"></div><div class="hud-flash"></div>
        <div class="hud-tl">
          <div class="hud-pos"><span class="pos-n">-</span><span class="pos-of">/-</span><em class="pos-d"></em></div>
          <div class="hud-lap">LAP <b class="lap-n">-</b></div>
          <div class="hud-times">
            <div><span>TIME</span><b class="t-cur">-</b></div>
            <div><span>LAST</span><b class="t-last">-</b></div>
            <div><span>BEST</span><b class="t-best">-</b></div>
          </div>
        </div>
        <div class="hud-tower"></div>
        <canvas class="hud-map" width="200" height="200"></canvas>
        <div class="hud-prog"><div class="pg-bar"></div><div class="pg-dots"></div></div>
        <div class="hud-br">
          <canvas class="speedo" width="260" height="150"></canvas>
          <div class="gauges">
            <div class="gauge boost"><span>BOOST</span><div><i></i></div></div>
            <div class="gauge heat"><span>HEAT</span><div><i></i></div></div>
            <div class="gauge brk"><span>BRAKES</span><div><i></i></div></div>
            <div class="gauge tyre"><span>TYRES</span><div><i></i></div></div>
            <div class="gauge eng"><span>ENGINE</span><div><i></i></div></div>
          </div>
        </div>
        <div class="hud-lights"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="hud-center"><div class="cd"></div><div class="banner"></div><div class="sub"></div></div>
        <div class="hud-tags"></div>
        <div class="hud-help"></div>
        <div class="hud-debug"></div>`;
      const $ = (s) => root.querySelector(s);
      this.el = {
        posN: $('.pos-n'), posOf: $('.pos-of'), posD: $('.pos-d'), lap: $('.lap-n'), cur: $('.t-cur'), last: $('.t-last'), best: $('.t-best'),
        tower: $('.hud-tower'), map: $('.hud-map'), speedo: $('.speedo'),
        boost: $('.boost i'), heat: $('.heat i'), heatBox: $('.gauge.heat'), boostBox: $('.gauge.boost'), brk: $('.brk i'), brkBox: $('.gauge.brk'), tyre: $('.tyre i'), eng: $('.eng i'),
        cd: $('.cd'), banner: $('.banner'), sub: $('.sub'), tags: $('.hud-tags'), br: $('.hud-br'), tl: $('.hud-tl'), debug: $('.hud-debug'), help: $('.hud-help'),
        lights: root.querySelectorAll('.hud-lights i'), lightsBox: $('.hud-lights'), prog: $('.hud-prog'), pgDots: $('.pg-dots'), vig: $('.hud-vig'), flash: $('.hud-flash'),
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
      this.applySettings();
    }

    applySettings() {
      const s = ST();
      this.root.style.setProperty('--hud', String(s.hudScale / 100));
      this.el.map.style.display = s.minimap ? '' : 'none';
      this.el.tags.style.display = s.tags ? '' : 'none';
      const K = s.keys, n = G.Settings.keyName;
      this.el.help.textContent = `${n(K.up)}/↑ throttle · ${n(K.down)}/↓ brake/reverse · ${n(K.left)} ${n(K.right)} steer · ${n(K.hb)} handbrake · ${n(K.reset)} reset · ${n(K.cam)} camera · Esc menu`;
      this.cache = {};
    }

    set(key, el, val, prop) {
      if (this.cache[key] === val) return;
      this.cache[key] = val;
      if (prop) el.style[prop] = val;
      else el.textContent = val;
    }

    show(on) {
      this.root.style.display = on ? '' : 'none';
      document.body.classList.toggle('racing', !!on);
    }

    setTrack(track) {
      this.track = track;
      // Pre-render the track outline into an offscreen canvas.
      const b = track.bounds;
      const size = 200, pad = 14;
      const s = Math.min((size - pad * 2) / (b.x1 - b.x0 || 1), (size - pad * 2) / (b.z1 - b.z0 || 1));
      this.mapT = { s, ox: size / 2 - b.cx * s, oz: size / 2 + b.cz * s };
      const off = document.createElement('canvas');
      off.width = off.height = size;
      const c = off.getContext('2d');
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
      c.clearRect(0, 0, 200, 200);
      if (this.mapBg) c.drawImage(this.mapBg, 0, 0);
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

    // Speedo: rev arc with a red zone, shift light, big speed, gear box.
    drawSpeedo(kmh, rpm, gear, unit) {
      const k = Math.round(kmh) + '|' + Math.round(rpm * 200) + '|' + gear + '|' + unit;
      if (this._spk === k) return;
      this._spk = k;
      const c = this.sctx, W = 260, H = 150;
      c.clearRect(0, 0, W, H);
      const cx = 118, cy = 128, R = 104;
      const a0 = Math.PI * 1.02, a1 = Math.PI * 1.98;
      c.lineCap = 'round';
      c.lineWidth = 12;
      c.strokeStyle = 'rgba(255,255,255,0.1)';
      c.beginPath();
      c.arc(cx, cy, R, a0, a1);
      c.stroke();
      const red = a0 + (a1 - a0) * 0.86;
      c.strokeStyle = 'rgba(255,74,61,0.35)';
      c.beginPath();
      c.arc(cx, cy, R, red, a1);
      c.stroke();
      const v = U.clamp(rpm, 0, 1);
      const grad = c.createLinearGradient(cx - R, 0, cx + R, 0);
      grad.addColorStop(0, '#2fe07a');
      grad.addColorStop(0.7, '#ffcc00');
      grad.addColorStop(1, '#ff4a3d');
      c.strokeStyle = grad;
      c.beginPath();
      c.arc(cx, cy, R, a0, a0 + (a1 - a0) * Math.max(0.01, v));
      c.stroke();
      // ticks
      c.lineWidth = 2;
      c.strokeStyle = 'rgba(255,255,255,0.45)';
      for (let i = 0; i <= 10; i++) {
        const a = a0 + ((a1 - a0) * i) / 10;
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * (R - 12), cy + Math.sin(a) * (R - 12));
        c.lineTo(cx + Math.cos(a) * (R - 20), cy + Math.sin(a) * (R - 20));
        c.stroke();
      }
      // shift light
      if (v > 0.9 && gear > 0) {
        c.fillStyle = Math.floor(performance.now() / 70) % 2 ? '#ff4a3d' : '#ffcc00';
        c.beginPath();
        c.arc(cx, cy - R + 26, 7, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = '#f5f7fc';
      c.textAlign = 'center';
      c.font = "58px 'Russo One', Impact, sans-serif";
      c.fillText(String(Math.round(kmh)), cx, cy - 22);
      c.font = "bold 14px 'Nunito', sans-serif";
      c.fillStyle = '#96a2c4';
      c.fillText(unit, cx, cy - 4);
      // gear box
      c.fillStyle = '#ffcc00';
      const gx = 212, gy = 64;
      c.beginPath();
      if (c.roundRect) c.roundRect(gx, gy, 44, 48, 10);
      else c.rect(gx, gy, 44, 48);
      c.fill();
      c.fillStyle = '#1a1300';
      c.font = "32px 'Russo One', Impact, sans-serif";
      c.fillText(gear === -1 ? 'R' : String(gear), gx + 22, gy + 37);
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
        cd = v.countdown > 3 ? 'READY' : String(Math.ceil(v.countdown));
        lit = U.clamp(Math.ceil((3 - v.countdown) / 0.6), 0, 5);
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
        this.set('cur', el.cur, U.fmtTime(me.curMs));
        this.set('last', el.last, U.fmtTime(me.lastLap));
        this.set('best', el.best, U.fmtTime(me.bestLap));
        if (me.bestLap != null) this.bestSeen = me.bestLap;
        const rs = me.rs;
        const sp = Math.hypot(rs.vx, rs.vz);
        this.drawSpeedo(G.Settings.speed(sp), U.clamp((rs.rpm - 0.14) / 0.86, 0, 1), rs.gear, G.Settings.unit());
        this.set('boost', el.boost, Math.round((rs.boost || 0) * 100) + '%', 'width');
        this.set('boostBox', el.boostBox, me.hasBoost ? '' : 'none', 'display');
        this.set('heatBox', el.heatBox, me.hasBoost ? '' : 'none', 'display');
        this.set('heat', el.heat, Math.round(U.clamp(rs.heat || 0, 0, 1) * 100) + '%', 'width');
        el.heatBox.className = 'gauge heat' + (rs.overheat ? ' over' : (rs.heat || 0) > 0.8 ? ' warn' : '');
        const bt = U.clamp((rs.bt || 0) / 1.2, 0, 1);
        this.set('brk', el.brk, Math.round(bt * 100) + '%', 'width');
        el.brkBox.className = 'gauge brk' + ((rs.bt || 0) > 0.7 ? ' warn' : (rs.bt || 0) < 0.12 && me.coldBrakes ? ' cold' : '');
        this.set('tyre', el.tyre, Math.round((1 - U.clamp(rs.tyreWear || 0, 0, 1)) * 100) + '%', 'width');
        this.set('eng', el.eng, Math.round((1 - U.clamp(rs.engineWear || 0, 0, 1)) * 100) + '%', 'width');
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
      }
      // standings tower
      const tower = v.order.map((c, i) => `${i + 1}|${c.name}|${c.color}|${c.finished ? 1 : 0}|${c.dnf ? 1 : 0}|${c.id === (me && me.id) ? 1 : 0}|${c.bet || ''}`).join(';');
      if (this.cache.tower !== tower) {
        this.cache.tower = tower;
        el.tower.innerHTML = v.order
          .map((c, i) => `<div class="row${me && c.id === me.id ? ' me' : ''}${c.finished ? ' fin' : ''}"><span class="p">${i + 1}</span><i style="background:#${c.color.toString(16).padStart(6, '0')}"></i><span class="n">${U.esc(c.name)}</span>${c.bet ? `<em>${U.esc(c.bet)}</em>` : ''}${c.finished ? '<b>🏁</b>' : c.dnf ? '<b>DNF</b>' : ''}</div>`)
          .join('');
      }
      this.drawMap(v.cars.map((c) => ({ x: c.rs.x, z: c.rs.z, h: c.rs.h, color: c.color, id: c.id })), me && me.id);
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
          const p = world.project(c.rs.x, 2.4, c.rs.z, this._p);
          t.style.display = p.vis ? '' : 'none';
          if (p.vis) {
            t.style.transform = `translate(${p.x | 0}px, ${p.y | 0}px) translate(-50%,-100%)`;
            const op = U.clamp(1.35 - (p.depth - 0.94) * 12, 0.25, 1);
            t.style.opacity = op.toFixed(2);
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

    clearTags() {
      for (const id in this.tagEls) this.tagEls[id].remove();
      this.tagEls = {};
    }
  }

  G.HUD = HUD;
})(window.G);
