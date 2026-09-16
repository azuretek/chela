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
  capability, policy, availableMessage, shouldReportNoUpdate, channelOf, allowPrerelease,
  checkIntervalMs, ago, INSTALL, MANUAL, NOTIFY, NONE, MAC_SIGNED,
  STABLE_INTERVAL_MS, PRERELEASE_INTERVAL_MS,
} from '../../core/updates.js';

export {
  capability, policy, availableMessage, shouldReportNoUpdate, channelOf, allowPrerelease,
  checkIntervalMs, ago, INSTALL, MANUAL, NOTIFY, NONE, MAC_SIGNED,
  STABLE_INTERVAL_MS, PRERELEASE_INTERVAL_MS,
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
 * @param {number} [opts.now]
 */
export function statusLine({ action, reason, channel = null, checkedAt = null, result = null, now = Date.now() }) {
  const follows = `${channel || 'stable'} channel`;
  if (action === NONE) return `Updates: not checked, ${reason}`;

  const behaviour = {
    [INSTALL]: 'installed automatically',
    [MANUAL]: 'installed when you ask',
  }[action] || 'announced, installed by hand';
  const when = checkedAt === null ? null : ago(now - checkedAt);
  const last = when ? `last checked ${when}${result ? `, ${result}` : ''}` : 'no check yet this run';
  return `Updates: ${follows}, ${behaviour}; ${last}`;
}

export default {
  capability, policy, availableMessage, shouldReportNoUpdate, channelOf, allowPrerelease,
  checkIntervalMs, ago, statusLine,
  INSTALL, MANUAL, NOTIFY, NONE, MAC_SIGNED, STABLE_INTERVAL_MS, PRERELEASE_INTERVAL_MS,
};
