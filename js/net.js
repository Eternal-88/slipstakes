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
//                              client after 10 s of silence, clients declare
//                              the host lost after 6 s.
'use strict';
(function (G) {
  const U = G.U;
  const PREFIX = 'slipstakes-v1-';
  const PROTO = 7; // bump when message formats change; mismatched clients are rejected (4: tuning/looks, brake temp; 5: v4 nitrous input, slipstream/catch-up state, 4-bit surfaces; 6: v4.3 join requests, host migration, traction control in the setup; 7: v4.4 private-room asks via the list, "room closed")
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
  const JOIN_TIMEOUT = 22000; // client gives up (covers all three routes)

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
        else L[label] = L.conns.find((c) => c !== conn && c.label === label && !c._ssGone) || null; // still connecting: tick() times it out
      };
      conn.on('close', () => gone('close'));
      conn.on('error', () => gone('error'));
    }

    _onData(L, label, d) {
      if (!d || typeof d !== 'object' || typeof d.t !== 'string') return; // never trust the wire
      if (label === 'ctrl') {
        if (d.t === 'hello') {
          if (d.proto !== PROTO) {
            this._sendRaw(L.ctrl, { t: 'reject', reason: 'Version mismatch — reload the page.' });
            return;
          }
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
      return L ? this._sendRaw(L.ctrl, msg) : false;
    }
    sendFast(pid, msg) {
      const L = this.byPid.get(pid);
      return L ? this._sendRaw(L.fast, msg) : false;
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
      for (const L of Array.from(this.links.values())) {
        // (a joiner waiting for the host to accept them — private rooms —
        // keeps pinging, so it gets the same 10 s silence rule as a player)
        if (L.pid || L.waiting ? now - L.lastSeen > 10000 : now - L.born > 25000) this._drop(L, 'timeout');
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
        const fail = (msg) => {
          if (settled) return;
          settled = true;
          clearTimeout(to);
          clearTimeout(knockT);
          this.close();
          reject(new Error(msg));
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
        const knockT = setTimeout(knock, usePeer ? RELAY_AFTER : 0);

        // Channels arrive from up to three places: our own WebRTC call and the
        // host's reverse call (both route 'direct', see NetHost._onConn), and
        // the relay (one route per broker). ctrl and fast must share a route,
        // because the host keeps a separate link per route. The first route
        // with both open wins; every other channel is closed.
        const routes = {};
        const all = [];
        const win = (kind) => {
          settled = true;
          clearTimeout(to);
          clearTimeout(knockT);
          const r = routes[kind];
          this.ctrl = r.ctrl;
          this.fast = r.fast;
          this.via = kind === 'direct' ? 'direct' : 'relay';
          for (const c of all) {
            if (c === r.ctrl || c === r.fast) continue;
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
          const r = (routes[kind] = routes[kind] || { ctrl: null, fast: null });
          c.on('open', () => {
            if (settled || r[label]) return c.close();
            r[label] = c;
            if (r.ctrl && r.fast) win(kind);
          });
          c.on('data', (d) => {
            if (this[label] !== c) return;
            simDeliver(label === 'fast', () => {
              this.lastHeard = performance.now();
              if (!d || typeof d !== 'object') return;
              if (label === 'ctrl' && d.t === 'pong') {
                this.rtt = U.lerp(this.rtt || performance.now() - d.c, performance.now() - d.c, 0.3);
                return;
              }
              this.emit(label, d);
            });
          });
          c.on('close', () => this[label] === c && this._lost('closed'));
          c.on('error', () => this[label] === c && this._lost('error'));
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
            if (!relay) return fail('Room not found');
            // A host that couldn't reach the matchmaking server may still be on the relay.
            knock();
            setTimeout(() => fail('Room not found'), 5000);
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
      if (!this.open || now - this._lastPing < 1000) return;
      this._lastPing = now;
      this.sendCtrl({ t: 'ping', c: now, rtt: Math.round(this.rtt) });
      // Host silent for 6 s -> treat as lost (tab crashed, network died).
      if (now - this.lastHeard > 6000) this._lost('silent');
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
        if (this.fast && this.fast.open) {
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
      if (this.relayJ) this.relayJ.close(); // after the channels, so their goodbyes go out first
      try {
        if (this.peer) this.peer.destroy();
      } catch (e) {}
    }
  }

  // Can we go online at all? (PeerJS loaded, or at least the relay.)
  const available = () => peerAvailable() || !!G.Relay;

  G.Net = { NetHost, NetClient, PREFIX, PROTO, peerAvailable, available, SIMNET };
})(window.G);
