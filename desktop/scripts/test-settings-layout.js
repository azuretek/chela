// The settings surface's LAYOUT, measured on the page rather than read off the
// stylesheet: are its blocks separated from each other, and are the heading's
// edges on one column with the header's own content?
//
// Both are claims no source read can settle. A spacing rule is one line in
// ui.css and whether it APPLIES is a question about the element's parentage: the
// rule that used to own the gap between two groups was a SIBLING rule
// (`.settings-group + .settings-group`), so it stopped applying the moment the
// page wrapped a run of groups in a host element, and the page looked exactly as
// it did before to everything except a rendered box. Same for the heading: the
// borrowed header and the page's own bit of chrome were each expressing an
// opinion about the same edge, and only a measurement says which one won.
//
// It loads the shared pages directly with a stub host, in both appearances and at
// two widths, because the phone and the desktop are the SAME page: what differs
// between them is width and the rules that answer it. The narrow pass is therefore
// not a second surface, it is the same page asked the phone's question. About is
// measured beside Settings because the header, the control, the title and the
// subtitle are one borrowed block that both pages use.
//
// What it asserts, at every width and in both appearances:
//
//   the blocks      on the settings surface, no two adjacent blocks are flush. The
//                   blocks are the tab bar, the gateway filter, every settings
//                   group and the About footer, read in the order they are drawn,
//                   which is what makes this a rule about the SURFACE rather than
//                   about the two places that happened to be reported.
//   the heading     the title and its subtitle start on one edge (both pages), and
//                   on the settings page that edge is the back control's own, which
//                   is upstream's arrangement for this header: the control's 9px
//                   inset and the title's 9px inset are the same edge on purpose.
//
//   npx electron scripts/test-settings-layout.js [--out DIR] [--report]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';

// The same two imports the app uses, and for the same reasons capture-pages.js
// records: our pages name tokens, and the LIVE theme is the only sheet Settings is
// given at runtime. A harness that painted this page with a palette the app never
// hands it could not see a page wearing the wrong one.
import { themeCss, themeFromReport } from '../src/chrome.js';

// The `rose` palette, as the preload's probe reports it: a non-default palette is
// the only one against which a script that ignores its theme looks wrong.
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

// A throwaway profile, pinned BOTH ways, as every harness here does: main.js is
// not loaded, but Chromium still writes a profile and a harness must never write
// into the real one.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-settings-layout-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const REPORT = process.argv.includes('--report');
const OUT = argOf('--out', path.join(os.tmpdir(), 'claw-settings-layout'));
fs.mkdirSync(OUT, { recursive: true });

const REPO = path.join(import.meta.dirname, '..', '..');
const UI = path.join(REPO, 'core', 'ui');

// The widths, and each is a question rather than a size: 900 is the desktop at
// its normal window, and 402 is the phone, where the surface is the same page and
// only the narrow-width rules differ. The floor is asserted at both.
const WIDTHS = [
  { name: 'wide', width: 900 },
  { name: 'narrow', width: 402 },
];

// The state the page renders from: read from the spec for the same reason
// capture-pages.js does, so the stub and the clients cannot disagree about which
// settings exist. Two gateways, one connected, so the surface draws a list, the
// "add a gateway" card under it and the Control-UI card at the end.
const PIN = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'upstream-reference.json'), 'utf8'));
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
      url: 'https://example-host.example.ts.net/',
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
// The About page's state, so the OTHER page carrying this header is measured too:
// the header, the back control, the title and the subtitle is one borrowed block
// used by both surfaces, so a fault in the column is a fault on both and a fix
// that only reached one of them would read as green from the page that was
// measured. Its headline is drawn BESIDE the app's mark rather than under the back
// control (see `.modal__headline`), so the title and its subtitle are what have to
// agree there, not the title and the control.
const ABOUT_STATE = {
  build: '1.0.0 (source)',
  updateStatus: 'No update check yet this run.',
  updateReady: null,
  canInstall: true,
  autoUpdate: true,
  facts: [
    { label: 'Version', value: '1.0.0' },
    { label: 'Runtime', value: 'Electron 44' },
    { label: 'Config', value: '~/config.json' },
  ],
  controlUI: { version: PIN.upstream.version, commit: PIN.upstream.commit },
};

// The pages this measures, and the one thing that differs between their headers.
const PAGES = [
  { name: 'settings', file: 'settings.html', state: SMALL_STATE, blocks: true, titleOnControlEdge: true },
  { name: 'about', file: 'about.html', state: ABOUT_STATE, blocks: false, titleOnControlEdge: false },
];

const PRELOAD = path.join(PROFILE, 'stub-preload.cjs');
fs.writeFileSync(PRELOAD, `
const { contextBridge } = require('electron');
const state = JSON.parse(process.env.CLAW_CAPTURE_STATE || '{}');
// The DIALOG presentation, which is the one with a way back to the app: as-page
// hides the back control, and this surface's header is half of what is measured.
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
  notices: async () => [],
  onNoticesChanged: () => {},
  bannerHeight: () => {},
  dismissNotice: () => {},
  noticeAction: () => {},
  markNoticesRead: () => {},
});
`);

