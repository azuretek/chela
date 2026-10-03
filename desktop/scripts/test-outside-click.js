// A click on the dim around Settings or About closes it; a click on the sheet never does.
//
//   npx electron scripts/test-outside-click.js [--shots DIR]
//
// WHY THIS EXISTS. Reported 2026-10-02 (#141): with Settings or About open, the
// area around the sheet is dimmed and blurred, and clicking it did nothing. It
// should close the sheet and return to the app exactly as "Back to app" and
// Escape do, and a click inside the sheet must never close it.
//
// WHAT IS DRIVEN. Real input, not a synthetic DOM event: the clicks are
// delivered to each sheet's view with webContents.sendInputEvent, so they go
// through the renderer's own hit testing, the way a person's mouse does. Each
// sheet is opened from the app's own menu over a stub Control UI, then:
//
//   1. a click on the sheet itself (its header, away from any control) leaves
//      the sheet up;
//   2. a press that starts on the sheet and is released on the dim (a text
//      selection dragged out) leaves it up;
//   3. a click on the dim beside the sheet takes it down, through the same
//      close that "Back to app" and Escape use;
//   4. with About over Settings, a click on the dim takes About down and leaves
//      Settings up, which is where About's own way back lands, and a second
//      click takes Settings down too.
//
// Needs a display: on Linux run it under xvfb-run.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const flag = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const SHOTS = flag('shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const NEWLINE = String.fromCharCode(10);

const PORT = 19241;
const ADDRESS = 'http://127.0.0.1:' + PORT + '/';
const PAGE = [
  '<!doctype html>',
  '<html data-openclaw-control-ui-build-id="stub-1" data-theme="dark" data-theme-mode="dark">',
  '<head><meta charset="utf-8"><title>Stub Control UI</title>',
  '<style>html, body { margin: 0; height: 100%; background: #0b0d12; color: #e8eef4; font: 14px system-ui; }</style>',
  '</head><body><main><h1>Stub Control UI</h1><p>The interface behind the sheet.</p></main></body>',
  '</html>',
].join(NEWLINE);

const { app, Menu, webContents } = await import('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-outside-click-'));
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
  if (ok) console.log('OK   ' + name);
  else { console.error('FAIL ' + name + ': ' + detail); failed = true; }
}
const WATCHDOG_MS = 90000;
setTimeout(() => {
  console.error('FAIL harness: still running after ' + (WATCHDOG_MS / 1000) + 's');
  app.exit(1);
}, WATCHDOG_MS).unref();

const view = (match) => webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes(match)) || null;

// A read on a view that is being torn down can neither resolve nor reject
// (test-settings-as-page-escape.js measured it), so every read is on a clock.
const ask = (wc, script, ms = 2000) => Promise.race([
  wc.executeJavaScript(script, true).catch(() => null),
  delay(ms).then(() => null),
]);

function menuItem(test, items = Menu.getApplicationMenu()?.items || []) {
  for (const item of items) {
    if (test(item.label || '')) return item;
    const found = item.submenu && menuItem(test, item.submenu.items);
    if (found) return found;
  }
  return null;
}

async function until(test, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await test()) return true;
    await delay(100);
  }
  return false;
}

/** The sheet is up and its arrival has finished, so a click lands on what is drawn. */
async function settled(match) {
  return until(async () => {
    const wc = view(match);
    if (!wc || wc.isLoading()) return false;
    // Held arrivals are PAUSED rather than running (surface.js holds them for the
    // first paint), so only finished ones count, and the card must be on screen.
    const ready = await ask(wc, "(() => { const m = document.querySelector('.modal'); if (!m || document.documentElement.classList.contains('surface--pending')) return false; const r = m.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1 && document.getAnimations().every((a) => a.playState === 'finished'); })()");
    return ready === true;
  }, 15000);
}

