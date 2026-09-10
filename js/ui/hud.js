// hud.js — in-race HUD: position, laps, timers, speedo, rev bar, boost/heat
// gauges, tyre/engine health, standings tower, minimap, name tags, banners.
// Updated every frame with change-detection so we don't thrash the DOM.
'use strict';
(function (G) {
  const U = G.U;

  class HUD {
    constructor(root) {
      this.root = root;
      root.innerHTML = `
        <div class="hud-tl">
          <div class="hud-pos"><span class="pos-n">-</span><span class="pos-of">/-</span></div>
          <div class="hud-lap">LAP <b class="lap-n">-</b></div>
          <div class="hud-times">
            <div><span>TIME</span><b class="t-cur">-</b></div>
            <div><span>LAST</span><b class="t-last">-</b></div>
            <div><span>BEST</span><b class="t-best">-</b></div>
          </div>
        </div>
        <div class="hud-tower"></div>
        <canvas class="hud-map" width="200" height="200"></canvas>
        <div class="hud-br">
          <div class="speed"><b class="spd">0</b><span>km/h</span></div>
          <div class="gear">N</div>
          <div class="revbar"><i></i></div>
          <div class="gauges">
            <div class="gauge boost"><span>BOOST</span><div><i></i></div></div>
            <div class="gauge heat"><span>HEAT</span><div><i></i></div></div>
            <div class="gauge tyre"><span>TYRES</span><div><i></i></div></div>
            <div class="gauge eng"><span>ENGINE</span><div><i></i></div></div>
          </div>
        </div>
        <div class="hud-center"><div class="cd"></div><div class="banner"></div><div class="sub"></div></div>
        <div class="hud-tags"></div>
        <div class="hud-help">W/↑ throttle · S/↓ brake/reverse · A D steer · SPACE handbrake · R reset · C camera · M sound · F3 fps</div>
        <div class="hud-debug"></div>`;
      const $ = (s) => root.querySelector(s);
      this.el = {
        posN: $('.pos-n'), posOf: $('.pos-of'), lap: $('.lap-n'), cur: $('.t-cur'), last: $('.t-last'), best: $('.t-best'),
        tower: $('.hud-tower'), map: $('.hud-map'), spd: $('.spd'), gear: $('.gear'), rev: $('.revbar i'),
        boost: $('.boost i'), heat: $('.heat i'), heatBox: $('.gauge.heat'), boostBox: $('.gauge.boost'), tyre: $('.tyre i'), eng: $('.eng i'),
        cd: $('.cd'), banner: $('.banner'), sub: $('.sub'), tags: $('.hud-tags'), br: $('.hud-br'), tl: $('.hud-tl'), debug: $('.hud-debug'), help: $('.hud-help'),
      };
      this.ctx = this.el.map.getContext('2d');
      this.cache = {};
      this.tagEls = {};
      this.bannerT = 0;
      this._p = {};
      this.debugOn = false;
    }

    set(key, el, val, prop) {
      if (this.cache[key] === val) return;
      this.cache[key] = val;
      if (prop) el.style[prop] = val;
      else el.textContent = val;
    }

    show(on) {
      this.root.style.display = on ? '' : 'none';
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
      draw(9, 'rgba(0,0,0,0.55)');
      draw(5, '#e9edf5');
      const st = track.pointAt(track.startDist, 0);
      c.fillStyle = '#ffcc00';
      c.fillRect(-st.x * s + size - this.mapT.ox - 3, this.mapT.oz - st.z * s - 3, 6, 6);
      this.mapBg = off;
      this.cache = {};
    }

    mapXY(x, z) {
      return [-x * this.mapT.s + 200 - this.mapT.ox, this.mapT.oz - z * this.mapT.s];
    }

    // Drawn with world X mirrored so the minimap matches the default camera
    // (looking toward +Z, +X appears on the LEFT of the screen).
    drawMap(cars, meId) {
      const c = this.ctx;
      c.clearRect(0, 0, 200, 200);
      if (this.mapBg) c.drawImage(this.mapBg, 0, 0);
      for (const car of cars) {
        const [x, y] = this.mapXY(car.x, car.z);
        c.beginPath();
        c.arc(x, y, car.id === meId ? 6 : 4.5, 0, Math.PI * 2);
        c.fillStyle = '#' + car.color.toString(16).padStart(6, '0');
        c.fill();
        c.lineWidth = car.id === meId ? 2.5 : 1.5;
        c.strokeStyle = car.id === meId ? '#fff' : '#111';
        c.stroke();
      }
    }

    banner(text, sub, secs) {
      this.el.banner.textContent = text || '';
      this.el.sub.textContent = sub || '';
      this.el.banner.classList.remove('pop');
      void this.el.banner.offsetWidth;
      if (text) this.el.banner.classList.add('pop');
      this.bannerT = secs || 2.5;
    }

    // view: see RaceView.build*
    update(v, dt, world) {
      const me = v.me;
      const el = this.el;
      this.bannerT -= dt;
      if (this.bannerT <= 0 && this.cache.bannerOn) {
        el.banner.textContent = '';
        el.sub.textContent = '';
      }
      this.cache.bannerOn = this.bannerT > 0;
      // countdown
      let cd = '';
      if (v.phase === 'grid') cd = v.countdown > 3 ? 'READY' : String(Math.ceil(v.countdown));
      else if (v.phase === 'race' && v.raceTime < 1.2) cd = 'GO!';
      this.set('cd', el.cd, cd);
      el.cd.className = 'cd' + (cd === 'GO!' ? ' go' : cd ? ' on' : '');
      const spectate = !me;
      this.set('spec', el.br, spectate ? 'none' : '', 'display');
      if (this.cache.specCls !== spectate) {
        this.cache.specCls = spectate;
        el.posN.parentElement.classList.toggle('spec', spectate);
      }
      this.set('help', el.help, v.phase === 'grid' && !spectate ? '' : 'none', 'display');
      if (me) {
        this.set('pos', el.posN, me.pos ? String(me.pos) : '-');
        this.set('posOf', el.posOf, '/' + v.total);
        const lapTxt = v.practice ? (v.format === 'circuit' ? String(Math.max(1, me.lapCount)) : 'PRACTICE')
          : v.format === 'circuit' ? Math.max(1, Math.min(me.lapCount, v.laps)) + '/' + v.laps : v.format === 'drag' ? 'DRAG' : 'SPRINT';
        this.set('lap', el.lap, lapTxt);
        this.set('cur', el.cur, U.fmtTime(me.curMs));
        this.set('last', el.last, U.fmtTime(me.lastLap));
        this.set('best', el.best, U.fmtTime(me.bestLap));
        const rs = me.rs;
        const kmh = Math.round(Math.hypot(rs.vx, rs.vz) * 3.6);
        this.set('spd', el.spd, String(kmh));
        this.set('gear', el.gear, rs.gear === -1 ? 'R' : String(rs.gear));
        const rpm = U.clamp((rs.rpm - 0.14) / 0.86, 0, 1);
        this.set('rev', el.rev, Math.round(rpm * 100) + '%', 'width');
        el.rev.className = rpm > 0.9 ? 'hot' : '';
        this.set('boost', el.boost, Math.round((rs.boost || 0) * 100) + '%', 'width');
        this.set('boostBox', el.boostBox, me.hasBoost ? '' : 'none', 'display');
        this.set('heatBox', el.heatBox, me.hasBoost ? '' : 'none', 'display');
        this.set('heat', el.heat, Math.round(U.clamp(rs.heat || 0, 0, 1) * 100) + '%', 'width');
        el.heatBox.className = 'gauge heat' + (rs.overheat ? ' over' : (rs.heat || 0) > 0.8 ? ' warn' : '');
        this.set('tyre', el.tyre, Math.round((1 - U.clamp(rs.tyreWear || 0, 0, 1)) * 100) + '%', 'width');
        this.set('eng', el.eng, Math.round((1 - U.clamp(rs.engineWear || 0, 0, 1)) * 100) + '%', 'width');
        if (me.wrong && !this.bannerT) this.banner('WRONG WAY', 'Press R to reset', 0.5);
      } else {
        this.set('pos', el.posN, '👁 LIVE');
        this.set('posOf', el.posOf, '');
        this.set('lap', el.lap, v.format === 'circuit' ? v.leaderLap + '/' + v.laps : v.format.toUpperCase());
        this.set('cur', el.cur, U.fmtTime(v.raceTime * 1000));
      }
      // standings tower
      const tower = v.order.map((c, i) => `${i + 1}|${c.name}|${c.color}|${c.finished ? 1 : 0}|${c.dnf ? 1 : 0}|${c.id === (me && me.id) ? 1 : 0}|${c.bet || ''}`).join(';');
      if (this.cache.tower !== tower) {
        this.cache.tower = tower;
        el.tower.innerHTML = v.order
          .map((c, i) => `<div class="row${me && c.id === me.id ? ' me' : ''}${c.finished ? ' fin' : ''}"><span class="p">${i + 1}</span><i style="background:#${c.color.toString(16).padStart(6, '0')}"></i><span class="n">${U.esc(c.name)}</span>${c.bet ? `<em>${U.esc(c.bet)}</em>` : ''}${c.finished ? '<b>🏁</b>' : c.dnf ? '<b>DNF</b>' : ''}</div>`)
          .join('');
      }
      this.drawMap(v.cars.map((c) => ({ x: c.rs.x, z: c.rs.z, color: c.color, id: c.id })), me && me.id);
      // name tags over other cars
      if (world) {
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
          t.style.transform = `translate(${p.x | 0}px, ${p.y | 0}px) translate(-50%,-100%)`;
        }
        for (const id in this.tagEls) {
          if (!seen[id]) {
            this.tagEls[id].remove();
            delete this.tagEls[id];
          }
        }
      }
      if (this.debugOn && world) {
        const s = world.stats();
        el.debug.textContent = `${s.fps.toFixed(0)} fps · ${s.calls} calls · ${(s.tris / 1000).toFixed(0)}k tris · q${s.level} pr${s.pr.toFixed(2)}` + (v.net ? ' · ' + v.net : '');
      }
      this.set('dbg', el.debug, this.debugOn ? '' : 'none', 'display');
    }

    clearTags() {
      for (const id in this.tagEls) this.tagEls[id].remove();
      this.tagEls = {};
    }
  }

  G.HUD = HUD;
})(window.G);
