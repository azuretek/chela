// What a client is allowed to do about a new version, per platform.
//
// The answer is not the same everywhere, and the reason is code signing rather
// than anything we chose:
//
//   Windows   Full auto-update, even unsigned. electron-updater's
//             `NsisUpdater.verifySignature()` reads `publisherName` from
//             app-update.yml and returns null when there is none, so an
//             unsigned build skips verification and installs normally.
//
//   macOS     Download and notify only. `MacUpdater` hands the update to native
//             Squirrel.Mac, which requires a valid signature on the *running*
//             bundle; an unsigned app fails with "Could not get code signature
//             for running application". No configuration avoids that -- it
//             needs an Apple Developer ID.
//
//   Linux     Full auto-update, but only while running as an AppImage.
//             `AppImageUpdater` replaces the .AppImage file the process was
//             started from, so it needs no signature, no package manager and no
//             root -- but it does need that file, which it finds through the
//             `APPIMAGE` environment variable the AppImage runtime sets. Started
//             any other way, `isUpdaterActive()` returns false and every check
//             resolves to null without emitting anything, so the honest answer
//             there is to not check and to say why.
//
//             That asymmetry is why AppImage is the only Linux target built. The
//             .deb and .rpm updaters exist, but they run dpkg or rpm through
//             pkexec, so every update raises a password prompt.
//
//   iOS       No self-update at all, and this one is a platform rule rather
//             than a signing fact: an app cannot install its own new version,
//             because installation is the operating system's job rather than the
//             app's. So the most a build can do is notice that a release exists,
//             tell the user, and hand them a link. The reason below names no
//             distribution channel on purpose: which one delivers the new build
//             is an open decision, and a sentence baked into the policy would
//             settle it by accident.
//
// This is the pure decision layer, and it lives in core so that every client
// reads the same answer from one place. It stays free of Electron and of
// `process`, taking `platform`, `packaged`, `macSigned` and `appImage` as
// arguments, so the policy can be tested for every platform from one run and the
// iOS client's Swift port has something to be checked against
// (fixtures/updates.json). Supplying the real values is the caller's job, which
// for desktop is src/main.js: `process.platform`, `app.isPackaged` and
// `Boolean(process.env.APPIMAGE)`.
//
// What is deliberately *not* here is the electron-updater wiring that acts on
// the answer, meaning the updater instance, the download, the install and the
// event handlers. It stays in the client, because none of it is portable and all
// of it needs Electron.
//
// Kept parametric rather than reading a global is the same shape as chrome.js
// taking `platform`.

import spec from './spec/updates.json' with { type: 'json' };
import { product } from './naming.js';
// The version comparator, imported rather than reimplemented, and the semver
// PRECEDENCE one specifically: `offeredCaveat` below asks what a reader can see on
// screen, which is the whole version string. That is deliberately not the
// comparison an update decision uses -- see compareRelease in version.js, and why
// this file needs the other one beside offeredStanding.
import { compare } from './version.js';
// The tones a check's answer is drawn in. Imported rather than spelled here,
// because the notice model owns what a tone IS and a second copy of the four
// names is the drift this module exists to avoid. It is a value import and not a
// dependency on the store: `checkAnswer` below composes what a notice says and
// never raises one, so the notice path itself stays with the client that owns
// the live store.
import { INFO, WARN, OK, sentence } from './notices.js';

// Flip to true when macOS builds are signed with a Developer ID and notarized.
// It is a constant rather than a runtime probe on purpose: asking the OS whether
// the running bundle is signed means shelling out to `codesign` on every check,
// and the answer only changes when the build pipeline changes -- which is a
// commit, not a runtime event.
//
// Signing is credential-driven rather than configured: electron-builder.yml
// carries no `identity` key on purpose, and notarization is switched on per-run
// by scripts/build.js when the App Store Connect variables are present.
//
// This constant describes the builds people install, which come from CI, and
// the release workflow now signs and notarizes the mac leg with a Developer ID.
// It stays a compiled-in constant rather than a runtime `codesign` probe: the
// answer only changes when the build pipeline changes, which is a commit.
//
// The hazard to remember if signing is ever removed: this must go back to false
// in the same commit. A true value on an unsigned build hands the update to
// Squirrel.Mac, which refuses to install over an unsigned running bundle -- the
// exact failure this flag exists to avoid.
export const MAC_SIGNED = true;

