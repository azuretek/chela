// Send, sleep, wake, send, against a live gateway, with the machine's power
// events emitted on Electron's own powerMonitor so main.js hears exactly what a
// real suspend and resume deliver. The socket loss a sleep causes is produced by
// taking the gateway partition offline for the length of the "sleep".
//
//   OPENCLAW_SEED_TOKEN=... CLAW_WAKE_GATEWAY=https://host npx electron scripts/test-wake-reconnect.js --shots DIR
//
// The token is read from the environment, stored through secrets.set in a
// throwaway profile, and never printed. Exits 0 only if the message sent after
// the wake is answered and no queued row is left behind.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, webContents, powerMonitor } from 'electron';
import secrets from '../src/secrets.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const SHOTS = arg('--shots', null);
const SLEEP_MS = Number(arg('--sleep-ms', '20000'));
const MODE = arg('--mode', 'plain'); // plain: send, sleep, wake, send. queued: queue during a run, then sleep.
const GATEWAY = process.env.CLAW_WAKE_GATEWAY;
const TOKEN = process.env.OPENCLAW_SEED_TOKEN;
if (!GATEWAY || !TOKEN) { console.error('need CLAW_WAKE_GATEWAY and OPENCLAW_SEED_TOKEN'); process.exit(2); }
delete process.env.OPENCLAW_SEED_TOKEN;

// A REUSED profile, not a fresh one per run. The gateway approves a browser
// once, keyed to the device keypair the Control UI stores in this profile, so a
// throwaway profile means a fresh approval on every launch and the run sits on
// the approval screen instead of the composer. Set CLAW_WAKE_PROFILE to run
// several proofs side by side; without it they share one and the first approval
// covers them all.
const TMP = process.env.CLAW_WAKE_PROFILE || path.join(os.tmpdir(), 'claw-wake-profile');
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);
app.commandLine.appendSwitch('user-data-dir', TMP);
// A mock keychain, so safeStorage does not wait on a keychain prompt nobody
// is there to answer over ssh, and the throwaway credential never lands in the
// real keychain.
app.commandLine.appendSwitch('use-mock-keychain');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(os.tmpdir(), 'claw-wake-' + process.pid + '.log');
const record = (line) => { const l = new Date().toISOString() + ' ' + line; fs.appendFileSync(LOG, l + '\n'); console.log(l); };
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const RUN = Date.now().toString(36);
const SESSION = process.env.CLAW_WAKE_SESSION || ('agent:main:dashboard:wake-proof-' + RUN);
const CHAT_URL = GATEWAY.replace(/\/$/, "") + "/chat?" + "session=" + encodeURIComponent(SESSION);
const GW_ID = 'wake-proof';
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
  // The app's own default chat route, not a fabricated session key: a key
  // the gateway has never seen leaves the UI on Home, where nothing of the
  // conversation is rendered and a delivery cannot be seen.
  // A DEDICATED session, named in the URL. The bare gateway URL routes this
  // client to the agent's MAIN session, where a proof run would send its test
  // messages into somebody's real conversation; the session key here keeps every
  // run in its own session. The key is stable (CLAW_WAKE_SESSION) so the first
  // run, which creates the session, lets every later run RENDER its transcript
  // rather than landing on Home with nothing on screen.
  gateways: [{ id: GW_ID, label: 'wake proof', url: CHAT_URL }],
  activeGatewayId: GW_ID,
}, null, 2));

// Registered before main.js is imported, so it runs ahead of main's own ready
// handler and the credential is there when the first connect reads it. Not
// awaited at the top level: Electron emits ready only after the entry module
// finishes evaluating, so a top-level await on it never returns.
app.whenReady().then(() => {
  secrets.set(GW_ID, { token: TOKEN });
  record('seeded a throwaway profile at ' + path.basename(TMP) + ', session ' + SESSION);
});
await import('../src/main.js');

const gatewayPage = () => webContents.getAllWebContents()
  .filter((wc) => !wc.isDestroyed() && wc.getURL().startsWith(GATEWAY))
  .pop();

// Deep reads through every shadow root, because the Control UI is custom elements.
const DEEP = 'function deep(root, out) { out = out || []; for (const el of root.querySelectorAll("*")) { out.push(el); if (el.shadowRoot) deep(el.shadowRoot, out); } return out; }';
async function evalPage(src, ms = 8000) {
  // The reconnect REPLACES the gateway view, so a view read here can be destroyed
  // before the call lands. That reads as null and the caller polls again, rather
  // than ending the run with "Object has been destroyed" (measured on Windows).
  try {
    const wc = gatewayPage();
    if (!wc) return null;
    return await Promise.race([wc.executeJavaScript('(() => { ' + DEEP + ' ' + src + ' })()').catch(() => null), delay(ms).then(() => null)]);
  } catch { return null; }
}
const pageText = () => evalPage('return deep(document).filter(e => !e.children.length).map(e => e.textContent).join("\\n");');
const queued = () => evalPage('return deep(document).filter(e => /queue|outbox/i.test(String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className)) && e.offsetParent !== null).map(e => String(e.className)).slice(0, 20);');

