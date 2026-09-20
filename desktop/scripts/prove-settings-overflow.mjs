// Find (and prove absent) the sideways scroll on the settings surface.
//
// The report: the whole settings page scrolls left-right. about.html standalone
// does not reproduce it, so this renders the REAL settings.html the way
// measure-text-scale.mjs does, with a gateway carrying a long tailnet URL and an
// extra-request-header row (the CF-Access fields in the screenshots), at scale 1
// and 1.5, and reports every element whose right edge pokes past the viewport.
//
//   npx electron scripts/prove-settings-overflow.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { themeCss, themeFromReport } from '../src/chrome.js';

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-setov-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);
function removeProfile(){ try{ fs.rmSync(PROFILE,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }catch{} }
const REPO = path.join(import.meta.dirname, '..', '..');
const UI = path.join(REPO, 'core', 'ui');

const STATE = {
  client:'desktop',
  surface: JSON.parse(fs.readFileSync(path.join(REPO,'core','spec','settings.json'),'utf8')),
  gateways:[{ id:'zilla', label:'Zilla', url:'https://minizilla.tail8a6fef.ts.net', credentials:{hasToken:true,hasPassword:false,headers:[{name:'CF-Access-Client-Id',hasValue:true}]}, status:{tone:'err',label:'Cannot connect',detail:'ERR_CONNECTION_REFUSED'} }],
  activeGatewayId:'zilla', connection:{phase:'failed'},
  settings:{closeToTray:true,launchAtLogin:false,startHidden:false,autoUpdate:true,promptMetadata:false,globalShortcut:'CommandOrControl+Shift+O'},
  appearance:{mode:'system'}, build:'1.0.1-dev.291.810552323b (810552323b-dirty, built 2026-09-20 03:34Z)', certOffers:[], trustedCerts:{}, updates:{}, secretsError:null,
};
const PRELOAD = path.join(PROFILE,'stub.cjs');
fs.writeFileSync(PRELOAD, `
const { contextBridge } = require('electron');
const state = JSON.parse(process.env.CLAW_SETOV_STATE || '{}');
contextBridge.exposeInMainWorld('clawSettings',{ asPage:false, invoke:async()=>state, on:()=>{} });
contextBridge.exposeInMainWorld('clawDesktop',{ about:async()=>state, checkUpdates:async()=>{}, openReleases:()=>{}, closeOverlay:()=>{}, onAboutChanged:()=>{}, notices:async()=>[], onNoticesChanged:()=>{}, bannerHeight:()=>{}, sweepBounds:()=>{}, dismissNotice:()=>{}, noticeAction:()=>{}, markNoticesRead:()=>{} });
`);

const PROBE = `(() => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const over = [];
  for (const el of document.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect();
    if (rect.right > vw + 0.5) over.push({ sel: (el.className && typeof el.className==='string'? el.className.split(/\\s+/)[0] : el.tagName), right: Math.round(rect.right), sw: el.scrollWidth, text:(el.textContent||'').trim().slice(0,30) });
  }
  over.sort((a,b)=>b.right-a.right);
  return { viewportW: vw, docExcess: de.scrollWidth-de.clientWidth, bodyExcess: document.body.scrollWidth-document.body.clientWidth, widest: over.slice(0,8) };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show:false, width:400, height:820, webPreferences:{ preload:PRELOAD, contextIsolation:true, nodeIntegration:false } });
  process.env.CLAW_SETOV_STATE = JSON.stringify(STATE);
  nativeTheme.themeSource = 'dark';
  const out = {};
  for (const scale of [1, 1.5]) {
    await win.loadFile(path.join(UI,'settings.html'));
    const theme = themeFromReport({ mode:'dark', surface:'rgb(25,23,36)', symbol:'rgb(213,210,235)', tokens:{ '--control-ui-text-scale': String(scale) } });
    await win.webContents.insertCSS(themeCss(theme));
    await new Promise(r=>setTimeout(r,700));
    out[scale] = await win.webContents.executeJavaScript(PROBE);
  }
  console.log(JSON.stringify(out,null,2));
  let failed = false;
  for (const s of [1,1.5]) { if (out[s].docExcess>0 || out[s].bodyExcess>0) { console.log('SIDE-SCROLL at '+s+'x: doc='+out[s].docExcess+' body='+out[s].bodyExcess); failed=true; } else console.log('OK no side-scroll at '+s+'x'); }
  removeProfile();
  console.log(failed?'REPRODUCED':'no-repro');
  app.exit(0);
}).catch(e=>{ console.error(e); removeProfile(); app.exit(1); });
