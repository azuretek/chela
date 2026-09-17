// Prove the update download card is HONEST and CLEARABLE, on the real app.
//
// Abi, 2026-09-17, on the macOS desktop: a banner reading "Downloading Claw
// Control UI <version>. Starting the download." with the bar stuck at 0% and no
// way to clear it. Two faults in one card, and this harness is the behavioural
// proof of both, driven through the real UI:
//
//   a stalled feed      the card reaches a clear, actionable state on a named
//                       window instead of sitting at 0% forever
//   the X               clearing it clears it, and the next chunk of a transfer
//                       nobody is watching does NOT put it back
//   a slow transfer     keeps its progress card for as long as it keeps moving,
//                       however long that is, because nothing cuts it off
//   a dead transfer     settles the card it raised rather than leaving a bar
//                       where it stopped
//
//   npx electron scripts/test-update-stall.js
//
// What is real and what is not. The banner, the notice store, the IPC, the
// update policy, the download phase state machine and every sentence are the
// app's own. What is replaced is the TRANSPORT, and only the transport:
// electron-updater needs a packaged app, a live release and a 130MB download to
// say anything at all, so the harness installs its own EventEmitter in the CJS
// cache under the specifier main.js resolves. It emits exactly the events the
// real one emits, including a CancellationToken that records a cancel, and it
// emits NOTHING when the scenario is a download that never moves -- which is the
// whole point, because "no progress events at all" is the failure this card could
// not survive.
//
// The window is NOT shortened for the run. 45 seconds is the value under test and
// a harness that quietly used 5 would prove nothing about the one that ships.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const APP_VERSION_FROM_FEED = '9.9.9';

/* --------------------------------------------------------------- the transport */

let mode = 'stall';
// Every event the fake updater emitted, with the clock, so the timeline below is
// evidence rather than a story. Nothing is emitted in 'stall' mode, and the
// timeline says so by having no entries.
const events = [];
let token = null;
const cancelled = [];

function record(kind, detail) {
  events.push({ at: Date.now(), kind, detail });
  console.log('[event] ' + kind + (detail ? ' ' + detail : ''));
}

class FakeToken {
  constructor() { this.cancelled = false; this.listeners = []; }
  cancel() {
    this.cancelled = true;
    cancelled.push(Date.now());
    record('cancel', 'the reader gave up the transfer');
  }
  onCanceled(fn) { this.listeners.push(fn); }
  dispose() {}
}

const fakeUpdater = new EventEmitter();
fakeUpdater.autoDownload = true;
fakeUpdater.allowPrerelease = false;
fakeUpdater.autoInstallOnAppQuit = false;
fakeUpdater.logger = { info() {}, warn() {}, error() {}, debug() {} };

fakeUpdater.checkForUpdates = async () => {
  // Asynchronously, like the real one: the app sets a flag before awaiting it, and
  // a synchronous emit would answer before that flag existed.
  await new Promise((r) => setTimeout(r, 50));
  token = new FakeToken();
  record('check', 'the feed named ' + APP_VERSION_FROM_FEED);
  fakeUpdater.emit('update-available', { version: APP_VERSION_FROM_FEED, releaseName: 'Claw Control UI ' + APP_VERSION_FROM_FEED });
  // ★ The library starts the download ITSELF here when autoDownload is set --
  // `doCheckForUpdates` returns `downloadPromise: this.autoDownload ?
  // this.downloadUpdate(cancellationToken) : null` -- and hands it the same token
  // it returns to the caller. That step is the whole of the transport under test,
  // and the first version of this harness did not reproduce it: nothing ever
  // called downloadUpdate, so the slow and dead scenarios never happened at all
  // and the stall scenario passed for the wrong reason.
  const downloadPromise = fakeUpdater.downloadUpdate(token);
  // The app attaches its own catch to this promise, which is what stops a failed
  // auto-download rejecting into the void. This is the harness's copy of it.
  downloadPromise.catch(() => {});
  return { updateInfo: { version: APP_VERSION_FROM_FEED }, cancellationToken: token, downloadPromise };
};

function progress(percent, transferred) {
  return { percent, transferred, total: 130 * 1024 * 1024, bytesPerSecond: 900 * 1024 };
}

function scheduleSlowProgress() {
  // A transfer that MOVES but moves slowly: a chunk every 10 seconds, five times,
  // which is longer than the 45 second stall window in total. A rate threshold, or
  // a window measured from the start, would call this dead part way through. It
  // must keep its progress card, and it must finish.
  let step = 0;
  const tick = setInterval(() => {
    step += 1;
    record('download-progress', 'percent ' + (step * 4));
    fakeUpdater.emit('download-progress', progress(step * 4, step * 5 * 1024 * 1024));
    if (step >= 5) {
      clearInterval(tick);
      setTimeout(() => {
        record('update-downloaded', APP_VERSION_FROM_FEED);
        fakeUpdater.emit('update-downloaded', { version: APP_VERSION_FROM_FEED });
      }, 400);
    }
  }, 10000);
  return new Promise((resolve) => setTimeout(resolve, 52000));
}

