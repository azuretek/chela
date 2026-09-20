// Prove the notice banner is FLOATING CARDS, not a full-width bar (#4).
//
// Abi, 2026-09-19: "floating cards no full width bar that's pointless". The bar's
// dead-zone came from the view spanning the window: a WebContentsView claims every
// click in its rectangle whatever it paints, so the empty strip beside the card
// ate clicks on the Control UI. The fix sizes the view to the card cluster. This
// proves the two facts that make click-through true, without a real-click harness:
//   1. the cluster's reported box is NARROWER than the window (not full-width);
//   2. the stack paints a TRANSPARENT background, so its own area outside the
//      cards is see-through (and the view is sized to the cards, so those pixels
//      are not even in the view).
// It also confirms the card still carries its own opaque-enough surface, so a
// floating card is still legible over the page.
//
//   npx electron scripts/prove-floating-cards.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { stylesheet as tokenStylesheet } from '../src/tokens.js';
import { themeCss, themeFromReport } from '../src/chrome.js';

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-float-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);
function removeProfile(){ try{ fs.rmSync(PROFILE,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }catch{} }
const REPO = path.join(import.meta.dirname, '..', '..');
const UI = path.join(REPO, 'core', 'ui');

// One error notice, the "Cannot connect" shape from the screenshots.
const NOTICES = [{ id:'conn', tone:'error', message:'Cannot connect to Zilla', detail:'The connection was refused. The gateway may not be running. (ERR_CONNECTION_REFUSED)', dismissible:true, action:{ label:'Open Settings', command:'open-settings' } }];
const PRELOAD = path.join(PROFILE,'stub.cjs');
fs.writeFileSync(PRELOAD, `
const { contextBridge, ipcRenderer } = require('electron');
const notices = JSON.parse(process.env.CLAW_FLOAT_NOTICES || '[]');
let reported = null;
contextBridge.exposeInMainWorld('clawDesktop',{
  notices: async()=>notices,
  onNoticesChanged: ()=>{},
  bannerBounds: (b)=>{ reported = b; return Promise.resolve(); },
  dismissNotice: ()=>{}, noticeAction: ()=>{},
});
contextBridge.exposeInMainWorld('__probe',{ reported: ()=>reported });
`);

const PROBE = `(() => {
  const stack = document.getElementById('stack');
  const card = document.querySelector('.banner');
  const de = document.documentElement;
  const stackBg = getComputedStyle(stack).backgroundColor;
  const cardBg = getComputedStyle(card).backgroundColor;
  const sr = stack.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  return {
    windowW: de.clientWidth,
    reported: window.__probe.reported(),
    stackRight: Math.round(sr.right), stackLeft: Math.round(sr.left), stackWidth: Math.round(sr.width),
    cardRight: Math.round(cr.right), cardWidth: Math.round(cr.width),
    stackBg, cardBg,
    stackRightAligned: Math.abs(sr.right - de.clientWidth) < 40,
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show:false, width:1200, height:400, webPreferences:{ preload:PRELOAD, contextIsolation:true, nodeIntegration:false } });
  process.env.CLAW_FLOAT_NOTICES = JSON.stringify(NOTICES);
  nativeTheme.themeSource = 'dark';
  await win.loadFile(path.join(UI,'banner.html'));
  await win.webContents.insertCSS(tokenStylesheet({ important:true }));
  const theme = themeFromReport({ mode:'dark', surface:'rgb(25,23,36)', symbol:'rgb(213,210,235)', tokens:{} });
  await win.webContents.insertCSS(themeCss(theme));
  await new Promise(r=>setTimeout(r,700));
  const m = await win.webContents.executeJavaScript(PROBE);
  console.log(JSON.stringify(m,null,2));
  let failed = false;
  // 1. Not full-width: the cluster and the reported box are well under the window.
  if (!(m.stackWidth < m.windowW - 200)) { console.log('FAIL cluster is ~full-width: stackWidth '+m.stackWidth+' vs window '+m.windowW); failed=true; }
  else console.log('OK   cluster is narrower than the window ('+m.stackWidth+' < '+m.windowW+')');
  if (m.reported && m.reported.width && m.reported.width < m.windowW - 200) console.log('OK   reported box width '+m.reported.width+' is a card cluster, not the window');
  else { console.log('FAIL reported box is full-width or missing: '+JSON.stringify(m.reported)); failed=true; }
  // 2. Stack background transparent (its non-card area is see-through).
  const transparent = /rgba\(0, 0, 0, 0\)|transparent/.test(m.stackBg);
  if (transparent) console.log('OK   stack paints no band (bg '+m.stackBg+')');
  else { console.log('FAIL stack still paints a band: '+m.stackBg); failed=true; }
  // 3. The card itself still has a surface (not transparent), so it is legible.
  const cardOpaque = !/rgba\(0, 0, 0, 0\)|^transparent/.test(m.cardBg);
  if (cardOpaque) console.log('OK   card keeps its own surface ('+m.cardBg+')');
  else { console.log('FAIL card lost its surface: '+m.cardBg); failed=true; }
  // 4. Right-aligned like the sweep / phone stack.
  if (m.stackRightAligned) console.log('OK   cluster hugs the trailing edge');
  else { console.log('FAIL cluster is not right-aligned: right '+m.stackRight+' vs window '+m.windowW); failed=true; }
  removeProfile();
  console.log(failed?'PROOF FAILED':'PROOF OK');
  app.exit(failed?1:0);
}).catch(e=>{ console.error(e); removeProfile(); app.exit(1); });
