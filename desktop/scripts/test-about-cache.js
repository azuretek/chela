// Prove the About page's Clear cache and refresh button, in the shipped app,
// against a real gateway.
//
//   npx electron scripts/test-about-cache.js [--gateway URL] [--shots DIR]
//
// Needs a reachable Control UI, and the same throwaway gateway
// scripts/test-affordance-placement.js documents:
//
//   OPENCLAW_STATE_DIR=/tmp/claw-affordance-gw/state \
//   OPENCLAW_CONFIG_PATH=/tmp/claw-affordance-gw/openclaw.json \
//   openclaw gateway --port 19099 --auth none --bind loopback --allow-unconfigured
//
// What is asserted is the two things the button promises and one thing it must
// never do. The promises: it CLEARS something, and it says what it cleared; and
// the reload brings the SERVER's current payload rather than the cached one. The
// thing it must not do: touch the origin's storage, which is where the gateway's
// paired-device identity lives, so a clear that reached it would make the gateway
// see a brand-new client and raise a login alert.
//
// Every measurement here is taken in the GATEWAY page, which is the page whose
// caches are in question, read before the press and after the reload.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

const argIndex = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const GATEWAY = argIndex('--gateway', 'http://127.0.0.1:19099/');
const SHOTS = argIndex('--shots', null);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const { app, BrowserWindow, Menu, desktopCapturer, webContents } = await import('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-about-cache-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Control UI', url: GATEWAY }],
  activeGatewayId: 'harness',
}, null, 2)}\n`);

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

/** The build id the gateway is SERVING, read from the server rather than the page. */
async function servedBuildId() {
  const html = await new Promise((resolve, reject) => {
    http.get(GATEWAY, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
  return /data-openclaw-control-ui-build-id="([^"]+)"/.exec(html)?.[1] || null;
}

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

function view(match) {
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes(match)) || null;
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

/** What the gateway page is holding in caches and in storage, read from the page itself. */
const PAGE_MEASURE = `(async () => {
  let cacheEntries = 0;
  let cacheNames = [];
  try {
    cacheNames = await caches.keys();
    for (const name of cacheNames) {
      const cache = await caches.open(name);
      cacheEntries += (await cache.keys()).length;
    }
  } catch (e) { cacheNames = ['unreadable: ' + e.message]; }
  let storageKeys = null;
  try { storageKeys = Object.keys(window.localStorage).length; } catch (e) { storageKeys = -1; }
  return {
    cacheNames,
    cacheEntries,
    storageKeys,
    serviceWorkers: ('serviceWorker' in navigator) ? ((await navigator.serviceWorker.getRegistrations()).length) : 0,
    buildId: document.documentElement.getAttribute('data-openclaw-control-ui-build-id'),
    url: location.href,
  };
})()`;

app.whenReady().then(async () => {
  await delay(9000);

  const gatewayPage = webContents.getAllWebContents().find(
    (wc) => !wc.isDestroyed() && wc.getURL().startsWith(GATEWAY.replace(/\/$/, '')),
  );
  check('the Control UI is loaded', Boolean(gatewayPage), `no view at ${GATEWAY}`);
  if (!gatewayPage) { clearTimeout(watchdog); app.exit(1); return; }

  const serving = await servedBuildId();
  console.log(`note the gateway is serving build ${serving}`);
  check('the gateway names the build it serves', Boolean(serving), 'no build id in the served document');

  // Warm something cacheable before measuring, so a clear has something to remove
  // rather than passing on an empty profile.
  await gatewayPage.executeJavaScript("fetch('/manifest.webmanifest', { cache: 'force-cache' }).then((r) => r.status).catch(() => 0)");
  await delay(1200);
  const before = await gatewayPage.executeJavaScript(PAGE_MEASURE);
  console.log(`note before: ${JSON.stringify({ ...before, url: undefined })}`);

  const about = menuItem('About Chela');
  check('the app can open its About surface', Boolean(about), 'no About menu item');
  if (about) { about.click(); await delay(2500); }
  const aboutView = view('/about.html');
  check('the About surface is up', Boolean(aboutView), 'the About overlay never opened');
  if (!aboutView) { clearTimeout(watchdog); app.exit(1); return; }

  const hasButton = await aboutView.executeJavaScript(
    "(() => { const b = document.getElementById('clear-cache'); return Boolean(b) && b.offsetParent !== null; })()",
  );
  check('the About page offers Clear cache and refresh', hasButton === true, 'the control is missing or hidden');
  await grab('about-clear-cache');

  // The press, through the page's own listener, which is the route a tap takes.
  //
  // Sampling starts BEFORE the press and runs through it, because the end state
  // cannot answer the question: the Control UI is a PWA, so its worker
  // re-registers and refills its bucket as soon as the reload lands, and a
  // measurement taken afterwards reads the same whether the clear happened or was
  // never attempted. What proves the clear is the DIP: the lowest count seen
  // between the press and the reload's own refill.
  const samples = [];
  let sampling = true;
  const sampleOnce = async () => {
    const live = webContents.getAllWebContents().find(
      (wc) => !wc.isDestroyed() && wc.getURL().startsWith(GATEWAY.replace(/\/$/, '')),
    );
    if (!live) return;
    try {
      samples.push(await live.executeJavaScript(PAGE_MEASURE));
    } catch { /* the document is being replaced; the next sample lands in the new one */ }
  };
  const sampler = (async () => {
    while (sampling) {
      // eslint-disable-next-line no-await-in-loop
      await sampleOnce();
      // eslint-disable-next-line no-await-in-loop
      await delay(120);
    }
  })();

  await aboutView.executeJavaScript("document.getElementById('clear-cache').click()");
  await delay(600);
  const immediate = await aboutView.executeJavaScript("document.getElementById('clear-result').textContent");
  console.log(`note immediately after the press: ${immediate}`);

  // Long enough for the clear and for the reload the main process starts after it.
  await delay(9000);
  sampling = false;
  await sampler;
  const settled = await aboutView.executeJavaScript("document.getElementById('clear-result').textContent");
  console.log(`note settled: ${settled}`);
  check('the button says what it cleared rather than that it tried',
    /Cleared cached code and service workers for/i.test(settled), settled);
  check('and names the origin it cleared',
    settled.includes(new URL(GATEWAY).host), settled);
  check('and confirms the reload landed, from the load rather than from the press',
    /reloaded from/i.test(settled), settled);

  // Present is not the same as READABLE, and a report nobody can see is the same
  // fault as no report at all. Measured on 2026-09-16: the line read back
  // correctly from textContent and was INVISIBLE, because it sat after a
  // width:100% control in a non-wrapping actions row and was clipped by the
  // group's overflow:hidden. So this asserts the line has a box, AND that the box
  // is inside the card the reader is looking at rather than past its edge.
  const shown = await aboutView.executeJavaScript(`(() => {
    const node = document.getElementById('clear-result');
    const box = node.getBoundingClientRect();
    const group = node.closest('.settings-group').getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      text: node.textContent,
      onScreen: node.offsetParent !== null && box.width > 0 && box.height > 0,
      insideCard: box.left >= group.left - 1 && box.right <= group.right + 1,
      box: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)],
      card: [Math.round(group.left), Math.round(group.right)],
      colour: style.color,
      visibility: style.visibility,
      textLength: (node.textContent || '').length,
    };
  })()`);
  console.log(`note the result line on screen: ${JSON.stringify(shown)}`);
  check('and the line is actually ON SCREEN, not merely in the DOM',
    shown.onScreen === true && shown.box[3] > 8 && shown.textLength > 40,
    JSON.stringify(shown));
  check('and it is inside the card the reader is looking at, not clipped past its edge',
    shown.insideCard === true,
    `the line spans x ${shown.box[0]}..${shown.box[0] + shown.box[2]} and the card ${shown.card[0]}..${shown.card[1]}`);
  await grab('about-clear-cache-done');

  /* ------------------------------------------------- what it actually did */

  const dipEntries = samples.length ? Math.min(...samples.map((s) => s.cacheEntries)) : -1;
  const dipWorkers = samples.length ? Math.min(...samples.map((s) => s.serviceWorkers)) : -1;
  console.log(`note sampled ${samples.length} page states through the clear: cache entries ${samples.map((s) => s.cacheEntries).join(',')}`);
  console.log(`note service workers seen: ${[...new Set(samples.map((s) => s.serviceWorkers))].join(',')}`);
  check('the cached code really was dropped, seen as a dip rather than as an end state',
    samples.length > 0 && dipEntries === 0,
    `the lowest cache entry count through the clear was ${dipEntries}; the Control UI's worker refills its bucket on the reload, so only the dip can show it`);
  check('and the service worker really was unregistered',
    samples.length > 0 && dipWorkers === 0,
    `the lowest registration count through the clear was ${dipWorkers}`);

  // The view is re-found rather than reused, and that is a fact about the app
  // rather than a convenience: a successful attempt REPLACES the gateway view
  // (`promoteGatewayView` in main.js), so the handle taken before the press may be
  // destroyed by the very reload this is checking. Asked of a dead view, the
  // measurement never resolves.
  const afterPage = webContents.getAllWebContents().find(
    (wc) => !wc.isDestroyed() && wc.getURL().startsWith(GATEWAY.replace(/\/$/, '')),
  );
  check('the Control UI is on screen after the reload', Boolean(afterPage), 'no gateway view after the clear');
  const after = afterPage
    ? await afterPage.executeJavaScript(PAGE_MEASURE)
    : { cacheNames: [], cacheEntries: -1, storageKeys: -1, serviceWorkers: -1, buildId: null, url: '' };
  console.log(`note after:  ${JSON.stringify({ ...after, url: undefined })}`);

  // The half that must NOT be touched. The origin's storage holds the paired
  // device identity, so a clear that reached it would make the gateway see a
  // brand-new client and raise a fresh login alert.
  check('the origin\'s storage was NOT touched',
    after.storageKeys === before.storageKeys,
    `localStorage keys went ${before.storageKeys} -> ${after.storageKeys}, which would orphan the paired device`);
  check('and it was untouched at every instant, not only at the end',
    samples.every((s) => s.storageKeys === before.storageKeys),
    `the sampled storage counts were ${[...new Set(samples.map((s) => s.storageKeys))].join(',')}`);

  // And the reload brought the SERVER's payload: the build id on the live page is
  // the one the gateway is serving now, read from the page rather than assumed.
  check('the page on screen is the build the gateway is serving',
    after.buildId === serving,
    `the page carries ${after.buildId} and the gateway serves ${serving}`);
  check('and it is the same page it was, reloaded rather than navigated elsewhere',
    after.url.split('#')[0] === before.url.split('#')[0],
    `${before.url} -> ${after.url}`);

  console.log(failed ? 'FAILED' : 'ALL OK');
  clearTimeout(watchdog);
  app.exit(failed ? 1 : 0);
});
