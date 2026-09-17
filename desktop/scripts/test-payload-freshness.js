// Measure what the app renders on a FRESH LAUNCH, after the gateway has started
// serving a different Control UI payload.
//
// The claim under test is Abi's: the server's payload should be what renders, on
// first load and after a cache clear, rather than a pre-loaded or previously
// cached one. Nothing here reasons about that: the gateway is a real server
// serving a distinguishable payload, the app is the real app, and what is printed
// is the text that ended up on screen.
//
// The gateway mimics the two halves of the real one that decide this:
//
//   the document   served with `Cache-Control: no-cache`, which is what
//                  OpenClaw's gateway sends (src/gateway/control-ui.ts), so the
//                  browser revalidates it rather than reusing it blind;
//   the worker     upstream's `ui/public/sw.js` in miniature: it SKIPS top-level
//                  navigations (so the document is the browser's business) and is
//                  cache-first for `/assets/`, with a build id embedded in the
//                  file and a small window of prior build caches kept.
//
// Three markers, because they fail independently and the difference is the whole
// diagnosis: the payload the document itself declares, a hashed asset whose URL
// changes with the build (as upstream's do), and an asset at a FIXED url, which
// is where a cache-first worker serves yesterday's file without asking.
//
// Run it twice against ONE profile to see a launch after an upgrade:
//
//   npx electron scripts/test-payload-freshness.js --phase a --profile /tmp/claw-payload
//   npx electron scripts/test-payload-freshness.js --phase b --profile /tmp/claw-payload
//
// and once more with --phase b and --doc-cache max-age=3600 to see what an edge
// that caches the document does to the same launch.
//
//   npx electron scripts/test-payload-freshness.js [--phase a|b] [--profile DIR]
//                                                  [--doc-cache no-cache|max-age=N]
//                                                  [--shots DIR] [--settle MS]

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { app, webContents, Menu } from 'electron';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const PHASE = (arg('phase', 'a') || 'a').toLowerCase();
if (!['a', 'b'].includes(PHASE)) {
  console.error(`--phase must be a or b, not ${PHASE}`);
  process.exit(2);
}
// The other phase's assets stay served, deliberately: a 404 would prove the app
// fetched, but it would not show WHICH copy it drew. Both are always on offer.
const MARK = { a: 'A', b: 'B' }[PHASE];
/**
 * The build id embedded in the worker, which the app records per origin and
 * compares on every load.
 *
 * Separate from the payload on purpose. A gateway that is upgraded moves both, but
 * the app's own refresh keys on THIS and nothing else, so a run that changes the
 * payload and holds the build id still is the case where nothing auto-clears, and
 * the only way out is the menu's Clear cache and reload. That is what part two of
 * the requirement is about, and it has to be reachable to be measured.
 */
const SW_BUILD = (arg('sw-build', PHASE) || PHASE).toUpperCase();
if (!['A', 'B'].includes(SW_BUILD)) {
  console.error(`--sw-build must be a or b, not ${SW_BUILD}`);
  process.exit(2);
}
/** What the payload must be: the phase letter unless the caller says otherwise. */
const EXPECT = (arg('expect', MARK) || MARK).toUpperCase();
/**
 * What the FIRST paint must be. Defaults to EXPECT, because a stale first paint
 * is the whole question: `--expect-first A --expect B` says "it may show A first",
 * which is how this file records a run that is known to be wrong rather than one
 * that passed.
 */
const EXPECT_FIRST = (arg('expect-first', EXPECT) || EXPECT).toUpperCase();
/** Set to click the menu's Clear cache and reload and check the payload after it. */
const THEN_CLEAR = process.argv.includes('--then-clear-cache');
/**
 * Allow the settled reading to hold a stale FIXED-url asset until the clear.
 *
 * This is the one staleness the document cannot fix and the worker owns: upstream
 * hashes its asset names, so a real Control UI never serves one from the same url
 * across builds, and the app's refresh drops the worker's caches when the build id
 * moves. A run that changes the payload while holding the build id still is the
 * case where nothing auto-clears, and it is the case the menu item exists for, so
 * that run asserts the stale value BEFORE the clear and the fresh one after it.
 */
