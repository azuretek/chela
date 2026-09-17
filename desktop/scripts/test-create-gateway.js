// Create a gateway WITH its token in ONE pass, and prove it connects from there.
//
//   npx electron scripts/test-create-gateway.js [--shots DIR]
//
// This is the acceptance test for the add form, and it is deliberately not "does
// the form have a token field". A field is not the fix: the fix is that one press
// creates a gateway that is COMPLETE, so the proof has to be that no second visit
// through Edit is needed before the app can connect with the credential that was
// typed. So the harness types a name, an address and a token into the form, presses
// Add once, and then presses Connect and checks what the gateway was handed.
//
// The gateway here is a stub served from inside this process, because what is
// being measured is the app's own behaviour: the token reaches the page as the
// \`#token=\` handoff (gateway-url.js \`withTokenHandoff\`, applied in
// loadActiveGateway from the credential this app stored), so the stub records the
// hash it was loaded with and that is the evidence. No real credential is involved
// and the value below is an example, of the same kind the fixtures use.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const shotsIndex = process.argv.indexOf('--shots');
const SHOTS = shotsIndex === -1 ? null : process.argv[shotsIndex + 1];
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/** The example token this run types into the form. Never a real one. */
const TOKEN = 'example-token-not-a-credential';
const ADDRESS = 'http://127.0.0.1:19099/';
const NAME = 'Stub gateway';

