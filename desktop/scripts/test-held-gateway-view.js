// Measure what the app holds on screen when the CONNECTION is gone.
//
// The rule is core/ui/CONVENTIONS.md's second one: a disconnected or failing
// client must never present a gateway view, and never one it did not ask for. The
// claim is about frames, not endpoints, because the fault is a screen that keeps
// showing a gateway that is not connected: an assertion about where things ENDED
// cannot see a view that stayed up for six seconds and then went away, and it
// cannot see one that stayed up and never went away either.
//
//   npx electron scripts/test-held-gateway-view.js --case switch|drop|normal [--shots DIR]
//
// The four cases are the four ways a reader meets this:
//
//   switch  a payload from the gateway they were on, then Connect on a gateway
//           that fails. What is on screen the moment our own surface closes?
//   drop    a payload from a gateway that was working, and then that gateway
//           goes away. What is on screen while nothing is connected?
//   normal  a payload held while a fresh copy is fetched successfully, which is
//           the path the previous work depends on and must not change.
//
// Every frame is classified against references captured in the same run, and the
// live views are sampled alongside it, so a frame can be named rather than
// guessed at. The marker gateway is what makes "the gateway view" a thing the
// frames can be compared against at all: two gateways serving visibly different
// documents, one of which is never listening.
//
// Pinned BOTH ways through the `--user-data-dir` switch as well as the path, for
// the reason scripts/test-connection-failure.js records: main.js decides whether
// a run is isolated from the SWITCH, so a harness that sets only the path runs on
// the real profile.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const CASE = (arg('case', 'switch') || '').toLowerCase();
if (!['switch', 'drop', 'normal'].includes(CASE)) {
  console.error(`--case must be switch, drop or normal, not ${CASE}`);
  process.exit(2);
}
const SHOTS = arg('shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const PORT = 18861;
const BASE = `http://127.0.0.1:${PORT}`;
/** The gateway that never answers. A refused port, as the sibling harnesses use. */
const NOWHERE = 'http://127.0.0.1:18862/';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), `claw-held-${CASE}-`));

const { app, BrowserWindow, Menu, desktopCapturer, webContents } = await import('electron');
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [
    { id: 'marker', label: 'Marker gateway', url: `${BASE}/` },
    { id: 'nowhere', label: 'Nowhere', url: NOWHERE },
  ],
  activeGatewayId: 'marker',
}, null, 2)}\n`);

/**
 * The marker Control UI.
 *
 * Deliberately loud and unlike any of the app's own pages: a saturated fill and a
 * heading the size of the window, so a frame that shows it is unmistakable when
 * compared against a cover frame, and so a partly-painted one would be obvious.
 *
 * And it OPENS A SOCKET, which is not decoration: the real Control UI's session
 * lives on one, the observer watches that socket, and the drop case is about what
 * this app does when the socket closes. A page with no socket would make the drop
 * case measure nothing at all, which is what its first run did.
 */
const document = (mark) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Marker Control UI ${mark}</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { background: ${mark === 'A' ? '#1b3ea8' : '#0f7a3d'}; color: #fff;
         font: 700 96px/1 system-ui, sans-serif; display: grid; place-items: center; }
  #mark { letter-spacing: 4px; }
</style></head>
<body><div id="mark">MARKER ${mark}</div>
<script>
  // The Control UI's own behaviour, reduced to the one part that matters here: a
  // session socket, kept open, reconnected after it goes away.
  (function () {
    function open() {
      var socket;
      try { socket = new WebSocket('ws://' + location.host + '/gateway'); } catch (e) { setTimeout(open, 400); return; }
      socket.addEventListener('close', function () { setTimeout(open, 400); });
    }
    open();
  })();
</script>
</body></html>
`;

/** What the gateway is serving right now, so a fresh payload is distinguishable. */
let served = 'A';
/**
 * How long the gateway takes to answer.
 *
 * Zero for every case here: these runs are about what is on screen once a
 * connection has FAILED or gone, and a gateway that answers instantly is the
 * arrangement that gets there fastest. A launch against a gateway that answers
 * late is scripts/test-connection-failure.js's, whose setup is built for it.
 */
let responseDelay = 0;

const server = http.createServer((_req, res) => {
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(document(served));
  }, responseDelay);
});

/** Every socket the gateway has, so closing it is a refused connection. */
const sockets = new Set();
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

