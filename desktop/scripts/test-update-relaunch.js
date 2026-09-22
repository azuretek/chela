// Prove the update download card does NOT come back after a RELAUNCH.
//
// Abi, 2026-09-17, after the stall window and the clear control landed: "I don't
// think the 0% thing is what you said it's just hung here on my mac even after a
// restart". The two facts in that sentence are what this harness exists for.
//
//   * it survives a restart -- so whatever brings it back runs on EVERY launch,
//     and the previous harness only ever looked inside ONE run
//   * "hung" -- which is a different claim from "sitting still", and has to be
//     told apart from an app whose main process is blocked
//
// So this runs the real app TWICE against one profile directory, as a real
// relaunch in a real second process, and measures the difference between them:
//
//   phase 1   let the app's own launch check run (60s after the updater is
//             wired) and record what the bar does, then ask for a check by hand
//             and clear the card the way the reporter did
//   phase 2   relaunch on the SAME profile and record whether the card returns,
//             and WHEN. A card that appears ~60s in is born of that run's own
//             launch check; one that is on the bar as the window paints was
//             restored from state on disk. Those need different fixes, and the
//             offset is what tells them apart rather than a guess.
//
// It also measures RESPONSIVENESS while the download is in flight, because
// "hung" is a claim about the app and not only about the card. The main process
// answering a JS round-trip in milliseconds, and its own 45 second stall timer
// firing, is what rules out a blocked process. A wedged transfer and a blocked
// process look alike from outside; they do not look alike from here.
//
//   npm run test:update-relaunch        (or: node scripts/test-update-relaunch.js)
//
// Driven by node rather than by electron, unlike the stall harness: this one has
// to launch the app twice, and a child Electron spawned from inside another one
// is a child that never gets a window.
//
// What is real and what is not is the same split the stall harness documents:
// the banner, the store, the IPC, the update policy, the download phase state
// machine and every sentence are the app's own, and only the TRANSPORT is
// replaced. It offers 9.9.9 on every check and then never moves: no progress
// event, no error, no settle. That IS the failure being reported, and it is the
// one shape electron-updater has no timeout for (there is no timeout anywhere in
// the library except the Windows signature verifier).

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const APP_VERSION_FROM_FEED = '9.9.9';
// The app's own launch check, from src/main.js. The offset is the evidence, so
// the harness never shortens it.
const FIRST_CHECK_MS = 60 * 1000;
const STALL_MS = 45000;
// Generous against the timeline below (60s to the launch check, 45s to the stall
// card, plus the manual press), and short enough to fail rather than hang.
const PHASE_LIMIT_MS = 150000;

const PHASE = process.env.CLAW_RELAUNCH_PHASE || null;
const PROFILE = process.env.CLAW_RELAUNCH_PROFILE || null;

// The driver runs under plain `node`, because the thing it drives is Electron
// itself: spawning an Electron app from inside another Electron app gave a child
// that never created a window at all (no helper processes, no output past its
// load-time lines), which is a fact about the harness rather than about the app.
// Run it as `npm run test:update-relaunch`, or `node scripts/test-update-relaunch.js`.
// ★ NOT awaited, and that is the whole reason a phase run produced no window at
// all: Electron does not emit 'ready' until the entry module has finished
// evaluating, and this module cannot finish while it awaits a phase that is itself
// waiting for 'ready'. The deadlock is silent -- no error, no window, no output
// past the app's load-time lines -- which is exactly what it looked like from here
// until the process was sampled and found idle in its run loop.
if (PHASE) {
  phase(Number(PHASE)).catch((err) => {
    console.error('[phase] ' + (err && (err.stack || err.message) ? (err.stack || err.message) : err));
    process.exit(1);
  });
} else if (process.versions.electron) {
  console.error('This harness is driven by node, so that it can relaunch the app twice.');
  console.error('Run: node scripts/test-update-relaunch.js   (or npm run test:update-relaunch)');
  process.exit(2);
} else await driver();

