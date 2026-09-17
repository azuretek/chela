// Device pairing on the desktop: the transport that carries the observer's
// report, the narrowing of an untrusted payload, and the state machine that puts
// the screen up and takes it down again.
//
// The phase RULES are core/pairing.js's, proven against core/fixtures/pairing.json
// from core/test/pairing.test.js and the Swift port. These tests are for the half
// this client owns: that the observer bytes injected into the page are the shared
// spec's rather than a copy, that nothing the page sends can reach the screen
// without passing the contract, and that a 1008 pairing close surfaces the screen
// from ANY prior phase, including a session that was established and working.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createState, injectedSources, parseReport, transportPrelude } from '../src/pairing.js';
import {
  AUTHENTICATED,
  CONNECTING,
  CONFIRM_SECONDS,
  FAILED,
  OBSERVER_GLOBAL,
  PAIRING_REQUIRED,
  RETRY_SECONDS,
  SOCKET_CLOSED,
  observerScript,
} from '../../core/pairing.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const UI = path.join(HERE, '..', '..', 'core', 'ui');

/** A clock with no time in it: pending timers, fired on demand. */
function fakeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    schedule(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, ms });
      return seq;
    },
    cancel(id) {
      timers.delete(id);
    },
    /** Fire everything pending, shortest delay first, so a beat can re-arm one. */
    tick() {
      for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].ms - b[1].ms)) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    pending() {
      return timers.size;
    },
    delays() {
      return [...timers.values()].map((t) => t.ms);
    },
  };
}

function stateWith(clock) {
  const retries = [];
  const changes = [];
  const state = createState({
    schedule: (fn, ms) => clock.schedule(fn, ms),
    cancel: (id) => clock.cancel(id),
    onRetry: () => retries.push(Date.now()),
    onChange: () => changes.push('change'),
  });
  return { state, retries, changes };
}

/** Put the client where a working, approved, established session leaves it. */
function established(clock) {
  const built = stateWith(clock);
  built.state.connecting();
  built.state.opened();
  assert.strictEqual(built.state.phase, AUTHENTICATED, 'setup: the session is established');
  assert.strictEqual(built.state.isPairing(), false, 'setup: no screen');
  return built;
}

test('the injected observer is the shared spec script, not a copy of it', () => {
  const [prelude, script] = injectedSources();
  assert.strictEqual(script, observerScript(), 'the observer half is one script, read from the spec');
  // And it is the spec's own bytes rather than a string that merely resembles
  // them, which is the property that keeps the desktop and the phone running one
  // script instead of two that agree until somebody edits one.
  const spec = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'core', 'spec', 'pairing.json'), 'utf8'));
  assert.strictEqual(script, spec.hook.join('\n'));
  // The transport goes first: a report that arrived before the channel existed
  // would land in a plain global and be lost.
  assert.strictEqual(prelude, transportPrelude());
  assert.ok(prelude.length > 0 && prelude !== script);
});

test('the transport turns the observer\'s fallback global into the app\'s channel', () => {
  const prelude = transportPrelude();
  // The global is the contract's, not a string written down again here, so a
  // rename in the spec cannot leave the desktop listening on the old name.
  assert.ok(prelude.includes(`'${OBSERVER_GLOBAL}'`), 'the transport must define the contract global');
  assert.ok(prelude.includes('__clawPairingReport'), 'and call the channel the preload installs');
  assert.ok(prelude.includes('__clawDesktopPairingTransport'), 'and install itself once');
  // Fail-soft: with no bridge the property is left alone rather than replaced
  // with a dead accessor that would swallow the observer's own assignment.
  assert.ok(prelude.includes("typeof post !== 'function'"));
});

