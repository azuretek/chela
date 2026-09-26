// The login-gate proxy as a small server, for a client this process cannot
// drive in-process (the iOS simulator's LoginGateConnectUITests).
//
//   node scripts/login-gate-proxy.js [--port 18996] [--control 18997] [--upstream 127.0.0.1:18995] [--socket refuse]
//
// GET /set?socket=refuse|pass&delay=MS on the control port switches it, and
// GET /cut drops every socket it carries. See scripts/lib/login-gate-proxy.js.

import http from 'node:http';
import { createLoginGateProxy, upstreamAnswers } from './lib/login-gate-proxy.js';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const [host, port] = arg('upstream', '127.0.0.1:18995').split(':');
if (!(await upstreamAnswers(host, Number(port)))) {
  console.error('no gateway answering at ' + host + ':' + port);
  process.exit(3);
}
const proxy = createLoginGateProxy({ upstreamHost: host, upstreamPort: Number(port) });
proxy.set({ socket: arg('socket', 'pass') });
await proxy.listen(Number(arg('port', '18996')));
const control = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://control');
  if (url.pathname === '/set') {
    proxy.set({ socket: url.searchParams.get('socket') || undefined, delay: Number(url.searchParams.get('delay') || 0) });
  } else if (url.pathname === '/cut') {
    proxy.cut();
  }
  console.log(new Date().toISOString() + ' ' + req.url + ' -> ' + JSON.stringify(proxy.state));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(proxy.state));
});
control.listen(Number(arg('control', '18997')), '127.0.0.1');
console.log('login-gate proxy on ' + arg('port', '18996') + ', control on ' + arg('control', '18997') + ', ' + JSON.stringify(proxy.state));
