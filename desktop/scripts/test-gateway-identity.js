// Prove the identity check in BOTH directions, in the shipped app, against real
// servers: a stranger's page must be refused with a clear sentence, and a real
// OpenClaw gateway must be accepted. A check that only rejects is as broken as one
// that accepts everything, and accepting everything is what this replaces.
//
//   npx electron scripts/test-gateway-identity.js [--gateway URL] [--shots DIR]
//
// Needs a reachable Control UI, and the same throwaway gateway
// scripts/test-affordance-placement.js documents:
//
//   OPENCLAW_STATE_DIR=/tmp/claw-affordance-gw/state \
//   OPENCLAW_CONFIG_PATH=/tmp/claw-affordance-gw/openclaw.json \
//   openclaw gateway --port 19099 --auth none --bind loopback --allow-unconfigured
//
// The stranger is this script's own: a plain HTTP server that answers 200 with an
// ordinary page. It is the exact shape the old check accepted, and the reason the
// whole thing exists.
//
// What is asserted is the app's OWN verdict, read from the settings host the real
// settings page calls, plus one thing a verdict cannot show: that the refused
// address was never LOADED. `Test connection` refusing is half of it; the connect
// path refusing is the half that matters.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

import * as identity from '../../core/gateway-identity.js';

const argIndex = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const GATEWAY = argIndex('--gateway', 'http://127.0.0.1:19099/');
const SHOTS = argIndex('--shots', null);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/** The port the stranger answers on. Nothing in the app knows it until it is told. */
const STRANGER_PORT = 19098;
const STRANGER_URL = `http://127.0.0.1:${STRANGER_PORT}/`;

const STRANGER_PAGE = `<!doctype html>
<html lang="en"><head><title>Network login</title></head>
<body><h1>Sign in to the network</h1>
<p>This page is served by something that is not an OpenClaw gateway. It answers
200, it sets a few security headers, and the old check would have accepted it.</p>
</body></html>`;

const { app, BrowserWindow, Menu, desktopCapturer, webContents } = await import('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-identity-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Control UI', url: GATEWAY }],
  activeGatewayId: 'harness',
}, null, 2)}\n`);

/** Is anything listening there? */
function reachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
  });
}

if (!await reachable(GATEWAY)) {
  console.error(`FAIL no Control UI at ${GATEWAY}: start the throwaway gateway first (see the header)`);
  process.exit(1);
}

// The stranger. Deliberately generous: it sets the same three header names the
// spec records, so the ONLY thing that separates it from a gateway is the payload
// marker it cannot produce. A check that passed this would be the bug.
const stranger = http.createServer((req, res) => {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'",
  });
  res.end(STRANGER_PAGE);
});
await new Promise((resolve) => stranger.listen(STRANGER_PORT, '127.0.0.1', resolve));
console.log(`note stranger answering on ${STRANGER_URL} (an ordinary 200, no OpenClaw marker)`);

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

const WATCHDOG_MS = 120000;
const watchdog = setTimeout(() => {
  console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`);
  app.exit(1);
}, WATCHDOG_MS);

/** The app's own settings surface, which is a local page and carries the host bridge. */
function settingsView() {
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes('/settings.html')) || null;
}

/** The notice banner's page, which is where a refusal reaches the reader. */
function bannerView() {
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes('/banner.html')) || null;
}

async function grab(name) {
  if (!SHOTS) return;
  const win = BrowserWindow.getAllWindows()[0];
  const [width, height] = win.getContentSize();
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
  const mine = sources.find((s) => s.id === win.getMediaSourceId()) || sources.find((s) => /claw/i.test(s.name));
  if (!mine || mine.thumbnail.isEmpty()) return;
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), mine.thumbnail.toPNG());
}

function menuItem(label, items = Menu.getApplicationMenu()?.items || []) {
  for (const item of items) {
    if (item.label === label) return item;
    const found = item.submenu && menuItem(label, item.submenu.items);
    if (found) return found;
  }
  return null;
}

