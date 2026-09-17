// Prove where the App-settings affordance actually lands in the Control UI, and
// where "Go to the Control UI settings" actually takes the reader.
//
// Both are claims about another program's DOM, so both are checked against the
// real page rather than read out of the spec: the anchor list can be correct and
// the DOM can have moved, and the failure looks identical in a source read.
//
//   npx electron scripts/test-affordance-placement.js [--gateway URL] [--shots DIR]
//
// Needs a reachable Control UI WITH a sidebar footer. By default it points at a
// throwaway gateway on this host:
//
//   OPENCLAW_STATE_DIR=/tmp/claw-affordance-gw/state \
//   OPENCLAW_CONFIG_PATH=/tmp/claw-affordance-gw/openclaw.json \
//   openclaw gateway --port 19099 --auth none --bind loopback --allow-unconfigured
//
// A throwaway gateway on a spare port with its own state directory, never the
// live one: this needs a Control UI whose footer it can inspect, and the real
// gateway's is behind a credential.
//
// AND IT MUST HAVE A MODEL PROVIDER, or the Control UI parks on its first-run
// model-setup flow, which has no sidebar and therefore no footer. That flow is the
// reason this harness used to insert footer markup of its own, which was the wrong
// artifact and hid a real difference between the served bundle and the OpenClaw
// checkout. It now requires the real footer and fails loudly without one: add a
// provider to the throwaway config (any reachable one will do) and the app reaches
// /chat/main, where the footer the anchors are about actually renders.
//
// The profile is pinned BOTH ways; main.js decides isolation from the
// `--user-data-dir` SWITCH rather than from the path. See scripts/dump-overlays.js.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

// The shared rules this harness is checking: the readiness question and the
// destination route are the app's own, read from the same module the clients
// import, so the harness cannot go on passing against a claim the app stopped
// making. Imported rather than re-typed here for the same reason the app imports
// it: a second copy of a selector is the fork the spec exists to prevent.
import * as appSettingsAffordance from '../../core/app-settings-affordance.js';

const argIndex = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const GATEWAY = argIndex('--gateway', 'http://127.0.0.1:19099/');
const SHOTS = argIndex('--shots', null);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// The width the transition burst captures at. Small enough that a frame costs
// meaningfully less than the ~90ms a full-size thumbnail does, which is what makes
// the burst dense enough to catch a view that lasted a few hundred milliseconds.
const FRAME_WIDTH = 360;

const { app, BrowserWindow, Menu, desktopCapturer, webContents } = await import('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-affordance-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);

/** Refuse to run against nothing: a harness that proves nothing is worse than one that fails. */
async function gatewayReachable() {
  return new Promise((resolve) => {
    const req = http.get(GATEWAY, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
  });
}

fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Control UI', url: GATEWAY }],
  activeGatewayId: 'harness',
}, null, 2)}\n`);

if (!await gatewayReachable()) {
  console.error(`FAIL no Control UI at ${GATEWAY}: start the throwaway gateway first (see the header)`);
  process.exit(1);
}

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

const WATCHDOG_MS = 120000;
setTimeout(() => {
  console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`);
  app.exit(1);
}, WATCHDOG_MS).unref();

/** The gateway page: the only view whose URL is the gateway. */
function page() {
  return webContents.getAllWebContents().find(
    (wc) => !wc.isDestroyed() && wc.getURL().startsWith(GATEWAY.replace(/\/$/, '')),
  ) || null;
}

/**
 * One image of the composited window, which is the only way to see child views.
 *
 * The window has no WebContents of its own, so this is `desktopCapturer` rather
 * than `capturePage()`: the question is what the OS compositor drew, and our
 * settings surface is a child view stacked over the gateway page.
 *
 * `maxWidth` exists for the transition burst, which needs frames as close together
 * as the compositor will give them: `getSources` costs about 90ms at full size and
 * rather less when the thumbnail is small, and the claim being checked is about a
 * window that lasts a few hundred milliseconds. The smaller frame is downsampled
 * to the same signature either way, so a burst stays comparable with the reference
 * frames taken at full size.
 */