/** What to do when a newer version exists. */
export const INSTALL = spec.actions.install; // download it and offer to restart
export const MANUAL = spec.actions.manual; // could install, but only when the user asks for it
export const NOTIFY = spec.actions.notify; // tell the user, link to the release, install by hand
export const NONE = spec.actions.none; // do not even check

/**
 * How a check ended, which is the other half of an answer.
 *
 * An action says what this build may DO about a newer version; an outcome says
 * what a check FOUND. The two are different axes and the checks below read both:
 * an update can be available on a build that can install it (INSTALL, download
 * it) or on one that cannot (NOTIFY, go and get it), and the same sentence has to
 * be true in both cases.
 *
 *   available    there is a newer version on this build's channel
 *   current      there is not: this build is the newest one the channel names
 *   unavailable  this build has no way to ask at all, so the answer is why
 *   error        the check ran and could not finish
 *
 * They mirror `outcomes` in spec/updates.json, which is what the Swift port is
 * proven against, so renaming one is a fixture change rather than a silent
 * divergence between the two clients.
 */
export const AVAILABLE = spec.outcomes.available;
export const CURRENT = spec.outcomes.current;
export const UNAVAILABLE = spec.outcomes.unavailable;
export const FAILED = spec.outcomes.error;

/**
 * What the *platform* allows, ignoring what the user has asked for.
 *
 * Split from policy() because the two answers are needed separately: Settings
 * has to say why the automatic-updates toggle is unavailable on a build that
 * could never install anyway, and that reason is a fact about the build rather
 * than about the preference.
 *
 * `platform`, `packaged`, `macSigned` and `appImage` are all arguments, and none
 * is read from the environment. `appImage` in particular used to default from
 * `Boolean(process.env.APPIMAGE)` in the desktop client; here it is the caller's
 * fact to supply, so a stray `APPIMAGE` in the environment cannot change what
 * this answers and every platform can be exercised from one test run.
 *
 * @param {object} opts
 * @param {string} opts.platform   process.platform
 * @param {boolean} opts.packaged  app.isPackaged
 * @param {boolean} [opts.macSigned]
 * @param {boolean} [opts.appImage]  running from an AppImage (Linux only)
 */
export function capability({ platform, packaged, macSigned = MAC_SIGNED, appImage = false }) {
  // A source run has no app-update.yml and no version worth comparing.
  // electron-updater guards this itself (`app.isPackaged || forceDevUpdateConfig`)
  // but it does so by logging an error, which reads like a fault every `npm start`.
  if (!packaged) {
    return { action: NONE, check: false, autoDownload: false, reason: 'running from source' };
  }

  if (platform === 'win32') {
    return { action: INSTALL, check: true, autoDownload: true, reason: 'NSIS updates do not require a signed build' };
  }

  if (platform === 'darwin') {
    return macSigned
      ? { action: INSTALL, check: true, autoDownload: true, reason: 'signed with a Developer ID' }
      : {
        action: NOTIFY,
        check: true,
        // Downloading something that cannot be installed wastes ~130MB of
        // someone's bandwidth to reach the same dialog.
        autoDownload: false,
        reason: 'unsigned: Squirrel.Mac cannot install an update over an unsigned bundle',
      };
  }

  if (platform === 'linux') {
    return appImage
      ? { action: INSTALL, check: true, autoDownload: true, reason: 'an AppImage replaces itself in place' }
      : {
        action: NOTIFY,
        // Not merely useless but actively misleading: AppImageUpdater's
        // isUpdaterActive() is false without APPIMAGE, so checkForUpdates()
        // returns null having emitted no event at all -- no 'error', no
        // 'update-not-available'. A check that can only ever answer nothing is
        // worse than one that explains itself, and main.js turns check:false
        // into exactly that explanation.
        check: false,
        autoDownload: false,
        reason: 'not running as an AppImage, so there is no file an update could replace',
      };
  }

  // iOS is a branch rather than a fallthrough because it is the one platform
  // where the limit is a rule instead of a signing accident, and because the two
  // answers agree by coincidence: the generic branch below happens to say NOTIFY
  // with the same two flags today, and a fact that is right by accident stops
  // being right the first time anything upstream moves.
  //
  // NOTIFY rather than MANUAL: this build cannot install anything even when
  // asked, so there is no button to offer. `check` stays true because noticing a
  // release is the whole of what this platform can do, and autoDownload stays
  // false because there is nothing to download that the app could apply.
  if (platform === 'ios') {
    return {
      action: NOTIFY,
      check: true,
      autoDownload: false,
      reason: 'iOS does not let an app install its own update, so it can only say a release exists and offer an install link',
    };
  }

  return { action: NOTIFY, check: true, autoDownload: false, reason: 'no tested install path on this platform' };
}

