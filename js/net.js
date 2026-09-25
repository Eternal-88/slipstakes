// net.js — PeerJS (WebRTC) transport. No server code: PeerJS's public
// signalling server only brokers the introduction; after that every byte goes
// peer-to-peer. THIS IS WHERE THE BUGS LIVE — read the notes.
//
// Topology: STAR. The host is the hub; clients only ever talk to the host.
//
// Two DataConnections per client:
//   'ctrl'  reliable + ordered.  hello/welcome, full session state, actions,
//           race events, pings. Anything that must arrive, in order.
//   'fast'  unordered (reliable:false). 30 Hz inputs up, 20 Hz snapshots down.
//           Every packet carries a sequence number/tick and receivers DROP
//           anything older than what they already have, so reordering is
//           harmless and a late packet never rewinds the world.
// Each PeerJS DataConnection is its own RTCPeerConnection, so the two
// channels can't head-of-line block each other.
//
// Identity: the host's peer id is PREFIX + room code. A client proves who it
// is with a random TOKEN kept in its localStorage per room — so a crashed tab
// that reloads gets its own car, money and parts back.
//
// Failure handling:
//   * host signalling drop  -> existing P2P links keep working; we call
//                              peer.reconnect() so NEW joiners can still find us.
//   * client link drop      -> client emits 'lost' and the game layer retries
//                              the whole handshake every few seconds.
//   * silent peers          -> both sides ping every second; the host drops a
//                              client after SILENT_MS of silence; clients
//                              declare the host lost after 10 s of silence THEY
//                              WERE AWAKE FOR (see pump/tick - time with a
//                              blocked main thread is not silence).
'use strict';
(function (G) {
  const U = G.U;
  const PREFIX = 'slipstakes-v1-';
  const PROTO = 11; // bump when message formats change; mismatched clients are rejected (4: tuning/looks, brake temp; 5: v4 nitrous input, slipstream/catch-up state, 4-bit surfaces; 6: v4.3 join requests, host migration, traction control in the setup; 7: v4.4 private-room asks via the list, "room closed"; 8: v5 fuel/tyre/pit state in snapshots, stops, weather + endurance race info; 9: v5.1 car physics and parts changed, and the schedule says which races are endurance races; 10: v5.3 revCut joins the car's core state, so the full-state packet is a field longer; 11: v5.3.3 aero is sized to the car and the Mule's power changed - an old client would predict its own car against different numbers)
  // ICE servers: how two devices find a path to each other.
  //  * STUN tells each device its public address so a direct path can be
  //    punched through both networks' routers.
  //  * TURN (a relay) carries the traffic when no direct path exists, for
  //    example two Chromebooks on a school Wi-Fi that isolates devices.
  // PeerJS's built-in relays (eu-0/us-0.turn.peerjs.com) are DEAD: their names
  // no longer resolve (checked Sept 2026), so a join that needed a relay just
  // "timed out". No free account-less TURN is left, so relay.js carries the
  // game over public MQTT brokers instead when no direct path exists (school
  // Wi-Fi). A real TURN account can still go in TURN, e.g.
  // { urls: 'turn:HOST:443?transport=tcp', username: '…', credential: '…' }
  const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, { urls: 'stun:stun.cloudflare.com:3478' }];
  const TURN = [];
  // debug 0: we handle every PeerJS error ourselves; at debug 1 the reconnect
  // loop (a retry every 3 s for up to 5 min) filled the console with ERRORs.
  const PEER_OPTS = { debug: 0, config: { iceServers: STUN.concat(TURN) } };
  const REVERSE_AFTER = 5000; // joiner's link not open by now -> host dials the joiner
  const RELAY_AFTER = 8000; // still no direct link (reverse dial included) -> joiner knocks on the backup relay
  // v4.5: on a link that can't keep up (weak or busy Wi-Fi) the browser queues
  // 'fast' packets, and every queued snapshot / input then arrives late. Past
  // this backlog we skip the packet instead: the next one supersedes it, and
  // inputs carry copies of the previous blocks anyway. (The relay has its own.)
  const FAST_BACKLOG = 32 * 1024;
  const NETSTAT = (G.NetStat = { skipped: 0 });
  const backlogged = (conn) => {
    const dc = conn && conn.dataChannel;
    if (!(dc && dc.bufferedAmount > FAST_BACKLOG)) return false;
    NETSTAT.skipped++;
    return true;
  };
  const JOIN_TIMEOUT = 22000; // client gives up (covers all three routes)
  // A gap this long between ticks means the main thread was blocked, not that
  // the other end went quiet. See pump() and tick().
  const STALL_MS = 1200;
  // How long a player can go quiet before the host gives their seat up. A
  // blocked main thread sends no pings, so this is really "how slow a device
  // are we willing to wait for". At 10 s, a Chromebook that took two long
  // moments to build a track lost its seat mid-race and came back as a new
  // joiner - that is the race-start disconnect loop from the host's end. A
  // frozen player's car is driven by a stand-in bot meanwhile (hostrace.js),
  // so waiting longer costs the race nothing.
  const SILENT_MS = 20000;

  // v5.5.5 BIG MESSAGES. PeerJS refuses any JSON message of 16,300 bytes or
  // more on a direct link: it reports 'message-too-big' as a link ERROR and
  // sends nothing. A full room's state (eight players, their garages and
  // stats, fifty lines of chat) is over 20 KB, and the heirs' copy is bigger
  // still. So once a session had grown, every state update dropped every
  // player on a direct link; they reconnected, were sent the state, and
  // dropped again - the "lost connection / is back" loop. (Relayed players
  // were fine: that is why it hit some players and not others.)
  // Now a big control message goes as numbered parts, each well under the
  // limit, and the other end puts it back together. The control channel is
  // reliable and ordered, so the parts arrive complete and in order.
  const PART_MAX = 12000; // bytes of one part on the wire (PeerJS's limit is 16,300)
  const enc = new TextEncoder();
  const bytes = (s) => enc.encode(s).length;
  let partId = 0;
  const partsCache = new WeakMap(); // one split per message, however many players it goes to
  function split(msg) {
    if (partsCache.has(msg)) return partsCache.get(msg);
    const s = JSON.stringify(msg);
    // (a character is at most 4 bytes: short messages can't be over)
    let out = null;
    if (s.length * 4 >= PART_MAX && bytes(s) >= PART_MAX) {
      const ds = [];
      for (let i = 0; i < s.length; ) {
        let n = Math.min(s.length - i, 6000);
        while (n > 64 && bytes(JSON.stringify(s.substr(i, n))) > PART_MAX - 200) n = Math.floor(n * 0.7);
        const c = s.charCodeAt(i + n - 1);
        if (c >= 0xd800 && c <= 0xdbff && i + n < s.length) n--; // keep an emoji's two halves together
        ds.push(s.substr(i, n));
        i += n;
      }
      const id = ++partId;
      out = ds.map((d, k) => ({ t: 'part', id, i: k, n: ds.length, d }));
    }
    partsCache.set(msg, out);
    return out;
  }
  // Collects parts on `holder` (one link); returns the whole message once the
  // last part is in, else null. Never trusts the wire: bad or oversized
  // parts are dropped.
  function joinPart(holder, m) {
    if (typeof m.d !== 'string' || !(m.n > 1 && m.n <= 256) || !(m.i >= 0 && m.i < m.n)) return null;
    let b = holder._part;
    if (!b || b.id !== m.id || b.n !== m.n) b = holder._part = { id: m.id, n: m.n, got: 0, len: 0, d: new Array(m.n) };
    if (b.d[m.i] == null) {
      b.d[m.i] = m.d;
      b.got++;
      b.len += m.d.length;
    }
    if (b.len > 4e6) holder._part = null;
    if (b.got < b.n || holder._part !== b) return null;
    holder._part = null;
    try {
      return JSON.parse(b.d.join(''));
    } catch (e) {
      return null;
    }
  }
  // A player whose game predates parts can't be sent a big message at all.
  const OUTDATED = "This room has grown past what your version of the game can receive. Reload the page (Ctrl+Shift+R) to get the latest version, then rejoin.";

  function peerAvailable() {
    return typeof window.Peer === 'function';
  }

  // ===================================================================== HOST
  class NetHost extends U.Emitter {
    // opts: {lid, epoch} — the room's server-list id (relay.js RelayHost)
    constructor(code, opts) {
      super();
      this.code = code;
      this.opts = opts || {};
      this.links = new Map(); // remote peer id -> link {id, ctrl, fast, pid, lastSeen, rtt}
      this.byPid = new Map(); // player id -> link
      this.closed = false;
      this.bytesOut = 0;
    }

    // Resolves once the signalling server has registered our id, then also
    // listens on the backup relay (relay.js). Rejects with 'taken' if the room
    // code is in use (caller picks another code). If the signalling server
    // can't be reached at all, the room opens on the relay alone.
    open() {
      return new Promise((resolve, reject) => {
        let settled = false, to = null;
        const fallback = (why) => {
          if (settled) return;
          settled = true;
          clearTimeout(to);
          if (!G.Relay) return reject(new Error(why));
          if (this.peer) {
            try {
              this.peer.destroy();
            } catch (e) {}
            this.peer = null;
          }
          this.relayOnly = true;
          const R = this._startRelay();
          const t = setTimeout(() => {
            off();
            reject(new Error(why));
          }, 9000);
          const off = R.on('ready', () => {
            clearTimeout(t);
            off();
            resolve();
          });
        };
        if (!peerAvailable()) return fallback('offline');
        const peer = new window.Peer(PREFIX + this.code, PEER_OPTS);
        this.peer = peer;
        to = setTimeout(() => fallback('timeout'), 12000);
        peer.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(to);
          this._startRelay(); // the code is ours now, so answer relayed joiners too
          resolve();
        });
        peer.on('error', (err) => {
          if (!settled) {
            if (err.type !== 'unavailable-id') return fallback(err.type || 'error');
            settled = true;
            clearTimeout(to);
            reject(new Error('taken'));
            return;
          }
          // After open, errors are usually about individual links; log only.
          console.warn('[net host] peer error', err.type, err);
        });
        peer.on('connection', (conn) => this._onConn(conn));
        peer.on('disconnected', () => {
          // Lost the signalling server (not the players). Re-register so late
          // joiners and rejoiners can still reach this room code.
          if (this.closed) return;
          this.emit('signal', 'lost');
          setTimeout(() => {
            if (!this.closed && peer.disconnected && !peer.destroyed) {
              try {
                peer.reconnect();
              } catch (e) {}
            }
          }, 1500);
        });
        peer.on('open', () => this.emit('signal', 'ok'));
      });
    }

    _startRelay() {
      if (!this.relay && G.Relay) {
        this.relay = new G.Relay.RelayHost(this.code, this.opts);
        this.relay.on('connection', (c) => this._onConn(c)); // each relayed joiner is its own link
        this.relay.on('request', (r) => this.emit('request', r)); // "let me in" from the server list (private rooms)
        this.relay.start();
      }
      return this.relay;
    }

    _onConn(conn) {
      if (conn.label !== 'ctrl' && conn.label !== 'fast') return conn.close();
      let L = this.links.get(conn.peer);
      if (!L || L.dead) {
        const now = performance.now();
        L = { id: conn.peer, ctrl: null, fast: null, conns: [], rev: {}, pid: null, born: now, lastSeen: now, rtt: 0, dead: false };
        this.links.set(conn.peer, L);
      }
      this._wire(L, conn);
      if (conn.relay || !this.peer) return; // relayed channels are already open
      // REVERSE DIAL. In theory WebRTC connects the same whichever side calls,
      // but real firewalls aren't symmetric. Players saw a PC join a
      // Chromebook host fine while the Chromebook timed out joining the PC's
      // room. So if the joiner's call hasn't opened after a few seconds, the
      // host calls the joiner on the same channel; whichever opens first
      // carries the traffic.
      const label = conn.label;
      setTimeout(() => {
        if (this.closed || L.dead || L.rev[label] || (L[label] && L[label].open)) return;
        try {
          const r = this.peer.connect(conn.peer, { label, reliable: label === 'ctrl', serialization: 'json' });
          if (r) this._wire(L, (L.rev[label] = r));
        } catch (e) {}
      }, REVERSE_AFTER);
    }

    // While a link is being set up it can hold two connections per channel
    // (the joiner's call and our reverse call). L.ctrl / L.fast always point
    // at the one that opened first; a spare failing is harmless.
    _wire(L, conn) {
      const label = conn.label;
      L.conns.push(conn);
      if (!L[label]) L[label] = conn;
      conn.on('open', () => {
        if (!L[label] || !L[label].open) L[label] = conn;
      });
      conn.on('data', (d) => {
        L.lastSeen = performance.now();
        this._onData(L, label, d);
      });
      const gone = (why) => {
        conn._ssGone = true;
        if (L[label] !== conn) return;
        const alt = L.conns.find((c) => c !== conn && c.label === label && !c._ssGone && c.open);
        if (alt) L[label] = alt;
        else if (L.pid) this._drop(L, why);
        // (v5.5.5: a link that never got a player and has nothing left open -
        // a relay route the joiner didn't pick - goes now, not after 25 s)
        else if (!L.conns.some((c) => !c._ssGone)) this._drop(L, why);
        else L[label] = L.conns.find((c) => c !== conn && c.label === label && !c._ssGone) || null; // still connecting: tick() times it out
      };
      conn.on('close', () => gone('close'));
      conn.on('error', (e) => {
        // (a message PeerJS refused to send is not a dead link - see split)
        if (e && e.type === 'message-too-big') return console.warn('[net host] message too big', L.pid);
        gone('error');
      });
    }

    _onData(L, label, d) {
      if (!d || typeof d !== 'object' || typeof d.t !== 'string') return; // never trust the wire
      if (label === 'ctrl') {
        if (d.t === 'part') {
          const whole = joinPart(L, d);
          if (whole) this._onData(L, label, whole);
          return;
        }
        if (d.t === 'hello') {
          if (d.proto !== PROTO) {
            this._sendRaw(L.ctrl, { t: 'reject', reason: 'Version mismatch — reload the page.' });
            return;
          }
          // v5.5.5: which version they run, and whether they can take a big
          // message in parts (5.5.4 and older can't)
          L.parts = !!d.parts;
          L.ver = typeof d.v === 'string' ? d.v.slice(0, 12) : '';
          this.emit('hello', L, d); // game layer answers with bind()+welcome or reject
          return;
        }
        if (d.t === 'ping') {
          this._sendRaw(L.ctrl, { t: 'pong', c: d.c, h: performance.now() });
          if (typeof d.rtt === 'number') L.rtt = d.rtt;
          return;
        }
        if (!L.pid) return; // must complete hello first
        this.emit('ctrl', L.pid, d);
      } else {
        if (!L.pid) return;
        this.emit('fast', L.pid, d);
      }
    }

    // Associate a link with a player (after hello was accepted). If that
    // player already had a link (a stale one from before a crash), kill it.
    bind(L, pid) {
      const old = this.byPid.get(pid);
      if (old && old !== L) {
        // Tell the displaced connection BEFORE closing it, so it stops
        // auto-reconnecting (otherwise two tabs ping-pong over one seat).
        // pid is cleared first so the drop doesn't mark the player offline.
        this._sendRaw(old.ctrl, { t: 'kicked', reason: 'Your seat was taken over by a newer connection (another tab or device).' });
        old.pid = null;
        setTimeout(() => this._drop(old, 'replaced'), 250);
      }
      L.pid = pid;
      this.byPid.set(pid, L);
    }

    reject(L, reason) {
      this._sendRaw(L.ctrl, { t: 'reject', reason });
      setTimeout(() => this._drop(L, 'rejected'), 300);
    }

    _sendRaw(conn, msg) {
      if (conn && conn.open) {
        try {
          conn.send(msg);
          return true;
        } catch (e) {
          console.warn('[net host] send failed', e);
        }
      }
      return false;
    }
    sendCtrl(pid, msg) {
      const L = this.byPid.get(pid);
      if (!L) return false;
      const c = L.ctrl;
      const ps = c && !c.relay ? split(msg) : null; // (the relay carries any size)
      if (!ps) return this._sendRaw(c, msg);
      if (!L.parts) {
        // an older game: it can't put parts back together, and PeerJS won't
        // send the message whole. Tell them to reload rather than let them
        // drop and rejoin for ever.
        if (!L.outdated) {
          L.outdated = true;
          this._sendRaw(c, { t: 'kicked', reason: OUTDATED });
          setTimeout(() => this._drop(L, 'outdated'), 400);
        }
        return false;
      }
      let ok = true;
      for (const part of ps) ok = this._sendRaw(c, part) && ok;
      return ok;
    }
    sendFast(pid, msg) {
      const L = this.byPid.get(pid);
      if (!L || backlogged(L.fast)) return false;
      return this._sendRaw(L.fast, msg);
    }
    broadcastCtrl(msg) {
      for (const pid of this.byPid.keys()) this.sendCtrl(pid, msg);
    }
    connectedPids() {
      return Array.from(this.byPid.keys());
    }
    rtt(pid) {
      const L = this.byPid.get(pid);
      return L ? L.rtt : 0;
    }
    // Which way this player's traffic goes. A relayed link crosses a public
    // MQTT broker that rate-limits, so the race sends it fewer snapshots.
    route(pid) {
      const L = this.byPid.get(pid);
      return L && L.fast && L.fast.relay ? 'relay' : 'direct';
    }

    _drop(L, why) {
      if (L.dead) return;
      L.dead = true;
      for (const c of L.conns) {
        try {
          c.close();
        } catch (e) {}
      }
      if (this.links.get(L.id) === L) this.links.delete(L.id);
      if (L.pid && this.byPid.get(L.pid) === L) {
        this.byPid.delete(L.pid);
        this.emit('leave', L.pid, why);
      }
    }

    // Host kicked a player: close their link.
    dropPid(pid) {
      const L = this.byPid.get(pid);
      if (L) this._drop(L, 'kicked');
    }

    // Called every frame: drop links that have gone silent (10 s), or that are
    // still being set up after 25 s. (It used to be 10 s from the first knock
    // for everyone, which killed slow handshakes before they could finish.)
    tick(now) {
      // Same rule from the other end: a host that stalls (building its own
      // track, a GC pause on a slow machine) has not been ignored by its
      // players, it just wasn't running. Without this it dropped everyone's
      // seat at the start of a race and they all came back as new joiners.
      const gap = now - (this._tickT == null ? now : this._tickT);
      this._tickT = now;
      if (gap > STALL_MS) {
        for (const L of this.links.values()) {
          L.lastSeen += gap;
          L.born += gap;
        }
        this.stalls = (this.stalls || 0) + 1;
      }
      for (const L of Array.from(this.links.values())) {
        // (a joiner waiting for the host to accept them — private rooms —
        // keeps pinging, so it gets the same 10 s silence rule as a player)
        if (L.pid || L.waiting ? now - L.lastSeen > SILENT_MS : now - L.born > 25000) this._drop(L, 'timeout');
      }
      if (this.relay) this.relay.pump(now);
    }

    close() {
      this.closed = true;
      for (const L of Array.from(this.links.values())) this._drop(L, 'host-closed');
      if (this.relay) this.relay.close();
      if (this.peer) this.peer.destroy();
    }
  }

  // Network-conditions simulator for testing reconciliation on a LAN/loopback:
  //   index.html?lag=120&jitter=40&loss=0.05   (client side only)
  // lag/jitter delay both directions (ms each way); loss drops FAST packets only
  // (ctrl is reliable by contract, so we only delay it — never reorder it).
  const SIMNET = (() => {
    const q = new URLSearchParams(location.search);
    // forcerev: make this client's own calls unable to connect, to test the
    // host's reverse dial on one machine. forcerelay: skip WebRTC entirely and
    // join through the backup relay straight away.
    return { lag: +(q.get('lag') || 0), jitter: +(q.get('jitter') || 0), loss: +(q.get('loss') || 0), forceRev: q.has('forcerev'), forceRelay: q.has('forcerelay') };
  })();
  G.NetSim = SIMNET; // (adjustable at runtime by the test tools)
  let _ctrlClock = 0; // keeps delayed ctrl messages in order
  function simDeliver(fast, fn) {
    if (!SIMNET.lag && !SIMNET.jitter && !SIMNET.loss) return fn();
    if (fast && Math.random() < SIMNET.loss) return;
    let d = SIMNET.lag + (Math.random() * 2 - 1) * SIMNET.jitter;
    if (!fast) {
      d = Math.max(d, _ctrlClock - performance.now() + 1);
      _ctrlClock = performance.now() + d;
    }
    setTimeout(fn, Math.max(0, d));
  }

  // =================================================================== CLIENT
  class NetClient extends U.Emitter {
    constructor(code) {
      super();
      this.code = code;
      this.rtt = 0;
      this.lastHeard = performance.now();
      this.closed = false;
      this.open = false;
    }

    // Opens both channels to the host. Resolves when BOTH are open on the same
    // route: the direct WebRTC link, or the backup relay (relay.js) if the
    // direct link hasn't opened after RELAY_AFTER or the matchmaking server
    // can't help. Emits 'status' 'relay' when it starts trying the relay;
    // this.via says which route won ('direct' | 'relay').
    connect() {
      return new Promise((resolve, reject) => {
        const usePeer = peerAvailable() && !SIMNET.forceRelay;
        const relay = G.Relay ? new G.Relay.RelayJoin(this.code) : null;
        if (!usePeer && !relay) return reject(new Error('PeerJS failed to load (offline?)'));
        this.relayJ = relay;
        let settled = false;
        let found = false; // matchmaking server answered, and no "room not found"
        // code 'gone': the matchmaking server says the room's host no longer
        // exists and it didn't answer on the relay either - the one failure
        // that means the room is really gone, not that OUR network is bad
        const fail = (msg, code) => {
          if (settled) return;
          settled = true;
          clearTimeout(to);
          clearTimeout(knockT);
          this.close();
          const e = new Error(msg);
          e.code = code || 'net';
          reject(e);
        };
        const why = () => {
          const relayOk = relay && relay.reached > 0;
          if (found)
            return relayOk
              ? `Found room ${this.code}, but couldn't link to the host, directly or through the backup relay. Make sure you both have the latest version (reload the page), then try again.`
              : `Found room ${this.code}, but this network blocks both the direct link and the backup relay. Try a phone hotspot, or turn off any VPN.`;
          return relayOk
            ? `Room ${this.code} didn't answer. Check the code, and that the host has reloaded to the latest version.`
            : "Couldn't reach the matchmaking server (0.peerjs.com) or the backup relay. The network may block them.";
        };
        const to = setTimeout(() => fail(why()), JOIN_TIMEOUT);
        const knock = () => {
          if (!relay || settled || relay.knocking) return;
          relay.knock();
          this.emit('status', 'relay');
        };
        // v5.5: this tab has been in this room before and the direct link
        // couldn't be made (a school Wi-Fi): knock on the relay straight
        // away on a reconnect instead of waiting RELAY_AFTER to find out
        // again. The direct attempt still runs alongside it. (Per tab and
        // per room code, never saved beyond the tab.)
        const hintKey = 'ss.route.' + this.code;
        let hint = null;
        try {
          hint = sessionStorage.getItem(hintKey);
        } catch (e) {}
        const knockT = setTimeout(knock, usePeer && hint !== 'relay' ? RELAY_AFTER : 0);

        // Channels arrive from up to three places: our own WebRTC call and the
        // host's reverse call (both route 'direct', see NetHost._onConn), and
        // the relay (one route per broker). ctrl and fast must share a route,
        // because the host keeps a separate link per route. The first route
        // with both open wins; every other channel is closed.
        const routes = {};
        const all = [];
        // v5.5.5: two direct channels with one label can open - our own call
        // and the host's reverse call (NetHost._onConn) - and each end took
        // whichever opened first ON ITS OWN SIDE. They could take different
        // ones: the host then sent the welcome and the room's state down a
        // channel this end ignored and closed, so a slow device (a handshake
        // over 5 s is what brings the reverse call) waited out the welcome,
        // gave up, tried again, and again. Now every open channel of the
        // route we use is listened to, a second one stays open as a spare,
        // and if the one we send on closes we move to the spare.
        this._alts = [];
        const spare = (label) => this._alts.find((x) => x.label === label && x.open && x !== this[label]);
        const win = (kind) => {
          settled = true;
          clearTimeout(to);
          clearTimeout(knockT);
          const r = routes[kind];
          this.ctrl = r.ctrl;
          this.fast = r.fast;
          this._alts = (r.spares || []).slice();
          this.via = kind === 'direct' ? 'direct' : 'relay';
          try {
            sessionStorage.setItem(hintKey, this.via);
          } catch (e) {}
          for (const c of all) {
            if (c === r.ctrl || c === r.fast || this._alts.includes(c)) continue;
            // (a channel of this same route still opening - the host's
            // reverse call - is kept: it becomes the spare when it opens)
            if (c._route === kind && !c.open) {
              this._alts.push(c);
              continue;
            }
            try {
              c.close();
            } catch (e) {}
          }
          if (this.via === 'relay') {
            relay.keep(r.ctrl.bid);
            if (this.peer) {
              try {
                this.peer.destroy();
              } catch (e) {}
              this.peer = null;
            }
          } else if (relay) {
            relay.close();
            this.relayJ = null;
          }
          this.open = true;
          this.lastHeard = performance.now();
          this._startPing();
          resolve();
        };
        const use = (c, kind) => {
          const label = c.label;
          if (label !== 'ctrl' && label !== 'fast') return c.close();
          all.push(c);
          c._route = kind;
          const r = (routes[kind] = routes[kind] || { ctrl: null, fast: null });
          c.on('open', () => {
            if (settled) {
              // a late channel on the route we're using: keep it as a spare
              if (this.open && this.via === 'direct' && kind === 'direct') return this._alts.includes(c) || this._alts.push(c);
              return c.close();
            }
            if (r[label]) return (r.spares = r.spares || []).push(c);
            r[label] = c;
            if (r.ctrl && r.fast) win(kind);
          });
          c.on('data', (d) => {
            if (this[label] !== c && !this._alts.includes(c)) return;
            simDeliver(label === 'fast', () => {
              this.lastHeard = performance.now();
              if (!d || typeof d !== 'object') return;
              if (label === 'ctrl' && d.t === 'pong') {
                this.rtt = U.lerp(this.rtt || performance.now() - d.c, performance.now() - d.c, 0.3);
                return;
              }
              if (label === 'ctrl' && d.t === 'part') {
                const whole = joinPart(this, d);
                if (whole) this.emit('ctrl', whole);
                return;
              }
              this.emit(label, d);
            });
          });
          const gone = (why) => {
            if (this[label] !== c) return;
            const alt = spare(label);
            if (alt) this[label] = alt;
            else this._lost(why);
          };
          c.on('close', () => gone('closed'));
          // (a message PeerJS refused to send is not a dead link)
          c.on('error', (e) => (e && e.type === 'message-too-big' ? console.warn('[net client] message too big') : gone('error')));
        };

        if (relay) {
          relay.on('connection', (c) => use(c, 'relay:' + c.bid));
          relay.start(); // connect to the brokers now, so a knock goes out instantly
        }
        if (!usePeer) return;
        const peer = new window.Peer(PEER_OPTS);
        this.peer = peer;
        const target = PREFIX + this.code;
        peer.on('error', (err) => {
          if (settled) return console.warn('[net client] peer error', err.type);
          if (err.type === 'peer-unavailable') {
            found = false;
            if (!relay) return fail('Room not found', 'gone');
            // A host that couldn't reach the matchmaking server may still be on the relay.
            knock();
            setTimeout(() => fail('Room not found', 'gone'), 5000);
          } else {
            if (!relay) return fail('Network error: ' + (err.type || 'unknown'));
            knock(); // matchmaking trouble: the relay may still get through
          }
        });
        peer.on('connection', (c) => (c.peer === target ? use(c, 'direct') : c.close()));
        peer.on('open', () => {
          found = true;
          for (const label of ['ctrl', 'fast']) {
            const c = peer.connect(target, { label, reliable: label === 'ctrl', serialization: 'json' });
            if (SIMNET.forceRev && c.peerConnection) {
              try {
                c.peerConnection.setConfiguration({ iceServers: [], iceTransportPolicy: 'relay' });
              } catch (e) {}
            }
            use(c, 'direct');
          }
        });
      });
    }

    // Keep-alive. Driven from the game tick (pump), which the App's Worker
    // ticker keeps running even in a hidden tab. A plain setInterval here got
    // throttled to once a MINUTE after 5 minutes in the background, and the
    // host drops links silent for 10 s — so a player who alt-tabbed during the
    // intermission lost their connection. The interval is only a fallback.
    _startPing() {
      this._lastPing = 0;
      this.pingT = setInterval(() => this.pump(performance.now()), 1000);
    }
    pump(now) {
      if (this.relayJ) this.relayJ.pump(now);
      // A big gap between pumps means OUR main thread was blocked - building a
      // track takes seconds on a Chromebook - not that the host went quiet. We
      // could not have heard anything while we were not running, so that time
      // is not silence and must not count towards the timeout.
      // This was the race-start disconnect loop: every race the client stalled
      // building the track, declared the host lost, reconnected, was sent the
      // state, built the track again, and stalled again. Meanwhile the host's
      // own 10 s rule was dropping the seat from the other end.
      const gap = now - (this._pumpT == null ? now : this._pumpT);
      this._pumpT = now;
      if (gap > STALL_MS) {
        this.lastHeard += gap;
        this.stalls = (this.stalls || 0) + 1;
      }
      if (!this.open || now - this._lastPing < 1000) return;
      this._lastPing = now;
      this.sendCtrl({ t: 'ping', c: now, rtt: Math.round(this.rtt) });
      // Host silent for 10 s -> treat as lost (tab crashed, network died).
      // (v5.5.4: 6 s. School Wi-Fi stalls for longer than that and then
      // recovers by itself - the link was fine - and every one of those was
      // turning into a full reconnect.)
      if (now - this.lastHeard > 10000) this._lost('silent');
    }

    _lost(why) {
      if (!this.open) return;
      this.open = false;
      this.emit('lost', why);
      this.close();
    }

    sendCtrl(m) {
      simDeliver(false, () => {
        if (this.ctrl && this.ctrl.open) {
          try {
            this.ctrl.send(m);
          } catch (e) {}
        }
      });
    }
    sendFast(m) {
      simDeliver(true, () => {
        if (this.fast && this.fast.open && !backlogged(this.fast)) {
          try {
            this.fast.send(m);
          } catch (e) {}
        }
      });
    }

    close() {
      this.closed = true;
      this.open = false;
      clearInterval(this.pingT);
      try {
        if (this.ctrl) this.ctrl.close();
      } catch (e) {}
      try {
        if (this.fast) this.fast.close();
      } catch (e) {}
      for (const c of this._alts || []) {
        try {
          c.close();
        } catch (e) {}
      }
      if (this.relayJ) this.relayJ.close(); // after the channels, so their goodbyes go out first
      try {
        if (this.peer) this.peer.destroy();
      } catch (e) {}
    }
  }

  // Can we go online at all? (PeerJS loaded, or at least the relay.)
  const available = () => peerAvailable() || !!G.Relay;

  G.Net = { NetHost, NetClient, PREFIX, PROTO, peerAvailable, available, SIMNET, split, joinPart, PART_MAX };
})(window.G);
