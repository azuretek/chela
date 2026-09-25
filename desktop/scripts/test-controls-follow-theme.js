// Every control on our own pages, in every state, wears the custom theme.
//
//   npx electron scripts/test-controls-follow-theme.js [--appearance light|dark] [--shots DIR]
//
// WHY THIS EXISTS. Reported 2026-09-25 on a build that already followed a
// tweakcn theme: "I notice some of the buttons still turn red, we should follow
// the theme".
//
// A custom theme is a FIXED list of tokens. Upstream writes exactly the names in
// MODE_TOKEN_ORDER (ui/src/app/custom-theme.ts) into its style tag, and every
// other name the page defines keeps the value upstream's own base stylesheet
// gives it. So a token our pages read that the custom theme does not set still
// computes on the page, to upstream's DEFAULT, and the probe reports it as though
// it were the theme's: the primary button's hover was upstream's #c22e2e red,
// inside a window wearing the reader's own palette.
//
// The claim this harness makes is the reader's, not the stylesheet's: a colour a
// control shows is traceable to the theme exactly when it CHANGES with the theme.
// So it drives every control on every page through every state under one custom
// theme, imports a second one whose every token differs, drives them again, and
// fails on any colour that did not move. A literal, a platform default (the
// focus ring a control with no focus style of its own draws) and an upstream
// default all stay put across the swap, whatever they look like; a colour
// derived from the theme cannot. Fully transparent paint is not a colour.
//
// The chain is the real one from the gateway page to our pages: the app is
// launched against a stub Control UI shaped like upstream's page (its base
// palette on :root, the custom theme in the openclaw-custom-theme style tag), the
// app's own probe reports it, and each of our pages is loaded with the sheets the
// app would insert from that report (themeFromReport, themeCss, the token layer).

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { stylesheet as tokenStylesheet } from '../src/tokens.js';
import { forPages as bannerSpec } from '../../core/banner.js';
import { themeCss, themeFromReport } from '../src/chrome.js';

const flag = (name, fallback = null) => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const APPEARANCE = flag('appearance', 'dark');
if (!['light', 'dark'].includes(APPEARANCE)) throw new Error('unknown appearance ' + APPEARANCE);
const SHOTS = flag('shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const NEWLINE = String.fromCharCode(10);
const REPO = path.join(import.meta.dirname, '..', '..');
const UI = path.join(REPO, 'core', 'ui');
const TOKENS = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'tokens.json'), 'utf8'));

// ---------------------------------------------------------------- the themes

/**
 * The names a tweakcn import writes (live.customTheme in core/spec/tokens.json,
 * upstream's MODE_TOKEN_ORDER). Nothing outside this list is the custom theme's
 * to set, which is the whole fault.
 */
const CUSTOM_TOKENS = TOKENS.live.customTheme.names.map((name) => name.slice(2));

/**
 * One custom theme, generated per hue so two of them differ in EVERY token.
 * Lightness is the role's (a surface is dark in dark, a text is light), the hue
 * is the theme's, and every value is oklch() because that is what tweakcn
 * exports. The focus ring and glow are written in the theme's own hue.
 */
function customTheme(hue, mode) {
  const dark = mode === 'dark';
  const L = (d, l) => (dark ? d : l);
  const c = (lightness, chroma, h = hue, alpha = null) =>
    'oklch(' + lightness + ' ' + chroma + ' ' + h + (alpha === null ? '' : ' / ' + alpha) + ')';
  const surface = (d, l) => c(L(d, l), 0.03);
  const accent = c(L(0.7, 0.52), 0.17);
  const warm = (hue + 35) % 360;
  const out = {};
  for (const name of CUSTOM_TOKENS) {
    let value;
    if (name === 'font-body' || name === 'font-display') value = 'Helvetica, Arial, sans-serif';
    else if (name === 'mono') value = 'Menlo, monospace';
    else if (name === 'focus-ring') value = '0 0 0 2px ' + surface(0.2, 0.98) + ', 0 0 0 3px ' + c(L(0.7, 0.52), 0.17, hue, 0.8);
    else if (name === 'focus-glow') value = '0 0 0 2px ' + surface(0.2, 0.98) + ', 0 0 16px ' + c(L(0.7, 0.52), 0.17, hue, 0.3);
    else if (/^(bg|chrome|panel)(-|$)/.test(name)) value = surface(name === 'bg' ? 0.2 : 0.24, name === 'bg' ? 0.98 : 0.95);
    else if (/^(card|popover)$/.test(name)) value = surface(0.27, 1);
    else if (name === 'input') value = surface(0.3, 0.99);
    else if (/^border/.test(name)) value = surface(0.36, 0.86);
    else if (/^(text|chat-text|card-foreground|popover-foreground)/.test(name)) value = c(L(0.94, 0.2), 0.02);
    else if (/^muted/.test(name)) value = c(L(0.72, 0.48), 0.03);
    else if (/foreground$/.test(name)) value = c(L(0.16, 0.99), 0.04);
    else if (/^(destructive|danger)/.test(name)) value = c(L(0.64, 0.55), 0.2, warm, /subtle|muted/.test(name) ? 0.14 : null);
    else if (/subtle|glow|highlight|grid-line|^focus$/.test(name)) value = c(L(0.7, 0.52), 0.17, hue, 0.14);
    else value = accent;
    out['--' + name] = value;
  }
  return out;
}

