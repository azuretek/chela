// The About page's own geometry and palette, measured on the page.
//
//   npx electron scripts/test-about-surface.js [--appearance light|dark] [--shots DIR]
//
// Three reports about the About surface, all of them measured rather than read:
//
//   1. the space below the LAST thing in a section, which Abi reported as visibly
//      short at the foot of "Cached Control UI code". A section is a settings-group
//      and its bottom padding is the last row's, so this reads the gap between the
//      control and the group's own bottom edge and compares it with the same gap at
//      the section's top;
//   2. what the page paints behind and around its card. The page draws its card on
//      a translucent wash (--scrim is --bg at 70%), and on the phone the web view
//      behind it is painted by the HOST (mobile/Chela/AboutView.swift sets the
//      web view and its scroll view to .systemBackground while the page reports its
//      own --bg). Two shades meeting at the card's edge is what that composits to,
//      so this reads the wash's own alpha and the two colours that meet;
//   3. the accent. Both our surfaces take ONE resolved palette, so anything that
//      looks like two accents needs naming: this reads --accent and --primary and
//      the colour of every element that carries either, on BOTH pages, so the claim
//      "these are two different tokens by design" can be checked rather than
//      asserted.
//
// The palette is seeded and distinctive on purpose (accent and primary deliberately
// far apart), because against the default palette every one of these faults is
// invisible: that is how they got here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';

import { stylesheet as tokenStylesheet } from '../src/tokens.js';
import { themeCss, themeFromReport } from '../src/chrome.js';

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const APPEARANCE = flag('appearance', 'dark');
if (!['light', 'dark'].includes(APPEARANCE)) throw new Error(`unknown appearance ${APPEARANCE}`);
const SHOTS = flag('shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
// `--palette none` is the third case the report asks about, and it is the one a
// shade mismatch hides in: with nothing resolved the page wears ui.css's own
// palette whole, and the host has no colour to paint with. Both halves have to be
// deliberate rather than accidental, so the run measures the page and says what
// the host is left holding.
const PALETTE = flag('palette', 'seeded');
if (!['seeded', 'none'].includes(PALETTE)) throw new Error(`unknown palette ${PALETTE}`);

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-about-surface-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

const REPO = path.join(import.meta.dirname, '..', '..');
const UI = path.join(REPO, 'core', 'ui');

/**
 * The palette this run publishes, and it is chosen to make the two accents TELL
 * THEMSELVES APART: the accent is a pink and the primary a deep red, so an element
 * that takes the wrong one cannot be mistaken for a rounding difference. The
 * surface colours are the plum the earlier report used.
 */
const SEED = APPEARANCE === 'dark'
  ? {
    mode: 'dark',
    surface: 'rgb(25, 23, 36)',
    symbol: 'rgb(213, 210, 235)',
    tokens: {
      '--bg': 'rgb(25, 23, 36)',
      '--bg-elevated': 'rgb(31, 29, 46)',
      '--bg-hover': 'rgb(38, 35, 58)',
      '--panel': 'rgb(25, 23, 36)',
      '--panel-hover': 'rgb(38, 35, 58)',
      '--panel-strong': 'rgb(31, 29, 46)',
      '--card': 'rgb(31, 29, 46)',
      '--input': 'rgb(41, 38, 60)',
      '--text': 'rgb(213, 210, 235)',
      '--text-strong': 'rgb(239, 237, 250)',
      '--muted': 'rgb(151, 147, 176)',
      '--muted-strong': 'rgb(172, 168, 196)',
      '--border': 'rgb(41, 38, 60)',
      '--border-strong': 'rgb(61, 57, 88)',
      '--border-hover': 'rgb(84, 80, 120)',
      '--accent': 'rgb(255, 92, 158)',
      '--accent-hover': 'rgb(255, 122, 178)',
      '--accent-subtle': 'rgba(255, 92, 158, 0.14)',
      '--primary': 'rgb(153, 27, 27)',
      '--primary-hover': 'rgb(185, 28, 28)',
      '--primary-foreground': 'rgb(255, 255, 255)',
      '--destructive': 'rgb(211, 47, 47)',
      '--ring': 'rgb(255, 92, 158)',
    },
  }
  : {
    mode: 'light',
    surface: 'rgb(250, 244, 237)',
    symbol: 'rgb(87, 82, 121)',
    tokens: {
      '--bg': 'rgb(250, 244, 237)',
      '--bg-elevated': 'rgb(255, 252, 250)',
      '--bg-hover': 'rgb(240, 231, 222)',
      '--panel': 'rgb(250, 244, 237)',
      '--panel-hover': 'rgb(240, 231, 222)',
      '--panel-strong': 'rgb(255, 250, 243)',
      '--card': 'rgb(255, 252, 250)',
      '--input': 'rgb(242, 233, 225)',
      '--text': 'rgb(87, 82, 121)',
      '--text-strong': 'rgb(38, 35, 58)',
      '--muted': 'rgb(121, 116, 154)',
      '--muted-strong': 'rgb(102, 97, 138)',
      '--border': 'rgb(224, 217, 208)',
      '--border-strong': 'rgb(203, 194, 186)',
      '--border-hover': 'rgb(172, 164, 156)',
      '--accent': 'rgb(255, 92, 158)',
      '--accent-hover': 'rgb(255, 122, 178)',
      '--accent-subtle': 'rgba(255, 92, 158, 0.10)',
      '--primary': 'rgb(153, 27, 27)',
      '--primary-hover': 'rgb(140, 68, 90)',
      '--primary-foreground': 'rgb(255, 255, 255)',
      '--destructive': 'rgb(180, 60, 90)',
      '--ring': 'rgb(255, 92, 158)',
    },
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
    { label: 'Control UI', value: '2026.9.4 (362492d734)' },
  ],
  controlUI: { version: '2026.9.4', commit: '362492d734' },
};