fakeUpdater.downloadUpdate = async (given) => {
  record('downloadUpdate', given === token ? 'with the app token' : 'with a token of its own');
  // 'idle': what the app's OWN startup check gets. It raises the card and then
  // nothing moves, and it is deliberately consumed before any scenario runs -- the
  // startup check fires 60 seconds after the updater is wired, and a run that
  // ignored it had its slow scenario interleaved with a second download the app
  // started on its own, which is a harness fault rather than an app one.
  if (mode === 'idle') return new Promise(() => {});
  if (mode === 'slow') return scheduleSlowProgress();
  if (mode === 'dead') {
    // What a release with no mac zip does inside the library: it throws before any
    // byte moves, and the only thing the app ever learns is an error event.
    // Long enough for the harness to observe the progress card it raised first:
    // the press below returns after 1.2s, and a failure that arrived inside that
    // window would make this scenario untestable rather than wrong.
    await new Promise((r) => setTimeout(r, 3000));
    record('error', 'ZIP file not provided');
    fakeUpdater.emit('error', new Error('ZIP file not provided: ERR_UPDATER_ZIP_FILE_NOT_FOUND'));
    throw new Error('ZIP file not provided');
  }
  // 'stall': nothing moves and nothing ever settles, which is what a request
  // stalled looks like from this side. It rejects if the reader cancels, which is
  // what the library does with a CancellationError rather than dispatching error.
  return new Promise((_resolve, reject) => {
    token.onCanceled(() => reject(Object.assign(new Error('cancelled'), { name: 'CancellationError' })));
  });
};
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

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-update-stall-'));
const { app, Menu, webContents } = await import('electron');
// The one fact the policy reads to decide whether a check happens at all, and
// whether a mac build may install for itself. Everything else is the app.
Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

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
  // The marker OpenClaw's own shell carries, so this address is accepted as a
  // gateway. Without it the app correctly refuses the page and raises a notice of
  // its own, which puts a second card on the bar and makes every probe below
  // ambiguous about which card it was reading.
  res.end('<!doctype html><html data-openclaw-control-ui-build-id="harness"><head><title>Gateway</title></head><body><h1 id="served">served</h1></body></html>');
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

// No autoUpdate key: the default is on, which on a signed macOS build means the
// finding is announced by the download's own progress card -- the card under test.
fs.writeFileSync(path.join(PROFILE, 'config.json'), JSON.stringify({
  gateways: [{ id: 'harness', label: 'Harness gateway', url: 'http://127.0.0.1:' + PORT + '/' }],
  activeGatewayId: 'harness',
}, null, 2) + '\n');

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log('OK   ' + name);
  else { console.error('FAIL ' + name + ': ' + detail); failed = true; }
}

const WATCHDOG_MS = 300000;
setTimeout(() => {
  console.error('FAIL harness: still running after ' + (WATCHDOG_MS / 1000) + 's');
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

function bannerContents() {
  return webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.getURL().includes('banner.html'));
}

// Everything the reader can see in the bar, plus whether a bar was drawn at all.
// Read from the page rather than from the store, because the page is the surface
// the report was about.
async function bar() {
  const wc = bannerContents()[0];
  if (!wc) return { text: '', bar: false, percent: null, clearable: false, action: null, cards: [] };
  const probe = "(() => {"
    + " const card = document.getElementById('n-update-available');"
    + " const bars = card ? card.querySelectorAll('progress') : [];"
    + " const close = card ? card.querySelector('.banner__close') : null;"
    + " const act = card ? card.querySelector('.banner__action') : null;"
    + " return {"
    + " text: card ? card.innerText.replace(/\\s*\\n+\\s*/g, ' | ').trim() : '',"
    + " bar: bars.length > 0,"
    + " percent: bars.length ? bars[0].value : null,"
    + " clearable: Boolean(close),"
    + " action: act ? act.textContent : null,"
    + " cards: Array.from(document.querySelectorAll('.banner')).map((n) => n.id),"
    + " };"
    + "})()";
  try {
    return await wc.executeJavaScript(probe);
  } catch {
    return { text: '', bar: false, percent: null, clearable: false, action: null, cards: [] };
  }
}

async function clickClose() {
  const wc = bannerContents()[0];
  if (!wc) return false;
  // The update card's OWN clear control, so a stray card cannot absorb the click.
  return wc.executeJavaScript("(() => { const c = document.getElementById('n-update-available'); const b = c && c.querySelector('.banner__close'); if (!b) return false; b.click(); return true; })()");
}

async function pressCheck(about) {
  await about.executeJavaScript("document.getElementById('check').click()");
  await delay(1200);
}

// Poll the bar until it says something, and report when. The elapsed number is
// the measured timeline: a state that arrives on a named window is a state with a
// boundary, and this is where the boundary is observed rather than asserted.
async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await bar();
    if (predicate(last)) return { hit: true, ms: Date.now() - started, state: last, label };
    await delay(250);
  }
  return { hit: false, ms: Date.now() - started, state: last, label };
}

