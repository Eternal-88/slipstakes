// online.js — who is playing SLIPSTAKES right now, anywhere, and direct
// messages between them (v5.5.3).
//
// There is no game server, so this rides on the public MQTT brokers the
// backup relay already uses (relay.js). Every open game keeps one small
// retained "online card" under NS+'p/'+its id: name, what it's doing, and the
// code of its room if that room is PUBLIC (a private room's code never goes
// out). The card carries a Last Will, so the broker wipes it the moment the
// tab goes, and it is refreshed every 25 s so a stale one ages out anyway.
//
// Direct messages go to NS+'dm/'+the recipient's id, end-to-end encrypted:
// each tab makes an ECDH key pair when it opens and puts the public half on
// its card; the AES key between two players is ECDH of one's private key and
// the other's public key. Only the recipient can read a message, and it can
// only have come from the card that claims to have sent it (anyone else's
// ciphertext won't open). Nothing is stored: messages, blocks and the id all
// go when the tab closes (every visit is a fresh session).
//
// v5.5.6: no opt-outs any more (everyone is listed and can be messaged);
// blocking is how you stop someone. A block tells them, sealed like any
// message ({b: 1}, and {b: 0} on unblock), so they know to stop; if they
// write again anyway (a reload forgets it) they are told again, at most once
// a minute. Older games ignore it (no text in it).
'use strict';
(function (G) {
  const U = G.U;
  const NS = 'slipstakes/online/v1/';
  const REFRESH = 25000; // re-publish our card this often
  const LIVE_TTL = 75000; // a card we've seen refreshed is good for this long
  const RETAINED_TTL = 110000; // ...one that was waiting on the broker, by its own clock
  const MAX_LEN = 200;
  const okId = (v) => typeof v === 'string' && /^[a-z0-9]{10,24}$/i.test(v);
  const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const parse = (s) => {
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  };
  const STATUS = {
    menu: 'On the menu', garage: 'In the garage', solo: 'Racing solo', casino: 'At the casino',
    lobby: 'In a lobby', race: 'Racing', room: 'In a room', private: 'In a private room',
  };

  const Online = {
    cards: new Map(), // id -> {info, seen, live}
    convos: new Map(), // id -> {name, msgs: [{me, text, at}], unread}
    blocked: new Map(), // id -> name: I blocked them (listed at the bottom, with Unblock)
    blockedBy: new Set(), // they blocked me: my box to them is shut
    ms: [],
    open: false,
    view: null, // null = the list, else the id of the conversation on screen

    init() {
      if (!G.Relay || !window.crypto || !crypto.subtle) return;
      // (per tab: a reload keeps the same id, a new tab is a new driver)
      try {
        this.id = sessionStorage.getItem('ss.oid');
      } catch (e) {}
      if (!okId(this.id)) {
        this.id = U.uid(16).replace(/[^a-z0-9]/gi, 'x');
        try {
          sessionStorage.setItem('ss.oid', this.id);
        } catch (e) {}
      }
      this._build();
      // a moment after load, so it never competes with the first screen
      setTimeout(() => this.start(), 1500);
      setInterval(() => this._tick(), 3000);
    },

    async start() {
      if (this.started) return;
      this.started = true;
      try {
        this.keys = await G.Relay.DM.keyPair();
        this.pub = await G.Relay.DM.exportPub(this.keys.publicKey);
      } catch (e) {
        this.keys = null; // no crypto: we can see who's online, but no messages
      }
      this.akeys = new Map(); // other id -> AES key (derived once)
      this.seenMsg = new Set();
      for (const b of G.Relay.BROKERS) this._connect(b);
    },

    _connect(b) {
      const m = new G.Relay.Mqtt(Object.assign({}, b, { will: { topic: NS + 'p/' + this.id, payload: '', retain: true } }));
      m.connect(7000)
        .then(() => {
          this.ms.push(m);
          const subAt = performance.now();
          m.subscribe(NS + 'p/+');
          m.subscribe(NS + 'dm/' + this.id);
          m.on('msg', (t, s) => this._in(t, s, performance.now() - subAt > 1500));
          m.on('close', () => {
            this.ms = this.ms.filter((x) => x !== m);
            setTimeout(() => this._connect(b), 30000); // try that broker again later
          });
          this._publish(true, m);
        })
        .catch(() => setTimeout(() => this._connect(b), 60000));
    },

    // What we're doing right now, for our card
    status() {
      const A = G.App, Gm = G.Game, st = G.Client && G.Client.state;
      if (Gm && Gm.role && st) {
        const pub = st.settings && st.settings.vis === 'public';
        const ph = st.phase === 'race' ? 'race' : 'lobby';
        if (!pub) return { st: 'private', room: '', rname: '' };
        const host = st.players && st.players[st.hostId];
        const humans = st.players ? Object.values(st.players).filter((p) => !p.isBot).length : 1;
        return { st: ph, room: Gm.code || '', rname: clip(st.settings.name || (host ? host.name + "'s room" : ''), 28), n: humans, max: (st.settings && st.settings.maxPlayers) || 8 };
      }
      if (A && A.mode === 'drive') return { st: 'solo' };
      if (A && A.mode === 'garage') return { st: 'garage' };
      if (A && A.mode === 'casino') return { st: 'casino' };
      return { st: 'menu' };
    },

    _card() {
      const s = this.status();
      return {
        id: this.id, name: clip(G.App && G.App.name ? G.App.name() : 'Driver', 16), st: s.st, room: s.room || '', rname: s.rname || '',
        n: s.n || 0, max: s.max || 0, v: G.VERSION, proto: G.Net ? G.Net.PROTO : 0,
        pub: this.pub || '', dm: this.pub ? 1 : 0, at: Date.now(),
      };
    },

    // force: publish now even if nothing changed; m: only to this broker
    _publish(force, m) {
      if (!this.started) return;
      const topic = NS + 'p/' + this.id;
      const c = this._card();
      const sig = JSON.stringify(Object.assign({}, c, { at: 0 }));
      if (!force && sig === this._sig && Date.now() - (this._pubAt || 0) < REFRESH) return;
      this._sig = sig;
      this._pubAt = Date.now();
      const s = JSON.stringify(c);
      for (const x of m ? [m] : this.ms) x.publish(topic, s, true);
    },

    _tick() {
      for (const m of this.ms) m.pump(performance.now());
      this._publish(false);
      // cards age out
      const now = Date.now();
      let changed = false;
      for (const [id, c] of this.cards) {
        const fresh = c.live ? now - c.seen < LIVE_TTL : now - c.info.at < RETAINED_TTL;
        if (!fresh) {
          this.cards.delete(id);
          changed = true;
        }
      }
      if (changed) this._changed();
    },

    _in(topic, s, live) {
      if (topic.indexOf(NS + 'p/') === 0) {
        const id = topic.slice(NS.length + 2);
        if (!okId(id) || id === this.id) return;
        if (!s) {
          if (this.cards.delete(id)) this._changed();
          return;
        }
        const o = parse(s);
        if (!o || o.id !== id) return;
        const info = {
          id, name: clip(o.name, 16) || 'Driver', st: STATUS[o.st] ? o.st : 'menu',
          room: /^[A-Z0-9]{5}$/.test(o.room || '') ? o.room : '', rname: clip(o.rname, 28),
          n: Math.max(0, Math.min(8, +o.n || 0)), max: Math.max(0, Math.min(8, +o.max || 0)),
          v: clip(o.v, 8), proto: +o.proto || 0,
          pub: typeof o.pub === 'string' && o.pub.length < 200 ? o.pub : '', dm: o.dm ? 1 : 0, at: +o.at || 0,
        };
        const old = this.cards.get(id);
        if (old && old.info.pub !== info.pub) this.akeys.delete(id); // they reloaded: new key
        this.cards.set(id, { info, seen: Date.now(), live: live || (old && old.live) || false });
        const cv = this.convos.get(id);
        if (cv) cv.name = info.name;
        this._changed();
      } else if (topic === NS + 'dm/' + this.id) this._dm(s);
    },

    async _key(id) {
      const c = this.cards.get(id);
      if (!c || !c.info.pub || !this.keys) return null;
      let k = this.akeys.get(id);
      if (!k) {
        k = await G.Relay.DM.key(this.keys.privateKey, c.info.pub);
        this.akeys.set(id, k);
      }
      return k;
    },

    async _dm(s) {
      const o = parse(s);
      if (!o || !okId(o.f) || typeof o.id !== 'string' || typeof o.iv !== 'string' || typeof o.ct !== 'string' || o.ct.length > 2000) return;
      if (this.seenMsg.has(o.id)) return; // (it comes once per broker)
      this.seenMsg.add(o.id);
      if (this.seenMsg.size > 400) this.seenMsg = new Set(Array.from(this.seenMsg).slice(200));
      // a few messages a second from one sender is flooding, not talking
      const now = Date.now();
      const rl = (this._rl = this._rl || new Map());
      const w = (rl.get(o.f) || []).filter((t) => now - t < 10000);
      if (w.length >= 8) return;
      w.push(now);
      rl.set(o.f, w);
      let text, body;
      try {
        const k = await this._key(o.f);
        if (!k) return; // we don't know who that is (no card): can't check it came from them
        body = parse(await G.Relay.DM.open(k, o));
        text = clip(body && body.t, MAX_LEN);
      } catch (e) {
        return; // didn't open: not really from that card
      }
      const card = this.cards.get(o.f);
      if (this.blocked.has(o.f)) {
        // still writing: tell them again (they may have reloaded and forgotten)
        const told = (this._told = this._told || new Map());
        if (text && now - (told.get(o.f) || 0) > 60000) {
          told.set(o.f, now);
          this._notice(o.f, 1);
        }
        return;
      }
      if (body && (body.b === 1 || body.b === 0)) return this._blockNotice(o.f, card ? card.info.name : 'Driver', body.b === 1);
      if (!text) return;
      const cv = this._convo(o.f, card ? card.info.name : 'Driver');
      cv.msgs.push({ me: false, text, at: now });
      if (cv.msgs.length > 100) cv.msgs.shift();
      const reading = this.open && this.view === o.f && !document.hidden;
      if (!reading) {
        cv.unread++;
        G.UI.toast(`💬 ${cv.name}: ${text.length > 60 ? text.slice(0, 57) + '…' : text}`, 'info', false);
      }
      if (G.Audio && G.Audio.chat) G.Audio.chat();
      this._changed();
    },

    _convo(id, name) {
      let cv = this.convos.get(id);
      if (!cv) this.convos.set(id, (cv = { name: name || 'Driver', msgs: [], unread: 0 }));
      return cv;
    },

    async send(id, text) {
      text = clip(text, MAX_LEN);
      if (!text) return;
      const c = this.cards.get(id);
      if (this.blockedBy.has(id)) return G.UI.toast(`${c ? c.info.name : 'They'} blocked you: your messages don't reach them.`, 'bad');
      if (!c) return G.UI.toast('They have gone offline.', 'bad');
      if (!c.info.dm) return G.UI.toast(`${c.info.name} isn't taking messages.`, 'bad');
      if (!this.ms.length) return G.UI.toast("Can't reach the message servers from here.", 'bad');
      const now = Date.now();
      if (now - (this._sentAt || 0) < 700) return;
      this._sentAt = now;
      try {
        const k = await this._key(id);
        if (!k) throw new Error('no key');
        const sealed = await G.Relay.DM.seal(k, JSON.stringify({ t: text }));
        const msg = JSON.stringify({ f: this.id, id: U.uid(12), iv: sealed.iv, ct: sealed.ct, at: now });
        for (const m of this.ms) m.publish(NS + 'dm/' + id, msg);
      } catch (e) {
        return G.UI.toast('That message could not be sent.', 'bad');
      }
      const cv = this._convo(id, c.info.name);
      cv.msgs.push({ me: true, text, at: now });
      if (cv.msgs.length > 100) cv.msgs.shift();
      this._changed();
    },

    block(id) {
      const c = this.cards.get(id), cv = this.convos.get(id);
      const name = c ? c.info.name : cv ? cv.name : 'Driver';
      this.blocked.set(id, name);
      this.convos.delete(id);
      this._notice(id, 1);
      G.UI.toast(`Blocked ${name}: they've been told, and you won't see their messages. Unblock them at the bottom of the list.`, 'info');
      this.view = null;
      this._changed();
    },

    unblock(id) {
      const name = this.blocked.get(id) || 'Driver';
      if (!this.blocked.delete(id)) return;
      if (this._told) this._told.delete(id);
      this._notice(id, 0);
      G.UI.toast(`Unblocked ${name}.`, 'info');
      this._changed();
    },

    // Tell someone we blocked (b 1) or unblocked (b 0) them: sealed like a
    // message, so it can only have come from us. (Needs their card: someone
    // who has gone offline hears it if they write again.)
    async _notice(id, b) {
      if (!this.ms.length || !this.cards.has(id)) return;
      try {
        const k = await this._key(id);
        if (!k) return;
        const sealed = await G.Relay.DM.seal(k, JSON.stringify({ b }));
        const msg = JSON.stringify({ f: this.id, id: U.uid(12), iv: sealed.iv, ct: sealed.ct, at: Date.now() });
        for (const m of this.ms) m.publish(NS + 'dm/' + id, msg);
      } catch (e) {}
    },

    // They blocked (on) or unblocked us: say so in the conversation, and shut
    // or reopen the box.
    _blockNotice(id, name, on) {
      if (on === this.blockedBy.has(id)) return;
      if (on) this.blockedBy.add(id);
      else this.blockedBy.delete(id);
      const cv = this._convo(id, name);
      const text = on ? `${cv.name} blocked you. Your messages won't reach them.` : `${cv.name} unblocked you.`;
      cv.msgs.push({ sys: true, text, at: Date.now() });
      if (cv.msgs.length > 100) cv.msgs.shift();
      if (!(this.open && this.view === id && !document.hidden)) G.UI.toast(text, on ? 'bad' : 'info', false);
      this._changed();
    },

    list() {
      const q = (this.q || '').toLowerCase();
      return Array.from(this.cards.values())
        .map((c) => c.info)
        .filter((i) => !this.blocked.has(i.id) && (!q || i.name.toLowerCase().includes(q)))
        .sort((a, b) => (this.convos.get(b.id) || { unread: 0 }).unread - (this.convos.get(a.id) || { unread: 0 }).unread || a.name.localeCompare(b.name));
    },
    unread() {
      let n = 0;
      for (const cv of this.convos.values()) n += cv.unread;
      return n;
    },
    count() {
      let n = 0;
      for (const id of this.cards.keys()) if (!this.blocked.has(id)) n++;
      return n + 1; // (and us)
    },
    // the corner button: 👥 and how many are on, or unread messages
    cornerHtml() {
      if (!this.started) return '';
      const u = this.unread();
      return `<button data-c="online" title="Online players and messages" class="on-cbtn">👥<b class="${u ? 'unread' : ''}">${u || (this.ms.length ? this.count() : '')}</b></button>`;
    },

    _changed() {
      if (this._cT) return;
      this._cT = setTimeout(() => {
        this._cT = null;
        const u = this.unread() + ':' + this.count() + ':' + this.ms.length;
        if (u !== this._cornerSig && G.Overlay && G.Overlay.renderCorner) {
          this._cornerSig = u;
          G.Overlay.renderCorner();
        }
        this.render();
      }, 150);
    },

    // ------------------------------------------------------------ the panel
    _build() {
      const el = document.createElement('div');
      el.id = 'online';
      el.innerHTML = `<div class="on-head"><b>Online now</b><span class="on-n"></span><button class="on-x" title="Close (Esc)">✕</button></div>
        <div class="on-listv"><input class="on-q" maxlength="16" placeholder="Find a driver…"><div class="on-list"></div></div>
        <div class="on-chat" hidden><div class="on-ch"><button class="on-back" title="Back">←</button><div><b></b><span></span></div><button class="on-block" title="Block: no more messages from them this session">Block</button></div>
          <div class="on-log"></div>
          <div class="on-in"><input maxlength="${MAX_LEN}" placeholder="Message…"><button class="btn small">Send</button></div></div>
        <p class="on-note">Messages are end-to-end encrypted and vanish when you close the game. Never share personal details with someone you don't know.</p>`;
      document.body.appendChild(el);
      this.el = el;
      this.$ = (s) => el.querySelector(s);
      el.addEventListener('click', (e) => {
        const t = e.target;
        if (t.closest('.on-x')) return this.toggle(false);
        if (t.closest('.on-back')) {
          this.view = null;
          return this.render();
        }
        if (t.closest('.on-block')) return this.view && this.block(this.view);
        const ub = t.closest('[data-on="unblock"]');
        if (ub) return this.unblock(ub.dataset.id);
        if (t.closest('.on-in button')) return this._sendBox();
        const b = t.closest('[data-on]');
        if (!b) return;
        const id = b.dataset.id;
        if (b.dataset.on === 'msg') {
          this.view = id;
          this.render();
          setTimeout(() => this.$('.on-in input').focus(), 30);
        } else if (b.dataset.on === 'join') this._join(id);
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (this.view) {
            this.view = null;
            this.render();
          } else this.toggle(false);
        } else if (e.key === 'Enter' && e.target.closest('.on-in')) {
          e.preventDefault();
          e.stopPropagation();
          this._sendBox();
        }
        e.stopPropagation(); // typing here never drives the car or opens the chat
      });
      this.$('.on-q').addEventListener('input', (e) => {
        this.q = e.target.value;
        this.render();
      });
    },

    toggle(on) {
      this.open = on == null ? !this.open : !!on;
      this.el.classList.toggle('open', this.open);
      if (!this.open && document.activeElement && this.el.contains(document.activeElement)) document.activeElement.blur();
      if (this.open && !this.started) this.start();
      this.render();
    },

    async _sendBox() {
      const inp = this.$('.on-in input');
      const v = inp.value;
      if (!v.trim() || !this.view) return;
      inp.value = '';
      await this.send(this.view, v);
    },

    _join(id) {
      const c = this.cards.get(id);
      if (!c || !c.info.room) return;
      if (G.Game && G.Game.role) return G.UI.toast('Leave the room you are in first (Esc → Leave).', 'bad');
      if (c.info.proto !== (G.Net && G.Net.PROTO)) return G.UI.toast('Their game is a different version — both of you should reload the page.', 'bad');
      this.toggle(false);
      if (G.App.mode !== 'menu') G.App.showMenu();
      setTimeout(() => G.UI.screens.menu.openJoin(c.info.room), 200);
    },

    statusText(i) {
      let t = STATUS[i.st] || '';
      if ((i.st === 'lobby' || i.st === 'race') && i.room) t += ` · ${U.esc(i.rname || 'a room')} (${i.n}/${i.max || 8})`;
      return t;
    },

    render() {
      if (!this.el || !this.open) return;
      const $ = this.$;
      $('.on-n').textContent = this.ms.length ? `${this.count()} playing` : this.started ? 'connecting…' : '';
      const chat = this.view && this.convos.get(this.view) ? this.convos.get(this.view) : this.view ? this._convo(this.view, (this.cards.get(this.view) || { info: { name: 'Driver' } }).info.name) : null;
      $('.on-listv').hidden = !!chat;
      $('.on-chat').hidden = !chat;
      if (chat) {
        chat.unread = 0;
        const card = this.cards.get(this.view);
        $('.on-ch b').textContent = chat.name;
        $('.on-ch span').textContent = card ? STATUS[card.info.st] || '' : 'Offline';
        const log = chat.msgs.map((m) => `<div class="on-m ${m.sys ? 'sys' : m.me ? 'me' : ''}">${U.esc(m.text)}</div>`).join('') || `<p class="on-empty">Say hello to ${U.esc(chat.name)}.</p>`;
        if ($('.on-log')._h !== log) {
          $('.on-log').innerHTML = $('.on-log')._h = log;
          $('.on-log').scrollTop = 1e6;
        }
        const by = this.blockedBy.has(this.view);
        const can = card && card.info.dm && !by;
        $('.on-in input').disabled = !can;
        $('.on-in input').placeholder = by ? `${chat.name} blocked you` : !card ? 'They have gone offline' : !card.info.dm ? "They aren't taking messages" : `Message ${chat.name}…`;
        if (G.Overlay && G.Overlay.renderCorner) G.Overlay.renderCorner();
        return;
      }
      const rows = this.list();
      const inRoom = !!(G.Game && G.Game.role);
      const html = rows.length
        ? rows
            .map((i) => {
              const cv = this.convos.get(i.id);
              const u = cv && cv.unread ? `<b class="on-u">${cv.unread}</b>` : '';
              const joinable = i.room && !inRoom && i.proto === (G.Net && G.Net.PROTO) && i.n < (i.max || 8);
              const by = this.blockedBy.has(i.id);
              return `<div class="on-row"><div class="on-who"><div class="on-nm"><b>${U.esc(i.name)}</b>${u}</div><span>${by ? 'Blocked you' : this.statusText(i)}</span></div>${joinable ? `<button class="btn small ghost" data-on="join" data-id="${i.id}" title="Join their room">Join</button>` : ''}${i.dm ? `<button class="btn small" data-on="msg" data-id="${i.id}" title="${by ? 'They blocked you' : 'Send a message'}">💬</button>` : ''}</div>`;
            })
            .join('')
        : `<p class="on-empty">${!this.started || !this.ms.length ? 'Looking for other players…' : this.q ? 'Nobody by that name.' : "Nobody else is on right now. When friends open the game they'll show up here."}</p>`;
      // the people you blocked, so you can let them back in
      const blk = this.blocked.size
        ? `<div class="on-blk"><span>Blocked</span>${Array.from(this.blocked)
            .map(([id, name]) => `<div class="on-row"><div class="on-who"><div class="on-nm"><b>${U.esc(name)}</b></div><span>${this.cards.has(id) ? 'Online' : 'Offline'}</span></div><button class="btn small ghost" data-on="unblock" data-id="${id}">Unblock</button></div>`)
            .join('')}</div>`
        : '';
      if ($('.on-list')._h !== html + blk) $('.on-list').innerHTML = $('.on-list')._h = html + blk;
    },
  };

  G.Online = Online;
  window.addEventListener('load', () => Online.init());
})(window.G);
