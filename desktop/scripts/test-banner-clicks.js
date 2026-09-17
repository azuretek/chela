// Prove the banner's own controls answer a REAL mouse click, at the point a
// person aims at.
//
// Why this cannot be a unit test or a synthetic event. A notice banner is a
// WebContentsView laid over the page, and every page of ours keeps a grab band
// (`core/ui/ui.css` .dragbar) that is 50px tall starting at the page's own top.
// A drag region is a window-drag surface: the OS never delivers a mouse-down
// inside it to any web contents, so a banner whose pixels overlap that band is
// dead exactly there, however it is drawn. `webContents.sendInputEvent` cannot
// see this, because it injects into the renderer's pipeline and bypasses the
// window's hit test: it reports a working button on a button nobody can press.
// The honest instrument is a real click at real screen coordinates, which is
// what this does, through System Events.
//
//   npx electron scripts/test-banner-clicks.js [--target close|action]
//                                              [--expect dead|alive]
//                                              [--shots DIR]
//
// `--expect dead` is the state this reproduced on 2026-09-16, before the fix: the
// click lands in the drag band and nothing happens. `--expect alive` is the claim
// the fix makes. Both are asserted, so this file records the fault rather than
// quietly passing once it is gone.
//
// Isolation is pinned BOTH ways, because main.js decides whether a run is
// isolated from the '--user-data-dir' SWITCH rather than from the path: a harness
// that sets only the path boots against the REAL profile and the live gateway
// while asserting nothing. See dump-overlays.js, and test-banner.js, which had
// exactly that fault until this harness was written.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { app, webContents, desktopCapturer, BrowserWindow } from 'electron';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-banner-clicks-'));
app.setPath('userData', TMP);
app.commandLine.appendSwitch('user-data-dir', TMP);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const SHOTS = arg('--shots', null);
const TARGET = arg('--target', 'close');
const EXPECT = arg('--expect', 'alive');

// The gateway this run points at. Unreachable by default, which is one of the
// conditions that raises a notice, but a reachable one matters for the decisive
// test: the connection notice is raised again on every reconnect attempt, so
// against a dead gateway the banner can go from two cards to one and back to two
// and a dismissed card looks like one that never went.
const GATEWAY = arg('--gateway', 'http://127.0.0.1:18791/');

