// The native token handoff: the object a native client sets on the Control UI's
// window, and the one assignment that installs it. These are the contract the
// Swift port proves itself against (mobile/ClawTests/NativeControlAuthParityTests.swift),
// and the same golden pairs are asserted on both sides, so "the two clients hand
// over the same object" is checked rather than hoped for.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  NATIVE_CONTROL_AUTH_GLOBAL,
  NATIVE_CONTROL_AUTH_MODE,
  NATIVE_CONTROL_AUTH_SCOPES,
  nativeControlAuth,
  installation,
} from '../native-control-auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const FIXTURES = path.join(HERE, '..', 'fixtures');
const SPEC_PATH = path.join(REPO, 'core', 'spec', 'native-control-auth.json');

function load(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));

test('the exported constants come from the spec, not string literals', () => {
  assert.strictEqual(NATIVE_CONTROL_AUTH_GLOBAL, spec.global);
  assert.strictEqual(NATIVE_CONTROL_AUTH_MODE, spec.mode);
  assert.deepStrictEqual(NATIVE_CONTROL_AUTH_SCOPES, spec.scopes);
});

test('the global is the one the Control UI reads at boot', () => {
  // The name the OpenClaw Control UI reads in resolveApplicationStartupSettings.
  // Pinned as a literal here so a rename of the spec value fails loudly rather
  // than silently handing the token to a global nothing reads.
  assert.strictEqual(NATIVE_CONTROL_AUTH_GLOBAL, '__OPENCLAW_NATIVE_CONTROL_AUTH__');
});

test('nativeControlAuth() reproduces every fixture', () => {
  const { cases } = load('native-control-auth.json');
  assert.ok(cases.length > 0, 'expected native-control-auth fixtures');
  for (const { name, input, output } of cases) {
    assert.deepStrictEqual(nativeControlAuth(input), output, name);
  }
});

test('installation() reproduces every fixture', () => {
  const { installation: cases } = load('native-control-auth.json');
  assert.ok(cases.length > 0, 'expected native-control-auth installation fixtures');
  for (const { name, input, output } of cases) {
    assert.strictEqual(installation(input), output, name);
  }
});

test('installation is a single assignment of the object to the global', () => {
  const out = installation({ token: 'example-token' });
  assert.ok(
    out.startsWith(`window.${spec.global} = `),
    'the statement assigns the spec global',
  );
  assert.ok(out.endsWith(';'), 'the statement is one assignment');
  const json = out.slice(`window.${spec.global} = `.length, -1);
  assert.deepStrictEqual(JSON.parse(json), nativeControlAuth({ token: 'example-token' }));
});

test('an empty token hands no credential over, even with a fragment-like object present', () => {
  // The case a port gets wrong by treating an empty token as "set token to the
  // empty string". The page reads an empty token as a request to retire
  // shared-owner auth, so the object must carry no token key at all.
  assert.ok(!('token' in nativeControlAuth({ token: '' })));
  assert.ok(!('token' in nativeControlAuth({})));
  assert.ok(!('token' in nativeControlAuth({ token: null })));
});

test('a partial client descriptor is omitted rather than half sent', () => {
  assert.ok(!('client' in nativeControlAuth({ token: 't', clientId: 'openclaw-ios', platform: 'ios' })));
  assert.ok(!('client' in nativeControlAuth({ token: 't', clientId: 'openclaw-ios' })));
  assert.ok('client' in nativeControlAuth({ token: 't', clientId: 'openclaw-ios', platform: 'ios', deviceFamily: 'iPhone' }));
});
