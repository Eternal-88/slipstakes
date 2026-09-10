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
  const PROTO = 3; // bump when message formats change; mismatched clients are rejected
  // debug 0: we handle every PeerJS error ourselves; at debug 1 the reconnect
  // loop (a retry every 3 s for up to 5 min) filled the console with ERRORs.
  const PEER_OPTS = { debug: 0 };

  function peerAvailable() {
    return typeof window.Peer === 'function';
  }

  // ===================================================================== HOST
  class NetHost extends U.Emitter {
    constructor(code) {
      super();
      this.code = code;
      this.links = new Map(); // remote peer id -> link {id, ctrl, fast, pid, lastSeen, rtt}
      this.byPid = new Map(); // player id -> link
      this.closed = false;
      this.bytesOut = 0;
    }

    // Resolves once the signalling server has registered our id. Rejects with
    // 'taken' if the room code is in use (caller picks another code).
    open() {
      return new Promise((resolve, reject) => {
        if (!peerAvailable()) return reject(new Error('offline'));
        let settled = false;
        const peer = new window.Peer(PREFIX + this.code, PEER_OPTS);
        this.peer = peer;
        const to = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('timeout'));
          }
        }, 12000);
        peer.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(to);
          resolve();
        });
        peer.on('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(to);
            reject(new Error(err.type === 'unavailable-id' ? 'taken' : err.type || 'error'));
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

    _onConn(conn) {
      let L = this.links.get(conn.peer);
      if (!L || L.dead) {
        L = { id: conn.peer, ctrl: null, fast: null, pid: null, lastSeen: performance.now(), rtt: 0, dead: false };
        this.links.set(conn.peer, L);
      }
      if (conn.label === 'ctrl') L.ctrl = conn;
      else if (conn.label === 'fast') L.fast = conn;
      else return conn.close();
      conn.on('data', (d) => {
        L.lastSeen = performance.now();
        this._onData(L, conn.label, d);
      });
      conn.on('close', () => this._drop(L, 'close'));
      conn.on('error', () => this._drop(L, 'error'));
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
      try {
        if (L.ctrl) L.ctrl.close();
      } catch (e) {}
      try {
        if (L.fast) L.fast.close();
      } catch (e) {}
      if (this.links.get(L.id) === L) this.links.delete(L.id);
      if (L.pid && this.byPid.get(L.pid) === L) {
        this.byPid.delete(L.pid);
        this.emit('leave', L.pid, why);
      }
    }

    // Called every frame: drop links that have gone silent.
    tick(now) {
      for (const L of Array.from(this.links.values())) {
        if (now - L.lastSeen > 10000) this._drop(L, 'timeout');
      }
    }

    close() {
      this.closed = true;
      for (const L of Array.from(this.links.values())) this._drop(L, 'host-closed');
      if (this.peer) this.peer.destroy();
    }
  }

  // Network-conditions simulator for testing reconciliation on a LAN/loopback:
  //   index.html?lag=120&jitter=40&loss=0.05   (client side only)
  // lag/jitter delay both directions (ms each way); loss drops FAST packets only
  // (ctrl is reliable by contract, so we only delay it — never reorder it).
  const SIMNET = (() => {
    const q = new URLSearchParams(location.search);
    return { lag: +(q.get('lag') || 0), jitter: +(q.get('jitter') || 0), loss: +(q.get('loss') || 0) };
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

    // Opens both channels to the host. Resolves when BOTH are open.
    connect() {
      return new Promise((resolve, reject) => {
        if (!peerAvailable()) return reject(new Error('PeerJS failed to load (offline?)'));
        let settled = false;
        const fail = (msg) => {
          if (settled) return;
          settled = true;
          clearTimeout(to);
          this.close();
          reject(new Error(msg));
        };
        const to = setTimeout(() => fail('Timed out reaching the host'), 15000);
        const peer = new window.Peer(PEER_OPTS);
        this.peer = peer;
        peer.on('error', (err) => {
          if (err.type === 'peer-unavailable') fail('Room not found');
          else if (!settled) fail('Network error: ' + (err.type || 'unknown'));
          else console.warn('[net client] peer error', err.type);
        });
        peer.on('open', () => {
          const target = PREFIX + this.code;
          this.ctrl = peer.connect(target, { label: 'ctrl', reliable: true, serialization: 'json' });
          this.fast = peer.connect(target, { label: 'fast', reliable: false, serialization: 'json' });
          let n = 0;
          const onOpen = () => {
            if (++n === 2 && !settled) {
              settled = true;
              clearTimeout(to);
              this.open = true;
              this.lastHeard = performance.now();
              this._startPing();
              resolve();
            }
          };
          for (const [label, c] of [['ctrl', this.ctrl], ['fast', this.fast]]) {
            c.on('open', onOpen);
            c.on('data', (d) =>
              simDeliver(label === 'fast', () => {
                this.lastHeard = performance.now();
                if (!d || typeof d !== 'object') return;
                if (label === 'ctrl' && d.t === 'pong') {
                  this.rtt = U.lerp(this.rtt || performance.now() - d.c, performance.now() - d.c, 0.3);
                  return;
                }
                this.emit(label, d);
              })
            );
            c.on('close', () => this._lost('closed'));
            c.on('error', () => this._lost('error'));
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
      try {
        if (this.peer) this.peer.destroy();
      } catch (e) {}
    }
  }

  G.Net = { NetHost, NetClient, PREFIX, PROTO, peerAvailable, SIMNET };
})(window.G);
