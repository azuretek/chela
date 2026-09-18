// Capture the two shared pages in BOTH appearances, with a screenshot per
// surface per appearance.
//
// Why this is its own harness rather than a flag on test-settings-surface.js:
// that one drives the real app through the menu, which is the right way to test
// the surface as a person reaches it, and it can only ever be in one appearance
// at a time because the app's appearance follows the Control UI's theme. This is
// the other question, and it is the one a single screenshot cannot answer: does
// each page actually TAKE the appearance in force, or does it only look right in
// the mode somebody happened to look at? A page that ignores the mode renders
// perfectly in one of them.
//
// It loads the pages directly, with a stub host, rather than through the app, so
// that the appearance is the only thing that varies between two captures. The
// pages are the real files from core/ui, the state handed to settings.html is
// read from core/spec/settings.json, and the CSS is the real stylesheet.
//
// What it asserts, per page: the page's own `color-scheme` is the mode it was
// asked for, the background it paints differs between the two modes, and the
// back control this batch added is present with its esc chip. The screenshots
// are what is left for a person to look at.
//
//   npx electron scripts/capture-pages.js [--out DIR] [--width N]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';

// The notice token layer, injected exactly as the app injects it (applyTokenCss in
// src/main.js): our pages name tokens, and this is the sheet that defines them.
// Without it the banner draws no card background at all, because every colour it
// names resolves to nothing -- which is how the first run of this harness looked
// like a broken layout rather than a harness that had skipped a step.
import { stylesheet as tokenStylesheet } from '../src/tokens.js';
// And the live theme, injected exactly as the app injects it (applyThemeCss in
// src/main.js): the Control UI's own tokens, read off a running page.
//
// `themeFromReport` is not decoration in this import. It is the app's own path
// from a page's report to a sheet (see the `chrome:theme` handler in main.js),
// and it is where the allowlist lives: `sanitizeTokens` keeps only the names in
// the shared live-token list (core/spec/tokens.json), so a token missing from
// that list cannot reach a page however the Control UI defines it. Handing
// `themeCss` a theme object directly skips that filter and makes this harness
// report a palette the app would never hand out, which is how a two-palette page
// passed here on the day it was reported.
import { themeCss, themeFromReport } from '../src/chrome.js';

/**
 * A running Control UI's palette, as the app receives it from the page probe.
 *
 * NOT the default palette, and that is the whole point of seeding it here. Every
 * fault this harness is asked about is a surface drawn from a token the live
 * theme cannot reach, and against the default palette such a surface is the
 * RIGHT colour: the fault is invisible in exactly the runs that look green. The
 * values below are the `rose` palette (ui/public/themes/rose.css in the checkout),
 * which is both a palette a reader really can pick and the purple-with-pink one
 * in the report that produced this: a deep plum surface with a dusty pink accent.
 *
 * Written as computed `rgb()` strings because that is what the preload's probe
 * reports after the engine resolves each token through a real property.
 */
