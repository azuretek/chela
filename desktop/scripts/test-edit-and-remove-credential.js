// Edit a gateway in ONE press, and take a stored credential back out again.
//
//   npx electron scripts/test-edit-and-remove-credential.js [--shots DIR]
//
// The other half of scripts/test-create-gateway.js. That one proves a gateway can
// be CREATED complete, with its token, in one pass. This one proves the two things
// the single-Save redesign of the editor has to keep, neither of which a
// screenshot can settle:
//
//   1. ONE Save writes the whole section: a renamed gateway AND a newly typed
//      credential, in the same press, through the same commands.
//   2. A stored credential can still be REMOVED. The per-field Clear is gone with
//      the per-field Save, so the removal is now a control of its own beside the
//      field it empties, and this is the measurement that it works and that the
//      app stops handing the credential over afterwards.
//
// The gateway is a stub served from inside this process, and the evidence is the
// app's own credential handoff: the page is loaded with \`#token=<value>\`, which
// only the app's own stored credential can put there (gateway-url.js
// \`withTokenHandoff\`, applied in loadActiveGateway). So the same assertion
// proves the write and its absence proves the removal. No real credential is
// involved and the values below are examples, of the kind the fixtures use.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const shotsIndex = process.argv.indexOf('--shots');
const SHOTS = shotsIndex === -1 ? null : process.argv[shotsIndex + 1];
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const TOKEN = 'example-token-typed-once';
const NEW_TOKEN = 'example-token-typed-again';
const ADDRESS = 'http://127.0.0.1:19100/';
const NAME = 'Stub gateway';
const RENAMED = 'Stub gateway, renamed';

const { app, BrowserWindow, Menu, desktopCapturer, webContents } = await import('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-edit-credential-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

// A gateway that answers like a Control UI and remembers the hash it was loaded
// with. A fragment never leaves the client, so the app's own handoff is the only
// thing that can put the token there, and its absence afterwards is only
// explicable by the credential being gone.
const served = { hashes: [] };
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end('<!doctype html><html data-openclaw-control-ui-build-id="stub-1"><head><meta charset="utf-8">'
    + '<title>Stub Control UI</title></head><body><h1>Stub Control UI</h1>'
    + '<script>window.__clawHash = location.hash;</script></body></html>');
});
await new Promise((resolve) => server.listen(19100, '127.0.0.1', resolve));

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

