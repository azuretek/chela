import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as connection from '../../core/connection.js';
import { createState } from '../src/pairing.js';

// Whether the device-approval gate clears from LIVE state, which is the one thing
// neither core module can answer alone.
//
// The two verdicts the host reads are shared and each is proven in its own file:
// core/connection.js's `mayPresentGatewayView` (may the document on screen be held
// through a connect attempt?) and `shouldMarkConnected` (does a finished load mean
// the gateway answered?). This file is the WIRING between them, which is where the
// fault lived, because the two can each be right and still compose into a client
// that can never notice the approval it is waiting for.
//
// Abi, 2026-09-21, on 1.0.1-dev.297.f2d997ec5c: "after approval the try again does
// not work, I can see the theme change as it works but it never directs to the OPA",
// with the gateway reporting the device paired, `pending: []`, `connected: true`
// and `lastSeenReason device-token-auth`. So the device WAS approved and WAS
// authenticating, and the screen rendering the request id was stale CLIENT state.
//
// The sequence: the gateway serves the page and refuses the session 1008, so the
// phase holds `pending` and the pairing screen goes up; `mayPresentGatewayView`
// holds the document on screen on that same phase, so every retry beat loads its
// fresh document BESIDE it instead of in place; and a finished load only counted
// while the phase was `connecting`, so the attempt was never promoted and its own
// observer report was read from the view on screen and dropped. The document nobody
// was looking at held the only socket that could report the approval, so the screen
// stayed up for the life of the process, and Try again repeated it exactly. A
// relaunch cleared it, because a launch starts from `connecting` and takes the load
// in place.
//
// Nothing here is a second copy of a rule: every decision is imported from core.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GW = 'gw';
const URL = 'https://gw.example/';

/**
 * A clock with no time in it, as the other pairing tests use: pending timers,
 * fired on demand, shortest first so a beat can re-arm one.
 */
function fakeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    schedule(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, ms });
      return seq;
    },
    cancel(id) { timers.delete(id); },
    fireShortest() {
      const next = [...timers.entries()].sort((a, b) => a[1].ms - b[1].ms)[0];
      if (!next) return false;
      timers.delete(next[0]);
      next[1].fn();
      return true;
    },
    pending() { return timers.size; },
    delays() { return [...timers.values()].map((t) => t.ms); },
  };
}

/**
 * The desktop host's connect path, in src/main.js's own terms, with the views
 * reduced to handles so a sequence can be replayed with no Electron in the room.
 *
 * Mirrors, in order: `loadActiveGateway` then `beginGatewayConnect` (which asks
 * `mayPresentGatewayView` whether the document on screen may be held, and loads
 * BESIDE it when it may), the view's `did-finish-load` (which asks
 * `shouldMarkConnected` before anything is promoted), and `handlePairingReport`
 * (which reads a report only from the view on screen). The pairing state is the
 * real one, timers included, and its `onChange` runs the real `syncPairing` move.
 */
function host(clock) {
  const log = [];
  let phase = connection.CONNECTING;
  let held = null;        // the gateway whose document is on screen
  let onScreen = null;    // that document: the only view a report may come from
  let attempt = null;     // a document loaded BESIDE the one on screen
  let seq = 0;

  const pairing = createState({
    schedule: (fn, ms) => clock.schedule(fn, ms),
    cancel: (id) => clock.cancel(id),
    onRetry: () => retryBeat(),
    onChange: () => syncPairing(),
  });

  /**
   * The gateway row follows the same state the screen does, which is what keeps
   * an unapproved device reading `pending` rather than Connected.
   */
  function syncPairing() {
    const next = connection.nextPhase(phase, { type: pairing.isPairing() ? 'pending' : 'confirm' });
    if (next !== phase) phase = next;
  }

  /** One beat of the pairing cadence, which re-runs the app's own connect path. */
  function retryBeat() {
    if (!pairing.isPairing()) return null;
    return connect();
  }

  function connect() {
    seq += 1;
    const view = { id: 'view-' + seq, gateway: GW };
    phase = connection.nextPhase(phase, { type: 'connect' });
    pairing.connecting();
    if (connection.mayPresentGatewayView({ gatewayId: GW, heldGatewayId: held, phase })) {
      attempt = view;
      log.push(view.id + ': loaded BESIDE the document on screen');
    } else {
      onScreen = view;
      log.push(view.id + ': the view takes the load itself');
    }
    return view;
  }

  /** The view's `did-finish-load`: the shared verdict, then the promotion. */
  function loadFinished(view) {
    if (!connection.shouldMarkConnected({ phase, url: URL })) {
      log.push(view.id + ': a finished load that did not count');
      return false;
    }
    if (attempt === view) {
      onScreen = view;
      attempt = null;
      log.push(view.id + ': promoted into the window');
    }
    held = GW;
    phase = connection.nextPhase(phase, { type: 'connected' });
    return true;
  }

  /** `handlePairingReport`: the sender is the view on screen, and nothing else. */
  function report(view, payload) {
    if (view !== onScreen) {
      log.push(view.id + ': report dropped, it is not the view on screen');
      return false;
    }
    if (payload.kind === 'open') pairing.opened();
    else pairing.closed({ reason: 'not-paired', requestId: payload.requestId });
    return true;
  }

  return {
    connect,
    loadFinished,
    report,
    pairing,
    log,
    phase: () => phase,
    onScreen: () => onScreen,
    attempt: () => attempt,
  };
}

