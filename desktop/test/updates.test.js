// Plain `node --test`, no Electron. src/updates.js takes `platform` and
// `packaged` as arguments for exactly this reason, so every platform's policy
// is exercised from one run on one machine.
//
// What matters here is that the app never *claims* it can update itself where
// it cannot. An unsigned macOS build that downloads 130MB and then fails inside
// Squirrel.Mac is worse than one that says plainly it cannot.
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import updates from '../src/updates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// appImage is pinned rather than left to default, so a stray APPIMAGE in the
// environment, or a test run from inside one, cannot change what these assert.
const packaged = (platform, macSigned) => updates.policy({ platform, packaged: true, macSigned, appImage: false });

/* ------------------------------------------------------------------ Windows */

test('Windows installs updates, signed or not', () => {
  // NsisUpdater.verifySignature() returns null when the build has no
  // publisherName, so verification is skipped and the update proceeds.
  const p = packaged('win32');
  assert.equal(p.action, updates.INSTALL);
  assert.equal(p.check, true);
  assert.equal(p.autoDownload, true);
});

/* -------------------------------------------------------------------- macOS */

test('unsigned macOS notifies instead of pretending it can install', () => {
  const p = packaged('darwin', false);
  assert.equal(p.action, updates.NOTIFY);
  assert.equal(p.check, true, 'still worth telling someone a release exists');
  assert.match(p.reason, /Squirrel\.Mac/);
});

test('unsigned macOS does not download what it cannot install', () => {
  // ~130MB to arrive at the same dialog.
  assert.equal(packaged('darwin', false).autoDownload, false);
});

test('signed macOS gets the same treatment as Windows', () => {
  // The one line that changes when a Developer ID exists.
  const p = packaged('darwin', true);
  assert.equal(p.action, updates.INSTALL);
  assert.equal(p.autoDownload, true);
});

test('macOS ships signed, and the flag says so', () => {
  // The constant is compiled in, so it has to track what the release workflow
  // actually produces. These two move together in both directions: a true flag
  // on an unsigned build fails inside Squirrel with no explanation, and a false
  // one on a signed build gives up an install it could have done.
  assert.equal(updates.MAC_SIGNED, true);
  assert.equal(updates.policy({ platform: 'darwin', packaged: true }).action, updates.INSTALL);
});

/* -------------------------------------------------------------------- Linux */

const linux = (appImage) => updates.policy({ platform: 'linux', packaged: true, appImage });

test('an AppImage installs updates, like Windows', () => {
  // AppImageUpdater overwrites the file the process was started from. No
  // signature, no package manager, no root, the one Linux path that installs
  // without a privilege prompt.
  const p = linux(true);
  assert.equal(p.action, updates.INSTALL);
  assert.equal(p.check, true);
  assert.equal(p.autoDownload, true);
});

test('Linux outside an AppImage does not check at all', () => {
  // The distinction that matters: not "cannot install" but "cannot answer".
  // AppImageUpdater.isUpdaterActive() is false without APPIMAGE, so
  // checkForUpdates() resolves to null having emitted no event, neither
  // 'error' nor 'update-not-available'. Left checking, a manual check would
  // hang silently and About would say "no check yet this run" forever.
  const p = linux(false);
  assert.equal(p.check, false, 'a check that can only answer nothing must not be made');
  assert.equal(p.autoDownload, false);
  assert.match(p.reason, /AppImage/);
});

test('Linux update behaviour is a runtime fact, not a build-time one', () => {
  // Unlike MAC_SIGNED, which is compiled in because it only changes when the
  // pipeline does, this changes per launch: the same binary auto-updates when
  // run as an AppImage and cannot when unpacked next to it.
  assert.notEqual(linux(true).action, linux(false).action);
});

/* ------------------------------------------------------------- source runs */

test('a source run does not check at all', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const p = updates.policy({ platform, packaged: false });
    assert.equal(p.action, updates.NONE, `for ${platform}`);
    assert.equal(p.check, false);
  }
});

test('not-packaged beats every platform rule', () => {
  // electron-updater guards this itself, but by logging an error that reads
  // like a fault on every `npm start`.
  assert.equal(updates.policy({ platform: 'win32', packaged: false }).action, updates.NONE);
  assert.equal(updates.policy({ platform: 'darwin', packaged: false, macSigned: true }).action, updates.NONE);
});