const ALLOW_STALE_STATIC = process.argv.includes('--allow-stale-static-before-clear');
const DOC_CACHE = arg('doc-cache', 'no-cache');
const SETTLE_MS = Number(arg('settle', 6000));
const PORT = 18845;
const BASE = `http://127.0.0.1:${PORT}`;
const PROFILE = arg('profile') || fs.mkdtempSync(path.join(os.tmpdir(), 'claw-payload-'));
const SHOTS = arg('shots');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// Pinned BOTH ways: main.js decides whether a run is isolated from the
// `--user-data-dir` SWITCH rather than from the path, so a harness that sets only
// the path runs on the real profile. See dump-overlays.js.
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

// Written only when it is not there yet, so the second run of a pair reads the
// profile the first run left behind, which is the thing being measured: the
// recorded build ids and the browser's caches both live in that directory.
const CONFIG = path.join(PROFILE, 'config.json');
if (!fs.existsSync(CONFIG)) {
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(CONFIG, `${JSON.stringify({
    gateways: [{ id: 'marker', label: 'Marker gateway', url: `${BASE}/` }],
    activeGatewayId: 'marker',
  }, null, 2)}\n`);
}

/**
 * The payload, per phase.
 *
 * `doc` is what the served document says, `hashed` is an asset under a name that
 * changes with the build (upstream's are content-hashed), and `static` is one at a
 * fixed name, so a cache-first worker has something to serve stale.
 */
const document = (mark) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Marker Control UI ${mark}</title></head>
<body>
  <div id="doc">doc ${mark}</div>
  <div id="hashed">hashed not loaded</div>
  <div id="static">static not loaded</div>
  <script src="/assets/app-${mark.toLowerCase()}.js"></script>
  <script src="/assets/static.js"></script>
  <script>navigator.serviceWorker.register('/sw.js').catch(() => {});</script>
