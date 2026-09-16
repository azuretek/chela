// Prove the three things about the settings surface that no unit test can see:
// what the credential line actually says, what the layout does when the window
// is narrow, and where the "looking for the gateway's own settings?" card is.
//
// Every one of them is a claim about what ended up on screen, and each has a
// failure mode that passes `npm test`:
//
//   the credential line   a row that composes the right words and renders them
//                         into a hidden element reads as correct in the source.
//                         It also used to say "No saved credentials, you will be
//                         asked to sign in", which was two claims rather than an
//                         observation, so the assertions below check the words
//                         that are actually on the glass and that the old
//                         sentence is gone from it.
//   the narrow layout     a media query that never fires, or fires but leaves the
//                         pill stretched across the card, is invisible to a source
//                         read. This measures real boxes at a real width.
//   the card's home       a card moved into a footer and a card duplicated per tab
//                         look identical in a diff of the page's own text. This
//                         counts the node in the live DOM and switches tabs.
//
// It runs the real app on a throwaway profile, against a plain HTTP server this
// script starts. Nothing here is a gateway: there is no pairing, no device list
// and nothing to revoke, and no state directory belonging to anything real.
//
//   npx electron scripts/test-settings-surface.js [--shots DIR]

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { app, BrowserWindow, Menu, webContents } from 'electron';

// A throwaway profile, pinned BOTH ways, which is what the other harnesses here
// do and for the reason dump-overlays.js records: main.js decides whether a run
// is isolated from the `--user-data-dir` SWITCH rather than from the path, and a
// harness that sets only the path runs on the real profile. This one writes a
// credential, so a run that leaked into the real profile would leave a token
// behind in it as well as render the wrong rows.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-settings-surface-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

const shotIndex = process.argv.indexOf('--shots');
const SHOTS = shotIndex === -1 ? null : process.argv[shotIndex + 1];
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/** A port nothing else is on, because a taken one is a run that proves nothing. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const PORT = await freePort();
// Answers like a gateway that is up, so the active row reaches CONNECTED. That is
// half of the credential line: the device half is only known once a socket has
// been accepted, so without a reachable gateway there would be nothing to assert.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>Gateway</title><h1 id="served">served</h1>');
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

// Two gateways, so the line can be read in both of its states side by side: one
// active and holding a token (both facts known), one with nothing stored. No
// credentials are seeded here: the run saves one through the app's own editor,
// which is the path a person takes.
fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [
    { id: 'alpha', label: 'Alpha gateway', url: `http://127.0.0.1:${PORT}/` },
    { id: 'beta', label: 'Beta gateway', url: `http://127.0.0.1:${PORT}/` },
  ],
  activeGatewayId: 'alpha',
}, null, 2)}\n`);

// Imported dynamically, and after the profile is prepared, because a static
// import would be hoisted and run main before this harness had set the path.
await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const live = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());
const settingsPage = () => live().find((wc) => wc.getURL().includes('settings.html'));
const gatewayPage = () => live().find((wc) => wc.getURL().startsWith(`http://127.0.0.1:${PORT}`));

let failed = false;
function check(name, ok, detail = '') {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

async function shoot(wc, name) {
  if (!SHOTS || !wc) return '';
  try {
    const image = await wc.capturePage();
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG());
    return path.join(SHOTS, `${name}.png`);
  } catch (err) {
    return `no screenshot (${err.message})`;
  }
}

/** A menu item by label, anywhere in the application menu. */
function menuItem(label, items = Menu.getApplicationMenu()?.items || []) {
  for (const item of items) {
    if (item.label === label) return item;
    const found = item.submenu && menuItem(label, item.submenu.items);
    if (found) return found;
  }
  return null;
}

/**
 * What the settings page says about its rows, read off the rendered page.
 *
 * `innerText` rather than `textContent`, deliberately: this is a claim about
 * what a person can read, and a line rendered into a `hidden` element is exactly
 * the failure this is here to catch.
 */
const ROWS = `(() => {
  const rows = [...document.querySelectorAll('#gateways > .card')].map((card) => {
    const row = card.querySelector('.row');
    const badge = row.querySelector('.row__status .badge');
    const actions = row.querySelector('.row__actions');
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
    return {
      text: card.innerText.replace(/\\s+/g, ' ').trim(),
      approval: badge ? badge.innerText.trim() : null,
      badge: badge ? box(badge) : null,
      status: box(row.querySelector('.row__status')),
      actions: actions ? box(actions) : null,
      buttons: actions ? [...actions.querySelectorAll('button')].map((b) => box(b)) : [],
      row: box(row),
    };
  });
  const card = document.getElementById('control-ui-settings');
  return {
    rows,
    cardCount: document.querySelectorAll('#control-ui-settings').length,
    cardVisible: Boolean(card) && !card.hidden && card.getBoundingClientRect().height > 0,
    cardInsidePanel: Boolean(card && card.closest('.panel')),
    tabs: [...document.querySelectorAll('#tabs .tab')].filter((t) => !t.hidden).map((t) => t.id.replace(/^tab-/, '')),
  };
})()`;

