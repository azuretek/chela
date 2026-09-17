// Does a notice appearing, changing, or going away move the reader's focus?
//
// THE CLAIM, and the one Abi reported on 2026-09-17: "when they pop up what I'm
// typing gets stopped. nothing should take focus unless its by rule". The notice
// bar is drawn over the Control UI in a view of its own, and the reader's caret
// lives in a control inside the page underneath it, so anything the bar does to
// the window's focus is felt as a stopped keyboard mid-sentence.
//
// WHY THIS IS A SCRIPT AND NOT A UNIT TEST. What is being measured is which
// WebContents the window hands the keyboard to, and whether the page's own
// document kept focus. Neither is visible to a fake DOM: a unit test can assert
// that no line calls focus(), which is exactly the assertion that would have
// missed the fault, because the fault is not a call.
//
// WHAT IS MEASURED, at each of the three moments the bar changes:
//
//   * the webContents that reports isFocused(), by URL, so a theft names its
//     thief;
//   * document.hasFocus() and document.activeElement in the page underneath;
//   * the caret's own offset and the text in the composer;
//   * and one character typed at the moment, sent the way the OS sends one, into
//     whichever webContents holds the keyboard. A character that lands somewhere
//     else is the reader's sentence, gone.
//
// HOW A NOTICE IS RAISED HERE. The app's own Settings command is driven from a
// hidden window carrying this app's preload (src/preload.cjs), which is the page
// -side door the settings surface uses. Saving a global shortcut the OS refuses
// raises the app's real 'shortcut' notice; saving one it accepts clears it; and
// saving a different refused one changes the notice's own sentence, which is the
// in-place rebuild. All three are the app's production paths, and none of them
// touches the page or the cover, which is what makes the page's focus the only
// thing this measures. The hidden window is never shown, so it takes no focus of
// its own.
//
//   npx electron scripts/test-banner-focus.js [--shots DIR]
//
// Run with: cd desktop && npx electron scripts/test-banner-focus.js

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { app, webContents, BrowserWindow, desktopCapturer } from 'electron';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const SHOTS = arg('--shots', null);

// Isolation is pinned BOTH ways, because main.js decides whether a run is
// isolated from the '--user-data-dir' SWITCH rather than from the path: a harness
// that sets only the path boots against the REAL profile and the live gateway
// while asserting nothing.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-banner-focus-'));
app.setPath('userData', TMP);
app.commandLine.appendSwitch('user-data-dir', TMP);

// The page underneath, served from here. It has to be a real page with a real
// composer in it: this claim is about what the reader was typing into, and a
// refused gateway leaves a blank view where nothing can hold a caret.
const { createServer } = await import('node:http');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html data-openclaw-control-ui-build-id="harness">'
    + '<head><meta charset="utf-8"><title>Harness gateway</title></head>'
    + '<body><h1 id="served">served</h1>'
    + '<textarea id="composer" rows="3" autocomplete="off"></textarea></body></html>');
});
const port = await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const GATEWAY = 'http://127.0.0.1:' + port + '/';

