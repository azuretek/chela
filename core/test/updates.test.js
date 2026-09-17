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
  STALL_MS, stallRemaining, offeredStanding, offeredCaveat, downloadingMessage, stalledMessage,
  fetchPlan, OFFER_INSTALL, OFFER_RELEASE,
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

/*
 * ★ The download that sat at 0% with no way out.
 *
 * Abi, 2026-09-17: a banner reading "Downloading Claw Control UI <version>.
 * Starting the download." with the bar at zero and no control that would take it
 * away. Two faults, and both are covered here or in the desktop's own tests: a
 * surface reporting progress that was not happening, and a card with no way out.
 *
 * The RULE these pin is one sentence: a transfer that has produced nothing for a
 * named window is not progress, and the app must say something true about it
 * rather than leave a bar where it stopped. What it must NOT do is claim the
 * download failed or cut it off, because neither is known.
 */

test('the stall window is a named value, from the spec both clients read', () => {
  const spec = load('../spec/updates.json');
  assert.equal(STALL_MS, spec.download.stallMs, 'the window comes from the spec, not from a literal at the timer');
  // A window has to outlast the transport flapping underneath it and still be
  // short enough that nobody watches a frozen bar through it. The bounds are loose
  // on purpose: what they catch is a typo'd unit, not a taste.
  assert.ok(STALL_MS >= 15000, `${STALL_MS}ms is short enough to cut off a working download`);
  assert.ok(STALL_MS <= 120000, `${STALL_MS}ms is long enough to read as the bar being stuck`);
});

test('the window is measured from the last movement, so a slow download is never cut off', () => {
  // ★ This is the whole stalled-versus-slow answer, as arithmetic.
  //
  // A transfer that keeps arriving re-arms the window on every chunk, so what is
  // left of it is what matters: 40 seconds of quiet is 5 seconds of window, and a
  // download that has been trickling along for an hour still has the full window
  // ahead of it. A rate threshold is the check that would cut a working download
  // off, and there is deliberately none.
  assert.equal(stallRemaining(0), STALL_MS, 'a fresh transfer has the whole window');
  assert.equal(stallRemaining(40000), STALL_MS - 40000, 'movement spends the window from the last event');
  assert.equal(stallRemaining(STALL_MS), 0, 'the window is spent exactly at the named value');
  assert.equal(stallRemaining(STALL_MS * 3), 0, 'a very late timer cannot report a negative window');
  // A clock that went backwards, or a caller that passed nothing, is "no quiet
  // time observed" rather than a negative or NaN delay a timer would fire at once.
  assert.equal(stallRemaining(-5000), STALL_MS);
  assert.equal(stallRemaining(undefined), STALL_MS);
  assert.equal(stallRemaining(NaN), STALL_MS);
});

test('the stalled card says what is known, and does not claim the download failed', () => {
  const { message, detail } = stalledMessage({ version: '1.0.2', current: '1.0.1' });
  assert.match(message, /1\.0\.2/, 'it still names the version it is about');
  assert.match(message, /stopped making progress/i);
  assert.match(detail, /45 seconds/, 'the window is named, so "why now" has an answer');
  assert.match(detail, /not been cancelled/i, 'nothing was cancelled, so nothing may say it was');
  assert.match(detail, /may still finish/i, 'and the transfer really may still land');
  // What it must never say. A card that reported a failure here would be the same
  // fault one state over: describing a state the app is not in.
  assert.doesNotMatch(`${message} ${detail}`, /fail|error|could not/i);
});

test('a download names the version and says how far it has got, or that it is starting', () => {
  const starting = downloadingMessage({ version: '1.0.2', current: '1.0.1' });
  assert.equal(starting.message, 'Downloading Claw Control UI 1.0.2.');
  assert.equal(starting.detail, 'Starting the download.');
  const moving = downloadingMessage({ version: '1.0.2', current: '1.0.1', transfer: '12 MB of 130 MB, 900 kB/s' });
  assert.equal(moving.detail, "12 MB of 130 MB, 900 kB/s", "the client's own arrival line is used as it stands");
});

