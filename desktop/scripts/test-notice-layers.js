// Prove where the notice banner sits, against the layers that actually overlap
// it: the app's own Settings surface, About over Settings, and the Control UI
// underneath.
//
// The z-order is the whole claim, and it is the one thing no unit test can see.
// `dialogs.test.js` reads the restackViews list and asserts `bannerView` comes
// after the overlays, which is true of the source and says nothing about what a
// window drew. So this runs the real app and asserts the window's own child
// order, then takes an image of the composited window as the human-readable half.
//
//   npx electron scripts/test-notice-layers.js [--shots DIR]
//
// Three things about the capture. `webContents.capturePage()` cannot do this job:
// it captures one WebContents, and the question here is which of several child
// views is on top in a window that has no WebContents of its own. Only the OS
// compositor sees the stack, so the image comes from `desktopCapturer`. And the
// position assertions in scripts/test-connection-failure.js are the other half of
// the same claim: this file is about ORDER, that one is about BOUNDS, and a
// banner that is on top and somewhere else is still wrong.
//
// The condition is real rather than injected: the profile is written with a
// global shortcut the OS cannot register, which is one of the four things that
// genuinely raise a notice. See the note in scripts/test-banner.js. The update
// answer in the last step is real too, raised by pressing the About page's own
// button through its real IPC, which is the path a person takes.
//
// The profile is pinned BOTH ways, from dump-overlays.js's record of why: main.js
// decides whether a run is isolated from the `--user-data-dir` SWITCH rather than
// from the path, so a harness that sets only the path runs on the real profile.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { app, BrowserWindow, Menu, desktopCapturer, webContents } from 'electron';

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-notice-layers-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

const shotIndex = process.argv.indexOf('--shots');
const SHOTS = shotIndex === -1 ? null : process.argv[shotIndex + 1];
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/** A port nothing else is on, because a taken one is a run that proves nothing. */
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
// A gateway that is up, so the window is a real Control UI page with Settings
// drawn over it rather than Settings standing in for the window on a first run.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>Gateway</title><h1 id="served">served</h1>');
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Harness gateway', url: `http://127.0.0.1:${PORT}/` }],
  activeGatewayId: 'harness',
  // Not an accelerator. globalShortcut.register throws on it, which is exactly
  // the path that raises the 'shortcut' notice.
  globalShortcut: 'Frobnicate+Zz',
}, null, 2)}\n`);

// Dynamically, and after the profile is prepared, because a static import would
// be hoisted and run main before this file had a profile to point it at.
await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}
function note(text) { console.log(`note ${text}`); }

function contentsIncluding(fragment) {
  return webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.getURL().includes(fragment));
}
function banner() { return contentsIncluding('banner.html')[0] || null; }
function settingsPage() { return contentsIncluding('settings.html')[0] || null; }
function aboutPage() { return contentsIncluding('about.html')[0] || null; }

function menuItem(label) {
  const menu = Menu.getApplicationMenu();
  for (const top of menu ? menu.items : []) {
    for (const item of top.submenu ? top.submenu.items : []) {
      if (item.label === label) return item;
    }
  }
  return null;
}

const WATCHDOG_MS = 150000;
setTimeout(() => {
  console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`);
  app.exit(1);
}, WATCHDOG_MS).unref();

/**
 * The window's child views, in the order the compositor stacks them.
 *
 * `contentView.children` is the window's own list, and `addChildView` on an
 * attached view moves it to the top, so the LAST entry is the frontmost. Read
 * through webContents ids because that is what each view can be matched to.
 */
function stackOrder(win) {
  return win.contentView.children
    .filter((view) => view && view.webContents)
    .map((view) => {
      const url = view.webContents.isDestroyed() ? '' : view.webContents.getURL();
      if (url.includes('banner.html')) return 'banner';
      if (url.includes('settings.html')) return 'settings';
      if (url.includes('about.html')) return 'about';
      if (url.includes('loading.html')) return 'loading';
      if (url.startsWith('http')) return 'gateway';
      return url || 'unknown';
    });
}