const LIVE_THEME = {
  dark: {
    mode: 'dark',
    surface: 'rgb(25, 23, 36)',
    symbol: 'rgb(213, 210, 235)',
    tokens: {
      '--bg': 'rgb(25, 23, 36)',
      '--bg-hover': 'rgb(38, 35, 58)',
      '--bg-muted': 'rgb(38, 35, 58)',
      '--panel': 'rgb(25, 23, 36)',
      '--panel-hover': 'rgb(38, 35, 58)',
      '--panel-strong': 'rgb(31, 29, 46)',
      '--input': 'rgb(41, 38, 60)',
      '--text': 'rgb(213, 210, 235)',
      '--text-strong': 'rgb(239, 237, 250)',
      '--muted': 'rgb(151, 147, 176)',
      '--muted-strong': 'rgb(172, 168, 196)',
      '--border': 'rgb(41, 38, 60)',
      '--border-strong': 'rgb(61, 57, 88)',
      '--border-hover': 'rgb(84, 80, 120)',
      '--accent': 'rgb(235, 188, 186)',
      '--accent-hover': 'rgb(242, 208, 206)',
      '--accent-subtle': 'rgba(235, 188, 186, 0.12)',
      '--primary': 'rgb(235, 188, 186)',
      '--primary-hover': 'rgb(242, 208, 206)',
      '--primary-foreground': 'rgb(63, 34, 36)',
      '--destructive': 'rgb(235, 111, 146)',
      '--ring': 'rgb(235, 188, 186)',
      '--card': 'rgb(31, 29, 46)',
      '--bg-elevated': 'rgb(31, 29, 46)',
    },
  },
  light: {
    mode: 'light',
    surface: 'rgb(250, 244, 237)',
    symbol: 'rgb(87, 82, 121)',
    tokens: {
      '--bg': 'rgb(250, 244, 237)',
      '--bg-hover': 'rgb(240, 231, 222)',
      '--bg-muted': 'rgb(240, 231, 222)',
      '--panel': 'rgb(250, 244, 237)',
      '--panel-hover': 'rgb(240, 231, 222)',
      '--panel-strong': 'rgb(255, 250, 243)',
      '--input': 'rgb(242, 233, 225)',
      '--text': 'rgb(87, 82, 121)',
      '--text-strong': 'rgb(38, 35, 58)',
      '--muted': 'rgb(121, 116, 154)',
      '--muted-strong': 'rgb(102, 97, 138)',
      '--border': 'rgb(224, 217, 208)',
      '--border-strong': 'rgb(203, 194, 186)',
      '--border-hover': 'rgb(172, 164, 156)',
      '--accent': 'rgb(156, 79, 102)',
      '--accent-hover': 'rgb(140, 68, 90)',
      '--accent-subtle': 'rgba(156, 79, 102, 0.1)',
      '--primary': 'rgb(156, 79, 102)',
      '--primary-hover': 'rgb(140, 68, 90)',
      '--primary-foreground': 'rgb(255, 250, 243)',
      '--destructive': 'rgb(180, 60, 90)',
      '--ring': 'rgb(156, 79, 102)',
      '--card': 'rgb(255, 252, 250)',
      '--bg-elevated': 'rgb(255, 252, 250)',
    },
  },
};

/** The colour one custom property resolves to on the page, lowercased. */
function cssColour(rgb) {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(rgb || '');
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : String(rgb || '').trim();
}

// A throwaway profile, pinned BOTH ways: main.js is not loaded here, but
// Chromium still writes a profile, and a harness must never write into the real
// one. See dump-overlays.js for the switch-versus-path reason.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-capture-pages-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? path.join(os.tmpdir(), 'claw-pages') : process.argv[outIndex + 1];
const widthIndex = process.argv.indexOf('--width');
const WIDTH = widthIndex === -1 ? 900 : Number(process.argv[widthIndex + 1]);
fs.mkdirSync(OUT, { recursive: true });

const REPO = path.join(import.meta.dirname, '..', '..');
const UI = path.join(REPO, 'core', 'ui');

/**
 * The pin that records which Control UI this build targets.
 *
 * Read rather than written out here, because About names it and this harness is
 * what checks that the page shows the pin's own version: a version typed into
 * this file would be a third copy of it, and it would agree with whatever the
 * page happened to print on the day it was typed. The pin is also what proves
 * the check can fail, since its version is the expected value.
 */
const PIN = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'upstream-reference.json'), 'utf8'));

/**
 * What settings.html renders from, when no client is behind it.
 *
 * The spec is read rather than written out here, because the page filters its
 * surface from that file and a stub that disagreed with it would render a
 * different page from the one the clients render.
 */
const SMALL_STATE = {
  client: 'desktop',
  surface: JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'settings.json'), 'utf8')),
  gateways: [
    {
      id: 'alpha',
      label: 'Alpha gateway',
      url: 'http://127.0.0.1:19001/',
      credentials: { hasToken: true, hasPassword: false, headers: [] },
      status: { tone: 'ok', label: 'Connected', detail: null },
    },
    {
      id: 'beta',
      label: 'Beta gateway',
      url: 'https://gateway.example.ts.net/',
      credentials: { hasToken: false, hasPassword: false, headers: [] },
      status: { tone: 'muted', label: 'Not connected', detail: null },
    },
  ],
  activeGatewayId: 'alpha',
  connection: { phase: 'connected' },
  settings: {
    closeToTray: true,
    launchAtLogin: false,
    startHidden: false,
    autoUpdate: true,
    promptMetadata: false,
    globalShortcut: 'CommandOrControl+Shift+O',
  },
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
  facts: [
    { label: 'Version', value: '1.0.0' },
    { label: 'Runtime', value: 'Electron 44' },
    { label: 'Chromium', value: '140.0.0.0' },
    { label: 'Config', value: '~/config.json' },
  ],
  // The pin's own two fields, straight out of the file, which is what both
  // clients hand the page. The page composes the line from them.
  controlUI: { version: PIN.upstream.version, commit: PIN.upstream.commit },
};

