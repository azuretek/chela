// The reconnect-resume shim, driven the way the page drives it.
//
// The script this file runs is the one the phone installs, read from
// spec/reconnect-resume-shim.json rather than restated here, and it is run
// against a fake window and a fake WebSocket: the page's own code is not what is
// under test, the bytes it would send are. Every case below is therefore an
// assertion about a string that reached the socket, which is the only thing the
// shim can change.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { RESERVED_PROPERTY, SHIM_GLOBAL, SHIM_METHOD, shimScript } from '../reconnect-resume-shim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const SPEC_PATH = path.join(REPO, 'core', 'spec', 'reconnect-resume-shim.json');
const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));

// A fresh socket class per case, so one case cannot leave a wrapper on the
// prototype for the next one to inherit: in the page there is one prototype and
// one install, and a test that shared it would be testing the harness.
function fakeSocketClass() {
  return class FakeSocket {
    constructor() {
      this.frames = [];
    }
    send(data) {
      this.frames.push(data);
    }
  };
}

// The script runs against the fake globals as ARGUMENTS rather than as
// properties, because the real page has them as bindings (WebSocket is a global
// there, not only window.WebSocket) and a Node run has a real WebSocket of its
// own that would otherwise be the one wrapped.
function install({ script = shimScript(), window = { location: { href: 'https://gateway.test/' } }, Socket = fakeSocketClass() } = {}) {
  new Function('window', 'WebSocket', script)(window, Socket);
  return { window, Socket, socket: new Socket() };
}

function frame(overrides = {}) {
  return { type: 'req', id: 'frame-1', method: SHIM_METHOD, params: { sessionKey: 'agent:main:main', message: 'hello' }, ...overrides };
}

function sent(socket, index = 0) {
  assert.ok(socket.frames.length > index, 'expected the wrapper to have sent something');
  return socket.frames[index];
}

test('the exported constants come from the spec, not string literals', () => {
  assert.strictEqual(RESERVED_PROPERTY, spec.reservedProperty);
  assert.strictEqual(SHIM_METHOD, spec.method);
  assert.strictEqual(SHIM_GLOBAL, spec.global);
  assert.strictEqual(shimScript(), spec.hook.join('\n'));
});

test('the reserved property is the one the Control UI sets and the gateway refuses', () => {
  // Pinned as a literal so a rename of the spec value fails here rather than in
  // the field: the string is the wire's, not ours. It is the property
  // requestChatSend in the OpenClaw checkout puts on a resumed chat.send
  // (ui/src/pages/chat/chat-send-request.ts), and the one the gateway's
  // validation rejects when its strip does not run.
  assert.strictEqual(RESERVED_PROPERTY, '__controlUiReconnectResume');
  assert.strictEqual(SHIM_METHOD, 'chat.send');
  assert.strictEqual(SHIM_GLOBAL, '__clawReconnectResumeShim');
});

test('a chat.send frame carrying the marker comes out without it', () => {
  const { socket } = install();
  const outgoing = frame({ params: { sessionKey: 'agent:main:main', __controlUiReconnectResume: true, message: 'hello' } });
  socket.send(JSON.stringify(outgoing));

  const received = sent(socket);
  assert.strictEqual(typeof received, 'string', 'the wrapper sends a string, as the page did');
  const parsed = JSON.parse(received);
  assert.ok(!(RESERVED_PROPERTY in parsed.params), 'the reserved property reached the socket');
  // Everything else about the frame is the page's and must survive untouched:
  // the id the reply is matched by, the method, and the params it did send.
  assert.strictEqual(parsed.id, 'frame-1');
  assert.strictEqual(parsed.method, 'chat.send');
  assert.strictEqual(parsed.type, 'req');
  assert.deepStrictEqual(parsed.params, { sessionKey: 'agent:main:main', message: 'hello' });
});

test('the marker is removed by presence, not by its value', () => {
  // The page only ever sets it true, and the gateway refuses the property
  // whatever it holds, so a false one is deleted too rather than left to fail
  // the same send.
  const { socket } = install();
  socket.send(JSON.stringify(frame({ params: { message: 'hello', __controlUiReconnectResume: false } })));
  assert.ok(!(RESERVED_PROPERTY in JSON.parse(sent(socket)).params));
});

test('a chat.send frame without the marker is untouched byte for byte', () => {
  const { socket } = install();
  const outgoing = JSON.stringify(frame());
  socket.send(outgoing);
  assert.strictEqual(sent(socket), outgoing, 'a frame the shim had nothing to do with came out changed');
});

