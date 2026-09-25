// The desktop wake controller: each event order that stranded a queued message,
// driven through the controller with the actions counted, so what main.js does
// on each order is asserted rather than assumed.

import test from 'node:test';
import assert from 'node:assert';
import { createWake } from '../src/wake.js';

function harness() {
  const calls = [];
  const wake = createWake({
    close: () => calls.push('close'),
    cover: () => calls.push('cover'),
    reconnect: () => calls.push('reconnect'),
    uncover: () => calls.push('uncover'),
  });
  return { wake, calls };
}

test('suspend then resume: close, then one fresh reconnect, cover down on render', () => {
  const { wake, calls } = harness();
  for (const raw of ['powerMonitor:suspend', 'powerMonitor:resume', 'page:rendered']) wake.reportRaw(raw);
  assert.deepStrictEqual(calls, ['close', 'reconnect', 'uncover']);
  assert.strictEqual(wake.state, 'awake');
});

test('lock, suspend, resume, unlock reconnects exactly once', () => {
  const { wake, calls } = harness();
  for (const raw of ['powerMonitor:lock-screen', 'powerMonitor:suspend', 'powerMonitor:resume', 'powerMonitor:unlock-screen', 'page:rendered']) wake.reportRaw(raw);
  assert.deepStrictEqual(calls, ['close', 'reconnect', 'uncover']);
});

test('resume with no network: cover and wait, reconnect when it returns', () => {
  const { wake, calls } = harness();
  for (const raw of ['powerMonitor:suspend', 'net:offline', 'powerMonitor:resume', 'net:online', 'page:rendered']) wake.reportRaw(raw);
  assert.deepStrictEqual(calls, ['close', 'cover', 'reconnect', 'uncover']);
});

test('heartbeat missed while open reconnects fresh', () => {
  const { wake, calls } = harness();
  for (const raw of ['page:socket-dropped', 'page:rendered']) wake.reportRaw(raw);
  assert.deepStrictEqual(calls, ['reconnect', 'uncover']);
});

test('network drop while open: cover, reconnect on restore', () => {
  const { wake, calls } = harness();
  for (const raw of ['net:offline', 'net:online', 'page:rendered']) wake.reportRaw(raw);
  assert.deepStrictEqual(calls, ['cover', 'reconnect', 'uncover']);
});

test('an unknown platform event does nothing', () => {
  const { wake, calls } = harness();
  assert.strictEqual(wake.reportRaw('powerMonitor:thermal-state-change'), 'none');
  assert.deepStrictEqual(calls, []);
});
