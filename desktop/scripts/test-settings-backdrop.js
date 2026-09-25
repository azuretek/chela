// The dim behind Settings and About, measured on the composited window.
//
//   npx electron scripts/test-settings-backdrop.js [--appearance dark|light] [--shots DIR]
//
// WHY THIS EXISTS. Reported 2026-09-25: "right now the control ui sort of
// flickers into the background color as the settings/about us pages slide up".
// Each sheet is a transparent view of ours over the Control UI, but its page
// painted html and body with the page colour, so the moment the view attached
// the interface was replaced by a flat sheet of --bg, in the fallback palette for
// the first frames until the live theme arrived. Its scrim was the page colour at
// 70% as well. Measured on a macOS desktop, this harness's own frames: the column
// went from the interface straight to the light fallback and then to the dark
// page colour, and never showed through again while the sheet was up.
//
// The dim is now the Control UI's own mobile nav drawer backdrop, black at 44%,
// so the interface stays visible and darkens the way it does when its own drawer
// opens (core/ui/ui.css, --scrim; the stylesheet guard is core/test/backdrop.test.js).
//
// WHAT IS MEASURED. A stub gateway page paints a column of one known colour down
// its left edge, inside the scrim's own padding where no card ever sits. Every
// frame of the window is sampled there, through each transition:
//
//   1. At rest under Settings the column reads the drawer dim over the column's
//      colour, and not the page colour mixed in.
//   2. Through the arrival and the departure every frame lies on the straight line
//      from the bare column to the dimmed one: the backdrop only darkens and
//      lightens, and never moves toward another colour, which is what the wash
//      did and what a first paint of the wrong colour would do.
//   3. About over Settings leaves the one dim, not two.
//   4. Closing both gives the bare column back.
//
// The page-as-window case (a first run, nothing behind) is not here: it keeps its
// opaque page colour by design, which the stylesheet guard holds.
//
// Needs a display: on Linux run it under xvfb-run, and on macOS a signed-in
// screen with the Screen Recording grant. Refuses to pass on a capture it cannot
// read, rather than reporting a dim it never saw.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const flag = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const APPEARANCE = flag('appearance', 'dark');
if (!['light', 'dark'].includes(APPEARANCE)) throw new Error('unknown appearance ' + APPEARANCE);
const SHOTS = flag('shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const NEWLINE = String.fromCharCode(10);

/** The column's colour, chosen to be far from both palettes' page colour. */
const COLUMN = [255, 92, 92];
/** The drawer backdrop's alpha (upstream .shell-nav-backdrop, rgb(0 0 0 / 44%)). */
const DIM_ALPHA = 0.44;
const DIMMED = COLUMN.map((c) => Math.round(c * (1 - DIM_ALPHA)));
/** How far a sample may sit from where it should be, per channel, for encoding noise. */
const TOLERANCE = 8;

const PALETTE = {
  dark: { '--bg': '#0b0d12', '--card': '#161920', '--text': '#e8eef4', '--accent': '#ff5c5c' },
  light: { '--bg': '#faf9f5', '--card': '#ffffff', '--text': '#1b1b18', '--accent': '#d33d3d' },
}[APPEARANCE];

const PORT = 19231;
const ADDRESS = 'http://127.0.0.1:' + PORT + '/';
const PAGE = [
  '<!doctype html>',
  '<html data-openclaw-control-ui-build-id="stub-1" data-theme="' + (APPEARANCE === 'light' ? 'light' : 'dark') + '" data-theme-mode="' + APPEARANCE + '">',
  '<head><meta charset="utf-8"><title>Stub Control UI</title>',
  '<style>',
  '  :root { color-scheme: ' + APPEARANCE + '; ' + Object.entries(PALETTE).map(([n, v]) => n + ': ' + v + ';').join(' ') + ' }',
  '  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 14px system-ui; }',
  '  #column { position: fixed; left: 0; top: 0; bottom: 0; width: 160px; background: rgb(' + COLUMN.join(' ') + '); }',
  '  main { margin-left: 180px; padding: 24px; }',
  '</style></head>',
  '<body><div id="column"></div><main><h1>Stub Control UI</h1><p>The interface behind the sheet.</p></main></body>',
  '</html>',
].join(NEWLINE);

const { app, BrowserWindow, Menu, desktopCapturer, screen, webContents } = await import('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-backdrop-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end(PAGE);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

fs.writeFileSync(path.join(PROFILE, 'config.json'), JSON.stringify({
  gateways: [{ id: 'gw-stub', label: 'Stub gateway', url: ADDRESS }],
  activeGatewayId: 'gw-stub',
  themeByGateway: {},
}, null, 2) + NEWLINE);

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function check(name, ok, detail) {
  if (ok) console.log('OK   ' + APPEARANCE + ': ' + name);
  else { console.error('FAIL ' + APPEARANCE + ': ' + name + ': ' + detail); failed = true; }
}
const WATCHDOG_MS = 120000;
const watchdog = setTimeout(() => {
  console.error('FAIL harness: still running after ' + (WATCHDOG_MS / 1000) + 's');
  app.exit(1);
}, WATCHDOG_MS);

const view = (match) => webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes(match)) || null;

function menuItem(test, items = Menu.getApplicationMenu()?.items || []) {
  for (const item of items) {
    if (test(item.label || '')) return item;
    const found = item.submenu && menuItem(test, item.submenu.items);
    if (found) return found;
  }
  return null;
}

/* ------------------------------------------------------------------ capture */

/** Channel order of the capture's bitmap, settled against the bare column. */
let order = [2, 1, 0];

/** Said once: which capture route this run is on, and what the capturer offered. */
let routeNoted = false;

/**
 * One frame of the composited window: only the OS compositor sees the child views.
 *
 * The window's own source first. Where the platform does not list the window by
 * its media id (an X server under xvfb names it differently), the screen it is on
 * is captured instead and cropped to the window's content, which is the same
 * composited pixels.
 */
async function frame() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return null;
  const [width, height] = win.getContentSize();
  // Bounded: a session with no screen to capture (a Mac at its login window, a
  // display server that is not there) can leave this call unanswered, and a
  // harness that hangs is one nobody reads. A refusal ("Failed to get sources")
  // is the same answer: no frame.
  const ask = (types, size) => Promise.race([
    desktopCapturer.getSources({ types, thumbnailSize: size }).catch(() => []),
    delay(5000).then(() => []),
  ]);
  const windows = await ask(['window'], { width, height });
  const mine = windows.find((s) => s.id === win.getMediaSourceId())
    || windows.find((s) => s.name === win.getTitle());
  if (mine && !mine.thumbnail.isEmpty()) {
    if (!routeNoted) { routeNoted = true; console.log('note capturing the window source ' + JSON.stringify(mine.name)); }
    return mine.thumbnail;
  }
  const display = screen.getDisplayMatching(win.getBounds());
  const { width: sw, height: sh } = display.size;
  const screens = await ask(['screen'], { width: sw, height: sh });
  const shot = screens.find((s) => String(s.display_id) === String(display.id)) || (screens.length === 1 ? screens[0] : null);
  if (!routeNoted) {
    routeNoted = true;
    console.log('note no window source matched (' + windows.length + ' offered: ' + JSON.stringify(windows.map((s) => s.name).slice(0, 6))
      + '), so capturing the screen and cropping to the window: ' + (shot ? 'screen ' + JSON.stringify(shot.name) : 'no screen either'));
  }
  if (!shot || shot.thumbnail.isEmpty()) return null;
  const content = win.getContentBounds();
  const scale = shot.thumbnail.getSize().width / sw;
  return shot.thumbnail.crop({
    x: Math.round((content.x - display.bounds.x) * scale),
    y: Math.round((content.y - display.bounds.y) * scale),
    width: Math.round(content.width * scale),
    height: Math.round(content.height * scale),
  });
}