/**
 * What the page drew, in the order it drew it.
 *
 * The left edge of a TEXT run rather than of its element, because the element's
 * box carries the padding the question is about: the title's own box starts 9px
 * left of where its text does, so measuring the box would report two elements as
 * misaligned when their text is on one edge, and vice versa.
 */
const PROBE = `(() => {
  const textLeft = (node) => {
    if (!node) return null;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let first = walker.nextNode();
    while (first && !first.textContent.trim()) first = walker.nextNode();
    if (!first) return null;
    const range = document.createRange();
    range.selectNodeContents(first);
    return range.getBoundingClientRect().left;
  };
  const box = (node) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  };
  const visible = (node) => {
    if (!node) return false;
    if (node.hidden || node.closest('[hidden]')) return false;
    const r = node.getBoundingClientRect();
    return r.height > 0 && r.width > 0;
  };

  // The blocks of the surface, in the order they are drawn. Every settings group
  // is a block wherever it is held, which is the point: the page holds them in
  // three different kinds of parent (the modal body, a panel, and the list hosts
  // the script fills) and the owner of their spacing has to hold for all three.
  const blocks = [...document.querySelectorAll('.modal__body .tabs, .modal__body .gateway-filter, .modal__body .settings-group, .modal__body .settings-footer')]
    .filter(visible)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    .map((node) => ({
      what: node.id || node.className.split(' ').slice(0, 2).join('.'),
      heldBy: (() => {
        const parent = node.parentElement;
        return parent.id ? '#' + parent.id : parent.className.split(' ').slice(0, 2).join('.');
      })(),
      box: box(node),
      // Read off the element rather than the stylesheet: what matters is the gap
      // the ENGINE drew, which is the only thing that answers whether a rule
      // applied.
      marginTop: getComputedStyle(node).marginTop,
      marginBottom: getComputedStyle(node).marginBottom,
    }));

  const header = document.querySelector('.modal__header');
  const back = document.getElementById('close');
  const title = document.getElementById('title');
  // By that class rather than by an id, because the two pages name this element
  // differently: settings.html calls it subtitle and about.html calls it build,
  // and it is the same line in the same slot of the same borrowed header. An id
  // here measured one page's subtitle and returned a null edge for the other's,
  // which reads as a page with nothing under its title.
  const subtitle = document.getElementById('subtitle') || document.querySelector('.modal__header .sub');
  return {
    width: document.documentElement.clientWidth,
    header: box(header),
    headerPadding: header ? getComputedStyle(header).padding : null,
    back: box(back),
    backPadding: back ? getComputedStyle(back).padding : null,
    backTextLeft: textLeft(back),
    backIcon: box(document.querySelector('.settings-sidebar__back-icon')),
    title: box(title),
    titleTextLeft: textLeft(title),
    titlePadding: title ? getComputedStyle(title).padding : null,
    titleMargin: title ? getComputedStyle(title).margin : null,
    subtitleTextLeft: textLeft(subtitle),
    bodyPadding: getComputedStyle(document.querySelector('.modal__body')).padding,
    firstBlockLeft: blocks.length ? blocks[0].box.left : null,
    blocks,
  };
})()`;

