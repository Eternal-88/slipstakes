// relay.js — the BACKUP ROUTE, for when two devices can't link directly.
//
// WebRTC (net.js) needs a device-to-device path. School and office Wi-Fi
// usually block that twice over: devices on the Wi-Fi can't see each other
// ("client isolation") and UDP to the outside is filtered. The standard fix
// is a TURN relay, but every free account-less TURN server has gone: openrelay,
// freestun, anyfirewall and PeerJS's own all failed a test in Sept 2026.
//
// So when the direct link fails we carry the game's messages through public
// MQTT brokers over secure WebSockets: the same kind of connection an ordinary
// web page makes, on port 443 where a broker offers it (a school can't block
// 443 without breaking the web). The host listens on every broker in BROKERS.
// A joiner that can't link directly knocks on all of them, and the first broker
// the host answers on carries that player's traffic.
//
// Trade-offs:
//  * lag: joiner -> broker -> host instead of joiner -> host, typically
//    60-200 ms round trip instead of ~5 ms on one Wi-Fi. Client prediction
//    hides most of it.
//  * these are public test brokers. Anyone who guesses the topic can read the
//    traffic (car positions and driver names, nothing secret), and any of them
//    can go down, which is why there are several.
//
// The rest of the game never sees any of this: RelayConn looks like a PeerJS
// DataConnection (label, open, send, close, 'open'/'data'/'close' events), so
// net.js wires it exactly like a WebRTC channel.
//
// Wire format: each MQTT message is a JSON string {f?, z:[frame, …]}, with
// frame = {l:'ctrl'|'fast', k?:'o'|'x', d?:msg}. k:'o' opens a channel, k:'x'
// closes it, no k carries a message. f (joiner -> host only) is the joiner's
// random id. Every message sent in one JS task to one party is batched into a
// single MQTT publish.
'use strict';
(function (G) {
  const U = G.U;
  // shiftr's public broker is on 443, the port most likely to be open; the
  // others use 8884/8081, which strict networks may block. A joiner uses
  // whichever broker the host answers on first, so the fastest one wins.
  // Tested Sept 2026 at 60 msgs/s of 1.1 KB (a race needs ~50/s per player):
  // all three delivered 300/300 with a 180-250 ms one-way trip. broker.emqx.io
  // is NOT listed: it passed only 60 of 300 (rate-limited to ~12/s).
  const BROKERS = [
    { id: 'shiftr', url: 'wss://public.cloud.shiftr.io', user: 'public', pass: 'public' },
    { id: 'hivemq', url: 'wss://broker.hivemq.com:8884/mqtt' },
    { id: 'mosquitto', url: 'wss://test.mosquitto.org:8081' },
  ];
  const NS = 'slipstakes/r1/'; // topics: NS+CODE+'/h' (to the host), NS+CODE+'/c/'+joinerId
  const DIR = 'slipstakes/rooms/v1/'; // server list: one retained "room card" per room code
  const KEEPALIVE = 60; // s; we ping every 20 s, and any publish also counts
  const CONGESTED = 64 * 1024; // bytes waiting in the socket: drop 'fast' messages rather than build up lag

  const enc = new TextEncoder(), dec = new TextDecoder();
  const parse = (s) => {
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  };

  // ------------------------------------------------ minimal MQTT 3.1.1 client
  // Just what we need: CONNECT, SUBSCRIBE, PUBLISH (QoS 0), PING, DISCONNECT.
  function mstr(s) {
    const b = enc.encode(s);
    const o = new Uint8Array(2 + b.length);
    o[0] = b.length >> 8;
    o[1] = b.length & 255;
    o.set(b, 2);
    return o;
  }
  function packet(head, parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const len = [];
    let x = n;
    do {
      let d = x % 128;
      x = Math.floor(x / 128);
      if (x > 0) d |= 128;
      len.push(d);
    } while (x > 0);
    const o = new Uint8Array(1 + len.length + n);
    o[0] = head;
    o.set(len, 1);
    let i = 1 + len.length;
    for (const p of parts) {
      o.set(p, i);
      i += p.length;
    }
    return o;
  }

  class Mqtt extends U.Emitter {
    constructor(b) {
      super();
      this.b = b;
      this.ready = false;
      this.dead = false;
      this.buf = new Uint8Array(0);
      this.pid = 0;
      this.lastIn = this.lastOut = performance.now();
    }

    connect(ms) {
      return new Promise((res, rej) => {
        let ws;
        try {
          ws = new WebSocket(this.b.url, 'mqtt');
        } catch (e) {
          return rej(e);
        }
        this.ws = ws;
        ws.binaryType = 'arraybuffer';
        const to = setTimeout(() => {
          rej(new Error('timeout'));
          this.close();
        }, ms || 7000);
        this._connack = (ok) => {
          clearTimeout(to);
          if (!ok) {
            rej(new Error('refused'));
            return this.close();
          }
          this.ready = true;
          res(this);
        };
        ws.onopen = () => {
          const b = this.b;
          let flags = 0x02 | (b.user ? 0x80 : 0) | (b.pass ? 0x40 : 0); // clean session
          // Last Will: the broker publishes this if we vanish without saying
          // goodbye. Hosts use it to wipe their room from the server list.
          if (b.will) flags |= 0x04 | (b.will.retain ? 0x20 : 0);
          const parts = [new Uint8Array([0, 4, 77, 81, 84, 84, 4, flags, 0, KEEPALIVE]), mstr('ss-' + U.uid(12))];
          if (b.will) parts.push(mstr(b.will.topic), mstr(b.will.payload || ''));
          if (b.user) parts.push(mstr(b.user));
          if (b.pass) parts.push(mstr(b.pass));
          this._send(packet(0x10, parts));
        };
        ws.onmessage = (e) => {
          this.lastIn = performance.now();
          if (e.data instanceof ArrayBuffer) this._feed(new Uint8Array(e.data));
        };
        ws.onclose = ws.onerror = () => {
          clearTimeout(to);
          rej(new Error('closed'));
          this._die();
        };
      });
    }

    // A WebSocket message may hold several MQTT packets, or part of one.
    _feed(chunk) {
      let b = chunk;
      if (this.buf.length) {
        b = new Uint8Array(this.buf.length + chunk.length);
        b.set(this.buf);
        b.set(chunk, this.buf.length);
      }
      let i = 0;
      while (b.length - i >= 2) {
        let n = 0, mul = 1, j = i + 1, d = 0, whole = true;
        do {
          if (j >= b.length) {
            whole = false;
            break;
          }
          d = b[j++];
          n += (d & 127) * mul;
          mul *= 128;
        } while (d & 128);
        if (!whole || j + n > b.length) break;
        this._packet(b[i], b.subarray(j, j + n));
        i = j + n;
      }
      this.buf = i < b.length ? b.slice(i) : new Uint8Array(0);
    }

    _packet(head, p) {
      const type = head >> 4;
      if (type === 2) {
        if (this._connack) this._connack(p[1] === 0);
      } else if (type === 3) {
        const tl = (p[0] << 8) | p[1];
        const topic = dec.decode(p.subarray(2, 2 + tl));
        const k = 2 + tl + ((head >> 1) & 3 ? 2 : 0); // QoS>0 carries a packet id
        this.emit('msg', topic, dec.decode(p.subarray(k)));
      }
      // SUBACK (9) and PINGRESP (13) need no action.
    }

    _send(u8) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      try {
        this.ws.send(u8);
        this.lastOut = performance.now();
        return true;
      } catch (e) {
        return false;
      }
    }
    subscribe(topic) {
      this.pid = (this.pid % 65535) + 1;
      this._send(packet(0x82, [new Uint8Array([this.pid >> 8, this.pid & 255]), mstr(topic), new Uint8Array([0])]));
    }
    // retain: the broker keeps the message and hands it to anyone who
    // subscribes later (the server list); an empty retained message clears it.
    publish(topic, s, retain) {
      return this._send(packet(0x30 | (retain ? 1 : 0), [mstr(topic), enc.encode(s)]));
    }
    backlog() {
      return this.ws ? this.ws.bufferedAmount : 0;
    }
    pump(now) {
      if (!this.ready) return;
      if (now - this.lastOut > 20000) this._send(new Uint8Array([0xc0, 0])); // PINGREQ
      if (now - this.lastIn > 75000) this.close(); // broker went quiet: treat as gone
    }
    close() {
      if (this.dead) return;
      this._send(new Uint8Array([0xe0, 0])); // DISCONNECT (queued data still goes out first)
      try {
        this.ws.close();
      } catch (e) {}
      this._die();
    }
    _die() {
      if (this.dead) return;
      this.dead = true;
      this.ready = false;
      this.emit('close');
    }
  }

  // ------------------------------------------------------- channel + route
  // One channel ('ctrl' or 'fast') to one party, shaped like a PeerJS DataConnection.
  class RelayConn extends U.Emitter {
    constructor(route, label, peer) {
      super();
      this.route = route;
      this.label = label;
      this.peer = peer;
      this.bid = route.m.b.id;
      this.relay = true;
      this.open = false;
      this.gone = false;
    }
    _open() {
      if (this.open || this.gone) return;
      this.open = true;
      this.emit('open');
    }
    send(msg) {
      if (this.open) this.route.push({ l: this.label, d: msg });
    }
    close() {
      if (this.gone) return;
      if (this.open) this.route.push({ l: this.label, k: 'x' });
      this._gone();
    }
    _gone() {
      if (this.gone) return;
      this.gone = true;
      this.open = false;
      this.emit('close');
    }
  }

  // Everything to/from one party over one broker: its channels and the
  // outgoing batch.
  class Route {
    constructor(m, to, from) {
      this.m = m;
      this.to = to; // topic we publish to
      this.from = from; // joiner id stamped on each publish (joiner side only)
      this.q = [];
      this.queued = false;
      this.conns = {};
    }
    push(fr) {
      if (fr.l === 'fast' && fr.d !== undefined && this.m.backlog() > CONGESTED) return;
      this.q.push(fr);
      if (!this.queued) {
        this.queued = true;
        queueMicrotask(() => this.flush());
      }
    }
    flush() {
      this.queued = false;
      if (!this.q.length) return;
      const o = { z: this.q };
      if (this.from) o.f = this.from;
      this.q = [];
      this.m.publish(this.to, JSON.stringify(o));
    }
    open(label, peer) {
      return (this.conns[label] = new RelayConn(this, label, peer));
    }
    inbound(fr) {
      const c = this.conns[fr.l];
      if (!c) return;
      if (fr.k === 'x') c._gone();
      else if (c.open && fr.d !== undefined) c.emit('data', fr.d);
    }
    kill() {
      for (const l of Object.keys(this.conns)) this.conns[l]._gone();
    }
  }

  const okFrame = (fr) => fr && (fr.l === 'ctrl' || fr.l === 'fast');

  // --------------------------------------------------------------- HOST side
  // Listens on the room's topic on every broker; emits 'connection' with a
  // RelayConn for each channel a joiner opens. Brokers that drop are retried.
  // Also publishes the room's card for the server list (announce()), with a
  // Last Will that clears it if this host drops off the internet.
  class RelayHost extends U.Emitter {
    constructor(code) {
      super();
      this.code = code;
      this.base = NS + code;
      this.dirTopic = DIR + code;
      this.routes = new Map(); // brokerId:joinerId -> Route
      this.ms = new Map(); // brokerId -> Mqtt
      this.closed = false;
      this.card = ''; // current room card (JSON), '' = not listed
    }
    // info = room card object, or null to take the room off the list
    announce(info) {
      const s = info ? JSON.stringify(info) : '';
      if (s === this.card && info) {
        // unchanged: still refresh now and then so listers see it's alive
        if (performance.now() - (this.cardAt || 0) < 25000) return;
      }
      if (!s && !this.card) return;
      this.card = s;
      this.cardAt = performance.now();
      for (const m of this.ms.values()) m.publish(this.dirTopic, s, true);
    }
    start() {
      for (const b of BROKERS) this._keep(b, 0);
      return this;
    }
    brokers() {
      return Array.from(this.ms.keys());
    }
    _keep(b, fails) {
      if (this.closed) return;
      const m = new Mqtt(Object.assign({}, b, { will: { topic: this.dirTopic, payload: '', retain: true } }));
      m.connect(8000)
        .then(() => {
          if (this.closed) return m.close();
          this.ms.set(b.id, m);
          m.subscribe(this.base + '/h');
          if (this.card) m.publish(this.dirTopic, this.card, true);
          m.on('msg', (t, s) => this._in(m, s));
          m.on('close', () => {
            if (this.ms.get(b.id) === m) this.ms.delete(b.id);
            for (const [k, R] of Array.from(this.routes)) {
              if (R.m === m) {
                this.routes.delete(k);
                R.kill();
              }
            }
            setTimeout(() => this._keep(b, 0), 3000);
          });
          this.emit('ready', b.id);
        })
        .catch(() => setTimeout(() => this._keep(b, fails + 1), Math.min(60000, 5000 * 2 ** fails)));
    }
    _in(m, s) {
      const o = parse(s);
      if (!o || typeof o.f !== 'string' || !/^[\w-]{4,40}$/.test(o.f) || !Array.isArray(o.z)) return;
      const key = m.b.id + ':' + o.f;
      let R = this.routes.get(key);
      for (const fr of o.z) {
        if (!okFrame(fr)) continue;
        if (fr.k !== 'o') {
          if (R) R.inbound(fr);
          continue;
        }
        if (!R) this.routes.set(key, (R = new Route(m, this.base + '/c/' + o.f, null)));
        R.push({ l: fr.l, k: 'o' }); // a repeated knock gets the same answer
        if (R.conns[fr.l]) continue;
        const c = R.open(fr.l, 'relay:' + key);
        const route = R, label = fr.l;
        c.on('close', () => {
          route.flush(); // send the channel's goodbye now, before the route can be torn down
          if (route.conns[label] === c) delete route.conns[label];
          if (!Object.keys(route.conns).length && this.routes.get(key) === route) this.routes.delete(key);
        });
        this.emit('connection', c);
        c._open();
      }
    }
    pump(now) {
      for (const m of this.ms.values()) m.pump(now);
    }
    close() {
      this.closed = true;
      for (const R of this.routes.values()) R.flush();
      for (const m of this.ms.values()) {
        if (this.card) m.publish(this.dirTopic, '', true); // off the server list
        m.close();
      }
      this.routes.clear();
      this.ms.clear();
    }
  }

  // --------------------------------------------------------- SERVER LIST
  // Subscribes to every room card on every broker. A card is shown while it's
  // fresh: either the host refreshed it while we were watching (hosts refresh
  // every ~25 s), or its own timestamp is under 2 minutes old (retained cards
  // arrive the instant we subscribe, so their age comes from the host's clock).
  // After a host migration the same room (rid) gets a new code; the newest
  // epoch wins.
  const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
  const num = (v, lo, hi) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : lo);
  class RoomBoard extends U.Emitter {
    constructor() {
      super();
      this.rooms = new Map(); // code -> {info, live}
      this.ms = [];
      this.tried = 0;
      this.failed = 0;
      this.closed = false;
    }
    start() {
      for (const b of BROKERS) {
        const m = new Mqtt(b);
        this.tried++;
        m.connect(7000)
          .then(() => {
            if (this.closed) return m.close();
            this.ms.push(m);
            const subAt = performance.now();
            m.subscribe(DIR + '+');
            m.on('msg', (t, s) => this._in(t, s, performance.now() - subAt > 1500));
            m.on('close', () => (this.ms = this.ms.filter((x) => x !== m)));
            this.emit('change');
          })
          .catch(() => {
            this.failed++;
            this.emit('change');
          });
      }
      this.tick = setInterval(() => {
        for (const m of this.ms) m.pump(performance.now());
        this.emit('change'); // ages move on
      }, 5000);
      return this;
    }
    reached() {
      return this.ms.length;
    }
    _in(topic, s, live) {
      const code = topic.slice(DIR.length);
      if (!/^[A-Z0-9]{5}$/.test(code)) return;
      if (!s) {
        if (this.rooms.delete(code)) this.emit('change');
        return;
      }
      const o = parse(s);
      if (!o || o.code !== code) return;
      const info = {
        code, rid: clip(o.rid, 16) || code, epoch: num(o.epoch, 0, 999), name: clip(o.name, 28), host: clip(o.host, 16),
        vis: o.vis === 'public' ? 'public' : 'private', players: num(o.players, 0, 8), max: num(o.max, 1, 8), bots: num(o.bots, 0, 8),
        phase: clip(o.phase, 14), race: num(o.race, 0, 99), races: num(o.races, 1, 99), ver: clip(o.ver, 8), proto: num(o.proto, 0, 999), at: +o.at || 0,
      };
      const old = this.rooms.get(code);
      this.rooms.set(code, { info, live: live || (old && old.live) || false, seen: Date.now() });
      this.emit('change');
    }
    // Fresh rooms, one per room id (newest epoch), busiest first.
    list() {
      const now = Date.now();
      const best = new Map();
      for (const r of this.rooms.values()) {
        const fresh = r.live ? now - r.seen < 75000 : now - r.info.at < 120000;
        if (!fresh) continue;
        const b = best.get(r.info.rid);
        if (!b || r.info.epoch > b.epoch || (r.info.epoch === b.epoch && r.info.at > b.at)) best.set(r.info.rid, r.info);
      }
      return Array.from(best.values()).sort((a, b) => b.players - a.players || a.name.localeCompare(b.name));
    }
    close() {
      this.closed = true;
      clearInterval(this.tick);
      for (const m of this.ms) m.close();
      this.ms = [];
    }
  }

  // ------------------------------------------------------------- JOINER side
  // start() connects to every broker straight away (so the relay is warm);
  // knock() asks the host to open both channels, repeated every 2 s until it
  // answers. keep(brokerId) drops the other brokers once one has won.
  class RelayJoin extends U.Emitter {
    constructor(code) {
      super();
      this.base = NS + code;
      this.cid = U.uid(12);
      this.routes = new Map(); // brokerId -> Route
      this.tried = 0;
      this.failed = 0;
      this.reached = 0;
      this.heard = false;
      this.knocking = false;
      this.kept = null;
      this.closed = false;
    }
    start() {
      for (const b of BROKERS) {
        const m = new Mqtt(b);
        this.tried++;
        m.connect(7000)
          .then(() => {
            if (this.closed || (this.kept && this.kept !== b.id)) return m.close();
            this.reached++;
            const R = new Route(m, this.base + '/h', this.cid);
            this.routes.set(b.id, R);
            m.subscribe(this.base + '/c/' + this.cid);
            m.on('msg', (t, s) => this._in(R, s));
            m.on('close', () => {
              R.kill();
              if (this.routes.get(b.id) === R) this.routes.delete(b.id);
            });
            if (this.knocking) this._knock(R);
          })
          .catch(() => {
            if (++this.failed === this.tried) this.emit('fail');
          });
      }
      return this;
    }
    knock() {
      if (this.knocking || this.closed) return;
      this.knocking = true;
      for (const R of this.routes.values()) this._knock(R);
      this.kt = setInterval(() => {
        for (const R of this.routes.values()) if (!(R.conns.ctrl && R.conns.fast)) this._knock(R);
      }, 2000);
    }
    _knock(R) {
      R.push({ l: 'ctrl', k: 'o' });
      R.push({ l: 'fast', k: 'o' });
    }
    _in(R, s) {
      const o = parse(s);
      if (!o || !Array.isArray(o.z)) return;
      for (const fr of o.z) {
        if (!okFrame(fr)) continue;
        if (fr.k !== 'o') {
          R.inbound(fr);
          continue;
        }
        if (R.conns[fr.l] || this.closed || (this.kept && this.kept !== R.m.b.id)) continue;
        this.heard = true;
        const c = R.open(fr.l, 'host');
        this.emit('connection', c);
        c._open();
      }
    }
    keep(bid) {
      this.kept = bid;
      clearInterval(this.kt);
      for (const [id, R] of Array.from(this.routes)) {
        if (id === bid) continue;
        for (const l of Object.keys(R.conns)) R.conns[l].close();
        R.flush();
        R.m.close();
        this.routes.delete(id);
      }
    }
    pump(now) {
      for (const R of this.routes.values()) R.m.pump(now);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.kt);
      for (const R of this.routes.values()) {
        R.flush();
        R.m.close();
        R.kill();
      }
      this.routes.clear();
    }
  }

  G.Relay = { BROKERS, Mqtt, RelayHost, RelayJoin, RoomBoard };
})(window.G);
