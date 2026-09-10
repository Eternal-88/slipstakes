// menu.js — title screen, free-practice picker, settings, and the small
// in-drive overlay bar. (Host / Join are added by the multiplayer layer.)
'use strict';
(function (G) {
  const U = G.U, UI = G.UI;

  const Menu = {
    mount(root, arg) {
      this.tab = (arg && arg.tab) || 'home';
      this.track = U.store.get('ss.lastTrack', 'harbour');
      root.innerHTML = `
        <div class="menu">
          <div class="m-card">
            <div class="logo">SLIP<span>STAKES</span></div>
            <div class="tagline">Race. Upgrade. Gamble. Regret.</div>
            <div class="m-body"></div>
          </div>
        </div>`;
      this.body = root.querySelector('.m-body');
    },

    render() {
      const me = G.Client.me;
      let h = '';
      if (this.tab === 'home') {
        h = `
          <label class="fld"><span>Your name</span><input data-input="name" maxlength="16" value="${U.esc(me ? me.name : '')}" placeholder="Driver"></label>
          <div class="m-btns">
            ${G.App.menuButtons ? G.App.menuButtons() : ''}
            <button class="btn big" data-act="practice">Free practice</button>
            <button class="btn big ghost" data-act="garage">Garage sandbox <small>$25k to play with</small></button>
            <button class="btn ghost" data-act="settings">Settings</button>
          </div>
          <div class="m-help">W/↑ throttle · S/↓ brake & reverse · A/D steer · SPACE handbrake · R reset · C camera</div>`;
      } else if (this.tab === 'practice') {
        const tracks = G.TrackDefs.TRACKS;
        h = `<h2>Free practice</h2><div class="trk-grid">${tracks
          .map((t) => `<div class="trk ${t.id === this.track ? 'on' : ''}" data-act="pickTrack" data-id="${t.id}"><b>${U.esc(t.name)}</b><em class="fmt fmt-${t.format}">${t.format.toUpperCase()}</em><p>${U.esc(t.blurb)}</p></div>`)
          .join('')}</div>
          <div class="m-row">
            <label class="fld inline"><span>Bots</span><select data-input="bots">${[0, 1, 3, 5, 7].map((n) => `<option ${n === (this.bots || 0) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
            <span class="muted">Driving your garage car${me ? ': <b>' + U.esc(G.Parts.CARS[me.carId].name) + '</b>' : ''}. Wear counts.</span>
          </div>
          <div class="m-btns row"><button class="btn ghost" data-act="home">Back</button><button class="btn primary big" data-act="drive">Drive</button></div>`;
      } else if (this.tab === 'settings') {
        const q = U.store.get('ss.quality', 'auto');
        const snd = U.store.get('ss.sound', false);
        h = `<h2>Settings</h2>
          <label class="fld"><span>Graphics quality</span><select data-input="quality">${['auto', 'high', 'medium', 'low']
            .map((o) => `<option value="${o}" ${o === q ? 'selected' : ''}>${o}${o === 'auto' ? ' (adapts to hold 60 fps)' : ''}</option>`)
            .join('')}</select></label>
          <label class="fld"><span>Sound</span><select data-input="sound"><option value="0" ${!snd ? 'selected' : ''}>Off</option><option value="1" ${snd ? 'selected' : ''}>On</option></select></label>
          <p class="muted small">Quality changes to antialiasing apply after a reload. Press F3 in-race for an FPS counter.</p>
          <div class="m-btns row"><button class="btn ghost" data-act="home">Back</button></div>`;
      }
      UI.patch(this.body, h);
    },

    input(k, el) {
      if (k === 'name') {
        const v = el.value.trim().slice(0, 16);
        U.store.set('ss.name', v);
        if (G.App.setName) G.App.setName(v);
      } else if (k === 'bots') this.bots = +el.value;
      else if (k === 'quality') U.store.set('ss.quality', el.value);
      else if (k === 'sound') {
        U.store.set('ss.sound', el.value === '1');
        if (G.Audio) G.Audio.setEnabled(el.value === '1');
      }
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
          `<label class="fld"><span>Room code</span><input name="code" maxlength="5" autocomplete="off" style="text-transform:uppercase;letter-spacing:6px;font-size:26px;text-align:center"></label><p class="muted small">Joining as <b>${U.esc(G.App.name())}</b> — change your name on the menu first if you like.</p>`,
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
      home() { this.tab = 'home'; UI.refresh(true); },
      practice() { this.tab = 'practice'; UI.refresh(true); },
      settings() { this.tab = 'settings'; UI.refresh(true); },
      garage() { G.App.openGarage(); },
      pickTrack(el) {
        this.track = el.dataset.id;
        U.store.set('ss.lastTrack', this.track);
        UI.refresh(true);
      },
      drive() { G.App.startDrive({ trackId: this.track, bots: this.bots || 0 }); },
    },
  };
  UI.register('menu', Menu);

  // Thin overlay while driving practice / test drives.
  const DriveBar = {
    mount(root, arg) {
      this.arg = arg || {};
      root.innerHTML = `<div class="drivebar"><span class="db-l"></span><button class="btn small ghost" data-act="leave">Esc — leave</button></div>`;
      this.l = root.querySelector('.db-l');
    },
    render() {},
    update() {
      const d = G.App.driveInfo ? G.App.driveInfo() : null;
      UI.patch(this.l, d ? d : '');
    },
    acts: {
      leave() { G.App.endDrive(); },
    },
  };
  UI.register('drivebar', DriveBar);
})(window.G);
