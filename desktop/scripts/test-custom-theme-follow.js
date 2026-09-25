// The custom theme reaching our own surfaces, and the mark.
//
//   npx electron scripts/test-custom-theme-follow.js [--appearance light|dark] [--shots DIR]
//
// WHY THIS EXISTS. Reported 2026-09-25 on a dev build: with a theme imported
// from tweakcn, "our ui elements and the icon dont change, we need to ensure we
// follow even those theme changes".
//
// A custom theme is not a picker setting. Upstream writes it into a STYLE TAG in
// the page head (id "openclaw-custom-theme", syncCustomThemeStyleTag in
// ui/src/app/custom-theme.ts) carrying both appearances:
//
//   :root[data-theme="custom"]       { --accent: ...; --bg: ...; ... }
//   :root[data-theme="custom-light"] { --accent: ...; --bg: ...; ... }
//
// and importing a SECOND custom theme REWRITES that tag's text. The theme
// attribute stays "custom", the mode attribute stays put and the class list
// stays put, so an observer watching the ROOT's attributes receives no event at
// all: the page repaints around us while our own pages keep the previous
// palette, the caption strip keeps the previous window colour and the mark keeps
// the previous accent.
//
// The palettes here are authored in oklch(), which is what a tweakcn theme
// carries, so a reader that only understands "#hex" is caught here too. Every
// claim about a colour is made by RESOLVING it through the engine that painted
// it, a one pixel canvas read-back, rather than by comparing notation: the
// assertion is about the colour a reader sees, not the way it was written.
//
// This harness measures the TRIGGER. Which names may reach our pages at all is
// scripts/test-settings-theme.js's claim, made against a stub of the same shape;
// this one asks only whether a swap that changes no attribute is seen at all.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as appIcons from '../../core/app-icons.js';