/** The mean colour of a small block inside the column, below any drag band. */
function sample(image) {
  const { width, height } = image.getSize();
  const scale = width / BrowserWindow.getAllWindows()[0].getContentSize()[0];
  const x = Math.round(8 * scale);
  const y = Math.round(height * 0.6);
  const side = Math.max(2, Math.round(4 * scale));
  const bytes = image.crop({ x, y, width: side, height: side }).toBitmap();
  const sum = [0, 0, 0];
  const n = bytes.length / 4;
  for (let i = 0; i < bytes.length; i += 4) for (let c = 0; c < 3; c += 1) sum[c] += bytes[i + order[c]];
  return sum.map((s) => Math.round(s / n));
}

const far = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** How far a colour sits from the straight line between two others, per channel. */
function offLine(p, from, to) {
  const d = to.map((v, i) => v - from[i]);
  const len2 = d.reduce((s, v) => s + v * v, 0);
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, p.reduce((s, v, i) => s + (v - from[i]) * d[i], 0) / len2));
  return far(p, from.map((v, i) => v + t * d[i]));
}

/**
 * Whether one of our pages is up, loaded and done moving: the page's own answer,
 * so the harness never guesses how long a load or an animation takes.
 */
async function settledPage(file) {
  const wc = view(file);
  if (!wc) return false;
  try {
    return await wc.executeJavaScript(
      'document.readyState === "complete" && !document.documentElement.classList.contains("surface--pending")'
      + ' && document.getAnimations().every((a) => a.playState !== "running")',
    );
  } catch { return false; }
}
const gone = (file) => async () => !view(file);

