// Capture the Gateways tab's two gateway forms, and check they are one shape.
//
//   npx electron scripts/capture-gateway-form.js [--out DIR] [--width N]
//
// Two surfaces live on this tab: the add form under the list, and the editor
// that opens under a row. They are the same field set in two states, which is
// the property this harness exists for, because it is the one a person cannot
// check from a diff: whether the form you create a gateway with offers the same
// fields as the panel you later edit it in. They were two shapes once, and the
// difference was a gateway created half-configured with no token.
//
// So it loads the real page from core/ui with a stub host, exactly as
// capture-pages.js does and for the same reason (a screenshot has to show the
// page the app renders rather than a mock of it), captures both forms in both
// appearances, and asserts that the two forms' fields line up.
//
// The measurements are taken from the RENDERED page, not from the source: an
// input the script builds into an element only after a click is a field nobody
// creating a gateway can see.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { stylesheet as tokenStylesheet } from '../src/tokens.js';
import { themeCss, themeFromReport } from '../src/chrome.js';

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-form-capture-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? path.join(os.tmpdir(), 'claw-form') : process.argv[outIndex + 1];
fs.mkdirSync(OUT, { recursive: true });
const widthIndex = process.argv.indexOf('--width');
const WIDTH = widthIndex === -1 ? 900 : Number(process.argv[widthIndex + 1]);

const REPO = path.join(import.meta.dirname, '..', '..');
const UI = path.join(REPO, 'core', 'ui');

/**
 * What the page renders from when no client is behind it.
 *
 * The spec is read rather than written out, because the page filters its surface
 * from that file. One gateway, with no credential stored, so the editor this
 * capture opens is in its ordinary state rather than a seeded one.
 */
const STATE = {
  client: 'desktop',
  surface: JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'settings.json'), 'utf8')),
  gateways: [
    {
      id: 'alpha',
      label: 'Home gateway',
      url: 'https://gateway.example.ts.net/',
      credentials: { hasToken: false, hasPassword: false, headers: [] },
      status: { tone: 'muted', label: 'Not connected', detail: null },
    },
  ],
  activeGatewayId: null,
  connection: { phase: 'idle' },
  settings: {
    closeToTray: true,
    launchToLogin: false,
    launchAtLogin: false,
    startHidden: false,
    autoUpdate: true,
    promptMetadata: false,
    globalShortcut: 'CommandOrControl+Shift+O',
  },
  appearance: { mode: 'system' },
  build: '1.0.0 (source)',
  certOffers: [],
  trustedCerts: {},
  updates: {},
  secretsError: null,
};

/** The stub host: the desktop's own answers, without the app behind them. */
const PRELOAD = path.join(PROFILE, 'stub-preload.cjs');
fs.writeFileSync(PRELOAD, `
const { contextBridge } = require('electron');
const state = JSON.parse(process.env.CLAW_CAPTURE_STATE || '{}');
contextBridge.exposeInMainWorld('clawSettings', {
  asPage: false,
  invoke: async (command) => {
    if (command === 'addGateway') {
      return Object.assign({}, state, { added: { id: 'added', label: 'stub', url: 'https://stub.example.ts.net/' } });
    }
    if (command === 'setCredentials' || command === 'addHeader') {
      return Object.assign({}, state, { saved: { ok: true, error: null } });
    }
    if (command === 'testGateway') return { ok: true, message: 'Reached it.', fingerprint: null };
    if (command === 'liveNotices' || command === 'noticeHistory') return [];
    return state;
  },
  on: () => {},
});
`);