/**
 * Two notices for the banner, one of each shape it draws: a card with an action,
 * and one carrying a download's progress.
 */
const BANNER_STATE = {
  notices: [
    {
      id: 'n-connection',
      tone: 'warn',
      message: 'Cannot connect to gateway.example.ts.net',
      detail: 'The gateway is not answering on its address. Retrying every few seconds.',
      dismissible: true,
      action: { label: 'Open settings', command: 'openSettings' },
    },
    {
      id: 'n-update',
      tone: 'info',
      message: 'A newer build is available',
      detail: 'Version 1.1.0 is ready to install.',
      progress: 0.42,
    },
  ],
};

/** The stub host, installed before the page's own script runs. */
const PRELOAD = path.join(PROFILE, 'stub-preload.cjs');
fs.writeFileSync(PRELOAD, `
const { contextBridge } = require('electron');
const state = JSON.parse(process.env.CLAW_CAPTURE_STATE || '{}');
// NOT as-page, and that is the point of the capture: when this page IS the
// window (a first run, or a phone with no gateway) its own script HIDES the back
// control, because there is nothing to go back to. A capture in that
// presentation therefore shows every surface except the one this batch is about.
// The dialog presentation is the one with somewhere to return to, so it is the
// one that shows the control.
contextBridge.exposeInMainWorld('clawSettings', {
  asPage: false,
  invoke: async (command) => (command === 'state' ? state : state),
  on: () => {},
});
contextBridge.exposeInMainWorld('clawDesktop', {
  about: async () => state,
  checkUpdates: async () => {},
  openReleases: () => {},
  closeOverlay: () => {},
  onAboutChanged: () => {},
  // The clear-cache pair, and the reason this stub is now checked against the
  // page rather than written from memory: about.js hides the whole section when
  // the host cannot do this, so a stub that forgot these two commands produced
  // About captures of a page with no clear-cache control on it, while the real
  // app (desktop/src/preload.cjs) has always had them. A capture harness whose
  // host is thinner than the real one is measuring a page nobody ships.
  clearCacheAndReload: async () => ({ cleared: ['example.invalid'], failed: [], origins: ['example.invalid'], gateway: null }),
  onCacheCleared: () => {},
  // The banner's own host, so the same stub serves all three pages. It reports a
  // height rather than sizing anything: the view is sized to exactly what the
  // page reports, and this harness has no view to size.
  notices: async () => state.notices || [],
  onNoticesChanged: () => {},
  bannerHeight: () => {},
  dismissNotice: () => {},
  noticeAction: () => {},
  markNoticesRead: () => {},
});
`);

let failed = false;
// The sheets currently inserted into the window, so the next capture can take
// them back out before it puts its own in. One window serves every capture, and
// two layers at once would leave the earlier one's values on top.
let applied = null;
let appliedToken = null;

/** Give one pass back to a bare document, whatever it had put on it. */
async function clearInjected(win) {
  if (applied) { await win.webContents.removeInsertedCSS(applied); applied = null; }
  if (appliedToken) { await win.webContents.removeInsertedCSS(appliedToken); appliedToken = null; }
}