test('a report is narrowed to the contract before it can reach a screen', () => {
  // What the observer sends on a pairing close.
  assert.deepStrictEqual(
    parseReport(JSON.stringify({ kind: PAIRING_REQUIRED, reason: 'not-paired', requestId: 'req-7f3a2b' })),
    { kind: 'close', refusal: { reason: 'not-paired', requestId: 'req-7f3a2b' } },
  );
  // The upgrade reasons are the contract's too, and are not collapsed into the
  // general one.
  assert.deepStrictEqual(
    parseReport({ kind: PAIRING_REQUIRED, reason: 'scope-upgrade', requestId: 'req-scope-1' }),
    { kind: 'close', refusal: { reason: 'scope-upgrade', requestId: 'req-scope-1' } },
  );
  // An open, which is the recovery leg.
  assert.deepStrictEqual(parseReport(JSON.stringify({ kind: AUTHENTICATED })), { kind: 'open' });

  // A reason the contract does not know falls back rather than being shown.
  assert.strictEqual(parseReport({ kind: PAIRING_REQUIRED, reason: 'nonsense', requestId: 'req-1' }).refusal.reason, 'not-paired');
  // An id that fails the contract's pattern is dropped, so the screen shows the
  // `--latest` command rather than arbitrary text from the page.
  assert.strictEqual(parseReport({ kind: PAIRING_REQUIRED, reason: 'not-paired', requestId: '../../etc' }).refusal.requestId, null);
  assert.strictEqual(parseReport({ kind: PAIRING_REQUIRED, reason: 'not-paired' }).refusal.requestId, null);
});

test('a socket the gateway closed is the session ending, and is read as its own thing', () => {
  // The observer's other report, and it is not pairing: the socket opened and has
  // now closed without a refusal. The desktop's host ends the hold on it, because
  // the page held the only socket either side had and a client that keeps showing
  // the gateway's page after that is claiming to be connected when it is not.
  assert.deepStrictEqual(parseReport({ kind: SOCKET_CLOSED }), { kind: 'dropped' });
  // The kind is the spec's, so the script that posts it and the clients that read
  // it cannot disagree about the string.
  const spec = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'core', 'spec', 'pairing.json'), 'utf8'));
  assert.strictEqual(SOCKET_CLOSED, spec.socketClosed);
  assert.ok(spec.hook.join('\n').includes(`kind: '${SOCKET_CLOSED}'`), 'the observer no longer posts the kind the clients read');
  // A payload assembled by hand that names that kind must not be confused with a
  // refusal, and a refusal must not be confused with it.
  assert.strictEqual(parseReport({ kind: SOCKET_CLOSED, reason: 'not-paired' }).kind, 'dropped');
  assert.strictEqual(parseReport({ kind: PAIRING_REQUIRED, reason: 'not-paired' }).kind, 'close');
});

test('the observer only reports a close for a socket it saw OPEN', () => {
  // The guard that keeps a token the gateway refused out of this: a handshake that
  // never completed is not a session ending, and the page's own login gate is what
  // the reader needs on screen there. So the listener records the open first and
  // reports the close only if it happened.
  const script = observerScript();
  assert.match(script, /var opened = false;/, 'the socket no longer tracks whether it ever opened');
  assert.match(script, /addEventListener\('open', function \(\) \{ opened = true;/, 'an open no longer records itself');
  assert.match(script, /if \(opened\) \{ post\(\{ kind: 'disconnected' \}\); \}/,
    'a close is reported without checking that the socket had opened');
  // And a pairing refusal returns rather than falling through to it: one close,
  // one meaning, so a 1008 can never also read as a drop.
  assert.match(script, /requestId: pairing\.requestId \}\); return; \}/, 'a pairing close falls through to the drop report');
});

test('a payload that is not one of the two reports is dropped', () => {
  // Untrusted input, so every shape that is not the contract's is nothing rather
  // than a guess: a kind nobody named, a body that is not an object, the empty
  // string the preload substitutes for a non-string payload, and markup.
  for (const payload of [
    null,
    undefined,
    '',
    'not json',
    '{"kind":"pairing-required"',
    42,
    [],
    { kind: 'tick' },
    '<script>',
  ]) {
    assert.strictEqual(parseReport(payload), null, `${JSON.stringify(payload)} must be dropped`);
  }
  // A pairing report with no reason at all still reaches the general case, which
  // is the honest reading of "refused, without saying how": the screen shows the
  // requirement with no id, which is the `--latest` command.
  assert.deepStrictEqual(
    parseReport({ kind: PAIRING_REQUIRED }),
    { kind: 'close', refusal: { reason: 'not-paired', requestId: null } },
  );
  // And an authenticated report carrying pairing fields is still just an open.
  assert.deepStrictEqual(parseReport({ kind: AUTHENTICATED, reason: 'not-paired', requestId: 'req-1' }), { kind: 'open' });
});

