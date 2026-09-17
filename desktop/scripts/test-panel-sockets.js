// Does a panel's own socket disturb the app's connection?
//
// THE REPORT, 2026-09-17, two symptoms together: refreshing the Control UI's
// browser side panel made the MAIN UI refresh, and closing it left the whole app
// stuck on its "Not connected" page, showing the gateway address and a Try again
// button, until the reader pressed it.
//
// WHY THIS IS A SCRIPT. The panel is a dock inside the Control UI's own document,
// and what it does to this app is nothing at all: it opens a socket of its own for
// its screencast stream (dist/control-ui/assets/browser-panel-*.js builds one at
// the \`wsPath\` the gateway hands it). What went wrong was on OUR side, in the
// observer this app injects into the page: it wrapped EVERY WebSocket and reported
// \`disconnected\` for ANY of them that had opened and closed, and the shell read
// that as the gateway going away. So the thing to measure is the shell's own
// reaction, and it needs a real page, a real injected observer and real sockets:
// no unit test can see a cover being raised over a live connection.
//
// The page served here mimics the two sockets a real Control UI has: a SESSION
// socket it opens first and keeps, and a PANEL socket it opens when the reader
// docks something. The commands below are the reader's actions on that panel.
//
//   npx electron scripts/test-panel-sockets.js [--shots DIR]
//
// ★ AND THE GATEWAY HAS TO BE ABLE TO CLOSE A SOCKET. Measured 2026-09-17, after the
// first fix: this server wrote the handshake and never answered a close frame, so
// Chromium held every client socket in CLOSING, the page's `close` event never fired,
// and NOTHING in the run could be reported. The panel checks passed with the faulty
// hook installed (there was no close to report) and the run's own control failed, so
// the file was red and blind at the same time. The echo is one line; without it this
// harness cannot tell the fix from the fault.
//
// Run with: cd desktop && npx electron scripts/test-panel-sockets.js

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { app, webContents, BrowserWindow, desktopCapturer } from 'electron';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const SHOTS = arg('--shots', null);

// Isolation pinned BOTH ways: main.js decides whether a run is isolated from the
// '--user-data-dir' SWITCH rather than from the path, so a harness that sets only
// the path boots against the real profile and the live gateway while asserting
// nothing.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-panel-sockets-'));
app.setPath('userData', TMP);
app.commandLine.appendSwitch('user-data-dir', TMP);
// ★ The page must keep ANSWERING. Measured 2026-09-17: with the window behind a
// terminal, Chromium occludes it, the renderer is frozen, and every
// executeJavaScript against the page then waits out its timeout. A harness that
// reads null at both ends of a change compares null to null and reports "nothing
// moved" for a page it could not read at all, which is the one shape of pass this
// run must never produce. So the freeze is off, the window is brought forward
// before each action, and a missing reading below is a FAILURE rather than an
// equality.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const LOG = path.join(os.tmpdir(), `claw-panel-sockets-${process.pid}.log`);
const record = (line) => { fs.appendFileSync(LOG, `${line}\n`); console.log(line); };
let failed = false;
const check = (name, ok, detail) => {
  if (ok) record(`OK   ${name}`);
  else { record(`FAIL ${name}: ${detail}`); failed = true; }
};
const note = (name, value) => record(`note ${name}: ${value}`);

setTimeout(() => { console.error('FAIL harness: still running after 120s'); app.exit(1); }, 120000).unref();
console.log(`note log file: ${LOG}`);

/**
 * A gateway that speaks just enough WebSocket to be held open.
 *
 * The handshake is written out by hand rather than pulling in a server library,
 * and no frame is ever sent: what the page needs is a socket that OPENS and can
 * CLOSE, which is exactly what the observer watches, and nothing here speaks the
 * gateway protocol itself.
 */
