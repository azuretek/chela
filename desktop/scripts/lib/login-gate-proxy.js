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

// How long an upstream request may go without an answer before the browser's
// request is failed instead of held. The assets are local, so a real answer is
// milliseconds: anything near this is a gateway that is not going to answer, and
// holding the browser's request on it holds the page open with it.
export const UPSTREAM_TIMEOUT_MS = 15000;

export function createLoginGateProxy({ upstreamHost = '127.0.0.1', upstreamPort = 18995, upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
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
      // `pipe` ends the browser's response on the upstream's `end`, and ONLY there:
      // an upstream response that is aborted, reset or cut short emits `aborted` /
      // `close` with no `end`, and without this the browser's request is held open
      // forever. A load-blocking one holds the whole page's load with it, which is
      // how a client sees a page that never stops loading and a harness bound that
      // sits BETWEEN samples never gets to run.
      const finish = () => { if (!res.writableEnded) res.end(); };
      answer.on('aborted', finish);
      answer.on('error', finish);
      answer.on('close', finish);
    });
    // A gateway that accepts a request and never answers must not hold the browser's
    // request either: bound it, and fail the request when the clock trips.
    out.setTimeout(upstreamTimeoutMs, () => out.destroy(new Error('no upstream answer within ' + upstreamTimeoutMs + 'ms')));
    out.on('error', () => { if (!res.writableEnded) res.destroy(); });
    req.on('error', () => out.destroy());
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
    /** The address it is actually listening on, for a test that asked for port 0. */
    address() { return server.address(); },
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