/** Where to click: a point on the dim beside the card, and one on the card's header. */
async function targets(wc) {
  return ask(wc, `(() => {
    const modal = document.querySelector('.modal');
    const header = modal.querySelector('.modal__header') || modal;
    const m = modal.getBoundingClientRect();
    const h = header.getBoundingClientRect();
    const dragbar = document.querySelector('.dragbar');
    const below = dragbar ? dragbar.getBoundingClientRect().bottom : 0;
    // The dim to the left of the card, halfway down, clear of the drag band.
    const outside = { x: Math.max(4, Math.round(m.left / 2)), y: Math.round(Math.max(below + 8, (m.top + m.bottom) / 2)) };
    // A point on the header that is not on any control.
    let inside = null;
    const y = Math.round(h.top + h.height / 2);
    for (let x = Math.round(h.left + h.width / 2); x < h.right - 4 && !inside; x += 8) {
      const hit = document.elementFromPoint(x, y);
      if (hit && modal.contains(hit) && !hit.closest('button, a, input, select, textarea, [role=tab]')) inside = { x, y };
    }
    const hitOutside = document.elementFromPoint(outside.x, outside.y);
    return { outside, inside, outsideHit: hitOutside ? (hitOutside.id || hitOutside.className) : null, outsideIsScrim: hitOutside === document.getElementById('scrim'), width: innerWidth, card: [m.left, m.right] };
  })()`);
}

function press(wc, type, point) {
  wc.sendInputEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
}
async function click(wc, point) {
  wc.focus();
  press(wc, 'mouseMove', point);
  press(wc, 'mouseDown', point);
  await delay(40);
  press(wc, 'mouseUp', point);
}

async function shoot(wc, name) {
  if (!SHOTS || !wc) return;
  try {
    const shot = await Promise.race([wc.capturePage(), delay(4000).then(() => { throw new Error('no shot'); })]);
    fs.writeFileSync(path.join(SHOTS, name), shot.toPNG());
  } catch { /* evidence, not the check */ }
}

async function exercise(label, open, file) {
  const item = menuItem(open);
  check(label + ' can be opened from the menu', Boolean(item), 'no menu item');
  if (!item) return;
  item.click();
  check(label + ' arrives', await settled(file), file + ' never settled');
  const wc = view(file);
  if (!wc) return;
  const t = await targets(wc);
  console.log('note ' + label + ' targets ' + JSON.stringify(t));
  check(label + ': there is dim beside the card to click', Boolean(t && t.card[0] > 8),
    'targets ' + JSON.stringify(t));
  check(label + ': there is a spot on the card with no control', Boolean(t && t.inside), 'targets ' + JSON.stringify(t));
  if (!t || !t.inside) return;
  await shoot(wc, 'outside-click-' + label.toLowerCase() + '-up.png');

  await click(wc, t.inside);
  await delay(800);
  check(label + ': a click on the sheet leaves it up', Boolean(view(file)), 'the sheet closed');

  wc.focus();
  press(wc, 'mouseMove', t.inside);
  press(wc, 'mouseDown', t.inside);
  await delay(40);
  press(wc, 'mouseMove', t.outside);
  press(wc, 'mouseUp', t.outside);
  await delay(800);
  check(label + ': a press on the sheet released on the dim leaves it up', Boolean(view(file)), 'the sheet closed');

  await click(wc, t.outside);
  const gone = await until(async () => !view(file), 5000);
  check(label + ': a click on the dim closes it', gone, file + ' still up 5s after the click');
}

/** About over Settings: one click on the dim goes back one surface. */
async function stacked() {
  menuItem((label) => label === 'Settings\u2026')?.click();
  if (!(await settled('settings.html'))) { check('About over Settings: Settings arrives', false, 'never settled'); return; }
  menuItem((label) => /^About\b/.test(label))?.click();
  if (!(await settled('about.html'))) { check('About over Settings: About arrives', false, 'never settled'); return; }
  const about = view('about.html');
  const t = await targets(about);
  await click(about, t.outside);
  const aboutGone = await until(async () => !view('about.html'), 5000);
  check('About over Settings: a click on the dim takes About down', aboutGone, 'about.html still up 5s after the click');
  await delay(1200);
  check('About over Settings: and leaves Settings up', Boolean(view('settings.html')), 'Settings closed with About');
  const settings = view('settings.html');
  if (!settings || !(await settled('settings.html'))) return;
  const s = await targets(settings);
  await click(settings, s.outside);
  check('About over Settings: a second click on the dim takes Settings down',
    await until(async () => !view('settings.html'), 5000), 'settings.html still up 5s after the click');
}

app.whenReady().then(async () => {
  await until(async () => Boolean(view(ADDRESS)) && !view(ADDRESS).isLoading(), 20000);
  await delay(1500);
  await exercise('Settings', (label) => label === 'Settings\u2026', 'settings.html');
  await exercise('About', (label) => /^About\b/.test(label), 'about.html');
  await stacked();
  server.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  console.log(failed ? 'outside-click: FAILED' : 'outside-click: all checks passed');
  app.exit(failed ? 1 : 0);
});
