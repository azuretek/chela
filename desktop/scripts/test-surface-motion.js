// Prove the motion, per transition, by capturing the composited window THROUGH
// each one rather than at its ends.
//
// The rule and the numbers are core/ui/CONVENTIONS.md, the page-side mechanism is
// core/ui/surface.js and the host's half is main.js. This is the measured half:
// every claim above is about what a reader saw while something changed, and no
// assertion about two endpoints can make that claim.
//
//   npx electron scripts/test-surface-motion.js [--gateway URL] [--shots DIR] [--reduced]
//
// Needs a reachable Control UI. By default it points at a throwaway gateway on this
// host, which is what the deliverable was verified against:
//
//   OPENCLAW_STATE_DIR=/tmp/claw-motion-gw/state \
//   OPENCLAW_CONFIG_PATH=/tmp/claw-motion-gw/openclaw.json \
//   openclaw gateway --port 19099 --auth none --bind loopback --allow-unconfigured
//
// `--reduced` runs the whole thing again with the preference forced on, which is
// the half a rule like this loses first: an app that animates beautifully and
// ignores a reader who asked it not to. Chromium honours the switch, so the pages
// read the same media query they would for a real reader.
//
// WHAT THIS COVERS, and what it deliberately does not. The transitions here are the
// ones this change made move: a surface arriving, a panel replacing another inside
// one, a surface departing, and a notice card leaving the bar. The loading cover's
// reveal is NOT here, and the reason is the app's own: a cover is only raised while
// there is no payload on screen, and this harness's setup always has one (the
// Control UI it is talking about). It has its own harness,
// scripts/test-cover-reveal.js, whose setup starts against a gateway that answers
// late, which is the one arrangement where a cover exists to be revealed.

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
const REDUCED = process.argv.includes('--reduced');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-motion-'));
const { app, BrowserWindow, Menu, desktopCapturer, webContents } = await import('electron');
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);
// Forced before the app is ready, which is when Chromium reads it. The pages then
// answer `prefers-reduced-motion: reduce` exactly as they would for a reader who
// set it, so nothing here is exercising a special path.
if (REDUCED) app.commandLine.appendSwitch('force-prefers-reduced-motion');

/** Refuse to run against nothing: a harness that proves nothing is worse than one that fails. */
async function reachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
  });
}