/**
 * How this build should behave about updates, given what the platform allows
 * and what the user has asked for.
 *
 * The preference only ever *narrows* the platform's answer. Turning automatic
 * updates off cannot make a build that could not install start installing, and
 * it does not stop the app looking: knowing a release exists is the thing the
 * user gave up nothing to keep, and it is what makes the manual install offer
 * possible at all.
 *
 * MANUAL rather than NOTIFY when it is off, because the two are different
 * offers and saying the wrong one is worse than saying nothing. NOTIFY means
 * "go and replace the app yourself"; MANUAL means "press the button and I will
 * do it", which is true here, and which NOTIFY's wording would deny.
 *
 * @param {object} opts
 * @param {string} opts.platform   process.platform
 * @param {boolean} opts.packaged  app.isPackaged
 * @param {boolean} [opts.macSigned]
 * @param {boolean} [opts.appImage]  running from an AppImage (Linux only)
 * @param {boolean} [opts.autoUpdate]  the user's preference; config.autoUpdate
 * @returns {{action: string, check: boolean, autoDownload: boolean, reason: string,
 *           canInstall: boolean, capabilityReason: string}}
 */
export function policy({ autoUpdate = true, ...opts }) {
  const base = capability(opts);
  const canInstall = base.action === INSTALL;
  const common = { canInstall, capabilityReason: base.reason };

  if (!canInstall || autoUpdate) return { ...base, ...common };

  return {
    ...common,
    action: MANUAL,
    check: true,
    autoDownload: false,
    reason: 'automatic updates are turned off in Settings',
  };
}

/** What a notice may offer when a release exists. */
export const OFFER_INSTALL = 'install'; // fetch it here, on the button
export const OFFER_RELEASE = 'release'; // go and get it from the release page

/**
 * Whether a check that found a release may fetch it, and what it owes the reader.
 *
 * ★ This exists because the card it governs is not a report of the download. It
 * is a report to a READER, and a reader who never asked for anything is owed
 * nothing until there is something true to say. Electron-updater on a signed mac
 * starts fetching the moment a check finds a release, with nobody in the loop,
 * so the app raised a progress bar at 0% on the strength of having asked for the
 * file -- a claim about movement made before a single byte had moved. When that
 * request then produced nothing at all and never errored (the library has no
 * request timeout anywhere), the bar sat on the screen unchanging, and because
 * the attempt was re-created by every LAUNCH's own check, restarting the app
 * brought it straight back. Measured 2026-09-17 by scripts/test-update-relaunch.js.
 *
 * Three answers, and each is a different sentence to the reader:
 *
 *   fetch, quiet    start it and say NOTHING until evidence of movement arrives
 *                   (a background check: nobody asked, so a bar at zero is a
 *                   claim with nothing behind it)
 *   fetch, loud     start it and show the card at once (someone pressed Check,
 *                   so the card is the answer to their press)
 *   no fetch        do not start this version's transfer again on our own, and
 *                   say nothing about it in the background. The reader ended
 *                   that transfer once already -- they cleared the card, or it
 *                   produced nothing for the whole stall window -- and re-raising
 *                   it on the next launch is precisely the bug above.
 *
 * `suppressedVersion` is that record, and it is ONE version: a later release is a
 * different transfer and is offered normally, which is why the caller compares
 * rather than this function keeping history.
 *
 * The offer a notice carries is composed here rather than by the client, because
 * which of the two offers is TRUE depends on the policy action: a build that can
 * install for itself offers to fetch, and one that cannot must point at the
 * release page, because a button that quietly did nothing would be this same
 * class of fault in a new place.
 *
 * @param {object} opts
 * @param {string} opts.action            from policy()
 * @param {string} [opts.version]         the release the check found
 * @param {string|null} [opts.suppressedVersion]  a version whose transfer already ended here
 * @param {string} [opts.trigger]         'manual', 'startup' or 'scheduled'
 * @returns {{fetch: boolean, quiet: boolean, offer: string|null}}
 */
