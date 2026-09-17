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
//   npx electron scripts/test-banner-clicks.js [--target close|action|readall|dead]
//                                              [--expect dead|alive]
//                                              [--shots DIR]
//
// `--expect dead` is the state this reproduced on 2026-09-16, before the fix: the
// click lands in the drag band and nothing happens. `--expect alive` is the claim
// the fix makes. Both are asserted, so this file records the fault rather than
// quietly passing once it is gone.
//
// `--target dead` is the OTHER half of "the click reaches what a person aimed
// at", and it is the direction that was reported three times in this area: a
// point inside the banner's own rectangle that is NOT one of its controls, aimed
// at the transparent strip below the cards in the sweep control's row. A click
// there belongs to the page underneath, because that is what the reader can see
// through it. Three readings are printed for it, and they name different faults:
// the banner page saw the click and the page beneath did not (an element of the
// banner is hit-testable where the pixel is transparent, which is a declaration
// in banner.css); neither saw it (the click never left the banner's view, which
// is the view bounds in main.js and no stylesheet can fix); or the page beneath
// saw it, which is live.
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

// The gateway this run points at, SERVED FROM HERE unless one is given.
//
// The page underneath the banner has to be a real page, or the through-click
// target measures nothing: it asserts that a click on a transparent pixel reaches
// what the reader can see there, and with a refused gateway the view below the
// banner is blank, so that view's silence reads as "the click was eaten" whatever
// the stylesheet says. Measured 2026-09-17, on the first runs of that target: the
// window stacked titlebar | blank | banner, and the blank view would not take a
// listener at all.
//
// The served document carries OpenClaw's own payload marker because that is what
// makes main.js accept an address as a gateway and load it rather than refuse it
// (core/gateway-identity.js reads the marker names from
// core/spec/gateway-identity.json). The banner still comes up in every run: the
// profile below sets a global shortcut the OS cannot register, which is a real
// condition whose notice never stops being true.
//
// `--gateway` still overrides, which is how the unreachable case is reproduced.
const GIVEN_GATEWAY = arg('--gateway', null);
let gatewayServer = null;
let GATEWAY = GIVEN_GATEWAY;
if (!GIVEN_GATEWAY) {
  const { createServer } = await import('node:http');
  gatewayServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html data-openclaw-control-ui-build-id="harness">'
      + '<head><meta charset="utf-8"><title>Harness gateway</title></head>'
      + '<body><h1 id="served">served</h1><p id="under">the page under the banner</p></body></html>');
  });
  const port = await new Promise((resolve, reject) => {
    gatewayServer.once('error', reject);
    gatewayServer.listen(0, '127.0.0.1', () => resolve(gatewayServer.address().port));
  });
  GATEWAY = `http://127.0.0.1:${port}/`;
}

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
      // The sweep, which is the other control in the strip and the one the
      // strip's own surface sits under: it is at the TRAILING edge with nothing
      // drawn around it, so a band of the page's own background there is a
      // control sitting on an opaque block rather than over the content.
      readall: rect('.banner__readall'),
      stack: rect('.banner-stack'),
      // The point Abi reported: inside the banner's own rectangle, below the
      // cards, in the row the sweep control sits in and to the LEFT of it. It
      // is a pixel the page beneath is showing through, so it is exactly where
      // a click must belong to that page rather than to the banner.
      dead: (() => {
        const box = (sel) => {
          const node = document.querySelector(sel);
          if (!node) return null;
          const r = node.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        };
        const stack = box('.banner-stack');
        if (!stack) return null;
        const cards = [...document.querySelectorAll('.banner')].map((n) => n.getBoundingClientRect());
        if (!cards.length) return null;
        // THE STRIP UNDER THE CARDS: 24px below the lowest card they draw, in the
        // leading part of the width where nothing is drawn. Defined against the
        // CARDS rather than against the sweep's own row, because the row is what
        // the fix removes and a point that follows it would move with it: this is
        // the same pixel of the window before and after, which is what makes the
        // two readings a comparison.
        const lowest = Math.max(...cards.map((c) => c.y + c.height));
        const x = stack.x + 200;
        const y = lowest + 24;
        const overACard = cards.some((c) => x >= c.x && x <= c.x + c.width && y >= c.y && y <= c.y + c.height);
        return {
          x: Math.round(x), y: Math.round(y), w: 0, h: 0, cx: x, cy: y, overACard,
          label: 'the transparent area under the cards',
        };
      })(),
      // How many cards are up, so a click that dismissed one can be told apart
      // from a click that did nothing while a second card kept the view alive.
      cards: document.querySelectorAll('.banner__close').length,
      height: document.body.scrollHeight,
    };
  })()`, 6000);

  const inset = contentInset().top;
  const contentBounds = window.getContentBounds();
  note('window content bounds on screen', `${contentBounds.x},${contentBounds.y} ${contentBounds.width}x${contentBounds.height}`);
  note('banner view', `y ${inset}..${inset + targets.height} (page reports ${targets.height}px tall)`);
  note('banner controls (page coords)', JSON.stringify({ close: targets.close, action: targets.action }));

  // Every other page, and every element in it that CLAIMS A DRAG REGION, with
  // where that region lands in the window.
  //
  // The region is the whole question, and reading the band instead is how this was
  // missed the first time: a band with a region on it and a band without one look
  // identical in a stylesheet, print identical geometry, and behave opposite ways.
  // So this asks the computed style of every element on every page rather than
  // looking for a familiar class, and reports each region against the banner's own
  // controls rather than against the page it was declared in.
  //
  // Each view's own origin comes from the window's child views, not from a table of
  // page names: a region is registered against the WINDOW, so its page-space
  // geometry means nothing until the view it belongs to is placed.
  const origins = new Map();
  const viewStack = [];
  for (const view of window.contentView.children || []) {
    try {
      if (view.webContents && !view.webContents.isDestroyed()) {
        const bounds = view.getBounds();
        origins.set(view.webContents.id, bounds.y);
        viewStack.push(`${(view.webContents.getURL().split('/').pop() || view.webContents.getURL() || 'blank')}`
          + ` y ${bounds.y}+${bounds.height}`);
      }
    } catch { /* not a web contents view */ }
  }
  // What the window actually stacks, in order, with each view's own rectangle.
  // Recorded because "the page beneath" is only a page if something is there to
  // receive a click, and a stack read off the source is exactly the kind of
  // assumption this harness exists to replace.
  note('the window stacks, back to front', viewStack.join(' | ') || 'no views');

  // One view's CURRENT rectangle, asked for at the moment it matters. The stack
  // note above is a snapshot at the top of the run, and the banner is resized
  // whenever the page reports a new height, which is exactly around the moment a
  // click is measured: reading the rectangle from the note instead of from the
  // app has already put a click point below the banner's own view in one run.
  const viewBoundsFor = (id) => {
    for (const view of window.contentView.children || []) {
      try {
        if (view.webContents && view.webContents.id === id) return view.getBounds();
      } catch { /* not a web contents view */ }
    }
    return null;
  };

  // The band the banner's own controls occupy, in window coordinates:
  // the strip's height down to the banner view, then the controls inside it.
  const overTop = inset + Math.round(targets.close ? Math.min(targets.close.y, targets.action ? targets.action.y : 1e9) : 0);
  const overBottom = inset + Math.round(Math.max(
    targets.close ? targets.close.y + targets.close.h : 0,
    targets.action ? targets.action.y + targets.action.h : 0,
  ));
  note('the banner band', `window y ${inset}..${inset + targets.height}, its controls ${overTop}..${overBottom}`);

  let regionsSeen = 0;
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed() || wc.id === bc.id) continue;
    const found = await ask(wc, `(() => {
        const out = [];
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          if (cs.getPropertyValue('app-region') !== 'drag') continue;
          const b = el.getBoundingClientRect();
          out.push({
            sel: el.tagName.toLowerCase()
              + (el.className && typeof el.className === 'string' && el.className.trim()
                ? '.' + el.className.trim().split(/\\s+/).join('.') : '')
              + (el.id ? '#' + el.id : ''),
            top: Math.round(b.top), bottom: Math.round(b.bottom),
          });
        }
        return out;
      })()`);
    const name = (wc.getURL().split('/').pop() || wc.getURL()).split('?')[0];
    const origin = origins.has(wc.id) ? origins.get(wc.id) : null;
    if (!Array.isArray(found) || !found.length) continue;
    for (const region of found) {
      regionsSeen += 1;
      const top = (origin === null ? inset : origin) + region.top;
      const bottom = (origin === null ? inset : origin) + region.bottom;
      const over = top < overBottom && bottom > overTop;
      note(`drag region on ${name}`, `${region.sel} -> window y ${top}..${bottom}`
        + (origin === null ? ' (view origin unknown, assumed the strip)' : '')
        + (over ? "  OVER THE BANNER'S CONTROLS" : ''));
    }
  }
  if (!regionsSeen) note('drag regions', 'none on any page, so nothing can swallow a click above the page');

  // `dead` aims at a PIXEL rather than at a control, so it has no entry here:
  // its own block below makes the verdict and ends the run.
  const target = { close: targets.close, action: targets.action, readall: targets.readall }[TARGET];
  if (TARGET !== 'dead') {
    check(`the banner has the ${TARGET} control to aim at`, Boolean(target), `the ${TARGET} control is not in the banner`);
    if (!target) { app.exit(1); return; }
  }

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
  // EVERY page underneath is armed rather than the first one that answers, which
  // is what this used to do, and it is not a detail: the loading cover sits over
  // the gateway page at this point, so a run that armed the page BEHIND the cover
  // counted nothing and failed a clicker that was working. Measured 2026-09-17,
  // on the first run of the through-click target: the control reported "the page
  // beneath the banner saw 0 mouse-down(s)" while the banner's own listener was
  // counting the same clicks. The union is the honest reading, and the count from
  // each page says which one is on top.
  const beneathPages = [];
  const census = [];
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed() || wc.id === bc.id) continue;
    const armed = await ask(wc, `(() => {
        if (!document.body) return false;
        window.__clawClickProbe = 0;
        window.__clawBeneathProbe = 0;
        document.addEventListener('mousedown', () => { window.__clawClickProbe += 1; }, true);
        document.addEventListener('mousedown', () => { window.__clawBeneathProbe += 1; }, true);
        return true;
      })()`);
    // The reason a page did not answer, recorded rather than swallowed: an
    // unarmed page is a page whose silence will read as "the click was eaten",
    // which is the one conclusion this harness must never reach by accident.
    // Measured 2026-09-17: on a refused gateway the only page that took a
    // listener was the title strip, so every page a click could actually land on
    // was missing from the count and the verdict was resting on nothing.
    const diagnostics = armed === true ? null : await ask(wc, `(() => JSON.stringify({
        ready: document.readyState,
        body: Boolean(document.body),
        url: location.href,
      }))()`, 1500);
    census.push(`${(wc.getURL().split('/').pop() || wc.getURL()).split('?')[0] || 'unknown'}`
      + `${armed === true ? ' [armed]' : ` [no listener: ${diagnostics || 'did not answer'}]`}`);
    if (armed === true) {
      beneathPages.push({ wc, name: (wc.getURL().split('/').pop() || wc.getURL()).split('?')[0] || 'unknown' });
    }
  }
  note('every page open', census.join(' | ') || 'none');
  note('pages armed under the banner', beneathPages.map((p) => p.name).join(', ') || 'none answered');

  if (beneathPages.length) {
    const probePoint = { x: contentBounds.x + 700, y: contentBounds.y + inset + 400 };
    const control = await clickAt(probePoint.x, probePoint.y);
    await delay(700);
    const seenBy = [];
    for (const page of beneathPages) {
      const count = await ask(page.wc, 'window.__clawClickProbe', 2000);
      if (typeof count === 'number' && count > 0) seenBy.push(`${page.name}: ${count}`);
    }
    check('the clicker reaches the app at all (control click over the page)', seenBy.length > 0,
      `no page under the banner saw the click at ${Math.round(probePoint.x)},${Math.round(probePoint.y)}; `
      + `clicker said ${control.error || control.out}`);
    note('the control click was seen by', seenBy.join(', ') || 'nothing');
  } else {
    note('control click', 'skipped: no page underneath answered');
  }

  // ★ The other direction of the same claim, and the one that was reported three
  // times in this area: a click on a pixel the reader can see THROUGH must belong
  // to the page they can see, not to the overlay's transparent furniture.
  //
  // The readings are deliberately kept apart, because they have different causes
  // and only one of them is a stylesheet's:
  //
  //   the banner page saw it, the page beneath did not  -> an element of banner.css
  //     is hit-testable where the pixel is transparent;
  //   neither page saw it                                -> the click never left the
  //     banner's view, so the fault is the view's bounds in main.js;
  //   the page beneath saw it                            -> the pixel is live.
  //
  // Every page underneath is armed rather than one, and each reports on its own:
  // with the loading cover over the gateway page, which of the two is on top at
  // this point is the app's business and not something to guess at here.
  const beneath = beneathPages;

  let through = null;
  if (!targets.dead) {
    note('the through-click', 'skipped: the banner draws no stack to measure');
  } else if (targets.dead.overACard) {
    note('the through-click', 'skipped: the only free point on the sweep row landed on a card');
  } else {
    const bannerBefore = await ask(bc, 'window.__clawBannerClicks', 2000);
    const hitsBefore = await ask(bc, '(window.__clawBannerHits || []).length', 2000);
    for (const page of beneath) await ask(page.wc, 'window.__clawBeneathProbe = 0', 2000);
    const point = {
      x: contentBounds.x + targets.dead.cx,
      y: contentBounds.y + inset + targets.dead.cy,
    };
    console.log(`note aiming at: the transparent area under the banner, page ${Math.round(targets.dead.cx)},`
      + `${Math.round(targets.dead.cy)} = screen ${Math.round(point.x)},${Math.round(point.y)}`);
    // Is the point inside the banner's own rectangle at this moment? A point that
    // is outside it is aimed at the page beneath by construction, and a reading
    // taken there says nothing about the overlay.
    const bounds = viewBoundsFor(bc.id);
    if (bounds) {
      const inside = targets.dead.cy >= bounds.y - inset
        && targets.dead.cy <= bounds.y - inset + bounds.height;
      note('the banner view at the moment of the click', `page y ${bounds.y - inset}..`
        + `${bounds.y - inset + bounds.height} (height ${bounds.height}); the point is `
        + `${inside ? 'inside it' : 'OUTSIDE IT, so this run measures the page beneath instead'}`);
    } else {
      note('the banner view at the moment of the click', 'its view was not found in the window');
    }
    await shot('before-through-click');
    const delivered = await clickAt(point.x, point.y);
    await delay(1200);
    await shot('after-through-click');
    const bannerAfter = await ask(bc, 'window.__clawBannerClicks', 2000);
    const bannerSaw = typeof bannerBefore === 'number' && typeof bannerAfter === 'number'
      ? bannerAfter - bannerBefore
      : null;
    // WHICH element of the banner's document received it, and where. On the root
    // element at a point where nothing is drawn, the click has been dispatched
    // into this document with no element under it: that is a container still
    // taking hit tests, and it is not the same reading as the click being
    // ignored. Named rather than counted, because the two have different fixes.
    const hits = typeof hitsBefore === 'number'
      ? await ask(bc, `JSON.stringify((window.__clawBannerHits || []).slice(${hitsBefore}))`, 2000)
      : null;
    note('what the banner page received', hits || 'nothing readable');
    const saw = [];
    for (const page of beneath) {
      const count = await ask(page.wc, 'window.__clawBeneathProbe', 2000);
      if (typeof count === 'number' && count > 0) saw.push(`${page.name}: ${count}`);
    }
    through = { bannerSaw, saw };
    console.log(`note the through-click: the clicker ${delivered.error ? `did NOT deliver (${delivered.error})` : 'delivered'}`
      + `; the banner page saw ${bannerSaw === null ? 'nothing readable' : bannerSaw} mouse-down(s)`
      + `; the page beneath saw ${saw.join(', ') || 'nothing'}`);
  }

  if (TARGET === 'dead') {
    if (!through) {
      check('a click in the transparent area could be aimed at all', false,
        'no point on the banner was measurable, so nothing was proved either way');
    } else if (EXPECT === 'dead') {
      check('the click in the transparent area is swallowed (the fault, reproduced)', !through.saw.length,
        `the page beneath saw it (${through.saw.join(', ')}), so this pixel was already live`);
    } else {
      check('a click in the transparent area reaches the page beneath it', through.saw.length > 0,
        'nothing under the banner saw the click: '
        + (through.bannerSaw ? 'the banner page captured it, so something in banner.css is still '
          + 'hit-testable where the pixel is transparent' : 'the click never left the banner\'s view, so the '
          + 'fault is the view bounds in main.js and no stylesheet can fix it'));
    }
    console.log(failed ? 'FAILED' : 'ALL OK');
    app.exit(failed ? 1 : 0);
    return;
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
  } else if (TARGET === 'readall') {
    // The sweep's outcome is the bar coming down: it marks every notice read
    // without clearing a condition, so the view it lived in goes away and the
    // Conditions it recorded are still in the app's own log.
    check('the click reached Mark all read and swept the bar away', gone,
      `the banner is still up with ${cardsAfter} card(s) and the banner page saw ${bannerSaw} mouse-down(s)`);
  } else {
    check('the click reached the action button and something followed from it', changed,
      'nothing changed, so the click was swallowed');
  }

  console.log(failed ? 'FAILED' : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
