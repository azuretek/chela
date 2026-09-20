// One-off proof for the About-card overflow fixes (design-language fixes #1/#3/#6).
//
// Renders about.html through the real electron path (token + theme CSS injected
// exactly as measure-text-scale.mjs does), with the reported worst-case content:
// a long dev build line and a Windows config path. Measures, per scale:
//   - documentElement.scrollWidth vs clientWidth: any excess is the SIDEWAYS
//     scroll of the whole surface Abi reported (#1). Must be 0.
//   - the .result line: clientHeight vs scrollHeight, so a message in green/red
//     is not clipped by a fixed box at a larger reading scale (#3/#6).
//
//   npx electron scripts/prove-about-overflow.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { themeCss, themeFromReport } from '../src/chrome.js';

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-about-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);
function removeProfile(){ try{ fs.rmSync(PROFILE,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }catch{} }
const REPO = path.join(import.meta.dirname, '..', '..');
const UI = path.join(REPO, 'core', 'ui');

// The worst-case About state: a dev build line with a commit and stamp, and a
// long Windows config path, which is what forced the surface to scroll sideways.
const STATE = {
  build: '1.0.1-dev.291.810552323b (810552323b-dirty, built 2026-09-20 03:34Z)',
  updateStatus: 'Updates: dev channel, installed automatically; last checked just now, up to date',
  updateReady: null, canInstall: true, autoUpdate: true,
  facts: [
    { label: 'Version', value: '1.0.1-dev.291.810552323b' },
    { label: 'Channel', value: 'dev' },
    { label: 'Electron', value: '44.4.1 \u00b7 Chromium 152.0.7977.78' },
    { label: 'Platform', value: 'Windows 10.0.26200 x64' },
    { label: 'Config', value: 'C:\\Users\\azure\\AppData\\Roaming\\Claw Control UI\\config.json' },
  ],
  controlUI: { version: '2026.9.4', commit: '362492d734abcdef' },
};
const PRELOAD = path.join(PROFILE,'stub.cjs');
fs.writeFileSync(PRELOAD, `
const { contextBridge } = require('electron');
const state = JSON.parse(process.env.CLAW_ABOUT_STATE || '{}');
contextBridge.exposeInMainWorld('clawDesktop',{ about:async()=>state, checkUpdates:async()=>{}, openReleases:()=>{}, closeOverlay:()=>{}, onAboutChanged:()=>{}, clearCacheAndReload:async()=>({cleared:['https://minizilla.tail8a6fef.ts.net'],failed:[],origins:['https://minizilla.tail8a6fef.ts.net'],gateway:{label:'Zilla'}}), onCacheCleared:()=>{}, notices:async()=>[], onNoticesChanged:()=>{}, bannerHeight:()=>{}, sweepBounds:()=>{}, dismissNotice:()=>{}, noticeAction:()=>{}, markNoticesRead:()=>{} });
`);

const PROBE = `(() => {
  const de = document.documentElement;
  const body = document.body;
  const modalBody = document.querySelector('.modal__body');
  // Press clear-cache so the .result line carries a real message, then measure it.
  const btn = document.getElementById('clear-cache');
  return new Promise((resolve) => {
    const measure = () => {
      const result = document.querySelector('.result');
      // Find every element whose right edge pokes past the viewport, worst first.
      const vw = de.clientWidth;
      const over = [];
      for (const el of document.querySelectorAll('*')) {
        const rect = el.getBoundingClientRect();
        if (rect.right > vw + 0.5) over.push({ sel: el.className && typeof el.className === 'string' ? el.className.split(/\\s+/)[0] : el.tagName, right: Math.round(rect.right), sw: el.scrollWidth });
      }
      over.sort((a,b)=>b.right-a.right);
      resolve({
        viewportW: vw,
        docScrollExcess: de.scrollWidth - de.clientWidth,
        bodyScrollExcess: body.scrollWidth - body.clientWidth,
        modalBodyScrollExcess: modalBody ? (modalBody.scrollWidth - modalBody.clientWidth) : null,
        widest: over.slice(0,6),
        result: result ? { text: result.textContent.slice(0,40), clientH: result.clientHeight, scrollH: result.scrollHeight, clipped: result.scrollHeight > result.clientHeight + 1 } : null,
      });
    };
    if (btn) { btn.click(); setTimeout(measure, 250); } else { measure(); }
  });
})()`;

app.whenReady().then(async () => {
  // ★ Narrower than the modal's own min(460px, 100%): this is the condition the
  // report is about. At a wide window the modal fits and nothing overflows
  // whatever the CSS does; the sideways scroll only appears once the window is
  // narrow enough that the modal must shrink and an unbreakable string (the dev
  // build line, the Windows config path) refuses to. 380px forces that.
  const win = new BrowserWindow({ show:false, width:380, height:760, webPreferences:{ preload:PRELOAD, contextIsolation:true, nodeIntegration:false } });
  process.env.CLAW_ABOUT_STATE = JSON.stringify(STATE);
  nativeTheme.themeSource = 'dark';
  const results = {};
  for (const scale of [1, 1.5]) {
    await win.loadFile(path.join(UI,'about.html'));
    const theme = themeFromReport({ mode:'dark', surface:'rgb(25,23,36)', symbol:'rgb(213,210,235)', tokens:{ '--control-ui-text-scale': String(scale) } });
    await win.webContents.insertCSS(themeCss(theme));
    await new Promise(r=>setTimeout(r,600));
    results[scale] = await win.webContents.executeJavaScript(PROBE);
  }
  console.log(JSON.stringify(results,null,2));
  let failed = false;
  for (const scale of [1, 1.5]) {
    const r = results[scale];
    if (r.docScrollExcess > 0 || r.bodyScrollExcess > 0) { console.log('FAIL side-scroll at ' + scale + 'x: doc=' + r.docScrollExcess + ' body=' + r.bodyScrollExcess); failed = true; }
    else console.log('OK   no side-scroll at ' + scale + 'x');
    if (r.result && r.result.clipped) { console.log('FAIL .result clipped at ' + scale + 'x: ' + r.result.clientH + ' < ' + r.result.scrollH); failed = true; }
    else if (r.result) console.log('OK   .result not clipped at ' + scale + 'x (' + r.result.clientH + '>=' + r.result.scrollH + ', "' + r.result.text + '")');
  }
  removeProfile();
  console.log(failed ? 'PROOF FAILED' : 'PROOF OK');
  app.exit(failed?1:0);
}).catch(e=>{ console.error(e); removeProfile(); app.exit(1); });