/** Put the host where an unapproved device leaves it: the gate up, phase held. */
function waitingOnApproval(clock, h) {
  const first = h.connect();
  h.loadFinished(first);
  assert.equal(h.phase(), connection.CONNECTED, 'setup: the document loaded, so the connection is up');
  // The gateway serves the page and then refuses the session: the open, then the
  // 1008 close carrying the request id.
  h.report(first, { kind: 'open' });
  h.report(first, { kind: 'pairing-required', requestId: 'req-1' });
  assert.equal(h.pairing.isPairing(), true, 'setup: the gate is up for an unapproved device');
  assert.equal(h.phase(), connection.PENDING, 'setup: and the row says the gateway is holding this device');
  return first;
}

test('the attempt a retry makes is the one that reports, so an approval lands on it', () => {
  const clock = fakeClock();
  const h = host(clock);
  const first = waitingOnApproval(clock, h);

  // A retry beat while the device is still unapproved. The held document means
  // the attempt is made beside it, and its own report is refused again.
  clock.fireShortest();
  const refused = h.attempt();
  assert.ok(refused, 'the cadence made an attempt at all');
  assert.notStrictEqual(refused, first, 'and it is a fresh document, not the one already on screen');
  h.loadFinished(refused);
  assert.equal(h.report(refused, { kind: 'open' }), true,
    'the document the attempt loaded is the one whose socket is opened, so its report is the one that is read');
  h.report(refused, { kind: 'pairing-required', requestId: 'req-1' });
  assert.equal(h.pairing.isPairing(), true, 'a device that is still refused stays on the gate');

  // The operator approves. The next beat loads the same way and this time the
  // socket is not refused, so the open is the approval.
  clock.fireShortest();
  const approved = h.attempt();
  assert.ok(h.loadFinished(approved), 'a finished load while the phase is held is the gateway answering');
  assert.strictEqual(h.onScreen(), approved,
    'and it takes the place of the document on screen, so nothing is left showing behind the gate');
  assert.equal(h.report(approved, { kind: 'open' }), true, 'its open is read from the view on screen');
  assert.equal(h.pairing.isPairing(), true, 'the open alone does not clear it: the settle window does');
  clock.fireShortest();
  assert.equal(h.pairing.isPairing(), false, 'THE GATE CLEARS FROM LIVE STATE, with no relaunch');
  assert.equal(h.phase(), connection.CONNECTED, 'and the row confirms the connect');
});

test('Try again now reaches live state instead of a verdict read from earlier', () => {
  const clock = fakeClock();
  const h = host(clock);
  waitingOnApproval(clock, h);

  // Eleven presses with the gateway still refusing. Each one is the app's own
  // connect path (src/preload.cjs sends `app:reconnect`, src/main.js runs
  // loadActiveGateway), so each one makes a fresh attempt and re-reads the socket
  // rather than believing the refusal already on screen. A flat verdict here is
  // what made the button do nothing at all for the life of the process, which is
  // the same shape as the cached identity probe fixed in 907d1fd.
  for (let press = 1; press <= 11; press += 1) {
    const view = h.connect();
    assert.ok(h.attempt() === view || h.onScreen() === view, 'press ' + press + ' made no attempt at all');
    h.loadFinished(view);
    h.report(view, { kind: 'open' });
    h.report(view, { kind: 'pairing-required', requestId: 'req-1' });
    assert.equal(h.pairing.isPairing(), true, 'press ' + press + ' cleared the gate before the device was approved');
    assert.equal(h.phase(), connection.PENDING, 'press ' + press + ' moved the row off pending');
  }

  // The approval lands while the gate is up, and the next press is the one that
  // reaches it. Nothing is cached from the eleven refusals.
  const approved = h.connect();
  h.loadFinished(approved);
  h.report(approved, { kind: 'open' });
  clock.fireShortest();
  assert.equal(h.pairing.isPairing(), false, 'the press that reached live state cleared the gate');
  assert.equal(h.phase(), connection.CONNECTED);
});

test('the host reads both verdicts from core, and reads a report from one view', () => {
  // The replay above is only faithful while the host actually asks these two
  // questions in this order, so the wiring is guarded where it lives.
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /connectionState\.shouldMarkConnected\(\{ phase: connection\.phase, url: wc\.getURL\(\) \}\)/,
    'did-finish-load must ask the shared verdict whether the gateway answered');
  assert.match(main, /if \(attempt\) promoteGatewayView\(view\);/,
    'a finished attempt must be promoted, or the document nobody can see holds the socket');
  assert.match(main, /const hold = connectionState\.mayPresentGatewayView|connectionState\.mayPresentGatewayView\(\{/,
    'the hold must come from the shared rule rather than a second copy of it');
  // One acceptance path: the report is read from the view on screen and no other.
  assert.match(main, /function handlePairingReport\(event, payload\) \{\n  const wc = page\(\);\n  if \(!wc \|\| event\.sender !== wc\) return;/,
    'the pairing report must be read from the view on screen alone');
});