const WATCHDOG_MS = 240000;
const watchdog = setTimeout(() => {
  console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`);
  app.exit(1);
}, WATCHDOG_MS);

function view(match) {
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes(match)) || null;
}

function menuItem(label, items = Menu.getApplicationMenu()?.items || []) {
  for (const item of items) {
    if (item.label === label) return item;
    const found = item.submenu && menuItem(label, item.submenu.items);
    if (found) return found;
  }
  return null;
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

/** The state the settings page renders from, read through its own host door. */
const STATE = "window.clawSettings.invoke('state', [])";

/** The row for our address, as the page drew it: its summary, its badge, its buttons. */
const ROW = `(() => {
  const row = [...document.querySelectorAll('#gateways .settings-row')].find((r) => {
    const url = r.querySelector('.url');
    return url && url.textContent.includes('127.0.0.1:19100');
  });
  if (!row) return null;
  return {
    title: row.querySelector('.settings-row__title').textContent,
    summary: row.querySelector('.settings-row__desc').textContent,
    badge: row.querySelector('.badge').textContent,
    buttons: [...row.querySelectorAll('button')].map((b) => b.textContent.trim()),
  };
})()`;

/** Our gateway, read out of the app's own state. */
const MINE = `(async () => {
  const state = await ${STATE};
  const mine = (state.gateways || []).filter((g) => g.url.includes('127.0.0.1:19100'))[0] || null;
  return mine && { id: mine.id, label: mine.label, hasToken: mine.credentials.hasToken };
})()`;

/** Open the editor on our row, and press a button in it by its label. */
const pressInEditor = (label) => `(() => {
  const card = [...document.querySelectorAll('#gateways > .settings-group')]
    .find((c) => /19100/.test(c.innerText));
  if (!card) return { error: 'no card for the gateway' };
  const buttons = [...card.querySelectorAll('.editor button')].map((b) => b.textContent.trim());
  const button = [...card.querySelectorAll('.editor button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
  if (!button) return { error: 'no button labelled ' + ${JSON.stringify(label)}, buttons };
  button.click();
  return { buttons };
})()`;

const openEditor = () => `(() => {
  const card = [...document.querySelectorAll('#gateways > .settings-group')]
    .find((c) => /19100/.test(c.innerText));
  if (!card) return { error: 'no card for the gateway' };
  const edit = [...card.querySelectorAll('.row__actions button')].find((b) => b.textContent.trim() === 'Edit');
  if (!edit) return { error: 'the row offers no Edit' };
  edit.click();
  return { ok: true };
})()`;

const editorButtons = () => `(() => {
  const card = [...document.querySelectorAll('#gateways > .settings-group')]
    .find((c) => /19100/.test(c.innerText));
  if (!card) return null;
  return [...card.querySelectorAll('.editor button')].map((b) => b.textContent.trim());
})()`;

const connectFromRow = () => `(() => {
  const row = [...document.querySelectorAll('#gateways .settings-row')].find((r) => {
    const url = r.querySelector('.url');
    return url && url.textContent.includes('127.0.0.1:19100');
  });
  if (!row) return { error: 'no row for the gateway' };
  const button = [...row.querySelectorAll('button')].find((b) => /^(Connect|Reconnect)/.test(b.textContent.trim()));
  if (!button) return { error: 'the row offers no Connect' };
  const label = button.textContent.trim();
  button.click();
  return { label, summary: row.querySelector('.settings-row__desc').textContent };
})()`;

async function openSettings() {
  const item = menuItem('Settings…');
  if (!item) return null;
  item.click();
  await delay(2500);
  return view('settings.html');
}

app.whenReady().then(async () => {
  await delay(6000);

  /* ---- 1. create the gateway WITH its token, in one pass ---------------- */
  const page = await openSettings();
  check('the settings surface is up', Boolean(page), 'the settings overlay never opened');
  if (!page) { clearTimeout(watchdog); app.exit(1); return; }

  const created = await page.executeJavaScript(`(async () => {
    document.getElementById('new-label').value = ${JSON.stringify(NAME)};
    document.getElementById('new-url').value = ${JSON.stringify(ADDRESS)};
    document.getElementById('new-token').value = ${JSON.stringify(TOKEN)};
    document.getElementById('add').click();
    await new Promise((r) => setTimeout(r, 1200));
    return { result: document.getElementById('test-result').textContent, gateway: await ${MINE} };
  })()`);
  console.log(`note the create form answered: ${created.result}`);
  check('one press created the gateway, with the token',
    Boolean(created.gateway) && created.gateway.hasToken === true, JSON.stringify(created.gateway));

  /* ---- 2. and it connects with that token ------------------------------ */
  const firstConnect = await page.executeJavaScript(connectFromRow());
  check('the new gateway was offered Connect', Boolean(firstConnect) && /^Connect/.test(firstConnect.label || ''), JSON.stringify(firstConnect));
  await delay(10000);
  const firstView = view('19100');
  const firstHash = firstView ? await firstView.executeJavaScript('location.hash') : null;
  console.log(`note the gateway was loaded with the hash: ${firstHash}`);
  check('the gateway was handed the token typed into the create form',
    typeof firstHash === 'string' && firstHash.includes(`token=${TOKEN}`), JSON.stringify(firstHash));
  await grab('edit-remove-created');

  /* ---- 3. remove the stored credential, from its own control ------------ */
  const again = await openSettings();
  check('Settings reopened after connecting', Boolean(again), 'the settings surface never reopened');
  if (!again) { clearTimeout(watchdog); app.exit(1); return; }
  const openedEditor = await again.executeJavaScript(openEditor());
  await delay(600);
  const before = await again.executeJavaScript(editorButtons());
  console.log(`note the editor offers: ${JSON.stringify(before)}`);

  const removed = await again.executeJavaScript(pressInEditor('Remove saved token'));
  await delay(900);
  const afterRemoval = await again.executeJavaScript(`(async () => ({
    gateway: await ${MINE},
    row: ${ROW},
    buttons: ${editorButtons()},
    placeholder: document.querySelector('.editor input[type=password]').placeholder,
    answer: document.querySelector('.editor .result').textContent,
  }))()`);
  console.log(`note after the removal: ${JSON.stringify(afterRemoval)}`);
  await grab('edit-remove-removed');

  check('the editor offered a control that names the stored credential',
    Array.isArray(before) && before.includes('Remove saved token'), JSON.stringify(before));
  check('pressing it removes the stored token',
    Boolean(afterRemoval.gateway) && afterRemoval.gateway.hasToken === false, JSON.stringify(afterRemoval.gateway));
  check('and says so, and stops offering the removal',
    /removed\.$/i.test(afterRemoval.answer || '') && !(afterRemoval.buttons || []).includes('Remove saved token'),
    JSON.stringify({ answer: afterRemoval.answer, buttons: afterRemoval.buttons }));
  check('the field reports nothing stored again',
    afterRemoval.placeholder === 'Not set', JSON.stringify(afterRemoval.placeholder));
  check('and the row says no token is saved',
    /No token saved/.test(afterRemoval.row ? afterRemoval.row.summary : ''), JSON.stringify(afterRemoval.row));

  /* ---- 4. ONE Save writes the whole section ----------------------------- */
  const saved = await again.executeJavaScript(`(async () => {
    const card = [...document.querySelectorAll('#gateways > .settings-group')]
      .find((c) => /19100/.test(c.innerText));
    card.querySelector('.editor input[type=text]').value = ${JSON.stringify(RENAMED)};
    card.querySelector('.editor input[type=password]').value = ${JSON.stringify(NEW_TOKEN)};
    const buttons = [...card.querySelectorAll('.editor button')].map((b) => b.textContent.trim());
    const save = [...card.querySelectorAll('.editor button')].find((b) => b.textContent.trim() === 'Save');
    if (!save) return { error: 'no single Save in the editor', buttons };
    save.click();
    await new Promise((r) => setTimeout(r, 1200));
    return {
      buttons,
      answer: card.querySelector('.editor .result').textContent,
      gateway: await ${MINE},
      row: ${ROW},
    };
  })()`);
  console.log(`note after the single Save: ${JSON.stringify(saved)}`);
  await grab('edit-remove-saved');

  check('editing offers exactly ONE Save and no per-field Clear',
    Array.isArray(saved.buttons) && saved.buttons.filter((b) => b === 'Save').length === 1
      && !saved.buttons.includes('Clear'),
    JSON.stringify(saved.buttons));
  check('that one press renamed the gateway AND stored the credential',
    Boolean(saved.gateway) && saved.gateway.label === RENAMED && saved.gateway.hasToken === true,
    JSON.stringify(saved.gateway));
  check('and the answer names what it kept',
    /token/.test(saved.answer || ''), JSON.stringify(saved.answer));
  check('the row reads the new name with its token saved',
    /Token saved/.test(saved.row ? saved.row.summary : '') && saved.row.title === RENAMED,
    JSON.stringify(saved.row));

  /* ---- 5. and the renamed gateway connects with the new token ----------- */
  const secondConnect = await again.executeJavaScript(connectFromRow());
  check('the row still offers Connect', Boolean(secondConnect) && /^(Connect|Reconnect)/.test(secondConnect.label || ''), JSON.stringify(secondConnect));
  await delay(10000);
  const secondView = view('19100');
  const secondHash = secondView ? await secondView.executeJavaScript('location.hash') : null;
  console.log(`note the gateway was loaded with the hash: ${secondHash}`);
  check('the gateway was handed the token stored by that one Save',
    typeof secondHash === 'string' && secondHash.includes(`token=${NEW_TOKEN}`), JSON.stringify(secondHash));
  await grab('edit-remove-reconnected');

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