let failed = false;
function check(name, ok, detail = '') {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

/**
 * What the two forms are made of, read off the rendered page.
 *
 * `fields` is the pair (input type, whether a value is required) in document
 * order, which is what "the same field set" means on screen: the same controls,
 * offering the same thing, in the same order. Nothing here reads a label, so the
 * two forms are compared structurally rather than by wording that is allowed to
 * differ between creating and editing.
 */
const PROBE = `(() => {
  const box = (root) => [...root.querySelectorAll('input')].map((i) => i.type);
  // Found by the form's own container rather than by position, so this measures
  // the same thing before and after the form was given a builder: it is the
  // settings group that holds the address input, or the id it carries now.
  const address = document.getElementById('new-url');
  const add = document.getElementById('add-gateway') || (address ? address.closest('.settings-group') : null);
  const editor = document.querySelector('.editor');
  const text = (root) => [...root.querySelectorAll('button')].map((b) => b.textContent.trim());
  return {
    addFields: add ? box(add) : null,
    editorFields: editor ? box(editor) : null,
    addButtons: add ? text(add) : null,
    editorButtons: editor ? text(editor) : null,
    addVisible: Boolean(add) && add.offsetParent !== null,
    editorVisible: Boolean(editor) && editor.offsetParent !== null,
    background: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: 900,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  process.env.CLAW_CAPTURE_STATE = JSON.stringify(STATE);

  const seen = {};
  for (const mode of ['light', 'dark']) {
    nativeTheme.themeSource = mode;
    await win.loadFile(path.join(UI, 'settings.html'));
    // The page's own palette, applied the way the app applies it. A capture
    // taken without it shows ui.css's fallback colours and cannot tell a page
    // wearing the reader's theme from one wearing its own.
    await win.webContents.insertCSS(tokenStylesheet());
    await win.webContents.insertCSS(themeCss(themeFromReport({ mode, tokens: {} })));
    await new Promise((r) => setTimeout(r, 1000));

    const addShot = path.join(OUT, `gateways-add-${mode}.png`);
    fs.writeFileSync(addShot, (await win.capturePage()).toPNG());
    console.log(`SHOT ${addShot}`);

    // Open the first row's editor: the other half of this surface, reached the
    // way a person reaches it.
    const opened = await win.webContents.executeJavaScript(`(() => {
      const edit = [...document.querySelectorAll('#gateways button')].find((b) => b.textContent.trim() === 'Edit');
      if (!edit) return false;
      edit.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 700));
    const editShot = path.join(OUT, `gateways-edit-${mode}.png`);
    fs.writeFileSync(editShot, (await win.capturePage()).toPNG());
    console.log(`SHOT ${editShot}`);

    const probe = await win.webContents.executeJavaScript(PROBE);
    seen[mode] = probe;
    console.log(`     ${mode} add fields ${JSON.stringify(probe.addFields)} buttons ${JSON.stringify(probe.addButtons)}`);
    console.log(`     ${mode} editor   fields ${JSON.stringify(probe.editorFields)} buttons ${JSON.stringify(probe.editorButtons)}`);

    check(`${mode}: the add form is on screen`, probe.addVisible === true, JSON.stringify(probe));
    check(`${mode}: the editor opened from its row's own button`, opened === true && probe.editorVisible === true, JSON.stringify({ opened, editorVisible: probe.editorVisible }));

    // The invariant this harness exists for. A gateway is created with whatever
    // this form offers, so a form that offers less than the editor produces a
    // gateway that has to be reopened to finish.
    check(`${mode}: creating a gateway offers every field editing one does`,
      Boolean(probe.addFields) && Boolean(probe.editorFields) && probe.addFields.join(',') === probe.editorFields.join(','),
      `the add form offers [${probe.addFields}] and the editor [${probe.editorFields}]`);
    // Named separately from the equality above, because the equality can be
    // satisfied by two forms that are equally incomplete, and the credential is
    // the field this was reported about.
    check(`${mode}: the add form can carry a credential`,
      Boolean(probe.addFields) && probe.addFields.filter((t) => t === 'password').length >= 2,
      `the add form's fields are [${probe.addFields}]`);
    check(`${mode}: the add form offers the test and the add, and says what it adds`,
      Boolean(probe.addButtons) && probe.addButtons.includes('Test connection')
        && probe.addButtons.some((b) => /^Add /.test(b)),
      JSON.stringify(probe.addButtons));
  }

  check('the two appearances paint differently',
    seen.light.background !== seen.dark.background && seen.light.background !== '',
    JSON.stringify({ light: seen.light.background, dark: seen.dark.background }));

  fs.rmSync(PROFILE, { recursive: true, force: true });
  console.log(failed ? 'FAILED' : `OK   captures in ${OUT}`);
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(`FAIL harness: ${err && err.stack ? err.stack : err}`);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(1);
});