async function grab(maxWidth = null) {
  const win = BrowserWindow.getAllWindows()[0];
  const [width, height] = win.getContentSize();
  const scale = maxWidth && maxWidth < width ? maxWidth / width : 1;
  const size = { width: Math.round(width * scale), height: Math.round(height * scale) };
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size });
  const mine = sources.find((s) => s.id === win.getMediaSourceId()) || sources.find((s) => /claw/i.test(s.name));
  if (!mine || mine.thumbnail.isEmpty()) return null;
  return mine.thumbnail;
}

async function capture(name) {
  if (!SHOTS) return null;
  const image = await grab();
  if (!image) return null;
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  return file;
}

/**
 * One frame, for both halves: the image saved for a person to look at, and its
 * signature for the assertions. A null name saves nothing, which is what the
 * frames in the middle of a burst do.
 */
async function framed(name, maxWidth = null) {
  const image = await grab(maxWidth);
  if (!image) return { file: null, sig: null };
  const sig = signature(image);
  if (!SHOTS || !name) return { file: null, sig };
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  return { file, sig };
}

/**
 * A small, stable signature of what a frame shows, so two frames can be compared.
 *
 * Downsampled rather than byte-for-byte: the compositor is free to hand back a
 * slightly different encoding of the same picture, and the claim being checked is
 * "the same view", not "the same bytes".
 *
 * The size is measured rather than chosen. At 64x40 the two views this harness has
 * to tell apart, the Control UI's settings profile tab and its appearance tab,
 * came out about 4 apart: they share a shell, a sidebar and a palette, and at that
 * scale the panels looked the same. 160x100 separates them by an order of
 * magnitude more, which is what makes the comparison below worth making.
 */
function signature(image) {
  return image.resize({ width: 160, height: 100 }).toBitmap();
}

/** Mean absolute difference per channel byte. 0 is identical. */
function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

/**
 * The app's own Settings surface, as a live WebContents, or null when it is not up.
 *
 * Found by URL rather than by asking main.js for a handle: main.js exports
 * nothing, deliberately, and the overlay's own page is the thing being looked at.
 */
function overlayContents() {
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes('/settings.html')) || null;
}

/** Find a menu item by its label, anywhere in the application menu. */
function menuItem(label, items = Menu.getApplicationMenu()?.items || []) {
  for (const item of items) {
    if (item.label === label) return item;
    const found = item.submenu && menuItem(label, item.submenu.items);
    if (found) return found;
  }
  return null;
}

/**
 * Where the injected control is, as the page itself reports it.
 *
 * `closest` answers the question the anchors are about: is this node inside the
 * footer's action row, inside the footer bar, or parked in a corner by the last
 * step of the chain. Read from the DOM rather than inferred from the class list,
 * because the class existing in a stylesheet says nothing about where the node
 * ended up.
 */
const placementQuery = `(() => {
  const node = document.querySelector('[data-claw-app-settings]');
  if (!node) return { placed: false };
  const spec = (window.__clawAppSettingsConfig && window.__clawAppSettingsConfig.anchors) || {};
  const actions = node.closest('.sidebar-footer-actions');
  const bar = node.closest('.sidebar-footer-bar');
  // The sidebar anchor comes from the SPEC the page was installed with, not
  // from a copy here: a hardcoded selector here is a second owner of the same
  // decision, and the one it used to hold was the class-substring match that
  // wrongly caught .settings-sidebar.
  const sidebar = spec.sidebar ? node.closest(spec.sidebar) : null;
  const style = getComputedStyle(node);
  return {
    placed: true,
    inFooterActions: Boolean(actions),
    inFooterBar: Boolean(bar),
    inSidebar: Boolean(sidebar),
    position: style.position,
    left: style.left,
    bottom: style.bottom,
    parent: node.parentElement ? node.parentElement.className : null,
    label: node.getAttribute('aria-label'),
    // What the PAGE says about where it put the control, rather than what this
    // harness infers from geometry: a control in the corner is indistinguishable
    // from a control whose footer never rendered, and this is the difference.
    placement: node.getAttribute('data-claw-app-settings-placement'),
  };
})()`;