const HUES = { first: 255, second: 145 };

/** The tag's text for a theme, in upstream's own shape: one block per appearance. */
function customCss(hue) {
  const block = (id, values) => [
    ':root[data-theme="' + id + '"] {',
    ...Object.entries(values).map(([name, value]) => '  ' + name + ': ' + value + ';'),
    '}',
  ].join(NEWLINE);
  return [block('custom', customTheme(hue, 'dark')), block('custom-light', customTheme(hue, 'light'))].join(NEWLINE);
}

/**
 * Upstream's base palette on :root, which is what a name the custom theme does
 * not set falls back to on the real page. The notice layer's css block is our
 * pinned copy of that base (core/spec/tokens.json), and the ones it does not
 * carry are upstream's own values from ui/src/styles/base.css.
 */
function basePalette(mode) {
  const base = { ...TOKENS.css[mode] };
  base['--primary'] = mode === 'dark' ? '#d13c3c' : '#bd4531';
  base['--primary-hover'] = mode === 'dark' ? '#c22e2e' : '#a83c29';
  base['--primary-foreground'] = '#ffffff';
  base['--destructive'] = mode === 'dark' ? '#d32f2f' : '#b91c1c';
  base['--scrollbar-thumb'] = 'color-mix(in srgb, var(--muted) 32%, transparent)';
  base['--scrollbar-thumb-hover'] = 'color-mix(in srgb, var(--muted) 64%, transparent)';
  base['--shadow-lg'] = '0 12px 32px rgba(0, 0, 0, 0.4)';
  return base;
}

const IN_FORCE = APPEARANCE === 'light' ? 'custom-light' : 'custom';
const CUSTOM_STYLE_ID = 'openclaw-custom-theme';
const PORT = 19230;
const ADDRESS = 'http://127.0.0.1:' + PORT + '/';

const PAGE = [
  '<!doctype html>',
  '<html data-openclaw-control-ui-build-id="stub-1" data-theme="' + IN_FORCE + '" data-theme-mode="' + APPEARANCE + '">',
  '<head><meta charset="utf-8"><title>Stub Control UI</title>',
  '<style>',
  '  :root { color-scheme: ' + APPEARANCE + '; ' + Object.entries(basePalette(APPEARANCE)).map(([n, v]) => n + ': ' + v + ';').join(' ') + ' }',
  '  body { background: var(--bg); color: var(--text); }',
  '</style>',
  '<style id="' + CUSTOM_STYLE_ID + '">',
  customCss(HUES.first),
  '</style>',
  '</head>',
  '<body><h1>Stub Control UI</h1>',
  '<script>window.__swap = function (css) { var t = document.getElementById("' + CUSTOM_STYLE_ID + '"); t.textContent = css; return t.textContent.length; };</script>',
  '</body></html>',
].join(NEWLINE);

// ---------------------------------------------------------------- the pages

const SETTINGS_STATE = {
  client: 'desktop',
  surface: JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'settings.json'), 'utf8')),
  gateways: [
    { id: 'alpha', label: 'Alpha gateway', url: 'http://127.0.0.1:19001/', credentials: { hasToken: true, hasPassword: false, headers: [] }, status: { tone: 'ok', label: 'Connected', detail: null } },
    { id: 'beta', label: 'Beta gateway', url: 'https://gateway.example.invalid/', credentials: { hasToken: false, hasPassword: false, headers: [] }, status: { tone: 'err', label: 'Failed', detail: 'refused' } },
  ],
  activeGatewayId: 'alpha',
  connection: { phase: 'connected' },
  settings: { closeToTray: true, launchAtLogin: false, startHidden: false, autoUpdate: true, promptMetadata: false, globalShortcut: 'CommandOrControl+Shift+O' },
  appearance: { mode: 'system' },
  build: '1.0.0 (source)',
  certOffers: [],
  trustedCerts: {},
  updates: {},
  secretsError: null,
};