const SETTINGS_STATE = {
  client: 'desktop',
  surface: JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'settings.json'), 'utf8')),
  gateways: [{ id: 'alpha', label: 'Alpha gateway', url: 'https://gateway.example.ts.net/', credentials: { hasToken: true, hasPassword: false, headers: [] }, status: { tone: 'ok', label: 'Connected', detail: null } }],
  activeGatewayId: 'alpha',
  connection: { phase: 'connected' },
  settings: { closeToTray: true, autoUpdate: true, promptMetadata: false, globalShortcut: 'CommandOrControl+Shift+O' },
  appearance: { mode: 'system' },
  build: '1.0.0 (source)',
  certOffers: [], trustedCerts: {}, updates: {}, secretsError: null,
};

const PRELOAD = path.join(PROFILE, 'stub-preload.cjs');
fs.writeFileSync(PRELOAD, `
const { contextBridge } = require('electron');
const state = JSON.parse(process.env.CLAW_CAPTURE_STATE || '{}');
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
  clearCacheAndReload: async () => ({ cleared: [], failed: [], origins: [], gateway: null }),
  onCacheCleared: () => {},
  notices: async () => [],
  onNoticesChanged: () => {},
  bannerHeight: () => {},
  dismissNotice: () => {},
  noticeAction: () => {},
  markNoticesRead: () => {},
});
`);