test('every policy explains itself', () => {
  // The reason is logged at startup and shown in the "no updates here" dialog,
  // so an empty one turns a clear answer into a shrug.
  for (const packagedState of [true, false]) {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const p = updates.policy({ platform, packaged: packagedState });
      assert.ok(p.reason && p.reason.length > 10, `${platform}/${packagedState}: "${p.reason}"`);
    }
  }
});

/* ----------------------------------------------------------------- messages */

test('the install message offers a restart', () => {
  const m = updates.availableMessage({ action: updates.INSTALL, version: '1.1.0', current: '1.0.0' });
  assert.match(m.message, /1\.1\.0 is available/);
  assert.match(m.detail, /restart/i);
  assert.match(m.detail, /1\.0\.0/, 'says which version you are on');
});

test('the notify message says why it cannot update itself', () => {
  // Otherwise "a new version is available" with no install button reads as a
  // broken updater rather than a deliberate limit.
  const m = updates.availableMessage({
    action: updates.NOTIFY, version: '1.1.0', current: '1.0.0', reason: 'it is not code signed',
  });
  assert.match(m.detail, /because it is not code signed/);
  assert.doesNotMatch(m.detail, /restart/i);
});

test('the notify message takes its reason from the policy, not from a hardcoded one', () => {
  // It used to say "because it is not code signed" unconditionally, which was
  // true of the only platform that could reach it then. Linux can reach it now
  // for an entirely different reason, and a dialog naming the wrong cause is
  // worse than one naming none.
  const p = updates.policy({ platform: 'linux', packaged: true, appImage: false });
  const m = updates.availableMessage({ action: p.action, version: '1.1.0', current: '1.0.0', reason: p.reason });
  assert.match(m.detail, /AppImage/);
  assert.doesNotMatch(m.detail, /code signed/);
});

/* ------------------------------------------- the automatic-updates preference */

// The preference may only ever *narrow* what the platform allows. The failure
// worth guarding against is the other direction: a toggle that appears to
// enable something the build could never do, or one that quietly stops the app
// noticing releases at all.

const withPref = (platform, autoUpdate) => updates.policy({
  platform, packaged: true, macSigned: true, appImage: true, autoUpdate,
});

test('turning automatic updates off stops the download, not the check', () => {
  const p = withPref('win32', false);
  assert.equal(p.autoDownload, false, 'nothing arrives unasked');
  assert.equal(p.check, true, 'but the app still notices a release exists');
  assert.equal(p.action, updates.MANUAL);
});

test('off is MANUAL rather than NOTIFY, because this build really can install it', () => {
  // NOTIFY's wording sends people to the release page to replace the app by
  // hand. Saying that to someone whose app is one button away from doing it
  // itself is worse than saying nothing.
  const m = updates.availableMessage({
    action: withPref('win32', false).action, version: '1.2.0', current: '1.1.0',
  });
  assert.match(m.detail, /install it now/i);
  assert.doesNotMatch(m.detail, /replace the app/);
});

test('the preference cannot switch on a platform that could never install', () => {
  for (const p of [
    updates.policy({ platform: 'darwin', packaged: true, macSigned: false, autoUpdate: true }),
    updates.policy({ platform: 'linux', packaged: true, appImage: false, autoUpdate: true }),
    updates.policy({ platform: 'win32', packaged: false, autoUpdate: true }),
  ]) {
    assert.equal(p.canInstall, false);
    assert.equal(p.autoDownload, false);
    assert.notEqual(p.action, updates.INSTALL);
  }
});

test('canInstall reports the platform, not the preference', () => {
  // Settings disables the checkbox on canInstall and explains itself with
  // capabilityReason, so both have to keep describing the build even once the
  // preference has changed the action out from under them.
  const off = withPref('win32', false);
  assert.equal(off.canInstall, true, 'the build can install; the user asked it not to');
  assert.match(off.capabilityReason, /NSIS/);
  assert.match(off.reason, /turned off/, 'reason describes the current action');
});

test('leaving the preference unset behaves exactly as before', () => {
  // Every other caller and test omits it, so the default is load-bearing.
  const implicit = updates.policy({ platform: 'win32', packaged: true });
  assert.equal(implicit.action, updates.INSTALL);
  assert.equal(implicit.autoDownload, true);
  assert.equal(withPref('win32', true).action, updates.INSTALL);
});

test('capability() answers about the platform alone', () => {
  const cap = updates.capability({ platform: 'win32', packaged: true });
  assert.equal(cap.action, updates.INSTALL);
  assert.equal(cap.autoDownload, true);
  assert.equal(cap.canInstall, undefined, 'that field is policy()’s answer, not this one’s');
});

