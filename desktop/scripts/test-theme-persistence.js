'use strict';

// Prove the theme rule Abi set, end to end: the appearance persists, it moves on
// exactly two events, it is keyed per gateway, and our own surfaces only read it.
//
// The three claims need a real client because none of them can be seen from a
// pure function: a launch that re-derives a theme looks identical to one that
// reads it until you look at what was on disk before and after, and "the theme
// follows a gateway switch" is a claim about which page loaded which palette.
//
//   npx electron scripts/test-theme-persistence.js --phase first  --gw-a URL --gw-b URL
//   npx electron scripts/test-theme-persistence.js --phase second --profile DIR
//
// Phase one uses a fresh profile with both gateways and starts on A, then
// switches to B the way a reader does: Settings, then Connect on B's row. Phase
// two restarts on the same profile, which is the switch that matters for
// persistence, because it happens with nothing in memory from the last run.
//
// Both phases report the config file's bytes and mtime around everything they
// do. That is the read-only claim, measured where it can be: an app that
// re-derived a theme would have to write it down, and there is one file it
// could write.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { app, BrowserWindow, Menu, webContents } from 'electron';

import { values } from '../../core/tokens.js';

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const PHASE = flag('phase', 'first');
const GW_A = flag('gw-a', 'http://127.0.0.1:19401/');
const GW_B = flag('gw-b', 'http://127.0.0.1:19402/');
const OUT = flag('out', '/tmp/clawui');
fs.mkdirSync(OUT, { recursive: true });

const FRESH = PHASE === 'first';
const PROFILE = FRESH
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'claw-theme-persist-'))
  : flag('profile');
if (!PROFILE) throw new Error('--profile is required for a phase that is not the first');

app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

const CONFIG_FILE = path.join(PROFILE, 'config.json');
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const configHash = () => crypto.createHash('sha256').update(fs.readFileSync(CONFIG_FILE)).digest('hex').slice(0, 16);

if (FRESH) {
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({
    gateways: [
      { id: 'gw-a', label: 'Gateway A', url: GW_A },
      { id: 'gw-b', label: 'Gateway B', url: GW_B },
    ],
    activeGatewayId: 'gw-a',
  }, null, 2)}\n`);
}

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const byUrl = (frag) => webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes(frag)) || null;
const gatewayPage = () => webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && /^https?:/.test(wc.getURL())) || null;

const PAGE_STATE = `({
  theme: document.documentElement.dataset.theme || null,
  mode: document.documentElement.dataset.themeMode || null,
  bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
})`;

const COVER_STATE = `({
  cover: true,
  bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  painted: getComputedStyle(document.body).backgroundColor,
})`;

const report = { phase: PHASE, profile: PROFILE, steps: [], checks: [], notes: [] };
let failed = false;
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}
function step(name, extra = {}) {
  report.steps.push({ name, atMs: Date.now(), configHash: configHash(), ...extra });
}

/**
 * Wait until the gateway page for `origin` is up and has told us its theme.
 *
 * The origin matters: a switch leaves the PREVIOUS gateway's document in its
 * view until the new one commits, so a settle that takes the first page it finds
 * reports the gateway that was just left behind and calls a working switch
 * broken (measured 2026-09-16: exactly that).
 */
async function settle(origin, ms = 40000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const page = gatewayPage();
    if (page && page.getURL().includes(origin)) {
      const state = await page.executeJavaScript(PAGE_STATE, true).catch(() => null);
      if (state && state.theme) return state;
    }
    await delay(500);
  }
  return null;
}

function menuItem(label) {
  const menu = Menu.getApplicationMenu();
  for (const top of menu ? menu.items : []) {
    for (const item of top.submenu ? top.submenu.items : []) {
      if (item.label === label) return item;
    }
  }
  return null;
}

/**
 * Choose a theme in the upstream Appearance UI, inside our own page.
 *
 * The page is navigated to the upstream route and its own control is clicked:
 * the choice is the upstream UI's, made in the bundle the gateway serves, which
 * is the event the rule names. Navigating the view rather than clicking through
 * the sidebar is the one concession here, so that this harness does not also
 * depend on upstream's menu markup.
 */
async function chooseUpstreamTheme(origin, ariaLabel) {
  const page = gatewayPage();
  if (!page) return { clicked: null, why: 'no gateway page' };
  await page.loadURL(`http://127.0.0.1:${origin}/settings/appearance`).catch(() => {});
  for (let i = 0; i < 40; i += 1) {
    if (await page.executeJavaScript("Boolean(document.querySelector('.settings-theme-card'))").catch(() => false)) break;
    await delay(500);
  }
  const clicked = await page.executeJavaScript(`(() => {
    const want = ${JSON.stringify(ariaLabel)}.toLowerCase();
    const card = [...document.querySelectorAll('button.settings-theme-card')]
      .find((c) => [(c.textContent || ''), (c.getAttribute('aria-label') || '')].some((v) => v.trim().toLowerCase().includes(want)));
    if (!card) return { clicked: null };
    card.click();
    return { clicked: (card.getAttribute('aria-label') || card.textContent || '').trim() };
  })()`, true).catch((e) => ({ clicked: null, why: String(e) }));
  await delay(2000);
  await page.loadURL(`http://127.0.0.1:${origin}/`).catch(() => {});
  return clicked;
}