function check(name, ok, detail = '') {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

/** The page's own answer about which appearance it is in, plus what it paints. */
const PROBE = `(() => {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const body = getComputedStyle(document.body).backgroundColor;
  const back = document.getElementById('close');
  const box = back ? back.getBoundingClientRect() : null;
  const cards = [...document.querySelectorAll('.banner')];
  const cardStyle = cards.length ? getComputedStyle(cards[0]) : null;
  const rows = [...document.querySelectorAll('.fact')];
  return {
    colorScheme: computed.colorScheme.trim(),
    tokenBackground: computed.getPropertyValue('--bg').trim(),
    body,
    back: back ? back.className : null,
    // ON SCREEN, not merely in the document. The page hides this control in the
    // presentation where it is the window rather than a dialog, so a check for
    // its presence passes on a control nobody can see -- which is the failure
    // this batch was reported for in the first place.
    backVisible: Boolean(back) && !back.hidden && Boolean(box) && box.height > 0 && box.width > 0,
    esc: Boolean(document.querySelector('.settings-sidebar__esc')),
    backIcon: Boolean(document.querySelector('.settings-sidebar__back-icon svg')),
    // The About page's clear-cache control, read the way the back control above
    // is: ON SCREEN, not merely in the document. The section is hidden outright
    // when the host has no such command, so a presence check alone would pass on
    // a page whose whole section the reader cannot see -- which is the fault this
    // reading was added for, and it was found by looking at a capture rather than
    // at the page.
    clear: (function () {
      const button = document.getElementById('clear-cache');
      const group = document.getElementById('clear-cache-group');
      if (!button) return { present: false };
      const box = button.getBoundingClientRect();
      return {
        present: true,
        label: button.textContent.trim(),
        groupHidden: Boolean(group && group.hidden),
        onScreen: !button.hidden && button.offsetParent !== null
          && box.width > 0 && box.height > 0,
      };
    })(),
    title: document.querySelector('.settings-sidebar__title') ? document.querySelector('.settings-sidebar__title').textContent.trim() : null,
    // The facts list, as the page DREW it. Read off the rendered elements rather
    // than from the state the stub was handed, because the question this answers
    // is what a person sees: a row the page builds into an element is shown, and a
    // value it never renders is not.
    facts: rows.map(function (row) {
      var label = row.querySelector('.fact__label');
      var value = row.querySelector('.fact__value');
      return {
        label: label ? label.textContent.trim() : null,
        value: value ? value.textContent.trim() : null,
      };
    }),
    // The banner's half. The notice surface token is emitted as a reference to a
    // palette token, and a custom property computes to the value it refers to, so
    // these three read as concrete colours and can be compared with each other.
    // No backticks in this comment, and none anywhere below: this whole probe is
    // one template literal, so a backtick in a comment ends the string early and
    // the rest parses as code.
    cards: cards.length,
    cardSurface: cardStyle ? cardStyle.getPropertyValue('--notice-surface').trim() : null,
    cardGap: cardStyle ? cardStyle.getPropertyValue('--notice-gap').trim() : null,
    panel: computed.getPropertyValue('--panel').trim(),
    bgElevated: computed.getPropertyValue('--bg-elevated').trim(),

    // ---- the card the theme is actually wearing -------------------------
    // The card token as the LIVE theme resolved it, against the surface the
    // page's groups actually painted (no backtick anywhere below: this probe is
    // one template literal, so a backtick in a comment ends the string early).
    themeCard: (() => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;height:0';
      probe.style.backgroundColor = 'var(--card, rgb(1, 2, 3))';
      document.documentElement.appendChild(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    })(),
    groups: [...document.querySelectorAll('.settings-group')].map(function (group) {
      return getComputedStyle(group).backgroundColor;
    }),
    escSurface: (function () {
      const esc = document.querySelector('.settings-sidebar__esc');
      return esc ? getComputedStyle(esc).backgroundColor : null;
    })(),

    // ---- what the banner covers, and whether it is ours to cover -------
    // The banner lives in a view sized to exactly its own height, so every pixel
    // it paints is a pixel it covers. The root element and the body are read by
    // name because
    // the canvas the root element paints is the whole of that rectangle, whatever
    // the card on top of it does.
    htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
    stackBackground: (function () {
      const node = document.getElementById('stack');
      return node ? getComputedStyle(node).backgroundColor : null;
    })(),
    // ---- the card's body, and whether its blocks are stacked ---------------
    // The headline and the subject line under it are two blocks. The fault this
    // reads for is that they were drawn as ONE paragraph: the body carried a class
    // whose column rule had been retired from the stylesheet this page used to
    // share with the settings surface, so the body fell back to a plain block and
    // its spans laid out inline, which the reader sees as two sentences interleaved
    // (Abi, 2026-09-18: "the banner has improper spacing between words"). No source
    // assertion can see that, so the reading is geometric: the detail starts BELOW
    // the headline, and the progress bar below that.
    noticeBody: (function () {
      const card = document.querySelector('.banner');
      if (!card) return null;
      const box = function (node) {
        const b = node.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, height: b.height };
      };
      const message = card.querySelector('.banner__message');
      const detail = card.querySelector('.banner__detail');
      const progress = card.querySelector('.banner__progress');
      const body = card.firstElementChild;
      return {
        className: body ? body.className : null,
        direction: body ? getComputedStyle(body).flexDirection : null,
        message: message ? box(message) : null,
        detail: detail ? box(detail) : null,
        progress: progress ? box(progress) : null,
      };
    })(),
    // The sweep button's own box, and the CARD it hangs on. The sweep is no
    // longer a full-width row of its own (Abi, 2026-09-18): it is a plain button
    // on the last card's line, so what has to be painted is the card behind the
    // button, not a strip spanning the width. onCard says the button is inside a
    // card, which is what makes its pixels the card's rather than a dead zone.
    sweep: (function () {
      const readall = document.querySelector('.banner__readall');
      if (!readall) return null;
      const box = readall.getBoundingClientRect();
      const card = readall.closest('.banner');
      const cardBox = card ? card.getBoundingClientRect() : null;
      return {
        onCard: Boolean(card),
        top: box.top, bottom: box.bottom, left: box.left, right: box.right,
        card: cardBox ? { top: cardBox.top, bottom: cardBox.bottom, left: cardBox.left, right: cardBox.right } : null,
      };
    })(),
    // The sweep control, and whether a press at its own centre would reach it.
    // The banner is a view over the page, so a control inside it is clickable
    // unless something in the SAME document is drawn over it: this is the
    // hit test, which is the only way to tell an opaque sibling from a control.
    readall: (function () {
      const node = document.querySelector('.banner__readall');
      if (!node) return null;
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        label: node.textContent.trim(),
        centre: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
        hit: hit ? String(hit.className || hit.tagName) : null,
        reached: Boolean(hit) && (hit === node || node.contains(hit)),
      };
    })(),
  };
})()`;

// `back` is which pages carry the way back, `title` is their heading, `reference`
// is the pin's own line about which Control UI the page targets, and `cards` is
// the notice banner's half: one page, no back control, notices instead.
// `back` is which pages carry the way back, `title` is their heading, `reference`
// is the pin's own line about which Control UI the page targets, `clear` is the
// About page's clear-cache control, and `cards` is the notice banner's half: one
// page, no back control, notices instead.
const PAGES = [
  { name: 'settings', file: 'settings.html', state: SMALL_STATE, title: 'Settings', back: true },
  { name: 'about', file: 'about.html', state: ABOUT_STATE, title: 'Claw Control UI', back: true, reference: true, clear: true },
  { name: 'banner', file: 'banner.html', state: BANNER_STATE, title: null, back: false, cards: true },
];

async function capture(page, mode, win) {
  nativeTheme.themeSource = mode;
  // Set BEFORE the load: a renderer inherits the main process's environment when
  // it is spawned, so a stub set after the window appears arrives as an empty map
  // and the page renders an empty state.
  process.env.CLAW_CAPTURE_STATE = JSON.stringify(page.state);

  // ONE window for every capture, reloaded. A fresh window per capture failed
  // here: the second load of the same file:// URL came back ERR_FAILED (-2)
  // while the previous window's teardown was still finishing. Reusing the window
  // removes the teardown from the sequence, and the retry covers the remainder.
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await win.loadFile(path.join(UI, page.file));
      break;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${page.file} would not load after ${attempt} attempts: ${err.message}`);
      console.log(`     ${page.name} ${mode}: load attempt ${attempt} failed (${err.message}), retrying`);
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  // The pages render after their host answers the first state call, and the CSS
  // goes in before the probe reads anything, because what the probe reads is what
  // this put there.
  //
  // WHICH sheets depends on the page, and it is the fidelity half of this
  // harness. It used to hand the notice token layer to every page, which is not
  // what any of them is given at runtime: `applyTokenCss` runs for the banner and
  // the loading cover only (see src/main.js), and Settings and About get the LIVE
  // theme alone. A harness that paints a page with a palette the app never gives
  // it cannot see a page wearing the wrong one, which is exactly the fault it is
  // being asked about here.
  await clearInjected(win);
  const theme = themeCss(themeFromReport(LIVE_THEME[mode]));
  if (page.cards) {
    appliedToken = await win.webContents.insertCSS(tokenStylesheet());
    applied = await win.webContents.insertCSS(theme);
  } else {
    applied = await win.webContents.insertCSS(theme);
  }
  await new Promise((r) => setTimeout(r, 1200));

  const probe = await win.webContents.executeJavaScript(PROBE);
  const shot = path.join(OUT, `${page.name}-${mode}.png`);
  const image = await win.capturePage();
  fs.writeFileSync(shot, image.toPNG());

  // What the page actually COVERED, read off the composited pixels rather than
  // off a stylesheet: the banner is a strip over someone else's page, so a pixel
  // it paints there is a pixel of that page nobody can see. Read through the
  // window's own alpha because the view is transparent-backed (see
  // `bannerView.setBackgroundColor('#00000000')` in src/main.js) and fully
  // transparent is the state this should be in everywhere the card is not.
  //
  // Two readings per band: the full-width row the sweep control sits in, and the
  // stack's own padding at the leading edge, which is the part of the strip a
  // person reads as "this block covers what is under it".
  probe.pixels = page.cards ? readPixels(image, probe) : null;

  console.log(`SHOT ${shot}`);
  console.log(`     ${page.name} ${mode}: color-scheme=${probe.colorScheme} --bg=${probe.tokenBackground} body=${probe.body}`);
  if (probe.pixels) {
    console.log(`     banner ${mode}: html=${probe.htmlBackground} stack=${probe.stackBackground} sweep=${probe.sweep ? (probe.sweep.onCard ? 'on-card' : 'not-on-card') : 'none'}`);
    console.log(`     banner ${mode} pixels: ${JSON.stringify(probe.pixels)}`);
  }
  return probe;
}

/**
 * The colour and alpha at a few points of a captured frame, as `r,g,b,a` strings.
 *
 * `toBitmap()` is BGRA in premultiplied form, so the last byte is the one that
 * answers "is anything painted here at all" and the colour is the reading next
 * to it. Downsampled by nothing: a single pixel is the point of it.
 */
function readPixels(image, probe) {
  const bitmap = image.toBitmap();
  const { width, height } = image.getSize();
  const at = (x, y) => {
    const px = Math.max(0, Math.min(width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(height - 1, Math.round(y)));
    const i = (py * width + px) * 4;
    return `rgb(${bitmap[i + 2]}, ${bitmap[i + 1]}, ${bitmap[i]}) a${bitmap[i + 3]}`;
  };
  const out = {};
  if (probe.sweep) {
    // The sweep button's own pixels, read at its centre. It hangs on a card now,
    // so this pixel is the card's painted surface: it must NOT be a hole the page
    // shows through, which is what a dead zone under the button would be.
    const y = (probe.sweep.top + probe.sweep.bottom) / 2;
    out.sweepCentre = at((probe.sweep.left + probe.sweep.right) / 2, y);
  }
  // The stack's own padding, above the first card: the strip's own surface.
  out.aboveTheCard = at(4, 4);
  return out;
}

// NOT `await app.whenReady()` at module scope, and that is not a style choice:
// this file is an ESM module, and Electron's ESM loader does not let the app
// start until the module has finished evaluating, so awaiting readiness at the
// top level deadlocks -- the module waits for the app and the app waits for the
// module. It hangs with no output at all, which is how it was found. The other
// harnesses here are shaped the same way for the same reason.
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: 720,
    // Transparent, because one of the questions here is what a page COVERS. The
    // banner is a strip over someone else's page and its view is transparent-backed
    // (bannerView.setBackgroundColor('#00000000') in src/main.js), so a capture
    // taken off an opaque window would report every pixel as painted and the
    // check beside it would pass on nothing.
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  for (const page of PAGES) {
    const seen = {};
    for (const mode of ['light', 'dark']) {
      const probe = await capture(page, mode, win);
      seen[mode] = probe;

      // The one thing a screenshot cannot show: that the page asked the platform
      // for THIS appearance. A page that ignores the mode renders correctly in
      // one of the two, which is why the assertion is per mode.
      check(`${page.name}.html resolves ${mode}`,
        probe.colorScheme === mode, `color-scheme is "${probe.colorScheme}"`);

      if (page.back) {
        check(`${page.name}.html shows the back control, on screen, with its glyph and its esc chip`,
          probe.backVisible && probe.back && probe.back.includes('settings-sidebar__back')
            && probe.esc && probe.backIcon,
          JSON.stringify({ back: probe.back, visible: probe.backVisible, esc: probe.esc, icon: probe.backIcon }));
        check(`${page.name}.html names its surface`,
          probe.title === page.title, `the heading reads "${probe.title}"`);
      }

      if (page.reference) {
        // Which Control UI this build targets, asserted against the pin and not
        // against the stub: the stub was handed the pin's fields, so a check that
        // only compared those would pass with the page drawing nothing at all.
        //
        // The expected line is composed here, independently of the page, on
        // purpose: this is the one place that says what the line IS, so a change
        // to the wording has to be a decision rather than a diff nobody read. The
        // version and the sha come from the pin, which is what makes bumping the
        // pin without the page following a failure instead of stale text.
        const expected = `${PIN.upstream.version} (${PIN.upstream.commit.slice(0, 10)})`;
        const row = probe.facts.find((f) => f.label === 'Control UI');
        check(`${page.name}.html names the Control UI the pin records`,
          Boolean(row) && row.value === expected,
          JSON.stringify({ row: row || null, expected, pin: PIN.upstream.version }));
        // And the other end of the same arrangement: the pin is the only place a
        // version is written down, so the page must not be showing one of its own.
        check(`${page.name}.html shows no version the pin did not give it`,
          probe.facts.every((f) => !/\b20\d\d\.\d+\.\d+\b/.test(f.value) || f.value === expected),
          JSON.stringify(probe.facts));
      }

      if (page.clear) {
        // The manual escape hatch, ON SCREEN, in both appearances. It is on the
        // About page rather than in Settings because About is where someone looks
        // when the app is behaving oddly, and it is the one control there that
        // appears only when the host can actually do it: about.js hides the whole
        // section otherwise.
        //
        // This check is the thing that was missing. The page has carried the
        // control since f31f5b7, and the real app has always shown it, but this
        // harness's stub host did not answer clearCacheAndReload, so the page's
        // own guard hid the section and every About capture it produced was of a
        // page without it. Nothing failed, because nothing was checking: the
        // captures were the evidence and they were the evidence that was wrong.
        check(`${page.name}.html offers the clear-cache control, on screen, with the label it acts on`,
          probe.clear && probe.clear.present && probe.clear.onScreen
            && !probe.clear.groupHidden && probe.clear.label === 'Clear cache and refresh',
          JSON.stringify(probe.clear));
      }

      if (page.cards) {
        // The card is drawn at all, and drawn with the surface the SPEC records
        // for it. That second half is here because it is what had drifted: the
        // banner borrows the floating attention card by value, and its recorded
        // surface was `--bg-elevated`, the PANEL variant's surface, where the
        // floating chrome mixes `--panel`. Both are colours a page can paint, so
        // nothing objected, and the two differ in both appearances.
        check(`${page.name}.html draws the seeded notices`,
          probe.cards === BANNER_STATE.notices.length,
          `${probe.cards} card(s) for ${BANNER_STATE.notices.length} notice(s)`);
        check(`${page.name}.html draws its card on the surface the spec records`,
          Boolean(probe.cardSurface) && probe.cardSurface === probe.panel,
          JSON.stringify({ cardSurface: probe.cardSurface, panel: probe.panel, bgElevated: probe.bgElevated }));
        check(`${page.name}.html does not draw it on the panel variant's surface`,
          probe.cardSurface !== probe.bgElevated,
          JSON.stringify({ cardSurface: probe.cardSurface, bgElevated: probe.bgElevated }));
        check(`${page.name}.html uses the row gap the spec records`,
          probe.cardGap === '8px', `the gap resolved to "${probe.cardGap}"`);

        // ---- the bar paints its whole rectangle -----------------------------
        // This assertion is where the reversal is recorded. What stood here
        // required the ROOT, the BODY and the STACK to be transparent, so the strip
        // was an unpainted band the page underneath showed through. That was the
        // first answer to the click-swallowing fault and it READ WRONG: the reader
        // saw a strip of the app under a floating bar, and those unpainted pixels
        // were dead zones over the Control UI anyway, which is the fault it was
        // meant to fix. See the note at the top of core/ui/banner.css: the bar
        // paints its whole rectangle, because a view claims every mouse event
        // inside its rectangle whatever is drawn there.
        //
        // So the STACK paints, and the two above it must still add NOTHING: the
        // root's background is propagated to the whole viewport, and a margin on
        // the body would sit inside the view and outside the bar.
        const clear = (value) => /rgba?\([^)]*,\s*0\)$|^transparent$/.test(String(value || '').trim());
        check(`${page.name}.html adds no canvas above the bar`,
          clear(probe.htmlBackground) && clear(probe.body),
          JSON.stringify({ html: probe.htmlBackground, body: probe.body }));
        check(`${page.name}.html paints the whole bar, so no pixel of it is a dead zone`,
          Boolean(probe.stackBackground) && !clear(probe.stackBackground),
          `the stack resolved to ${JSON.stringify(probe.stackBackground)}`);
        // ---- the card's body stacks its blocks --------------------------------
        // Read off geometry rather than source, because the fault was a class whose
        // rule had gone: the card still carried it and the page still drew. The
        // detail must START below where the headline ENDS, which is false the moment
        // the two are laid out as one inline flow whatever the stylesheet says.
        const body = probe.noticeBody;
        check(`${page.name}.html stacks the headline and the detail instead of interleaving them`,
          Boolean(body) && body.direction === 'column'
            && Boolean(body.message) && Boolean(body.detail)
            && body.detail.top >= body.message.bottom - 0.5,
          JSON.stringify(body));
        // ---- the sweep is a plain button on a card, not a full-width row ------
        // Abi, 2026-09-18: the sweep had become a full-width row whose empty part
        // ate clicks on the Control UI. It is a plain button on the last card's
        // line now, so the invariant is that it sits ON a card (its pixels are the
        // card's painted surface) rather than in a strip of its own.
        check(`${page.name}.html hangs the sweep on a card, not in a row of its own`,
          Boolean(probe.sweep) && probe.sweep.onCard && Boolean(probe.sweep.card),
          JSON.stringify(probe.sweep));
        // And off the composited pixels, the half a person sees: the button's own
        // centre is painted (it is on the card), and the strip's padding above the
        // first card is the bar's own surface. The colour is reported beside the
        // alpha so a fully transparent pixel cannot pass by looking painted.
        if (probe.pixels) {
          const alpha = (value) => Number(String(value).split(' a').pop());
          check(`${page.name}.html paints behind the sweep button and its own strip`,
            [probe.pixels.sweepCentre, probe.pixels.aboveTheCard]
              .every((pixel) => alpha(pixel) > 0),
            JSON.stringify(probe.pixels));
        }

        // ---- the sweep control is still a control -------------------------
        // The click-swallowing bug was in this exact area, so the control is
        // hit-tested at its own centre rather than merely checked for presence: a
        // control covered by an opaque sibling, or by a drag region, is present,
        // styled and dead. This is the in-document half; the real click through
        // the window server is scripts/test-banner-clicks.js.
        check(`${page.name}.html leaves the sweep control reachable at its own centre`,
          Boolean(probe.readall) && probe.readall.reached && probe.readall.label === 'Mark all read',
          JSON.stringify(probe.readall));
      }

      if (page.back) {
        // ---- the surfaces follow the palette the reader chose ----------------
        // The settings groups are the biggest surfaces on the page and the ones
        // this batch moved onto upstream's classes, and upstream's class names a
        // token rather than a colour. That token has to be one the LIVE theme can
        // reach, or the group keeps ui.css's copy of the Control UI's DEFAULT
        // palette while the window around it wears the reader's: a page wearing
        // two palettes at once, which is invisible against the default one and
        // obvious against any other.
        const expected = cssColour(LIVE_THEME[mode].tokens['--card']);
        check(`${page.name}.html draws its groups from the palette in force (${mode})`,
          probe.groups.length > 0 && probe.groups.every((colour) => cssColour(colour) === expected),
          JSON.stringify({ expected, themeCard: cssColour(probe.themeCard), groups: probe.groups }));
        check(`${page.name}.html's surface token is the one the theme publishes`,
          cssColour(probe.themeCard) === expected,
          JSON.stringify({ themeCard: probe.themeCard, expected }));
      }
    }
    check(`${page.name}.html paints a different background in each appearance`,
      seen.light.tokenBackground !== seen.dark.tokenBackground
        && seen.light.tokenBackground !== '',
      JSON.stringify({ light: seen.light.tokenBackground, dark: seen.dark.tokenBackground }));
    check(`${page.name}.html returns the appearance it was asked for, not the other one`,
      seen.light.colorScheme === 'light' && seen.dark.colorScheme === 'dark',
      JSON.stringify({ light: seen.light.colorScheme, dark: seen.dark.colorScheme }));
  }

  fs.rmSync(PROFILE, { recursive: true, force: true });
  console.log(failed ? 'FAILED' : `OK   ${PAGES.length * 2} captures in ${OUT}`);
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(`FAIL harness: ${err && err.stack ? err.stack : err}`);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(1);
});