app.whenReady().then(async () => {
  // Long enough for the window and the gateway load.
  await delay(8000);

  const settings = menuItem('Settings\u2026');
  check('the app can open its settings surface', Boolean(settings), 'no Settings… menu item');
  if (settings) {
    settings.click();
    await delay(2500);
  }
  const view = settingsView();
  check('the settings surface is up', Boolean(view), 'the settings overlay never opened');
  if (!view) { clearTimeout(watchdog); app.exit(1); return; }

  const callTest = (url) => view.executeJavaScript(`window.clawDesktop.testGateway(${JSON.stringify(url)})`);

  /* ------------------------------------------- direction one: a stranger is refused */

  const strangerVerdict = await callTest(STRANGER_URL);
  console.log(`note the stranger's verdict: ${JSON.stringify(strangerVerdict)}`);
  check('a page that merely ANSWERS is refused', strangerVerdict.ok === false, JSON.stringify(strangerVerdict));
  check('and the reader is told plainly that it is not an OpenClaw gateway',
    /not an OpenClaw gateway/.test(String(strangerVerdict.message)), String(strangerVerdict.message));
  check('and told what the address actually answered',
    /200/.test(String(strangerVerdict.message)), String(strangerVerdict.message));
  check('and told that nothing was loaded',
    /nothing was loaded/i.test(String(strangerVerdict.message)), String(strangerVerdict.message));
  check('and the evidence names the signal that was missing',
    strangerVerdict.identity && strangerVerdict.identity.accepted === false
    && strangerVerdict.identity.evidence && strangerVerdict.identity.evidence.payloadMarker === false,
    JSON.stringify(strangerVerdict.identity));

  // The same press, in the page, so the screenshot is of the real surface
  // rendering the real sentence rather than of a value this script printed.
  await view.executeJavaScript(`(() => {
    document.getElementById('new-url').value = ${JSON.stringify(STRANGER_URL)};
    document.getElementById('test').click();
    return true;
  })()`);
  await delay(1500);
  const strangerShown = await view.executeJavaScript("document.getElementById('test-result').textContent");
  console.log(`note the settings row shows: ${strangerShown}`);
  check('the settings page renders the refusal', /not an OpenClaw gateway/.test(strangerShown), strangerShown);
  await grab('identity-refused');

  /* ------------------------------------------- direction two: a gateway is accepted */

  const gatewayVerdict = await callTest(GATEWAY);
  console.log(`note the gateway's verdict: ${JSON.stringify(gatewayVerdict)}`);
  check('a real OpenClaw gateway is accepted', gatewayVerdict.ok === true, JSON.stringify(gatewayVerdict));
  check('and it was accepted on the payload itself, which is the signal that proves it',
    gatewayVerdict.identity && gatewayVerdict.identity.strength === identity.PAYLOAD,
    JSON.stringify(gatewayVerdict.identity));
  check('and the message says what answered', /HTTP 200/.test(String(gatewayVerdict.message)),
    String(gatewayVerdict.message));

  await view.executeJavaScript(`(() => {
    document.getElementById('new-url').value = ${JSON.stringify(GATEWAY)};
    document.getElementById('test').click();
    return true;
  })()`);
  await delay(1500);
  const gatewayShown = await view.executeJavaScript("document.getElementById('test-result').textContent");
  console.log(`note the settings row shows: ${gatewayShown}`);
  check('the settings page renders the acceptance', /HTTP 200/.test(gatewayShown), gatewayShown);
  await grab('identity-accepted');

  /* --------------------------- the half a verdict cannot show: the address is not LOADED */

  // Add the stranger as a gateway and connect to it. `Test connection` refusing is
  // one thing; the connect path refusing is the requirement, because that is the
  // path every launch and every retry takes.
  const added = await view.executeJavaScript(
    `window.clawDesktop.addGateway({ label: 'Stranger', url: ${JSON.stringify(STRANGER_URL)} })`,
  );
  const strangerRow = (added.gateways || []).find((g) => g.label === 'Stranger');
  check('the stranger can be added to the list', Boolean(strangerRow), JSON.stringify(added.gateways));
  if (strangerRow) {
    await view.executeJavaScript(`window.clawDesktop.connect(${JSON.stringify(strangerRow.id)})`);
    await delay(7000);

    const loaded = webContents.getAllWebContents().filter(
      (wc) => !wc.isDestroyed() && wc.getURL().startsWith(STRANGER_URL.replace(/\/$/, '')),
    );
    check('the refused address was NEVER loaded', loaded.length === 0,
      `${loaded.length} view(s) are showing ${STRANGER_URL}: ${loaded.map((wc) => wc.getURL()).join(', ')}`);

    const banner = bannerView();
    check('the app has a notice banner to say so in', Boolean(banner), 'no banner.html view exists');
    if (banner) {
      const text = await banner.executeJavaScript('document.body.innerText || document.body.textContent || ""');
      console.log(`note the reader is told: ${String(text).replace(/\s+/g, ' ').slice(0, 400)}`);
      check('the reader is told it is not an OpenClaw gateway',
        /not an OpenClaw gateway/i.test(String(text)), String(text).slice(0, 200));
    }
    await grab('identity-refused-on-connect');
  }

  console.log(failed ? 'FAILED' : 'ALL OK');
  clearTimeout(watchdog);
  stranger.close();
  app.exit(failed ? 1 : 0);
});
