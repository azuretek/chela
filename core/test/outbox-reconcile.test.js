// The outbox reconcile, driven the way the page drives it.
//
// The script is the one both clients install, read from spec/outbox-reconcile.json
// rather than restated here. It runs against a fake window, socket, storage and
// clock: the Control UI's own code is not what is under test, what the script
// reads from the page's outbox and says to the gateway is. Every case below is an
// assertion about the stored outbox or a frame that reached the socket.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { RECONCILE_GLOBAL, reconcileScript } from '../outbox-reconcile.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.join(HERE, '..', 'spec', 'outbox-reconcile.json');
const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));

const STORE_KEY = 'openclaw.control.chatComposer.v4:wss%3A%2F%2Fgateway.test';
const SESSION = 'agent:main:dashboard:proof';
const ENTRY = SESSION + '\u0000agent:main';

function fakeStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

// A gateway that answers the script's requests from a record the case sets up.
function fakeGateway() {
  const gateway = { record: { messages: [], pendingInputs: { items: [] }, sessionInfo: { hasActiveRun: false, status: 'done' } }, sends: [], requests: [] };
  gateway.answer = (frame) => {
    gateway.requests.push(frame);
    if (frame.method === 'chat.history') return { type: 'res', id: frame.id, ok: true, payload: gateway.record };
    if (frame.method === 'chat.send') { gateway.sends.push(frame.params); return { type: 'res', id: frame.id, ok: true, payload: { runId: frame.params.idempotencyKey, status: 'started' } }; }
    return { type: 'res', id: frame.id, ok: false, error: { message: 'unknown' } };
  };
  return gateway;
}

function install({ gateway = fakeGateway(), storage = fakeStorage() } = {}) {
  const clock = { t: 1_000_000 };
  class FakeDate extends Date { static now() { return clock.t; } }
  const events = [];
  const window = { location: { href: 'https://gateway.test/chat' }, dispatchEvent: (e) => { events.push(e); return true; } };
  class FakeStorageEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url; this.readyState = 1; this.listeners = {}; this.sent = [];
      sockets.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, data) { for (const fn of this.listeners[type] || []) fn({ data }); }
    send(data) {
      this.sent.push(data);
      const frame = JSON.parse(data);
      if (frame.type === 'req' && String(frame.id).startsWith('chela-outbox-reconcile-')) {
        const reply = gateway.answer(frame);
        queueMicrotask(() => this.emit('message', JSON.stringify(reply)));
      }
    }
  }
  FakeSocket.OPEN = 1;
  new Function('window', 'WebSocket', 'sessionStorage', 'StorageEvent', 'Date', 'setInterval', script)(
    window, FakeSocket, storage, FakeStorageEvent, FakeDate, () => 0,
  );
  const state = window[RECONCILE_GLOBAL];
  const open = () => {
    const socket = new window.WebSocket('wss://gateway.test/');
    socket.emit('message', JSON.stringify({ type: 'res', id: 'connect-1', ok: true, payload: { type: 'hello-ok' } }));
    return socket;
  };
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const pass = async (advanceMs) => { clock.t += advanceMs; state.tick(); await settle(); };
  return { window, state, storage, gateway, clock, sockets, events, open, pass, FakeSocket };
}
const script = reconcileScript();

function seed(storage, items) {
  storage.setItem(STORE_KEY, JSON.stringify({ version: 4, gatewayOwner: 'wss://gateway.test', recovery: {}, sessions: { [ENTRY]: { queue: items, updatedAt: 1 } } }));
}
function queued(storage) {
  const store = JSON.parse(storage.getItem(STORE_KEY) || '{}');
  return ((store.sessions && store.sessions[ENTRY] && store.sessions[ENTRY].queue) || []).map((item) => [item.id, item.sendState]);
}
const row = (id, sendState, extra = {}) => ({ id, text: 'message ' + id, sendRunId: 'run-' + id, sendState, sendAttempts: 1, sessionKey: SESSION, ...extra });

test('the script and its global come from the spec', () => {
  assert.strictEqual(reconcileScript(), spec.hook.join('\n'));
  assert.strictEqual(RECONCILE_GLOBAL, spec.global);
  assert.strictEqual(RECONCILE_GLOBAL, '__clawOutboxReconcile');
});

test('the page still gets a native socket, and a second install stacks nothing', () => {
  const env = install();
  const socket = new env.window.WebSocket('wss://gateway.test/');
  assert.ok(socket instanceof env.FakeSocket, 'the wrapper hands the page the native instance');
  assert.strictEqual(env.window.WebSocket.OPEN, 1);
  const wrapped = env.window.WebSocket;
  new Function('window', 'WebSocket', 'sessionStorage', 'StorageEvent', 'Date', 'setInterval', script)(env.window, wrapped, env.storage, class {}, Date, () => 0);
  assert.strictEqual(env.window.WebSocket, wrapped, 'the guard keeps the first install');
});

test('a waiting-reconnect row the gateway holds as pending is removed as delivered, and nothing is sent', async () => {
  const env = install();
  seed(env.storage, [row('b', 'waiting-reconnect')]);
  env.gateway.record.pendingInputs.items = [{ id: 'p1', runId: 'run-b', state: 'queued' }];
  env.gateway.record.sessionInfo = { hasActiveRun: true, status: 'running' };
  env.open();
  await env.pass(0);
  await env.pass(3000);
  assert.deepStrictEqual(queued(env.storage), [['b', 'waiting-reconnect']], 'not before the threshold');
  await env.pass(1500);
  assert.deepStrictEqual(queued(env.storage), []);
  assert.deepStrictEqual(env.gateway.sends, []);
  assert.strictEqual(env.events.length, 1, 'the page is told its store changed');
  assert.strictEqual(env.events[0].key, STORE_KEY);
});

