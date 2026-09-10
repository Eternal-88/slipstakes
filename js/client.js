// client.js — ClientSession: this browser's view of the session.
// Holds the latest public state from the host and sends actions to it. When
// this browser IS the host (or single-player), actions go straight into the
// local HostSession through a loopback — the same code path as a remote
// client, just without the wire.
'use strict';
(function (G) {
  const U = G.U;

  class ClientSession extends U.Emitter {
    constructor() {
      super();
      this.state = null;
      this.meId = null;
      this.host = null; // HostSession when local
      this.net = null; // NetClient when remote
    }

    _unsub() {
      if (this._offs) this._offs.forEach((f) => f());
      this._offs = null;
    }

    connectLocal(host, meId) {
      this._unsub(); // e.g. switching from the sandbox to a hosted session
      this.host = host;
      this.net = null;
      this.meId = meId;
      this._offs = [
        host.on('state', (s) => this._state(s)),
        host.on('toPlayer', (pid, m) => {
          if (pid === this.meId) this._msg(m);
        }),
        host.on('broadcast', (m) => this._msg(m)),
      ];
      host.dirty = true;
      host.flush();
    }

    connectRemote(net, meId) {
      this._unsub();
      this.host = null;
      this.net = net;
      this.meId = meId;
    }

    disconnect() {
      if (this._offs) this._offs.forEach((f) => f());
      this._offs = null;
      this.host = null;
      this.net = null;
      this.state = null;
    }

    act(m) {
      if (this.host) this.host.handle(this.meId, m);
      else if (this.net) this.net.sendCtrl(m);
    }

    get me() {
      return this.state ? this.state.players[this.meId] : null;
    }
    get isHost() {
      return !!this.host;
    }

    // Host clock estimate. Every state carries the host's Date.now() at send
    // time; phase/casino deadlines are in host time, so a client laptop whose
    // clock is off by 40 s still shows the right countdown. (Ignores one-way
    // latency: ~50 ms, irrelevant for second-resolution timers.)
    hostNow() {
      return Date.now() + (this.clockOffset || 0);
    }

    _state(s) {
      if (s && s.now) {
        const off = s.now - Date.now();
        this.clockOffset = this.clockOffset == null ? off : this.clockOffset + (off - this.clockOffset) * 0.2;
      }
      this.state = s;
      this.emit('state', s);
    }
    _msg(m) {
      if (m.t === 'toast' && G.UI) G.UI.toast(m.msg, m.kind);
      this.emit('msg', m);
    }
  }

  G.ClientSession = ClientSession;
})(window.G);