const WIDTH_FLIP = 601;

app.whenReady().then(async () => {
  const win = () => BrowserWindow.getAllWindows()[0];
  await delay(6000);

  /* ------------------------------------------------------------ opening it */

  const open = menuItem('Settings…');
  check('the Settings menu item exists', Boolean(open), 'no "Settings…" item in the application menu');
  if (!open) { fs.rmSync(PROFILE, { recursive: true, force: true }); app.exit(1); return; }
  open.click();
  await delay(2000);

  const page = settingsPage();
  check('Settings opened', Boolean(page), 'settings.html never loaded');
  if (!page) { fs.rmSync(PROFILE, { recursive: true, force: true }); app.exit(1); return; }

  /* ------------------------------------- 1. the credential line, at full width */

  // Save a token through the editor, which is the real path: the row is only
  // allowed to claim a saved token once one is actually stored.
  //
  // By label rather than by a class, because the active row's Connect button is a
  // `ghost` too: a class selector here clicked Reconnect and started a second
  // connect instead of opening the editor.
  await page.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('#gateways > .card')]
      .find((c) => /Alpha gateway/.test(c.innerText));
    const edit = [...card.querySelectorAll('.row__actions button')]
      .find((b) => b.textContent.trim() === 'Edit');
    edit.click();
    return true;
  })()`);
  await delay(600);
  const saved = await page.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('#gateways > .card')]
      .find((c) => /Alpha gateway/.test(c.innerText));
    const input = card.querySelector('.editor input[type=password]');
    if (!input) return 'no field';
    input.value = 'harness-not-a-real-token';
    const save = [...card.querySelectorAll('.editor button')]
      .find((b) => b.textContent.trim() === 'Save');
    if (!save) return 'no save button';
    save.click();
    return true;
  })()`);
  check('the token editor took a value', saved === true, String(saved));
  await delay(1200);

  // Collapse the editor, so the screenshots show the row the way it reads in the
  // list rather than mid-edit.
  await page.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('#gateways > .card')]
      .find((c) => /Alpha gateway/.test(c.innerText));
    const done = [...card.querySelectorAll('.row__actions button')]
      .find((b) => b.textContent.trim() === 'Done');
    if (done) done.click();
    return true;
  })()`);
  await delay(600);

  // The device fact is only known once a socket has been accepted, so wait for
  // the connect rather than racing it.
  let wide = await page.executeJavaScript(ROWS);
  for (let i = 0; i < 12 && !/Device approved/.test(wide.rows[0]?.text || ''); i += 1) {
    await delay(1000);
    wide = await page.executeJavaScript(ROWS);
  }

  const alpha = wide.rows[0] || { text: '<no row>', badge: null, actions: null };
  const beta = wide.rows[1] || { text: '<no row>' };
  console.log(`     alpha: ${alpha.text}`);
  console.log(`     beta:  ${beta.text}`);

  check('the active row names the saved token',
    /Token saved/.test(alpha.text), alpha.text);
  check('and the approved device, from the phase the badge already reads',
    /Device approved/.test(alpha.text), alpha.text);
  check('the row with nothing stored says exactly that, and no more',
    /No token saved/.test(beta.text), beta.text);
  check('and the claim that a sign-in is coming is gone from the page',
    !/asked to sign in|No saved credentials/i.test(wide.rows.map((r) => r.text).join(' | ')),
    wide.rows.map((r) => r.text).join(' | '));

  // The wide layout is the one that must not have moved: the state and the three
  // buttons still share a line, with the buttons to the trailing side of it.
  const sameLine = alpha.badge && alpha.actions
    && Math.abs(alpha.badge.top - alpha.actions.top) < 8
    && alpha.actions.left > alpha.badge.right;
  check('at full width the state and the buttons still share one line',
    Boolean(sameLine), JSON.stringify({ badge: alpha.badge, actions: alpha.actions }));
  check('and the badge is still a pill rather than a bar',
    Boolean(alpha.badge) && alpha.badge.width < alpha.row.width * 0.5,
    JSON.stringify({ badge: alpha.badge, row: alpha.row }));
  check('every button is on that line',
    alpha.buttons.length === 3, `${alpha.buttons.length} buttons`);
  console.log(`SHOT ${await shoot(page, 'settings-creds-wide')}`);

  /* ------------------------------------------------- 2. the narrow window */

  const wideBounds = win().getBounds();
  win().setSize(480, 760);
  await delay(1500);

  const narrow = await page.executeJavaScript(ROWS);
  const row = narrow.rows[0] || {};
  console.log(`     narrow: ${row.text}`);
  check(`the window is below the ${WIDTH_FLIP}px floor`,
    (await page.executeJavaScript('window.innerWidth')) < WIDTH_FLIP,
    `innerWidth is ${await page.executeJavaScript('window.innerWidth')}`);

  const buttonsBelowState = row.actions && row.status && row.actions.top >= row.status.bottom - 1;
  check('the buttons are on a line of their own, below the state',
    Boolean(buttonsBelowState), JSON.stringify({ status: row.status, actions: row.actions }));

  const centred = row.badge && (() => {
    const rowMid = (row.row.left + row.row.right) / 2;
    const badgeMid = (row.badge.left + row.badge.right) / 2;
    return Math.abs(rowMid - badgeMid) <= 2;
  })();
  check('the state is centred on that line',
    Boolean(centred), JSON.stringify({ badge: row.badge, row: row.row }));
  check('and it is still a pill: the badge did not stretch to the card width',
    row.badge.width < row.row.width * 0.5,
    JSON.stringify({ badge: row.badge, row: row.row }));
  check('all three buttons are on the one line',
    row.buttons.length === 3
    && row.buttons.every((b) => Math.abs(b.top - row.buttons[0].top) < 4),
    JSON.stringify(row.buttons));
  check('and the URL has the whole card width to wrap into',
    row.actions.left >= row.row.left - 1 && row.actions.right <= row.row.right + 1,
    JSON.stringify({ actions: row.actions, row: row.row }));
  console.log(`SHOT ${await shoot(page, 'settings-narrow')}`);

  /* ------------------------------------------- 3. back to full width, unchanged */

  win().setSize(wideBounds.width, wideBounds.height);
  await delay(1200);
  const back = await page.executeJavaScript(ROWS);
  const backAlpha = back.rows[0] || {};
  check('widening the window puts the row back on one line',
    Boolean(backAlpha.badge && backAlpha.actions
      && Math.abs(backAlpha.badge.top - backAlpha.actions.top) < 8)
    && backAlpha.badge.width < backAlpha.row.width * 0.5,
    JSON.stringify({ badge: backAlpha.badge, actions: backAlpha.actions }));

  /* -------------------------------------- 4. the card, on more than one tab */

  check('there is exactly ONE "looking for the gateway\'s own settings?" card in the document',
    back.cardCount === 1, `${back.cardCount} copies`);
  check('and it is outside every panel, so no tab can hide it',
    back.cardInsidePanel === false, 'the card is still inside a panel');

  const shots = [];
  for (const tab of ['gateways', 'behaviour', 'certificates']) {
    if (!back.tabs.includes(tab)) { console.log(`     (no ${tab} tab on this client)`); continue; }
    await page.executeJavaScript(`document.getElementById('tab-${tab}').click()`);
    await delay(500);
    const seen = await page.executeJavaScript(ROWS);
    check(`the card is on screen on the ${tab} tab`,
      seen.cardVisible && seen.cardCount === 1,
      JSON.stringify({ visible: seen.cardVisible, count: seen.cardCount }));
    shots.push(await shoot(page, `settings-card-${tab}`));
  }
  check('the card was seen on more than one tab', shots.length >= 2, `${shots.length} tab(s)`);
  console.log(`SHOT ${shots.join(' ')}`);

  /* ------------------------------- 5. the other half of the device fact */

  // The approval half has two states and only one of them has been on screen so
  // far. The other is a gateway holding this device's approval, which the
  // observer reports from inside the gateway page: this sends the same payload
  // the observer sends, over the same bridge, on a throwaway profile with a
  // throwaway server behind it.
  const pageWc = gatewayPage();
  if (!pageWc) {
    check('the gateway page is up, so the pending half can be shown', false, 'no gateway page');
  } else {
    await pageWc.executeJavaScript(
      'window.__clawPairingReport(JSON.stringify({ kind: "pairing-required", reason: "not-paired", requestId: "req-harness-0001" }))',
    );
    await delay(2500);
    const pending = await page.executeJavaScript(ROWS);
    const pendingRow = pending.rows[0] || {};
    console.log(`     pending: ${pendingRow.text}`);
    check('an unapproved device reads as needing approval, beside the token it does have',
      /Token saved/.test(pendingRow.text) && /Device needs approval/.test(pendingRow.text),
      pendingRow.text);
    check('and the row still says what to do about it',
      /Approve this device on the gateway host/.test(pendingRow.text), pendingRow.text);
  }

  server.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(`FAIL harness: ${err && err.stack ? err.stack : err}`);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(1);
});
