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

test('sleep then wake preserves the document and requests one transport check', () => {
  assert.deepStrictEqual(run(['sleep', 'wake', 'rendered']), {
    state: 'awake', actions: ['none', 'reconnect', 'uncover'],
  });
});

test('wake with no network preserves the document until the network returns', () => {
  assert.deepStrictEqual(run(['sleep', 'offline', 'wake', 'online', 'rendered']), {
    state: 'awake', actions: ['none', 'none', 'none', 'reconnect', 'uncover'],
  });
});

test('heartbeat missed while open: reconnect fresh, once', () => {
  assert.deepStrictEqual(run(['heartbeatMissed', 'heartbeatMissed', 'rendered']), {
    state: 'awake', actions: ['reconnect', 'none', 'uncover'],
  });
});

test('network drop preserves the document and checks transport on restore', () => {
  assert.deepStrictEqual(run(['offline', 'online', 'rendered']), {
    state: 'awake', actions: ['none', 'reconnect', 'uncover'],
  });
});

test('unlock without a sleep still reconnects', () => {
  assert.deepStrictEqual(run(['wake', 'rendered']).actions, ['reconnect', 'uncover']);
});

test('lock then suspend preserves the document and double wake coalesces', () => {
  assert.deepStrictEqual(run(['sleep', 'sleep', 'wake', 'wake', 'rendered']).actions,
    ['none', 'none', 'reconnect', 'none', 'uncover']);
});

test('sleep during recovery preserves the document and allows another wake', () => {
  assert.deepStrictEqual(run(['heartbeatMissed', 'sleep', 'wake', 'rendered']).actions,
    ['reconnect', 'none', 'reconnect', 'uncover']);
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
