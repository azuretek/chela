// The update policy lives in the shared core now, so desktop and the iOS client
// answer "what may this build do about a new version" from the same source of
// truth (core/spec/updates.json, pinned by core/fixtures/updates.json and
// core/test/updates.test.js). This is a thin re-export so nothing in desktop has
// to know where it moved: src/main.js and scripts/build.js keep importing the
// same default object, and test/updates.test.js keeps importing the same module.
//
// What did NOT move is the electron-updater wiring, and it was never here: the
// updater instance, the download, the install and the event handlers all live in
// src/main.js, which owns them because they need Electron. This file was always
// only the decision layer, which is why it could be shared in the first place.
//
// One thing stayed behind, and it is the only non-re-export below: statusLine(),
// the single line About shows about updating. It reads the clock through its
// `now` default, and core is deliberately clock-free, so composing that line is
// left with the client that displays it. Everything it says anything about comes
// from the core it sits on top of.

import {
  capability, policy, availableMessage, checkAnswer, shouldReportNoUpdate, channelOf, allowPrerelease,
  checkIntervalMs, ago, INSTALL, MANUAL, NOTIFY, NONE, MAC_SIGNED,
  AVAILABLE, CURRENT, UNAVAILABLE, FAILED,
  STABLE_INTERVAL_MS, PRERELEASE_INTERVAL_MS,
  STALL_MS, stallRemaining, offeredStanding, offeredCaveat, downloadingMessage, stalledMessage,
  // What a check may FETCH, and what it says while it does. Shared core for the
  // same reason the policy is, and re-exported here so src/main.js reads one
  // module. See fetchPlan in core/updates.js.
  fetchPlan, OFFER_INSTALL, OFFER_RELEASE,
} from '../../core/updates.js';
// ★ The desktop's answer to "is the feed's newest build newer than this one"
// comes from the same owner the phone calls, not from a comparison written
// here. It has to: electron-updater ranks the build and commit tail itself
// (`semver.gt` inside its `isUpdateAvailable`), and that tail's basis has
// changed, so the dependency can conclude this build is AHEAD of the feed and
// report nothing. main.js re-decides with this. See `isNewerBuild` in
// core/feed.js for the rule and `compareRelease` in core/version.js for why the
// tail must never be ranked.
import { newerVersion, isNewerBuild } from '../../core/feed.js';

export {
  capability, policy, availableMessage, checkAnswer, shouldReportNoUpdate, channelOf, allowPrerelease,
  checkIntervalMs, ago, INSTALL, MANUAL, NOTIFY, NONE, MAC_SIGNED,
  AVAILABLE, CURRENT, UNAVAILABLE, FAILED,
  STABLE_INTERVAL_MS, PRERELEASE_INTERVAL_MS,
  newerVersion, isNewerBuild,
  // The download phase: how long a transfer may say nothing before the card stops
  // calling it progress, the re-arm rule, and the wording for both phases. Shared
  // core, re-exported here so src/main.js and test/updates.test.js keep reading one
  // module, the same shape the whole policy moved in. fetchPlan is the same
  // split one layer down: how long a transfer may be silent before it stops
  // being called progress is core's, and so is whether a check may start one.
  STALL_MS, stallRemaining, offeredStanding, offeredCaveat, downloadingMessage, stalledMessage,
  fetchPlan, OFFER_INSTALL, OFFER_RELEASE,
};

/**
 * The single line About shows about updating.
 *
 * It exists because updating is otherwise entirely invisible: it succeeds
 * silently, and the only proof it ever ran is a file in a cache directory. An
 * app that quietly keeps itself current and an app whose update check has been
 * failing for a month look exactly alike from the outside, which is a fair
 * reason to doubt the first one.
 *
 * Three facts, in the order someone doubting it would ask for them: which
 * releases this build follows, what it does when it finds one, and when it last
 * looked. Nothing is persisted, so "no check yet" means this run, which is the
 * truth, and a stored timestamp claiming otherwise would not be.
 *
 * @param {object} opts
 * @param {string} opts.action        from policy()
 * @param {string} opts.reason        from policy()
 * @param {string|null} [opts.channel] from channelOf()
 * @param {number|null} [opts.checkedAt]  Date.now() of the last completed check
 * @param {string|null} [opts.result]     how that check ended
 * @param {{version: string, reason: string}|null} [opts.suppressed]  a version this app will not fetch on its own
 * @param {number} [opts.now]
 */