export function fetchPlan({ action, version = null, suppressedVersion = null, trigger = 'scheduled' }) {
  const asked = trigger === 'manual';
  const suppressed = typeof version === 'string' && suppressedVersion === version;

  if (action === INSTALL) {
    // ★ A version whose transfer already ended here is not started AGAIN by
    // itself, and that is the whole of the suppression. It is not a refusal: a
    // person who presses Check is asking now, and their ask is the thing the card
    // answers, so the fetch happens and is loud. Only the background path is
    // held back, because only the background path is the one that cannot be
    // answered, as nobody asked the question.
    if (suppressed && !asked) return { fetch: false, quiet: true, offer: null };
    return { fetch: true, quiet: !asked, offer: null };
  }

  // A build that cannot fetch by itself has nothing to stay quiet about: the
  // card IS the answer, and it is the only way on.
  if (action === MANUAL) return { fetch: false, quiet: false, offer: OFFER_INSTALL };
  return { fetch: false, quiet: false, offer: OFFER_RELEASE };
}

/**
 * Message for the "a new version exists" dialog.
 *
 * Split from the dialog call so the wording is testable and so the two
 * platforms cannot drift into saying the same thing about different outcomes.
 *
 * The "why not" half is the caller's `reason` rather than a sentence written in
 * here. It used to say "because it is not code signed", which was true of the
 * only platform that could reach it at the time and became false the moment
 * Linux could reach it too, a dialog confidently naming the wrong cause.
 */
export function availableMessage({ action, version, current, reason = null }) {
  const headline = `${product} ${version} is available.`;
  const caveat = offeredCaveat(version, current);
  const from = `You are on ${current}.${caveat ? ` ${caveat}` : ''}`;
  if (action === INSTALL) {
    return { message: headline, detail: `${from} It will download in the background, and you can restart to apply it.` };
  }
  if (action === MANUAL) {
    return {
      message: headline,
      detail: `${from} Automatic updates are off, so nothing has been downloaded yet, `
        + 'install it now, or turn them back on in Settings.',
    };
  }
  const because = reason ? `, because ${reason}` : '';
  return {
    message: headline,
    // The caveat rides in the one place that composes an offer, so no client can
    // put a lower number on screen without it.
    detail: `${from} This build cannot update itself${because}, `
      + 'download the new version and replace the app to upgrade.',
  };
}

/**
 * How the number on an offer relates to the number on the running build.
 *
 * ★ This decides NOTHING about whether to update. It answers the reader's
 * question, which is "is the thing I am being offered above what I have?", and it
 * answers it from the version strings themselves so the two clients cannot say
 * different things about one offer.
 *
 *   'newer'      the offered number is above the running one
 *   'same-build' equal by semver precedence, so the same number
 *   'lower'      below it
 *   null         one of them is not a version this build parses
 *
 * ★ Why `compare` (semver precedence, tail and all) rather than `compareRelease`.
 * They answer different questions, and using the wrong one here is the fault this
 * function exists for. An update DECISION must never rank the tail, because its
 * basis changes and ranking it inverts the check (see compareRelease). What a
 * banner PRESENTS is the opposite case: the reader is shown the whole string, so
 * "is what I am offered newer than what I have" has to be answered about the
 * whole string. A dev build can be legitimately newer by publish order and still
 * carry a lower number, and a banner that offers `1.0.1-dev.38.a1b2c3d4e5` to a
 * build on `1.0.1-dev.42.b2c3d4e5f6` as though it were an upgrade is reporting a
 * state the app is not in.
 *
 * The non-answer is deliberate and is not a `newer`: an unparseable version is a
 * fault to surface where it happened rather than a caveat to invent here.
 *
 * @param {string} offered  the version a feed or an updater offered
 * @param {string} current  the version this build is running
 * @returns {'newer'|'same-build'|'lower'|null}
 */
export function offeredStanding(offered, current) {
  let result;
  try {
    result = compare(offered, current);
  } catch {
    return null;
  }
  if (result > 0) return 'newer';
  if (result < 0) return 'lower';
  return 'same-build';
}

