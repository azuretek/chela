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
// The token layer currently inserted into the window, so the next capture can
// take it back out before it puts its own in. One window serves every capture,
// and two layers at once would leave the earlier one's values on top.
let applied = null;
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
  };
})()`;

// `back` is which pages carry the way back, `title` is their heading, `reference`
// is the pin's own line about which Control UI the page targets, and `cards` is
// the notice banner's half: one page, no back control, notices instead.
const PAGES = [
  { name: 'settings', file: 'settings.html', state: SMALL_STATE, title: 'Settings', back: true },
  { name: 'about', file: 'about.html', state: ABOUT_STATE, title: 'Claw Control UI', back: true, reference: true },
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

  // The pages render after their host answers the first state call, and this is
  // also the sheet that gives the banner its colours, so it goes in before the
  // probe reads them. Same order the app uses: the token layer, then the live
  // theme on top of it (there is no live theme here, so the layer is the answer).
  if (applied) await win.webContents.removeInsertedCSS(applied);
  applied = await win.webContents.insertCSS(tokenStylesheet());
  await new Promise((r) => setTimeout(r, 1200));

  const probe = await win.webContents.executeJavaScript(PROBE);
  const shot = path.join(OUT, `${page.name}-${mode}.png`);
  const image = await win.capturePage();
  fs.writeFileSync(shot, image.toPNG());

  console.log(`SHOT ${shot}`);
  console.log(`     ${page.name} ${mode}: color-scheme=${probe.colorScheme} --bg=${probe.tokenBackground} body=${probe.body}`);
  return probe;
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