let failed = false;
function check(name, ok, detail = '') {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

/**
 * The pairs of blocks that are touching, and the gap each pair was given.
 *
 * A gap is the distance between one block's bottom and the next one's top, so a
 * negative reading is an overlap and a zero is two blocks flush against each
 * other, which is the fault this measures.
 */
function gaps(probe) {
  return probe.blocks.slice(1).map((block, i) => ({
    after: probe.blocks[i].what,
    heldBy: probe.blocks[i].heldBy,
    before: block.what,
    heldByNext: block.heldBy,
    gap: Math.round((block.box.top - probe.blocks[i].box.bottom) * 100) / 100,
    marginTop: block.marginTop,
  }));
}

// ONE window for every pass, resized and reloaded rather than replaced, which is
// what capture-pages.js does and for the same measured reason: destroying a
// window and opening the next one tears the app down mid-run, and the harness then
// reports a single pass and exits 0 -- a green-looking run that measured one
// quarter of what it claims. A pass therefore takes the previous pass's injected
// sheet back out before it puts its own in, or the earlier pass's palette stays on
// top of the later one's.
let sheet = null;

async function capture(win, page, width, mode) {
  nativeTheme.themeSource = mode;
  process.env.CLAW_CAPTURE_STATE = JSON.stringify(page.state);
  win.setContentSize(width.width, 900);

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await win.loadFile(path.join(UI, page.file));
      break;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${page.file} would not load: ${err.message}`);
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  if (sheet) { await win.webContents.removeInsertedCSS(sheet); sheet = null; }
  // The live theme, exactly as the app injects it (applyThemeCss in main.js), and
  // through the same allowlist the app filters a page's report through.
  sheet = await win.webContents.insertCSS(themeCss(themeFromReport(LIVE_THEME[mode])));
  await new Promise((r) => setTimeout(r, 900));
  const probe = await win.webContents.executeJavaScript(PROBE);
  const shot = path.join(OUT, `${page.name}-${width.name}-${mode}.png`);
  fs.writeFileSync(shot, (await win.capturePage()).toPNG());
  console.log(`SHOT ${shot}`);
  probe.shot = shot;
  return probe;
}

const round = (n) => (n === null || n === undefined ? n : Math.round(n * 100) / 100);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: WIDTHS[0].width,
    height: 900,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  for (const page of PAGES) {
  for (const width of WIDTHS) {
    for (const mode of ['light', 'dark']) {
      const probe = await capture(win, page, width, mode);
      const where = `${page.name} ${width.name} ${mode}`;
      const pairs = gaps(probe);

      console.log(`\n--- ${where} (viewport ${probe.width}px) ---`);
      console.log(`    header padding ${probe.headerPadding} | body padding ${probe.bodyPadding}`);
      console.log(`    back control box left ${round(probe.back.left)} padding ${probe.backPadding}`);
      console.log(`    back text left ${round(probe.backTextLeft)} | back icon box left ${round(probe.backIcon.left)}`);
      console.log(`    title box left ${round(probe.title.left)} padding ${probe.titlePadding} margin ${probe.titleMargin}`);
      console.log(`    title text left ${round(probe.titleTextLeft)} | subtitle text left ${round(probe.subtitleTextLeft)}`);
      console.log(`    first block left ${round(probe.firstBlockLeft)}`);
      for (const p of pairs) {
        console.log(`    gap ${String(p.gap).padStart(7)}px  ${p.heldBy} -> ${p.heldByNext}   ${p.after} .. ${p.before}   (margin-top ${p.marginTop})`);
      }

      // ---- the blocks are separated -------------------------------------
      // The floor is the scale the surface is drawn in: --space-2 (8px) is the
      // smallest separation upstream uses between two blocks, so two blocks closer
      // than that are touching as far as a reader is concerned. It is a floor and
      // not an equality on purpose: this guard is about a gap that vanished, and
      // pinning each pair's own value would turn every deliberate widening into a
      // failure.
      if (page.blocks) {
        const touching = pairs.filter((p) => p.gap < 8);
        check(`${where}: no two blocks of the settings surface are flush`,
          pairs.length >= 4 && touching.length === 0,
          `only ${pairs.length} pairs measured; touching: ${JSON.stringify(touching)}`);
      }

      // ---- the headline starts on the header's own edge -----------------
      // ONE edge for the three things the header holds, which is upstream's
      // arrangement: the back control's 9px inset and the title's 9px inset are the
      // same edge on purpose, and a subtitle belongs on it too. The fault this
      // catches is the title BLOCK having two leading edges, so it is asserted as
      // one claim over all three readings rather than as two pairwise ones: a title
      // that moved and a subtitle that stayed would pass a check written against
      // either one alone.
      const backIconLeft = round(probe.backIcon.left);
      const titleLeft = round(probe.titleTextLeft);
      const subtitleLeft = round(probe.subtitleTextLeft);
      const onEdge = (left) => left !== null && titleLeft !== null && Math.abs(left - titleLeft) <= 0.5;
      check(`${where}: the title and its subtitle share one leading edge`,
        onEdge(subtitleLeft),
        `title ${titleLeft}, subtitle ${subtitleLeft}`);
      if (page.titleOnControlEdge) {
        check(`${where}: and that edge is the back control's own`,
          onEdge(backIconLeft),
          `back icon ${backIconLeft}, title ${titleLeft}, subtitle ${subtitleLeft}`);
      } else {
        // The other header in the app draws its title BESIDE the app's mark, so
        // the control is a column of its own there. Reported so a run says which
        // edges this page has rather than leaving the difference to look like a
        // gap in the measurement.
        console.log(`    note: this page's title column starts at ${titleLeft}, its back control at ${backIconLeft}`);
      }

      // The page's first block is reported and NOT asserted, and that is a fact
      // about the design rather than a tolerance: it sits a border-width to the
      // right of the header's content here (the body's own 22px inset against the
      // header's 12px plus the control's 9px), and upstream does not align those
      // either. Its own settings sidebar pads its navigation 12px while its title
      // sits at 21px, so a column shared with the blocks below is not the
      // arrangement either surface is drawn to.
      console.log(`    note: the page's first block starts at ${round(probe.firstBlockLeft)}, the header's content at ${backIconLeft}`);

      if (REPORT) console.log(`    ${JSON.stringify(probe.blocks.map((b) => [b.what, b.heldBy, round(b.box.top), round(b.box.bottom)]))}`);
    }
  }
  }

  fs.rmSync(PROFILE, { recursive: true, force: true });
  console.log(failed ? '\nFAILED' : `\nOK   ${PAGES.length * WIDTHS.length * 2} measurements in ${OUT}`);
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(`FAIL harness: ${err && err.stack ? err.stack : err}`);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(1);
});