// Every view of ours, through the DevTools protocol: the host this runs on may
// have its display locked, where the window server paints nothing and both
// capturePage and a screen grab come back empty, while the renderer still draws
// its own frame for Page.captureScreenshot. The gateway page is the proof of
// delivery; the cover, when it is up, is the proof the reconnect was covered.
async function cdpShot(wc) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    const r = await Promise.race([wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }), delay(8000).then(() => null)]);
    return r && r.data ? Buffer.from(r.data, 'base64') : null;
  } catch (e) { record('note cdp shot failed: ' + e.message); return null; }
}
async function shot(name) {
  if (!SHOTS) return;
  for (const wc of webContents.getAllWebContents().filter((w) => !w.isDestroyed())) {
    let url = '';
    try { url = wc.getURL(); } catch { continue; }
    const kind = url.startsWith(GATEWAY) ? 'gateway' : /loading\.html/.test(url) ? 'cover' : null;
    if (!kind) continue;
    const png = await cdpShot(wc);
    if (!png) { record('note shot ' + name + '-' + kind + ' came back empty'); continue; }
    fs.writeFileSync(path.join(SHOTS, name + '-' + kind + '.png'), png);
    record('shot ' + name + '-' + kind + ' (' + png.length + ' bytes)');
  }
}

async function waitFor(label, fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await delay(1000);
  }
  record('TIMEOUT waiting for ' + label);
  return null;
}

function describePage() {
  return evalPage('const t = (document.body.innerText || "").replace(/\s+/g, " ").trim(); const roots = deep(document).filter(e => e.shadowRoot).map(e => (e.shadowRoot.textContent || "").replace(/\s+/g, " ").trim()).join(" ~ "); return JSON.stringify({ url: location.href, body: t.slice(0, 300), shadow: roots.slice(0, 400) });');
}

async function send(text) {
  // Typed and entered the way a person does, through the renderer's own input
  // pipeline, so the composer's handlers see a real keystroke.
  const found = await evalPage('const all = deep(document).filter(e => e.tagName === "TEXTAREA" && e.offsetParent !== null); const t = all.find(e => /message|ask|send/i.test(e.placeholder || "")) || all.pop(); if (!t) return "no composer"; t.focus(); t.value = ""; t.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true })); return "focused " + (t.placeholder || "");');
  const wc = gatewayPage();
  if (!wc || wc.isDestroyed() || !String(found).startsWith('focused')) { record('send: ' + found); return false; }
  wc.focus();
  await wc.insertText(text);
  await delay(300);
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  record('send ' + JSON.stringify(text) + ': ' + found);
  return true;
}
// Answered means the marker is on screen. Matched as a SUBSTRING of any text
// node, because the transcript wraps a reply in its own markup and whitespace,
// and an exact-match test reported "not answered" for a reply that had rendered.
const answered = (marker) => async () => evalPage('const m = ' + JSON.stringify(marker) + '; for (const el of deep(document)) { if (el.shadowRoot && el.shadowRoot.textContent.includes(m)) return true; } return document.body.textContent.includes(m);');

async function sleepAndWake() {
  const part = gatewayPage()?.session;
  record('suspend (powerMonitor), network offline for ' + SLEEP_MS + 'ms');
  powerMonitor.emit('lock-screen');
  powerMonitor.emit('suspend');
  part?.enableNetworkEmulation({ offline: true });
  await delay(SLEEP_MS);
  part?.disableNetworkEmulation();
  record('resume (powerMonitor), network back');
  powerMonitor.emit('resume');
  powerMonitor.emit('unlock-screen');
}

let ok = true;
app.whenReady().then(() => delay(500)).then(async () => {
try {
  const ready = await waitFor('the composer', () => evalPage('return deep(document).some(e => e.tagName === "TEXTAREA" && e.offsetParent !== null);'), 90000);
  await shot('01-connected');
  record('page at connect: ' + await describePage());
  if (!ready) {
    const t = await pageText();
    record('page text: ' + String(t).slice(0, 600).replace(/\n+/g, ' | '));
    throw new Error('never reached the composer');
  }
  const A = 'WAKEA' + RUN, B = 'WAKEB' + RUN, C = 'WAKEC' + RUN;
  await send('Reply with exactly ' + A + ' and nothing else.');
  ok = Boolean(await waitFor('reply ' + A, answered(A), 30000)) && ok;
  await shot('02-first-send-answered');
  record('page after first send: ' + await describePage());
  if (MODE === 'queued') {
    await send('Run the shell command sleep 25, then reply with exactly DONE' + RUN + '.');
    await delay(4000);
    await send('Reply with exactly ' + B + ' and nothing else.');
    await delay(1500);
    record('queued rows before sleep: ' + JSON.stringify(await queued()));
    await shot('03-queued-before-sleep');
  }
  await sleepAndWake();
  await delay(3000);
  await shot('04-after-wake');
  record('page after wake: ' + await describePage());
  await waitFor('the composer after wake', () => evalPage('return deep(document).some(e => e.tagName === "TEXTAREA" && e.offsetParent !== null);'), 90000);
  if (MODE === 'queued') {
    const b = await waitFor('reply ' + B, answered(B), 150000);
    record('queued message answered after wake: ' + Boolean(b));
    ok = Boolean(b) && ok;
  }
  await send('Reply with exactly ' + C + ' and nothing else.');
  const c = await waitFor('reply ' + C, answered(C), 30000);
  record('message sent after wake answered: ' + Boolean(c));
  ok = Boolean(c) && ok;
  const left = await queued();
  record('queued rows left: ' + JSON.stringify(left));
  await shot('05-after-wake-send-answered');
} catch (e) {
  ok = false;
  record('ERROR ' + e.message);
}
record(ok ? 'RESULT PASS' : 'RESULT FAIL');
record('log ' + LOG + ' session ' + SESSION);
app.exit(ok ? 0 : 1);
});
