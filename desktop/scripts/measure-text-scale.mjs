// Prove our own pages follow the Control UI's reading-size setting.
//
// The Control UI has a text-size setting that resolves --control-ui-text-scale on
// its root to a unitless multiplier (textScale/100). Our pages render inside it
// and must grow with it, which is the response half of the text-scale work: every
// font-size ui.css declares is relative to that multiplier. A source guard
// (core/test/text-scale.test.js) proves no literal px remains; this proves the
// RENDERED result, which a source scan cannot: it loads settings.html at scale 1
// and at 1.25 with the scale injected exactly as the app injects a live theme
// (chrome.js themeCss over the page), measures a representative set of our own
// text elements, and asserts each grew by 1.25x. A component left on a literal
// size would grow by 1.0 and fail here.
//
//   npx electron scripts/measure-text-scale.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { themeCss, themeFromReport } from '../src/chrome.js';

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-scale-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);
function removeProfile(){ for(let i=0;i<5;i++){ try{ fs.rmSync(PROFILE,{recursive:true,force:true,maxRetries:5,retryDelay:100}); return;}catch{ const u=Date.now()+150; while(Date.now()<u){} } } }
const REPO = path.join(import.meta.dirname, '..', '..');
const UI = path.join(REPO, 'core', 'ui');

const STATE = {
  client:'desktop',
  surface: JSON.parse(fs.readFileSync(path.join(REPO,'core','spec','settings.json'),'utf8')),
  gateways:[{id:'alpha',label:'Alpha gateway',url:'http://127.0.0.1:19001/',credentials:{hasToken:true,hasPassword:false,headers:[]},status:{tone:'ok',label:'Connected',detail:null}}],
  activeGatewayId:'alpha', connection:{phase:'connected'},
  settings:{closeToTray:true,launchAtLogin:false,startHidden:false,autoUpdate:true,promptMetadata:false,globalShortcut:'CommandOrControl+Shift+O'},
  appearance:{mode:'system'}, build:'1.0.0 (source)', certOffers:[], trustedCerts:{}, updates:{}, secretsError:null,
};
const PRELOAD = path.join(PROFILE,'stub.cjs');
fs.writeFileSync(PRELOAD, `
const { contextBridge } = require('electron');
const state = JSON.parse(process.env.CLAW_SCALE_STATE || '{}');
contextBridge.exposeInMainWorld('clawSettings',{ asPage:false, invoke:async()=>state, on:()=>{} });
contextBridge.exposeInMainWorld('clawDesktop',{ about:async()=>state, checkUpdates:async()=>{}, openReleases:()=>{}, closeOverlay:()=>{}, onAboutChanged:()=>{}, clearCacheAndReload:async()=>({cleared:[],failed:[],origins:[],gateway:null}), onCacheCleared:()=>{}, notices:async()=>[], onNoticesChanged:()=>{}, bannerHeight:()=>{}, sweepBounds:()=>{}, dismissNotice:()=>{}, noticeAction:()=>{}, markNoticesRead:()=>{} });
`);

// Measure a representative set of OUR-OWN text elements: the heading, a tab label,
// the connection badge, the search input placeholder box, and the gateway url.
const PROBE = `(() => {
  const sz = (sel) => { const n=document.querySelector(sel); if(!n) return null; return +parseFloat(getComputedStyle(n).fontSize).toFixed(2); };
  return {
    scale: getComputedStyle(document.documentElement).getPropertyValue('--control-ui-text-scale').trim(),
    title: sz('.settings-sidebar__title'),
    tab: sz('.tab'),
    badge: sz('.badge'),
    url: sz('.url'),
    rowTitle: sz('.settings-row__title'),
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show:false, width:900, height:720, webPreferences:{ preload:PRELOAD, contextIsolation:true, nodeIntegration:false } });
  process.env.CLAW_SCALE_STATE = JSON.stringify(STATE);
  nativeTheme.themeSource = 'dark';
  const results = {};
  for (const scale of [1, 1.25]) {
    await win.loadFile(path.join(UI,'settings.html'));
    // Inject the live theme with the scale token, exactly as chrome.js -> main.js does.
    const theme = themeFromReport({ mode:'dark', surface:'rgb(25,23,36)', symbol:'rgb(213,210,235)', tokens:{ '--control-ui-text-scale': String(scale) } });
    await win.webContents.insertCSS(themeCss(theme));
    await new Promise(r=>setTimeout(r,700));
    results[scale] = await win.webContents.executeJavaScript(PROBE);
  }
  console.log(JSON.stringify(results,null,2));
  // Assert every measured element grew by ~1.25x
  let failed = false;
  const keys = ['title','tab','badge','url','rowTitle'];
  for (const k of keys) {
    const a = results[1][k], b = results[1.25][k];
    if (a == null || b == null) { console.error('MISSING', k); failed = true; continue; }
    const ratio = b / a;
    const ok = Math.abs(ratio - 1.25) < 0.03;
    console.log((ok?'OK  ':'FAIL') + ' ' + k + ' ' + a + ' -> ' + b + ' (x' + ratio.toFixed(3) + ')');
    if (!ok) failed = true;
  }
  removeProfile();
  console.log(failed ? 'FAILED' : 'OK all scaled');
  app.exit(failed?1:0);
}).catch(e=>{ console.error(e); removeProfile(); app.exit(1); });