const ABOUT_STATE = {
  build: '1.0.0 (source)',
  updateStatus: 'No update check yet this run.',
  updateReady: null,
  canInstall: true,
  autoUpdate: true,
  facts: [{ label: 'Version', value: '1.0.0' }],
  controlUI: { version: 'stub', commit: 'stub' },
};

const BANNER_STATE = {
  notices: [
    { id: 'n-error', tone: 'error', message: 'Cannot connect', detail: 'The gateway refused.', dismissible: true, action: { label: 'Open settings', command: 'openSettings' } },
    { id: 'n-info', tone: 'info', message: 'A newer build is available', detail: 'Ready to install.', dismissible: true, action: { label: 'Restart', command: 'restart' }, progress: 0.4 },
  ],
};

const LOADING_STATE = {
  gateways: [{ id: 'alpha', label: 'Alpha gateway', url: 'http://127.0.0.1:19001/' }],
  activeGatewayId: 'alpha',
  connection: { phase: 'failed' },
};

const PAGES = [
  { name: 'settings', file: 'settings.html', state: SETTINGS_STATE },
  { name: 'about', file: 'about.html', state: ABOUT_STATE },
  { name: 'pairing', file: 'pairing.html', state: { phase: 'pending', requestId: 'stub', gateway: 'Alpha gateway' } },
  { name: 'loading', file: 'loading.html', state: LOADING_STATE },
  { name: 'banner', file: 'banner.html', state: BANNER_STATE },
];

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-controls-theme-'));
const PRELOAD = path.join(PROFILE, 'stub-preload.cjs');
fs.writeFileSync(PRELOAD, [
  "const { contextBridge } = require('electron');",
  "const arg = process.argv.find((a) => a.startsWith('--claw-state='));",
  "const state = arg ? JSON.parse(Buffer.from(arg.slice(13), 'base64').toString('utf8')) : {};",
  "const bannerArg = process.argv.find((a) => a.startsWith('--claw-banner='));",
  "const spec = bannerArg ? JSON.parse(Buffer.from(bannerArg.slice(14), 'base64').toString('utf8')) : null;",
  'const none = () => {};',
  "contextBridge.exposeInMainWorld('clawSettings', { asPage: false, invoke: async () => state, on: none });",
  "contextBridge.exposeInMainWorld('clawDesktop', {",
  '  about: async () => state, checkUpdates: async () => {}, openReleases: none, closeOverlay: none, onAboutChanged: none,',
  "  clearCacheAndReload: async () => ({ cleared: [], failed: [], origins: [], gateway: null }),",
  '  notices: async () => state.notices || [], bannerSpec: async () => spec, onNoticesChanged: none,',
  '  bannerHeight: none, bannerBounds: none, sweepBounds: none, dismissNotice: none, noticeAction: none, markNoticesRead: none,',
  '  pairing: async () => state, onPairingChanged: none, reconnect: none,',
  '  getState: async () => state, progress: async () => null, onProgress: none, onStateChanged: none,',
  '});',
].join(NEWLINE));

// ---------------------------------------------------------------- measuring

/** Every element a reader can operate, on any of our pages. */
const CONTROLS = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="switch"], [tabindex]:not([tabindex="-1"])';

const STATES = [
  { name: 'rest', pseudo: [] },
  { name: 'hover', pseudo: ['hover'] },
  { name: 'focus', pseudo: ['focus', 'focus-visible', 'focus-within'] },
  { name: 'pressed', pseudo: ['hover', 'active'] },
  { name: 'disabled', pseudo: [], disable: true },
];

/**
 * Every colour a control paints in its current state, keyed by where it is
 * painted. Borders and outlines count only where they are drawn, and a shadow's
 * colours are read out of the shadow list, since a focus ring is usually one.
 * An icon inside the control paints with fill and stroke rather than color.
 */