/** One image of the COMPOSITED window, which is the only way to see the stack. */
async function captureWindow(name) {
  if (!SHOTS) return { file: null, image: null, scale: 1 };
  const win = BrowserWindow.getAllWindows()[0];
  const [width, height] = win.getContentSize();
  const wanted = win.getMediaSourceId();
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
  const mine = sources.find((s) => s.id === wanted)
    || sources.find((s) => /claw/i.test(s.name));
  if (!mine || mine.thumbnail.isEmpty()) return { file: null, image: null, scale: 1 };
  const image = mine.thumbnail;
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  const size = image.getSize();
  return { file, image, scale: size.width / width };
}

/** The set of colours in a band of rows, downsampled, as `r,g,b` strings. */
function coloursInBand(image, y0, y1) {
  const size = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  const seen = new Set();
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(size.height, Math.round(y1)); y += 1) {
    for (let x = 0; x < size.width; x += 2) {
      const i = (y * size.width + x) * 4;
      seen.add(`${bitmap[i + 2]},${bitmap[i + 1]},${bitmap[i]}`);
    }
  }
  return seen;
}

function rgbOf(css) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css || '');
  return m ? `${m[1]},${m[2]},${m[3]}` : null;
}

/** A count read out of the banner page, or null when the view has gone. */
async function bannerCounts(wc, expr) {
  try {
    return await wc.executeJavaScript(expr);
  } catch {
    return null;
  }
}

/**
 * Press one of the banner's own controls.
 *
 * Deliberately NOT awaited: dismissing the last unread notice tears the banner
 * view down, and the WebContents close takes the pending `executeJavaScript`
 * promise with it, so awaiting it hangs the harness until the watchdog fires
 * (measured 2026-09-16, on the first run of this file). Fire, then settle, then
 * read the result from outside the page.
 */
function press(wc, expr) {
  try {
    wc.executeJavaScript(expr).catch(() => {});
  } catch { /* already gone */ }
}