/* -------------------------------------------------------------- the driver */

/**
 * Run phase 1, then relaunch for phase 2, then judge what the two measured.
 *
 * The judgement lives here rather than in either phase because it is the
 * DIFFERENCE that is under test: phase 1 proves the card exists and can be
 * cleared, phase 2 proves clearing it survived a relaunch. Either half alone
 * passes for the wrong reason, and a phase that asserted its own conclusion
 * could not tell a fixed app from a broken one.
 */
async function driver() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-update-relaunch-'));
  console.log('[driver] one profile for both launches: ' + profile);

  const results = {};
  for (const n of [1, 2]) {
    const phaseOut = path.join(profile, 'phase' + n + '.json');
    try { fs.rmSync(phaseOut, { force: true }); } catch { /* first run */ }
    console.log('');
    console.log('[driver] === launch ' + n + ' ===');
    const code = await run(profile, n);
    if (code !== 0) {
      console.error('[driver] launch ' + n + ' exited ' + code);
      process.exit(1);
    }
    results[n] = JSON.parse(fs.readFileSync(phaseOut, 'utf8'));
  }

  const one = results[1];
  const two = results[2];
  let failed = false;
  const check = (name, ok, detail) => {
    if (ok) console.log('OK   ' + name);
    else { console.error('FAIL ' + name + ': ' + detail); failed = true; }
  };

  console.log('');
  console.log('-- launch 1 --');
  console.log('   launch check drew a card at ' + JSON.stringify(one.launchCardAtMs) + 'ms (null is the fix)');
  console.log('   drawn with a bar at     ' + JSON.stringify(one.launchCardPercent));
  console.log('   main process answered a JS round-trip in ' + JSON.stringify(one.responsiveMs) + 'ms');
  console.log('   cancels at the clear    ' + JSON.stringify(one.cancelled));
  console.log('   cleared by the X        ' + JSON.stringify(one.cleared));
  console.log('-- launch 2 (the relaunch) --');
  console.log('   card seen at            ' + JSON.stringify(two.firstCardAtMs) + 'ms after launch');
  console.log('   state on disk at launch ' + JSON.stringify(two.diskState));

  // The scenario has to be real in both directions, or the assertion below is
  // vacuous: something must have been shown and cleared in launch 1.
  check('the reader was shown a card they could clear, and cleared it',
    one.cleared === true,
    'cleared=' + JSON.stringify(one.cleared) + ' manualCard=' + JSON.stringify(one.manualCard));

  // ★ The fix, in one line: a background fetch draws nothing until it has evidence
  // of movement, so the launch check cannot put a bar at 0% on the screen at all.
  check('the app own launch check draws NO card, so nothing is presented as live progress on launch',
    one.launchCardAtMs === null,
    'a card was drawn ' + JSON.stringify(one.launchCardAtMs) + 'ms after launch, at ' + JSON.stringify(one.launchCardPercent));

  // ★ "Hung" is ruled out here rather than argued about. A blocked main process
  // cannot answer executeJavaScript, and it cannot fire its own stall timer.
  check('the app stayed responsive while the transfer was wedged, so the app was not hung',
    typeof one.responsiveMs === 'number' && one.responsiveMs < 2000,
    'the banner answered in ' + JSON.stringify(one.responsiveMs) + 'ms');
  // The transfer was given up rather than only hidden: the token the library
  // hands back is the only cancel it has, and the reader's clear uses it.
  check('the transfer the reader cleared was given up, not just hidden',
    typeof one.cancelled === 'number' && one.cancelled >= 1,
    'cancel calls: ' + JSON.stringify(one.cancelled));

  // ★ The assertion this harness exists for. A card that comes back after a
  // relaunch means the reader has no way to stop being told about a transfer
  // they already ended.
  check('the card does NOT come back after a relaunch',
    two.firstCardAtMs === null,
    'it returned at ' + JSON.stringify(two.firstCardAtMs) + 'ms after launch 2');

  // And the offset, reported either way: ~60s means a fresh attempt from that
  // run's own launch check, ~0 means state restored as the window painted.
  if (two.firstCardAtMs !== null) {
    console.log('   (that card was ' + (two.firstCardAtMs < 10000 ? 'RESTORED at startup' : 'a fresh launch check') + ')');
  }
  check('and no live progress bar is drawn on launch for a transfer in flight',
    two.barOnLaunch !== true,
    'a bar was drawn at ' + JSON.stringify(two.firstCardPercent));

  console.log('');
  console.log(failed ? 'FAILED' : 'ALL OK');
  process.exit(failed ? 1 : 0);
}

