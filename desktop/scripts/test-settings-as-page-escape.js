// Prove that a connect attempted from settings-as-page, and failing, never leaves
// the reader without a way back: the failure banner's one offer must reveal the
// usable settings page rather than doing nothing.
//
// The dead end this guards, measured on 2026-09-18 before the fix: on the desktop
// a first-run / no-active-gateway presentation shows settings AS THE PAGE, where
// Escape and "Back to app" are deliberately dead (there is nothing behind the
// page). A connect pressed there and then failing raised the failure banner whose
// one action was "Open Settings" -- which called openSettings(), which returned a
// no-op because settings was already the whole window. So the reader had a banner
// they could not act on, no gateway on screen, and no working key or control to
// the Control UI. The phone never hit this because its connect dismisses the
// settings sheet, so its banner always sits over the Control UI where the action
// reopens a real modal.
//
// The fix (src/main.js openSettings): when settings IS the page, "Open Settings"
// takes the banner down and returns the reader to the usable page it was
// covering, which is the same escape the phone gets for free.
//
//   npx electron scripts/test-settings-as-page-escape.js [--shots DIR]

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

const shotIndex = process.argv.indexOf('--shots');
const SHOTS = shotIndex === -1 ? null : process.argv[shotIndex + 1];
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const PORT = 18941;
const BASE = `http://127.0.0.1:${PORT}`;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-aspage-escape-'));

const { app, webContents, BrowserWindow } = await import('electron');
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);
// A gateway is configured, but NO active one, which is what puts settings on
// screen AS THE PAGE (the same presentation as a first run). Pinned both ways for
// the reason the sibling harnesses record: main.js reads isolation off the switch.
fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'gw', label: 'Home', url: `${BASE}/` }],
  activeGatewayId: null,
}, null, 2)}\n`);

// A payload the identity check accepts, so pressing Connect gets as far as a real
// load attempt: the marker attribute on <html> and a /healthz. It is taken down
// before the press so the attempt fails.
const shell = '<!doctype html><html data-openclaw-control-ui-build-id="test"><head><meta charset="utf-8"><title>Control UI</title></head><body>UI</body></html>';
const sockets = new Set();
let server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"status":"live"}'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
    'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'" });
  res.end(shell);
});
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const live = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());
const overlayWc = (f) => live().find((wc) => wc.getURL().includes('/' + f)) || null;
const settingsWc = () => live().find((wc) => /settings\.html/.test(wc.getURL())) || null;

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}
async function shoot(wc, name) {
  if (!SHOTS || !wc) return;
  try { fs.writeFileSync(path.join(SHOTS, name), (await wc.capturePage()).toPNG()); } catch { /* evidence, not the check */ }
}

const WATCHDOG_MS = 90000;
setTimeout(() => { console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`); app.exit(1); }, WATCHDOG_MS).unref();

