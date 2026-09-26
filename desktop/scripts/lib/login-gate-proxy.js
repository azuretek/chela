// An app-only proxy in front of a real gateway that can refuse or delay the
// page's gateway socket while it still serves the page.
//
// It is how the Control UI's OWN login gate ("Gateway unreachable") is reached on
// purpose: the page loads, its socket is refused, and the page draws the gate. The
// proxy is this test's alone, so nothing else on the host is rerouted; a client is
// pointed at it by its own gateway address. Used by scripts/test-login-gate-connect.js
// in-process, and as a small server (scripts/login-gate-proxy.js) by the iOS
// LoginGateConnectUITests, which switches it through the control port.
//
// The gateway's Control UI must allow the proxy's origin in
// gateway.controlUi.allowedOrigins.

import http from 'node:http';
import net from 'node:net';

export function createLoginGateProxy({ upstreamHost = '127.0.0.1', upstreamPort = 18995 } = {}) {
  const state = { socket: 'pass', delay: 0 };
  // How many sockets were refused: proof the page loaded and tried to connect,
  // so a client test can tell the gate was reached rather than the page never
  // loading at all.
  let refused = 0;
  const upgraded = new Set();
  // Every connection the proxy holds, either side: close() ends them all, because
  // server.close() waits on any the page still has open, and a page that keeps
  // retrying (the refused case) always has one, so a close that waited on it
  // never returned (measured 2026-09-25 on the Linux runner: every check passed,
  // then the harness sat in close() until its 120s backstop).
  const open = new Set();
  const hold = (s) => { open.add(s); s.on('close', () => open.delete(s)); };
  const server = http.createServer((req, res) => {
    const out = http.request({ host: upstreamHost, port: upstreamPort, path: req.url, method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    out.on('error', () => res.destroy());
    req.pipe(out);
  });
  server.on('connection', hold);
  server.on('upgrade', (req, socket, head) => {
    if (state.socket === 'refuse') { refused += 1; socket.destroy(); return; }
    const forward = () => {
      const up = net.connect(upstreamPort, upstreamHost, () => {
        let raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
        for (let i = 0; i < req.rawHeaders.length; i += 2) raw += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
        up.write(raw + '\r\n');
        if (head && head.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      hold(up);
      upgraded.add(socket);
      socket.on('close', () => upgraded.delete(socket));
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    };
    if (state.delay) setTimeout(forward, state.delay); else forward();
  });
  return {
    /** Refuse every new socket, or pass them after an optional delay. */
    set({ socket = state.socket, delay = state.delay } = {}) { state.socket = socket; state.delay = delay; },
    /** Drop every socket the proxy is carrying, which is a gateway that went away. */
    cut() { for (const s of upgraded) s.destroy(); upgraded.clear(); },
    listen(port, host = '127.0.0.1') { return new Promise((resolve) => server.listen(port, host, resolve)); },
    close() {
      this.cut();
      const closed = new Promise((resolve) => server.close(() => resolve()));
      for (const s of open) s.destroy();
      open.clear();
      return closed;
    },
    get state() { return { ...state, refused }; },
  };
}

/** Whether the upstream answers HTTP at all. */
export function upstreamAnswers(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const probe = http.get({ host, port, path: '/' }, (r) => { r.resume(); resolve(r.statusCode < 500); });
    probe.on('error', () => resolve(false));
    probe.setTimeout(timeoutMs, () => { probe.destroy(); resolve(false); });
  });
}
