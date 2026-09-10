// menu.js — title screen (quick race, host / join, practice, garage, casino,
// settings, how to play), the track picker with map thumbnails, and the thin
// bar shown while driving practice / test drives.
'use strict';
(function (G) {
  const U = G.U, UI = G.UI, Parts = G.Parts;
  const hex = (c) => UI.colorHex(c);

  // Track outline thumbnails (drawn once, cached as data URLs). X is mirrored
  // to match the in-race minimap / default camera.
  const thumbs = {};
  function thumb(id) {
    if (thumbs[id]) return thumbs[id];
    const tr = G.getTrack(id);
    const W = 150, H = 92, pad = 9;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const c = cv.getContext('2d');
    const b = tr.bounds;
    const s = Math.min((W - pad * 2) / (b.x1 - b.x0 || 1), (H - pad * 2) / (b.z1 - b.z0 || 1));
    const X = (x) => W / 2 - (x - b.cx) * s, Y = (z) => H / 2 - (z - b.cz) * s;
    c.lineJoin = 'round';
    c.lineCap = 'round';
    const path = () => {
      c.beginPath();
      for (let i = 0; i < tr.N; i += 2) i ? c.lineTo(X(tr.X[i]), Y(tr.Z[i])) : c.moveTo(X(tr.X[i]), Y(tr.Z[i]));
      if (tr.closed) c.closePath();
    };
    path();
    c.strokeStyle = 'rgba(0,0,0,.55)';
    c.lineWidth = 7;
    c.stroke();
    path();
    c.strokeStyle = '#e9edf5';
    c.lineWidth = 3.5;
    c.stroke();
    for (let i = 0; i < tr.N - 2; i += 2) {
      const sf = G.SURF[tr.S[i]];
      if (!sf.loose && !sf.wet) continue;
      c.beginPath();
      c.moveTo(X(tr.X[i]), Y(tr.Z[i]));
      c.lineTo(X(tr.X[i + 2]), Y(tr.Z[i + 2]));
      c.strokeStyle = sf.wet ? '#7fb2ff' : '#d9a066';
      c.lineWidth = 3.5;
      c.stroke();
    }
    const st = tr.pointAt(tr.startDist, 0);
    c.fillStyle = '#ffcc00';
    c.fillRect(X(st.x) - 3, Y(st.z) - 3, 6, 6);
    return (thumbs[id] = cv.toDataURL());
  }

  const TIPS = [
    'Tap the steering keys for small corrections — holding gives full lock.',
    'SPACE (handbrake) swings the rear out for tight hairpins.',
    'Wide tyres are fast in the dry and awful in the wet. Check the next track.',
    'Big turbos overheat on long straights. Cooling packs fix that — for a price.',
    'Race brake pads are weak when cold: brake early into the first corner.',
    'The richest driver starts at the back. Pick your fights.',
    'Sit a race out and bet on it — the odds use each car\'s stats on THAT track.',
    'The casino always wins in the long run. Racing pays better.',
    'Setups are free: soften the rear anti-roll bar if the car is too loose.',
    'Press Esc any time for the menu, settings and controls.',
  ];

  const Menu = {
    mount(root, arg) {
      this.tab = (arg && arg.tab) || 'home';
      this.track = U.store.get('ss.lastTrack', 'harbour');
      this.bots = this.bots == null ? 3 : this.bots;
      this.tip = Math.floor(Math.random() * TIPS.length);
      root.innerHTML = `
        <div class="menu">
          <div class="m-card">
            <div class="logo">SLIP<span>STAKES</span></div>
            <div class="tagline">Race. Upgrade. Gamble. Regret.</div>
            <div class="m-body"></div>
          </div>
          <div class="m-side"></div>
        </div>`;
      this.body = root.querySelector('.m-body');
      this.side = root.querySelector('.m-side');
    },

    render() {
      const me = G.Client.me;
      let h = '';
      const K = G.Settings.s.keys, kn = G.Settings.keyName;
      if (this.tab === 'home') {
        h = `
          <label class="fld"><span>Your name</span><input data-input="name" maxlength="16" value="${U.esc(me ? me.name : '')}" placeholder="Driver"></label>
          <div class="m-grid">
            <button class="btn big primary span2" data-act="quick">🏁 Quick race <small>you vs 5 bots on a random track</small></button>
            ${G.App.menuButtons ? G.App.menuButtons() : ''}
            <button class="btn" data-act="practice">🛣 Free practice</button>
            <button class="btn" data-act="garage">🔧 Garage <small>parts · tuning · paint</small></button>
            <button class="btn" data-act="casino">🎰 Casino <small>practice chips</small></button>
            <button class="btn" data-act="settings">⚙ Settings</button>
            <button class="btn ghost span2" data-act="help">❓ How to play</button>
          </div>
          <div class="m-help">${kn(K.up)}/↑ throttle · ${kn(K.down)}/↓ brake & reverse · ${kn(K.left)}/${kn(K.right)} steer · ${kn(K.hb)} handbrake · ${kn(K.reset)} reset · ${kn(K.cam)} camera · Esc menu</div>`;
      } else if (this.tab === 'practice') {
        const tracks = G.TrackDefs.TRACKS;
        h = `<h2>Free practice</h2><div class="trk-grid">${tracks
          .map((t) => `<div class="trk ${t.id === this.track ? 'on' : ''}" data-act="pickTrack" data-id="${t.id}"><img src="${thumb(t.id)}" alt=""><div><b>${U.esc(t.name)}</b><em class="fmt fmt-${t.format}">${t.format.toUpperCase()}</em><p>${U.esc(t.blurb)}</p></div></div>`)
          .join('')}</div>
          <div class="m-row">
            <div class="m-cars">${Parts.CAR_ORDER.map((id) => `<button class="chipb ${me && me.carId === id ? 'on' : ''}" data-act="pickCar" data-id="${id}">${Parts.CARS[id].name}</button>`).join('')}</div>
            <label class="fld inline"><span>Bots</span><select data-input="bots">${[0, 1, 3, 5, 7].map((n) => `<option ${n === this.bots ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          </div>
          <p class="muted small">Driving your garage car with its parts, setup and paint. Wear counts (it's play money).</p>
          <div class="m-btns row"><button class="btn ghost" data-act="home">← Back</button><button class="btn primary big" data-act="drive">Drive ▶</button></div>`;
      } else if (this.tab === 'help') {
        h = `<h2>How to play</h2>
          <div class="help">
            <p><b>The loop.</b> A session is a series of races. Before each one you choose: <b>RACE</b> for prize money, or <b>SIT OUT</b> and bet on the others. Between races you spend your winnings in the <b>garage</b> — or lose them in the <b>casino</b>.</p>
            <p><b>Money.</b> Every place pays, plus bonuses for places gained and the fastest lap. Fuel, tyres, engine wear and crash damage all cost money. The richest driver at the end wins.</p>
            <p><b>Parts have downsides.</b> Turbos lag and overheat, wings add drag, wide tyres aquaplane, race brakes are weak when cold. Read the red lines in the shop and the handling notes.</p>
            <p><b>Setup is free.</b> The Tuning tab changes pressures, camber, anti-roll bars, brake bias, diff lock, gearing and more — watch the preview car and the stat bars as you drag.</p>
            <p><b>Driving.</b> ${kn(K.up)} throttle, ${kn(K.down)} brake (hold when stopped to reverse), ${kn(K.left)}/${kn(K.right)} steer — tap for small corrections. ${kn(K.hb)} is the handbrake. ${kn(K.reset)} puts you back on the track. Arrow keys work too, and gamepads.</p>
            <p><b>Multiplayer.</b> One person clicks <b>Host</b> and reads out the 5-letter code; up to 7 friends click <b>Join</b>. Bots fill empty grid slots. If anyone drops, they can rejoin with their car and money intact.</p>
          </div>
          <div class="m-btns row"><button class="btn ghost" data-act="home">← Back</button></div>`;
      }
      UI.patch(this.body, h);
      // side card: your car + a tip
      if (me) {
        const c = Parts.CARS[me.carId];
        const L = me.garage.look || {};
        const paint = L.paint != null ? L.paint : me.color;
        const up = Parts.SLOTS.filter((s) => me.garage.installed[s.id] !== s.options[0].id).map((s) => Parts.opt(s.id, me.garage.installed[s.id]).name);
        UI.patch(
          this.side,
          `<div class="m-carcard"><span>YOUR CAR</span><b><i style="background:${hex(paint)}"></i>${U.esc(c.name)}</b><em>${U.esc(c.tag)}</em>
            <p>${up.length ? up.slice(0, 5).map(U.esc).join(' · ') + (up.length > 5 ? ` +${up.length - 5}` : '') : 'Stock — visit the garage.'}</p>
            <div class="m-cc-btns"><button class="btn small" data-act="car">🚗 Change car</button><button class="btn small ghost" data-act="paint">🎨 Paint</button></div>
            <div class="m-money">Garage money <b>${U.fmtMoney(me.money)}</b></div></div>
           <div class="m-tip"><span>TIP</span>${U.esc(TIPS[this.tip])}</div>`
        );
      }
    },

    update(dt) {
      this._tipT = (this._tipT || 0) + dt;
      if (this._tipT > 9) {
        this._tipT = 0;
        this.tip = (this.tip + 1) % TIPS.length;
        UI.refresh();
      }
    },

    input(k, el) {
      if (k === 'name') {
        const v = el.value.trim().slice(0, 16);
        U.store.set('ss.name', v);
        if (G.App.setName) G.App.setName(v);
      } else if (k === 'bots') this.bots = +el.value;
    },

    acts: {
      host() {
        UI.toast('Creating a room…');
        G.Game.hostNew(G.App.name()).catch((e) => {
          G.Game.role = null;
          UI.toast('Could not host: ' + e.message, 'bad');
        });
      },
      async join() {
        const r = await UI.modal(
          'Join a session',
          `<label class="fld"><span>Room code</span><input name="code" maxlength="5" autocomplete="off" style="text-transform:uppercase;letter-spacing:6px;font-size:26px;text-align:center"></label><p class="muted small">Joining as <b>${U.esc(G.App.name())}</b> — change your name on the menu first if you like. Your car choice and paint come with you.</p>`,
          [{ label: 'Cancel', value: 0, cls: 'ghost' }, { label: 'Join', value: 1, cls: 'primary' }]
        );
        if (!r.value) return;
        UI.toast('Connecting…');
        try {
          await G.Game.join(r.inputs.code, G.App.name());
        } catch (e) {
          G.Game.role = null;
          UI.toast(e.message, 'bad');
        }
      },
      resume() {
        G.Game.resume().catch((e) => {
          G.Game.role = null;
          UI.toast('Could not resume: ' + e.message, 'bad');
        });
      },
      async rejoin() {
        const lc = G.Game.lastClient();
        if (!lc) return;
        UI.toast('Reconnecting to ' + lc.code + '…');
        try {
          await G.Game.join(lc.code, lc.name || G.App.name(), lc.token);
        } catch (e) {
          G.Game.role = null;
          UI.toast(e.message, 'bad');
        }
      },
      quick() {
        G.App.quickRace();
      },
      home() {
        this.tab = 'home';
        UI.refresh(true);
      },
      practice() {
        this.tab = 'practice';
        UI.refresh(true);
      },
      help() {
        this.tab = 'help';
        UI.refresh(true);
      },
      settings() {
        G.Overlay.show('settings', 'graphics');
      },
      garage() {
        G.App.openGarage();
      },
      casino() {
        G.App.openCasino();
      },
      car() {
        G.App.openGarage('car');
      },
      paint() {
        G.App.openGarage('paint');
      },
      pickTrack(el) {
        this.track = el.dataset.id;
        U.store.set('ss.lastTrack', this.track);
        UI.refresh(true);
      },
      pickCar(el) {
        G.Client.act({ t: 'setCar', carId: el.dataset.id });
      },
      drive() {
        G.App.startDrive({ trackId: this.track, bots: this.bots || 0 });
      },
    },
  };
  UI.register('menu', Menu);

  // Thin overlay while driving practice / test drives.
  const DriveBar = {
    mount(root, arg) {
      this.arg = arg || {};
      root.innerHTML = `<div class="drivebar"><span class="db-l"></span><button class="btn small ghost" data-act="menu">☰ Esc — menu</button></div>`;
      this.l = root.querySelector('.db-l');
    },
    render() {},
    update() {
      const d = G.App.driveInfo ? G.App.driveInfo() : null;
      UI.patch(this.l, d ? d : '');
    },
    acts: {
      menu() {
        G.Overlay.show('pause');
      },
    },
  };
  UI.register('drivebar', DriveBar);
})(window.G);
