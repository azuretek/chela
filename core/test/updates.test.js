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

import {
  capability, policy, checkAnswer, INSTALL, NOTIFY, NONE, MANUAL,
  AVAILABLE, CURRENT, UNAVAILABLE, FAILED,
} from '../updates.js';
// The tones the answers are drawn in, imported from the notice model rather than
// written as literals: what a tone IS belongs to that module, and a test naming
// 'ok' by hand would pass while the two drifted.
import { INFO, WARN, OK } from '../notices.js';

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

/*
 * What a check says when someone presses the button.
 *
 * The bug these exist for: a control that appears to work and reports nothing.
 * The check ran, compared, and found a release, and no surface said so. So the
 * two directions are asserted here rather than one, because a proof that only
 * covers "an update is found" is exactly the shape that let the silent half
 * through, and the silent half is the harder one: it is the outcome where the
 * code has nothing to draw and is most likely to draw it.
 */
test('a check that finds a newer version names it', () => {
  const answer = checkAnswer({
    outcome: AVAILABLE, trigger: 'manual', version: '1.0.2', current: '1.0.1', action: INSTALL,
  });
  assert.ok(answer, 'a manual check that finds a release must say something');
  assert.match(answer.message, /1\.0\.2/, 'the headline must name the version found');
  assert.equal(answer.tone, INFO);
});

test('a check that finds nothing still says so, to the person who asked', () => {
  const answer = checkAnswer({ outcome: CURRENT, trigger: 'manual', current: '1.0.1' });
  assert.ok(answer, 'a manual check owes an answer in both directions');
  assert.equal(answer.tone, OK);
  assert.match(answer.message, /up to date/i);
  assert.match(answer.detail, /1\.0\.1/, 'and it names the build you are on');
});

test('a background check that finds nothing keeps its silence', () => {
  for (const trigger of ['startup', 'scheduled']) {
    assert.equal(checkAnswer({ outcome: CURRENT, trigger, current: '1.0.1' }), null, `${trigger} must be silent`);
    assert.equal(checkAnswer({ outcome: UNAVAILABLE, trigger, current: '1.0.1', reason: 'running from source' }), null,
      `${trigger} must not announce that it cannot check`);
    // And a background check that FAILED says nothing either. A dev build checks
    // every five minutes, so a warning per flaky network is the noise this rule is
    // for; the press is the case that is owed the bad news.
    assert.equal(checkAnswer({ outcome: FAILED, trigger, current: '1.0.1', error: 'offline' }), null,
      `${trigger} must not announce a failed check`);
  }
});

test('a check that cannot run at all answers the press, and only the press', () => {
  const pressed = checkAnswer({
    outcome: UNAVAILABLE, trigger: 'manual', current: '1.0.1', reason: 'running from source',
  });
  assert.ok(pressed, 'pressing the button in a build that cannot check must not do nothing');
  assert.match(pressed.detail, /Running from source/, 'the reason stands alone as a sentence');
});

test('a failed check says so rather than looking like a check that found nothing', () => {
  const answer = checkAnswer({ outcome: FAILED, trigger: 'manual', current: '1.0.1', error: 'net down' });
  assert.equal(answer.tone, WARN, 'a check that could not finish is not good news');
  assert.equal(answer.detail, 'Net down.');
});

test('the phone points at where the build is, and core names no channel of its own', () => {
  // iOS cannot install its own update, so its last sentence is the client's. The
  // shared default must not name a distribution channel, which is the same rule
  // capability() follows for the ios reason.
  const shared = checkAnswer({
    outcome: AVAILABLE, trigger: 'manual', version: '1.0.2', current: '1.0.1', action: NOTIFY, reason: 'it cannot install its own update',
  });
  const phone = checkAnswer({
    outcome: AVAILABLE, trigger: 'manual', version: '1.0.2', current: '1.0.1', action: NOTIFY,
    reason: 'it cannot install its own update', pointer: 'Open TestFlight to update.',
  });
  assert.doesNotMatch(shared.detail.toLowerCase(), /testflight|app store/, 'core names no distribution channel');
  assert.match(phone.detail, /Open TestFlight to update\.$/);
  assert.match(phone.detail, /1\.0\.1/, 'and it still says which build you are on');
});

test('the outcome names come from the spec, like the action names', () => {
  const spec = load('../spec/updates.json');
  assert.deepStrictEqual(
    [AVAILABLE, CURRENT, UNAVAILABLE, FAILED],
    [spec.outcomes.available, spec.outcomes.current, spec.outcomes.unavailable, spec.outcomes.error],
  );
});