function read(selector) {
  const COLOUR = /(?:rgba?|color|oklch|oklab|lab|lch|hsla?|hwb)\([^()]*(?:\([^()]*\)[^()]*)*\)/g;
  const out = [];
  const nodes = [...document.querySelectorAll(selector)];
  nodes.forEach((el, index) => {
    const s = getComputedStyle(el);
    const cls = typeof el.className === 'string' ? el.className.trim() : '';
    const text = (el.textContent || '').trim().slice(0, 28);
    const label = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
      + (cls ? '.' + cls.split(/\s+/).join('.') : '') + (text ? ' "' + text + '"' : '');
    const box = el.tagName === 'INPUT' && /checkbox|radio/.test(el.type);
    // A checkbox paints no text, so its color is never on screen.
    const paints = box ? { background: s.backgroundColor } : { color: s.color, background: s.backgroundColor };
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (s.getPropertyValue('border-' + side + '-style') !== 'none' && parseFloat(s.getPropertyValue('border-' + side + '-width')) > 0) {
        paints['border-' + side] = s.getPropertyValue('border-' + side + '-color');
      }
    }
    if (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) paints.outline = s.outlineColor;
    if (s.boxShadow && s.boxShadow !== 'none') {
      (s.boxShadow.match(COLOUR) || []).forEach((c, i) => { paints['shadow-' + i] = c; });
    }
    if (el.tagName === 'INPUT' && /checkbox|radio|range/.test(el.type)) paints.accent = s.accentColor;
    if (s.textDecorationLine && s.textDecorationLine !== 'none') paints.underline = s.textDecorationColor;
    for (const pseudo of ['::before', '::after']) {
      const p = getComputedStyle(el, pseudo);
      if (!p.content || p.content === 'none' || p.content === 'normal' || p.visibility === 'hidden' || p.display === 'none') continue;
      paints[pseudo + '-background'] = p.backgroundColor;
      for (const side of ['top', 'right', 'bottom', 'left']) {
        if (p.getPropertyValue('border-' + side + '-style') !== 'none' && parseFloat(p.getPropertyValue('border-' + side + '-width')) > 0) {
          paints[pseudo + '-border-' + side] = p.getPropertyValue('border-' + side + '-color');
        }
      }
    }
    el.querySelectorAll('svg, svg *').forEach((icon, i) => {
      const is = getComputedStyle(icon);
      if (is.fill && is.fill !== 'none') paints['icon-fill-' + i] = is.fill;
      if (is.stroke && is.stroke !== 'none') paints['icon-stroke-' + i] = is.stroke;
    });
    out.push({ index, label, paints });
  });
  return out;
}
const READ = '(' + read.toString() + ')';

/** Whether a computed colour paints nothing at all. */
function invisible(value) {
  if (!value) return true;
  const v = value.trim().toLowerCase();
  if (v === 'transparent' || v === 'none') return true;
  if (/^rgba\([^)]*,\s*0(\.0+)?\)$/.test(v)) return true;
  if (/\/\s*0(\.0+)?\)$/.test(v)) return true;
  return false;
}

const { app, BrowserWindow, nativeTheme, ipcMain, webContents } = await import('electron');
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

/** Every theme report the stub gateway page sends, through the app's own probe. */
const reports = [];
ipcMain.on('chrome:theme', (event, report) => {
  if (event.sender.getURL().includes(String(PORT))) reports.push(report);
});

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function check(name, ok, detail) {
  if (ok) console.log('OK   ' + name);
  else { console.error('FAIL ' + name + ': ' + detail); failed = true; }
}

const WATCHDOG_MS = 240000;
const watchdog = setTimeout(() => {
  console.error('FAIL harness: still running after ' + (WATCHDOG_MS / 1000) + 's');
  app.exit(1);
}, WATCHDOG_MS);

function finish(code) {
  clearTimeout(watchdog);
  server.close();
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* the verdict is the checks */ }
  app.exit(code);
}

/** The next report whose accent is not the one before, or null. */
async function nextReport(previous) {
  for (let i = 0; i < 80; i += 1) {
    const last = reports[reports.length - 1];
    if (last && last.tokens && last.tokens['--accent'] && last.tokens['--accent'] !== previous) return last;
    await delay(250);
  }
  return null;
}