const { createServer } = await import('node:http');
const sockets = { session: new Set(), panel: new Set() };
const server = createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE_HTML);
    return;
  }
  res.writeHead(404).end();
});
const jsonSockets = new Set();
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const which = req.url.includes('panel') ? 'panel' : 'session';
  sockets[which].add(socket);
  jsonSockets.add(socket);
  socket.on('close', () => { sockets[which].delete(socket); jsonSockets.delete(socket); });
  // ★ ANSWER THE CLOSE FRAME, which this server did not do and a real gateway does.
  // Measured 2026-09-17: without the echo Chromium leaves the client socket in
  // CLOSING (readyState 2) and the page's `close` event NEVER fires, so no report
  // can be posted and nothing in this run can happen. The committed version of this
  // file passed the panel checks against the FAULTY hook for that reason (there was
  // nothing to report), while its own control failed, so it could not witness the
  // bug it was written for. A close frame is opcode 0x8; the echo is the same frame
  // stripped to its header, which is what a server that has nothing to say sends.
  socket.on('data', (buf) => {
    if ((buf[0] & 0x0f) !== 0x8) return;
    try { socket.write(Buffer.from([0x88, 0x00])); } catch { /* already gone */ }
    setTimeout(() => socket.destroy(), 10);
  });
  socket.on('error', () => { /* the client went away */ });
});
const port = await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const GATEWAY = `http://127.0.0.1:${port}/page`;
const WS = `ws://127.0.0.1:${port}`;

const PAGE_HTML = `<!doctype html><html data-openclaw-control-ui-build-id="harness">
<head><meta charset="utf-8"><title>Harness gateway</title></head>
<body style="margin:0">
  <div id="feed" style="height:120px;overflow-y:auto;width:400px">
    <div style="height:2000px">the reader's scrolled conversation</div>
  </div>
  <textarea id="composer" rows="3" style="width:400px"></textarea>
  <script>
    // One document, one identity: a reload gives a new one, which is how "the main
    // UI did not reload" is asserted rather than eyeballed.
    window.__boot = Math.random().toString(36).slice(2);
    // The session socket, opened first, exactly as the Control UI opens its own
    // gateway socket before it can render any dock.
    window.__session = new WebSocket('${WS}/gateway');
    window.__panelSocket = null;
    window.__panel = function (command) {
      if (command === 'open' || command === 'refresh') {
        if (window.__panelSocket) { window.__panelSocket.close(); window.__panelSocket = null; }
        window.__panelSocket = new WebSocket('${WS}/panel/stream');
        return 'panel ' + command + 'ed';
      }
      if (command === 'close') {
        if (window.__panelSocket) { window.__panelSocket.close(); window.__panelSocket = null; }
        return 'panel closed';
      }
      if (command === 'closeSession') { window.__session.close(); return 'session closed'; }
      return 'unknown';
    };
    // What the reader would visibly lose if this document reloaded.
    window.__state = function () {
      var c = document.getElementById('composer');
      return JSON.stringify({
        boot: window.__boot,
        value: c.value,
        caret: c.selectionStart,
        scroll: document.getElementById('feed').scrollTop,
        panel: window.__panelSocket ? window.__panelSocket.readyState : null,
      });
    };
  </script>
</body></html>`;