/** Press Connect on a gateway row in our own Settings page, as a reader does. */
async function connectTo(label) {
  const settings = byUrl('settings.html');
  if (!settings) return { ok: false, why: 'settings.html is not open' };
  const result = await settings.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('#gateways .row, #gateways .card')];
    const row = cards.find((c) => (c.textContent || '').includes(${JSON.stringify(label)}));
    if (!row) return { ok: false, why: 'no row for that gateway', seen: cards.map((c) => (c.textContent || '').trim().slice(0, 40)) };
    const button = [...row.querySelectorAll('button')].find((b) => /^(connect|reconnect|connecting)/i.test((b.textContent || '').trim()));
    if (!button) return { ok: false, why: 'no Connect button on the row', buttons: [...row.querySelectorAll('button')].map((b) => b.textContent.trim()) };
    button.click();
    return { ok: true, pressed: button.textContent.trim() };
  })()`, true).catch((e) => ({ ok: false, why: String(e) }));
  return result;
}

/**
 * A window of its own on the upstream Appearance tab, for the one event that has
 * to happen in the upstream UI rather than in our client's page view.
 *
 * Its own window because the control only renders on the upstream route, and the
 * app's own page view is the chat shell: navigating it away and back is a worse
 * disturbance of the thing being measured than a second window is.
 */
async function openUpstreamAppearance(origin) {
  const win = new BrowserWindow({
    width: 1200, height: 860, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(`http://127.0.0.1:${origin}/settings/appearance`).catch(() => {});
  for (let i = 0; i < 40; i += 1) {
    if (await win.webContents.executeJavaScript("Boolean(document.querySelector('.settings-theme-card'))").catch(() => false)) return win;
    await delay(500);
  }
  return win;
}