test('a pairing close from an established session puts the screen up', () => {
  // The regression, named. A device that was approved and WORKING, then had its
  // approval revoked server-side, is refused with the same 1008 close a first
  // connection gets: `openclaw devices remove <deviceId>` closes the live socket
  // (`4001 device removed`) and the next connects are closed
  // `1008 pairing required: device is not approved yet (requestId: ...)`.
  //
  // Entering pairing from `authenticated` is what was missing here: the desktop
  // had no observer at all, so nothing surfaced this, and the phone's screen
  // reached the phase only because it happened to be refused on a connect.
  const clock = fakeClock();
  const { state } = established(clock);

  state.closed({ reason: 'not-paired', requestId: 'req-established-1' });

  assert.strictEqual(state.phase, PAIRING_REQUIRED, 'the refusal must reach the pairing state');
  assert.strictEqual(state.isPairing(), true, 'and the screen must go up');
  const snapshot = state.snapshot();
  assert.strictEqual(snapshot.requestId, 'req-established-1');
  assert.match(snapshot.command, /openclaw devices approve req-established-1/);
  assert.ok(snapshot.requirement.length > 0, 'the screen says which requirement was refused');
});

test('the screen holds through the retries, and only a settled open clears it', () => {
  const clock = fakeClock();
  const { state, retries, changes } = established(clock);
  state.closed({ reason: 'not-paired', requestId: 'req-establishment-2' });

  // Three retry cycles exactly as the gateway produces them: a reload, the
  // handshake completing, then the 1008 close. The screen must never come down
  // for the open in between: that gap is what flickered on the phone before
  // 6ccc6d5, and the shared reducer's `open` case is what holds it here.
  for (let cycle = 0; cycle < 3; cycle += 1) {
    state.connecting();
    assert.strictEqual(state.isPairing(), true, 'a retry connect must not drop the screen');
    state.opened();
    assert.strictEqual(state.isPairing(), true, 'an unconfirmed open must not drop the screen');
    state.closed({ reason: 'not-paired', requestId: 'req-establishment-2' });
    assert.strictEqual(state.phase, PAIRING_REQUIRED);
  }

  // The retry cadence is live: each beat asks for a fresh attempt, at the
  // interval the shared spec names.
  const before = retries.length;
  clock.tick();
  assert.strictEqual(retries.length, before + 1, 'a beat must ask for one reconnect');
  assert.ok(clock.delays().includes(RETRY_SECONDS * 1000), 'and re-arm at the spec interval');

  // Now the approval lands: the socket opens and stays open. The screen comes
  // down on the settle window, with no relaunch and nothing to press.
  const changesBeforeApproval = changes.length;
  state.opened();
  assert.strictEqual(state.isPairing(), true, 'still held until the window elapses');
  assert.ok(clock.delays().includes(CONFIRM_SECONDS * 1000), 'the settle window is the spec\'s');
  // The move that clears the screen happens in the timer, so the timer has to be
  // what TELLS the screen. Measured live without it: the phase read authenticated
  // while the pairing overlay stayed on top of a working Control UI, because
  // nothing repainted on the one transition with no other caller.
  clock.tick();
  assert.strictEqual(state.phase, AUTHENTICATED);
  assert.ok(changes.length > changesBeforeApproval, 'the settle must notify whoever shows the phase');
  assert.strictEqual(state.isPairing(), false, 'the screen clears on its own');
  assert.strictEqual(state.snapshot().refusal, null, 'and the refusal goes with it');
  assert.strictEqual(clock.pending(), 0, 'no cadence is left running after recovery');
});

test('a refusal that follows an open cancels the settle window, so nothing clears it early', () => {
  const clock = fakeClock();
  const { state } = established(clock);
  state.closed({ reason: 'not-paired', requestId: 'req-race-1' });

  // The exact race: the handshake completes and the 1008 close lands a few
  // milliseconds later. A confirm that fired between them would show the user a
  // working app that is not working.
  state.opened();
  state.closed({ reason: 'not-paired', requestId: 'req-race-1' });
  clock.tick();
  assert.strictEqual(state.phase, PAIRING_REQUIRED, 'a late settle must not clear a screen the close kept up');
});