const { app, BrowserWindow, Menu, desktopCapturer, webContents } = await import('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-create-gateway-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

// A gateway that answers like a Control UI and remembers what it was loaded
// with. The hash is the whole measurement: a fragment never leaves the client, so
// the only thing that can put the token there is the app's own handoff.
const served = { hashes: [], loads: 0 };
const server = http.createServer((req, res) => {
  served.loads += 1;
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end('<!doctype html><html data-openclaw-control-ui-build-id="stub-1"><head><meta charset="utf-8">'
    + '<title>Stub Control UI</title></head><body><h1>Stub Control UI</h1>'
    + '<script>window.__clawHash = location.hash;</script></body></html>');
});
await new Promise((resolve) => server.listen(19099, '127.0.0.1', resolve));

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

const WATCHDOG_MS = 150000;
const watchdog = setTimeout(() => {
  console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`);
  app.exit(1);
}, WATCHDOG_MS);

function view(match) {
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes(match)) || null;
}

async function grab(name) {
  if (!SHOTS) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
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

/** The state the settings page renders from, read through its own host door. */
const STATE = "window.clawSettings.invoke('state', [])";

/** The row for one address, as the page drew it: its summary and its badge. */
const ROW = (address) => `(() => {
  const row = [...document.querySelectorAll('#gateways .settings-row')].find((r) => {
    const url = r.querySelector('.url');
    return url && url.textContent.includes(${JSON.stringify(address.replace(/\/$/, ''))});
  });
  if (!row) return null;
  return {
    summary: row.querySelector('.settings-row__desc').textContent,
    badge: row.querySelector('.badge').textContent,
    buttons: [...row.querySelectorAll('button')].map((b) => b.textContent.trim()),
  };
})()`;

app.whenReady().then(async () => {
  await delay(6000);

  const settings = menuItem('Settings…');
  check('the app offers Settings in its menu', Boolean(settings), 'no Settings… item');
  if (!settings) { clearTimeout(watchdog); app.exit(1); return; }
  settings.click();
  await delay(3000);

  const page = view('settings.html');
  check('the settings surface is up', Boolean(page), 'the settings overlay never opened');
  if (!page) { clearTimeout(watchdog); app.exit(1); return; }

  // ---- the one pass ---------------------------------------------------------
  // Everything is typed into the form and the form is then told to save, once.
  const afterAdd = await page.executeJavaScript(`(async () => {
    document.getElementById('new-label').value = ${JSON.stringify(NAME)};
    document.getElementById('new-url').value = ${JSON.stringify(ADDRESS)};
    document.getElementById('new-token').value = ${JSON.stringify(TOKEN)};
    document.getElementById('add').click();
    await new Promise((r) => setTimeout(r, 1200));
    const state = await ${STATE};
    const mine = (state.gateways || []).filter((g) => g.url.includes('127.0.0.1:19099'))[0] || null;
    return {
      result: document.getElementById('test-result').textContent,
      gateway: mine && { id: mine.id, label: mine.label, url: mine.url, hasToken: mine.credentials.hasToken },
      formToken: document.getElementById('new-token').value,
    };
  })()`);

  console.log(`note the form's own answer: ${afterAdd.result}`);
  check('the add reports the token among what it kept',
    /token/i.test(afterAdd.result) && /Added/.test(afterAdd.result), afterAdd.result);
  check('the form no longer sends the reader to Edit to finish the job',
    !/Use Edit/i.test(afterAdd.result), afterAdd.result);
  check('the gateway exists in the app state after the single press',
    Boolean(afterAdd.gateway) && afterAdd.gateway.url.includes('127.0.0.1:19099'),
    JSON.stringify(afterAdd.gateway));
  check('and it already holds the token, with no Edit step',
    Boolean(afterAdd.gateway) && afterAdd.gateway.hasToken === true,
    JSON.stringify(afterAdd.gateway));
  check('the credential input was cleared once it was stored',
    afterAdd.formToken === '', JSON.stringify(afterAdd.formToken));
  await grab('create-one-pass');

  // ---- and it connects ------------------------------------------------------
  // The acceptance half. A credential that is stored but not used is the same
  // failure one step later, so this presses Connect and reads what the gateway
  // was actually handed.
  const connected = await page.executeJavaScript(`(async () => {
    const row = [...document.querySelectorAll('#gateways .settings-row')].find((r) => {
      const url = r.querySelector('.url');
      return url && url.textContent.includes('127.0.0.1:19099');
    });
    if (!row) return { error: 'no row for the new gateway' };
    const button = [...row.querySelectorAll('button')].find((b) => /^(Connect|Reconnect)/.test(b.textContent.trim()));
    if (!button) return { error: 'the row offers no Connect' };
    const label = button.textContent.trim();
    button.click();
    return { label, summary: row.querySelector('.settings-row__desc').textContent };
  })()`);
  console.log(`note the row before pressing: ${JSON.stringify(connected)}`);
  check('the new gateway was offered Connect without an Edit first',
    connected && /^Connect/.test(connected.label), JSON.stringify(connected));
  check('and its own row already says a token is saved',
    Boolean(connected) && /Token saved/.test(connected.summary || ''), JSON.stringify(connected));

  await delay(9000);

  const gateway = view('19099');
  const handed = gateway ? await gateway.executeJavaScript('location.hash') : null;
  console.log(`note the gateway page was loaded with the hash: ${handed}`);
  await grab('create-one-pass-connected');

  check('the app reached the gateway it created', Boolean(gateway), 'no view at the gateway address');
  // The acceptance assertion, and the one that makes the rest of this mean
  // something: the credential the app handed over is the one typed into the
  // create form, which is only possible if the one press stored it.
  check('and the gateway was handed the token that was typed into the create form',
    typeof handed === 'string' && handed.includes(`token=${TOKEN}`), JSON.stringify(handed));

  // Read the row again AFTER re-opening the surface, rather than immediately
  // after the press: a Connect that succeeds takes this surface away, which is
  // the app's own design (announceConnected in src/main.js answers from a notice
  // over the Control UI rather than by leaving the page up). A row read from a
  // dismissed surface is null, and asserting on it would have been a check that
  // could only ever fail.
  const reopened = menuItem('Settings…');
  check('the app still offers Settings after connecting', Boolean(reopened), 'no Settings… item');
  if (reopened) {
    reopened.click();
    await delay(2500);
    const after = view('settings.html');
    const row = after ? await after.executeJavaScript(ROW(ADDRESS)) : null;
    console.log(`note the row after connecting: ${JSON.stringify(row)}`);
    await grab('create-one-pass-row');
    check('and the gateway it created reports itself connected, with the token still saved',
      Boolean(row) && /Connected/i.test(row.badge || '') && /Token saved/.test(row.summary || ''),
      JSON.stringify(row));
  }

  if (SHOTS) console.log(`note screenshots in ${SHOTS}`);
  clearTimeout(watchdog);
  server.close();
  console.log(failed ? 'FAILED' : 'ALL OK');
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(`FAIL harness: ${err && err.stack ? err.stack : err}`);
  server.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(1);
});
