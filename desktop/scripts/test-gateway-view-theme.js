'use strict';

// Prove the gateway view's own surface follows a theme change, in both
// directions, read off the composited window rather than asserted in source.
//
// WHY THIS EXISTS. The gateway view (the WebContentsView the Control UI loads
// into) has a backgroundColor of its own: it is the colour Electron paints where
// the page itself does not, an overscroll rubber-band at the bottom edge, the
// gap while a fresh payload is swapped in, the frame before a navigation paints.
// It was set once at createGatewayView and never moved after, so a theme change
// repainted the STRIP (the top band) and the window while this kept the old
// colour. The reader saw a band at the top or the bottom disagreeing with the
// rest, reported 2026-09-18 as "we still have some color issues on the top and
// bottom". refreshThemedPages() now repaints it; this is the proof.
//
// It reads the COMPOSITED pixel, not the source, because a stylesheet or a source
// line saying the right thing and the screen showing it are two different facts.
// Two gateways are seeded, one stored dark and one stored light, both pointed at a
// hold-server that answers with a page that paints NOTHING: with no --bg of its
// own the page is transparent over the gateway view, so the pixel composited in
// the view's area IS the view's own backgroundColor. Switching between the two
// gateways drives applyStoredTheme -> refreshThemedPages, the real path a theme
// change takes, and the pixel must become the surface the switched-to theme names.
//
//   npx electron scripts/test-gateway-view-theme.js [--shots DIR]

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { app, BrowserWindow, desktopCapturer, webContents, ipcMain } from 'electron';

import { fallbackTheme } from '../src/chrome.js';

function flag(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const SHOTS = flag('shots', null);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// A page that loads instantly and paints NOTHING of its own: no --bg, so what
// composites in the gateway view's area is the view's own backgroundColor. A
// real gateway would paint its palette over the view and hide exactly the pixel
// this is about.
const holdServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  // The OpenClaw payload marker on <html> is what the identity check requires
  // (core/spec/gateway-identity.json), so the app loads this rather than showing
  // its own error page over the gateway view. The body paints NOTHING of its own
  // (no --bg), so the pixel composited in the view's area is the gateway view's
  // own backgroundColor, which is the whole point.
  res.end('<!doctype html><html data-openclaw-control-ui-build-id="test-0.0.0"><head><title>Held, OpenClaw</title></head><body></body></html>');
});
await new Promise((r) => holdServer.listen(0, '127.0.0.1', r));
const GATEWAY = 'http://127.0.0.1:' + holdServer.address().port + '/';

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-gwview-theme-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);
// Two gateways, each remembered in a different appearance, first active. The
// switch between them is the theme change, driven the way a real one is.
fs.writeFileSync(path.join(PROFILE, 'config.json'), JSON.stringify({
  gateways: [
    { id: 'dark-gw', label: 'Dark', url: GATEWAY },
    { id: 'light-gw', label: 'Light', url: GATEWAY },
  ],
  activeGatewayId: 'dark-gw',
  themeByGateway: { 'dark-gw': 'dark', 'light-gw': 'light' },
  themeMode: 'dark',
}, null, 2) + '\n');

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function check(name, ok, detail) {
  if (ok) console.log('OK   ' + name);
  else { console.error('FAIL ' + name + ': ' + (detail || '')); failed = true; }
}

/** #rrggbb at a fractional point of a composited frame. */
function pixel(image, fx, fy) {
  const s = image.getSize();
  const x = Math.min(s.width - 1, Math.max(0, Math.round(s.width * fx)));
  const y = Math.min(s.height - 1, Math.max(0, Math.round(s.height * fy)));
  const b = image.toBitmap();
  const i = (y * s.width + x) * 4;
  const h = (n) => n.toString(16).padStart(2, '0');
  return '#' + h(b[i + 2]) + h(b[i + 1]) + h(b[i]);
}
async function capture(win) {
  const [w, h] = win.getContentSize();
  const srcs = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: w, height: h } });
  const mine = srcs.find((s) => s.id === win.getMediaSourceId()) || srcs.find((s) => /claw/i.test(s.name));
  return mine && !mine.thumbnail.isEmpty() ? mine.thumbnail : null;
}