app.whenReady().then(async () => {
  await delay(3500);

  const s = settingsWc();
  check('settings is on screen as the window itself', Boolean(s), 'no settings page');
  if (!s) { server.close(); fs.rmSync(PROFILE, { recursive: true, force: true }); app.exit(1); return; }
  const asPage = await s.executeJavaScript("document.body.classList.contains('as-page')");
  check('and it is in its as-page presentation, where Escape and Back are dead', asPage, 'settings is a modal, not the page');
  await shoot(s, 'as-page.png');

  // Drop the gateway, then press Connect on the row. The attempt will fail.
  for (const sk of sockets) sk.destroy(); sockets.clear();
  await new Promise((r) => server.close(r));
  const pressed = await s.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.settings-row')].find((r) => /Home/.test(r.textContent));
    if (!row) return 'no-row';
    const b = [...row.querySelectorAll('button')].find((x) => /^(Re)?[Cc]onnect$/.test(x.textContent.trim()));
    if (!b) return 'no-button';
    b.click(); return 'pressed';
  })()`);
  check('Connect can be pressed from the page', pressed === 'pressed', String(pressed));

  // Wait for the failure banner. Both failure paths land here and both are the
  // condition the fix must escape: a load that fails after identity (the reported
  // "Cannot connect"), and an address that fails identity first ("is not an
  // OpenClaw gateway"). The banner and its one offer are the same either way, so
  // the guard matches on the offer rather than the sentence.
  let banner = null;
  const dl = Date.now() + 20000;
  while (Date.now() < dl) {
    await delay(150);
    const b = overlayWc('banner.html');
    if (!b) continue;
    try {
      const text = await b.executeJavaScript('document.body.innerText');
      if (/Cannot connect|not an OpenClaw gateway/i.test(text)) { banner = b; break; }
    } catch { /* rewriting */ }
  }
  check('the failed connect raises a banner', Boolean(banner), 'no failure banner within 20s');
  if (!banner) { fs.rmSync(PROFILE, { recursive: true, force: true }); app.exit(1); return; }
  const action = await banner.executeJavaScript("(document.querySelector('.banner__action')||{}).textContent || null");
  check('the banner offers the one way out', action === 'Open Settings', `action: ${action}`);
  await shoot(banner, 'banner.png');

  // THE FIX: following that offer must not be a no-op. It takes the FAILURE notice
  // down and returns the reader to the usable settings page it was covering.
  //
  // The claim is about the connection-failure card specifically, not the whole
  // banner view. Another, unrelated notice may share the bar and keep the view up
  // legitimately: a headless Linux box with no keyring raises a standing "gateway
  // credentials cannot be saved" card, which is nothing to do with this failure and
  // must not be swept by it. So the guard polls for the failure card to go while
  // tolerating anything else on the bar, bounded so a card that never leaves fails.
  await banner.executeJavaScript("document.querySelector('.banner__action').click()");
  const failureCardGone = async () => {
    const b = overlayWc('banner.html');
    if (!b) return true; // the whole bar went, so the failure card certainly did
    try {
      const text = await b.executeJavaScript('document.body.innerText');
      return !/Cannot connect|not an OpenClaw gateway/i.test(text);
    } catch { return true; } // mid-teardown reads throw; the bar is going
  };
  let cleared = false;
  const clearDl = Date.now() + 8000;
  while (Date.now() < clearDl) {
    if (await failureCardGone()) { cleared = true; break; }
    await delay(150);
  }
  check('following it clears the connection-failure notice', cleared,
    'the "Cannot connect" card is still on the bar 8s after Open Settings');

  const after = settingsWc();
  check('and leaves the reader on the settings page', Boolean(after), 'settings is gone, the window is blank');
  if (after) {
    const usable = await after.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.settings-row')].find((r) => /Home/.test(r.textContent));
      if (!row) return { visible: false };
      return {
        visible: !!row.offsetParent,
        canRetry: [...row.querySelectorAll('button')].some((b) => /^(Re)?[Cc]onnect$/.test(b.textContent.trim())),
        canAdd: !!document.querySelector('#add-form') || [...document.querySelectorAll('button')].some((b) => /Add gateway/i.test(b.textContent)),
      };
    })()`);
    check('the settings page is usable: the row is visible and can be retried', usable.visible && usable.canRetry, JSON.stringify(usable));
    check('and another gateway can still be added from it', usable.canAdd, JSON.stringify(usable));
    await shoot(after, 'after-escape.png');

    // The layout flap, at the width it shows. The failed row now reads "Cannot
    // connect", a wider badge than "Connected", and the reported glitch was that
    // badge plus the three action buttons squeezing the text column to nothing so
    // its URL wrapped one character to a line. It showed in the band between the
    // 601px stacking query and the full 720px modal. The window is narrowed into
    // that band and the row measured: the URL must read as one line, and the row's
    // two columns must not overlap. Guards the flex-wrap rule in core/ui/ui.css.
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      const [, h] = win.getSize();
      win.setSize(660, h);
      await delay(500);
      const layout = await after.executeJavaScript(`(() => {
        const row = [...document.querySelectorAll('.settings-row')].find((r) => /Home/.test(r.textContent));
        if (!row) return { measured: false };
        const url = row.querySelector('.url');
        const text = row.querySelector('.settings-row__text');
        const ctrl = row.querySelector('.settings-row__control');
        const ub = url.getBoundingClientRect();
        const tb = text.getBoundingClientRect();
        const cb = ctrl.getBoundingClientRect();
        return {
          measured: true,
          urlWraps: ub.height > 20,
          // Columns overlap only when the trailing one is squeezing the leading
          // one on a shared line; once the row wraps they sit on their own lines.
          columnsOverlap: Math.round(tb.right) > Math.round(cb.left) + 2 && Math.round(cb.top) < Math.round(tb.bottom) - 2,
        };
      })()`);
      await shoot(after, 'after-escape-narrow.png');
      check('the failed row does not wrap its URL character-by-character when narrow',
        layout.measured && !layout.urlWraps, JSON.stringify(layout));
      check('and its two columns never squeeze each other on a shared line',
        layout.measured && !layout.columnsOverlap, JSON.stringify(layout));
    }
  }

  server.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(`FAIL harness: ${err && err.stack ? err.stack : err}`);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(1);
});