/**
 * Frames spanning an action, sampled in the column, until the action's end state
 * holds (bounded, so a page that never settles is a failure rather than a hang),
 * and a little past it.
 */
async function through(name, act, done) {
  const frames = [];
  let stop = false;
  const started = Date.now();
  const capturer = async () => {
    while (!stop) {
      const image = await frame();
      if (image) frames.push({ at: Date.now() - started, rgb: sample(image), image });
    }
  };
  const runs = [capturer(), capturer()];
  await delay(60);
  const actedAt = Date.now() - started;
  await act();
  const deadline = Date.now() + 10000;
  while (!(await done()) && Date.now() < deadline) await delay(40);
  await delay(300);
  stop = true;
  await Promise.all(runs);
  frames.sort((a, b) => a.at - b.at);
  for (const f of frames) f.rel = f.at - actedAt;
  if (SHOTS) {
    frames.forEach((f, i) => fs.writeFileSync(path.join(SHOTS, name + '-' + String(i).padStart(3, '0') + '-' + f.rel + 'ms.png'), f.image.resize({ width: 480 }).toPNG()));
  }
  console.log('note ' + name + ': ' + frames.map((f) => f.rel + 'ms rgb(' + f.rgb.join(' ') + ')').join(', '));
  return frames;
}

/**
 * The window at rest: captured until three frames in a row agree, because a page
 * that says it has settled can still be a frame or two from the screen on a slow
 * machine, and a reading taken in between measures neither state.
 */
async function still(name, until = () => true) {
  const deadline = Date.now() + 15000;
  let last = null;
  let agree = 0;
  let image = null;
  while (Date.now() < deadline) {
    image = await frame();
    if (!image) return null;
    const rgb = sample(image);
    agree = last && far(rgb, last) <= 2 ? agree + 1 : 0;
    last = rgb;
    if (agree >= 2 && until(rgb)) break;
    await delay(60);
  }
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, name + '.png'), image.toPNG());
  return last;
}

/** Enough frames inside a transition to say how it moved, rather than only where it ended. */
const MIN_FRAMES_FOR_MOTION = 6;

/** Leave a surface the way the reader does, with Escape. */
const escape = (wc) => wc.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");

