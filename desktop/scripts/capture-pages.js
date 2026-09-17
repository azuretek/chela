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
});
`);

let failed = false;
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
  };
})()`;

const PAGES = [
  { name: 'settings', file: 'settings.html', state: SMALL_STATE, title: 'Settings' },
  { name: 'about', file: 'about.html', state: ABOUT_STATE, title: 'Claw Control UI' },
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

  // The pages render after their host answers the first state call, and their
  // own stylesheet is what settles the palette.
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
      check(`${page.name}.html shows the back control, on screen, with its glyph and its esc chip`,
        probe.backVisible && probe.back && probe.back.includes('settings-sidebar__back')
          && probe.esc && probe.backIcon,
        JSON.stringify({ back: probe.back, visible: probe.backVisible, esc: probe.esc, icon: probe.backIcon }));
      check(`${page.name}.html names its surface`,
        probe.title === page.title, `the heading reads "${probe.title}"`);
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