test('a non-chat.send frame carrying the marker is untouched', () => {
  const { socket } = install();
  const cases = [
    JSON.stringify({ type: 'req', id: 'frame-2', method: 'chat.history', params: { __controlUiReconnectResume: true } }),
    JSON.stringify({ type: 'req', id: 'frame-3', params: { __controlUiReconnectResume: true } }),
    JSON.stringify({ type: 'event', event: 'chat.message', payload: { __controlUiReconnectResume: true } }),
    JSON.stringify({ type: 'req', id: 'frame-4', method: 'chat.send', params: ['__controlUiReconnectResume'] }),
    JSON.stringify({ type: 'req', id: 'frame-5', method: 'chat.send' }),
  ];
  for (const outgoing of cases) {
    socket.send(outgoing);
  }
  assert.deepStrictEqual(socket.frames, cases, 'the shim rewrote a frame that is not the one it exists for');
});

test('a malformed or non-JSON payload passes through unchanged', () => {
  const { socket } = install();
  const cases = [
    '{not json',
    '{"type":"req","method":"chat.send","params":',
    'plain text',
    '',
    '[]',
    'null',
    '[{"type":"req","method":"chat.send","params":{"__controlUiReconnectResume":true}}]',
  ];
  for (const outgoing of cases) {
    socket.send(outgoing);
  }
  assert.deepStrictEqual(socket.frames, cases, 'a payload the shim does not recognise was altered or dropped');
});

test('the wrapper never throws, and still sends, on a frame it half recognises', () => {
  const { socket } = install();
  const cases = [
    JSON.stringify({ type: 'req', method: 'chat.send', params: null }),
    JSON.stringify({ type: 'req', method: 'chat.send', params: 7 }),
    JSON.stringify({ type: 'req', method: 'chat.send', params: { __controlUiReconnectResume: true } }),
  ];
  for (const outgoing of cases) socket.send(outgoing);
  assert.strictEqual(socket.frames.length, cases.length, 'a send was swallowed');
  // The first two are left alone; the third is the one the shim exists for.
  assert.strictEqual(socket.frames[0], cases[0]);
  assert.strictEqual(socket.frames[1], cases[1]);
  assert.ok(!(RESERVED_PROPERTY in JSON.parse(socket.frames[2]).params));
});

test('the socket is passed to the original send, so the frame goes out on the socket that sent it', () => {
  const { socket, Socket } = install();
  const other = new Socket();
  socket.send(JSON.stringify(frame({ params: { __controlUiReconnectResume: true } })));
  assert.deepStrictEqual(other.frames, [], 'a frame was sent on a socket that did not send it');
  assert.strictEqual(socket.frames.length, 1);
});

test('binary payloads and other arguments are not read or rewritten', () => {
  const { socket } = install();
  const buffer = new Uint8Array([123, 125]);
  socket.send(buffer);
  socket.send(JSON.stringify(frame()), undefined);
  assert.strictEqual(socket.frames[0], buffer, 'a non-string payload was replaced');
  assert.strictEqual(socket.frames[1], JSON.stringify(frame()));
});

test('a second installation on the same window does not stack a second wrapper', () => {
  const window = { location: { href: 'https://gateway.test/' } };
  const Socket = fakeSocketClass();
  const first = install({ window, Socket });
  install({ window, Socket });
  first.socket.send(JSON.stringify(frame({ params: { __controlUiReconnectResume: true } })));
  assert.strictEqual(first.socket.frames.length, 1, 'the frame was sent more than once, so the wrapper is stacked');
  assert.ok(!(RESERVED_PROPERTY in JSON.parse(first.socket.frames[0]).params));
});

test('a window with no WebSocket prototype to wrap is left alone', () => {
  const window = { location: { href: 'https://gateway.test/' } };
  assert.doesNotThrow(() => new Function('window', 'WebSocket', shimScript())(window, undefined));
});

test('the shared script carries nothing from this client', () => {
  // The bytes the phone installs have to be the bytes any other client would
  // install, so a platform name, a bridge or a credential in the script would
  // mean the two clients are running two dialects.
  const script = shimScript();
  for (const foreign of ['webkit.messageHandlers', 'postMessage', 'claw-ios', 'openclaw-ios', '__OPENCLAW_NATIVE_CONTROL_AUTH__', 'localStorage']) {
    assert.ok(!script.includes(foreign), foreign + ' does not belong in the shared script');
  }
});

test('the spec names the trigger that retires the shim', () => {
  // The removal trigger is the one thing in a shim that stops it becoming
  // permanent, so it is asserted rather than trusted to survive an edit.
  const why = spec.why.join('\n');
  assert.match(why, /REMOVAL TRIGGER/, 'the spec no longer names what retires the shim');
  assert.match(why, /strips the reserved field for every client/, 'the trigger no longer names the upstream condition');
});