fs.writeFileSync(path.join(TMP, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Harness', url: GATEWAY }],
  activeGatewayId: 'harness',
  // Not an accelerator, so globalShortcut.register throws and the app raises the
  // real 'shortcut' notice, whose condition never becomes false: one stable,
  // dismissible card, which is what a click test needs.
  globalShortcut: 'Frobnicate+Zz',
}, null, 2)}\n`);
console.log(`note gateway under test: ${GATEWAY}`);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

await import('../src/main.js');
const chrome = (await import('../src/chrome.js'));
const { contentInset } = chrome;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Every line goes to a file as well as to the terminal, synchronously. The
// watchdog exits the process on a hang, and Node buffers stdout when it is a
// pipe: measured 2026-09-16, where the last four verdicts of a run were lost
// with the exit and the harness looked as if it had stopped earlier than it had.
const LOG = path.join(os.tmpdir(), `claw-banner-clicks-${process.pid}.log`);
const record = (line) => { fs.appendFileSync(LOG, `${line}\n`); console.log(line); };
let failed = false;
const check = (name, ok, detail) => {
  if (ok) record(`OK   ${name}`);
  else { record(`FAIL ${name}: ${detail}`); failed = true; }
};
const note = (name, value) => record(`note ${name}: ${value}`);

/** Ask a web contents something, but never wait on one that cannot answer. */
const ask = (wc, script, ms = 2500) => Promise.race([
  wc.executeJavaScript(script).catch(() => null),
  delay(ms).then(() => null),
]);

console.log(`note log file: ${LOG}`);

setTimeout(() => { console.error('FAIL harness: still running after 90s'); app.exit(1); }, 90000).unref();

const bannerContents = () => webContents.getAllWebContents()
  .find((wc) => !wc.isDestroyed() && wc.getURL().includes('banner.html'));

/** Every page of ours, by the tail of its URL, for an "what changed" comparison. */
const pageSet = () => new Set(webContents.getAllWebContents()
  .filter((wc) => !wc.isDestroyed())
  .map((wc) => (wc.getURL().split('/').pop() || '').split('?')[0])
  .filter(Boolean));

/**
 * Click a real screen point, through /tmp/click (CGEvent at the HID tap).
 *
 * Not System Events: it hung twice on 2026-09-16 on the very click being
 * verified, at a point that had returned promptly minutes before, and a tool that
 * cannot distinguish "the click did nothing" from "the click never happened"
 * cannot verify this claim. This posts a real click that goes through the window
 * server's hit test, so a drag region still swallows it.
 */
const clickAt = (x, y) => new Promise((resolve) => {
  execFile('/tmp/click', [String(Math.round(x)), String(Math.round(y))], { timeout: 8000 },
    (error, stdout, stderr) => resolve({ error: error ? String(error.message || error) : null, out: String(stdout || '').trim(), stderr: String(stderr || '').trim() }));
});

async function shot(name) {
  if (!SHOTS) return;
  try {
    // Raced against a deadline: macOS gates `desktopCapturer` behind Screen
    // Recording permission, and an ungranted call can sit there rather than
    // failing. A screenshot is the human-readable half of this harness, never the
    // claim, so a capture that cannot happen must not hold the verdict.
    const sources = await Promise.race([
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1400, height: 900 } }),
      delay(6000).then(() => null),
    ]);
    if (sources && sources[0]) fs.writeFileSync(path.join(SHOTS, `${name}.png`), sources[0].thumbnail.toPNG());
    else console.log(`note screenshot ${name}: not captured (no screen source)`);
  } catch (e) { console.log(`note screenshot ${name}: not captured (${e})`); }
}

app.whenReady().then(async () => {
  // The window and the banner both arrive asynchronously, and asking for either
  // too early is a harness that reports a fault in the app. Wait for the window
  // rather than assuming `whenReady` implies it.
  let window = null;
  for (let i = 0; i < 60 && !window; i += 1) {
    window = BrowserWindow.getAllWindows()[0] || null;
    if (!window) await delay(250);
  }
  check('the app has a window', Boolean(window), 'no window after 15s');
  if (!window) { app.exit(1); return; }

  // Frontmost, because a click at a screen point goes to whatever is on top
  // there, and a click delivered to another application's window proves nothing.
  app.focus({ steal: true });
  window.focus();
  await delay(2500);

  let bc = null;
  for (let i = 0; i < 40 && !bc; i += 1) {
    bc = bannerContents() || null;
    if (!bc) await delay(250);
  }
  check('the banner view exists', Boolean(bc), 'no banner webContents found after 10s');
  if (!bc) { app.exit(1); return; }
  await delay(600);

  const targets = await ask(bc, `(() => {
    const rect = (sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
               cx: r.x + r.width / 2, cy: r.y + r.height / 2, label: (node.textContent || '').trim().slice(0, 24) };
    };
    return {
      close: rect('.banner__close'),
      action: rect('.banner__action'),
      stack: rect('.banner-stack'),
      height: document.body.scrollHeight,
    };
  })()`, 6000);

  const inset = contentInset().top;
  const contentBounds = window.getContentBounds();
  note('window content bounds on screen', `${contentBounds.x},${contentBounds.y} ${contentBounds.width}x${contentBounds.height}`);
  note('banner view', `y ${inset}..${inset + targets.height} (page reports ${targets.height}px tall)`);
  note('banner controls (page coords)', JSON.stringify({ close: targets.close, action: targets.action }));

  // Every other page, and how far its grab band reaches. This is the half that
  // explains the fault rather than describing it.
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed() || wc.id === bc.id) continue;
    const drag = await ask(wc, `(() => {
        const node = document.querySelector('.dragbar');
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { top: Math.round(r.y), bottom: Math.round(r.y + r.height), height: Math.round(r.height) };
      })()`);
    const name = (wc.getURL().split('/').pop() || wc.getURL()).split('?')[0];
    if (drag) {
      const overlaps = drag.top < inset + targets.height && drag.bottom > inset;
      note(`grab band on ${name}`, `page y ${drag.top}..${drag.bottom} (${drag.height}px) -> window y ${inset + drag.top}..${inset + drag.bottom}` + (overlaps ? '  OVERLAPS THE BANNER' : ''));
    }
  }

  const target = TARGET === 'action' ? targets.action : targets.close;
  check(`the banner has the ${TARGET} control to aim at`, Boolean(target), `the ${TARGET} control is not in the banner`);
  if (!target) { app.exit(1); return; }

  // Arm the banner itself, so "the banner did not react" can be told apart from
  // "the click never reached the banner". Those two have different causes and
  // only one of them is the fault Abi reported.
  const armedBanner = await ask(bc, `(() => {
      window.__clawBannerClicks = 0;
      window.__clawBannerHits = [];
      document.addEventListener('mousedown', (event) => {
        window.__clawBannerClicks += 1;
        window.__clawBannerHits.push({
          what: String((event.target && (event.target.className || event.target.tagName)) || '?'),
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
        });
      }, true);
      return true;
    })()`);
  check('the banner page is instrumented', armedBanner === true, 'the banner would not take a listener');

  // The control for the instrument itself: a click over the page BENEATH the
  // banner, which no drag band covers, reported back by the page's own listener.
  // Without this, "the banner did not react" is equally consistent with a clicker
  // that cannot click, which is exactly how a dead button passes a test.
  let controlPage = null;
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed() || wc.id === bc.id) continue;
    const armed = await ask(wc, `(() => {
        if (!document.body) return false;
        window.__clawClickProbe = 0;
        document.addEventListener('mousedown', () => { window.__clawClickProbe += 1; }, true);
        return true;
      })()`);
    if (armed) { controlPage = wc; break; }
  }
  if (controlPage) {
    const probePoint = { x: contentBounds.x + 700, y: contentBounds.y + inset + 400 };
    const control = await clickAt(probePoint.x, probePoint.y);
    await delay(700);
    const seen = await ask(controlPage, 'window.__clawClickProbe', 2000);
    check('the clicker reaches the app at all (control click over the page)', seen >= 1,
      `the page beneath the banner saw ${seen} mouse-down(s); clicker said ${control.error || control.out}`);
  } else {
    note('control click', 'skipped: no page underneath answered');
  }

  const screenX = contentBounds.x + target.cx;
  const screenY = contentBounds.y + inset + target.cy;
  console.log(`note aiming at: ${TARGET} "${target.label}" centre = screen ${Math.round(screenX)},${Math.round(screenY)}`);  const before = pageSet();
  await shot('before-click');

  const result = await clickAt(screenX, screenY);
  console.log(`note click: ${result.error ? `NOT DELIVERED: ${result.error} ${result.stderr}` : `delivered (${result.out})`}`);
  await delay(1800);
  await shot('after-click');

  // Did the window move? A mouse-down inside a drag region starts a window drag,
  // and a drag both moves the window and eats the click (the mouse-up ends up
  // somewhere else), which looks exactly like an unclickable button.
  const endBounds = window.getContentBounds();
  const moved = endBounds.x !== contentBounds.x || endBounds.y !== contentBounds.y;
  console.log(`note window: ${moved ? `MOVED from ${contentBounds.x},${contentBounds.y} to ${endBounds.x},${endBounds.y} (a drag was started by that click)` : 'stayed put'}`);
  const hits = await ask(bc, 'JSON.stringify(window.__clawBannerHits || [])', 2000);
  console.log(`note what the click landed on: ${hits}`);

  const gone = !bannerContents();
  const bannerSaw = await ask(bc, 'window.__clawBannerClicks', 2000);
  // The view stays while ANY card is up, so "the banner went away" is the wrong
  // question when the app has two notices stacked: measured 2026-09-16, where a
  // click that did dismiss its card was reported as swallowed because a second
  // card kept the view on screen.
  const cardsAfter = gone ? 0 : await ask(bc, `document.querySelectorAll('.banner__close').length`, 2000);
  const dismissed = gone || (typeof cardsAfter === 'number' && cardsAfter < targets.cards);
  const after = pageSet();
  const appeared = [...after].filter((u) => !before.has(u));
  console.log(`note after the click: banner ${gone ? 'gone' : `up with ${cardsAfter} card(s), was ${targets.cards}`}; the banner page saw ${bannerSaw} mouse-down(s); pages appeared: ${appeared.join(', ') || 'none'}`);
  const changed = dismissed || appeared.length > 0;

  if (EXPECT === 'dead') {
    check('the click did NOT reach the banner control (the fault, reproduced)', !changed,
      'something happened, so the control WAS clickable here');
  } else if (TARGET === 'close') {
    check('the click reached the X and dismissed its card', dismissed,
      `nothing was dismissed and the banner page saw ${bannerSaw} mouse-down(s): ` +
      (bannerSaw >= 1 ? 'the click ARRIVED, so the dismiss path is what failed' : 'the click never reached the banner, so something in front of it is eating it'));
  } else {
    check('the click reached the action button and something followed from it', changed,
      'nothing changed, so the click was swallowed');
  }

  console.log(failed ? 'FAILED' : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
