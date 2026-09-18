// The bootstrap crash-loop health check: is the running build coming up, or
// dying before it finishes?
//
// A build that crashes before its own code runs cannot report anything, so the
// signal has to survive the crash. desktop/src/main.js writes a boot-attempt
// marker to its persistent config store BEFORE init starts and clears it once
// the window signals renderer-ready. A marker still present on the next launch
// is a boot that never finished, and N consecutive uncleared markers is a build
// that cannot come up rather than a one-off crash.
//
// This module is the pure decision and nothing else: it reads the marker record
// and the threshold and says whether the build is bad. It is Electron-free, reads
// nothing ambient, and NEVER writes or clears the marker (that is the client's
// job, because only the client knows when a boot genuinely finished). Keeping it
// read-only is what lets both clients share one decision while each owns its own
// persistence. See core/spec/bootstrap-health.json for the argument.

import spec from './spec/bootstrap-health.json' with { type: 'json' };

export const DEFAULT_THRESHOLD = spec.defaults.threshold;
export const STAGES = spec.stages;

/**
 * A fresh marker for a boot that is starting now.
 *
 * The count is the number of consecutive boots that have started without a clean
 * finish, THIS one included: the client increments the previous record's count
 * when it writes a new marker ahead of init, and resets to a clean state when a
 * boot reaches renderer-ready. `version` is the build the attempts are against,
 * so a fresh install of a new build starts the count over rather than inheriting
 * the old build's failures.
 */
export function beginAttempt(previous, version, stage = STAGES[0], now = Date.now()) {
  const prior = markerFor(previous, version);
  return {
    version: typeof version === 'string' ? version : null,
    // Consecutive attempts against THIS version. A record for a different
    // version does not carry its count forward, which is what makes a downgrade
    // or a fresh build start clean.
    attempts: (prior ? prior.attempts : 0) + 1,
    stage: STAGES.includes(stage) ? stage : STAGES[0],
    at: now,
  };
}

/**
 * The marker after a boot reached a later stage, so a report can say where a
 * crash landed without the count moving. Returns the record unchanged when the
 * stage is not one we name.
 */
export function reachedStage(marker, stage) {
  if (!marker || !STAGES.includes(stage)) return marker;
  return { ...marker, stage };
}

/** The record for THIS version, or null if the stored one is for another build. */
function markerFor(marker, version) {
  if (!marker || typeof marker !== 'object') return null;
  if (typeof marker.attempts !== 'number' || !Number.isFinite(marker.attempts)) return null;
  if (typeof version === 'string' && typeof marker.version === 'string' && marker.version !== version) {
    return null;
  }
  return marker;
}

/**
 * The verdict on a marker read at launch, BEFORE this launch's own attempt is
 * written. `bad` is true when the build has failed to come up `threshold` times
 * in a row: that is the crash loop, and it is what the banner and the automatic
 * rollback key off.
 *
 * `version` scopes the count: a marker left by a different build is not this
 * build's crash loop, so it reports zero attempts and is never bad. This is the
 * property that keeps a rollback from immediately judging the good build bad on
 * the strength of the broken build's leftover marker.
 */
export function assess(marker, { version = null, threshold = DEFAULT_THRESHOLD } = {}) {
  const limit = Number.isInteger(threshold) && threshold > 0 ? threshold : DEFAULT_THRESHOLD;
  const record = markerFor(marker, version);
  const attempts = record ? record.attempts : 0;
  return {
    attempts,
    stage: record ? record.stage : null,
    version: record ? record.version : null,
    threshold: limit,
    bad: attempts >= limit,
  };
}

/**
 * The broken-build banner's words, from a verdict.
 *
 * Pure and copy-only: it composes what the reader sees and never raises the
 * notice, which keeps the store and the notice surface with the client that owns
 * them (the same split as core/updates.js checkAnswer). Returns null when the
 * verdict is not bad, so the caller has one thing to check. The stage is named
 * when it is known, because "it kept failing to start" is more actionable with
 * WHERE it failed, and left out rather than guessed when it is not.
 */
export function brokenBuildBanner(verdict, { canRollback = false } = {}) {
  if (!verdict || !verdict.bad) return null;
  const where = verdict.stage ? ` while it was still coming up (${verdict.stage})` : '';
  const message = 'This version keeps failing to start.';
  const detail = canRollback
    ? `It failed to finish starting ${verdict.attempts} times in a row${where}, so it can be rolled back to the last version that worked.`
    : `It failed to finish starting ${verdict.attempts} times in a row${where}. There is no earlier version to roll back to on this install, so reinstall from the release page.`;
  return { message, detail, attempts: verdict.attempts, stage: verdict.stage };
}