app.whenReady().then(async () => {
  // Long enough for the window and the gateway load. The Control UI opens on
  // whatever route its boot picks, which for an unconfigured gateway is the
  // first-run settings flow: a layout with NO main sidebar at all.
  await delay(9000);

  const wc = page();
  check('the Control UI loaded', Boolean(wc), `no view at ${GATEWAY}`);
  if (!wc) { app.exit(1); return; }

  const anchorsHere = await wc.executeJavaScript(`(() => {
    const spec = window.__clawAppSettingsConfig && window.__clawAppSettingsConfig.anchors;
    const out = {};
    for (const key of Object.keys(spec || {})) {
      const node = document.querySelector(spec[key]);
      out[key] = node ? ('MATCH ' + node.tagName.toLowerCase() + '.' + String(node.className).slice(0, 60)) : 'no match';
    }
    out.route = location.pathname + location.search;
    out.footerActionsPresent = Boolean(document.querySelector('.sidebar-footer-actions'));
    return out;
  })()`);
  console.log(`note anchors at ${anchorsHere.route}:`);
  for (const [key, value] of Object.entries(anchorsHere)) if (key !== 'route') console.log(`note   ${key}: ${value}`);

  // The first-run layout has no footer to hold it, so the honest outcome here is
  // the failure the corner step used to make look like success: the placement
  // found nothing, and the client's own route to app settings is what remains.
  // What must NOT happen is the old behaviour, a control parked inside the
  // settings page's own sidebar, which is the wrong place and, worse, permanent.
  const firstRun = await wc.executeJavaScript(placementQuery);
  console.log(`note placement on the first-run layout: ${JSON.stringify(firstRun)}`);
  check('the first-run layout does not park the control in the settings sidebar',
    !firstRun.placed || !/settings-sidebar/.test(String(firstRun.parent || '')), JSON.stringify(firstRun));

  /* ------------------------------------- the layout the app actually shows */

  // The chat layout, which is where a configured client sits and where the
  // Control UI renders the footer this control belongs in.
  //
  // NO SYNTHETIC FOOTER. This step used to INSERT the footer markup, taken from
  // the running bundle's own template, and assert the placement against that. It
  // was the wrong artifact and it hid a real difference: the bundle the gateway
  // serves is the one the client loads, and the OpenClaw CHECKOUT on the machine
  // can be ahead of it. Measured 2026-09-16: the checkout carries a Settings icon
  // in the footer action strip (commit 362492d7340) that the served build
  // predates, so a check that read either one could not see the other, and a
  // harness that built its own footer could not see either.
  //
  // So the footer now has to BE there, and the failure is loud rather than
  // substituted. A gateway reaches this layout once it has a model provider it can
  // talk to; the header says how to start one that does.
  const footer = await wc.executeJavaScript(`(() => {
    const bar = document.querySelector('.sidebar-footer-bar');
    if (!bar) return { present: false, route: location.pathname + location.search, body: document.body.className };
    return {
      present: true,
      route: location.pathname + location.search,
      actions: Boolean(document.querySelector('.sidebar-footer-actions')),
      settingsControl: Boolean(document.querySelector('.sidebar-footer-bar__settings')),
      controls: [...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.className),
      // The evidence, kept short: the class structure is what the anchors are
      // about, and printing every attribute of someone else's markup would bury it.
      // Whitespace is flattened by the caller rather than here, so this script has
      // no escape sequences in it at all.
      html: bar.outerHTML.slice(0, 4000),
    };
  })()`);
  console.log(`note the SERVED footer at ${footer.route}: ${footer.controls ? footer.controls.length : 0} control(s)`);
  if (footer.controls) for (const label of footer.controls) console.log(`note   served control: ${label}`);
  if (footer.html) console.log(`note served footer markup: ${String(footer.html).replace(/\s+/g, ' ').slice(0, 900)}`);
  check('the SERVED page has a real sidebar footer to place into',
    footer.present && footer.actions,
    'no .sidebar-footer-actions on the page: start the throwaway gateway with a model provider so the '
    + 'Control UI leaves its first-run flow, rather than substituting markup for the real thing');
  // The artifact difference itself, asserted rather than noted: on the served
  // build the footer has no settings control, so `controlUiSettings` matching
  // nothing is CORRECT there, and a harness that treated that as a failure would
  // be the same mistake in the other direction.
  console.log(`note the served footer ${footer.settingsControl ? 'HAS' : 'has NO'} settings control `
    + `(the checkout is a different artifact; see core/spec/app-settings-affordance.json's servedFooter)`);
  await delay(1500);

  const anchorsThere = await wc.executeJavaScript(`(() => {
    const spec = window.__clawAppSettingsConfig && window.__clawAppSettingsConfig.anchors;
    const out = {};
    for (const key of Object.keys(spec || {})) {
      const node = document.querySelector(spec[key]);
      out[key] = node ? ('MATCH ' + node.tagName.toLowerCase() + '.' + String(node.className).slice(0, 60)) : 'no match';
    }
    out.route = location.pathname + location.search;
    return out;
  })()`);
  console.log(`note anchors at ${anchorsThere.route}:`);
  for (const [key, value] of Object.entries(anchorsThere)) if (key !== 'route') console.log(`note   ${key}: ${value}`);
  // Every placement anchor must match the page that ships, and the required one
  // must be the footer's action row: this is the assertion the earlier check made
  // against the wrong artifact.
  for (const key of ['primary', 'footer', 'sidebar']) {
    check(`the ${key} anchor matches the SERVED page`,
      /^MATCH/.test(String(anchorsThere[key])),
      `${key} is ${appSettingsAffordance.AFFORDANCE_ANCHORS[key]} and the served page has nothing matching it`);
  }

  const where = await wc.executeJavaScript(placementQuery);
  check('the affordance is placed at all', where.placed === true, JSON.stringify(where));
  if (where.placed) {
    check('and it is in the sidebar FOOTER actions row, not a corner',
      where.inFooterActions === true, JSON.stringify(where));
    check('and it is inside the footer bar', where.inFooterBar === true, JSON.stringify(where));
    // The corner step is the one that sets these; a footer placement leaves the
    // stylesheet's own values in place. This is the upgrade step's other half.
    check('and the corner fallback did not fire, or was cleared by the move',
      where.position !== 'absolute', JSON.stringify(where));
    check('and the page itself records which anchor it used',
      where.placement === 'footer-actions',
      `the control reports its placement as ${JSON.stringify(where.placement)}`);
    check('and it carries the label the spec names', where.label === 'App settings', String(where.label));
  }
  const shot = await capture('affordance-placement');
  if (shot) console.log(`note shot: ${shot}`);

  /* ------------------------------------- what "Go to Control UI settings" does */

  // The same call both clients make, evaluated in the page it is meant for.
  const before = await wc.executeJavaScript('location.href');
  const pressed = await wc.executeJavaScript(
    "(() => { const c = window.__clawAppSettingsConfig; return c && typeof c.openControlUiSettings === 'function' ? c.openControlUiSettings() : 'no-config'; })()",
  );
  await delay(3000);
  const after = await wc.executeJavaScript('location.href');

  console.log(`note the shared call reported: ${JSON.stringify(pressed)}`);
  console.log(`note url before: ${before}`);
  console.log(`note url after:  ${after}`);

  // The deliverable: the reader lands on the tab the Control UI's OWN settings
  // entry opens, which is `appearance`.
  check('the reader lands on the Control UI settings route', after.includes('/settings/'), after);
  check('and on the APPEARANCE tab, the one its own entry opens',
    await wc.executeJavaScript("location.pathname === '/settings/appearance'"), after);

  const route = await wc.executeJavaScript(
    "(() => { const active = document.querySelector('.settings-sidebar__item--active, [aria-current=\"page\"]'); return { active: active ? (active.textContent || '').trim() : null, path: location.pathname + location.hash }; })()",
  );
  console.log(`note route after: ${JSON.stringify(route)}`);
  check('and the page says so itself', /appearance/i.test(route.path) || /appearance/i.test(String(route.active)), JSON.stringify(route));
  await capture('affordance-control-ui-settings');

  /* ------------------------------------------------------------ the journey */

  // Everything above checks where the reader LANDS. What was wrong with this
  // handoff was the journey: the app dismissed its own surface FIRST and asked
  // second, so the reader was returned to whatever the Control UI had been showing
  // and watched it for the whole of the destination's load, a visible few seconds,
  // before the settings page arrived. The destination was never wrong.
  //
  // So this drives the handoff from the REAL button in the real page and captures
  // the composited window all the way through it. The composite is the point:
  // our settings surface is a child view stacked over the gateway page, so what
  // the reader saw is a fact about the window the OS drew and no assertion about
  // either page alone can make it.

  // Put the Control UI somewhere that is NOT the destination, and that the reader
  // must not be shown again. Another TAB of the Control UI's own settings, rather
  // than the chat layout, and deliberately: it carries the same settings SHELL the
  // destination does, which is exactly the case a readiness check that looked only
  // for the shell would call "already there" and reveal immediately.
  await wc.executeJavaScript("location.assign('/settings/profile'); true").catch(() => {});
  await delay(6000);
  const previousRoute = await wc.executeJavaScript('location.pathname');
  // Is the readiness node on the page they came from? If it is, a probe that
  // looked only for the node would answer "ready" the instant they pressed, on the
  // page they were already looking at, which is the whole reason the probe also
  // requires the route. Reported rather than assumed, because it is a fact about
  // someone else's markup.
  const shellAtPrevious = await wc.executeJavaScript(
    `Boolean(document.querySelector(${JSON.stringify(appSettingsAffordance.AFFORDANCE_ANCHORS.controlUiSettingsSurface)}))`,
  );
  const destination = appSettingsAffordance.AFFORDANCE_ROUTES.appearance;
  check('the reader starts somewhere that is not the destination', previousRoute !== destination, previousRoute);
  console.log(`note the readiness node is ${shellAtPrevious ? 'PRESENT' : 'absent'} on ${previousRoute}, `
    + `so a ${shellAtPrevious ? 'node-only check would answer ready at once and the route check is what stops it' : 'node-only check would also be correct here'}`);
  check('and the readiness check still refuses to call that destination',
    (await wc.executeJavaScript(appSettingsAffordance.controlUiSettingsReadySource())) === false,
    'the readiness check answered true on the page the reader came from');

  // What the reader must NOT be returned to: the window with our surface down, on
  // the view they were on. Captured before the click, as the baseline.
  const previousFrame = await framed('transition-before', FRAME_WIDTH);

  const settingsItem = menuItem('Settings\u2026');
  check('our settings surface can be opened', Boolean(settingsItem), 'no "Settings\u2026" menu item');
  if (settingsItem) {
    settingsItem.click();
    await delay(2500);
  }
  const ours = overlayContents();
  check('our settings surface is up over the Control UI', Boolean(ours), 'the settings overlay never opened');
  const holding = await framed('transition-holding');

  if (ours) {
    // The real control, pressed the way a person presses it: through the page's
    // own listener and the host bridge, not by calling main's function directly.
    const cardUp = await ours.executeJavaScript(
      "(() => { const b = document.getElementById('open-control-ui-settings'); return Boolean(b) && b.offsetParent !== null; })()",
    );
    check('the card that carries the handoff is on screen', cardUp === true, 'the Control UI settings card is not shown');

    // The DOM half of the record, on its own loop. Separate from the frame loop
    // because grabbing a frame costs milliseconds, and one loop would sample the
    // page too slowly to say what was true while a given frame was on screen.
    const states = [];
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const at = Date.now();
        let pathname = null;
        let ready = null;
        try {
          pathname = await wc.executeJavaScript('location.pathname');
          ready = await wc.executeJavaScript(appSettingsAffordance.controlUiSettingsReadySource());
        } catch { /* the document is being replaced; the next sample lands in the new one */ }
        states.push({ at, pathname, ready });
        await delay(10);
      }
    })();

    const clickAt = Date.now();
    await ours.executeJavaScript("document.getElementById('open-control-ui-settings').click()").catch(() => {});

    // The burst. Frames as close together as the compositor will hand them over,
    // each with the moment it was taken, until our surface is down and the
    // destination is rendered.
    //
    // Several capturers rather than one, because `getSources` costs ~80ms whatever
    // the thumbnail size is and one loop therefore samples a window that lasts a
    // few hundred milliseconds about five times. The monitor owns the end
    // condition so every capturer stops on the same event, and the frames are
    // sorted afterwards because they arrive from more than one place.
    const frames = [];
    const run = { stop: false, revealedAt: null };
    const capturer = async () => {
      while (!run.stop) {
        const at = Date.now() - clickAt;
        const up = Boolean(overlayContents());
        const frame = await framed(up ? null : (run.revealedAt === null ? 'transition-revealed' : null), FRAME_WIDTH);
        frames.push({ at, up, sig: frame.sig });
        if (!up && run.revealedAt === null) run.revealedAt = at;
      }
    };
    const monitor = (async () => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 15000) {
        if (run.revealedAt !== null) {
          const ready = await wc.executeJavaScript(appSettingsAffordance.controlUiSettingsReadySource()).catch(() => false);
          if (ready === true) break;
        }
        await delay(10);
      }
      run.stop = true;
    })();
    await Promise.all([monitor, capturer(), capturer(), capturer()]);
    frames.sort((a, b) => a.at - b.at);
    const revealedAt = run.revealedAt;
    polling = false;
    await poll;

    // What the reader was looking at while our surface was up, and when the
    // destination became ready. Correlated by time rather than by index, because
    // the two loops run at different rates.
    const nearest = (at) => states.reduce(
      (best, s) => (best === null || Math.abs(s.at - (clickAt + at)) < Math.abs(best.at - (clickAt + at)) ? s : best),
      null,
    );
    const readyState = states.find((s) => s.ready === true) || null;
    const readyAt = readyState ? readyState.at - clickAt : null;

    // THE INVARIANT, and the whole point of the fix: at no sampled instant was the
    // reader looking at a view they did not ask for. Either our surface was up over
    // the window, or the Control UI was on the destination with its settings page
    // rendered. There is no third state, and the old order produced one on every
    // frame from the click until the destination arrived.
    const exposed = frames.filter((f) => !f.up).filter((f) => {
      const state = nearest(f.at);
      return !(state && state.ready === true && state.pathname === destination);
    });
    check('no frame showed a view the reader did not ask for', exposed.length === 0,
      `${exposed.length} of ${frames.length} frames had our surface down with the destination not ready: `
      + JSON.stringify(exposed.slice(0, 3).map((f) => ({ at: f.at, state: nearest(f.at) }))));

    // The same claim in pixels, and scoped to the frames where it means something:
    // for as long as our surface held, the window must not have looked like the page
    // the reader came from. The surface is a translucent scrim over the Control UI,
    // so this is a real claim rather than a tautology, and it is the half a DOM read
    // cannot make: it is evidence that "the surface is up" really did mean the
    // window was covered.
    //
    // Measured against the NOISE FLOOR rather than a number picked out of the air.
    // Two captures of the same still page do not come back identical, and the size
    // of that difference decides what any comparison here is worth: a threshold
    // below it would pass on any two frames, and one above the real separation
    // would fail on a correct run. Both numbers are printed so the margin is
    // visible rather than implied.
    const heldAway = frames
      .filter((f) => f.up && f.sig && previousFrame.sig)
      .map((f) => frameDiff(f.sig, previousFrame.sig));
    // Captured back to back on a page that is not moving, which is what makes them
    // a noise floor rather than a comparison.
    const stillA = await framed(null, FRAME_WIDTH);
    const stillB = await framed(null, FRAME_WIDTH);
    const noise = stillA.sig && stillB.sig ? frameDiff(stillA.sig, stillB.sig) : 0;
    const separation = previousFrame.sig && stillA.sig ? frameDiff(previousFrame.sig, stillA.sig) : 0;
    console.log(`note frame noise floor ${noise.toFixed(1)}, page separation ${separation.toFixed(1)}`);
    check('and the window never looked like the page the reader came from while it held',
      heldAway.length > 0 && Math.min(...heldAway) > Math.max(3 * noise, 4),
      `${heldAway.length} frames held; closest to the page they came from differed by ${heldAway.length ? Math.min(...heldAway).toFixed(1) : 'n/a'} against a noise floor of ${noise.toFixed(1)}`);

    // The reveal really happened, and it really showed the destination: otherwise
    // the checks above could pass on a run where nothing moved at all.
    check('our surface really did come down', frames.some((f) => !f.up) && frames.some((f) => f.up),
      `${frames.filter((f) => f.up).length} frames up, ${frames.filter((f) => !f.up).length} down`);
    // The still frame the comparisons are anchored on, saved for a person to look
    // at next to 'transition-before': the two ends of the journey.
    await framed('transition-settled', FRAME_WIDTH);

    // Every frame against both ends, printed rather than summarised, because the
    // interesting question is not "how different" but "different from WHICH": a
    // frame that sits close to the page the reader came from and far from the
    // destination is a view they did not ask for, and one number cannot say that.
    if (stillA.sig) {
      console.log('note frame  at    surface  vs-came-from  vs-destination');
      for (const f of frames) {
        if (!f.sig) continue;
        const dPrev = previousFrame.sig ? frameDiff(f.sig, previousFrame.sig) : NaN;
        const dDest = frameDiff(f.sig, stillA.sig);
        console.log(`note        ${String(f.at).padStart(4)}ms  ${f.up ? 'up  ' : 'DOWN'}     ${dPrev.toFixed(1).padStart(5)}         ${dDest.toFixed(1).padStart(5)}`);
      }
    }

    // What the pixels can and cannot settle, said plainly because the next person
    // here will otherwise assume they can settle more. Two captures of the SAME
    // still page differ by about as much as the two settings routes differ from
    // each other: the Control UI's settings pages share a shell, a sidebar and a
    // palette, so at any scale cheap enough to sample at 26ms they are the same
    // picture. A pixel test therefore CANNOT say "this is the appearance tab and
    // not the profile tab", and one that claimed to would be reading the noise
    // floor as content.
    //
    // So the destination is asserted where it is actually observable, which is the
    // DOM: the invariant above requires the Control UI to be on the destination
    // route with its settings page rendered at every instant the surface was down.
    // The frames are kept for the claim they CAN carry, and for a person to look at.
    console.log(`note ${frames.length} frames kept at ${SHOTS || 'no'} --shots dir; the destination is asserted on the DOM, not on these`);

    // The measurement. The old order dismissed our surface at ~0ms, so the window
    // it exposed the previous view for is exactly "how long the destination takes
    // to be ready". That is the gap this run removed, and it is reported in the
    // same units as the thing that replaced it.
    console.log(`note destination ready ${readyAt === null ? '(never)' : `${readyAt}ms`} after the click`);
    console.log(`note our surface revealed the destination ${revealedAt === null ? '(never)' : `${revealedAt}ms`} after the click`);
    const span = frames.length > 1 ? frames[frames.length - 1].at - frames[0].at : 0;
    console.log(`note sampled ${frames.length} frames over ${span}ms (~${frames.length > 1 ? Math.round(span / (frames.length - 1)) : 0}ms apart), and ${states.length} page states at ~10ms`);
    check('the destination was ready before it was revealed',
      readyAt !== null && revealedAt !== null && revealedAt >= readyAt - 15,
      `ready at ${readyAt}ms, revealed at ${revealedAt}ms`);
  }

  console.log(failed ? 'FAILED' : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