/**
 * The gateway end of the page's session socket.
 *
 * Hand-rolled because the point is the CLOSE, not the protocol: the handshake is
 * completed so the page's socket genuinely opens, and then nothing is ever sent on
 * it. The observer reports the close, the page reconnects on a timer, and neither
 * side needs a frame.
 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || !/websocket/i.test(String(req.headers.upgrade))) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
});

/**
 * Stop serving and close what is open, which is a gateway that has gone away.
 *
 * Sockets FIRST, and that order is not tidiness: the page holds a WebSocket now, and
 * `server.close()` waits for every open connection to end, so awaiting it before
 * destroying them waits for a socket that is only going to end when the page gives
 * up, which it never does. Measured: the run sat there until its watchdog.
 */
async function dropGateway() {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await new Promise((resolve) => server.close(resolve));
}

async function serve() {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
}

await serve();
await import('../src/main.js');

/* ------------------------------------------------------------------ helpers */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

const WATCHDOG_MS = 240000;
setTimeout(() => {
  console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`);
  app.exit(1);
}, WATCHDOG_MS).unref();

/* ------------------------------------------------------------------ capture */

/**
 * What the reader is looking at, decided by the views themselves.
 *
 * The composited window is the ideal witness and the harness still captures it,
 * but it is not always available: a sleeping or locked display hands back a BLACK
 * image, and black compares equal to black, which is how a run of identical
 * screenshots passed while measuring nothing. So the frame's meaning comes from the
 * app's own view stack -- which of its views is up, what each one is showing, and
 * the z-order main.js keeps -- and the pixels corroborate it when they are real.
 *
 * The z-order is the load-bearing part and it is one rule worth repeating: the
 * cover sits above the page view (restackViews), so a cover that is up is what the
 * reader sees whatever the page underneath still holds.
 */
async function readViews() {
  const all = live();
  const cover = all.find((wc) => wc.getURL().includes('loading.html')) || null;
  const page = pageWc();
  const overlays = all.filter((wc) => /(settings|about|pairing)\.html/.test(wc.getURL()))
    .map((wc) => (wc.getURL().includes('page=1') ? 'settings-as-page' : wc.getURL().split('/').pop()));

  let coverTitle = null;
  if (cover) {
    try { coverTitle = await cover.executeJavaScript("document.getElementById('title').textContent", true); } catch { coverTitle = null; }
  }
  let mark = null;
  let pageUrl = null;
  if (page) {
    try { pageUrl = page.getURL(); } catch { pageUrl = null; }
    try { mark = await page.executeJavaScript("(document.getElementById('mark')||{}).textContent || null", true); } catch { mark = null; }
  }

  // The topmost thing the reader sees, by the app's own stacking: a modal, then the
  // cover, then the page view (and the page only if it is showing a gateway
  // document at all).
  let top = 'other';
  if (overlays.length) top = 'ours';
  else if (cover) top = 'cover';
  else if (mark) top = 'gateway';
  return { top, cover: coverTitle, mark, overlays, pageUrl };
}

/**
 * One image of the composited window. Only the OS compositor sees the child views.
 *
 * RETRIED, because the compositor hands back an empty thumbnail under load: several
 * capturers call this at once, each `getSources` costs tens of milliseconds, and a
 * run that silently recorded nothing looks exactly like a run where nothing
 * happened. Whether the pixels mean anything is a separate question and a separate
 * answer -- see `contrast`.
 */
async function grab(maxWidth = 360, tries = 3) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const [width, height] = win.getContentSize();
    const scale = maxWidth < width ? maxWidth / width : 1;
    const size = { width: Math.round(width * scale), height: Math.round(height * scale) };
    let mine = null;
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size });
      mine = sources.find((s) => s.id === win.getMediaSourceId()) || sources.find((s) => /claw/i.test(s.name));
    } catch { /* a capture that threw is a capture we try again */ }
    if (mine && !mine.thumbnail.isEmpty()) return mine.thumbnail;
    if (attempt < tries - 1) await delay(8);
  }
  return null;
}

/**
 * How much this image actually varies, 0 being a flat rectangle.
 *
 * A black frame is not a view the reader saw, and it compares equal to every other
 * black frame. Every page this app can show has text, a spinner or a saturated fill
 * on it, so a real frame of one is nowhere near zero.
 */
function contrast(bitmap) {
  if (!bitmap || !bitmap.length) return 0;
  let min = 255;
  let max = 0;
  for (let i = 0; i < bitmap.length; i += 4) {
    const v = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

/** A frame is real evidence only if the window painted something. */
const MIN_CONTRAST = 6;

/** Downsampled because the compositor re-encodes the same picture slightly differently. */
const signature = (image) => image.resize({ width: 160, height: 100 }).toBitmap();

/** Mean absolute difference per channel byte. 0 is identical, Infinity is "no frame". */
function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

const live = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());
const pageWc = () => live().find((wc) => wc.getURL().startsWith(BASE.replace(/\/$/, ''))) || null;
const overlayWc = (file) => live().find((wc) => wc.getURL().includes(`/${file}`)) || null;
const coverWc = () => overlayWc('loading.html');

/** The cover's own words, so a frame can say which of its two states it was in. */
/** The cover's own words, so a frame can say which of its two states it was in. */
async function coverTitle() {
  return (await readViews()).cover;
}

/** The app's view stack, as the older checks below expect to read it. */
async function viewState() {
  return readViews();
}

/**
 * A burst of frames spanning an action.
 *
 * Two records, on purpose. `view` is what the app's own views say the reader is
 * looking at, sampled every tick, and it is the record the checks are made on: it
 * survives a sleeping display, which is when the compositor hands back black.
 * `sig`/`detail` are the composited window's own pixels, kept as corroboration and
 * reported rather than trusted blindly.
 */
async function burst({ ms, actAt = 0, act = null, until = null, name = null }) {
  const frames = [];
  const run = { stop: false, saved: false };
  const started = Date.now();
  const capturer = async () => {
    while (!run.stop) {
      const at = Date.now();
      const win = BrowserWindow.getAllWindows()[0];
      const visible = win ? win.isVisible() : false;
      let sig = null;
      try {
        const image = await grab(360);
        if (image) sig = signature(image);
      } catch { /* a frame we could not take is not a claim about the screen */ }
      frames.push({ at, rel: at - started, sig, detail: sig ? contrast(sig) : 0, visible });
      if (sig && name && !run.saved) {
        run.saved = true;
        if (SHOTS) {
          try { fs.writeFileSync(path.join(SHOTS, `${name}-first.png`), (await grab(720)).toPNG()); } catch { /* evidence, not the check */ }
        }
      }
    }
  };
  const monitor = (async () => {
    let fired = act === null;
    while (Date.now() - started < ms) {
      if (!fired && Date.now() - started >= actAt) { fired = true; Promise.resolve(act && act()).catch(() => {}); }
      let view = null;
      try { view = await readViews(); } catch { /* mid-navigation; the next tick has one */ }
      frames.push({ at: Date.now(), rel: Date.now() - started, view });
      if (until && fired && await until()) break;
      await delay(12);
    }
    run.stop = true;
  })();
  await Promise.all([monitor, capturer(), capturer()]);
  frames.sort((a, b) => a.rel - b.rel);
  return { frames };
}

/** A still frame of the whole window, and of each of the app's own views. */
async function framed(name) {
  const image = await grab(360);
  const sig = image ? signature(image) : null;
  const shot = async (wc, suffix) => {
    if (!SHOTS || !wc) return;
    try { fs.writeFileSync(path.join(SHOTS, `${name}-${suffix}.png`), (await wc.capturePage()).toPNG()); } catch { /* a shot is evidence, not the check */ }
  };
  if (SHOTS && name && image) {
    try { fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG()); } catch { /* ditto */ }
  }
  // The per-view captures are the visual half that survives a display that is not
  // painting the composited window.
  await shot(coverWc(), 'cover');
  await shot(pageWc(), 'page');
  return { sig, detail: sig ? contrast(sig) : 0 };
}

function menuItem(label, items = Menu.getApplicationMenu()?.items || []) {
  for (const item of items) {
    if (item.label === label) return item;
    const found = item.submenu && menuItem(label, item.submenu.items);
    if (found) return found;
  }
  return null;
}

/** Whether the view the app has on top IS the gateway's own document. */
function isGatewayView(view) {
  return Boolean(view) && view.top === 'gateway';
}

/**
 * A compact, ordered record of what the reader was looking at.
 *
 * Labelled by the view on top, and by WHICH document when that view is the
 * gateway's own: "MARKER A" and "MARKER B" are the two payloads this harness
 * serves, so a frame that kept the old one is distinguishable from a frame that
 * fetched a new one, which a boolean could not tell apart.
 */
function viewTimeline(frames) {
  const out = [];
  for (const frame of frames) {
    const view = frame.view;
    if (!view) continue;
    const label = view.top === 'gateway' ? (view.mark || 'gateway') : view.top;
    const last = out[out.length - 1];
    if (!last || last.label !== label) {
      out.push({ label, at: frame.rel, cover: view.cover, overlays: view.overlays.length ? view.overlays : undefined });
    } else {
      last.until = frame.rel;
      if (view.cover) last.cover = view.cover;
    }
  }
  return out;
}

/** How the composited window's own pixels read, for the record. */
function pixelNote(frames) {
  const captured = frames.filter((f) => f.sig).length;
  const painted = frames.filter((f) => f.detail >= MIN_CONTRAST).length;
  return `${captured} captures, ${painted} with paint on them`;
}

const show = (label, entries) => console.log(`${label} ${JSON.stringify(entries)}`);

/* -------------------------------------------------------------------- steps */

app.whenReady().then(async () => {
  console.log(`held-gateway-view: case ${CASE}, profile ${PROFILE}, marker gateway on ${PORT}`);

  // Long enough for the window and the gateway load, then the payload itself: the
  // harness is about what happens AFTER a gateway document is on screen.
  let payload = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await delay(120);
    const wc = pageWc();
    if (!wc) continue;
    if (coverWc()) continue;
    try {
      const mark = await wc.executeJavaScript("(document.getElementById('mark')||{}).textContent || null");
      if (mark === 'MARKER A') { payload = wc; break; }
    } catch { /* mid-load reads throw; the next tick has one */ }
  }
  check('the gateway page is on screen and shows the gateway\'s own document', Boolean(payload),
    `no view at ${BASE} served MARKER A`);
  if (!payload) { server.close(); app.exit(1); return; }
  await delay(1200);
  const refGateway = await framed('gateway-held');

  /* ------------------------------------------------------- case: switch */

  if (CASE === 'switch') {
    const settingsItem = menuItem('Settings\u2026');
    check('the settings surface can be opened', Boolean(settingsItem), 'no "Settings…" menu item');
    if (!settingsItem) { server.close(); app.exit(1); return; }
    settingsItem.click();
    await delay(1800);
    const settings = overlayWc('settings.html');
    check('settings is open over the window', Boolean(settings), 'the settings overlay did not open');

    // The press a reader makes: Connect on the gateway that will fail.
    const pressed = settings ? await settings.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.settings-row')]
        .find((r) => /Nowhere/.test(r.textContent));
      if (!row) return 'no-row';
      const button = [...row.querySelectorAll('button')]
        .find((b) => /^(Re)?[Cc]onnect$/.test(b.textContent.trim()));
      if (!button) return 'no-button';
      button.click();
      return 'pressed';
    })()`, true) : 'no-page';
    check('Connect can be pressed for the gateway that will fail', pressed === 'pressed', String(pressed));

    // Wait for the failure to be reported, which is the moment the app knows.
    const failedDeadline = Date.now() + 20000;
    let reported = false;
    while (Date.now() < failedDeadline) {
      await delay(120);
      const banner = overlayWc('banner.html');
      if (!banner) continue;
      try {
        const text = await banner.executeJavaScript('document.body.innerText', true);
        if (/Cannot connect/.test(text)) { reported = true; break; }
      } catch { /* the banner is rewriting itself; the next tick has one */ }
    }
    check('the failure is reported', reported, 'no "Cannot connect" notice appeared within 20s');

    // Now the reader's own move: leave our surface, which is what reveals the
    // window underneath it.
    const closeBurst = await burst({
      ms: 3000,
      actAt: 250,
      act: () => {
        const wc = overlayWc('settings.html');
        return wc ? wc.executeJavaScript("document.getElementById('close').click()") : null;
      },
    });
    await delay(400);
    await framed('after-close');
    const state = await readViews();
    const line = viewTimeline(closeBurst.frames);
    show('TIMELINE', line);
    console.log(`PIXELS  ${pixelNote(closeBurst.frames)}`);
    console.log(`SETTLED ${JSON.stringify(state)}`);

    // The Settings overlay has its own departure, so the window is only fully
    // revealed a little after the press. Everything after that is the answer to
    // "what is the reader left looking at?".
    const revealed = line.filter((e) => (e.until ?? e.at) > 400);
    check('leaving our surface never shows the previous gateway',
      revealed.every((e) => e.label !== 'MARKER A'),
      `frames showed the previous gateway: ${JSON.stringify(revealed.filter((e) => e.label === 'MARKER A'))}`);
    check('and what is on screen is the app\'s own surface instead',
      state.top === 'cover',
      `the view on top is ${state.top} (${JSON.stringify(state)})`);
    server.close();
    await delay(200);
    fs.rmSync(PROFILE, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
    return;
  }

  /* ------------------------------------------------- case: drop and normal */

  await framed(`before-${CASE}`);
  if (CASE === 'normal') served = 'B';

  const ACT_AT = 300;
  const act = async () => {
    if (CASE === 'drop') {
      await dropGateway();
      console.log('DROP    the gateway is no longer listening');
      return;
    }
    const item = menuItem('Reconnect to gateway');
    if (!item) throw new Error('no "Reconnect to gateway" menu item');
    item.click();
  };

  const frames = await burst({
    // The drop case stops as soon as the app's own surface is up, because that is
    // the claim; the normal case runs its full length so the LANDING is captured.
    ms: CASE === 'drop' ? 9000 : 3000,
    actAt: ACT_AT,
    act,
    until: CASE === 'drop'
      ? async () => (await coverTitle()) === 'Not connected'
      : null,
  });
  await delay(300);
  await framed(`settled-${CASE}`);

  const state = await readViews();
  const line = viewTimeline(frames.frames);
  show('TIMELINE', line);
  console.log(`PIXELS  ${pixelNote(frames.frames)}`);
  console.log(`SETTLED ${JSON.stringify(state)}`);
  check('the run could read the app\'s own views throughout',
    frames.frames.filter((f) => f.view).length >= 8,
    `only ${frames.frames.filter((f) => f.view).length} view samples were taken`);

  if (CASE === 'drop') {
    // The gateway is gone, so from the moment it went away the reader must not be
    // looking at its document. Bounded rather than "eventually": the app learns
    // from the page's own socket closing, which is a round trip through the
    // preload and the main process, and the number printed is where that lands.
    const BOUND_MS = 1200;
    const after = line.filter((e) => (e.until ?? e.at) > ACT_AT);
    const held = after.filter((e) => e.label === 'MARKER A');
    const lastHeld = held.length ? Math.max(...held.map((e) => e.until ?? e.at)) : null;
    console.log(`note the gateway's document was last on top ${lastHeld}ms into the burst, `
      + `${lastHeld === null ? 'which is not at all' : `${lastHeld - ACT_AT}ms after the gateway went away`}`);
    check('the gateway view is off screen within a bound of the drop',
      lastHeld === null || lastHeld - ACT_AT <= BOUND_MS,
      `the gateway view was still on top at ${lastHeld}ms, i.e. ${lastHeld - ACT_AT}ms after the gateway went away`);
    check('the app\'s own surface replaces it',
      state.top === 'cover' && state.cover === 'Not connected',
      `the view on top is ${state.top} saying ${state.cover}`);

    // And the recovery half: the gateway comes back, and the app must not need a
    // person to press anything for the reader to be back on it.
    served = 'B';
    await serve();
    console.log('RESTORE the gateway is back, serving payload B');
    const backDeadline = Date.now() + 25000;
    let recovered = null;
    while (Date.now() < backDeadline) {
      await delay(200);
      const view = await readViews();
      // The reader is on the gateway again only when the gateway's document is the
      // thing ON TOP. The old document stays loaded behind our cover -- measured
      // above, `mark` still reads MARKER A while the cover is up -- so reading the
      // mark alone would call a covered window a recovery.
      if (view.top === 'gateway' && view.mark) { recovered = view.mark; break; }
    }
    check('and comes back on its own when the gateway does', recovered === 'MARKER B',
      `the window was showing ${recovered} rather than the gateway, with no press`);
    if (recovered) await framed('recovered');
  } else {
    // The path the previous work depends on: a held payload while a fresh copy is
    // fetched. It must still hold, and it must still land, with nothing else shown.
    const labels = line.map((e) => e.label);
    check('a normal reconnect still holds the payload it has',
      labels[0] === 'MARKER A', `the sequence opened on ${labels[0]}`);
    check('and still lands on the destination with no intermediate view',
      labels[labels.length - 1] === 'MARKER B' && labels.slice(1, -1).every((l) => l === 'MARKER A'),
      `the sequence was ${JSON.stringify(labels)}`);
    check('with no cover raised over a working interface',
      !frames.frames.some((f) => f.view && f.view.cover),
      'the loading cover was up during a refresh that succeeded');
  }

  server.close();
  await delay(200);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch(async (err) => {
  console.error(`FAIL harness: ${err && err.stack ? err.stack : err}`);
  try { server.close(); } catch { /* already closed */ }
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(1);
});