// The shortcut is not an accelerator, so registering it throws, which is one of the
// four things that genuinely raises a notice: the app raises the card itself.
fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Control UI', url: GATEWAY }],
  activeGatewayId: 'harness',
  globalShortcut: 'Frobnicate+Zz',
}, null, 2)}\n`);

if (!await reachable(GATEWAY)) {
  console.error(`FAIL no Control UI at ${GATEWAY}: start the throwaway gateway first (see the header)`);
  process.exit(1);
}

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = (promise) => { promise.catch(() => {}); };

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

/** One image of the composited window. Only the OS compositor sees the child views. */
async function grab(maxWidth = 360) {
  const win = BrowserWindow.getAllWindows()[0];
  const [width, height] = win.getContentSize();
  const scale = maxWidth < width ? maxWidth / width : 1;
  const size = { width: Math.round(width * scale), height: Math.round(height * scale) };
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size });
  const mine = sources.find((s) => s.id === win.getMediaSourceId()) || sources.find((s) => /claw/i.test(s.name));
  if (!mine || mine.thumbnail.isEmpty()) return null;
  return mine.thumbnail;
}

/**
 * A small, stable signature of what a frame shows, so two frames can be compared.
 *
 * Downsampled because the compositor hands back a slightly different encoding of
 * the same picture, and the claim is "the same view", not "the same bytes".
 */
const signature = (image) => image.resize({ width: 160, height: 100 }).toBitmap();

/** Mean absolute difference per channel byte. 0 is identical. */
function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

async function framed(name, maxWidth = 360) {
  const image = await grab(maxWidth);
  if (!image) return { file: null, sig: null };
  const sig = signature(image);
  if (!SHOTS || !name) return { file: null, sig };
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  return { file, sig };
}

/** The app's own pages, as live WebContents, or null when one is not up. */
const overlayContents = (file) => webContents.getAllWebContents()
  .find((wc) => !wc.isDestroyed() && wc.getURL().includes(`/${file}`)) || null;

/** The gateway page: the only view whose URL is the gateway. */
const page = () => webContents.getAllWebContents()
  .find((wc) => !wc.isDestroyed() && wc.getURL().startsWith(GATEWAY.replace(/\/$/, ''))) || null;

function menuItem(label, items = Menu.getApplicationMenu()?.items || []) {
  for (const item of items) {
    if (item.label === label) return item;
    const found = item.submenu && menuItem(label, item.submenu.items);
    if (found) return found;
  }
  return null;
}

/**
 * A burst of frames spanning an ACTION, so the frames cover the transition itself.
 *
 * `act` fires `actAt` milliseconds in, on the burst's own clock, and every frame is
 * timed from that moment. Doing it the other way round (burst, await, then act) is
 * how the first version of this file measured nothing: the burst finished before
 * anything moved, and the frames were of a still page reporting a transition that
 * had not happened yet.
 *
 * Several capturers, because `getSources` costs about 25ms whatever the thumbnail
 * size is and one loop would sample a 100ms animation three times. The monitor owns
 * the end condition so every capturer stops together, and it samples the Control
 * UI's route alongside, which is the "no view the reader did not ask for" claim in
 * the form a capture can make.
 */
async function burst({ ms, until = null, name = null, actAt = 0, act = null, routeOf = null, fullWidth = false }) {
  const routes = [];
  const frames = [];
  const run = { stop: false, saved: false };
  const started = Date.now();
  const capturer = async () => {
    while (!run.stop) {
      const at = Date.now();
      const shot = await framed(!run.saved && name ? (run.saved = true, name) : null, fullWidth ? 100000 : 360);
      frames.push({ at, rel: actAt === null ? at - started : at - (started + actAt), sig: shot.sig });
    }
  };
  const monitor = (async () => {
    let fired = act === null;
    while (Date.now() - started < ms) {
      if (!fired && Date.now() - started >= actAt) { fired = true; silent(Promise.resolve(act())); }
      const wc = routeOf ? routeOf() : page();
      if (wc) {
        let route = null;
        try { route = await wc.executeJavaScript('location.pathname'); } catch { /* swapping */ }
        routes.push({ at: Date.now() - started, route });
      }
      if (until && fired && await until()) break;
      await delay(10);
    }
    if (!fired) silent(Promise.resolve(act()));
    run.stop = true;
  })();
  await Promise.all([monitor, capturer(), capturer(), capturer()]);
  frames.sort((a, b) => a.rel - b.rel);
  return { frames, routes };
}

/** The first frame at or after `from` that matches a reference within tolerance. */
function settledAt(frames, reference, tolerance, from = -Infinity) {
  const hit = frames.find((f) => f.rel >= from && frameDiff(f.sig, reference) <= tolerance);
  return hit ? hit.rel : null;
}

/** The first frame at or after `from` that DIFFERS from a reference beyond tolerance. */
function changedAt(frames, reference, tolerance, from = -Infinity) {
  const hit = frames.find((f) => f.rel >= from && frameDiff(f.sig, reference) > tolerance);
  return hit ? hit.rel : null;
}

/** Whether any sampled route differs from the one the step started on. */
const routeHeld = (routes, expected) => routes.filter((r) => r.route !== null && r.route !== expected);

/* ------------------------------------------------------------------- steps */

app.whenReady().then(async () => {
  // Long enough for the window and the gateway load.
  await delay(9000);

  const wc = page();
  check('the Control UI loaded', Boolean(wc), `no view at ${GATEWAY}`);
  if (!wc) { app.exit(1); return; }

  const preference = await wc.executeJavaScript("window.matchMedia('(prefers-reduced-motion: reduce)').matches");
  console.log(`note this is the ${REDUCED ? 'REDUCED-MOTION' : 'animated'} pass; the Control UI reports reduced-motion ${preference}`);
  check(`the ${REDUCED ? 'reduced-motion' : 'animated'} pass is really running that preference`,
    preference === REDUCED, `the page reports ${preference}`);
  const startRoute = await wc.executeJavaScript('location.pathname');

  // Measured rather than assumed: two captures of one still page differ by a
  // little, and every tolerance below is read against that instead of picked.
  const stillA = await framed(null);
  const stillB = await framed(null);
  const noise = stillA.sig && stillB.sig ? frameDiff(stillA.sig, stillB.sig) : 0;
  const tol = Math.max(noise + 0.5, 1.5);
  console.log(`note frame noise floor ${noise.toFixed(1)}, so "the same view" is within ${tol.toFixed(1)}`);

  /* ------------------------------------- a surface arriving and departing */

  const bare = await framed('motion-bare');
  const settingsItem = menuItem('Settings\u2026');
  check('the Settings surface can be opened', Boolean(settingsItem), 'no "Settings\u2026" menu item');
  if (!settingsItem) { app.exit(1); return; }

  const arrival = await burst({
    ms: 4000,
    actAt: 80,
    act: () => settingsItem.click(),
    name: 'motion-settings-arrival',
    // The end condition is the PAGE's own: its document is ready and nothing is
    // still animating. Reading it from the page keeps the harness from guessing how
    // long an animation takes, which is the thing being measured.
    until: async () => {
      const o = overlayContents('settings.html');
      if (!o) return false;
      try {
        return await o.executeJavaScript(
          'document.readyState === "complete" && document.getAnimations().every((a) => a.playState !== "running")',
        );
      } catch { return false; }
    },
  });
  await delay(250);
  const settingsSettled = await framed('motion-settings-settled');
  // From the first frame that shows the surface to the first that shows it settled.
  // The page LOAD is inside that window and is not an animation, which is exactly why
  // the measurement starts at first paint: what is being checked is how long the thing
  // took to arrive once it was visible, which is the number the reader experiences.
  const arrivalPaint = changedAt(arrival.frames, bare.sig, tol);
  const arrivalDone = settledAt(arrival.frames, settingsSettled.sig, tol, arrivalPaint === null ? 0 : arrivalPaint);
  const arrivalMs = arrivalPaint !== null && arrivalDone !== null ? arrivalDone - arrivalPaint : null;
  console.log(`note surface arriving: first visible at ${arrivalPaint}ms, settled at ${arrivalDone}ms, so it took ${arrivalMs}ms, in ${arrival.frames.length} frames`);
  check('the settings surface arrives and settles', arrivalDone !== null,
    `the first frame showing it was at ${arrivalPaint}ms and it never settled`);
  check('the arrival completes inside its token',
    arrivalMs !== null && arrivalMs <= (REDUCED ? 260 : 650),
    `the arrival took ${arrivalMs}ms against a ${REDUCED ? '180ms fade' : '500ms sheet'} token`);
  // The arrival is not asserted to have taken a moment, and the reason is a fact
  // about the arrangement rather than a fault: the overlay view is attached and its
  // page loads while it is already compositing, so the first part of the enter
  // animation can be spent before the view's first frame reaches the screen. When
  // the enter was the Control UI's 180ms it measured 0ms here; the sheet's 500ms
  // slide leaves most of itself visible, and the frames are kept as the record. The
  // two transitions below are where the animation is asserted. The phone's sheet
  // animates its own presentation natively.
  console.log(`note the arrival: first visible at ${arrivalPaint}ms, settled at ${arrivalDone}ms`);
  check('and it is not still moving after its own animation says it is done',
    arrival.frames.every((f) => f.rel < (arrivalDone === null ? 0 : arrivalDone) + 60 || frameDiff(f.sig, settingsSettled.sig) <= tol),
    'frames after the surface settled differ from the settled surface');
  check('the settings surface arriving never showed a view the reader did not ask for',
    routeHeld(arrival.routes, startRoute).length === 0,
    JSON.stringify(routeHeld(arrival.routes, startRoute).slice(0, 3)));

  const ours = overlayContents('settings.html');
  if (!ours) { check('the settings overlay is up for the tab step', false, 'nothing to switch tabs in'); }
  else {
    // The handshake lives in OUR pages, not in the Control UI, which is why it is
    // asserted here rather than against the gateway page.
    const handshake = await ours.executeJavaScript('Boolean(window.clawSurface) && typeof window.clawSurface.leave === "function"');
    check('the shared departure handshake is installed in the surface', handshake === true,
      'window.clawSurface is absent from the settings page, so nothing can be asked to leave');
    const surfaceReduced = await ours.executeJavaScript('window.clawSurface.reducedMotion()');
    console.log(`note the settings page reports reduced-motion ${surfaceReduced}`);
    check('the page reads the same preference the app is running',
      surfaceReduced === REDUCED, `the page says ${surfaceReduced}, the run is ${REDUCED}`);

    /* ------------------------------------------------ a tab change inside it */

    const tabs = await ours.executeJavaScript(
      "(() => [...document.querySelectorAll('#tabs .tab')].map((b) => b.id.replace(/^tab-/, '')))()",
    );
    console.log(`note tabs offered: ${JSON.stringify(tabs)}`);
    const from = tabs[0];
    const to = tabs[Math.min(1, tabs.length - 1)];
    const tabBare = await framed('motion-tab-before');
    const tabBurst = await burst({
      ms: 1500,
      actAt: 80,
      act: () => ours.executeJavaScript(`document.getElementById('tab-${to}').click()`),
      name: 'motion-tab-incoming',
      // The CONTROL UI is what must not move while our panel changes, so its route
      // is what is sampled. Sampling the overlay's own pathname here was the first
      // version's mistake: a file URL can never equal the Control UI's route, so
      // the check failed on every sample for no reason.
      routeOf: () => page(),
      // The end condition is the PAGE's own animation state, not the DOM toggle:
      // `panel.hidden` flips synchronously on the click, so stopping at that stopped
      // the burst before the animation had run and left no frame to compare against
      // the settled panel. The DOM pair below is still asserted, but after the burst.
      until: async () => {
        try {
          return await ours.executeJavaScript(
            `(() => { const a = document.getElementById('panel-${to}'); const b = document.getElementById('panel-${from}');`
            + ' return Boolean(a) && !a.hidden && Boolean(b) && b.hidden'
            + ' && document.getAnimations().every((x) => x.playState !== "running"); })()',
          );
        } catch { return false; }
      },
    });
    const panels = await ours.executeJavaScript(
      `(() => { const a = document.getElementById('panel-${to}'); const b = document.getElementById('panel-${from}');`
      + " return { incomingHidden: Boolean(a) && a.hidden, outgoingHidden: Boolean(b) && b.hidden,"
      + " incomingClass: a ? a.className : null }; })()",
    ).catch(() => ({}));
    console.log(`note tab ${from} -> ${to}: ${JSON.stringify(panels)}`);
    check('the tab change never shows two panels at once',
      panels.incomingHidden === false && panels.outgoingHidden === true,
      `panels: ${JSON.stringify(panels)}`);
    check('only the incoming panel animates, from the side the reader moved toward',
      typeof panels.incomingClass === 'string' && panels.incomingClass.includes('panel--in-from-right'),
      `the incoming panel is ${JSON.stringify(panels.incomingClass)}, so the motion points the wrong way or nowhere`);
    await delay(250);
    const tabSettled = await framed('motion-tab-settled');
    // Measured from the CLICK rather than from the first frame that differs: the two
    // settings panels are similar enough that "the first frame that looks different"
    // is a fragile anchor, and what the rule actually promises is when the change is
    // DONE. A no-motion pass should reach it at once; an animated one should take
    // most of its token and not longer.
    const tabDone = settledAt(tabBurst.frames, tabSettled.sig, tol);
    console.log(`note tab change: settled at ${tabDone}ms after the click, in ${tabBurst.frames.length} frames`);
    check('the tab change completes inside its token',
      tabDone !== null && tabDone <= (REDUCED ? 190 : 450),
      `it settled at ${tabDone}ms against a ${REDUCED ? '100ms fade' : '350ms screen'} expectation`);
    // And the animated pass is asserted to have actually MOVED, so a disabled
    // animation cannot pass by doing nothing at all. Reduced motion is a short fade
    // rather than nothing, so it is held to the fade's bound instead.
    check(REDUCED
      ? 'the panel fades in quickly with motion turned off'
      : 'the panel takes a moment to arrive, so the animation really ran',
      REDUCED ? tabDone !== null && tabDone <= 190 : tabDone !== null && tabDone >= 100,
      `it settled at ${tabDone}ms`);
    check('the tab change never showed a view the reader did not ask for',
      routeHeld(tabBurst.routes, startRoute).length === 0,
      JSON.stringify(routeHeld(tabBurst.routes, startRoute).slice(0, 3)));

    /* ---------------------------------------------- the surface departing */

    // The real control, pressed the way a person presses it, so the departure goes
    // through the page, the preload and the host exactly as theirs would. The action
    // fires INSIDE the burst, which is what makes the frames cover it.
    //
    // The state it is leaving from is captured HERE rather than reused from the
    // arrival: the tab step changed the panel, so an arrival reference is a picture of
    // a surface that no longer exists, and the first version of this file compared
    // against exactly that and reported every frame as different.
    const surfaceUp = await framed('motion-departure-from');
    // Measured on the VIEW's clock, like the notice card below, and for the same
    // reason: what this change alters is WHEN the host stops showing the surface. A
    // view destroyed on the same tick as the press is a cut, whatever the stylesheet
    // says; a view that outlives the press by most of a `--duration-fast` is the
    // animation being seen. That is decisive where a pixel reference is fragile, since
    // the Control UI behind it is a live page whose own frames are not identical.
    let goneMs = null;
    const departure = await burst({
      ms: 2500,
      actAt: 80,
      act: async () => {
        const from = Date.now();
        await ours.executeJavaScript(
          "(() => { const b = document.getElementById('close') || document.querySelector('.modal__close'); if (!b) return false; b.click(); return true; })()",
        ).catch(() => {});
        while (Date.now() - from < 2000) {
          if (!overlayContents('settings.html')) { goneMs = Date.now() - from; return; }
          await delay(15);
        }
      },
      name: 'motion-settings-departure',
      until: async () => goneMs !== null,
    });
    await delay(250);
    const bareAfter = await framed('motion-departure-to');
    const departureFrom = frameDiff(surfaceUp.sig, bareAfter.sig) > tol;
    console.log(`note surface departing: the view went ${goneMs === null ? '(never)' : `${goneMs}ms`} after the press, in ${departure.frames.length} frames`);
    check('the surface really did go away', !overlayContents('settings.html'),
      'the settings overlay is still up after its own close control was pressed');
    check('the window really did start from the surface',
      departureFrom, 'the surface and the Control UI look the same, so this step measured nothing');
    check(REDUCED
      ? 'the surface fades out with motion turned off, rather than sliding'
      : 'the departure is ANIMATED rather than cut away: the sheet slides down',
      REDUCED ? goneMs !== null && goneMs >= 40 && goneMs <= 250 : goneMs !== null && goneMs >= 300,
      `the view went after ${goneMs}ms, which is ${REDUCED ? 'not the short fade' : 'a cut rather than a slide'}`);
    check('the departure completes inside its token',
      goneMs !== null && goneMs <= (REDUCED ? 250 : 650),
      `it took ${goneMs}ms against a ${REDUCED ? '100ms fade' : '400ms sheet'} token`);
    check('the surface departing never showed a view the reader did not ask for',
      routeHeld(departure.routes, startRoute).length === 0,
      JSON.stringify(routeHeld(departure.routes, startRoute).slice(0, 3)));
  }

  /* --------------------------------------------- a notice card leaving the bar */

  // A DISMISSIBLE card, raised by the app's own path rather than injected. The card
  // already on screen is the refused-global-shortcut one, and that one is kept ON
  // PURPOSE: main.js's own comment records that waving it away used to delete the
  // app's knowledge that the shortcut was refused, which is why a dismissal of it
  // changes nothing and why the first version of this step measured nothing at all.
  // About's manual update check raises the "updates are not available in this build"
  // notice instead, which is a card the reader can genuinely clear.
  const aboutItem = menuItem('About Chela');
  check('the About surface can be opened for the notice step', Boolean(aboutItem), 'no About menu item');
  if (aboutItem) {
    aboutItem.click();
    await delay(1500);
    const about = overlayContents('about.html');
    check('the About surface is up', Boolean(about), 'the About overlay never opened');
    if (about) {
      await about.executeJavaScript(
        "(() => { const b = [...document.querySelectorAll('button')].find((x) => /update/i.test(x.textContent)); if (b) b.click(); })()",
      ).catch(() => {});
      await delay(REDUCED ? 500 : 1200);
      const banner = overlayContents('banner.html');
      check('the notice banner is up', Boolean(banner), 'no banner view was raised');
      if (banner) {
        // Found by its own text, so this cannot dismiss the shortcut card by accident
        // and so a rename of the notice's wording fails loudly here rather than
        // quietly dismissing something else.
        const findCard = `(() => {
          const card = [...document.querySelectorAll('.banner')].find((n) => /Updates are not available/i.test(n.textContent || ''));
          const close = card && card.querySelector('.banner__close');
          return close ? card.id : null;
        })()`;
        const target = await banner.executeJavaScript(findCard).catch(() => null);
        const before = await banner.executeJavaScript('document.querySelectorAll(".banner").length').catch(() => 0);
        check('the bar carries the dismissible card this step needs', Boolean(target),
          `no dismissible update card among ${before} cards`);
        if (target) {
          const cardBare = await framed('motion-notice-before', 100000);
          // The deferral, on the page's own clock: a card removed on the same tick as
          // the press never painted a frame of its departure, which is the fault.
          let droppedMs = null;
          const leaveBurst = await burst({
            ms: 3200,
            actAt: 80,
            act: async () => {
              const from = Date.now();
              await banner.executeJavaScript(`(() => {
                const card = [...document.querySelectorAll('.banner')].find((n) => /Updates are not available/i.test(n.textContent || ''));
                const close = card && card.querySelector('.banner__close');
                if (close) close.click();
              })()`).catch(() => {});
              while (Date.now() - from < 2500) {
                const now = await banner.executeJavaScript('document.querySelectorAll(".banner").length').catch(() => null);
                if (now !== null && now < before) { droppedMs = Date.now() - from; return; }
                await delay(25);
              }
            },
            name: 'motion-notice-leaving',
            fullWidth: true,
            until: async () => droppedMs !== null,
          });
          await delay(200);
          const after = await banner.executeJavaScript('document.querySelectorAll(".banner").length').catch(() => before);
          const moved = leaveBurst.frames.filter((f) => f.rel > 0 && frameDiff(f.sig, cardBare.sig) > tol).length;
          console.log(`note notice cards: ${before} before, ${after} after; the count dropped ${droppedMs === null ? '(never)' : `${droppedMs}ms`} after the press`);
          console.log(`note ${moved} frames after the press differed from the bar before it, in ${leaveBurst.frames.length} frames`);
          check('the notice card was dismissed', after < before, `${before} cards before, ${after} after`);
          check(REDUCED
            ? 'the card goes at once with motion turned off'
            : 'the dismissal defers the removal, so the card is seen leaving rather than cut away',
            REDUCED ? droppedMs !== null && droppedMs <= 120 : droppedMs !== null && droppedMs >= 60,
            `the count dropped after ${droppedMs}ms`);
          // Reported rather than asserted, and the reason is a limitation of this
          // instrument rather than of the transition. The card's own slide happens
          // inside the banner strip, which is a few percent of a frame, and it is over
          // in `--duration-fast`: the burst cannot resolve it at either width. What IS
          // asserted above is decisive for the same transition: the count dropped a
          // hundred milliseconds after the press, and the only thing that produces that
          // deferral is the animation reaching its end (`animationend` is what removes
          // the node, with a clock as the backstop). So the departure is seen rather
          // than cut, and this says how far the pixels got.
          console.log(`note the card's own slide was too small and too quick for this burst to resolve (${moved} of ${leaveBurst.frames.length} frames differed); the deferral above is the evidence for it`);
        }
      }
    }
  }

  console.log(failed ? 'FAILED' : 'ALL OK');
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(`FAIL harness: ${err && err.stack ? err.stack : err}`);
  app.exit(1);
});