const flag = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const APPEARANCE = flag('appearance', 'light');
if (!['light', 'dark'].includes(APPEARANCE)) throw new Error('unknown appearance ' + APPEARANCE);
const SHOTS = flag('shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/** The one newline this file needs, so its own source carries no escape sequences. */
const NEWLINE = String.fromCharCode(10);

/** The style tag upstream manages, and the block inside it that is in force. */
const CUSTOM_STYLE_ID = 'openclaw-custom-theme';
const IN_FORCE = APPEARANCE === 'light' ? 'custom-light' : 'custom';

/** The Control UI's own defaults, so a page the palette never reached is visibly another colour. */
const BASE = { '--bg': '#0b0d12', '--accent': '#ff5c5c', '--card': '#161920', '--text': '#e8eef4' };

/**
 * Two custom themes: the first is already in force when the harness starts, the
 * second is what a further import writes. Their accents are a red and a green, so
 * the mark's bucket has to move between them, and every value is oklch().
 */
const FIRST = {
  dark: { '--bg': 'oklch(0.21 0.02 275)', '--accent': 'oklch(0.63 0.21 22)', '--card': 'oklch(0.27 0.02 275)' },
  light: { '--bg': 'oklch(0.97 0.01 95)', '--accent': 'oklch(0.55 0.19 22)', '--card': 'oklch(1 0 0)' },
};
const SECOND = {
  dark: { '--bg': 'oklch(0.23 0.03 155)', '--accent': 'oklch(0.72 0.17 155)', '--card': 'oklch(0.29 0.03 155)' },
  light: { '--bg': 'oklch(0.96 0.02 155)', '--accent': 'oklch(0.66 0.16 155)', '--card': 'oklch(0.99 0.01 155)' },
};

/** The tag's text for a theme, in upstream's own shape: one block per appearance. */
function customCss(theme) {
  const block = (id, values) => [
    ':root[data-theme="' + id + '"] {',
    ...Object.entries(values).map(([name, value]) => '  ' + name + ': ' + value + ';'),
    '}',
  ].join(NEWLINE);
  return [block('custom', theme.dark), block('custom-light', theme.light)].join(NEWLINE);
}

/**
 * The colour a page actually paints for one custom property: the engine's own
 * answer, and the same colour as the sRGB bytes it draws.
 */
const bytesScript = (name) => '(() => {'
  + '  const probe = document.createElement("span");'
  + '  probe.setAttribute("aria-hidden", "true");'
  + '  probe.style.cssText = "position:fixed;top:-9999px;left:-9999px;height:0;pointer-events:none;";'
  + '  probe.style.color = "var(' + name + ')";'
  + '  document.documentElement.appendChild(probe);'
  + '  const resolved = getComputedStyle(probe).color;'
  + '  probe.remove();'
  + '  const canvas = document.createElement("canvas");'
  + '  canvas.width = 1;'
  + '  canvas.height = 1;'
  + '  const context = canvas.getContext("2d");'
  + '  context.fillStyle = resolved;'
  + '  context.fillRect(0, 0, 1, 1);'
  + '  const data = context.getImageData(0, 0, 1, 1).data;'
  + '  return { resolved: resolved, bytes: [data[0], data[1], data[2], data[3]] };'
  + '})()';

const sameColour = (a, b) => Boolean(a) && Boolean(b) && a.bytes.every((n, i) => n === b.bytes[i]);
const hexOf = (bytes) => '#' + bytes.slice(0, 3).map((n) => n.toString(16).padStart(2, '0')).join('');

const PORT = 19220;
const ADDRESS = 'http://127.0.0.1:' + PORT + '/';

const PAGE = [
  '<!doctype html>',
  '<html data-openclaw-control-ui-build-id="stub-1" data-theme="' + IN_FORCE + '" data-theme-mode="' + APPEARANCE + '">',
  '<head><meta charset="utf-8"><title>Stub Control UI</title>',
  '<style>',
  '  :root { color-scheme: ' + APPEARANCE + '; ' + Object.entries(BASE).map(([name, value]) => name + ': ' + value + ';').join(' ') + ' }',
  '  body { background: var(--bg); color: var(--text); }',
  '</style>',
  '<!-- The custom theme already in force, as a first import leaves the page. -->',
  '<style id="' + CUSTOM_STYLE_ID + '">',
  customCss(FIRST),
  '</style>',
  '</head>',
  '<body>',
  '<h1>Stub Control UI</h1>',
  '<script>',
  '  window.__clawRootAttributeMutations = [];',
  '  window.__claw = {',
  '    // Installed by the harness immediately before the swap, so the record is of',
  '    // the swap alone.',
  '    watch: function () {',
  '      window.__clawRootAttributeMutations = [];',
  '      new MutationObserver(function (records) {',
  '        for (var i = 0; i < records.length; i += 1) {',
  '          window.__clawRootAttributeMutations.push(String(records[i].attributeName));',
  '        }',
  '      }).observe(document.documentElement, { attributes: true });',
  '    },',
  '    tag: function () {',
  '      var tag = document.getElementById("' + CUSTOM_STYLE_ID + '");',
  '      return tag ? tag.textContent : null;',
  '    },',
  '    // A further import, and NOTHING else: same id, same attributes, new text.',
  '    swap: function (css) {',
  '      var tag = document.getElementById("' + CUSTOM_STYLE_ID + '");',
  '      if (!tag) { return -1; }',
  '      tag.textContent = css;',
  '      return tag.textContent.length;',
  '    },',
  '    attributes: function () {',
  '      var root = document.documentElement;',
  '      var out = {};',
  '      for (var i = 0; i < root.attributes.length; i += 1) {',
  '        out[root.attributes[i].name] = root.attributes[i].value;',
  '      }',
  '      return out;',
  '    }',
  '  };',
  '</script>',
  '</body>',
  '</html>',
].join(NEWLINE);

// The app's own log lines, captured rather than printed into the harness's output.
const lines = [];
for (const level of ['log', 'warn']) {
  const original = console[level];
  console[level] = (...args) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    original(...args);
  };
}

const { app, BrowserWindow, Menu, desktopCapturer, webContents, ipcMain } = await import('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-custom-theme-'));
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

/**
 * Every theme report the gateway page sends, which is what the app repaints its
 * own pages and chooses the mark from. Read here rather than inferred from our
 * pages, so a report that never arrived is told apart from one that arrived and
 * was not applied.
 */
const reports = [];
ipcMain.on('chrome:theme', (event, report) => reports.push({ url: event.sender.getURL(), report }));

/** Only the page under test: our own pages report their theme as well. */
const pageReports = () => reports.filter((entry) => entry.url.includes(String(PORT))).map((entry) => entry.report);

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log('OK   ' + name);
  else { console.error('FAIL ' + name + ': ' + detail); failed = true; }
}

const WATCHDOG_MS = 150000;
const watchdog = setTimeout(() => {
  console.error('FAIL harness: still running after ' + (WATCHDOG_MS / 1000) + 's');
  app.exit(1);
}, WATCHDOG_MS);

function view(match) {
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes(match)) || null;
}

function menuItem(label, items = Menu.getApplicationMenu()?.items || []) {
  for (const item of items) {
    if (item.label === label) return item;
    const found = item.submenu && menuItem(label, item.submenu.items);
    if (found) return found;
  }
  return null;
}

async function grab(name) {
  if (!SHOTS) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  const [width, height] = win.getContentSize();
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
  const mine = sources.find((s) => s.id === win.getMediaSourceId()) || sources.find((s) => /claw/i.test(s.name));
  if (!mine || mine.thumbnail.isEmpty()) return;
  fs.writeFileSync(path.join(SHOTS, name + '.png'), mine.thumbnail.toPNG());
}

function finish(code) {
  clearTimeout(watchdog);
  server.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(code);
}

