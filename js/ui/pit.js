// pit.js — v5 endurance pit stop mini-game. Opens when your car stops in the
// pit box (race event pitIn) and plays in three parts:
//   1. PLAN   change tyres or not, how much fuel (3 s to decide; the crew's
//             suggestion is already picked)
//   2. FUEL   hold the button to fill, let go on the marker (every drop
//             over what you need is time sat in the box)
//   3. WHEELS if changing tyres: a needle sweeps, hit it in the green, four
//             times (a miss fumbles the wheel gun for half a second)
// Then it tells the host what the crew did (RaceSim.pitDone). The host never
// releases the car sooner than that service could really take, so how fast you
// play is how fast you get out, down to that limit.
'use strict';
(function (G) {
  const U = G.U;
  const FILL_RATE = 1 / 4.5; // tank per second (matches RaceEnv.pitTime)
  const WHEELS = ['FRONT LEFT', 'FRONT RIGHT', 'REAR LEFT', 'REAR RIGHT'];

  const Pit = {
    open: false,

    // ctx: {tank, tw, need (fuel to the flag), lapsLeft}
    start(ctx) {
      this.close();
      this.open = true;
      this.ctx = ctx;
      this.t0 = performance.now();
      const suggest = U.clamp(ctx.need * 1.12, ctx.tank, 1);
      this.plan = { tyres: ctx.tw > 0.45 ? 1 : 0, target: suggest, preset: 'flag' };
      this.stage = 'plan';
      this.stageT = 0;
      this.level = ctx.tank;
      this.spilt = 0;
      this.wheel = 0;
      this.fumble = 0;
      this.needle = 0;
      this.idleT = 0;
      this.holding = false;
      this.sent = false;
      this.result = null;
      const el = (this.el = document.createElement('div'));
      el.className = 'pitgame';
      el.innerHTML = `
        <div class="pg-head"><b>PIT STOP</b><span class="pg-clock">0.0 s</span></div>
        <div class="pg-body"></div>
        <div class="pg-foot"><button class="pg-leave" data-p="leave">Leave without service</button></div>`;
      el.addEventListener('pointerdown', (e) => this._pointer(e, true));
      el.addEventListener('pointerup', (e) => this._pointer(e, false));
      el.addEventListener('pointercancel', (e) => this._pointer(e, false));
      el.addEventListener('pointerleave', (e) => this._pointer(e, false));
      (document.getElementById('hud') || document.body).appendChild(el);
      this._key = (e) => this._keys(e);
      this._keyUp = (e) => {
        if (e.code === 'Space' || e.code === 'Enter') this._release();
      };
      window.addEventListener('keydown', this._key, true);
      window.addEventListener('keyup', this._keyUp, true);
      this._last = performance.now();
      const tick = () => {
        if (!this.open) return;
        const now = performance.now();
        this.update(Math.min(0.1, (now - this._last) / 1000));
        this._last = now;
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
      this.render();
      if (G.Audio) G.Audio.pitJack(true);
    },

    close() {
      if (!this.open) return;
      this.open = false;
      if (G.Audio) G.Audio.fuel(false);
      cancelAnimationFrame(this._raf);
      window.removeEventListener('keydown', this._key, true);
      window.removeEventListener('keyup', this._keyUp, true);
      if (this.el) this.el.remove();
      this.el = null;
    },

    // the host let the car go (race event pitOut for us)
    released(e) {
      if (!this.open) return;
      if (G.Audio) {
        G.Audio.fuel(false);
        G.Audio.pitJack(false);
      }
      this.stage = 'go';
      this.result = e;
      this.render();
      setTimeout(() => this.close(), 900);
    },

    _send(m) {
      if (this.sent) return;
      this.sent = true;
      if (G.App.mode === 'drive' && G.App.sim) G.App.sim.pitDone('me', m);
      else if (G.Client) G.Client.act(Object.assign({ t: 'pit' }, m));
    },

    _keys(e) {
      if (!this.open || e.repeat) return;
      const c = e.code;
      let used = true;
      if (this.stage === 'plan') {
        if (c === 'KeyT' || c === 'Digit1') this.plan.tyres = this.plan.tyres ? 0 : 1;
        else if (c === 'Digit2') this._preset('flag');
        else if (c === 'Digit3') this._preset('full');
        else if (c === 'Digit4') this._preset('splash');
        else if (c === 'Enter' || c === 'Space') this._confirm();
        else used = false;
      } else if (c === 'Space' || c === 'Enter') this._press();
      else if (c === 'Backspace') this._leave();
      else used = false;
      if (used) {
        e.preventDefault();
        e.stopPropagation();
        this.render();
      }
    },

    _pointer(e, down) {
      const t = e.target.closest('[data-p]');
      if (!down) return this._release();
      if (!t) return;
      e.preventDefault();
      const p = t.dataset.p;
      if (p === 'leave') return this._leave();
      if (p === 'tyres') this.plan.tyres = this.plan.tyres ? 0 : 1;
      else if (p === 'flag' || p === 'full' || p === 'splash') this._preset(p);
      else if (p === 'go') this._confirm();
      else if (p === 'act') this._press();
      this.render();
    },

    _preset(k) {
      const ctx = this.ctx;
      this.plan.preset = k;
      this.plan.target = k === 'full' ? 1 : k === 'splash' ? Math.min(1, ctx.tank + 0.25) : U.clamp(ctx.need * 1.12, ctx.tank, 1);
      if (G.Audio) G.Audio.click();
    },

    _confirm() {
      this.stage = this.plan.target > this.ctx.tank + 0.01 ? 'fuel' : this.plan.tyres ? 'wheels' : 'done';
      this.stageT = 0;
      if (G.Audio) G.Audio.click();
      if (this.stage === 'done') this._finish();
    },

    _leave() {
      this._send({ cancel: 1 });
      this.stage = 'wait';
      this.render();
    },

    // the action button (Space / tap): hold to fuel, tap to fire the wheel gun
    _press() {
      if (this.stage === 'fuel') {
        if (this.fumble > 0) return;
        this.holding = true;
        if (G.Audio) G.Audio.fuel(true);
      } else if (this.stage === 'wheels') {
        if (this.fumble > 0) return;
        const n = this.needle;
        if (Math.abs(n - 0.5) < (this.ctx.qr < 1 ? 0.17 : 0.12)) {
          this.wheel++;
          if (G.Audio) G.Audio.pitGun();
          if (this.wheel >= 4) {
            this.stage = 'done';
            this._finish();
          }
        } else {
          this.fumble = 0.5;
          this.flash = 'FUMBLE';
          if (G.Audio) G.Audio.error();
        }
      }
    },

    _release() {
      if (this.stage === 'fuel' && this.holding) {
        this.holding = false;
        this.idleT = 0;
        if (G.Audio) G.Audio.fuel(false);
      }
    },

    _endFuel() {
      this.holding = false;
      if (G.Audio) G.Audio.fuel(false);
      this.stage = this.plan.tyres ? 'wheels' : 'done';
      this.stageT = 0;
      if (this.stage === 'done') this._finish();
    },

    _finish() {
      this._send({ fuel: Math.max(0, this.level - this.ctx.tank), tyres: this.plan.tyres });
      this.stage = 'wait';
    },

    update(dt) {
      this.stageT += dt;
      if (this.fumble > 0) {
        this.fumble -= dt;
        if (this.fumble <= 0) this.flash = '';
      }
      if (this.stage === 'plan' && this.stageT > 3) this._confirm();
      else if (this.stage === 'fuel') {
        if (this.holding) {
          this.level += (FILL_RATE / (this.ctx.ck || 1)) * dt;
          if (this.level >= 1) {
            // brim-full: the nozzle clicks off
            this.level = 1;
            this.holding = false;
            this.flash = 'FULL';
            this._endFuel();
          }
        } else if (this.level > this.ctx.tank + 0.005 || this.stageT > 4) {
          // let go: a moment to top up, then the hose comes out
          this.idleT += dt;
          if (this.idleT > (this.fumble > 0 ? 1.4 : 0.6)) this._endFuel();
        }
      } else if (this.stage === 'wheels') {
        // needle sweeps 0..1..0; a little faster on every wheel
        const period = (0.95 - this.wheel * 0.08) * (this.ctx.qr < 1 ? 0.7 : 1);
        const ph = (this.stageT % period) / period;
        this.needle = ph < 0.5 ? ph * 2 : 2 - ph * 2;
      }
      this.render();
    },

    render() {
      if (!this.el) return;
      const ctx = this.ctx, p = this.plan;
      const clock = ((performance.now() - this.t0) / 1000).toFixed(1) + ' s';
      const body = this.el.querySelector('.pg-body');
      let html = '';
      if (this.stage === 'plan') {
        const left = Math.max(0, 3 - this.stageT).toFixed(1);
        const pct = (v) => Math.round(v * 100) + '%';
        html = `
          <div class="pg-title">Service plan <em>auto in ${left} s</em></div>
          <div class="pg-row">
            <button data-p="tyres" class="pg-opt${p.tyres ? ' on' : ''}"><kbd>T</kbd> Tyres<b>${p.tyres ? 'CHANGE' : 'KEEP'}</b><small>worn ${pct(U.clamp(ctx.tw, 0, 1))}</small></button>
          </div>
          <div class="pg-row pg-fuelopts">
            <button data-p="flag" class="pg-opt${p.preset === 'flag' ? ' on' : ''}"><kbd>2</kbd> To the flag<small>${pct(U.clamp(ctx.need * 1.12, ctx.tank, 1))}</small></button>
            <button data-p="full" class="pg-opt${p.preset === 'full' ? ' on' : ''}"><kbd>3</kbd> Full tank<small>100%</small></button>
            <button data-p="splash" class="pg-opt${p.preset === 'splash' ? ' on' : ''}"><kbd>4</kbd> Splash<small>+25%</small></button>
          </div>
          <button data-p="go" class="pg-go">Go <kbd>Space</kbd></button>`;
      } else if (this.stage === 'fuel') {
        const lv = this.level, tg = p.target, t0 = ctx.tank;
        const near = Math.abs(lv - tg) < 0.035;
        html = `
          <div class="pg-title">${ctx.ck > 1 ? 'Charge' : 'Fuel'} <em>hold <kbd>Space</kbd>, let go on the line</em></div>
          <div class="pg-tank">
            <i class="pg-base" style="width:${(t0 * 100).toFixed(1)}%"></i>
            <i class="pg-fill${near ? ' ok' : lv > tg + 0.035 ? ' over' : ''}" style="left:${(t0 * 100).toFixed(1)}%;width:${(Math.max(0, lv - t0) * 100).toFixed(1)}%"></i>
            <u style="left:${(tg * 100).toFixed(1)}%"></u>
          </div>
          <button data-p="act" class="pg-act${this.holding ? ' down' : ''}">${this.flash || (this.holding ? 'FILLING…' : 'HOLD TO FILL')}</button>`;
      } else if (this.stage === 'wheels') {
        const n = this.needle;
        html = `
          <div class="pg-title">Wheels <em>${WHEELS[Math.min(3, this.wheel)]} · tap <kbd>Space</kbd> in the green</em></div>
          <div class="pg-wheels">${WHEELS.map((w, i) => `<i class="${i < this.wheel ? 'done' : i === this.wheel ? 'cur' : ''}"></i>`).join('')}</div>
          <div class="pg-gun"><span class="pg-zone${ctx.qr < 1 ? ' wide' : ''}"></span><u style="left:${(n * 100).toFixed(1)}%"></u></div>
          <button data-p="act" class="pg-act${this.fumble > 0 ? ' bad' : ''}">${this.flash || 'GUN IT'}</button>`;
      } else if (this.stage === 'wait' || this.stage === 'done') {
        html = `<div class="pg-title">Crew finishing up…</div><div class="pg-big">JACK DOWN</div>`;
      } else if (this.stage === 'go') {
        const r = this.result || {};
        html = `<div class="pg-big go">GO GO GO</div><div class="pg-title"><em>${((r.ms || 0) / 1000).toFixed(1)} s stationary${r.tyres ? ' · new tyres' : ''}${r.fuel ? ' · +' + Math.round(r.fuel * 100) + '% fuel' : ''}</em></div>`;
      }
      const key = this.stage + '|' + html;
      if (this._html !== key) {
        this._html = key;
        body.innerHTML = html;
      }
      const ce = this.el.querySelector('.pg-clock');
      if (ce.textContent !== clock) ce.textContent = clock;
      const foot = this.el.querySelector('.pg-foot');
      const showLeave = this.stage === 'plan' || this.stage === 'fuel' || this.stage === 'wheels';
      if (foot._on !== showLeave) {
        foot._on = showLeave;
        foot.style.visibility = showLeave ? '' : 'hidden';
      }
    },
  };

  G.PitGame = Pit;
})(window.G);