function finish() {
  clearTimeout(watchdog);
  server.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(async () => {
  const deadline = Date.now() + 30000;
  while (!view(String(PORT)) && Date.now() < deadline) await delay(250);
  await delay(3000);
  const gateway = view(String(PORT));
  check('the stub gateway page is on screen', Boolean(gateway), 'no view at the stub address');
  if (!gateway) { finish(); return; }

  const probe = await frame();
  check('the window can be captured', Boolean(probe), 'desktopCapturer returned nothing for this window, so no claim can be made');
  if (!probe) { finish(); return; }
  // Settle the bitmap's channel order against the known column rather than assume it.
  const asIs = sample(probe);
  order = [0, 1, 2];
  const swapped = sample(probe);
  order = far(asIs, COLUMN) <= far(swapped, COLUMN) ? [2, 1, 0] : [0, 1, 2];
  // The gateway page's own first paint can trail its load on a slow machine.
  const bare = await still('backdrop-bare', (rgb) => far(rgb, COLUMN) <= TOLERANCE);
  console.log('note bare column rgb(' + bare.join(' ') + '), the dim should read rgb(' + DIMMED.join(' ') + ')');
  check('the capture reads the bare column', far(bare, COLUMN) <= TOLERANCE,
    'the column reads rgb(' + bare.join(' ') + ') where the page paints rgb(' + COLUMN.join(' ') + ')');

  /* --------------------------------------------------------- Settings arrives */
  const settingsItem = menuItem((label) => label === 'Settings\u2026');
  check('Settings can be opened from the menu', Boolean(settingsItem), 'no "Settings\u2026" menu item');
  if (!settingsItem) { finish(); return; }
  const arrival = await through('backdrop-settings-arrival', () => settingsItem.click(), () => settledPage('settings.html'));
  // Waited for until the sheet shows at all: a page that reports itself settled
  // can still be a frame from the screen.
  const underSettings = await still('backdrop-settings', (rgb) => far(rgb, bare) > TOLERANCE);
  check('under Settings the interface is dimmed, not washed into the page colour',
    far(underSettings, DIMMED) <= TOLERANCE,
    'the column reads rgb(' + underSettings.join(' ') + '); the drawer dim over it is rgb(' + DIMMED.join(' ') + ')');
  const strayIn = arrival.filter((f) => offLine(f.rgb, bare, DIMMED) > TOLERANCE);
  check('every frame of the arrival only darkens the interface toward the dim', strayIn.length === 0,
    strayIn.slice(0, 4).map((f) => f.rel + 'ms rgb(' + f.rgb.join(' ') + ')').join(', ') + ' left the line from the bare interface to the dim');
  const between = arrival.filter((f) => far(f.rgb, bare) > TOLERANCE && far(f.rgb, DIMMED) > TOLERANCE);
  const moving = arrival.filter((f) => f.rel >= 0 && f.rel <= 1500);
  // Reported, not asserted. The dim runs on the sheet's own animation, so it
  // moves with the slide by construction (core/test/motion.test.js holds the
  // pairing). How much of that animation reaches the screen is the compositor's
  // timing: a view whose page animates before its first frame is composited (a
  // loaded hosted runner does this) shows the end of the fade and not its start,
  // and the slide the same way, which scripts/test-surface-motion.js already
  // records for the arrival. A capturer this slow (a whole-screen grab under xvfb
  // is seconds a frame) cannot see a 500ms fade at all.
  console.log('note ' + between.length + ' of ' + moving.length + ' frames in the first 1.5s caught the dim part way'
    + (moving.length < MIN_FRAMES_FOR_MOTION ? ', too few frames to see a fade either way' : ''));

  /* ------------------------------------------------------ About over Settings */
  const aboutItem = menuItem((label) => /^About\b/.test(label));
  check('About can be opened from the menu', Boolean(aboutItem), 'no About menu item');
  if (aboutItem) {
    const stacking = await through('backdrop-about-arrival', () => aboutItem.click(), () => settledPage('about.html'));
    const underBoth = await still('backdrop-about-over-settings');
    check('About over Settings keeps ONE dim', far(underBoth, DIMMED) <= TOLERANCE,
      'the column reads rgb(' + underBoth.join(' ') + '); one dim is rgb(' + DIMMED.join(' ') + ') and two are rgb('
      + DIMMED.map((c) => Math.round(c * (1 - DIM_ALPHA))).join(' ') + ')');
    const strayStack = stacking.filter((f) => far(f.rgb, DIMMED) > TOLERANCE);
    check('the backdrop holds still while About rises over Settings', strayStack.length === 0,
      strayStack.slice(0, 4).map((f) => f.rel + 'ms rgb(' + f.rgb.join(' ') + ')').join(', '));
    const about = view('about.html');
    if (about) {
      await through('backdrop-about-departure', () => escape(about), gone('about.html'));
      const afterAbout = await still('backdrop-after-about');
      check('closing About leaves Settings dimming the interface', far(afterAbout, DIMMED) <= TOLERANCE,
        'the column reads rgb(' + afterAbout.join(' ') + ')');
    }
  }

  /* ---------------------------------------------------------- Settings leaves */
  const settings = view('settings.html');
  check('the Settings surface is up to close', Boolean(settings), 'no settings view');
  if (settings) {
    const departure = await through('backdrop-settings-departure', () => escape(settings), gone('settings.html'));
    const after = await still('backdrop-closed', (rgb) => far(rgb, bare) <= TOLERANCE);
    check('closing Settings gives the interface back undimmed', far(after, bare) <= TOLERANCE,
      'the column reads rgb(' + after.join(' ') + ') where it read rgb(' + bare.join(' ') + ')');
    const strayOut = departure.filter((f) => offLine(f.rgb, bare, DIMMED) > TOLERANCE);
    check('every frame of the departure only lightens the interface back', strayOut.length === 0,
      strayOut.slice(0, 4).map((f) => f.rel + 'ms rgb(' + f.rgb.join(' ') + ')').join(', '));
  }
  finish();
});
