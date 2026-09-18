// The bootstrap crash-loop decision, checked in both directions: a build that is
// coming up cleanly is never called bad, and a build that has failed to reach
// renderer-ready threshold times in a row always is.
//
// The three things this file exists to catch:
//   - a decision that never fires, so a genuinely broken build loops forever
//     with no banner and no rollback;
//   - a decision that fires on a healthy build, which would roll back a working
//     release on the strength of one force-quit;
//   - a count that carries across BUILDS, so the good build we rolled back to is
//     judged bad on the broken build's leftover marker, which would undo the
//     rollback we just made.

import test from 'node:test';
import assert from 'node:assert';

import {
  DEFAULT_THRESHOLD, STAGES, beginAttempt, reachedStage, assess,
} from '../bootstrap-health.js';

const V = '1.0.1-dev.139.7d21fe49cd';
const OTHER = '1.0.0-dev.100.aaaaaaaaaa';

test('a first boot of a build starts the count at one', () => {
  const marker = beginAttempt(null, V);
  assert.strictEqual(marker.attempts, 1);
  assert.strictEqual(marker.version, V);
  assert.strictEqual(marker.stage, STAGES[0]);
});

test('consecutive uncleared boots accumulate, and the count is what the verdict reads', () => {
  let marker = beginAttempt(null, V);
  assert.strictEqual(assess(marker, { version: V }).attempts, 1);
  marker = beginAttempt(marker, V);
  marker = beginAttempt(marker, V);
  assert.strictEqual(marker.attempts, 3);
});

test('a healthy build is never bad, because a clean boot clears the marker', () => {
  // The clear is the client writing null; the decision on a null marker is zero.
  const verdict = assess(null, { version: V });
  assert.strictEqual(verdict.attempts, 0);
  assert.strictEqual(verdict.bad, false);
});

test('the default threshold is a loop and not an accident', () => {
  assert.strictEqual(DEFAULT_THRESHOLD, 3);
  // One and two are not yet a loop; the threshold-th consecutive attempt is.
  let marker = beginAttempt(null, V);
  assert.strictEqual(assess(marker, { version: V }).bad, false, 'one crash is a loop');
  marker = beginAttempt(marker, V);
  assert.strictEqual(assess(marker, { version: V }).bad, false, 'two crashes is a loop');
  marker = beginAttempt(marker, V);
  assert.strictEqual(assess(marker, { version: V }).bad, true, 'three consecutive uncleared boots is not a loop');
});

test('the threshold is the caller\'s to set, and a bad one falls back to the default', () => {
  let marker = beginAttempt(null, V);
  marker = beginAttempt(marker, V);
  assert.strictEqual(assess(marker, { version: V, threshold: 2 }).bad, true, 'a threshold of two was not honoured');
  assert.strictEqual(assess(marker, { version: V, threshold: 0 }).threshold, DEFAULT_THRESHOLD, 'a zero threshold was not rejected');
  assert.strictEqual(assess(marker, { version: V, threshold: -5 }).threshold, DEFAULT_THRESHOLD);
  assert.strictEqual(assess(marker, { version: V, threshold: 2.5 }).threshold, DEFAULT_THRESHOLD, 'a fractional threshold was not rejected');
});

test('the count is scoped to the build, so a rollback is not judged on the broken build marker', () => {
  // Three failed boots of the broken build.
  let marker = beginAttempt(null, OTHER);
  marker = beginAttempt(marker, OTHER);
  marker = beginAttempt(marker, OTHER);
  assert.strictEqual(assess(marker, { version: OTHER }).bad, true, 'the broken build is not seen as bad');

  // Now running the good build we rolled back to: the marker is the broken
  // build's, and it must NOT count against the good one.
  const afterRollback = assess(marker, { version: V });
  assert.strictEqual(afterRollback.attempts, 0, 'the good build inherited the broken build failure count');
  assert.strictEqual(afterRollback.bad, false, 'the good build was judged bad on another build marker');

  // And a fresh attempt of the good build starts its own count at one.
  const fresh = beginAttempt(marker, V);
  assert.strictEqual(fresh.attempts, 1, 'the good build first boot did not start clean');
});

test('the stage travels on the marker but never moves the count', () => {
  let marker = beginAttempt(null, V);
  assert.strictEqual(marker.stage, STAGES[0]);
  marker = reachedStage(marker, 'gateway-connect');
  assert.strictEqual(marker.stage, 'gateway-connect', 'the stage did not advance');
  assert.strictEqual(marker.attempts, 1, 'advancing the stage changed the count');
  // An unknown stage is ignored rather than trusted.
  const before = marker.stage;
  marker = reachedStage(marker, 'not-a-stage');
  assert.strictEqual(marker.stage, before, 'an unknown stage was written to the marker');
  assert.strictEqual(assess(marker, { version: V }).stage, 'gateway-connect');
});

test('a malformed marker reads as no crash rather than throwing', () => {
  for (const junk of [undefined, {}, { attempts: 'three' }, { attempts: NaN }, 42, 'nope']) {
    const verdict = assess(junk, { version: V });
    assert.strictEqual(verdict.attempts, 0, `${JSON.stringify(junk)} was not treated as clean`);
    assert.strictEqual(verdict.bad, false);
  }
});

test('the module does not write or clear: begin returns a new record and leaves the input alone', () => {
  const previous = beginAttempt(null, V);
  const snapshot = JSON.stringify(previous);
  const next = beginAttempt(previous, V);
  assert.strictEqual(JSON.stringify(previous), snapshot, 'beginAttempt mutated the record it was given');
  assert.notStrictEqual(next, previous, 'beginAttempt returned the same object rather than a new one');
});
