// Parity tests: the JS reproduces every golden fixture exactly.
//
// These are the contract a Swift port proves itself against, the same shape as
// core/test/fixtures.test.js. The fixtures in core/fixtures/ are input/output
// pairs generated from this JS, and both this test and the iOS client's Swift
// tests assert the same pairs, so "the two clients agree about what this build
// may do" is a thing that is checked rather than hoped for. If a spec value
// changes, regenerate the fixtures and both sides move together.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { capability, policy, INSTALL, NOTIFY, NONE, MANUAL } from '../updates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');

function load(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/** The four fields the fixtures pin, in one place so they cannot drift apart. */
function tuple(plan) {
  return {
    action: plan.action,
    check: plan.check,
    autoDownload: plan.autoDownload,
    canInstall: plan.canInstall,
  };
}

test('updates.policy() reproduces every fixture', () => {
  const { cases } = load('updates.json');
  assert.ok(cases.length > 0, 'expected update policy fixtures');
  for (const { name, input, output } of cases) {
    assert.deepStrictEqual(
      tuple(policy(input)),
      output,
      `${name}: policy(${JSON.stringify(input)})`,
    );
  }
});

test('the fixture cases cover every platform the policy branches on', () => {
  // A fixture set that quietly lost a platform would still pass every assertion
  // above, one case lighter, which is the failure a golden-file test can least
  // afford.
  const { cases } = load('updates.json');
  const covered = new Set(cases.map((c) => c.input.platform));
  for (const platform of ['win32', 'darwin', 'linux', 'ios']) {
    assert.ok(covered.has(platform), `no fixture for ${platform}`);
  }
  assert.ok(cases.some((c) => c.input.packaged === false), 'no fixture for a source run');
  assert.ok(
    cases.filter((c) => c.input.autoUpdate === false).length >= 2,
    'the automatic-updates preference needs at least two fixtures',
  );
});

test('ios is NOTIFY on purpose, not by falling through the unknown-platform branch', () => {
  // The two answers agree today: iOS reaches the same action, check and
  // autoDownload as an unrecognised platform does. This is what keeps that
  // agreement from being the reason it works. The reason string is the evidence
  // that the branch is deliberate.
  const ios = capability({ platform: 'ios', packaged: true });
  const unknown = capability({ platform: 'freebsd', packaged: true });
  assert.equal(ios.action, NOTIFY);
  assert.equal(ios.check, true, 'noticing a release is the whole of what iOS can do');
  assert.equal(ios.autoDownload, false);
  assert.match(ios.reason, /iOS/);
  assert.match(ios.reason, /install its own update/);
  assert.notEqual(ios.reason, unknown.reason);
});

test('the ios reason names no distribution channel', () => {
  // Which mechanism delivers the next build is an open decision, so the policy
  // must not have settled it in a sentence nobody reviews.
  const { reason } = capability({ platform: 'ios', packaged: true });
  for (const channel of ['TestFlight', 'testflight', 'App Store', 'AppStore', 'manifest', 'ad-hoc', 'ad hoc', 'enterprise']) {
    assert.doesNotMatch(reason, new RegExp(channel), `the ios reason should not name ${channel}`);
  }
});

test('the environment cannot change the answer', () => {
  // The policy used to read APPIMAGE for itself. It must not any more: a core
  // module that reads the environment is a module that answers differently on
  // the machine it shipped to, and the desktop caller is the one place that can
  // honestly see that variable.
  const before = process.env.APPIMAGE;
  process.env.APPIMAGE = '/tmp/Claw-1.0.0.AppImage';
  try {
    const cap = capability({ platform: 'linux', packaged: true });
    assert.equal(cap.check, false, 'an omitted appImage means "not an AppImage", not "ask the environment"');
    assert.equal(cap.action, NOTIFY);
  } finally {
    if (before === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = before;
  }
});

test('the action names come from the spec, not from string literals', () => {
  // spec/updates.json is the one source of truth for the four names, so a client
  // comparing against a literal cannot silently disagree with it.
  const spec = load('../spec/updates.json');
  assert.deepStrictEqual(
    [INSTALL, MANUAL, NOTIFY, NONE],
    [spec.actions.install, spec.actions.manual, spec.actions.notify, spec.actions.none],
  );
});
