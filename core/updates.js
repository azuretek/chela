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
  const headline = `Claw Control UI ${version} is available.`;
  if (action === INSTALL) {
    return { message: headline, detail: `You are on ${current}. It will download in the background, and you can restart to apply it.` };
  }
  if (action === MANUAL) {
    return {
      message: headline,
      detail: `You are on ${current}. Automatic updates are off, so nothing has been downloaded yet, `
        + 'install it now, or turn them back on in Settings.',
    };
  }
  const because = reason ? `, because ${reason}` : '';
  return {
    message: headline,
    detail: `You are on ${current}. This build cannot update itself${because}, `
      + 'download the new version and replace the app to upgrade.',
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