test('About says updates wait for you when the preference is off', () => {
  const p = withPref('win32', false);
  const line = updates.statusLine({ action: p.action, reason: p.reason, channel: 'dev' });
  assert.match(line, /installed when you ask/);
  assert.doesNotMatch(line, /automatically/);
});

/* ------------------------------------------------------------------ quietness */

test('only a manual check reports that there is nothing to do', () => {
  assert.equal(updates.shouldReportNoUpdate('manual'), true);
  // A scheduled check announcing "up to date" every six hours is noise.
  assert.equal(updates.shouldReportNoUpdate('scheduled'), false);
  assert.equal(updates.shouldReportNoUpdate('startup'), false);
});

/* ------------------------------------------------------- what About reports */

// Updating succeeds silently, and the only trace it ever ran is a file in a
// cache directory nobody opens. These assertions are about the app being able
// to answer "is it actually checking?" without anyone going looking.

test('the status line names the channel, the behaviour and the last check', () => {
  const line = updates.statusLine({
    action: updates.INSTALL,
    reason: 'NSIS updates do not require a signed build',
    channel: 'dev',
    checkedAt: 1000,
    result: 'up to date',
    now: 1000 + 5 * 60 * 1000,
  });
  assert.match(line, /dev channel/);
  assert.match(line, /installed automatically/);
  assert.match(line, /last checked 5 minutes ago, up to date/);
});

test('a build with no prerelease component says stable', () => {
  const line = updates.statusLine({ action: updates.INSTALL, reason: 'r', channel: null, checkedAt: 0, now: 0 });
  assert.match(line, /stable channel/);
});

test('before the first check it says so rather than implying one happened', () => {
  const line = updates.statusLine({ action: updates.INSTALL, reason: 'r', channel: 'dev' });
  assert.match(line, /no check yet this run/);
  assert.doesNotMatch(line, /last checked/);
});

test('a build that cannot update says why instead of pretending to check', () => {
  const p = updates.policy({ platform: 'darwin', packaged: false });
  const line = updates.statusLine({ action: p.action, reason: p.reason });
  assert.match(line, /not checked/);
  assert.match(line, /running from source/);
});

test('a notify-only build does not claim it installs anything', () => {
  const line = updates.statusLine({ action: updates.NOTIFY, reason: 'unsigned', channel: null, checkedAt: 0, now: 0 });
  assert.doesNotMatch(line, /installed automatically/);
  assert.match(line, /by hand/);
});

test('elapsed time reads in the largest unit that still means something', () => {
  assert.equal(updates.ago(30 * 1000), 'just now');
  assert.equal(updates.ago(60 * 1000), '1 minute ago');
  assert.equal(updates.ago(90 * 60 * 1000), '1 hour ago');
  assert.equal(updates.ago(50 * 60 * 60 * 1000), '2 days ago');
  // A clock that moved backwards must not produce "-3 minutes ago".
  assert.equal(updates.ago(-1), null);
});

/* --------------------------------------------------- how often it looks */

test('dev checks every five minutes, stable every six hours', () => {
  assert.equal(updates.checkIntervalMs('1.0.1-dev.51.e8de8f92c2'), 5 * 60 * 1000);
  assert.equal(updates.checkIntervalMs('1.0.1'), 6 * 60 * 60 * 1000);
});

test('the interval follows the same channel rule as allowPrerelease', () => {
  // One version cannot be on the dev channel for picking releases and on the
  // stable channel for deciding how often to look. Both read channelOf().
  for (const v of ['1.0.1', '2.3.4', '1.0.1-dev.51.abc', '1.0.1-beta.2', '9.9.9-rc.1']) {
    const fast = updates.checkIntervalMs(v) === updates.PRERELEASE_INTERVAL_MS;
    assert.equal(fast, updates.allowPrerelease(v), `disagreed about ${v}`);
  }
});

test('a version that cannot be parsed falls back to the slow interval', () => {
  // Defensive rather than expected: an unreadable version must not become a
  // reason to poll GitHub twelve times an hour.
  for (const v of [undefined, null, '', 'not-a-version']) {
    assert.equal(updates.checkIntervalMs(v), updates.STABLE_INTERVAL_MS);
  }
});

/* ------------------------------------------------- the download, in words */