/**
 * The sentence that keeps an offer honest, or an empty string for an upgrade.
 *
 * Empty rather than a reassurance on the ordinary path, so the wording a reader
 * sees when everything is normal is exactly what it was: a caveat on every offer
 * is a caveat nobody reads by the second one.
 *
 * This is the answer to the version-numbering inversion that is being looked at
 * separately. The numbering is not fixed here and must not be: what is fixed is
 * that a banner says which build it is offering and whether that build's number
 * is above the one running, instead of presenting a lower number as newer.
 *
 * @param {string} offered
 * @param {string} current
 * @returns {string} '' for an upgrade, a sentence otherwise
 */
export function offeredCaveat(offered, current) {
  switch (offeredStanding(offered, current)) {
    case 'lower':
      return 'It is numbered below the build you are running, so it is not an upgrade; it is the newest release by publish time.';
    case 'same-build':
      return 'It carries the same number as the build you are running, so it is the same version released again rather than a newer one.';
    default:
      return '';
  }
}

/**
 * The card shown while an update is arriving.
 *
 * Composed here rather than in the desktop because the two clients must not be
 * able to describe one transfer differently, and because the caveat above has to
 * ride on this card as well as on the offer that started it: a build whose number
 * is below the one running is no more an upgrade for being half downloaded.
 *
 * `transfer` is the client's own "how far, how fast" line, which core cannot
 * compose: this module is clock-free and cannot know a byte count from a chunk.
 * An absent one is a fact rather than a gap -- the library reports progress before
 * it has a total to divide by -- so it says what is true at that moment instead of
 * "0% of 0 MB".
 *
 * @param {object} opts
 * @param {string} opts.version
 * @param {string} opts.current
 * @param {string|null} [opts.transfer]  the client's own arrival line, or null
 */
export function downloadingMessage({ version, current, transfer = null }) {
  const caveat = offeredCaveat(version, current);
  const line = transfer || 'Starting the download.';
  return {
    message: `Downloading ${product} ${version}.`,
    detail: caveat ? `You are on ${current}. ${caveat} ${line}` : line,
  };
}

/**
 * The card shown when a download has produced nothing for the stall window.
 *
 * ★ The sentence that matters is the one that keeps the app honest about what it
 * is still doing. Nothing is cancelled when this state is reached, so a card that
 * said "the download failed" would be a second lie in the place the first one was:
 * what is true is that no data has arrived for a named time, that the transfer has
 * not been stopped, and that it may still finish on its own. The reader gets the
 * two things they can do about it (clear it, or go and get the release by hand)
 * rather than a bar that never moves.
 *
 * @param {object} opts
 * @param {string} opts.version
 * @param {string} opts.current
 * @param {number} [opts.stallMs]
 */
export function stalledMessage({ version, current, stallMs = STALL_MS }) {
  const seconds = Math.max(1, Math.round(stallMs / 1000));
  return {
    message: `Downloading ${product} ${version} has stopped making progress.`,
    detail: `Nothing has arrived for ${seconds} seconds. It has not been cancelled, so it may still finish on its own.`,
  };
}

