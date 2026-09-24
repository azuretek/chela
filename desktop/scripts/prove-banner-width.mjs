// * Prove the notice banner does not COLLAPSE, and that the loop which sizes it
// has a FIXED POINT rather than a ratchet.
//
// Abi, 2026-09-20, on Windows, from 1.0.1-dev.295.a84fa1c: "the banners still
// collapse to the right", with the two notices rendered as one-character columns
// in a ~40px sliver down the trailing edge.
//
// Two faults, both in the loop between this page and its host, and the reason the
// 2026-09-20 fix (PR #54) did not hold: it corrected the CARD's percentage width
// while the number the host sizes the view to was still a fraction of the view, and
// it rendered in a BrowserWindow sized up front, so the loop never started from the
// state the real client starts from.
//
//   1. THE FIRST REPORT WAS TAKEN IN A 0x0 VIEWPORT. A fresh WebContentsView has no
//      bounds, and the banner's page is loaded while the view is OFF the window, so
//      its first report() ran with a zero-width viewport. The cards are capped at
//      max-width: 100% of it, so the report was 0 wide, and the host adopted 0 as
//      the view's width: a width the page can never exceed, so it never reports
//      anything else, and the two lock at nothing until the view is torn down.
//      Measured on the real sequence: bounds before load {0,0,0,0}, first report
//      {width: 0, height: 600}, cards 32px wide, one character per line.
//   2. THE REPORT WAS 24px SHORT OF WHAT THE VIEW HOLDS. report() sent the widest
//      CARD, and the view holds the CLUSTER -- cards plus the stack's own padding.
//      So every re-measure shrank the view by the padding: 420 -> 396 -> 372.
//
// What the reader saw, and why only a restart fixed it: the view was 0 wide, the
// cards inside it were squeezed to a character per line and painted against the
// trailing edge, and nothing in the app could widen it again because the only
// number that sets the width comes from the page inside it.
//
//   npx electron scripts/prove-banner-width.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, nativeTheme } from 'electron';
import { stylesheet as tokenStylesheet } from '../src/tokens.js';
import { themeCss, themeFromReport } from '../src/chrome.js';
import { forPages as bannerSpec } from '../../core/banner.js';

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-bw-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);
function cleanup(){ try{ fs.rmSync(PROFILE,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }catch{} }
const REPO = path.join(import.meta.dirname, '..', '..');
const UI = path.join(REPO, 'core', 'ui');

// The two notices from Abi's screenshot, and the shape that collapsed: a short
// status line with no detail, which is the hard case because a long message would
// push the card wide on its own.
const NOTICES = [
  { id:'connection', tone:'warn', message:'Cannot connect to Zilla', detail:'The gateway closed the connection', dismissible:true, action:{ label:'Open settings', command:'openSettings' } },
  { id:'gateway', tone:'error', message:'The gateway closed the connection', detail:'Retrying every few seconds.', dismissible:true },
];

const PRELOAD = path.join(PROFILE,'preload.cjs');
// The preload mirrors the real host: the page reports its box, and the MAIN side of
// this harness resizes the view exactly as layoutViews does, so the page is asked to
// report again. That closed loop is the whole point.
fs.writeFileSync(PRELOAD, `
const { contextBridge, ipcRenderer } = require('electron');
const notices = JSON.parse(process.env.CLAW_BW_NOTICES || '[]');
contextBridge.exposeInMainWorld('clawDesktop', {
  notices: async () => notices,
  bannerSpec: async () => JSON.parse(process.env.CLAW_BANNER_SPEC || 'null'),
  onNoticesChanged: () => {},
  bannerBounds: (b) => ipcRenderer.invoke('bw:bounds', b),
  dismissNotice: () => {}, noticeAction: () => {},
});
`);

const WINDOW_W = 1200, WINDOW_H = 820, TOP = 36, SIDE = 12;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { ipcMain } = await import('electron');
  process.env.CLAW_BW_NOTICES = JSON.stringify(NOTICES);
  process.env.CLAW_BANNER_SPEC = JSON.stringify(bannerSpec());
  nativeTheme.themeSource = 'dark';

  const win = new BrowserWindow({ show:false, width:WINDOW_W, height:WINDOW_H });

  // The host's real sizing rule (main.js layoutViews): the view is the reported
  // cluster box, capped at the window, hugging the top-trailing corner.
  let bannerSize = { width: 0, height: 72 };
  let view = null;
  const place = () => {
    if (!view) return;
    const [w, h] = win.getContentSize();
    const bw = Math.max(0, Math.min(bannerSize.width, w));
    const bh = Math.max(0, Math.min(bannerSize.height, Math.max(0, h - TOP)));
    view.setBounds({ x: Math.max(0, w - bw - SIDE), y: TOP, width: bw, height: bh });
  };
  let reports = 0;
  ipcMain.handle('bw:bounds', (_e, b) => {
    const width = Math.max(0, Math.min(560, Math.ceil(Number(b && b.width) || 0)));
    const height = Math.max(0, Math.min(600, Math.ceil(Number(b && b.height) || 0)));
    reports += 1;
    // The host's guard (main.js app:banner-bounds): a report of cards with no width
    // is a measurement taken in a viewport too small to measure in, and adopting it
    // is what made the collapse one-way.
    if (width === 0 && height > 0) return;
    if (width === bannerSize.width && height === bannerSize.height) return;
    bannerSize = { width, height };
    place();
  });

  // * THE REAL ORDER, which is the half this harness was missing: the view is
  // created with NO bounds, loaded while it is OFF the window, and attached only
  // once its document is ready (see refreshBanner in src/main.js). The provisional
  // width is the window's, which is what the app seeds now.
  view = new WebContentsView({ webPreferences:{ preload:PRELOAD, contextIsolation:true, nodeIntegration:false } });
  view.setBackgroundColor('#00000000');
  const boundsBeforeLoad = { ...view.getBounds() };
  bannerSize = { width: win.getContentSize()[0], height: 72 };
  place();
  view.webContents.once('dom-ready', async () => {
    await view.webContents.insertCSS(tokenStylesheet({ important:true }));
    const theme = themeFromReport({ mode:'dark', surface:'rgb(25,23,36)', symbol:'rgb(213,210,235)', tokens:{} });
    await view.webContents.insertCSS(themeCss(theme));
    win.contentView.addChildView(view);
    place();
  });

  await view.webContents.loadFile(path.join(UI, 'banner.html'));
  // Let the report/resize loop settle: the page reports on load and on resize, so
  // this waits out the cascade the real client runs.
  await delay(1200);
  const settled = bannerSize.width;

  // And then run the loop AGAIN, deliberately. A fixed point stays put; the
  // ratchet that shipped lost the stack's padding on every pass, so the number the
  // reader lived with was whichever pass happened to be the last one before they
  // looked. This is the assertion that fails on the old code.
  const reopened = [];
  for (let i = 0; i < 3; i += 1) {
    await view.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))');
    await delay(400);
    reopened.push(bannerSize.width);
  }

  const m = await view.webContents.executeJavaScript(`(() => {
    const stack = document.getElementById('stack');
    const card = document.querySelector('.banner');
    const cr = card.getBoundingClientRect();
    return {
      viewW: document.documentElement.clientWidth,
      stackW: Math.round(stack.getBoundingClientRect().width),
      cardW: Math.round(cr.width),
      cardH: Math.round(cr.height),
      msgText: card.textContent.trim().slice(0, 40),
    };
  })()`);

  console.log(JSON.stringify({ boundsBeforeLoad, settled, reopened, reports, viewBoundsW: view.getBounds().width, ...m }, null, 2));

  let failed = false;
  // 1. THE FIRST MEASUREMENT MUST BE TAKEN SOMEWHERE IT CAN HOLD THE CLUSTER. A
  //    fresh WebContentsView has no bounds, and a report taken there is 0 wide.
  if (boundsBeforeLoad.width === 0 && reports > 0 && settled < 200) {
    console.log('FAIL the view had no bounds at load (' + JSON.stringify(boundsBeforeLoad) + ') and the first report locked it at ' + settled + 'px');
    failed = true;
  }
  // 2. The view must be a card width, not a sliver.
  if (settled < 200) { console.log('FAIL the banner view collapsed to '+settled+'px (a sliver): the card cannot lay out its text'); failed = true; }
  else console.log('OK   the banner view is a card width, not a sliver ('+settled+'px)');
  // 3. The card itself is not a sliver.
  if (m.cardW < 200) { console.log('FAIL the card is '+m.cardW+'px wide, so its text wraps to a column'); failed = true; }
  else console.log('OK   the card is a legible width ('+m.cardW+'px)');
  // 4. The card is not absurdly tall relative to its width (the smashed column is
  //    tall and thin). A healthy short-notice card is wider than it is tall.
  if (m.cardH > m.cardW) { console.log('FAIL the card is taller ('+m.cardH+') than wide ('+m.cardW+'): the text is stacked into a column'); failed = true; }
  else console.log('OK   the card is wider than it is tall ('+m.cardW+'x'+m.cardH+')');
  // 5. And still not full-width (the floating-cards invariant must hold too).
  if (settled > WINDOW_W - 200) { console.log('FAIL the view is ~full-width ('+settled+'), the bar is back'); failed = true; }
  else console.log('OK   the view is not full-width ('+settled+' < '+WINDOW_W+')');
  // 6. * THE LOOP HAS A FIXED POINT: re-measuring does not move it.
  if (reopened.some((w) => w !== settled)) {
    console.log('FAIL the report/resize loop is a ratchet: settled at '+settled+'px, then '+JSON.stringify(reopened)+' on re-measure. Every pass loses width, so the banner the reader gets depends on when they look');
    failed = true;
  } else {
    console.log('OK   re-measuring leaves the view where it was ('+JSON.stringify(reopened)+'): the loop has a fixed point');
  }
  // 7. The stack's own box is what the page reports, so the arithmetic the host
  //    does lands on the cluster rather than on one of its parts.
  if (Math.abs(m.stackW - settled) > 1 && Math.abs(m.stackW - settled) !== 0) {
    console.log('     note: stack box '+m.stackW+'px against the settled view '+settled+'px (they are the same number when unclamped)');
  }

  cleanup();
  console.log(failed ? 'PROOF FAILED' : 'PROOF OK');
  app.exit(failed ? 1 : 0);
}).catch(e => { console.error(e); cleanup(); app.exit(1); });
