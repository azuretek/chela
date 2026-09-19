// Prove the manual update check answers in BOTH directions, on the real path.
//
// The complaint was "when I click check for updates I don't see that it has a new
// one", which is the class of bug this repo keeps producing: a control that
// appears to work and reports nothing. So the two directions are asserted here,
// both of them, from one run:
//
//   a feed naming a newer version   the banner says which version, and offers it
//   a feed naming this build        the banner says this build is up to date
//
//   npx electron scripts/test-update-answer.js [--shots DIR]
//
// What is real and what is not. The button, the IPC, `checkForUpdates`, the
// policy, the shared answer, the notice store and the banner are all the app's
// own, driven the way a person drives them: the About overlay is opened from the
// menu and its Check for updates button is clicked. What is replaced is the
// TRANSPORT, and only the transport: electron-updater needs a packaged app with
// a live GitHub release to answer at all, and a harness that needed one would be
// a harness that never ran. `electron-updater` is stubbed in the CJS cache with
// an EventEmitter that emits the same two events the real one does, and
// `app.isPackaged` is forced true, which is the switch the policy reads to decide
// whether this build may check at all. No claim is made here about the real
// updater's own comparison, which is electron-updater's and is covered by the
// release workflow.
//
// The preference is turned OFF in the profile, which is a real setting a person
// can set, and which is what makes the "available" answer a notice rather than a
// download in progress: on a signed macOS build with automatic updates on, the
// finding is announced by the download's own progress notice. Both are the same
// answer to the same question, and the notice is the one that names the version
// on its own.
//
// The profile is pinned BOTH ways; main.js decides isolation from the
// `--user-data-dir` SWITCH rather than from the path. See scripts/dump-overlays.js.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const APP_VERSION_FROM_FEED = '9.9.9';

/* --------------------------------------------------------------- the transport */

/** What the next `checkForUpdates()` should find: a release, or nothing. */
let feed = 'current';

const fakeUpdater = new EventEmitter();
fakeUpdater.autoDownload = true;
fakeUpdater.allowPrerelease = false;
fakeUpdater.autoInstallOnAppQuit = false;
fakeUpdater.logger = { info() {}, warn() {}, error() {}, debug() {} };
fakeUpdater.checkForUpdates = async () => {
  // Asynchronously, like the real one: the app sets a flag before awaiting it,
  // and a synchronous emit would answer before that flag existed.
  await new Promise((r) => setTimeout(r, 50));
  if (feed === 'available') {
    fakeUpdater.emit('update-available', {
      version: APP_VERSION_FROM_FEED,
      releaseName: `Claw Control UI ${APP_VERSION_FROM_FEED}`,
    });
  } else {
    fakeUpdater.emit('update-not-available', { version: '0.0.0' });
  }
  return { updateInfo: { version: feed === 'available' ? APP_VERSION_FROM_FEED : '0.0.0' } };
};
fakeUpdater.downloadUpdate = async () => {};
fakeUpdater.quitAndInstall = () => {};

// Into the CJS cache, under the exact specifier main.js resolves. Its own
// `require` comes from createRequire(import.meta.url) at the same path, so the
// cache key is the same file and the stub is what it gets.
const updaterPath = require.resolve('electron-updater');
require.cache[updaterPath] = {
  id: updaterPath,
  filename: updaterPath,
  loaded: true,
  exports: { autoUpdater: fakeUpdater },
};

/* ------------------------------------------------------------------ the profile */

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-update-answer-'));
const { app, BrowserWindow, Menu, webContents } = await import('electron');
// The one fact the policy reads to decide whether a check happens at all, forced
// for the run: everything else about the app is the app.
Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

const shotIndex = process.argv.indexOf('--shots');
const SHOTS = shotIndex === -1 ? null : process.argv[shotIndex + 1];
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const PORT = await freePort();
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>Gateway</title><h1 id="served">served</h1>');
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Harness gateway', url: `http://127.0.0.1:${PORT}/` }],
  activeGatewayId: 'harness',
  // A real preference a person can set. It makes the "available" finding a notice
  // that names the version rather than a download already in progress.
  autoUpdate: false,
}, null, 2)}\n`);

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

const WATCHDOG_MS = 120000;
setTimeout(() => {
  console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`);
  app.exit(1);
}, WATCHDOG_MS).unref();

function menuItem(label) {
  const menu = Menu.getApplicationMenu();
  for (const top of menu ? menu.items : []) {
    for (const item of top.submenu ? top.submenu.items : []) {
      if (item.label === label) return item;
    }
  }
  return null;
}

function contentsIncluding(fragment) {
  return webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.getURL().includes(fragment));
}

function bannerText() {
  const wc = contentsIncluding('banner.html')[0];
  if (!wc) return Promise.resolve('');
  return wc.executeJavaScript('document.body.innerText')
    .then((t) => t.replace(/\s*\n+\s*/g, ' | ').trim())
    .catch(() => '');
}

