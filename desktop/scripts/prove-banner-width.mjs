// ★ Prove the notice banner does not COLLAPSE to a sliver (the width regression).
//
// Abi, 2026-09-20, on Windows: the banner came up crushed into a ~30px column on
// the right edge, one word per line. The floating-cards change (PR #52) sized the
// view to the card cluster, but the card's width was capped at max-width: 100% OF
// THE VIEW, and the view is sized FROM the card. That is a feedback loop: if the
// view is ever narrow when report() runs, the card is clamped to that width, the
// host sizes the view to the clamped card, and the two lock at the smallest size.
//
// prove-floating-cards.mjs did not catch this because it renders the banner in a
// BrowserWindow at a FIXED width and measures the card there. The collapse only
// happens in the real WebContentsView loop: the view starts provisional, the page
// reports, the host resizes, the page reports again. This runs that actual loop
// against a WebContentsView whose window is the size of the reader's, so the card
// either settles at its intended width or collapses the way it did on Windows.
//
//   npx electron scripts/prove-banner-width.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, nativeTheme } from 'electron';
import { stylesheet as tokenStylesheet } from '../src/tokens.js';
import { themeCss, themeFromReport } from '../src/chrome.js';

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-bw-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);
function cleanup(){ try{ fs.rmSync(PROFILE,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }catch{} }
const REPO = path.join(import.meta.dirname, '..', '..');
const UI = path.join(REPO, 'core', 'ui');

// The exact notice from Abi's screenshot: a one-line status with no detail. A
// short message is the hard case, because a long one would push the card wide on
// its own; \"up to date\" is what collapsed.
const NOTICES = [{ id:'uptodate', tone:'info', message:'Claw Control UI is up to date.', detail:'You are on 1.0.1-dev.292.', dismissible:true }];

const PRELOAD = path.join(PROFILE,'preload.cjs');
// The preload mirrors the real host: it exposes bannerBounds, and the MAIN side
// of this harness resizes the view when the page reports, then the page is asked
// to report again. That closed loop is the whole point.
fs.writeFileSync(PRELOAD, `
const { contextBridge, ipcRenderer } = require('electron');
const notices = JSON.parse(process.env.CLAW_BW_NOTICES || '[]');
contextBridge.exposeInMainWorld('clawDesktop', {
  notices: async () => notices,
  onNoticesChanged: () => {},
  bannerBounds: (b) => ipcRenderer.invoke('bw:bounds', b),
  dismissNotice: () => {}, noticeAction: () => {},
});
`);

const WINDOW_W = 1200, WINDOW_H = 820, TOP = 36, SIDE = 12;

app.whenReady().then(async () => {
  const { ipcMain } = await import('electron');
  process.env.CLAW_BW_NOTICES = JSON.stringify(NOTICES);
  nativeTheme.themeSource = 'dark';

  const win = new BrowserWindow({ show:false, width:WINDOW_W, height:WINDOW_H });
  const view = new WebContentsView({ webPreferences:{ preload:PRELOAD, contextIsolation:true, nodeIntegration:false } });
  view.setBackgroundColor('#00000000');
  win.contentView.addChildView(view);

  // The host's real sizing rule (main.js layoutViews): the view is the reported
  // card box, capped at the window, right-aligned with a 12px inset. bannerSize
  // starts provisional, exactly as main.js seeds it.
  let bannerSize = { width: 420, height: 72 };
  const place = () => {
    const [w, h] = win.getContentSize();
    const bw = Math.max(0, Math.min(bannerSize.width, w));
    const bh = Math.max(0, Math.min(bannerSize.height, Math.max(0, h - TOP)));
    view.setBounds({ x: Math.max(0, w - bw - SIDE), y: TOP, width: bw, height: bh });
  };
  place();

  let reports = 0;
  ipcMain.handle('bw:bounds', (_e, b) => {
    const width = Math.max(0, Math.min(560, Math.ceil(Number(b && b.width) || 0)));
    const height = Math.max(0, Math.min(600, Math.ceil(Number(b && b.height) || 0)));
    reports += 1;
    if (width === bannerSize.width && height === bannerSize.height) return;
    bannerSize = { width, height };
    place();
  });

  await view.webContents.loadFile(path.join(UI, 'banner.html'));
  await view.webContents.insertCSS(tokenStylesheet({ important:true }));
  const theme = themeFromReport({ mode:'dark', surface:'rgb(25,23,36)', symbol:'rgb(213,210,235)', tokens:{} });
  await view.webContents.insertCSS(themeCss(theme));

  // Let the report/resize loop settle. The page reports on load and on resize, so
  // this waits out the cascade the real client runs.
  await new Promise(r => setTimeout(r, 1200));

  const m = await view.webContents.executeJavaScript(`(() => {
    const stack = document.getElementById('stack');
    const card = document.querySelector('.banner');
    const msg = document.querySelector('.banner__message, .banner-message, .banner p, .banner');
    const cr = card.getBoundingClientRect();
    // The message text's own line count: a collapse wraps a short line into many.
    const text = card.textContent.trim();
    // Widest word, to reason about wrapping-to-slivers independent of font metrics.
    return {
      viewW: document.documentElement.clientWidth,
      cardW: Math.round(cr.width),
      cardH: Math.round(cr.height),
      cardScrollW: card.scrollWidth,
      msgText: text.slice(0, 40),
    };
  })()`);

  const viewBoundsW = view.getBounds().width;
  console.log(JSON.stringify({ ...m, viewBoundsW, bannerSizeW: bannerSize.width, reports }, null, 2));

  let failed = false;
  // 1. The view (and so the card) must be wide enough to be a card, not a sliver.
  //    A real card is ~300-420px; anything under 200 is the collapse. Read from
  //    the host's own bannerSize, which is what it would set the view to.
  if (bannerSize.width < 200) { console.log('FAIL the banner view collapsed to '+bannerSize.width+'px (a sliver): the card cannot lay out its text'); failed = true; }
  else console.log('OK   the banner view is a card width, not a sliver ('+bannerSize.width+'px)');
  // 2. The card itself is not a sliver.
  if (m.cardW < 200) { console.log('FAIL the card is '+m.cardW+'px wide, so its text wraps to a column'); failed = true; }
  else console.log('OK   the card is a legible width ('+m.cardW+'px)');
  // 3. The card is not absurdly tall relative to its width (the smashed column is
  //    tall and thin). A healthy short-notice card is wider than it is tall.
  if (m.cardH > m.cardW) { console.log('FAIL the card is taller ('+m.cardH+') than wide ('+m.cardW+'): the text is stacked into a column'); failed = true; }
  else console.log('OK   the card is wider than it is tall ('+m.cardW+'x'+m.cardH+')');
  // 4. And still not full-width (the floating-cards invariant must hold too),
  //    read from the host's bannerSize, which is what it sizes the view to.
  if (bannerSize.width > WINDOW_W - 200) { console.log('FAIL the view is ~full-width ('+bannerSize.width+'), the bar is back'); failed = true; }
  else console.log('OK   the view is not full-width ('+bannerSize.width+' < '+WINDOW_W+')');

  cleanup();
  console.log(failed ? 'PROOF FAILED' : 'PROOF OK');
  app.exit(failed ? 1 : 0);
}).catch(e => { console.error(e); cleanup(); app.exit(1); });