app.whenReady().then(async () => {
  await delay(9000);

  const gatewayView = view(String(PORT));
  check(APPEARANCE + ': the stub gateway page was loaded', Boolean(gatewayView), 'no view at the stub address');
  if (!gatewayView) { finish(1); return; }

  const served = await gatewayView.executeJavaScript('window.__claw.tag()');
  check('the stub already carries a custom theme',
    typeof served === 'string' && served.includes(':root[data-theme='), JSON.stringify(served));

  const settings = menuItem('Settings…');
  check('the app offers Settings', Boolean(settings), 'no Settings item');
  if (settings) settings.click();
  await delay(4000);

  const page = view('settings.html');
  check('the settings surface opened', Boolean(page), 'settings.html never loaded');
  if (!page) { finish(1); return; }

  const before = {
    page: await gatewayView.executeJavaScript(bytesScript('--accent')),
    ours: await page.executeJavaScript(bytesScript('--accent')),
  };
  console.log('note the stub accent before the swap: ' + before.page.resolved);
  console.log('note our settings surface accent before the swap: ' + before.ours.resolved);
  check('our settings surface wore the first custom theme',
    sameColour(before.ours, before.page),
    'our surface resolves ' + before.ours.resolved + ', and the page is painted ' + before.page.resolved);

  await grab('custom-theme-' + APPEARANCE + '-01-before');
  const attributesBefore = await gatewayView.executeJavaScript('window.__claw.attributes()');
  await gatewayView.executeJavaScript('window.__claw.watch()');
  const swapped = await gatewayView.executeJavaScript('window.__claw.swap(' + JSON.stringify(customCss(SECOND)) + ')');
  check('the custom theme tag was rewritten', typeof swapped === 'number' && swapped > 0, 'swap answered ' + JSON.stringify(swapped));
  await delay(2000);

  const mutations = await gatewayView.executeJavaScript('window.__clawRootAttributeMutations');
  const attributesAfter = await gatewayView.executeJavaScript('window.__claw.attributes()');
  console.log('note the root attributes across the swap: ' + JSON.stringify(attributesBefore) + ' -> ' + JSON.stringify(attributesAfter));
  check('the swap changed no attribute on the root',
    Array.isArray(mutations) && mutations.length === 0,
    'the root recorded ' + JSON.stringify(mutations));

  const after = {
    page: await gatewayView.executeJavaScript(bytesScript('--accent')),
    ours: await page.executeJavaScript(bytesScript('--accent')),
  };
  console.log('note the stub accent after the swap: ' + after.page.resolved);
  console.log('note our settings surface accent after the swap: ' + after.ours.resolved);
  check('the page repainted, so this harness measured a real change',
    !sameColour(after.page, before.page),
    'the stub still resolves its first accent, so nothing changed to follow');
  check('our settings surface followed the swap',
    sameColour(after.ours, after.page),
    'our surface resolves ' + after.ours.resolved + ', and the page is painted ' + after.page.resolved);

  const fromPage = pageReports();
  const last = fromPage[fromPage.length - 1];
  const firstAccent = fromPage[0] && fromPage[0].tokens ? fromPage[0].tokens['--accent'] : undefined;
  check('the app reported the new palette rather than keeping the first',
    fromPage.length > 1 && Boolean(last && last.tokens) && last.tokens['--accent'] !== firstAccent,
    'the app reported ' + fromPage.length + ' time(s): ' + JSON.stringify(fromPage.map((r) => (r.tokens || {})['--accent'])));
  const reported = last && last.tokens ? last.tokens['--accent'] : null;
  const wanted = hexOf(after.page.bytes);
  console.log('note the accent the app received: ' + JSON.stringify(reported) + ', against ' + wanted + ' on the page');
  check('the mark would take the new accent bucket',
    Boolean(reported) && appIcons.choose(reported, APPEARANCE).bucket.id === appIcons.choose(wanted, APPEARANCE).bucket.id,
    'the received accent reads as bucket ' + (reported ? appIcons.choose(reported, APPEARANCE).bucket.id : '(none)') + ', and ' + wanted + ' reads as ' + appIcons.choose(wanted, APPEARANCE).bucket.id);

  check('the app adopted a palette from the page',
    lines.some((l) => /^\[chela-desktop\] theme: (light|dark) .*\(\d+ tokens\)$/.test(l)),
    JSON.stringify(lines.filter((l) => /theme/.test(l))));

  await grab('custom-theme-' + APPEARANCE + '-02-after');
  if (SHOTS) console.log('note screenshots in ' + SHOTS);

  console.log(failed ? 'FAILED' : 'ALL OK');
  finish(failed ? 1 : 0);
}).catch((err) => {
  console.error('FAIL harness: ' + (err && err.stack ? err.stack : err));
  server.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(1);
});