export function statusLine({ action, reason, channel = null, checkedAt = null, result = null, suppressed = null, now = Date.now() }) {
  const follows = `${channel || 'stable'} channel`;
  if (action === NONE) return `Updates: not checked, ${reason}`;

  const behaviour = {
    [INSTALL]: 'installed automatically',
    [MANUAL]: 'installed when you ask',
  }[action] || 'announced, installed by hand';
  const when = checkedAt === null ? null : ago(now - checkedAt);
  const last = when ? `last checked ${when}${result ? `, ${result}` : ''}` : 'no check yet this run';
  // ★ A version this app has been told to stop fetching on its own is a state a
  // reader has to be able to FIND, or the quiet it buys reads as the app having
  // forgotten the release. It rides here rather than on the bar, which is what
  // the suppression is for, and it says which of the two reasons it was, because
  // "nothing arrived" and "you cleared it" are different things to be told.
  const held = suppressed && suppressed.version
    ? `; not fetching ${suppressed.version} on its own (${suppressed.reason === 'cleared' ? 'you cleared it' : 'it produced nothing'})`
    : '';
  return `Updates: ${follows}, ${behaviour}; ${last}${held}`;
}

/**
 * How far a download has got, as a fraction, or null when that is not knowable.
 *
 * electron-updater reports a `percent` that is already 0 to 100, and reports it
 * as a float: 41.66666. The fraction is what the banner draws, so it is clamped
 * and left unrounded here, and rounding to something a person reads is the
 * display's job rather than this function's.
 *
 * Read defensively rather than destructured in the signature, because the one
 * thing an unknown or absent progress report must not do is throw inside an
 * event handler: the banner would lose the notice it was already showing.
 *
 * @param {object|null} [info]  electron-updater's DownloadProgress
 */
export function downloadProgress(info) {
  const percent = info ? info.percent : null;
  if (!Number.isFinite(percent)) return null;
  return Math.min(1, Math.max(0, percent / 100));
}

/** A byte count in the largest unit that still reads as a number. */
function size(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  if (mb < 1000) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * The line under "Downloading ...": how much has arrived, and how fast.
 *
 * Every part is optional, because electron-updater does not promise a total or
 * a rate and the fields arrive as zero when it does not know. A sentence that
 * says "0 MB of 0 MB" would be worse than one that says less, so a part with
 * nothing behind it is left out rather than filled in.
 *
 * @param {object|null} [info]  electron-updater's DownloadProgress
 * @returns {string|null}
 */
export function transferDetail(info) {
  const { transferred = 0, total = 0, bytesPerSecond = 0 } = info || {};
  const arrived = size(transferred);
  const whole = size(total);
  const rate = size(bytesPerSecond);
  const parts = [];
  if (arrived && whole) parts.push(`${arrived} of ${whole}`);
  else if (arrived) parts.push(arrived);
  if (rate) parts.push(`${rate}/s`);
  return parts.length ? parts.join(', ') : null;
}

export default {
  capability, policy, availableMessage, checkAnswer, shouldReportNoUpdate, channelOf, allowPrerelease,
  checkIntervalMs, ago, statusLine, downloadProgress, transferDetail, newerVersion, isNewerBuild,
  INSTALL, MANUAL, NOTIFY, NONE, MAC_SIGNED, STABLE_INTERVAL_MS, PRERELEASE_INTERVAL_MS,
  AVAILABLE, CURRENT, UNAVAILABLE, FAILED,
  STALL_MS, stallRemaining, offeredStanding, offeredCaveat, downloadingMessage, stalledMessage,
  fetchPlan, OFFER_INSTALL, OFFER_RELEASE,
};
