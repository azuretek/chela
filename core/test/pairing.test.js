// Device pairing: reading the gateway's policy close into a state, keeping it
// apart from an auth failure and a network drop, and moving through the four
// phases. These are the contract the Swift port proves itself against
// (mobile/ClawTests/PairingParityTests.swift), from the same golden cases, so
// both clients read one gateway close the same way rather than agreeing by luck.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CONNECTING,
  PAIRING_REQUIRED,
  AUTHENTICATED,
  FAILED,
  POLICY_CLOSE_CODE,
  PAIRING_REASONS,
  COPY,
  readRequestId,
  readPairingClose,
  nextPhase,
  approveCommand,
  requirement,
  observerScript,
  OBSERVER_GLOBAL,
  OBSERVER_MESSAGE_NAME,
} from '../pairing.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const FIXTURES = path.join(HERE, '..', 'fixtures');
const SPEC_PATH = path.join(REPO, 'core', 'spec', 'pairing.json');

function load(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));

test('the phases and the policy code come from the spec, not string literals', () => {
  assert.strictEqual(CONNECTING, spec.phases.connecting);
  assert.strictEqual(PAIRING_REQUIRED, spec.phases.pairingRequired);
  assert.strictEqual(AUTHENTICATED, spec.phases.authenticated);
  assert.strictEqual(FAILED, spec.phases.failed);
  assert.strictEqual(POLICY_CLOSE_CODE, spec.policyCloseCode);
});

test('the policy code is 1008, pinned so a spec drift fails loudly', () => {
  // The WebSocket "Policy Violation" code, which the gateway uses for a pairing
  // refusal. Pinned as a literal so a change to the spec value is a deliberate
  // edit rather than a silent one that would stop pairing being detected at all.
  assert.strictEqual(POLICY_CLOSE_CODE, 1008);
});

test('readPairingClose() reproduces every fixture', () => {
  const { close } = load('pairing.json');
  assert.ok(close.length > 0, 'expected pairing close fixtures');
  for (const { name, input, output } of close) {
    assert.deepStrictEqual(readPairingClose(input), output, name);
  }
});

test('a 1008 close is pairing only with a pairing reason, never on its own', () => {
  // 1008 is a general policy code, so pairing is code AND reason. This is the one
  // rule a client must not collapse: a 1008 with any other reason is an ordinary
  // failure with its own copy, and a pairing-looking reason on any other code is
  // not pairing either.
  assert.strictEqual(readPairingClose({ code: 1008, reason: 'message too large' }), null);
  assert.strictEqual(readPairingClose({ code: 1006, reason: 'pairing required' }), null);
  assert.strictEqual(readPairingClose({ code: 1000, reason: '' }), null);
  assert.ok(readPairingClose({ code: 1008, reason: 'pairing required' }));
});

test('readRequestId() reproduces every fixture and holds to the id pattern', () => {
  const { requestId } = load('pairing.json');
  assert.ok(requestId.length > 0, 'expected requestId fixtures');
  for (const { name, input, output } of requestId) {
    assert.strictEqual(readRequestId(input), output, name);
  }
});

test('nextPhase() reproduces every fixture', () => {
  const { phase } = load('pairing.json');
  assert.ok(phase.length > 0, 'expected phase fixtures');
  for (const { name, from, event, to } of phase) {
    assert.strictEqual(nextPhase(from, event), to, name);
  }
});

test('an approval that lands while pairing wins immediately', () => {
  // Auto-recovery, as a state rule: an `open` from pairing-required is
  // authenticated, not "pairing-required until something re-reads it". The
  // screen comes down the moment the socket opens.
  assert.strictEqual(nextPhase(PAIRING_REQUIRED, { type: 'open' }), AUTHENTICATED);
});

test('approveCommand() reproduces every fixture', () => {
  const { command } = load('pairing.json');
  assert.ok(command.length > 0, 'expected command fixtures');
  for (const { name, input, output } of command) {
    assert.strictEqual(approveCommand(input), output, name);
  }
});

test('every pairing reason has a requirement sentence', () => {
  for (const reason of PAIRING_REASONS) {
    assert.ok(requirement(reason), `no requirement for ${reason}`);
  }
  // An unknown reason falls back rather than returning nothing.
  assert.ok(requirement('nonsense'));
});

test('the copy reflects the real approve instruction, not an invented one', () => {
  assert.ok(COPY.commandWithId.includes('openclaw devices approve'));
  assert.ok(COPY.commandNoId.includes('openclaw devices approve --latest'));
  assert.ok(COPY.cannotRunHere, 'the screen says the device cannot approve itself');
});

test('the observer script is one copy, and reports through the message handler it names', () => {
  const script = observerScript();
  assert.strictEqual(script, spec.hook.join('\n'), 'the script is the spec hook joined, not a second copy');
  assert.strictEqual(OBSERVER_GLOBAL, spec.global);
  assert.strictEqual(OBSERVER_MESSAGE_NAME, spec.messageName);
  // The handler name the script posts to has to be the one the native client
  // registers, or the report is dropped silently.
  assert.ok(script.includes(`messageHandlers.${OBSERVER_MESSAGE_NAME}`));
  // It watches close and open, and it wraps rather than replaces the constructor
  // so the page's own socket behaviour is untouched.
  assert.ok(script.includes("addEventListener('close'"));
  assert.ok(script.includes("addEventListener('open'"));
  assert.ok(script.includes('window.WebSocket = Wrapped'));
});

test('the observer install-guard makes a second injection a no-op', () => {
  // Re-installed on every connect (the token script is), so the observer must
  // not stack a second wrapper each time. The guard is the same shape as the
  // prompt-metadata hook's.
  const script = observerScript();
  assert.ok(script.includes('__clawPairingInstalled'));
});