/**
 * What a check owes the person who pressed the button, in both directions.
 *
 * This is the answer to the class of bug this app keeps producing: a control that
 * appears to work and reports nothing. A check that finds a release, and a check
 * that finds none, are both answers, and the person who pressed "Check for
 * updates" is owed one either way. Composing it here rather than in each client
 * is what stops the two drifting into saying different things about the same
 * outcome, and it is why the phone and the desktop answer identically.
 *
 * The shape returned is a notice, not a notice store: `{ tone, message, detail }`
 * and nothing else. Which id it is raised under, whether it is dismissible and
 * how long it lives are the client's, because those are facts about a surface
 * rather than about the answer, and because a notice CAN offer an action (the
 * desktop's "Download and install", the phone's "Open TestFlight") that this
 * layer must not name.
 *
 * `pointer` is the one thing a caller may add, and it exists because the honest
 * last sentence differs by platform: the phone cannot install anything, so it
 * says where the build is, while a desktop that cannot install for itself says
 * to go and replace the app. Naming a distribution channel in this file is
 * exactly what the iOS branch of capability() refuses to do, so the sentence
 * comes from the client that has one to name and the default stays channel-free.
 *
 * A NON-answer is possible and is part of the contract: a background check
 * returns null for every outcome except a release that exists. "Nothing newer",
 * "this build cannot ask" and "the check could not finish" are things a scheduled
 * check keeps to its log, because a dev build checks every five minutes and an
 * announcement per flaky network is the noise this shape exists to avoid. What is
 * never silent is an answer to something a person pressed.
 *
 * @param {object} opts
 * @param {string} opts.outcome     AVAILABLE, CURRENT, UNAVAILABLE or FAILED
 * @param {string} [opts.trigger]   'manual', 'startup' or 'scheduled'
 * @param {string} [opts.version]   the version a check found, for AVAILABLE
 * @param {string} opts.current     the running build's own version
 * @param {string} [opts.action]    from policy(), so the available sentence is true here
 * @param {string} [opts.reason]    from policy(): why this build cannot check, or cannot install
 * @param {string} [opts.error]     what a failed check said
 * @param {string} [opts.pointer]   the client's own sentence for where a new build is
 * @returns {{tone: string, message: string, detail: string}|null}
 */
export function checkAnswer({
  outcome,
  trigger = 'manual',
  version = null,
  current,
  action = null,
  reason = null,
  error = null,
  pointer = null,
}) {
  // An answer is owed only to someone who asked. Every outcome but one is gated
  // on that, and the exception is the point of the rule: a release that exists is
  // news whatever started the check, while "nothing newer", "this build cannot
  // ask" and "the check could not finish" are all things a background check must
  // keep to its log. A scheduled check that announced a flaky network every five
  // minutes would be the noise this whole shape exists to avoid, and a manual
  // press is owed an answer even when the answer is that it failed.
  if (outcome !== AVAILABLE && !shouldReportNoUpdate(trigger)) return null;

  if (outcome === AVAILABLE) {
    const { message, detail } = availableMessage({ action, version, current, reason });
    const caveat = offeredCaveat(version, current);
    return {
      tone: INFO,
      message,
      // The version is in the headline either way, which is the half that must
      // never be lost: "an update exists" without naming it is the report that
      // sent us here.
      //
      // `pointer` replaces the offer's own sentence with the client's ("Open
      // TestFlight", "install it from the release page"), because the shared
      // composition may not name a distribution channel. It does NOT replace the
      // caveat, which says what the offered number IS: a pointer says where to get
      // something, never whether it is above what you have, and the phone's own
      // pointer is a bare "Open TestFlight to update."
      detail: pointer ? `You are on ${current}.${caveat ? ` ${caveat}` : ''} ${pointer}` : detail,
    };
  }

  if (outcome === CURRENT) {
    return {
      tone: OK,
      message: `${product} is up to date.`,
      detail: `You are on ${current}.`,
    };
  }

  if (outcome === UNAVAILABLE) {
    return {
      tone: INFO,
      message: 'Updates are not available in this build.',
      detail: sentence(reason),
    };
  }

  return {
    tone: WARN,
    message: 'Could not check for updates.',
    detail: sentence(error),
  };
}

/** Whether a check should say anything when there is no update. */
export function shouldReportNoUpdate(trigger) {
  // A scheduled check that announces "you are up to date" is noise, and more so
  // on dev, where it would say it every five minutes. Someone who just clicked
  // "Check for updates" is owed an answer.
  return trigger === 'manual';
}

/**
 * The release channel a build belongs to, read from its own version.
 *
 * `1.0.1-dev.38.a1b2c3d4e5` is on `dev`; `1.0.1` is on stable, which returns
 * null. The version is the only honest source: it is stamped at build time and
 * travels with the installed app, so a build cannot be wrong about which
 * channel it came from.
 */
export function channelOf(version) {
  const m = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(String(version || '').trim());
  return m ? m[1] : null;
}