</body></html>
`;

/** Upstream's worker, reduced to the two behaviours that decide this. */
const worker = (mark) => `const EMBEDDED_CACHE_VERSION = "build-${mark}";
const CACHE_PREFIX = "openclaw-control-";
const CACHE_NAME = CACHE_PREFIX + EMBEDDED_CACHE_VERSION;
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(["./"])));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const mine = keys.filter((key) => key.startsWith(CACHE_PREFIX));
    await Promise.all(mine.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Navigations are the browser's business, exactly as upstream leaves them.
  if (event.request.mode === "navigate") return;
  if (url.pathname.includes("/assets/")) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
    return;
  }
  event.respondWith(fetch(event.request));
});
`;

const asset = (kind, mark) => `document.getElementById('${kind}').textContent = '${kind} ${mark}';
window.__marker_${kind} = '${mark}';
`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  const send = (type, body, headers = {}) => {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': DOC_CACHE, ...headers });
    res.end(body);
  };
  if (url.pathname === '/' || url.pathname === '/index.html') {
    send('text/html; charset=utf-8', document(MARK));
    return;
  }
  if (url.pathname === '/sw.js') {
    send('text/javascript; charset=utf-8', worker(SW_BUILD), { 'Cache-Control': 'no-cache' });
    return;
  }
  const assetMatch = url.pathname.match(/^\/assets\/app-([ab])\.js$/);
  if (assetMatch) {
    send('text/javascript; charset=utf-8', asset('hashed', assetMatch[1].toUpperCase()), {
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return;
  }
  if (url.pathname === '/assets/static.js') {
    send('text/javascript; charset=utf-8', asset('static', MARK), {
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

/** Where the gateway page lives, once there is one. */
function pageWc() {
  return webContents.getAllWebContents().find(
    (wc) => !wc.isDestroyed() && wc.getURL().startsWith(BASE),
  ) || null;
}

/**
 * One item of the application menu, by label, at any depth.
 *
 * The manual half of the requirement is reached through this menu and no other
 * way, so the harness presses the real item rather than calling the function
 * behind it: a check that called the function would pass on a menu that had lost
 * the item. Same helper as dump-overlays.js.
 */
function menuItem(label, items = Menu.getApplicationMenu()?.items || []) {
  for (const item of items) {
    if (item.label === label) return item;
    const found = menuItem(label, item.submenu?.items || []);
    if (found) return found;
  }
  return null;
}

const READ = `({
  doc: (document.getElementById('doc') || {}).textContent || null,
  hashed: (document.getElementById('hashed') || {}).textContent || null,
  static: (document.getElementById('static') || {}).textContent || null,
  controlled: navigator.serviceWorker && navigator.serviceWorker.controller
    ? navigator.serviceWorker.controller.scriptURL : null,
})`;

const CACHE_NAMES = 'caches.keys()';

/** The rendered markers, or null while there is nothing to read them off. */
async function look(wc) {
  if (!wc || wc.isDestroyed()) return null;
  try {
    const seen = await wc.executeJavaScript(READ);
    const caches = await wc.executeJavaScript(CACHE_NAMES).catch(() => []);
    return { ...seen, caches };
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The sequence, not just the outcome. A stale payload that is REPLACED a moment
// later by the app's own refresh still answers "the server's payload is what
// renders" wrongly on the first launch after an upgrade, and only an ordered
// record can tell that apart from a launch that was fresh from the first paint.
const sequence = [];
let navigations = 0;
const started = Date.now();

app.on('web-contents-created', (_e, wc) => {
  wc.on('did-start-navigation', (...args) => {
    // (event, url, isInPlace, isMainFrame, ...) on modern Electron. Reading
    // isMainFrame out of the wrong slot silently counts nothing, which is how
    // the first run of this reported 0 navigations on a launch that clearly
    // navigated.
    const url = args[0] && args[0].url ? args[0].url : args[0];
    const isMainFrame = args[2] === undefined ? true : args[3];
    if (typeof url === 'string' && url.startsWith(BASE) && isMainFrame) {
      navigations += 1;
      console.log(`NAV     ${navigations}: ${url}`);
    }
  });
});

// Sampled rather than read once: each distinct value is recorded with when it
// appeared, so the record says whether A was ever on screen before B.
const sampler = setInterval(async () => {
  const wc = pageWc();
  if (!wc) return;
  try {
    const doc = await wc.executeJavaScript(
      "(document.getElementById('doc')||{}).textContent || null");
    if (doc && (sequence.length === 0 || sequence[sequence.length - 1].doc !== doc)) {
      sequence.push({ doc, atMs: Date.now() - started });
    }
  } catch { /* mid-navigation reads throw; the next tick has one */ }
}, 40);

await import('../src/main.js');

app.whenReady().then(async () => {
  console.log(`payload-freshness: phase ${MARK}, profile ${PROFILE}, document ${DOC_CACHE}`);
  // The first reading that is not the cover: this is what a person sees landing
  // in the window on a launch, before anything the app does about staleness.
  let first = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(120);
    const wc = pageWc();
    if (!wc) continue;
    const seen = await look(wc);
    if (!seen || !seen.doc) continue;
    first = seen;
    break;
  }
  if (!first) {
    console.error('FAIL nothing rendered on the gateway page within 20s');
    app.exit(1);
    return;
  }
  const wc = pageWc();
  if (SHOTS) {
    try {
      fs.writeFileSync(path.join(SHOTS, `first-${MARK}-${DOC_CACHE.replace(/[^a-z0-9]/gi, '')}.png`),
        (await wc.capturePage()).toPNG());
    } catch { /* a shot is evidence, not the check */ }
  }
  console.log(`FIRST   ${JSON.stringify(first)}`);

  await sleep(SETTLE_MS);
  const settled = await look(pageWc());
  if (SHOTS) {
    try {
      fs.writeFileSync(path.join(SHOTS, `settled-${MARK}-${DOC_CACHE.replace(/[^a-z0-9]/gi, '')}.png`),
        (await pageWc().capturePage()).toPNG());
    } catch { /* ditto */ }
  }
  console.log(`SETTLED ${JSON.stringify(settled)}`);
  console.log(`SEQUENCE ${JSON.stringify(sequence)} navigations=${navigations}`);

  // Part two of the requirement, measured through the path a person uses: the
  // menu's Clear cache and reload, which drops the worker's caches and the HTTP
  // cache and loads again. Runs only when asked, because with a moved build id the
  // app has usually cleared by itself already and the interesting run is the one
  // where it has not.
  let afterClear = null;
  if (THEN_CLEAR) {
    const item = menuItem('Clear cache and reload');
    if (!item) { console.error('FAIL no Clear cache and reload in the application menu'); app.exit(1); return; }
    console.log('MENU    clicking Clear cache and reload');
    item.click();
    await sleep(SETTLE_MS);
    afterClear = await look(pageWc());
    console.log(`AFTER-CLEAR ${JSON.stringify(afterClear)}`);
  }

  clearInterval(sampler);
  console.log(`VERDICT phase=${MARK} sw=${SW_BUILD} first=${first.doc} `
    + `settled=${settled ? settled.doc : 'gone'} `
    + `hashed=${settled ? settled.hashed : 'gone'} static=${settled ? settled.static : 'gone'} `
    + `painted=${sequence.map((s) => s.doc).join('->') || 'none'}`);

  // The claims, asserted rather than described, so a run that regresses fails
  // instead of printing a paragraph someone has to read carefully. `--expect-first`
  // is what makes "it painted the old payload first" a FAILURE rather than an
  // observation: with it left at its default, the first paint must already be the
  // server's payload.
  const fails = [];
  const want = (seen, field) => `${field} ${EXPECT}`;
  if (first.doc !== `doc ${EXPECT_FIRST}`) {
    fails.push(`the first paint was ${first.doc}, not doc ${EXPECT_FIRST}`);
  }
  const stale = sequence.filter((s) => s.doc !== `doc ${EXPECT_FIRST}` && s.doc !== `doc ${EXPECT}`);
  if (stale.length) fails.push(`a third payload was painted: ${JSON.stringify(stale)}`);
  if (!settled) fails.push('the page was gone after the settle window');
  else {
    for (const field of ['doc', 'hashed', 'static']) {
      if (ALLOW_STALE_STATIC && field === 'static') continue;
      if (settled[field] !== want(settled, field)) {
        fails.push(`after the launch ${field} is ${settled[field]}, not ${want(settled, field)}`);
      }
    }
    if (ALLOW_STALE_STATIC) {
      console.log(`NOTE    static is ${settled.static} before the clear, which is the worker's `
        + 'cache-first copy of an asset at a fixed url, and only a clear can move it');
    }
  }
  if (THEN_CLEAR) {
    if (!afterClear) fails.push('the page was gone after the cache clear');
    else {
      for (const field of ['doc', 'hashed', 'static']) {
        if (afterClear[field] !== want(afterClear, field)) {
          fails.push(`after the cache clear ${field} is ${afterClear[field]}, not ${want(afterClear, field)}`);
        }
      }
    }
  }

  server.close();
  await sleep(200);
  if (fails.length) {
    for (const fail of fails) console.error(`FAIL ${fail}`);
    app.exit(1);
    return;
  }
  console.log(`OK      phase=${MARK} sw=${SW_BUILD} painted=${sequence.map((s) => s.doc).join('->')} `
    + `settled=${settled.doc}${afterClear ? ` after-clear=${afterClear.doc}` : ''}`);
  app.exit(0);
});

server.listen(PORT, '127.0.0.1');