app.whenReady().then(async () => {
  await delay(7000);

  const win = BrowserWindow.getAllWindows()[0];
  const bannerWc = banner();
  check('a real condition raises the banner', Boolean(bannerWc), 'no banner view exists');
  if (!bannerWc) { app.exit(1); return; }

  // The tone stripe's colour, read from the banner's own rendered card rather
  // than from a token file: whatever it actually painted with is what the image
  // has to contain for "the banner drew there" to mean anything.
  const stripe = rgbOf(await bannerWc.executeJavaScript(
    "getComputedStyle(document.querySelector('.banner')).borderLeftColor",
  ));
  check('the banner painted a tone stripe', Boolean(stripe), 'no borderLeftColor');
  const bannerHeight = await bannerWc.executeJavaScript('window.innerHeight');

  // Over the Control UI, with nothing else open.
  check('the banner is the frontmost view over the Control UI',
    stackOrder(win).at(-1) === 'banner', stackOrder(win).join(' < '));
  const overUi = await captureWindow('banner-over-control-ui');
  if (overUi.image) {
    const bar = overUi.image.getSize();
    check('the composited window is the size of the window',
      Math.abs(bar.width - win.getContentSize()[0] * overUi.scale) <= 2,
      `${bar.width} at scale ${overUi.scale}`);
    check('and the banner is drawn in it', coloursInBand(overUi.image, 10 * overUi.scale, bannerHeight * overUi.scale).has(stripe),
      `${overUi.file} stripe=${stripe}`);
  }

  // The case that actually overlaps: Settings is a full-window sheet, and a
  // notice raised while it is open used to be drawn behind it.
  const settingsItem = menuItem('Settings…');
  check('the Settings menu item exists', Boolean(settingsItem), 'no menu item labelled "Settings…"');
  const settings = settingsItem;
  const aboutItem = menuItem('About Claw Control UI');
  check('the About menu item exists', Boolean(aboutItem), 'no About menu item');

  // The ORDER checks below do not need an image, and they used to sit behind
  // one. macOS gates `desktopCapturer` behind Screen Recording permission, this
  // harness is meant to run unattended, and on the machine it was measured on
  // (2026-09-17) it produced no window at all: every one of those checks was
  // skipped while the file still printed ALL OK. The image is the
  // human-readable half, never the claim, so the claim runs either way and the
  // two shots below are what is skipped when there is no surface to capture.
  if (settings && aboutItem) {
    settings.click();
    await delay(2500);
    check('Settings opened as an overlay', Boolean(settingsPage()), 'no settings.html view');
    let order = stackOrder(win);
    check('the banner is STILL the frontmost view, with Settings open',
      order.at(-1) === 'banner' && order.includes('settings'), order.join(' < '));

    const overSettings = await captureWindow('banner-over-settings');
    if (overSettings.image) {
      // Two readings of one pair of images, and together they mean "the banner is
      // drawn over the sheet":
      //
      //   the banner's band is IDENTICAL to the shot with no sheet, because what
      //   is painted there is the banner either way, and a sheet drawn over it
      //   would have changed those pixels;
      //   the band BELOW the banner differs, so the sheet is genuinely up and the
      //   identical band above is not because nothing happened.
      const bandAbove = coloursInBand(overSettings.image, 10 * overSettings.scale, bannerHeight * overSettings.scale);
      const bandBelow = coloursInBand(overSettings.image, (bannerHeight + 30) * overSettings.scale, (bannerHeight + 90) * overSettings.scale);
      const bandBelowNoSheet = coloursInBand(overUi.image, (bannerHeight + 30) * overUi.scale, (bannerHeight + 90) * overUi.scale);
      check('the banner drew over the Settings surface, not under it',
        bandAbove.has(stripe), `${overSettings.file} stripe=${stripe}`);
      check('and the Settings surface is what changed underneath it',
        differs(bandBelow, bandBelowNoSheet), 'the shot below the banner is unchanged, so nothing was drawn there');
    }

    // A notice raised WHILE the overlays are open, through the real path: the
    // About page's own Check for updates button, over Settings. This is the case
    // the report was about, and it is also where the update answer has to land.
    aboutItem.click();
    await delay(2500);
    check('About opened over Settings', Boolean(aboutPage()), 'no about.html view');
    order = stackOrder(win);
    check('the banner is still frontmost with Settings and About open',
      order.at(-1) === 'banner' && order.includes('settings') && order.includes('about'), order.join(' < '));

    const about = aboutPage();
    await about.executeJavaScript("document.getElementById('check').click()");
    await delay(1500);
    const text = ((await bannerCounts(bannerWc, 'document.body.innerText')) || '').replace(/\s*\n+\s*/g, ' | ').trim();
    check('pressing Check for updates puts an answer on the banner', /Updates are not available in this build/i.test(text), text);
    const button = await about.executeJavaScript("(() => { const b = document.getElementById('check'); return { label: b.textContent, disabled: b.disabled }; })()");
    check('and the About button stops saying "Checking…" and takes presses again',
      button.label === 'Check for updates' && button.disabled === false, `the button reads ${JSON.stringify(button)}`);
    await captureWindow('banner-over-about');

    // The card's own dismissal, which has to stay reachable while all of this is
    // open: the X is inside the banner's view and the view is on top, so a click
    // there belongs to the banner and not to the sheet under it.
    const before = await bannerCounts(bannerWc, 'document.querySelectorAll(".banner").length');
    press(bannerWc, 'document.querySelector(".banner__close").click()');
    await delay(700);
    const after = await bannerCounts(bannerWc, 'document.querySelectorAll(".banner").length');
    check('the dismiss X on a card still works with the overlays open',
      before !== null && (after === null || after === before - 1), `cards ${before} -> ${after}`);
    check('and the surfaces underneath are untouched',
      Boolean(settingsPage()) && Boolean(aboutPage()), 'dismissing a notice closed a surface');

    // The sweep: Mark all read takes the bar down without clearing a condition.
    if (banner()) {
      press(banner(), 'document.querySelector(".banner__readall").click()');
      await delay(900);
      check('Mark all read takes the bar down', !banner(), 'the banner view is still there');
      check('while Settings and About are still open', Boolean(settingsPage()) && Boolean(aboutPage()),
        'the sweep closed something it should not have');
    }
  } else {
    note('the overlay steps', settings && aboutItem
      ? 'skipped: the Settings or About menu item is missing'
      : 'skipped: no menu items to open');
  }

  console.log(failed ? 'FAILED' : 'ALL OK');
  server.close();
  app.exit(failed ? 1 : 0);
});

/** Whether two colour sets differ, for the "did anything change there" check. */
function differs(a, b) {
  if (a.size !== b.size) return true;
  for (const colour of a) if (!b.has(colour)) return true;
  return false;
}