app.whenReady().then(async () => {
  await delay(6000);

  const aboutItem = menuItem('About Claw Control UI');
  check('the About menu item exists', Boolean(aboutItem), 'no About menu item');
  if (!aboutItem) { app.exit(1); return; }
  aboutItem.click();
  await delay(2000);

  const about = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.getURL().includes('about.html'))[0];
  check('the About box opened', Boolean(about), 'no about.html view');
  if (!about) { app.exit(1); return; }

  // ★ Let the app's own startup check happen first, and let it be inert.
  //
  // The updater's first scheduled look runs 60 seconds after it is wired up, and a
  // run that ignored it had that check start a SECOND download in the middle of the
  // slow scenario: the timeline below showed two interleaved progress sequences and
  // the card had already been replaced by the ready notice when the bar was read.
  // Both failures were the harness reading a race it had created.
  mode = 'idle';
  console.log('[harness] waiting out the app own startup check (60s after wiring)');
  await delay(66000);
  const startup = await bar();
  console.log('[harness] after the startup check the bar holds ' + JSON.stringify(startup.cards));
  // ★ The launch check is a background fetch: nobody asked for it, so it draws no
  // card until it has evidence of movement. Pre-fix it put a bar at 0% on the bar
  // sixty seconds into EVERY launch, which is the card the reporter could not get
  // rid of: clearing it did not survive a relaunch because every run made a new
  // one. This is that card's absence, measured on the app's own startup path.
  check('the app own startup check draws nothing, so no bar is presented as live progress',
    startup.cards.length === 0,
    'the bar holds ' + JSON.stringify(startup.cards));

  /* ------------------------------------------- 1. a feed that never answers */

  mode = 'stall';
  const checkStarted = Date.now();
  await pressCheck(about);

  const started = await bar();
  check('the download card appears, naming the version',
    started.text.includes(APP_VERSION_FROM_FEED) && /Downloading/i.test(started.text),
    'the bar reads ' + JSON.stringify(started.text));
  check('it is drawn at zero, because nothing has arrived', started.bar && started.percent === 0,
    'bar=' + started.bar + ' percent=' + JSON.stringify(started.percent));
  check('and it offers a way out, which is what it did NOT before',
    started.clearable, 'the card has no clear control: ' + JSON.stringify(started.text));
  // A guard on the PROBE as much as on the app: this harness reads one card by id,
  // and an earlier version read the first match in the document instead and blamed
  // the app when a stray notice sorted ahead of it. Anything else on the bar is
  // reported here rather than quietly steering an assertion below.
  check('and nothing else is on the bar, so every probe below is unambiguous',
    started.cards.length === 1 && started.cards[0] === 'n-update-available',
    'the bar holds ' + JSON.stringify(started.cards));

  const stalledAt = await waitFor((s) => /stopped making progress/i.test(s.text), 90000, 'stalled');
  const elapsed = Date.now() - checkStarted;
  check('a download that never moves reaches the stalled state', stalledAt.hit,
    'it was still ' + JSON.stringify(stalledAt.state && stalledAt.state.text) + ' after ' + elapsed + 'ms');
  check('and it took the named 45 second window, not some other number',
    elapsed >= 44000 && elapsed <= 70000,
    'it took ' + elapsed + 'ms, measured from the press to the stalled card');
  check('the stalled card stopped claiming to show progress', stalledAt.state && stalledAt.state.bar === false,
    'a bar was still drawn: percent=' + JSON.stringify(stalledAt.state && stalledAt.state.percent));
  check('and it says what is known rather than that the download failed',
    stalledAt.state && /not been cancelled/i.test(stalledAt.state.text) && !/could not/i.test(stalledAt.state.text),
    'the card reads ' + JSON.stringify(stalledAt.state && stalledAt.state.text));
  check('and it offers the one thing it can actually do',
    stalledAt.state && stalledAt.state.action === 'Open release page',
    'the action reads ' + JSON.stringify(stalledAt.state && stalledAt.state.action));
  check('and it is still clearable', Boolean(stalledAt.state && stalledAt.state.clearable), 'no clear control');
  check('and the fake updater emitted no progress events at all, which is the fault',
    events.filter((e) => e.kind === 'download-progress').length === 0,
    'progress events seen: ' + events.filter((e) => e.kind === 'download-progress').length);

  /* ------------------------------------------------ 2. the reader clears it */

  const clicked = await clickClose();
  check('the clear control was clicked', clicked, 'no clear control to click');
  await delay(600);
  let after = await bar();
  check('the bar is empty after clearing it', after.text === '' && after.cards.length === 0,
    'the bar still holds ' + JSON.stringify(after.cards) + ' reading ' + JSON.stringify(after.text));
  check('and the transfer itself was given up, not just the card', cancelled.length === 1,
    'cancel calls: ' + cancelled.length);

  // The chunk nobody is watching: the app has stopped reporting this attempt, so
  // the next progress event must not slide the card back on as though nothing had
  // happened. This is the "must not reappear" rule, and it is the reason the clear
  // is not merely a hide.
  fakeUpdater.emit('download-progress', progress(37, 48 * 1024 * 1024));
  fakeUpdater.emit('download-progress', progress(38, 49 * 1024 * 1024));
  await delay(800);
  after = await bar();
  check('a late progress event does not put the cleared card back',
    after.cards.length === 0 && after.bar === false,
    'the bar came back holding ' + JSON.stringify(after.cards) + ' reading ' + JSON.stringify(after.text));

  /* --------------------------------- 3. a slow transfer keeps its progress */

  mode = 'slow';
  const slowStarted = Date.now();
  await pressCheck(about);
  const slowStart = await bar();
  check('a new attempt draws the progress card again, so a later offer still appears',
    /Downloading/i.test(slowStart.text) && slowStart.bar, 'the bar reads ' + JSON.stringify(slowStart.text));

  // ★ Read the bar WHILE it is moving, not after. The transfer completes inside
  // this scenario, so a probe taken at the end reads the ready notice and reports
  // that a working download showed no progress -- which is what a previous version
  // of this harness did, and it was the harness's fault rather than the app's.
  const moved = await waitFor((s) => s.bar && typeof s.percent === 'number' && s.percent > 0, 25000, 'first movement');
  check('and its bar moved, so the progress it showed was real', moved.hit,
    'never left zero: percent=' + JSON.stringify(moved.state && moved.state.percent));

  // Then watch it across the whole window and beyond. A transfer that keeps
  // arriving must never be called stalled, however long it takes.
  const sawStall = await waitFor((s) => /stopped making progress/i.test(s.text), 55000, 'spurious stall');
  check('a slow but moving download is never called stalled', sawStall.hit === false,
    'it was called stalled after ' + sawStall.ms + 'ms');
  check('and it was still moving after more than the whole stall window',
    Date.now() - slowStarted > 45000, 'only ' + (Date.now() - slowStarted) + 'ms elapsed');

  const readyAt = await waitFor((s) => /is ready/i.test(s.text), 30000, 'ready');
  check('and a normal download still finishes end to end', readyAt.hit,
    'the bar reads ' + JSON.stringify(readyAt.state && readyAt.state.text));
  check('and it offers the restart, which is the phase with something to lose',
    readyAt.state && /Install update/.test(readyAt.state.action || ''),
    'the action reads ' + JSON.stringify(readyAt.state && readyAt.state.action));

  /* ------------------------------- 4. a download that dies settles its card */

  mode = 'dead';
  await pressCheck(about);
  const deadStart = await bar();
  check('the dead download raises a progress card first, as the real one does',
    /Downloading/i.test(deadStart.text), 'the bar reads ' + JSON.stringify(deadStart.text));

  const settled = await waitFor((s) => /Could not download/i.test(s.text), 15000, 'settled');
  check('a download that fails settles the card it raised, in a background check', settled.hit,
    'the bar was still ' + JSON.stringify(settled.state && settled.state.text));
  check('and what replaces the bar is a warning rather than a bar at zero',
    settled.state && settled.state.bar === false, 'a bar was still drawn');
  check('and it is clearable too', Boolean(settled.state && settled.state.clearable), 'no clear control');

  /* ------------------------------------------------------- the timeline */

  console.log('');
  console.log('-- measured timeline (' + events.length + ' updater events) --');
  const base = events.length ? events[0].at : Date.now();
  for (const e of events) console.log(String(e.at - base).padStart(7) + 'ms  ' + e.kind + (e.detail ? '  ' + e.detail : ''));

  console.log(failed ? 'FAILED' : 'ALL OK');
  server.close();
  app.exit(failed ? 1 : 0);
});