test('a connection failure is not a pairing refusal', () => {
  // The other half of the rule, and the one that must not regress into a false
  // positive: a dropped host, or a socket close with no pairing reason, is the
  // network state with its own notice, never the pairing screen.
  const clock = fakeClock();
  const { state } = established(clock);
  state.closed(null);
  assert.strictEqual(state.phase, FAILED);
  assert.strictEqual(state.isPairing(), false, 'a dropped socket must not raise the pairing screen');
  assert.strictEqual(state.snapshot().command, 'openclaw devices approve --latest', 'and there is no id to show');

  const other = stateWith(fakeClock());
  other.state.connecting();
  other.state.failed();
  assert.strictEqual(other.state.phase, FAILED);
  assert.strictEqual(other.state.isPairing(), false, 'a load that never reached the gateway must not either');
});

test('main wires the observer, the report channel and the screen together', () => {
  const main = readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.match(main, /OVERLAY_PAGES = \{[^}]*pairing: 'pairing\.html'/, 'the pairing screen must be an overlay page');
  // The observer bytes are read by the preload, synchronously, because the
  // preload runs at document start and an async read would arrive after the
  // page's own first script.
  assert.match(main, /ipcMain\.on\('pairing:script'/, 'main must serve the observer script to the preload');
  assert.match(main, /event\.returnValue = pairing\.injectedSources\(\)/, 'and serve the shared bytes, in order');
  // The CDP route that shipped broken, kept out by name: it registered, it
  // logged success, and the script never ran in the page. Asserted on the calls
  // rather than on any mention, because the reason CDP was abandoned is written
  // down in the section above and the words are worth keeping.
  assert.doesNotMatch(main, /debugger\.attach\(/, 'the debugger route must be gone, not kept as a fallback');
  assert.doesNotMatch(main, /debugger\.sendCommand\(/, 'nor its registration calls');
  // The install is only believed when the injector says it happened.
  assert.match(main, /ipcMain\.on\('pairing:injected'/, 'the install report must be logged');
  // The report is only accepted from the live gateway page.
  assert.match(main, /ipcMain\.on\('pairing:report', handlePairingReport\)/, 'the report channel must be wired');
  assert.match(main, /event\.sender !== wc/, 'and must be checked against the page it came from');
  // The screen is opened from the phase, never from a first connect.
  assert.match(main, /if \(snap\.pairing\) \{[\s\S]*openOverlay\('pairing'\)/, 'the screen follows the phase');
  // And it follows EVERY phase move, including the settle timer's confirm, which
  // has no other caller: a repaint only on a page report leaves the screen up
  // over a session that is working.
  assert.match(main, /onChange: \(\) => \{[\s\S]*?syncPairing\(\)/, 'every phase move must repaint the screen');
  // The recovery line lives on that same hook rather than in the report handler,
  // because the recovery has two routes and only one of them is a report.
  assert.match(main, /device pairing cleared; the pairing screen is down/, 'the recovery must be logged');
  assert.match(main, /if \(pairingWasUp && !pairingNow\)/, 'and logged from the one place that sees both routes');

  // The report crosses from the remote page through the preload, which is the
  // only surface that page may use, and the injection happens there too.
  const preload = readFileSync(path.join(SRC, 'preload.cjs'), 'utf8');
  assert.match(preload, /exposeInMainWorld\('__clawPairingReport'/, 'the preload installs the report channel');
  assert.match(preload, /ipcRenderer\.send\('pairing:report'/, 'which carries it to main');
  assert.match(preload, /ipcRenderer\.sendSync\('pairing:script'\)/, 'and reads the observer bytes synchronously');
  assert.match(preload, /webFrame\.executeJavaScript\(source\)/, 'which it evaluates in the page main world at document start');
  assert.match(preload, /if \(!isLocalPage\) \{[\s\S]*sendSync\('pairing:script'\)/, 'injecting only into the remote gateway page');
  assert.match(preload, /ipcRenderer\.send\('pairing:injected'/, 'and reporting whether the install happened');

  // And the page itself exists where the overlay loads it from.
  assert.ok(readFileSync(path.join(UI, 'pairing.html'), 'utf8').includes('pairing.js'));
});