test('progress is a fraction, and an unreadable one is not a number', () => {
  assert.equal(updates.downloadProgress({ percent: 0 }), 0);
  // Divided, so the exact float is not the point: the fraction is.
  assert.ok(Math.abs(updates.downloadProgress({ percent: 41.6666 }) - 0.416666) < 1e-9);
  assert.equal(updates.downloadProgress({ percent: 100 }), 1);
  // electron-updater sends nothing useful before the first byte, and a bar
  // drawn from NaN is a bar that disappears rather than one that starts empty.
  for (const info of [{}, { percent: NaN }, { percent: Infinity }, undefined, null]) {
    assert.equal(updates.downloadProgress(info), null, `should not be a number: ${JSON.stringify(info)}`);
  }
  assert.equal(updates.downloadProgress({ percent: 250 }), 1, 'clamped');
});

test('the transfer line says what arrived and how fast, and drops what it cannot know', () => {
  assert.equal(
    updates.transferDetail({
      transferred: 58 * 1024 * 1024,
      total: 130 * 1024 * 1024,
      bytesPerSecond: 4.2 * 1024 * 1024,
    }),
    '58 MB of 130 MB, 4.2 MB/s',
  );
  // No total yet. "58 MB of 0 MB" would be a sentence that contradicts itself.
  assert.equal(updates.transferDetail({ transferred: 58 * 1024 * 1024 }), '58 MB');
  // Nothing known at all: null, so the caller can say something true instead of
  // filling the line with zeroes.
  assert.equal(updates.transferDetail({}), null);
  assert.equal(updates.transferDetail(), null);
  assert.equal(updates.transferDetail(undefined), null);
  assert.equal(updates.transferDetail(null), null);
  // The two ends of the scale stay readable rather than becoming "0 MB".
  assert.equal(updates.transferDetail({ transferred: 512 * 1024, total: 1024 * 1024 }), '0.5 MB of 1.0 MB');
  assert.equal(
    updates.transferDetail({ transferred: 2.5 * 1024 ** 3, total: 3 * 1024 ** 3 }),
    '2.50 GB of 3.00 GB',
  );
});

/* ------------------------------------------ what a press on the button means */

/*
 * The wiring half of "a control that appears to work and reports nothing".
 *
 * `core/test/updates.test.js` proves what the shared composition says in each
 * direction. What it cannot see is whether main.js ever asks it: the answer is
 * composed in core and raised here, so a handler that still composes its own
 * sentence, or that answers one direction and returns early on the other, would
 * pass every test in core and leave the button silent. These read the file the
 * way test/notices.test.js reads it, because main.js needs Electron and the
 * alternative is not testing the wiring at all.
 */