/**
 * Whether this build may consider prereleases, which is what keeps the two
 * channels apart, in both directions.
 *
 * A stable build leaves it false, so electron-updater asks GitHub for
 * `/releases/latest`, and GitHub excludes prereleases from that by definition.
 * Stable can therefore never be offered a dev build, without us filtering
 * anything.
 *
 * A dev build sets it true, which switches GitHubProvider to walking the
 * releases feed. There it compares each release's channel against its own
 * (taken from `semver.prerelease(currentVersion)[0]`, i.e. `dev`) and takes the
 * first match. A stable release has no prerelease component, so it matches
 * neither branch of that check and is skipped, a dev build is never offered
 * stable either.
 *
 * The pairing to keep in step: the build must also publish to the matching
 * channel, or the update metadata it looks for will not exist. scripts/build.js
 * passes `--config.publish.channel` for exactly that reason.
 */
export function allowPrerelease(version) {
  return channelOf(version) !== null;
}

/** How long a running app waits between scheduled checks. */
export const STABLE_INTERVAL_MS = spec.intervals.stableMs;
export const PRERELEASE_INTERVAL_MS = spec.intervals.prereleaseMs;

/**
 * ★ How long a download may produce NOTHING before the UI stops calling it
 * progress, in milliseconds.
 *
 * A named value in the spec rather than a number at the timer, because it is the
 * boundary between two states a reader is told apart by, and because the number is
 * the whole answer to "why did it give up so early" the next time it fires.
 *
 * 45 seconds, and the reasoning is about what "no progress" MEANS rather than
 * about patience. electron-updater emits `download-progress` per received chunk,
 * so a transfer that is working emits events continuously however slowly it is
 * moving, and one that is not moving emits none at all. The window is therefore
 * measured from the last evidence of movement, never from the start: a slow
 * download re-arms it on every chunk and so is never cut off, while a stalled one
 * goes quiet and crosses it. Both failure shapes leave the same signature -- no
 * events -- and the only thing that could tell a "slow" transfer from a "dead" one
 * without waiting is a rate threshold, which is exactly the check that kills a
 * working download on a bad link.
 *
 * 45 is chosen against the transport's own timeouts rather than against taste: it
 * is far longer than the socket and TCP retransmission behaviour underneath (a
 * connection that is truly gone surfaces as an error well inside this), and short
 * enough that nobody watches a bar that is not moving for a minute. Nothing is
 * cancelled when it fires, so a slow download that crosses it loses nothing but the
 * word "progress": the card changes state, the transfer carries on, and a late
 * event puts the card back.
 */
export const STALL_MS = spec.download.stallMs;

/**
 * How much of the stall window is left, given how long a transfer has been silent.
 *
 * The re-arm rule lives here so that "the window is measured from the last
 * movement, not from the start" is a thing that is checked rather than a comment
 * beside a timer. A quiet period longer than the window reports the window
 * already spent, which is what a stray or late timer must see.
 *
 * @param {number} quietForMs  how long the transfer has produced nothing
 * @param {number} [stallMs]
 */
export function stallRemaining(quietForMs, stallMs = STALL_MS) {
  const quiet = Number.isFinite(quietForMs) && quietForMs > 0 ? quietForMs : 0;
  return Math.max(0, stallMs - quiet);
}

/**
 * How often this build should look for a new release.
 *
 * Stable waits six hours: it is meant to sit in the tray for weeks, and
 * noticing a release an hour late costs nothing.
 *
 * A prerelease channel waits five minutes, because the two channels exist for
 * opposite reasons. A dev build is installed to watch a change land, so the
 * interval is the delay between pushing a fix and seeing it, six hours makes
 * the channel useless for the one job it has.
 *
 * Affordable because of where the check goes. On a prerelease channel
 * GitHubProvider reads `github.com/<owner>/<repo>/releases.atom` and then the
 * channel's own `.yml` from the release's download path, both plain github.com
 * URLs, so the 60-per-hour unauthenticated api.github.com rate limit never
 * applies. Twelve checks an hour is two small conditional GETs each, against a
 * CDN built for release traffic.
 *
 * Derived from the version rather than configured, for the same reason
 * channelOf() is: the version is stamped at build time and travels with the
 * installed app, so a build cannot be wrong about which channel it is on. A
 * setting could disagree with the build it is running in.
 */
export function checkIntervalMs(version) {
  return channelOf(version) === null ? STABLE_INTERVAL_MS : PRERELEASE_INTERVAL_MS;
}

/**
 * Roughly how long ago, in words.
 *
 * Deliberately coarse. The question this answers is "is it checking at all",
 * and a precise timestamp invites the reader to work out the interval instead
 * of reading the answer.
 */
export function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