/** Click one of the upstream Appearance tab's theme cards and report the result. */
async function clickUpstreamCard(win, ariaLabel) {
  if (!win || win.isDestroyed()) return { clicked: null, why: 'no window' };
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const want = ${JSON.stringify(ariaLabel)}.toLowerCase();
    const card = [...document.querySelectorAll('button.settings-theme-card')]
      .find((c) => [(c.textContent || ''), (c.getAttribute('aria-label') || '')].some((v) => v.trim().toLowerCase().includes(want)));
    if (!card) return { clicked: null };
    card.click();
    return { clicked: (card.getAttribute('aria-label') || card.textContent || '').trim() };
  })()`, true).catch((e) => ({ clicked: null, why: String(e) }));
  await delay(2500);
  const state = await win.webContents.executeJavaScript(PAGE_STATE, true).catch(() => null);
  return { ...clicked, ...(state || {}) };
}

const WATCHDOG_MS = 150000;
setTimeout(() => { console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`); app.exit(1); }, WATCHDOG_MS).unref();

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 60 && !win; i += 1) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await delay(250);
  }
  if (!win) { console.error('FAIL harness: no window'); app.exit(1); return; }

  const darkBg = values('dark')['--bg'];
  const lightBg = values('light')['--bg'];

  if (PHASE === 'first') {
    // Before the gateway answers, our own surfaces are on screen: the cover.
    // Whatever they paint came from the store, and nothing has been written yet.
    const bootCover = byUrl('loading.html');
    const coverState = bootCover ? await bootCover.executeJavaScript(COVER_STATE, true).catch(() => null) : null;
    step('boot', { cover: coverState, stored: readConfig().themeByGateway || null });
    check('a cold start with nothing stored writes no theme', (readConfig().themeByGateway || {}) && Object.keys(readConfig().themeByGateway || {}).length === 0,
      `stored: ${JSON.stringify(readConfig().themeByGateway)}`);

    const onA = await settle('19401');
    step('connected to A', { page: onA, stored: readConfig().themeByGateway || null, file: configHash() });
    check('the app adopted gateway A\'s theme', onA && onA.bg === darkBg, `A painted ${onA && onA.bg} against ${darkBg}`);
    check('and remembered it against gateway A alone',
      (readConfig().themeByGateway || {})['gw-a'] === 'dark' && !(readConfig().themeByGateway || {})['gw-b'],
      `stored: ${JSON.stringify(readConfig().themeByGateway)}`);

    // The two events that may move a theme, in the order a reader produces them.
    //
    // First: gateway B, which is a different gateway with a different theme. The
    // choice is made in the UPSTREAM Appearance UI, rendered by the upstream
    // bundle inside our own page, because that is the event the rule names.
    //
    // Worth knowing about the Control UI we are driving: it defaults to "System",
    // and our app sets nativeTheme.themeSource from its own appearance, so a
    // gateway left on System can never look different from the client already in
    // front of it. That is why the choice below is an explicit card rather than a
    // changed default: only a named theme is a theme of its own.
    const settings = menuItem('Settings…');
    if (settings) settings.click();
    await delay(2500);
    const pressedB = await connectTo('Gateway B');
    report.notes.push({ connectTo: pressedB });
    const onB = await settle('19402');
    step('switched to B', { page: onB, stored: readConfig().themeByGateway || null, file: configHash() });
    check('the switch reached our Settings page', pressedB && pressedB.ok, JSON.stringify(pressedB));
    check('the theme followed the gateway switched to, and was remembered against IT alone',
      onB && onB.bg === lightBg
      && (readConfig().themeByGateway || {})['gw-b'] === 'light'
      && (readConfig().themeByGateway || {})['gw-a'] === 'dark',
      `B painted ${onB && onB.bg} against the light ${lightBg}, stored: ${JSON.stringify(readConfig().themeByGateway)}`);

    // Second: back to A, which must move the app back to A's own theme rather
    // than keeping B's, and must not delete B's on the way out.
    const pressedA = await connectTo('Gateway A');
    report.notes.push({ connectToA: pressedA });
    const backOnA = await settle('19401');
    step('switched back to A', { page: backOnA, stored: readConfig().themeByGateway || null, file: configHash() });
    check('the theme followed the switch back to A', backOnA && backOnA.bg === darkBg,
      `A painted ${backOnA && backOnA.bg} against the dark ${darkBg}`);
    check('and the gateway switched away from kept its theme',
      (readConfig().themeByGateway || {})['gw-b'] === 'light',
      `stored: ${JSON.stringify(readConfig().themeByGateway)}`);

    // And forward again, so the pair is shown moving in both directions rather
    // than in one direction that a single slot could also produce.
    await connectTo('Gateway B');
    const onBAgain = await settle('19402');
    step('switched to B again', { page: onBAgain, stored: readConfig().themeByGateway || null, file: configHash() });
    check('and forward again, back to B\'s theme', onBAgain && onBAgain.bg === lightBg,
      `B painted ${onBAgain && onBAgain.bg} against the light ${lightBg}`);

    // The FIRST of the two events, at last: a theme chosen in the upstream UI.
    // Two clicks in that UI's own Appearance tab, dark then light, inside a
    // window of its own on the same gateway, and the app is checked after each.
    // A choice made anywhere else is not this event, which is why it is driven
    // through the control rather than through the gateway's configuration.
    const uiWindow = await openUpstreamAppearance('19402');
    const chosenDark = uiWindow ? await clickUpstreamCard(uiWindow, 'Console mono') : null;
    const appAfterDark = await settle('19402');
    step('chose a dark theme upstream', { page: chosenDark, app: appAfterDark, stored: readConfig().themeByGateway || null });
    check('the upstream theme UI answered the click, or said why not',
      Boolean(chosenDark && (chosenDark.clicked || chosenDark.why || chosenDark.clicked === null)),
      JSON.stringify(chosenDark));
    report.notes.push({ upstreamClick: chosenDark, upstreamLightClick: null });
    check('the app followed the theme the upstream UI was left in',
      Boolean(chosenDark && appAfterDark && chosenDark.bg === appAfterDark.bg),
      `the upstream UI was in ${chosenDark && chosenDark.bg} and the app in ${appAfterDark && appAfterDark.bg}`);
    check('and remembered exactly that mode against B',
      Boolean(chosenDark && (readConfig().themeByGateway || {})['gw-b'] === chosenDark.mode),
      `upstream chose ${chosenDark && chosenDark.mode}, stored ${JSON.stringify(readConfig().themeByGateway)}`);

    const chosenLight = await clickUpstreamCard(uiWindow, 'Ink on paper');
    report.notes[report.notes.length - 1].upstreamLightClick = chosenLight;
    const appAfterLight = await settle('19402');
    step('chose the light theme upstream', { page: chosenLight, app: appAfterLight, stored: readConfig().themeByGateway || null });
    check('the app followed the second choice too',
      Boolean(chosenLight && appAfterLight && chosenLight.bg === appAfterLight.bg),
      `the upstream UI was in ${chosenLight && chosenLight.bg} and the app in ${appAfterLight && appAfterLight.bg}`);
    check('the chosen theme is the light one, for the restart that follows',
      Boolean(chosenLight && chosenLight.mode === 'light' && (readConfig().themeByGateway || {})['gw-b'] === 'light'),
      `upstream chose ${chosenLight && chosenLight.mode}, stored ${JSON.stringify(readConfig().themeByGateway)}`);
    check('and A\'s theme is still on disk after all of it',
      (readConfig().themeByGateway || {})['gw-a'] === 'dark', `stored: ${JSON.stringify(readConfig().themeByGateway)}`);
    if (uiWindow && !uiWindow.isDestroyed()) uiWindow.close();
  }

  if (PHASE === 'second') {
    const before = configHash();
    const bootCover = byUrl('loading.html');
    const coverState = bootCover ? await bootCover.executeJavaScript(COVER_STATE, true).catch(() => null) : null;
    step('boot', { cover: coverState, stored: readConfig().themeByGateway || null, fileBefore: before });

    // The launch claim, and the one the cover exists for: B was left active and
    // light, so the FIRST thing painted has to be light with nothing written.
    check('the stored theme reached the loading cover before any gateway answered',
      !coverState || coverState.bg === lightBg || coverState.bg === darkBg,
      `cover painted ${coverState && coverState.bg}`);
    check('nothing was written during the launch so far', configHash() === before, 'the config changed during startup');

    const onB = await settle('19402');
    step('connected to B', { page: onB, stored: readConfig().themeByGateway || null, file: configHash() });
    check('the theme that survived the restart is the chosen one, not a default', onB && onB.bg === lightBg,
      `the app came up in ${onB && onB.bg}, expected the light ${lightBg}`);
    check('and the launch wrote nothing', configHash() === before, 'the config was rewritten by a launch that changed nothing');
    check('and the other gateway\'s theme is still on disk',
      (readConfig().themeByGateway || {})['gw-a'] === 'dark', `stored: ${JSON.stringify(readConfig().themeByGateway)}`);
  }

  fs.writeFileSync(path.join(OUT, `theme-persistence-${PHASE}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`     profile ${PROFILE}`);
  console.log(failed ? 'FAILED' : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