test('a row already in the transcript is removed, keyed by its send id', async () => {
  const env = install();
  seed(env.storage, [row('c', 'unconfirmed')]);
  env.gateway.record.messages = [{ role: 'user', content: 'message c', idempotencyKey: 'run-c:user' }];
  env.open();
  await env.pass(0);
  await env.pass(4000);
  assert.deepStrictEqual(queued(env.storage), []);
  assert.deepStrictEqual(env.gateway.sends, []);
  const history = env.gateway.requests.find((f) => f.method === 'chat.history');
  assert.deepStrictEqual(history.params.inputRunIds, ['run-c']);
  assert.strictEqual(history.params.sessionKey, SESSION);
});

test('a row the gateway does not hold waits while a run is active', async () => {
  const env = install();
  seed(env.storage, [row('d', 'waiting-reconnect')]);
  env.gateway.record.sessionInfo = { hasActiveRun: true, status: 'running' };
  env.open();
  await env.pass(0);
  await env.pass(5000);
  await env.pass(5000);
  assert.deepStrictEqual(queued(env.storage), [['d', 'waiting-reconnect']]);
  assert.deepStrictEqual(env.gateway.sends, []);
});

test('a row the gateway does not hold on an idle session is sent exactly once, under its own id', async () => {
  const env = install();
  seed(env.storage, [row('e', 'waiting-reconnect')]);
  env.open();
  await env.pass(0);
  await env.pass(4000);
  assert.deepStrictEqual(env.gateway.sends, [{ sessionKey: SESSION, message: 'message e', deliver: false, idempotencyKey: 'run-e' }]);
  assert.deepStrictEqual(queued(env.storage), []);
  // The same row coming back (a page that rewrote it from memory) is never sent twice.
  seed(env.storage, [row('e', 'waiting-reconnect')]);
  await env.pass(0);
  await env.pass(5000);
  await env.pass(5000);
  assert.strictEqual(env.gateway.sends.length, 1);
});

test('the once-only record survives a reload', async () => {
  const storage = fakeStorage();
  const first = install({ storage });
  seed(storage, [row('f', 'unconfirmed')]);
  first.open();
  await first.pass(0);
  await first.pass(4000);
  assert.strictEqual(first.gateway.sends.length, 1);
  seed(storage, [row('f', 'unconfirmed')]);
  const second = install({ storage });
  second.open();
  await second.pass(0);
  await second.pass(10000);
  assert.deepStrictEqual(second.gateway.sends, []);
});

test('a never-attempted row is left to the page for 20 seconds', async () => {
  const env = install();
  seed(env.storage, [row('g', 'waiting-idle', { sendAttempts: 0 })]);
  env.open();
  await env.pass(0);
  await env.pass(15000);
  assert.deepStrictEqual(env.gateway.requests, []);
  await env.pass(6000);
  assert.strictEqual(env.gateway.sends.length, 1);
});

test('a failed row is retried only when the gateway said to retry it', async () => {
  const env = install();
  seed(env.storage, [
    row('h', 'failed', { sendError: 'Error: session changed before chat.send; retry the request' }),
    row('i', 'failed', { sendError: 'model not allowed' }),
  ]);
  env.open();
  await env.pass(0);
  await env.pass(4000);
  await env.pass(4000);
  assert.deepStrictEqual(env.gateway.sends.map((s) => s.idempotencyKey), ['run-h']);
  assert.deepStrictEqual(queued(env.storage), [['i', 'failed']]);
});

test('a row with attachments is left for the reader', async () => {
  const env = install();
  seed(env.storage, [row('j', 'waiting-reconnect', { attachments: [{ id: 'a1' }] })]);
  env.open();
  await env.pass(0);
  await env.pass(4000);
  assert.deepStrictEqual(env.gateway.sends, []);
  assert.deepStrictEqual(queued(env.storage), [['j', 'waiting-reconnect']]);
});

test('nothing is asked before the page handshake, and a closed socket restarts every timer', async () => {
  const env = install();
  seed(env.storage, [row('k', 'waiting-reconnect')]);
  const socket = new env.window.WebSocket('wss://gateway.test/');
  await env.pass(10000);
  assert.deepStrictEqual(env.gateway.requests, [], 'no hello-ok yet');
  socket.emit('message', JSON.stringify({ type: 'res', id: 'c', ok: true, payload: { type: 'hello-ok' } }));
  await env.pass(0);
  await env.pass(3000);
  socket.readyState = 3;
  socket.emit('close');
  const next = env.open();
  await env.pass(0);
  await env.pass(3000);
  assert.deepStrictEqual(env.gateway.requests, [], 'the reconnect restarted the clock');
  await env.pass(1500);
  assert.strictEqual(env.gateway.requests[0].method, 'chat.history');
  assert.ok(next.sent.length > 0, 'the request went over the new socket');
});

test('other sessions and the page frames are left alone', async () => {
  const env = install();
  seed(env.storage, [row('l', 'sending')]);
  const socket = env.open();
  socket.send(JSON.stringify({ type: 'req', id: 'page-1', method: 'chat.send', params: { message: 'x' } }));
  await env.pass(0);
  await env.pass(30000);
  assert.deepStrictEqual(env.gateway.requests, [], 'an in-flight sending row is the page\'s');
  assert.deepStrictEqual(JSON.parse(socket.sent[0]).id, 'page-1');
});