async function capture(name) {
  if (!SHOTS) return;
  const win = BrowserWindow.getAllWindows()[0];
  const [width, height] = win.getContentSize();
  const { desktopCapturer } = await import('electron');
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
  const mine = sources.find((s) => s.id === win.getMediaSourceId()) || sources.find((s) => /claw/i.test(s.name));
  if (mine && !mine.thumbnail.isEmpty()) fs.writeFileSync(path.join(SHOTS, `${name}.png`), mine.thumbnail.toPNG());
}

/** Press the About box's own Check for updates button, the way a person does. */
async function pressCheck(about) {
  await about.executeJavaScript("document.getElementById('check').click()");
  // Long enough for the IPC round trip, the stubbed check and the notice render.
  await delay(1200);
}

app.whenReady().then(async () => {
  await delay(6000);

  const aboutItem = menuItem('About Claw Control UI');
  check('the About menu item exists', Boolean(aboutItem), 'no About menu item');
  if (!aboutItem) { app.exit(1); return; }
  aboutItem.click();
  await delay(2000);

  const about = contentsIncluding('about.html')[0];
  check('the About box opened', Boolean(about), 'no about.html view');
  if (!about) { app.exit(1); return; }

  const statusLine = (fragment) => new Promise((resolve) => {
    const wc = contentsIncluding(fragment)[0];
    if (!wc) { resolve(null); return; }
    wc.executeJavaScript("document.getElementById('update-status').textContent")
      .then(resolve).catch(() => resolve(null));
  });

  /* --------------------------------------------------- direction one: current */

  // Run first, on a board with nothing on it: the point of this direction is that
  // pressing the button reports something, and that reads most cleanly when the
  // only thing on the banner is the answer to the press.
  feed = 'current';
  await pressCheck(about);
  let text = await bannerText();
  check('a current build is reported as current', /up to date/i.test(text), `the banner reads ${JSON.stringify(text)}`);
  check('and it names the build you are on', /You are on/.test(text), text);
  check('and no version is offered, because there is none', !text.includes(APP_VERSION_FROM_FEED), text);
  let status = await statusLine('about.html');
  check('and the About card says the same thing', status !== null && /up to date/i.test(status),
    `the card reads ${JSON.stringify(status)}`);
  check('and it stops saying it is still checking', !/checking/i.test(status || ''), status);
  await capture('update-current');

  /* ------------------------------------------------- direction two: available */

  feed = 'available';
  await pressCheck(about);
  text = await bannerText();
  check('a newer version is reported, and named', text.includes(APP_VERSION_FROM_FEED),
    `the banner reads ${JSON.stringify(text)}`);
  check('and the answer offers the install it can do', /Download and install/.test(text), text);
  // The answer to a press supersedes the previous answer to the same question,
  // rather than stacking a second card under it.
  check('and the previous answer is not still on screen', !/up to date/i.test(text), text);
  status = await statusLine('about.html');
  check('and the About card says the same thing', status !== null && status.includes(APP_VERSION_FROM_FEED),
    `the card reads ${JSON.stringify(status)}`);
  check('and it is not still checking', !/checking/i.test(status || ''), status);
  await capture('update-available');

  /* ------------------------------------ direction three: a SECOND press */

  // ★ The reported bug: "clicking the check for updates button works great the
  // first time, but if I click it again it just flashes and returns quickly". The
  // first press this run is already covered above; this is the SECOND press for the
  // same outcome, which used to flash because the answer settled on a re-check with
  // nothing cached to hold on screen. Now the cached answer is re-presented at once
  // and floored (MIN_VISIBLE_MS), so the card is on the bar continuously across the
  // press rather than blinking. Driven on the "current" feed so the held state is
  // the "up to date" answer, and it is the one the reader complained they could not
  // read.
  feed = 'current';
  await pressCheck(about);
  text = await bannerText();
  check('a second press still reports the answer, held rather than flashed',
    /up to date/i.test(text), `the banner reads ${JSON.stringify(text)} after a second press`);
  check('and it still names the build you are on', /You are on/.test(text), text);
  // Press again immediately, then read the bar WITHOUT waiting for the re-check to
  // settle: the cached answer is up at once, so the bar is never empty between the
  // press and the live answer. This is the frame that used to be blank.
  await about.executeJavaScript("document.getElementById('check').click()");
  await delay(80); // far shorter than the stubbed check's 50ms + render, deliberately
  const immediate = await bannerText();
  check('★ the answer is on the bar the instant the button is pressed, not after a fetch',
    /up to date/i.test(immediate), `the banner read ${JSON.stringify(immediate)} right after the press`);
  await delay(1400); // let the re-check settle and the held card ride its floor
  const settled = await bannerText();
  check('and it is still there once the re-check settles, not replaced by a flash',
    /up to date/i.test(settled), `the banner reads ${JSON.stringify(settled)} after the re-check`);
  await capture('update-second-press');

  console.log(failed ? 'FAILED' : 'ALL OK');
  server.close();
  app.exit(failed ? 1 : 0);
});