fs.writeFileSync(path.join(TMP, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Harness', url: GATEWAY }],
  activeGatewayId: 'harness',
  // Not an accelerator, so globalShortcut.register throws and the app raises the
  // real 'shortcut' notice at startup. This run then CLEARS it and raises it
  // again, which is the difference between a notice that was already on screen
  // when the reader started typing and one that arrives mid-sentence.
  globalShortcut: 'Frobnicate+Zz',
}, null, 2)}
`);

// The bridge page: our own file, loaded by a window that is never shown. It holds
// no focus and displays nothing; it exists so the harness can call the app's own
// IPC the way the settings surface does.
const BRIDGE = path.join(TMP, 'bridge.html');
fs.writeFileSync(BRIDGE, '<!doctype html><html><body>bridge</body></html>');

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Every line goes to a file as well as to the terminal, synchronously: the
// watchdog exits the process on a hang and Node buffers stdout when it is a pipe.
const LOG = path.join(os.tmpdir(), `claw-banner-focus-${process.pid}.log`);
const record = (line) => { fs.appendFileSync(LOG, `${line}\n`); console.log(line); };
let failed = false;
const check = (name, ok, detail) => {
  if (ok) record(`OK   ${name}`);
  else { record(`FAIL ${name}: ${detail}`); failed = true; }
};
const note = (name, value) => record(`note ${name}: ${value}`);

console.log(`note log file: ${LOG}`);
setTimeout(() => { console.error('FAIL harness: still running after 120s'); app.exit(1); }, 120000).unref();

const live = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());
const tail = (wc) => (wc.getURL().split('/').pop() || wc.getURL() || 'blank').split('?')[0];
const page = () => live().find((wc) => /^https?:/.test(wc.getURL()) && !wc.getURL().includes('banner.html'));
const banner = () => live().find((wc) => wc.getURL().includes('banner.html'));
const focused = () => live().find((wc) => wc.isFocused()) || null;

/** Ask a page something, but never wait forever on one that cannot answer. */
const ask = (wc, script, ms = 3000) => Promise.race([
  wc.executeJavaScript(script).catch(() => null),
  delay(ms).then(() => null),
]);

async function shot(name) {
  if (!SHOTS) return;
  try {
    const sources = await Promise.race([
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1400, height: 900 } }),
      delay(6000).then(() => null),
    ]);
    if (sources && sources[0]) fs.writeFileSync(path.join(SHOTS, `${name}.png`), sources[0].thumbnail.toPNG());
    else note(`screenshot ${name}`, 'not captured (no screen source)');
  } catch (e) { note(`screenshot ${name}`, `not captured (${e})`); }
}

/** Everything this harness asserts, read from the app at one moment. */
async function state() {
  const p = page();
  const b = banner();
  const holder = focused();
  return {
    holder: holder ? tail(holder) : null,
    pageFocus: p ? await ask(p, 'document.hasFocus()') : null,
    active: p ? await ask(p, 'String((document.activeElement && (document.activeElement.id || document.activeElement.tagName)) || "none")') : null,
    value: p ? await ask(p, 'document.getElementById("composer").value') : null,
    caret: p ? await ask(p, 'document.getElementById("composer").selectionStart') : null,
    banner: b ? { id: b.id, cards: await ask(b, 'document.querySelectorAll(".banner").length'), detail: await ask(b, '[...document.querySelectorAll(".banner__detail")].map((n) => n.textContent.slice(0, 40)).join(" | ")') } : null,
  };
}

/**
 * Type one character the way the OS does: into whichever webContents holds the
 * keyboard right now.
 *
 * This is the half a focus assertion cannot make on its own. If the bar took the
 * keyboard, the character goes to the bar and the reader's sentence is missing a
 * letter, which is what "what I'm typing gets stopped" means.
 */
async function typeChar(ch) {
  const target = focused();
  if (target) {
    target.sendInputEvent({ type: 'keyDown', keyCode: ch });
    target.sendInputEvent({ type: 'char', keyCode: ch });
    target.sendInputEvent({ type: 'keyUp', keyCode: ch });
  }
  await delay(400);
  return target ? tail(target) : null;
}

app.whenReady().then(async () => {
  let window = null;
  for (let i = 0; i < 60 && !window; i += 1) {
    window = BrowserWindow.getAllWindows()[0] || null;
    if (!window) await delay(250);
  }
  check('the app has a window', Boolean(window), 'no window after 15s');
  if (!window) { app.exit(1); return; }
  // Frontmost: the character this harness types is delivered by the window
  // server, and a keystroke sent to another application proves nothing.
  app.focus({ steal: true });
  window.focus();
  await delay(1500);

  let p = null;
  for (let i = 0; i < 60 && !p; i += 1) { p = page() || null; if (!p) await delay(500); }
  check('the gateway page is on screen', Boolean(p), 'no http page after 30s');
  if (!p) { app.exit(1); return; }
  const gatewayUrl = p.getURL();

  // The reader, mid-sentence: focus in the composer, five characters in, the
  // caret at the end of them. The focus is RETRIED to a deadline rather than
  // assumed, because a window that is not yet frontmost cannot hold the keyboard,
  // and a run that measured from there would be reporting its own precondition as
  // the fault: nothing below means anything unless the page is holding it first.
  await ask(p, 'document.getElementById("composer").value = "dear "');
  let seeded = null;
  for (let i = 0; i < 20; i += 1) {
    window.show();
    app.focus({ steal: true });
    window.focus();
    p.focus();
    await delay(250);
    const read = await ask(p, '(() => { const i = document.getElementById("composer"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); return JSON.stringify({hasFocus: document.hasFocus(), active: document.activeElement.id, value: i.value, caret: i.selectionStart}); })()');
    if (read) {
      seeded = read;
      if (JSON.parse(read).hasFocus) break;
    }
  }
  note('the composer, as the reader left it', seeded || 'not readable');
  check('the composer holds the reader\'s text and the page holds the keyboard',
    Boolean(seeded && JSON.parse(seeded).hasFocus && JSON.parse(seeded).active === 'composer'),
    `the page never took the keyboard for this run, so every reading below would be about nothing: ${seeded}`);
  // And the instrument itself, before anything is measured with it: a character
  // typed now must land. Without this, a run whose typing goes nowhere at all
  // reads exactly like a run where the bar took the keyboard.
  const control = await typeChar('z');
  let seededValue = await ask(p, 'document.getElementById("composer").value');
  // Polled to a deadline: what is being checked is that the character arrives, not
  // that it arrives inside one tick of the harness asking.
  for (let i = 0; i < 8 && seededValue === 'dear '; i += 1) {
    await delay(250);
    seededValue = await ask(p, 'document.getElementById("composer").value');
  }
  check('the harness can type into the composer at all (the positive control)',
    typeof seededValue === 'string' && seededValue === 'dear z',
    `a character typed with the page holding the keyboard went to ${control} and left the composer at ${JSON.stringify(seededValue)}`);
  await ask(p, '(() => { const i = document.getElementById("composer"); i.value = "dear "; i.setSelectionRange(5, 5); return true; })()');

  const bridge = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL('../src/preload.cjs', import.meta.url)),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  await bridge.loadFile(BRIDGE);
  // The literal JSON goes in as source rather than through a helper argument, so
  // what the app receives is exactly what is written here.
  const save = (json) => bridge.webContents.executeJavaScript(
    `window.clawSettings.invoke("saveSettings", ${json}).then((r) => JSON.stringify(r.shortcut)).catch((e) => "ERR " + e.message)`,
  );
  const wired = await save('[{}]');
  check('the app answers its own settings command', wired !== 'undefined', `the settings command did not answer: ${wired}`);

  const before = await ask(p, 'document.getElementById("composer").value');
  const typing = [];
  const moments = [];

  /** One moment of the bar's life: what state() says, and where a character goes. */
  async function moment(name, ch) {
    const s = await state();
    const landed = await typeChar(ch);
    const after = await ask(p, 'document.getElementById("composer").value');
    moments.push({ name, s, landed, after, typed: ch });
    note(name, `keyboard held by ${s.holder}; page hasFocus=${s.pageFocus}; activeElement=${s.active}; caret=${s.caret}; value=${JSON.stringify(s.value)}; banner=${s.banner ? s.banner.cards + ' card(s), ' + JSON.stringify(s.banner.detail) : 'down'}`);
    note(`${name} (typed)`, `"${ch}" went to ${landed}, composer is now ${JSON.stringify(after)}`);
    return s;
  }

  /**
   * Wait for the bar to reach a state, then measure in it.
   *
   * The bar is loaded OFF the window and attached when its document is ready (see
   * attachReadyView in src/main.js), so "the notice was raised" and "the bar is on
   * screen" are a few hundred milliseconds apart, and a view that is not attached
   * is not listed by webContents.getAllWebContents() at all. Measuring between the
   * two would report a bar that had not arrived yet, which says nothing about
   * whether its arrival took the keyboard.
   */
  async function waitForBanner(want, ms = 6000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const b = banner();
      // Returns something TRUTHY for the state being waited for, which for 'down'
      // cannot be the view: the caller's check is a boolean, and a wait that
      // returns null when the state it wanted is precisely the state with no bar
      // reports a success as a failure.
      if (want === 'down') {
        if (!b) return 'down';
      } else if (b) {
        const detail = await ask(b, 'JSON.stringify([...document.querySelectorAll(".banner__detail")].map((n) => n.textContent).join(" "))');
        if (String(detail || '').includes(want)) return b;
      }
      await delay(200);
    }
    return null;
  }

  // 1. The bar goes away. A shortcut the OS accepts means nothing is wrong with
  //    it, so the notice clears and its view is removed from the window.
  note('saveSettings (a working shortcut)', await save('[{"globalShortcut":""}]'));
  check('the bar left the screen when the last notice was cleared', Boolean(await waitForBanner('down')),
    'the bar is still up after its only notice was cleared');
  const cleared = await moment('a notice cleared', 'a');
  check('clearing the last notice took the bar down', cleared.banner === null,
    `the bar is still up with ${cleared.banner && cleared.banner.cards} card(s)`);

  // 2. The bar arrives, which is the moment Abi reported: the window creates the
  //    bar's view and loads its page while the reader is mid-sentence.
  const bannerBefore = banner();
  note('saveSettings (a refused shortcut)', await save('[{"globalShortcut":"Frobnicate+Aa"}]'));
  const up = await waitForBanner('Frobnicate+Aa');
  check('★ raising a notice put the bar on screen, and it is a NEW view', Boolean(up) && (!bannerBefore || up.id !== bannerBefore.id),
    bannerBefore ? 'the webContents was reused, so nothing new was created' : 'no bar on screen after the notice was raised');
  const raised = await moment('a notice appearing', 'b');
  check('raising a notice left the bar showing its own sentence', Boolean(raised.banner),
    'no banner view after the notice was raised');
  check('raising a notice created a NEW view for it',
    Boolean(raised.banner) && (!bannerBefore || raised.banner.id !== bannerBefore.id),
    'the same webContents was reused, so nothing new was created and this proves nothing');

  // 3. The same notice, saying something different, which is the in-place rebuild
  //    every download percentage and every re-worded condition goes through.
  note('saveSettings (a differently refused shortcut)', await save('[{"globalShortcut":"Frobnicate+Bb"}]'));
  const rebuilt = await waitForBanner('Frobnicate+Bb');
  check('the card changed in place, in the same view', Boolean(rebuilt) && Boolean(raised.banner) && rebuilt.id === raised.banner.id,
    `the card did not change in the same view: raised=${raised.banner && raised.banner.id}, now=${rebuilt && rebuilt.id}`);
  await moment('a card changing in place', 'c');
  note('the view the bar is in, raised then now', `${raised.banner && raised.banner.id} then ${banner() && banner().id}`);

  check('the card changed in place and no new view was made for it',
    Boolean(changed.banner) && changed.banner.id === raised.banner.id,
    `the view id moved from ${raised.banner && raised.banner.id} to ${changed.banner && changed.banner.id}`);

  // 4. And the reader's own deliberate act still works, so the bar has not been
  //    made unreachable by keyboard: the control on it can be focused and used.
  const b = banner();
  const focusable = b ? await ask(b, '(() => { const n = document.querySelector(".banner__readall"); if (!n) return null; n.focus(); return JSON.stringify({active: document.activeElement.className}); })()') : null;
  check('a control on the bar can be focused by the reader', Boolean(focusable && /banner__readall/.test(focusable)),
    `no banner control could be focused: ${focusable}`);

  await shot('after');
  await delay(200);

  // The verdict, and it is about all three moments at once: the keyboard never
  // left the page, the composer kept its text and its caret, and every character
  // typed at the moment landed in it.
  const stolen = moments.filter((m) => m.s.pageFocus !== true || m.s.active !== 'composer');
  check('★ no moment moved the reader\'s focus', stolen.length === 0,
    stolen.map((m) => `${m.name}: page hasFocus=${m.s.pageFocus}, activeElement=${m.s.active}, keyboard held by ${m.s.holder}`).join('; '));

  const lost = moments.filter((m) => m.after === m.s.value);
  check('★ every character typed at the moment reached the composer', lost.length === 0,
    lost.map((m) => `"${m.typed}" typed while ${m.name} did NOT land in the composer (it went to ${m.landed}, and the value stayed ${JSON.stringify(m.after)})`).join('; '));

  const expected = before + moments.map((m) => m.typed).join('');
  const actual = moments[moments.length - 1].after;
  check('★ the reader\'s sentence is exactly what they typed, plus what they typed through the changes',
    actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

  const caret = await ask(p, 'document.getElementById("composer").selectionStart');
  check('the caret is still where the typing left it', caret === expected.length,
    `caret at ${caret}, text is ${expected.length} characters long`);

  record(`note gateway page under test: ${gatewayUrl}`);
  console.log(failed ? 'FAILED' : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