fs.writeFileSync(path.join(TMP, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Harness', url: GATEWAY }],
  activeGatewayId: 'harness',
  // A shortcut the OS refuses, so one stable notice is up throughout and the
  // banner's own view is not a variable in what follows.
  globalShortcut: 'Frobnicate+Zz',
}, null, 2)}
`);

await import('../src/main.js');

const live = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());
const tail = (wc) => (wc.getURL().split('/').pop() || wc.getURL() || 'blank').split('?')[0];
const page = () => live().find((wc) => /^https?:/.test(wc.getURL()) && !wc.getURL().includes('banner.html'));
/** The loading cover, which is what the reader sees as "Not connected". */
const cover = () => live().find((wc) => wc.getURL().includes('loading.html'));

const ask = (wc, script, ms = 1500, label = 'unnamed') => Promise.race([
  wc.executeJavaScript(script).catch((e) => { record(`note executeJavaScript failed on ${tail(wc)}: ${e.message}`); return null; }),
  // Named, because a page that will not answer is either a page being torn down or
  // one that is busy, and which ONE it is decides whether this is noise or the
  // fault. Measured 2026-09-17: an unnamed timeout left a run that passed every
  // check spending eighteen seconds an action wondering who it was asking.
  delay(ms).then(() => { record(`note executeJavaScript did not answer within ${ms}ms (${tail(wc)}, reading ${label})`); return null; }),
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

/** What the reader would lose, plus whether the app is showing its failure surface. */
/**
 * One reading, with its value printed either way.
 *
 * Printed rather than only used, because the question a failing run has to answer
 * is whether a reading came back AT ALL: a comparison of two missing readings is
 * an equality, and this run must never report "nothing moved" for a page it could
 * not read.
 */
async function read(wc, script, label, ms = 1500) {
  const value = await ask(wc, script, ms, label);
  record(`note read ${label}: ${value === null ? 'NOTHING' : JSON.stringify(value).slice(0, 90)}`);
  return value;
}

async function state() {
  const p = page();
  const c = cover();
  return {
    boot: p ? await read(p, 'window.__boot', 'the page boot id') : null,
    reader: p ? await read(p, 'window.__state()', 'the reader state') : null,
    cover: c ? { title: await read(c, 'document.getElementById("title") ? document.getElementById("title").textContent : null', 'the cover title'), failed: await read(c, 'document.body.classList.contains("is-failed")', 'the cover state') } : null,
  };
}

app.whenReady().then(async () => {
  let window = null;
  for (let i = 0; i < 60 && !window; i += 1) {
    window = BrowserWindow.getAllWindows()[0] || null;
    if (!window) await delay(250);
  }
  check('the app has a window', Boolean(window), 'no window after 15s');
  if (!window) { app.exit(1); return; }

  let p = null;
  for (let i = 0; i < 60 && !p; i += 1) { p = page() || null; if (!p) await delay(500); }
  check('the gateway page is on screen', Boolean(p), 'no page after 30s');
  if (!p) { app.exit(1); return; }

  // The app is connected when its cover is gone: a load that finished on a page
  // that is not ours takes the cover down, and the pairing settle confirms the
  // session from the socket the page opened.
  let connected = false;
  for (let i = 0; i < 40 && !connected; i += 1) {
    connected = !cover();
    if (!connected) await delay(250);
  }
  check('★ the app connected and took its cover down', connected,
    'the cover never came down, so the session was never confirmed and nothing below would be measuring a connected app');
  check('the page opened its session socket', sockets.session.size === 1,
    `the harness gateway sees ${sockets.session.size} session sockets`);

  // The reader, mid-sentence and mid-scroll.
  p.focus();
  await delay(400);
  await ask(p, '(() => { const c = document.getElementById("composer"); c.focus(); c.value = "dear panel"; c.setSelectionRange(4, 4); document.getElementById("feed").scrollTop = 320; return true; })()');
  const start = await state();
  note('the reader\'s state before any panel action', start.reader);
  check('the reader has text, a caret and a scroll position to lose', Boolean(start.reader)
    && JSON.parse(start.reader).value === 'dear panel' && JSON.parse(start.reader).scroll === 320,
    `the page would not set up the reader's state: ${start.reader}`);

  /** Run one panel action, then say what the app did in response. */
  async function panelAction(command) {
    // Bring the window forward first: a frozen page cannot be read, and a reading
    // that never happened is not evidence of anything.
    app.focus({ steal: true });
    window.focus();
    p.focus();
    await delay(200);
    const before = await state();
    const said = await ask(p, `window.__panel(">${command}<".slice(1, -1))`, 3000);
    await delay(1500);
    const after = await state();
    const lost = [];
    // A reading that came back missing is not "unchanged": it is nothing at all,
    // and this is the assertion that says so rather than comparing two nulls.
    if (!before.reader || !after.reader || !before.boot || !after.boot) {
      lost.push(`the page could not be read at this moment (before ${JSON.stringify(before.reader)}, after ${JSON.stringify(after.reader)})`);
    }
    if (after.cover) lost.push(`the app is showing its failure surface (${after.cover.title})`);
    if (after.boot !== before.boot) lost.push(`the page RELOADED (boot ${before.boot} became ${after.boot})`);
    const b = after.reader ? JSON.parse(after.reader) : {};
    const a = before.reader ? JSON.parse(before.reader) : {};
    if (b.value !== a.value) lost.push(`the composer went from ${JSON.stringify(a.value)} to ${JSON.stringify(b.value)}`);
    if (b.caret !== a.caret) lost.push(`the caret moved from ${a.caret} to ${b.caret}`);
    if (b.scroll !== a.scroll) lost.push(`the scroll moved from ${a.scroll} to ${b.scroll}`);
    note(`panel ${command}`, `${said}; ${lost.length ? lost.join('; ') : 'nothing moved'}`);
    return { lost, after };
  }

  // ★ 1 and 2: the panel's own socket closing and refreshing. Neither is this
  // app's connection, and neither may reach the reader.
  const closed = await panelAction('close');
  check('★ closing the panel leaves the app connected and the reader where they were', closed.lost.length === 0, closed.lost.join('; '));

  const refreshed = await panelAction('refresh');
  check('★ refreshing the panel reloads nothing of the app', refreshed.lost.length === 0, refreshed.lost.join('; '));

  // 3: the cycle, repeatedly, because a fault that only appears on the first
  // attempt is a fault the shape of this one hides.
  const cycle = [];
  for (let i = 0; i < 3; i += 1) {
    cycle.push(await panelAction('open'));
    cycle.push(await panelAction('close'));
    cycle.push(await panelAction('refresh'));
  }
  const broken = cycle.filter((step) => step.lost.length);
  check('★ three open, close and refresh cycles leave the app healthy throughout', broken.length === 0,
    broken.map((b) => b.lost.join('; ')).join(' | '));

  await shot('after-the-cycles');
  const held = await state();
  check('the same document is still on screen after nine panel actions', Boolean(held.boot) && held.boot === start.boot,
    `the page reloaded during the cycles: ${start.boot} became ${held.boot}`);

  // ★ And the instrument's own control: a REAL drop must still be seen, or the
  // fix would be an app that cannot notice anything. The session socket is the
  // one the report is about, so closing it must raise the failure surface.
  //
  // And the close has to be WATCHED, because a control that cannot fire is not a
  // control. The page records its own `close` event here so the run can say whether
  // the drop it is about to ask for was even delivered, rather than reading a cover
  // that never appeared and calling it a pass or a mystery.
  await ask(p, 'window.__closedSeen = false; window.__session.addEventListener("close", function () { window.__closedSeen = true; }); true');
  const said = await ask(p, 'window.__panel("closeSession")', 3000, 'the close-session command');
  note('the page said', String(said));
  let noticed = false;
  let seen = 'no cover at all';
  for (let i = 0; i < 40 && !noticed; i += 1) {
    await delay(250);
    const c = cover();
    // The cover EXISTING is the signal: the app raised its own surface over the
    // page, which is what "the gateway is gone" looks like from here. Its title is
    // read too and reported, but a title that will not answer must not turn a
    // raised cover into "nothing happened".
    if (c) {
      const title = await ask(c, 'document.getElementById("title") ? document.getElementById("title").textContent : null', 1500, 'the cover title');
      seen = `the app\'s own cover is up, title ${JSON.stringify(title)}`;
      if (title === 'Not connected' || title === null) noticed = title === 'Not connected';
    }
  }
  check('★ the session socket closing is still reported, so the app can still see a real drop', noticed,
    `closing the page\'s session socket raised nothing: ${seen}`);
  check('the page saw its own session socket close', await ask(p, 'window.__closedSeen === true', 1500, 'the close event'),
    'the close event never fired, so this run cannot exercise a real drop at all');
  await shot('after-the-real-drop');

  // ★ And a drop is where a PANEL socket is likeliest to be mistaken for the session:
  // the page behind the cover is still alive, and a reader who thinks the gateway is
  // gone may open or refresh a panel. Adopting that socket posts `authenticated`, the
  // report that re-runs this app's own load path, so the main view reloads a second
  // time off a panel action. The socket's endpoint is what tells it from the session.
  const bootAfterDrop = await read(p, 'window.__boot', 'the page boot id after the drop');
  await ask(p, 'window.__panel("open")', 3000, 'the post-drop panel open');
  let reloadedByPanel = false;
  for (let i = 0; i < 12 && !reloadedByPanel; i += 1) {
    await delay(500);
    const boot = await read(p, 'window.__boot', 'the page boot id after the post-drop panel open');
    if (boot && boot !== bootAfterDrop) reloadedByPanel = true;
  }
  check('★ a panel socket opening after a drop does not re-run the app load path', !reloadedByPanel,
    'the main view reloaded because a PANEL socket opened');

  record(`note the app is showing`, noticed ? 'its failure surface, as it should for a real drop' : 'nothing');
  console.log(failed ? 'FAILED' : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
