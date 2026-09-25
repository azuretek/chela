// The wake and reconnect rule, one test per event order that has stranded a
// queued message, plus the table's own shape.

import test from 'node:test';
import assert from 'node:assert';

import { ACTIONS, EVENTS, INITIAL, STATES, eventFor, run, step } from '../wake.js';

test('every state answers every event with a known state and action', () => {
  for (const s of STATES) {
    for (const e of EVENTS) {
      const next = step(s, e);
      assert.ok(STATES.includes(next.state), `${s} + ${e} -> ${next.state}`);
      assert.ok(ACTIONS.includes(next.action), `${s} + ${e} -> ${next.action}`);
    }
  }
});

test('sleep then wake: close on sleep, reconnect under the cover on wake, uncover once rendered', () => {
  assert.deepStrictEqual(run(['sleep', 'wake', 'rendered']), {
    state: 'awake', actions: ['close', 'reconnect', 'uncover'],
  });
});

test('wake with no network: cover and wait, then reconnect when the network returns', () => {
  assert.deepStrictEqual(run(['sleep', 'offline', 'wake', 'online', 'rendered']), {
    state: 'awake', actions: ['close', 'none', 'cover', 'reconnect', 'uncover'],
  });
});

test('heartbeat missed while open: reconnect fresh, once', () => {
  assert.deepStrictEqual(run(['heartbeatMissed', 'heartbeatMissed', 'rendered']), {
    state: 'awake', actions: ['reconnect', 'none', 'uncover'],
  });
});

test('network drop while open: cover, then reconnect on restore', () => {
  assert.deepStrictEqual(run(['offline', 'online', 'rendered']), {
    state: 'awake', actions: ['cover', 'reconnect', 'uncover'],
  });
});

test('unlock without a sleep still reconnects', () => {
  assert.deepStrictEqual(run(['wake', 'rendered']).actions, ['reconnect', 'uncover']);
});

test('lock then suspend closes once, and the double wake reconnects once', () => {
  assert.deepStrictEqual(run(['sleep', 'sleep', 'wake', 'wake', 'rendered']).actions,
    ['close', 'none', 'reconnect', 'none', 'uncover']);
});

test('sleep during a reconnect closes rather than leaving the load half-open', () => {
  assert.deepStrictEqual(run(['heartbeatMissed', 'sleep', 'wake', 'rendered']).actions,
    ['reconnect', 'close', 'reconnect', 'uncover']);
});

test('a render before the wake does not uncover a sleeping client', () => {
  assert.strictEqual(run(['sleep', 'rendered']).state, 'asleep');
});

test('an unknown event or state changes nothing', () => {
  assert.deepStrictEqual(step('awake', 'nope'), { state: 'awake', action: 'none' });
  assert.deepStrictEqual(step('nope', 'wake'), { state: 'nope', action: 'none' });
  assert.strictEqual(INITIAL, 'awake');
});

test('platform events map onto the rule', () => {
  assert.strictEqual(eventFor('desktop', 'powerMonitor:resume'), 'wake');
  assert.strictEqual(eventFor('desktop', 'powerMonitor:lock-screen'), 'sleep');
  assert.strictEqual(eventFor('ios', 'scenePhase:background'), 'sleep');
  assert.strictEqual(eventFor('ios', 'NWPathMonitor:interface-changed'), 'online');
  assert.strictEqual(eventFor('desktop', 'nope'), null);
});