/**
 * One launch, in its own process, so the relaunch is a real one.
 *
 * The app is a real Electron app, so it is a real second process rather than a
 * second import, and the profile directory is handed over by the environment so
 * both launches read the SAME store. A phase that never exits is killed and
 * reported: a harness that hangs is a harness that proves nothing.
 */
function run(profile, n) {
  const electron = require('electron');
  return new Promise((resolve) => {
    const child = spawn(electron, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, CLAW_RELAUNCH_PHASE: String(n), CLAW_RELAUNCH_PROFILE: profile },
      stdio: 'inherit',
    });
    const limit = setTimeout(() => {
      console.error('[driver] launch ' + n + ' did not finish in ' + (PHASE_LIMIT_MS / 1000) + 's; killing pid ' + child.pid);
      child.kill('SIGKILL');
    }, PHASE_LIMIT_MS);
    child.on('exit', (code) => {
      clearTimeout(limit);
      resolve(code === null ? 1 : code);
    });
  });
}

/* --------------------------------------------------------------- one launch */

async function phase(n) {
  const events = [];
  const cancelled = [];
  let token = null;

  const record = (kind, detail) => {
    events.push({ at: Date.now(), kind, detail });
    console.log('[event] ' + kind + (detail ? ' ' + detail : ''));
  };

  class FakeToken {
    constructor() { this.cancelled = false; this.listeners = []; }
    cancel() { this.cancelled = true; cancelled.push(Date.now()); record('cancel', 'the reader gave up the transfer'); }
    onCanceled(fn) { this.listeners.push(fn); }
    dispose() {}
  }

  const fakeUpdater = new EventEmitter();
  fakeUpdater.autoDownload = true;
  fakeUpdater.allowPrerelease = false;
  fakeUpdater.autoInstallOnAppQuit = false;
  fakeUpdater.logger = { info() {}, warn() {}, error() {}, debug() {} };

  fakeUpdater.checkForUpdates = async () => {
    await new Promise((r) => setTimeout(r, 50));
    token = new FakeToken();
    record('check', 'the feed named ' + APP_VERSION_FROM_FEED);
    fakeUpdater.emit('update-available', { version: APP_VERSION_FROM_FEED, releaseName: 'Chela ' + APP_VERSION_FROM_FEED });
    // The library starts the download itself when autoDownload is set, and hands
    // it the same token it returns. This one never moves and never settles:
    // nothing is emitted, nothing rejects. That is the reported state.
    const downloadPromise = fakeUpdater.downloadUpdate(token);
    downloadPromise.catch(() => {});
    return { updateInfo: { version: APP_VERSION_FROM_FEED }, cancellationToken: token, downloadPromise };
  };

  fakeUpdater.downloadUpdate = (given) => {
    record('downloadUpdate', given === token ? 'with the app token' : 'with a token of its own');
    return new Promise((_resolve, reject) => {
      token.onCanceled(() => reject(Object.assign(new Error('cancelled'), { name: 'CancellationError' })));
    });
  };
  fakeUpdater.quitAndInstall = () => {};

  const updaterPath = require.resolve('electron-updater');
  require.cache[updaterPath] = {
    id: updaterPath, filename: updaterPath, loaded: true,
    exports: { autoUpdater: fakeUpdater },
  };

  const { app, Menu, webContents } = await import('electron');
  // The one fact the policy reads to decide whether a check happens and whether
  // a mac build may fetch an update for itself. Everything else is the app.
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
    // gateway. Without it the app correctly refuses the page and raises a notice
    // of its own, which would make every probe below ambiguous.
    res.end('<!doctype html><html data-openclaw-control-ui-build-id="harness"><head><title>Gateway</title></head><body><h1 id="served">served</h1></body></html>');
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  // The store is created on the first launch and only UPDATED on a relaunch: the
  // relaunch has to read the same file, or it is not a relaunch of anything. What
  // does move between launches is the port, because each launch's placeholder
  // gateway is its own process, and leaving the second launch pointed at the
  // first one's dead address puts a connection notice on the bar -- noise in the
  // same place the card under test lives.
  const configPath = path.join(PROFILE, 'config.json');
  const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null;
  const url = 'http://127.0.0.1:' + PORT + '/';
  const gateways = existing && Array.isArray(existing.gateways) && existing.gateways.length
    ? existing.gateways.map((g) => (g.id === 'harness' ? { ...g, url } : g))
    : [{ id: 'harness', label: 'Harness gateway', url }];
  fs.writeFileSync(configPath, JSON.stringify({ ...(existing || {}), gateways, activeGatewayId: 'harness' }, null, 2) + '\n');

  const startedAt = Date.now();
  await import('../src/main.js');
  await app.whenReady();
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function bannerContents() {
    return webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.getURL().includes('banner.html'));
  }

  /** Everything the reader can see in the bar, read from the page itself. */
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
    try { return await wc.executeJavaScript(probe); }
    catch { return { text: '', bar: false, percent: null, clearable: false, action: null, cards: [] }; }
  }

  /** Is the app answering at all? A blocked main process times out here. */
  async function responsive() {
    // ANY of the app's own live views will do, and it has to be any: with the fix,
    // a launch that draws no card never creates the banner view at all, so probing
    // the banner alone reports "no answer" for an app that is answering perfectly
    // well. That mis-measure is what a view-coupled probe does.
    const wc = bannerContents()[0] || webContents.getAllWebContents().filter((w) => !w.isDestroyed())[0];
    if (!wc) return null;
    const t0 = Date.now();
    try {
      await Promise.race([
        wc.executeJavaScript('1'),
        new Promise((_r, reject) => setTimeout(() => reject(new Error('no answer in 5s')), 5000)),
      ]);
    } catch { return 5000; }
    return Date.now() - t0;
  }

  let sawUpdateCard = false;
  let firstCardAtMs = null;
  let firstCardPercent = null;
  let barOnLaunch = null;

  async function watchForCard(untilMs) {
    while (Date.now() - startedAt < untilMs) {
      const state = await bar();
      // The first reading, at launch, is what tells a RESTORED card apart from a
      // re-created one: anything on the bar before the app's own check has run
      // was not produced by that check.
      if (barOnLaunch === null) { barOnLaunch = state.bar; }
      if (state.cards.includes('n-update-available')) {
        if (!sawUpdateCard) {
          sawUpdateCard = true;
          firstCardAtMs = Date.now() - startedAt;
          firstCardPercent = state.percent;
          console.log('[phase ' + n + '] the update card appeared ' + firstCardAtMs + 'ms after launch: ' + JSON.stringify(state.text));
        }
        return state;
      }
      await delay(250);
    }
    return null;
  }

  const aboutItem = () => {
    const menu = Menu.getApplicationMenu();
    for (const top of menu ? menu.items : []) {
      for (const item of top.submenu ? top.submenu.items : []) {
        if (item.label === 'Check for updates\u2026') return item;
      }
    }
    return null;
  };

  const out = { phase: n, startedAt, profile: PROFILE };

  // ★ The watch starts from the 'ready' EVENT rather than from an await at module
  // level, and that is not style. Electron does not emit 'ready' until the entry
  // module has finished evaluating, so `await app.whenReady()` at the top level of
  // this file deadlocks it: the app never becomes ready, no window is ever
  // created, and nothing says why. The stall harness resolves it with .then() for
  // the same reason.
  const watch = async () => {
  // ---------------------------------------------------------------- launch 1
  if (n === 1) {
    await delay(6000);
    out.diskState = fs.readdirSync(PROFILE).sort();

    // The app's OWN launch check, exactly as it runs for the reporter: nothing
    // is pressed. Its bar is read on the way past, and the responsiveness
    // measure is taken while the transfer is in flight and wedged.
    const launchCard = await watchForCard(FIRST_CHECK_MS + 20000);
    // ★ What the app's OWN launch check did, which is the reported bug: a card drawn
    // at zero for a transfer nobody asked for. Null is the fix.
    out.launchCardAtMs = firstCardAtMs;
    out.launchCardPercent = firstCardPercent;
    out.barOnLaunch = barOnLaunch;
    out.launchCheckRaisedCard = launchCard !== null;
    out.responsiveMs = await responsive();
    console.log('[phase 1] responsiveness while wedged: ' + out.responsiveMs + 'ms');

    // Then ask for a check by hand. That is the one path that raises a card the
    // reader ASKED for, and it is deliberately taken before the stall window would
    // fire for the launch attempt: otherwise the launch attempt is suppressed by
    // then and this phase reads the honest offer instead of the download card it
    // means to clear. The stall card for a pressed download belongs to the stall
    // harness, which asserts its window there.
    const item = aboutItem();
    out.checkMenuItem = Boolean(item);
    if (item) item.click();
    await delay(2000);
    const pressed = await bar();
    console.log('[phase 1] after a manual check the bar reads ' + JSON.stringify(pressed.text));
    out.manualCard = pressed.cards.includes('n-update-available');

    const wc = bannerContents()[0];
    out.cleared = false;
    if (wc) {
      out.cleared = await wc.executeJavaScript("(() => { const c = document.getElementById('n-update-available'); const b = c && c.querySelector('.banner__close'); if (!b) return false; b.click(); return true; })()");
    }
    await delay(600);
    const after = await bar();
    out.cardsAfterClear = after.cards;
    console.log('[phase 1] after clearing, the bar holds ' + JSON.stringify(after.cards));

    // What the clear left on disk, which is the thing a relaunch reads.
    out.diskAfterClear = fs.readdirSync(PROFILE).sort();
    out.configAfterClear = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    out.cancelled = cancelled.length;
  } else {
    // ------------------------------------------------------------- launch 2
    out.diskState = fs.readdirSync(PROFILE).sort();
    out.configAtLaunch = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Read the bar at launch, before anything, so a card restored as the window
    // paints cannot be mistaken for one the launch check produced.
    await delay(6000);
    const early = await bar();
    out.barOnLaunch = early.bar;
    out.cardsAtLaunch = early.cards;
    out.firstCardAtMs = early.cards.includes('n-update-available') ? Date.now() - startedAt : null;
    if (out.firstCardAtMs !== null) out.firstCardPercent = early.percent;

    const card = await watchForCard(FIRST_CHECK_MS + 30000);
    if (card && out.firstCardAtMs === null) out.firstCardPercent = firstCardPercent;
    out.firstCardAtMs = firstCardAtMs === null ? out.firstCardAtMs : firstCardAtMs;
    out.responsiveMs = await responsive();
    console.log('[phase 2] card=' + JSON.stringify(out.firstCardAtMs) + 'ms bar=' + JSON.stringify(out.barOnLaunch));
  }

  fs.writeFileSync(path.join(PROFILE, 'phase' + n + '.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('[phase ' + n + '] wrote ' + path.join(PROFILE, 'phase' + n + '.json'));
  server.close();
  app.exit(0);
  };
  app.whenReady().then(() => void watch());
}
