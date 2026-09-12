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
    'Sit behind another car to slipstream it, then pull out and slingshot past.',
    'Nitrous refills while you draft — chase a car, charge the bottle, pass it.',
    'There\'s a bounty on the money leader: finish ahead of them and it\'s yours.',
    'After a race you can go double-or-nothing on your prize. It\'s a fair coin.',
    'Summit Pass climbs 58 m — gravity slows you uphill and stretches braking downhill.',
    'Oil kills grip for a moment: lift, keep it straight, and don\'t touch the brakes.',
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
            <div class="logo">SLIP<span>STAKES</span><em class="ver" data-act="news" title="What's new">v${G.VERSION}</em></div>
            <div class="tagline">Race. Upgrade. Gamble. Regret.</div>
            <label class="fld m-name"><span>Your name</span><input data-input="name" maxlength="16" placeholder="Driver" autocomplete="off" spellcheck="false"></label>
            <div class="m-body"></div>
          </div>
          <div class="m-side"></div>
        </div>`;
      this.body = root.querySelector('.m-body');
      this.side = root.querySelector('.m-side');
      // The name field is built ONCE and never re-rendered (it used to be part
      // of the re-rendered body: every letter typed replaced the input).
      this.nameBox = root.querySelector('.m-name');
      this.nameBox.querySelector('input').value = U.store.get('ss.name', '') || '';
      // after an update, show what changed (once per version)
      if (U.store.get('ss.seenVer', null) !== G.VERSION) {
        U.store.set('ss.seenVer', G.VERSION);
        setTimeout(() => this.showNews(), 700);
      }
    },

    showNews() {
      UI.modal(`What's new in v${G.VERSION}`, `<div class="news-box">${G.newsHtml(2)}</div>`, [{ label: 'Let\'s race', value: 1, cls: 'primary' }]);
    },

    async openJoin(prefill) {
      const lc = G.Game.lastClient();
      const code = String(prefill || (lc ? lc.code : '') || '').toUpperCase().slice(0, 5);
      const r = await UI.modal(
        'Join a session',
        `<label class="fld"><span>Room code</span><input name="code" maxlength="5" autocomplete="off" value="${U.esc(code)}" style="text-transform:uppercase;letter-spacing:6px;font-size:26px;text-align:center"></label><p class="muted small">Joining as <b>${U.esc(G.App.name())}</b> — change your name on the menu first if you like. Your car choice and paint come with you.</p>`,
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

    render() {
      const me = G.Client.me;
      let h = '';
      const K = G.Settings.s.keys, kn = G.Settings.keyName;
      if (this.tab === 'home') {
        h = `
          <div class="m-grid">
            <button class="btn big primary span2" data-act="quick">🏁 Quick race <small>you vs 5 ${U.esc(({ easy: 'easy', normal: 'normal', hard: 'hard' })[G.Settings.s.botLevel] || 'normal')} bots · random track · back yourself · win garage money</small></button>
            <div class="m-qopts span2">
              <label class="fld inline"><span>Bot skill</span><select data-input="botLevel">${[['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']].map(([v, l]) => `<option value="${v}" ${v === G.Settings.s.botLevel ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
              <label class="fld inline" title="Cars behind the leader get extra power: Mild up to +10%, Wild up to +25%"><span>Catch-up</span><select data-input="catchup">${[['off', 'Off'], ['mild', 'Mild'], ['wild', 'Wild']].map(([v, l]) => `<option value="${v}" ${v === G.Settings.s.catchup ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            </div>
            ${G.App.menuButtons ? G.App.menuButtons() : ''}
            <button class="btn" data-act="practice">🛣 Free practice</button>
            <button class="btn" data-act="garage">🔧 Garage <small>parts · tuning · paint</small></button>
            <button class="btn" data-act="casino">🎰 Casino <small>practice chips</small></button>
            <button class="btn" data-act="settings">⚙ Settings</button>
            <button class="btn ghost" data-act="help">❓ How to play</button>
            <button class="btn ghost news-btn" data-act="news">✨ What's new <small>v${G.VERSION} — ${G.CHANGELOG[0].name}</small></button>
          </div>
          <div class="m-help">${kn(K.up)}/↑ throttle · ${kn(K.down)}/↓ brake & reverse · ${kn(K.left)}/${kn(K.right)} steer · ${kn(K.hb)} handbrake · ${kn(K.nitro)} nitrous · ${kn(K.reset)} reset · ${kn(K.cam)} camera · Esc menu</div>`;
      } else if (this.tab === 'practice') {
        const tracks = G.TrackDefs.TRACKS;
        const pbCar = me ? me.carId : 'vandal';
        h = `<h2>Free practice</h2><div class="trk-grid">${tracks
          .map((t) => {
            const pb = G.App.getPB(t.id, pbCar);
            return `<div class="trk ${t.id === this.track ? 'on' : ''}" data-act="pickTrack" data-id="${t.id}"><img src="${thumb(t.id)}" alt=""><div><b>${U.esc(t.name)}</b><em class="fmt fmt-${t.format}">${t.format.toUpperCase()}</em>${t.isNew ? '<em class="t-new">NEW</em>' : ''}${pb ? `<span class="pb" title="Your personal best in this car">PB ${U.fmtTime(pb)}</span>` : ''}<p>${U.esc(t.blurb)}</p></div></div>`;
          })
          .join('')}</div>
          <div class="m-row">
            <div class="m-cars">${Parts.CAR_ORDER.map((id) => `<button class="chipb ${me && me.carId === id ? 'on' : ''}" data-act="pickCar" data-id="${id}">${Parts.CARS[id].name}</button>`).join('')}</div>
            <label class="fld inline"><span>Bots</span><select data-input="bots">${[0, 1, 3, 5, 7].map((n) => `<option ${n === this.bots ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
            <label class="fld inline"><span>Bot skill</span><select data-input="botLevel">${[['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']].map(([v, l]) => `<option value="${v}" ${v === G.Settings.s.botLevel ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          </div>
          <p class="muted small">Driving your garage car with its parts, setup and paint. Wear counts (it's play money).</p>
          <div class="m-btns row"><button class="btn ghost" data-act="home">← Back</button><button class="btn big" data-act="randomTrack">🎲 Random track</button><button class="btn primary big" data-act="drive">Drive ▶</button></div>`;
      } else if (this.tab === 'help') {
        h = `<h2>How to play</h2>
          <div class="help">
            <p><b>The loop.</b> A session is a series of races. Before each one you choose: <b>RACE</b> for prize money, or <b>SIT OUT</b> and bet on the others. Between races you spend your winnings in the <b>garage</b> — or lose them in the <b>casino</b>.</p>
            <p><b>Money.</b> Every place pays, plus bonuses for places gained and the fastest lap. Fuel, tyres, engine wear and crash damage all cost money. The richest driver at the end wins.</p>
            <p><b>Parts have downsides.</b> Turbos lag and overheat, wings add drag, wide tyres aquaplane, race brakes are weak when cold. Read the red lines in the shop and the handling notes.</p>
            <p><b>Setup is free.</b> The Tuning tab changes pressures, camber, anti-roll bars, brake bias, diff lock, gearing and more — watch the preview car and the stat bars as you drag.</p>
            <p><b>Driving.</b> ${kn(K.up)} throttle, ${kn(K.down)} brake (hold when stopped to reverse), ${kn(K.left)}/${kn(K.right)} steer — tap for small corrections. ${kn(K.hb)} is the handbrake. ${kn(K.reset)} puts you back on the track. Arrow keys work too, and gamepads.</p>
            <p><b>Slipstream, nitrous, catch-up.</b> Sit a few car-lengths behind someone and the wind stops fighting you (watch the SLIPSTREAM meter), then pull out and slingshot past. With a Nitrous part, hold ${kn(K.nitro)} for a burst of power — drafting refills it. When catch-up is on, cars far behind the leader get extra power, so nobody is ever out of it.</p>
            <p><b>Hazards.</b> Oil and ice kill grip for a moment — lift and keep it straight. Mud is slow unless you're on rally tyres or in the truck. Cyan chevrons are speed pads. Barrel stacks and rocks are solid.</p>
            <p><b>Betting in the flow.</b> Racers can back themselves before a race. There's a bounty on the money leader: finish highest ahead of them and it's yours. After every race you can flip a fair coin for double-or-nothing on your prize.</p>
            <p><b>Multiplayer.</b> Open the <b>🌐 Server list</b> to find rooms from any classroom, or click <b>Host</b> to open your own. A room is <b>🔒 Private</b> (anyone with the 5-letter code walks in with <b>Join</b>; strangers on the list ask the host first and never see the code) or <b>🌐 Public</b> (anyone walks in). You can join at any time: you watch the race in progress and drive from the next one. Bots fill empty grid slots. If anyone drops, they rejoin with their car and money intact. If the <b>host</b> drops, the next driver who joined takes over and the room carries on. Press <b>T</b> to chat on any screen.</p>
          </div>
          <div class="m-btns row"><button class="btn ghost" data-act="home">← Back</button></div>`;
      }
      UI.patch(this.body, h);
      this.nameBox.style.display = this.tab === 'home' ? '' : 'none';
      // the track picker needs room: widen the card and hide the side panel
      this.body.parentElement.classList.toggle('wide', this.tab === 'practice');
      this.side.style.display = this.tab === 'practice' ? 'none' : '';
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
            <div class="m-money">Garage money <b>${U.fmtMoney(me.money)}</b></div>
            ${G.Advisor ? `<div class="m-tips">${G.Advisor.html(G.Advisor.tips(me, null, 2), true)}</div>` : ''}</div>
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
      else if (k === 'botLevel') {
        G.Settings.set('botLevel', el.value);
        UI.refresh(true);
      } else if (k === 'catchup') G.Settings.set('catchup', el.value);
    },

    acts: {
      host() {
        UI.toast('Creating a room…');
        G.Game.hostNew(G.App.name()).catch((e) => {
          G.Game.role = null;
          UI.toast('Could not host: ' + e.message, 'bad');
        });
      },
      join() {
        this.openJoin();
      },
      rooms() {
        UI.show('rooms');
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
      news() {
        this.showNews();
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
      tiptab(el) {
        G.App.openGarage(el.dataset.tab);
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
      randomTrack() {
        const ids = G.TrackDefs.TRACKS.map((t) => t.id).filter((id) => id !== this.track);
        this.track = ids[Math.floor(Math.random() * ids.length)];
        U.store.set('ss.lastTrack', this.track);
        G.App.startDrive({ trackId: this.track, bots: this.bots || 0 });
      },
    },
  };
  UI.register('menu', Menu);

  // Quick-race results: finishing order, your prize, and what next.
  const QResults = {
    mount(root, r) {
      this.r = r;
      root.innerHTML = `<div class="results"><div class="panel rs-card qr"><div class="qr-head"></div><div class="rs-table"></div><div class="qr-money"></div><div class="qr-btns"></div></div></div>`;
      const $ = (s) => root.querySelector(s);
      this.el = { head: $('.qr-head'), table: $('.rs-table'), money: $('.qr-money'), btns: $('.qr-btns') };
      if (G.Audio) r.finished && r.pos <= 3 ? G.Audio.win() : G.Audio.lose();
    },
    render() {
      const r = this.r;
      if (!r) return;
      const win = r.rows.find((x) => x.finished);
      const place = r.finished ? U.ordinal(r.pos) : 'DNF';
      const cls = !r.finished ? 'neg' : r.pos === 1 ? 'gold' : r.pos <= 3 ? 'pod' : '';
      UI.patch(this.el.head, `<div class="qr-pos ${cls}">${place}</div><div><h1>${r.pos === 1 && r.finished ? 'YOU WIN!' : r.finished && r.pos <= 3 ? 'PODIUM!' : 'RACE OVER'}</h1><div class="muted">${U.esc(r.track.name)} <em class="fmt fmt-${r.track.format}">${r.track.format.toUpperCase()}</em> · ${U.esc({ easy: 'Easy', normal: 'Normal', hard: 'Hard' }[G.Settings.s.botLevel] || 'Normal')} bots</div></div>`);
      const rows = r.rows
        .map((x) => {
          const time = !x.finished ? 'DNF' : x === win ? U.fmtTime(x.ms) : '+' + ((x.ms - win.ms) / 1000).toFixed(3) + 's';
          return `<tr class="${x.id === 'me' ? 'me' : ''}"><td class="p">${x.pos}</td><td><i style="background:${UI.colorHex(x.color)}"></i>${U.esc(x.name)}</td><td class="muted">${Parts.CARS[x.carId].name}</td><td>${time}</td><td>${U.fmtTime(x.best)}</td></tr>`;
        })
        .join('');
      UI.patch(this.el.table, `<table><tr><th>#</th><th>Driver</th><th>Car</th><th>Time</th><th>Best lap</th></tr>${rows}</table>`);
      const me = G.Client.me;
      const bet = r.bet ? `<div class="ln"><span>Backed yourself (${r.bet.type} @ ${r.bet.odds.toFixed(2)}x)</span><b class="${r.bet.won ? 'pos' : 'neg'}">${r.bet.won ? U.fmtSigned(r.bet.payout) + ' 🎉' : 'lost ' + U.fmtMoney(r.bet.stake)}</b></div>` : '';
      UI.patch(this.el.money, `<div class="box"><div class="ln"><span>Prize (${place})</span><b>${U.fmtSigned(r.prize)}</b></div><div class="ln"><span>Fuel</span><b>${U.fmtSigned(-r.fuel)}</b></div>${bet}<div class="ln tot"><span>Garage money</span><b>${me ? U.fmtMoney(me.money) : ''}</b></div></div>${r.pb ? `<div class="box"><div class="ln"><span>Your best lap here</span><b>${U.fmtTime(r.best)}</b></div><div class="ln"><span>Personal best (this car)</span><b>${U.fmtTime(r.pb)}</b></div></div>` : ''}`);
      UI.patch(this.el.btns, `<button class="btn primary big" data-act="again">↻ Race again</button><button class="btn big" data-act="next">🎲 Next track</button><button class="btn" data-act="garage">🔧 Garage</button><button class="btn ghost" data-act="menu">⌂ Menu</button>`);
    },
    acts: {
      again() { G.App.quickAgain(false); },
      next() { G.App.quickAgain(true); },
      garage() {
        G.App.endDrive(true);
        G.App.openGarage();
      },
      menu() { G.App.endDrive(); },
    },
  };
  UI.register('qresults', QResults);

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