let failed = false;
function check(name, ok, detail = '') {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

/**
 * What the page paints and how it is spaced, read off the rendered document.
 *
 * Every box is a real rect, and the gaps are differences between them, because the
 * questions here are about pixels: a padding that "looks short" is a number, and a
 * wash that meets a card at an edge is an alpha.
 */
const PROBE = `(() => {
  const root = getComputedStyle(document.documentElement);
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
  const scrim = document.querySelector('.scrim');
  const group = document.getElementById('clear-cache-group');
  const rows = group ? [...group.querySelectorAll('.settings-row')] : [];
  const lastRow = rows.length ? rows[rows.length - 1] : null;
  const button = group ? group.querySelector('button') : null;
  const firstRow = rows.length ? rows[0] : null;
  const colour = (el, prop) => (el ? getComputedStyle(el)[prop] : null);
  const painted = (sel) => {
    const el = document.querySelector(sel);
    return el ? {
      background: getComputedStyle(el).backgroundColor,
      color: getComputedStyle(el).color,
      border: getComputedStyle(el).borderTopColor,
      bottomBorder: getComputedStyle(el).borderBottomColor,
    } : null;
  };
  return {
    page: location.pathname.split('/').pop(),
    colorScheme: root.colorScheme.trim(),
    bodyClass: document.body.className,
    tokens: {
      bg: root.getPropertyValue('--bg').trim(),
      card: root.getPropertyValue('--card').trim(),
      accent: root.getPropertyValue('--accent').trim(),
      primary: root.getPropertyValue('--primary').trim(),
    },
    scrim: scrim ? { background: getComputedStyle(scrim).backgroundColor, paddingTop: getComputedStyle(scrim).paddingTop, paddingBottom: getComputedStyle(scrim).paddingBottom } : null,
    cardSurface: group ? getComputedStyle(group).backgroundColor : null,
    // The page's own fit: how much room the card has above it, and how much the
    // page leaves below its last element. A page whose bottom is tighter than its
    // top is the "padding is visibly short" report, measured rather than eyeballed.
    fit: (function () {
      const groups = [...document.querySelectorAll('.settings-group')];
      const holders = [...document.querySelectorAll('.modal__body > *, #facts')];
      const last = groups.length ? groups[groups.length - 1] : null;
      const bodyRect = document.body.getBoundingClientRect();
      const scrimRect = scrim ? scrim.getBoundingClientRect() : null;
      const content = document.querySelector('.modal__body') || document.querySelector('.modal');
      const contentRect = content ? content.getBoundingClientRect() : null;
      return {
        groups: groups.length,
        holders: holders.length,
        firstGroupTop: groups.length ? Math.round(groups[0].getBoundingClientRect().top) : null,
        lastGroupBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
        lastGroupBottomToBodyEnd: last ? Math.round(bodyRect.bottom - last.getBoundingClientRect().bottom) : null,
        lastGroupBottomToContentEnd: (last && contentRect) ? Math.round(contentRect.bottom - last.getBoundingClientRect().bottom) : null,
        scrimTop: scrimRect ? Math.round(scrimRect.top) : null,
        scrimBottom: scrimRect ? Math.round(scrimRect.bottom) : null,
        cardTopGap: scrimRect && groups.length ? Math.round(groups[0].getBoundingClientRect().top - scrimRect.top) : null,
        cardBottomGap: (scrimRect && last) ? Math.round(scrimRect.bottom - last.getBoundingClientRect().bottom) : null,
        bodyHeight: Math.round(bodyRect.height),
        scrollHeight: Math.round(document.documentElement.scrollHeight),
      };
    })(),
    // The action rows themselves, measured box by box: the two sections are
    // structurally identical, so whatever makes one foot 46px and the other 13px is
    // in the SHAPE of the row rather than in the spacing scale.
    actionRows: [...document.querySelectorAll('.settings-group .settings-row--actions')].map(function (row, i) {
      const control = row.querySelector('.settings-row__control');
      const buttons = [...row.querySelectorAll('button')];
      const results = [...row.querySelectorAll('.result')];
      const group = row.closest('.settings-group');
      const title = group ? group.querySelector('.settings-row__title') : null;
      const height = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
      const bottom = (el) => (el ? Math.round(el.getBoundingClientRect().bottom) : null);
      return {
        which: title ? title.textContent.trim() : String(i),
        rowHeight: height(row),
        controlHeight: height(control),
        buttonHeights: buttons.map((b) => height(b)),
        buttonBottoms: buttons.map((b) => bottom(b)),
        rowBottom: bottom(row),
        group: group ? (group.id || (group.querySelector('.settings-row__title') || {}).textContent || '') : '',
        resultCount: results.length,
        resultHeights: results.map((r) => height(r)),
        resultDisplay: results.map((r) => getComputedStyle(r).display),
        rowPadding: getComputedStyle(row).padding,
        controlWrap: getComputedStyle(control).flexWrap,
        controlGap: getComputedStyle(control).gap,
      };
    }),
    // EVERY section's own spacing, so a section that is tighter at its foot than
    // the section above it can be told from a rhythm shared by both.
    sections: [...document.querySelectorAll('.settings-group')].map(function (g) {
      const rows = [...g.querySelectorAll('.settings-row')];
      const title = g.querySelector('.settings-row__title');
      const controls = [...g.querySelectorAll('button')];
      const last = controls.length ? controls[controls.length - 1] : null;
      const first = rows.length ? rows[0] : null;
      return {
        title: title ? title.textContent.trim() : null,
        contentBottomGap: last ? Math.round(g.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom) : null,
        contentTopGap: first ? Math.round(first.getBoundingClientRect().top - g.getBoundingClientRect().top) : null,
        rowBottomPad: rows.length ? getComputedStyle(rows[rows.length - 1]).paddingBottom : null,
        gapAboveControls: (last && rows.length > 1)
          ? Math.round(last.getBoundingClientRect().top - rows[rows.length - 2].getBoundingClientRect().bottom)
          : null,
      };
    }),
    // The section's own spacing, top against bottom.
    section: group && button ? {
      topGap: Math.round(box(firstRow).top - box(group).top),
      bottomGap: Math.round(box(group).bottom - box(button).bottom),
      rowBottomPad: getComputedStyle(lastRow).paddingBottom,
      rowTopPad: getComputedStyle(firstRow).paddingTop,
      actionRowPadBottom: getComputedStyle(group.querySelector('.settings-row--actions') || lastRow).paddingBottom,
      radius: getComputedStyle(group).borderBottomLeftRadius,
    } : null,
    // What a reader sees at the card's edge: the page's own background, the wash
    // over it, and the card, in the order they are painted.
    edge: scrim && group ? { wash: getComputedStyle(scrim).backgroundColor, card: getComputedStyle(group).backgroundColor, page: getComputedStyle(document.documentElement).backgroundColor } : null,
    accents: {
      accentToken: root.getPropertyValue('--accent').trim(),
      primaryToken: root.getPropertyValue('--primary').trim(),
      selectedTab: painted('.tab[aria-selected="true"]'),
      primaryButton: painted('button.primary'),
      plainButton: painted('button:not(.primary):not(.ghost)'),
      link: painted('a'),
      activeBadge: painted('.badge'),
    },
  };
})()`;

const PAGES = [
  { name: 'about', file: 'about.html', state: ABOUT_STATE, width: 402 },
  { name: 'about-wide', file: 'about.html', state: ABOUT_STATE, width: 900 },
  { name: 'settings', file: 'settings.html', state: SETTINGS_STATE, width: 402 },
];

app.whenReady().then(async () => {
  nativeTheme.themeSource = APPEARANCE;
  const theme = themeCss(themeFromReport(SEED));
  let appended = null;

  for (const page of PAGES) {
    process.env.CLAW_CAPTURE_STATE = JSON.stringify(page.state);
    const win = new BrowserWindow({
      show: false,
      width: page.width,
      height: 900,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    await win.loadFile(path.join(UI, page.file));
    if (appended) { await win.webContents.removeInsertedCSS(appended); appended = null; }
    // With no palette there is no live theme to inject: this is the run where the
    // page is on its own fallbacks, which is exactly what must be checked rather
    // than assumed (a page that only looked right because a theme was injected is
    // a page that will be wrong on a first run).
    if (PALETTE === 'seeded') appended = await win.webContents.insertCSS(theme);
    await new Promise((r) => setTimeout(r, 900));

    const measured = await win.webContents.executeJavaScript(PROBE);
    console.log(`     ${page.name} ${APPEARANCE} ${JSON.stringify(measured)}`);
    if (SHOTS) {
      const file = path.join(SHOTS, `${page.name}-${APPEARANCE}-${page.width}.png`);
      fs.writeFileSync(file, (await win.capturePage()).toPNG());
      console.log(`SHOT ${file}`);
    }

    if (page.name === 'about' && PALETTE === 'none') {
      // Nothing resolved: the page must still paint a whole palette of its own,
      // and the geometry must be identical to the seeded run, because the spacing
      // is the page's rather than the palette's.
      console.log(`     ${page.name} no-palette: tokens ${JSON.stringify(measured.tokens)} feet ${JSON.stringify((measured.sections || []).map((s) => s.contentBottomGap))}`);
      check(`${page.name}: with no palette the page still paints its own background`,
        Boolean(measured.tokens.bg) && Boolean(measured.tokens.card) && measured.tokens.bg !== measured.tokens.card,
        JSON.stringify(measured.tokens));
      const feet = (measured.sections || []).map((s) => s.contentBottomGap).filter((v) => typeof v === 'number');
      check(`${page.name}: and its two feet still agree, on the page's own palette`,
        feet.length > 1 && feet.every((v) => Math.abs(v - feet[0]) <= 1), JSON.stringify(feet));
      check(`${page.name}: and that foot still clears the corner radius`,
        Number.isFinite(measured.section.bottomGap)
          && parseFloat(measured.section.radius || '0') <= measured.section.bottomGap,
        JSON.stringify(measured.section));
    }

    if (page.name === 'about' && PALETTE === 'seeded') {
      // The page takes the seeded palette whole.
      check(`${page.name}: the page takes the published palette`,
        measured.tokens.bg === SEED.tokens['--bg'] && measured.tokens.card === SEED.tokens['--card'],
        JSON.stringify(measured.tokens));
      // The wash around the card is TRANSLUCENT, so whatever is behind the page
      // shows through it: that is what the host has to match. Read as an alpha
      // rather than assumed, because the whole fix depends on it.
      // Two shapes, and the alpha is at the end of BOTH: \`rgba(r, g, b, a)\` and the
      // \`color(srgb r g b / a)\` Chromium answers with for a colour it had to mix.
      const wash = (measured.edge || {}).wash || '';
      const tail = /[\d.]+\s*\)?\s*$/.exec(wash);
      const alpha = (wash.includes('/') || wash.startsWith('rgba')) && tail
        ? Number(tail[0].replace(/[^\d.]/g, ''))
        : 1;
      check(`${page.name}: the wash around the card is translucent, so the host shows through it`,
        Number.isFinite(alpha) && alpha < 1,
        `the wash is ${wash} (alpha ${alpha}), so nothing behind it can show through`);
      // The section's own bottom gap, against its top: the report is that it is
      // visibly short, so the numbers have to be able to disagree.
      const section = measured.section || {};
      console.log(`     ${page.name}: section top gap ${section.topGap}, bottom gap ${section.bottomGap}, row padding ${section.rowTopPad} / ${section.rowBottomPad}`);
      console.log(`     ${page.name}: fit ${JSON.stringify(measured.fit)}`);
      console.log(`     ${page.name}: sections ${JSON.stringify(measured.sections)}`);
      console.log(`     ${page.name}: actionRows ${JSON.stringify(measured.actionRows)}`);
      check(`${page.name}: the last section's bottom gap is not smaller than its top`,
        Number.isFinite(section.bottomGap) && Number.isFinite(section.topGap) && section.bottomGap >= section.topGap,
        `top ${section.topGap} vs bottom ${section.bottomGap}`);
      // The feet AGREE, which is what the report was about: one page, two feet,
      // 13px against 46px before this change.
      const feet = (measured.sections || []).map((s) => s.contentBottomGap).filter((v) => typeof v === 'number');
      const feetEqual = feet.length > 1 && feet.every((v) => Math.abs(v - feet[0]) <= 1);
      console.log(`     ${page.name}: section feet ${JSON.stringify(feet)}, action row foot padding ${section.actionRowPadBottom}, radius ${section.radius}`);
      check(`${page.name}: every section's foot is the row's own padding, not a wrapped empty reply line`,
        feetEqual, `the feet are ${JSON.stringify(feet)}`);
      check(`${page.name}: and that foot clears the card's own corner radius`,
        Number.isFinite(section.bottomGap) && parseFloat(section.radius || '0') <= section.bottomGap,
        `foot ${section.bottomGap} vs radius ${section.radius}`);
      // And the accent question, on this page.
      const accents = measured.accents;
      check(`${page.name}: --accent and --primary are the published ones, and they differ`,
        accents.accentToken === SEED.tokens['--accent'] && accents.primaryToken === SEED.tokens['--primary']
          && accents.accentToken !== accents.primaryToken,
        JSON.stringify({ accent: accents.accentToken, primary: accents.primaryToken }));
      if (accents.primaryButton) {
        check(`${page.name}: an action button takes --primary, not the accent`,
          accents.primaryButton.background === SEED.tokens['--primary'],
          JSON.stringify(accents.primaryButton));
      }
    }

    if (page.name === 'settings' && PALETTE === 'seeded') {
      const accents = measured.accents;
      check('settings: --accent and --primary are the SAME published pair as About sees',
        accents.accentToken === SEED.tokens['--accent'] && accents.primaryToken === SEED.tokens['--primary'],
        JSON.stringify({ accent: accents.accentToken, primary: accents.primaryToken }));
      check('settings: the selected tab is the ACCENT token',
        Boolean(accents.selectedTab) && (accents.selectedTab.bottomBorder === SEED.tokens['--accent'] || accents.selectedTab.border === SEED.tokens['--accent']),
        JSON.stringify(accents.selectedTab));
    }
  }

  console.log(failed ? 'FAILED' : 'ALL OK');
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(`FAIL harness: ${err && err.stack ? err.stack : err}`);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(1);
});