test('★ a build numbered below the one running is not presented as an upgrade', () => {
  // The case the numbering basis moved under us to create: the feed hands over the
  // newest release by PUBLISH TIME, so the number it carries can be below the
  // installed one. Whether to update is decided elsewhere and is not changed here.
  const lower = '1.0.1-dev.38.a1b2c3d4e5';
  const running = '1.0.1-dev.42.b2c3d4e5f6';
  assert.equal(offeredStanding(lower, running), 'lower');
  assert.match(offeredCaveat(lower, running), /numbered below the build you are running/);

  const offered = downloadingMessage({ version: lower, current: running, transfer: '4 MB of 130 MB' });
  assert.match(offered.detail, /not an upgrade/, 'a lower number is named as not an upgrade, even mid-download');
  assert.match(offered.detail, /4 MB of 130 MB/, 'and the arrival line survives the caveat');

  // And the ordinary path stays quiet. A caveat on every offer is a caveat nobody
  // reads by the second one.
  assert.equal(offeredStanding('1.0.1-dev.150.abc1234567', '1.0.1-dev.148.abc1234567'), 'newer');
  assert.equal(offeredCaveat('1.0.2', '1.0.1'), '');
  assert.equal(downloadingMessage({ version: '1.0.2', current: '1.0.1' }).detail, 'Starting the download.');

  // The comparison is by semver PRECEDENCE, not by release: what the reader is
  // shown is the whole string, which is the opposite of the rule an update
  // DECISION uses. Same release, lower tail, reads as lower.
  assert.equal(offeredStanding('1.0.1-dev.38.a1b2c3d4e5', '1.0.1-dev.42.b2c3d4e5f6'), 'lower');
  // Same string twice is a re-release rather than a newer version.
  assert.equal(offeredStanding('1.0.2', '1.0.2'), 'same-build');
  assert.match(offeredCaveat('1.0.2', '1.0.2'), /same number/);
  // A version this build cannot parse is a non-answer, not a caveat to invent.
  assert.equal(offeredStanding('not-a-version', '1.0.1'), null);
  assert.equal(offeredCaveat('not-a-version', '1.0.1'), '');
});

/*
 * fetchPlan(): what a check may fetch, and what it says while it does.
 *
 * The rule these pin is the one the reported bug turned on: a transfer nobody
 * asked for is silent until it has evidence, so a progress bar can only ever be
 * drawn over movement that actually happened. The rest is that rule's edges -- a
 * press is owed the card at once, a version the reader already ended is not
 * re-raised on the next launch, and a build that cannot fetch at all must still
 * say where the release is.
 */
test('a background fetch is quiet until it has evidence, and a press is not', () => {
  assert.deepEqual(fetchPlan({ action: INSTALL, version: '1.0.2', trigger: 'scheduled' }),
    { fetch: true, quiet: true, offer: null });
  // The launch check is a background check: 60 seconds into a run, with nobody
  // having asked for anything, which is exactly where the 0% card came from.
  assert.deepEqual(fetchPlan({ action: INSTALL, version: '1.0.2', trigger: 'startup' }),
    { fetch: true, quiet: true, offer: null });
  // Someone pressed Check. Their press is the thing the card answers.
  assert.deepEqual(fetchPlan({ action: INSTALL, version: '1.0.2', trigger: 'manual' }),
    { fetch: true, quiet: false, offer: null });
});

test('a version whose transfer already ended here is not fetched again on our own', () => {
  // The reader cleared the card, or it produced nothing for the stall window.
  const suppressed = fetchPlan({ action: INSTALL, version: '1.0.2', suppressedVersion: '1.0.2', trigger: 'startup' });
  assert.equal(suppressed.fetch, false, 'nothing is started');
  assert.equal(suppressed.quiet, true, 'and nothing is announced in the background');
  assert.equal(suppressed.offer, null, 'which is what stops a relaunch undoing a dismissal');
  // A person who presses Check still gets an answer, with the button: the
  // suppression is about fetching by ourselves, not about telling them.
  assert.deepEqual(fetchPlan({ action: INSTALL, version: '1.0.2', suppressedVersion: '1.0.2', trigger: 'manual' }),
    { fetch: true, quiet: false, offer: null });
});

test('the suppression names ONE version, so the next release is fetched normally', () => {
  assert.deepEqual(fetchPlan({ action: INSTALL, version: '1.0.3', suppressedVersion: '1.0.2', trigger: 'startup' }),
    { fetch: true, quiet: true, offer: null });
  assert.deepEqual(fetchPlan({ action: INSTALL, version: '1.0.2', suppressedVersion: null, trigger: 'startup' }),
    { fetch: true, quiet: true, offer: null });
});

test('the offer follows the policy action, because only one of the two is true', () => {
  // Automatic updates off: this build CAN install, and is waiting to be told.
  assert.equal(fetchPlan({ action: MANUAL, version: '1.0.2', trigger: 'startup' }).offer, OFFER_INSTALL);
  // Cannot install at all: a button here would do nothing, so it points at the
  // release page instead.
  assert.deepEqual(fetchPlan({ action: NOTIFY, version: '1.0.2', trigger: 'scheduled' }),
    { fetch: false, quiet: false, offer: OFFER_RELEASE });
  // Even for a version the reader cleared: announcing is the whole of what this
  // build can do, so silence would hide the only way on.
  assert.equal(fetchPlan({ action: NOTIFY, version: '1.0.2', suppressedVersion: '1.0.2', trigger: 'scheduled' }).offer,
    OFFER_RELEASE);
});