test('both directions of a manual check are answered through the shared composition', () => {
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');

  // The event the updater emits when there is nothing newer must reach an
  // answer. This is the direction the report was about: pressing the button on a
  // build that is current said nothing at all.
  const notAvailable = /updater\.on\('update-not-available',[\s\S]*?\n  \}\);/.exec(main);
  assert.ok(notAvailable, 'the update-not-available handler was not found');
  assert.match(notAvailable[0], /updates\.checkAnswer\(/, 'the up-to-date case must go through the shared answer');
  assert.match(notAvailable[0], /outcome: updates\.CURRENT/, 'and it must answer as CURRENT');
  assert.match(notAvailable[0], /pendingManualCheck/, 'and it must still be gated on a check someone asked for');

  // The available direction, which the banner draws either as a download or as
  // an offer, and which must name the version. It goes through the same
  // composition so the two clients cannot word one case differently.
  // The structure below this moved when the fetch decision became shared
  // (updates.fetchPlan): the INSTALL branch now either starts a quiet or a loud
  // fetch, and it is the OFFER path that composes the sentence. The rule being
  // asserted is unchanged, which is that an available release is worded by the
  // shared composition and names the version.
  const available = /const \{ message, detail \} = updates\.checkAnswer\(\{[\s\S]*?outcome: updates\.AVAILABLE,[\s\S]*?version: info\.version,/.exec(main);
  assert.ok(available, 'the update-available wording must come from the shared answer');
});

test('a build with no updater answers the press rather than swallowing it', () => {
  // A source run, and a Linux build that is not an AppImage, both reach
  // checkForUpdates with no updater. That used to be a sentence written in
  // main.js and is now the shared UNAVAILABLE answer, which is why this asserts
  // the call rather than the words.
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  const guard = /if \(!updater\) \{[\s\S]*?return;\n  \}/.exec(main);
  assert.ok(guard, 'the no-updater branch of checkForUpdates was not found');
  assert.match(guard[0], /outcome: updates\.UNAVAILABLE/, 'and it answers as UNAVAILABLE');
  assert.doesNotMatch(guard[0], /shouldReportNoUpdate/, 'the silence for a background check belongs in the shared answer');
});

/* ------------------------------------------------------ the release-only rule */

// The reported bug, from this client's side. electron-updater decides "is there
// a newer build" with `semver.gt(latest, current)` inside its own
// `isUpdateAvailable`, and that ranks the build and commit tail: the part of our
// version after the release, whose BASIS changed, so a newly published build can
// carry a LOWER number than the installed one. Ranked, that inversion reads as
// "the installed build is ahead", and builds stop arriving.

test('★ the desktop reaches the rule from the one owner, not a second comparison', () => {
  // The same function the feed path uses on the phone (newerVersion), which is
  // what makes the two clients agree rather than each holding a comparison.
  assert.equal(typeof updates.isNewerBuild, 'function', 'the desktop can ask the shared rule');
  assert.equal(updates.isNewerBuild('1.0.1-dev.12.1758000000', '1.0.1-dev.195.6387043585'), true,
    'a published build with a LOWER tail number than the installed one is still newer');
  assert.equal(updates.isNewerBuild('1.0.0-dev.900.1700000000', '1.0.1-dev.195.6387043585'), false,
    'an older release is not newer');
  assert.equal(updates.isNewerBuild('1.0.1-dev.12.1758000000', '1.0.1-dev.12.1758000000'), false,
    'the build we are running is not offered back to us');

  assert.equal(typeof updates.newerVersion, 'function', 'the desktop reaches the feed reader too');
  const document = { entries: [{ id: '.../releases/v1.0.1-dev.12.1758000000' }] };
  assert.equal(updates.newerVersion(document, '1.0.1-dev.195.6387043585'), '1.0.1-dev.12.1758000000');
});

test('★ main.js re-decides the version electron-updater refused, before reporting up to date', () => {
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  const handler = /updater\.on\('update-not-available',[\s\S]*?\n  \}\);/.exec(main);
  assert.ok(handler, 'the update-not-available handler was not found');

  assert.match(handler[0], /updates\.isNewerBuild\(/, 'its candidate is re-decided by the shared rule');
  assert.ok(handler[0].indexOf('updates.isNewerBuild(') < handler[0].indexOf("setLastCheck('up to date')"),
    'and the decision is made BEFORE anything is reported as up to date');

  assert.match(main, /function offerRefusedByUpdater\(/, 'a refused-but-newer build is offered, not dropped');
  assert.match(handler[0], /offerRefusedByUpdater\(offered\)/, 'and the handler offers it');
  // The offer points at the release, because this build cannot hand a version
  // the updater declined back to its downloader.
  const offer = /function offerRefusedByUpdater\([\s\S]*?\n\}/.exec(main);
  assert.ok(offer, 'the offer was not found');
  assert.match(offer[0], /'update-release-page'/, 'and it opens the release page');
  assert.match(offer[0], /outcome: updates\.AVAILABLE/, 'its wording comes from the shared answer');
});

test('the About page still shows the full version, tail and all', () => {
  // What changed is what is COMPARED, never what is shown: the build and commit
  // tail is the useful part of the number when reporting a problem.
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /version: app\.getVersion\(\),/, 'About reports the version of the build it is running');
  assert.doesNotMatch(main, /version: updates\.release\(/, 'the release-only form is never what is displayed');
});

/* ---------------------------------------------- the download that sat at 0% */

/*
 * Abi, 2026-09-17: "Downloading Claw Control UI <version>. Starting the download."
 * with the bar at 0% and no way to clear it.
 *
 * Three things had to be true for that card to be unkillable, and each one is
 * asserted here because each one on its own would have been recoverable:
 *
 *   it refused the X             so the card had no control of its own
 *   "Mark all read" skipped it   so the bulk control could not take it either
 *   a failure never settled it   so nothing else could, and the card outlived the
 *                                download it described
 *
 * The behavioural proof is scripts/test-update-stall.js, which drives the real app
 * against a feed that never answers and measures the frames it passes through.
 * These read the file, the way the rest of this section does: main.js needs
 * Electron, and the alternative is not testing the wiring at all.
 */

test('★ the download card can be dismissed, and its dismissal means stop', () => {
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  const card = /function downloadingNotice\(version, info\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(card, 'the download card was not found');
  assert.match(card[0], /dismissible: true/, 'the card that could not be dismissed must offer its X');
  assert.match(card[0], /dismissClears: true/, 'and that X must mean stop rather than "I have seen this"');
  // The wording, and the honesty about what is being offered, come from shared core
  // rather than from a sentence written here.
  assert.match(card[0], /updates\.downloadingMessage\(/);

  // The IPC handler is where a surface's dismissal lands, so it is where the
  // meaning has to be honoured: the store decides, and the transfer is given up
  // BEFORE the store is touched so the library's own reaction lands on an attempt
  // the app has already stopped reporting on.
  const dismiss = /ipcMain\.handle\('app:dismiss-notice'[\s\S]*?\n  \}\);/.exec(main);
  assert.ok(dismiss, 'the dismiss handler was not found');
  assert.match(dismiss[0], /notices\.dismiss\(/, 'the store owns what a dismissal means');
  assert.match(dismiss[0], /abandonUpdateDownload\(\)/, 'and a cleared transfer is given up');
  assert.ok(dismiss[0].indexOf('abandonUpdateDownload()') < dismiss[0].indexOf('notices.dismiss('),
    'giving up the transfer happens before the store, so a cancel cannot resurrect the card');
});

test('★ a cleared attempt does not come straight back', () => {
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');

  // One gate for every raise of the update card. A raise that skipped it would put
  // the abandoned card back on the next chunk of a transfer the reader already
  // asked to stop hearing about, which is the "must not reappear" half of the bug.
  const gate = /function showUpdateNotice\(notice\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(gate, 'the raise gate was not found');
  assert.match(gate[0], /downloadAttempt === clearedAttempt/, 'the gate compares the attempt');

  // Every phase of the download goes through it: the start, each whole percent, and
  // the stalled state. Progress is the one that would otherwise fight the reader.
  const progress = /function onDownloadProgress\(info\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(progress, 'the progress handler was not found');
  assert.match(progress[0], /showUpdateNotice\(downloadingNotice/, 'progress raises through the gate');
  assert.match(progress[0], /if \(downloadAttempt === clearedAttempt\) return;/,
    'and returns before doing any work for an abandoned attempt');

  // A new attempt is a new generation, which is how a later offer is still able to
  // appear: "not this attempt, again, now" rather than a version hidden forever.
  const begin = /function beginUpdateDownload\(version, \{ quiet = false \} = \{\}\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(begin, 'beginUpdateDownload was not found');
  assert.match(begin[0], /downloadAttempt \+= 1/, 'each attempt is its own generation');
});

test('★ a download that says nothing reaches a clear, honest state on a named window', () => {
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');

  // The window is a named value from the shared spec, never a number at the timer.
  assert.equal(typeof updates.STALL_MS, 'number', 'the desktop can read the named window');
  assert.equal(typeof updates.stallRemaining, 'function', 'and the re-arm rule');

  const arm = /function armStallWatch\(\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(arm, 'the stall watchdog was not found');
  assert.match(arm[0], /updates\.stallRemaining\(Date\.now\(\) - downloadMovedAt\)/,
    'what it arms for is the window measured from the last movement, not from the start');
  assert.match(arm[0], /onDownloadStall/, 'and it moves the card to the stalled state');

  const stall = /function onDownloadStall\(\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(stall, 'the stall handler was not found');
  assert.match(stall[0], /stalledNotice\(/, 'it raises the stalled card');

  // The card it raises has a way out and something to press, and it says what is
  // known rather than claiming the download failed.
  const card = /function stalledNotice\(version\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(card, 'the stalled card was not found');
  assert.match(card[0], /updates\.stalledMessage\(/, 'its wording comes from shared core');
  assert.match(card[0], /dismissible: true/, 'it can be cleared');
  assert.match(card[0], /dismissClears: true/, 'and clearing it means stop');
  assert.match(card[0], /'update-release-page'/, 'and it offers the one honest action');
  assert.equal(updates.stalledMessage({ version: '1.0.2', current: '1.0.1' }).detail.includes('cancelled'), true,
    'and it says plainly that nothing was cancelled');
});

test('★ a slow but working download is never called stalled', () => {
  // The distinction is MOVEMENT, and the order of two statements is what delivers
  // it: every progress event records movement and re-arms the window before the
  // whole-percent throttle can return early. Counting only the throttled raises
  // would call a slow transfer dead, which is the check that cuts a working
  // download off.
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  const progress = /function onDownloadProgress\(info\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(progress, 'the progress handler was not found');
  const recorded = progress[0].indexOf('downloadMovedAt = Date.now();');
  const reArmed = progress[0].indexOf('armStallWatch();');
  const throttled = progress[0].indexOf('if (percent === lastProgressPercent) return;');
  assert.ok(recorded !== -1 && reArmed !== -1 && throttled !== -1, 'the progress handler lost a step');
  assert.ok(recorded < throttled, 'movement is recorded before the whole-percent throttle');
  assert.ok(reArmed < throttled, 'and the window is re-armed there too');

  // No rate threshold anywhere: a bytes-per-second cutoff is what would kill a
  // working download on a bad link, and there is deliberately none.
  assert.doesNotMatch(progress[0], /bytesPerSecond\s*[<>]/, 'the stall rule is not a rate threshold');
});

test('★ a download that fails settles the card it raised, whatever started it', () => {
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  const handler = /updater\.on\('error', \(err\) => \{[\s\S]*?\n  \}\);/.exec(main);
  assert.ok(handler, 'the updater error handler was not found');

  assert.match(handler[0], /settleFailedDownload\(err\)/, 'a failure settles the download card');
  // BEFORE the manual-check gate. That gate is about a CHECK nobody asked about,
  // which says nothing because no card was ever raised; a download that dies has a
  // card on the bar already, and leaving it there is the app going quiet mid
  // sentence rather than being tactfully silent.
  assert.ok(handler[0].indexOf('settleFailedDownload(err)') < handler[0].indexOf('if (!pendingManualCheck) return;'),
    'the card is settled before the silence for a background check');
  assert.match(handler[0], /pendingManualCheck/, 'and the background-silence rule itself is unchanged');

  // Settling only ever acts on a card that was raised, and never on an attempt the
  // reader cleared: a cancel is not a failure.
  const settle = /function settleFailedDownload\(err\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(settle, 'settleFailedDownload was not found');
  assert.match(settle[0], /if \(!downloadCardRaised\) return;/, 'nothing is reported that nobody was told about');
  assert.match(settle[0], /downloadAttempt === clearedAttempt/, 'and an abandoned attempt stays abandoned');
  assert.match(settle[0], /tone: noticeStore\.WARN/, 'what replaces the progress card is a warning, not a bar at 0%');
});

test('★ clearing the card gives up the transfer where the library allows it, and says which', () => {
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  // The handle is the CancellationToken the check returns, which is the token the
  // download it starts on its own was given. Kept rather than discarded, because
  // holding it is the difference between clearing a card and stopping a download.
  assert.match(main, /if \(result && result\.cancellationToken\) downloadCancelToken = result\.cancellationToken;/,
    'the cancel handle a check hands back is kept');
  const abandon = /function abandonUpdateDownload\(\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(abandon, 'abandonUpdateDownload was not found');
  assert.match(abandon[0], /token\.cancel\(\)/, 'and used');
  assert.match(abandon[0], /clearedAttempt = downloadAttempt;/, 'the UI half never depends on the token existing');
  assert.ok(abandon[0].indexOf('clearedAttempt = downloadAttempt;') < abandon[0].indexOf('token.cancel()'),
    'the attempt is marked cleared BEFORE the cancel, because a cancel emits straight back into these handlers');
  // A cancelled download is not a failure, and the library agrees: it emits
  // update-cancelled rather than error for a CancellationError.
  assert.match(main, /updater\.on\('update-cancelled'/, 'the library has an event for it, and it is handled');
});

/*
 * ---------------------------------------------------------------------------
 * The card that came back after a relaunch.
 *
 * Abi, 2026-09-17: the 0% card was "just hung here on my mac even after a
 * restart". A clear that lived only in memory could not survive that, because the
 * card is raised by a check that runs on EVERY launch, and nothing about the
 * attempt was ever written down. So the rules below are all about what survives a
 * quit: the record on disk, who may start a fetch, and what a reader is told.
 * ---------------------------------------------------------------------------
 */

test('About says when a version is not being fetched on its own, and why', () => {
  const cleared = updates.statusLine({
    action: updates.INSTALL,
    reason: 'signed with a Developer ID',
    suppressed: { version: '1.0.2', reason: 'cleared' },
  });
  assert.match(cleared, /not fetching 1\.0\.2 on its own \(you cleared it\)/,
    'a reader who ended a transfer has to be able to find that out');
  // "nothing arrived" and "you cleared it" are different things to be told, so the
  // two reasons are not collapsed into one sentence.
  const stalled = updates.statusLine({
    action: updates.INSTALL,
    reason: 'signed with a Developer ID',
    suppressed: { version: '1.0.2', reason: 'stalled' },
  });
  assert.match(stalled, /it produced nothing/);
  // And the ordinary line is unchanged, because a caveat on every launch is one
  // nobody reads.
  const plain = updates.statusLine({ action: updates.INSTALL, reason: 'signed with a Developer ID' });
  assert.ok(!/not fetching/.test(plain), 'no suppression, no sentence about one');
});

test('the desktop re-exports the fetch decision rather than writing its own', () => {
  // One owner: a second copy here is how the two clients start disagreeing about
  // what a check is allowed to start.
  assert.deepEqual(updates.fetchPlan({ action: updates.INSTALL, version: '1.0.2', trigger: 'startup' }),
    { fetch: true, quiet: true, offer: null });
  assert.deepEqual(updates.fetchPlan({ action: updates.INSTALL, version: '1.0.2', suppressedVersion: '1.0.2', trigger: 'startup' }),
    { fetch: false, quiet: true, offer: null });
});

test('★ a cleared transfer is recorded on disk, because memory does not survive a relaunch', () => {
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  // The write: the record the next launch reads.
  assert.match(main, /config\.update\(\{ updateSuppression: \{ version, reason, at: Date\.now\(\) \} \}\)/,
    'the suppression is written to the config file rather than held in a variable');
  assert.match(main, /function suppressedUpdate\(\)/, 'and read back from it');
  // The clear: the reported symptom is that dismissing the card did nothing for
  // the next launch, so the reader's own action has to be the thing recorded.
  const abandon = /function abandonUpdateDownload\(\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(abandon, 'abandonUpdateDownload was not found');
  assert.match(abandon[0], /suppressUpdate\(version, 'cleared'\)/, 'clearing the card records why it was cleared');
  // The read, on the path that raises it: the offer consults the shared decision,
  // and a background fetch is silent.
  assert.match(main, /updates\.fetchPlan\(\{/, 'the fetch decision comes from the shared core');
  assert.match(main, /beginUpdateDownload\(info\.version, \{ quiet: fetch\.quiet \}\)/,
    'and a quiet fetch is started without a card');
  // The record has to be dropped when it stops being true, or a version nobody can
  // fetch is suppressed forever.
  assert.match(main, /clearUpdateSuppression\(/, 'and the record is cleared somewhere');
});

test('★ a background fetch draws no card until it has evidence', () => {
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  const begin = /function beginUpdateDownload\(version, \{ quiet = false \} = \{\}\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(begin, 'beginUpdateDownload was not found');
  // The quiet path must not raise the notice, and must still arm the watchdog: a
  // transfer that never moves still has to be given up on.
  assert.match(begin[0], /if \(quiet\) downloadCardRaised = false;/, 'a quiet attempt raises nothing');
  assert.match(begin[0], /armStallWatch\(\)/, 'and is still bounded by the stall window');
  // The stall path records a quiet attempt rather than announcing it, because
  // nothing was ever shown to the reader.
  const stall = /function onDownloadStall\(\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(stall, 'onDownloadStall was not found');
  assert.match(stall[0], /suppressUpdate\(downloadVersion, 'stalled'\)/,
    'a background transfer that produced nothing is recorded, not announced');
});

test('★ a download that completes is reported even for an attempt the reader cleared', () => {
  // Deliberate, and worth pinning so it does not read as an oversight later. What
  // the reader cleared is a PROGRESS card for one transfer; a finished download is
  // a different condition with a different offer behind it, and the tray carries it
  // either way. What is never restored is the bar they dismissed.
  const main = readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  const downloaded = /function onUpdateDownloaded\(info\) \{[\s\S]*?\n\}/.exec(main);
  assert.ok(downloaded, 'onUpdateDownloaded was not found');
  assert.match(downloaded[0], /clearedAttempt = -1;/, 'a completion clears the abandoned-attempt mark');
  assert.match(downloaded[0], /stopStallWatch\(\)/, 'and stops the watchdog');
  assert.match(downloaded[0], /setNotice\('update-available'/, 'and raises the ready card');
});