/** One page, loaded as the app would show it under the report, measured in every state. */
async function measurePage(page, report, shotTag) {
  const win = new BrowserWindow({
    show: false,
    width: page.name === 'banner' ? 480 : 900,
    height: page.name === 'banner' ? 360 : 720,
    webPreferences: {
      preload: PRELOAD,
      sandbox: false,
      contextIsolation: true,
      additionalArguments: [
        '--claw-state=' + Buffer.from(JSON.stringify(page.state)).toString('base64'),
        '--claw-banner=' + Buffer.from(JSON.stringify(bannerSpec())).toString('base64'),
      ],
    },
  });
  const wc = win.webContents;
  await win.loadFile(path.join(UI, page.file));
  await wc.insertCSS(tokenStylesheet());
  const sheet = themeCss(themeFromReport(report));
  if (sheet) await wc.insertCSS(sheet);
  // The states are measured, not animated into: a transition would be read part
  // of the way between two colours.
  await wc.insertCSS('*, *::before, *::after { transition: none !important; animation: none !important; }');
  await delay(700);

  const dbg = wc.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('DOM.enable');
  await dbg.sendCommand('CSS.enable');
  const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: CONTROLS });
  const selector = JSON.stringify(CONTROLS);

  const byState = {};
  for (const state of STATES) {
    if (state.disable) {
      await wc.executeJavaScript('(() => { window.__was = []; document.querySelectorAll(' + selector + ').forEach((el, i) => { if ("disabled" in el) { window.__was.push([i, el.disabled]); el.disabled = true; } }); })()');
    }
    for (const nodeId of nodeIds) {
      await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: state.pseudo });
    }
    await delay(80);
    byState[state.name] = await wc.executeJavaScript(READ + '(' + selector + ')');
    if (SHOTS && state.name === 'hover') {
      const image = await wc.capturePage();
      fs.writeFileSync(path.join(SHOTS, page.name + '-' + APPEARANCE + '-' + shotTag + '-hover.png'), image.toPNG());
    }
    if (state.disable) {
      await wc.executeJavaScript('(() => { const els = document.querySelectorAll(' + selector + '); for (const [i, v] of window.__was) els[i].disabled = v; })()');
    }
  }
  for (const nodeId of nodeIds) await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  dbg.detach();
  win.destroy();
  return { count: nodeIds.length, byState };
}

async function measureAll(report, shotTag) {
  const out = {};
  for (const page of PAGES) out[page.name] = await measurePage(page, report, shotTag);
  return out;
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = APPEARANCE;
  const first = await nextReport(null);
  check(APPEARANCE + ': the app reported the first custom theme', Boolean(first), 'no report from the stub page');
  if (!first) { finish(1); return; }
  console.log('note the reported --primary under the first theme: ' + first.tokens['--primary'] + ', --primary-hover: ' + first.tokens['--primary-hover']);

  const underFirst = await measureAll(first, 'first');

  const gateway = webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes(String(PORT)));
  check(APPEARANCE + ': the stub gateway page is loaded', Boolean(gateway), 'no gateway view');
  if (!gateway) { finish(1); return; }
  await gateway.executeJavaScript('window.__swap(' + JSON.stringify(customCss(HUES.second)) + ')');
  const second = await nextReport(first.tokens['--accent']);
  check(APPEARANCE + ': the app reported the second custom theme', Boolean(second), 'the accent never moved from ' + first.tokens['--accent']);
  if (!second) { finish(1); return; }
  console.log('note the reported --primary under the second theme: ' + second.tokens['--primary'] + ', --primary-hover: ' + second.tokens['--primary-hover']);

  const underSecond = await measureAll(second, 'second');

  const stuck = [];
  let compared = 0;
  for (const page of PAGES) {
    const a = underFirst[page.name];
    const b = underSecond[page.name];
    check(APPEARANCE + ': ' + page.name + ' has controls to measure', a.count > 0, 'no control matched');
    for (const state of STATES) {
      const listA = a.byState[state.name];
      const listB = b.byState[state.name];
      for (let i = 0; i < listA.length; i += 1) {
        const ca = listA[i];
        const cb = listB[i];
        if (!cb || cb.label !== ca.label) { stuck.push(page.name + ' ' + ca.label + ': not the same control under both themes'); continue; }
        for (const [where, value] of Object.entries(ca.paints)) {
          const other = cb.paints[where];
          if (invisible(value) && invisible(other)) continue;
          compared += 1;
          if (value === other) stuck.push(page.name + ' / ' + state.name + ' / ' + ca.label + ' / ' + where + ' = ' + value);
        }
      }
    }
  }
  console.log('note ' + compared + ' painted colours compared across the two themes');
  check(APPEARANCE + ': every colour every control paints, in every state, moves with the custom theme',
    stuck.length === 0,
    stuck.length + ' did not:' + NEWLINE + '      ' + stuck.join(NEWLINE + '      '));

  console.log(failed ? 'FAILED' : 'ALL OK');
  finish(failed ? 1 : 0);
}).catch((err) => {
  console.error('FAIL harness: ' + (err && err.stack ? err.stack : err));
  finish(1);
});