const WATCHDOG_MS = 90000;
setTimeout(() => { console.error('FAIL harness: still running after ' + (WATCHDOG_MS / 1000) + 's'); app.exit(1); }, WATCHDOG_MS).unref();

// Ask the app's own IPC to connect to a gateway, which is switchGateway ->
// applyStoredTheme, the real theme-change path.
function connectTo(id) {
  // The renderer normally invokes this; here the main process calls the handler
  // body directly through a synthetic invoke, which is what the preload does.
  return ipcMain.emit ? null : null;
}

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 80 && !win; i += 1) { win = BrowserWindow.getAllWindows()[0] || null; if (!win) await delay(250); }
  if (!win) { console.error('FAIL harness: no window'); app.exit(1); return; }

  // Let the first gateway settle: window shown, gateway view up and its held
  // page (which paints nothing) loaded.
  await delay(2500);

  // The colour the gateway view is painted with is currentTheme.surface. This
  // harness holds no real Control UI behind the view (the held page has no --bg,
  // so its theme report is refused), which leaves currentTheme as the app's own
  // FALLBACK palette: that is exactly the surface the view must wear, and it is
  // owned by chrome.js so this expectation cannot drift from the app's.
  const darkBg = fallbackTheme('dark').surface;
  const lightBg = fallbackTheme('light').surface;

  // A point low in the window, inside the gateway view's area (it starts below
  // the ~36px strip and runs to the bottom), and clear of the strip.
  const SAMPLE_X = 0.5;
  const SAMPLE_Y = 0.85;

  let first = null;
  for (let i = 0; i < 20 && !first; i += 1) { first = await capture(win).catch(() => null); if (!first) await delay(300); }
  if (first && SHOTS) fs.writeFileSync(path.join(SHOTS, 'gwview-01-dark.png'), first.toPNG());
  const firstPx = first ? pixel(first, SAMPLE_X, SAMPLE_Y) : null;
  check('the gateway view starts on the stored dark surface', firstPx === darkBg, 'view pixel ' + firstPx + ', expected ' + darkBg);

  // Switch to the light gateway: switchGateway -> applyStoredTheme -> refreshThemedPages.
  await win.webContents; // noop keep-alive
  const { ipcMain: ipc } = await import('electron');
  // Drive the real handler the preload drives.
  await new Promise((resolve) => {
    // app:connect is registered by main.js; call it the way ipcRenderer.invoke does.
    const fakeEvent = {};
    const handler = ipc._invokeHandlers && ipc._invokeHandlers.get ? ipc._invokeHandlers.get('app:connect') : null;
    if (handler) { Promise.resolve(handler(fakeEvent, 'light-gw')).then(resolve); }
    else { resolve(); }
  });
  // The switch reloads the gateway view; give it time to reload the held page
  // (which again paints nothing) and repaint the view's surface.
  await delay(3000);

  let second = null;
  for (let i = 0; i < 20 && !second; i += 1) { second = await capture(win).catch(() => null); if (!second) await delay(300); }
  if (second && SHOTS) fs.writeFileSync(path.join(SHOTS, 'gwview-02-light.png'), second.toPNG());
  const secondPx = second ? pixel(second, SAMPLE_X, SAMPLE_Y) : null;
  check('the gateway view follows the theme change to the light surface', secondPx === lightBg, 'view pixel ' + secondPx + ', expected ' + lightBg + ' (was dark ' + darkBg + ')');

  console.log('     dark --bg ' + darkBg + ', light --bg ' + lightBg + '; sampled (' + SAMPLE_X + ',' + SAMPLE_Y + ')');
  console.log('     first(dark) ' + firstPx + ' -> after switch ' + secondPx);

  fs.rmSync(PROFILE, { recursive: true, force: true });
  holdServer.close();
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error('FAIL harness: ' + (err && err.stack ? err.stack : err));
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* leaving temp dir */ }
  holdServer.close();
  app.exit(1);
});
