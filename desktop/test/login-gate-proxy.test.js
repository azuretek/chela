// The login-gate proxy's HTTP forwarding (scripts/lib/login-gate-proxy.js).
//
// Plain `node --test`, real sockets, no Electron. The shape that left
// login-gate-cover-gate's Control UI "still loading" until the 120s watchdog: the
// browser's request is held open on an upstream that never answers, or on an
// upstream response that is cut short after the headers. A load-blocking request
// held open holds the whole page's load with it, and a harness bound that sits
// BETWEEN samples never gets to run.
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

import { createLoginGateProxy } from '../scripts/lib/login-gate-proxy.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** GET the proxy and settle on end, abort or error, never hang the test on a held response. */
function get(port, path = '/') {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('aborted', () => resolve({ aborted: true }));
      res.on('error', (err) => resolve({ error: err.message }));
    });
    req.on('error', (err) => resolve({ error: err.message }));
  });
}

/** Read the proxy, but give up after `ms` so a held response is a FAILURE, not a wait. */
const readOrHang = (port, ms = 1500) =>
  Promise.race([get(port), new Promise((resolve) => setTimeout(() => resolve({ hung: true }), ms).unref())]);

test('a gateway that accepts a request and never answers fails it instead of holding it', async () => {
  const upstream = http.createServer(() => { /* accepted, never answered */ });
  const up = await listen(upstream);
  const proxy = createLoginGateProxy({ upstreamPort: up, upstreamTimeoutMs: 50 });
  await proxy.listen(0);
  const answer = await readOrHang(proxy.address().port);
  assert.ok(!answer.hung, 'the browser\'s request was held open on an upstream that never answered');
  await proxy.close();
  upstream.close();
});

test('an upstream response cut short after the headers ends the browser\'s request', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.write('partial');
    // Cut the connection with no end(): what a gateway that goes away mid-body does.
    setTimeout(() => res.destroy(), 20);
  });
  const up = await listen(upstream);
  const proxy = createLoginGateProxy({ upstreamPort: up });
  await proxy.listen(0);
  const answer = await readOrHang(proxy.address().port);
  assert.ok(!answer.hung, 'the browser\'s request was held open on a truncated upstream response');
  assert.ok(answer.aborted || answer.error || answer.body === 'partial', JSON.stringify(answer));
  await proxy.close();
  upstream.close();
});

test('an ordinary request is still forwarded whole', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello ' + req.url);
  });
  const up = await listen(upstream);
  const proxy = createLoginGateProxy({ upstreamPort: up });
  await proxy.listen(0);
  const answer = await readOrHang(proxy.address().port, 2000);
  assert.deepStrictEqual(answer, { status: 200, body: 'hello /' });
  await proxy.close();
  upstream.close();
});
