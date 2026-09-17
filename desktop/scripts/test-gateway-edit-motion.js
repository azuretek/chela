// Prove the gateway editor's expansion and collapse actually MOVE, in both
// directions, at frame resolution.
//
// The rule is core/ui/CONVENTIONS.md ("What counts as a transition": an in-place
// change is one, it runs in both directions, and it is verified by what was on
// screen DURING it). The mechanism is core/ui/settings.js plus the
// editor-disclosure rules in core/ui/ui.css. No assertion about two endpoints can
// make any of those claims: a panel that pops has the same two endpoints.
//
//   npx electron scripts/test-gateway-edit-motion.js [--out DIR] [--width N] [--reduced]
//
// WHAT IT MEASURES, and why each part is needed:
//
//   1. A per-frame trace of the disclosure while it moves, sampled on the page's
//      own animation frame, so the claim is about real frames rather than about a
//      handful of screenshots. A POP SHOWS TWO HEIGHTS (0 and full) and nothing in
//      between; a transition shows a ramp. That is the assertion.
//   2. The same trace for the closing press, plus the state IMMEDIATELY after the
//      press: the panel has to still be mounted with its animating class on it, or
//      the view is taken away on the same tick as the ask and never paints a frame.
//      That assertion is the regression guard for the one bug this harness caught.
//   3. The duration, from when the panel started changing to when it stopped, with
//      the animations' own end events alongside it, so the number is measured and
//      then compared against the token the conventions pin rather than read off the
//      stylesheet.
//   4. A burst of composited frames saved as PNGs, each tagged with the height and
//      the panel opacity that were on screen when it was grabbed, so a person can
//      see the intermediate states rather than take the trace's word for them.
//   5. The reduced-motion pass (--reduced), in which the panel must be at its
//      resting state with no intermediate frame at all, and the departure must not
//      wait for a duration nothing is going to animate.
//
// It loads the real page out of core/ui with a stub host, exactly as
// capture-gateway-form.js does and for the same reason: a capture has to show the
// page the app renders rather than a mock of it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argIndex = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const OUT = argIndex('--out', path.join(os.tmpdir(), 'claw-edit-motion'));
const WIDTH = Number(argIndex('--width', 620));
const REDUCED = process.argv.includes('--reduced');
fs.mkdirSync(OUT, { recursive: true });

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-edit-motion-'));
const { app, BrowserWindow, nativeTheme } = await import('electron');
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);
// Forced before the app is ready, which is when Chromium reads it, so the page
// answers prefers-reduced-motion: reduce exactly as it would for a reader who set
// it, and nothing here is exercising a special path of our own.
if (REDUCED) app.commandLine.appendSwitch('force-prefers-reduced-motion');

const REPO = path.join(import.meta.dirname, '..', '..');
const UI = path.join(REPO, 'core', 'ui');
const { stylesheet: tokenStylesheet } = await import('../src/tokens.js');
const { themeCss, themeFromReport } = await import('../src/chrome.js');

/**
 * What the page renders from when no client is behind it.
 *
 * Two gateways, so one pass can check the panel opens under ITS OWN row: a single
 * gateway cannot tell a working disclosure from one that puts every panel in the
 * first row. The first carries a stored credential, which is the state only an
 * existing gateway can be in and the one whose panel is tallest.
 */
const STATE = {
  client: 'desktop',
  surface: JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'settings.json'), 'utf8')),
  gateways: [
    {
      id: 'alpha',
      label: 'Home gateway',
      url: 'https://gateway.example.ts.net/',
      credentials: { hasToken: true, hasPassword: false, headers: ['CF-Access-Client-Id'] },
      status: { tone: 'muted', label: 'Not connected', detail: null },
    },
    {
      id: 'beta',
      label: 'Workshop gateway',
      url: 'https://workshop.example.ts.net/',
      credentials: { hasToken: false, hasPassword: false, headers: [] },
      status: { tone: 'muted', label: 'Not connected', detail: null },
    },
  ],
  activeGatewayId: null,
  connection: { phase: 'idle' },
  settings: {
    closeToTray: true, launchToLogin: false, launchAtLogin: false, startHidden: false,
    autoUpdate: true, promptMetadata: false, globalShortcut: 'CommandOrControl+Shift+O',
  },
  appearance: { mode: 'system' },
  build: '1.0.0 (source)',
  certOffers: [],
  trustedCerts: {},
  updates: {},
  secretsError: null,
};

const PRELOAD = path.join(PROFILE, 'stub-preload.cjs');
fs.writeFileSync(PRELOAD, [
  "const { contextBridge } = require('electron');",
  "const state = JSON.parse(process.env.CLAW_CAPTURE_STATE || '{}');",
  'contextBridge.exposeInMainWorld("clawSettings", {',
  '  asPage: false,',
  '  invoke: async (command) => {',
  "    if (command === 'setCredentials' || command === 'addHeader') {",
  "      return Object.assign({}, state, { saved: { ok: true, error: null } });",
  '    }',
  "    if (command === 'liveNotices' || command === 'noticeHistory') return [];",
  '    return state;',
  '  },',
  '  on: () => {},',
  '});',
  '',
].join('\n'));

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log('OK   ' + name);
  else { console.error('FAIL ' + name + ': ' + detail); failed = true; }
}

const WATCHDOG_MS = 150000;
setTimeout(() => {
  console.error('FAIL harness: still running after ' + (WATCHDOG_MS / 1000) + 's');
  app.exit(1);
}, WATCHDOG_MS).unref();

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every animation the page reports, with the numbers that make it the pinned one.
 *
 * The duration comes from the effect, and the CURVE from the element's computed
 * style rather than from the effect: Chromium applies a CSS animation's timing
 * function to its keyframes, so `effect.getTiming().easing` answers "linear" for an
 * animation that is plainly not linear. Reading the effect for the curve is how this
 * check passed against itself the first time it ran.
 */
const ANIMATIONS_JS = [
  'document.getAnimations().map(function (a) {',
  '  var effect = a.effect;',
  '  var timing = effect && effect.getTiming ? effect.getTiming() : {};',
  '  var target = effect && effect.target;',
  '  var style = target && getComputedStyle ? getComputedStyle(target) : null;',
  '  return {',
  '    name: a.animationName,',
  '    target: target && target.className ? String(target.className) : "",',
  '    duration: timing.duration === undefined ? null : timing.duration,',
  '    declared: style ? String(style.animationDuration) : null,',
  '    curve: style ? String(style.animationTimingFunction) : null,',
  '  };',
  '}).filter(function (a) { return a.duration && a.duration > 0; })',
].join('\n');

/**
 * The per-frame trace, sampled on the page's own animation frame.
 *
 * Four things per frame, because a pop and a transition agree at BOTH ends and can
 * disagree nowhere else:
 *
 *   - the disclosure wrapper's height, which is the thing that moves;
 *   - the panel's opacity, which is its content arriving;
 *   - the whole card's height, which is what the reader watches BELOW the panel:
 *     everything under it moves with it, and a card that sat at its old height for
 *     the whole change and then jumped would be the pop one layer out;
 *   - whether the panel is on screen at all, which is how the closing press is
 *     timed from the press to the element being gone.
 *
 * The animations' own animationend events are recorded too, so the duration can be
 * reported from the animation as well as from the shape of the ramp: the two agree
 * or one of them is lying.
 */
const TRACE_JS = [
  '(function () {',
  '  var s = window.__clawMotion = { samples: [], animations: null, ends: [], t0: performance.now() };',
  '  window.addEventListener("animationend", function (e) {',
  '    var name = e.animationName || "";',
  '    if (name.indexOf("editor-") !== 0) return;',
  '    s.ends.push({ name: name, t: Number((performance.now() - s.t0).toFixed(1)) });',
  '  }, true);',
  '  function sample() {',
  '    var wrap = document.querySelector("#gateways .editor-disclosure");',
  '    var panel = document.querySelector("#gateways .editor-disclosure__panel")',
  '      || document.querySelector("#gateways .editor");',
  '    var card = document.querySelector("#gateways .settings-group");',
  '    s.samples.push({',
  '      t: Number((performance.now() - s.t0).toFixed(1)),',
  '      has: Boolean(wrap),',
  '      h: wrap ? Number(wrap.getBoundingClientRect().height.toFixed(2)) : null,',
  '      o: panel ? Number(Number(getComputedStyle(panel).opacity).toFixed(3)) : null,',
  '      card: card ? Number(card.getBoundingClientRect().height.toFixed(2)) : null,',
  '    });',
  '    s.raf = window.requestAnimationFrame(sample);',
  '  }',
  '  sample();',
  '})()',
].join('\n');

const READ_TRACE_JS = [
  '(function () {',
  '  var s = window.__clawMotion;',
  '  if (!s) return null;',
  '  if (s.raf) window.cancelAnimationFrame(s.raf);',
  '  return { samples: s.samples, ends: s.ends };',
  '})()',
].join('\n');

/**
 * Press the named control on the FIRST gateway's row, and report the state the
 * press left the page in, in the same evaluation.
 *
 * The state is read HERE rather than a moment later on purpose: whether the panel is
 * still mounted with its animating class on it is true or false on the tick of the
 * press, and a check made after a round trip could not tell a departure that plays
 * from one that was cut off before it painted a frame.
 */
const PRESS_JS = (label) => [
  '(function () {',
  '  var card = document.querySelector("#gateways .settings-group");',
  '  var button = Array.prototype.slice.call(card.querySelectorAll(".row__actions button"))',
  '    .filter(function (b) { return b.textContent.trim() === ' + JSON.stringify(label) + '; })[0];',
  '  if (!button) return { pressed: false };',
  '  var s = window.__clawMotion;',
  '  if (s) s.pressAt = performance.now();',
  '  button.click();',
  '  var panel = document.querySelector("#gateways .editor-disclosure");',
  '  return {',
  '    pressed: true,',
  '    mounted: Boolean(panel),',
  '    classes: panel ? String(panel.className) : "",',
  '    animations: (' + ANIMATIONS_JS + '),',
  '    pressOffset: s && s.pressAt ? Number((s.pressAt - s.t0).toFixed(1)) : null,',
  '  };',
  '})()',
].join('\n');

/** What is on screen right now, for tagging a captured frame. */
const NOW_JS = [
  '(function () {',
  '  var wrap = document.querySelector("#gateways .editor-disclosure");',
  '  var panel = document.querySelector("#gateways .editor-disclosure__panel")',
  '    || document.querySelector("#gateways .editor");',
  '  var s = window.__clawMotion;',
  '  return {',
  '    t: s ? Number((performance.now() - s.t0).toFixed(1)) : null,',
  '    has: Boolean(wrap),',
  '    h: wrap ? Number(wrap.getBoundingClientRect().height.toFixed(1)) : null,',
  '    o: panel ? Number(Number(getComputedStyle(panel).opacity).toFixed(2)) : null,',
  '  };',
  '})()',
].join('\n');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: 720,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  // A background window still has to paint for a capture to hold a frame of a
  // hundred-millisecond animation, and for its animation frame callbacks to run at
  // all: without this the trace below is a handful of samples a quarter of a second
  // apart and a pop would be indistinguishable from a transition.
  win.webContents.setBackgroundThrottling(false);

  async function loadPage(mode) {
    process.env.CLAW_CAPTURE_STATE = JSON.stringify(STATE);
    await win.loadFile(path.join(UI, 'settings.html'));
    // The page's own palette, applied the way the app applies it: a capture taken
    // without it shows ui.css's fallback colours and cannot tell a page wearing the
    // reader's theme from one wearing its own.
    await win.webContents.insertCSS(tokenStylesheet());
    await win.webContents.insertCSS(themeCss(themeFromReport({ mode, tokens: {} })));
    await delay(700);
    await win.webContents.executeJavaScript(
      '(function () { (document.querySelector(".modal__body") || document.scrollingElement).scrollTop = 0; })()',
    );
    // One throwaway grab, so the first frame of a burst is not also the one that
    // pays for the capture pipeline being cold: measured here, a cold first grab
    // starved the trace for a fifth of a second and hid most of the opening ramp.
    await win.capturePage({ x: 0, y: 0, width: 40, height: 40 });
    await delay(120);
  }

  /**
   * Where a captured frame is taken from: the first gateway's card, and everything
   * under it down to the bottom of the window.
   *
   * The height is the point. The card is measured BEFORE the press, when the panel
   * is still shut, so a rect the size of the card is a rect of the ROW alone: every
   * frame of the expansion would be a picture of the row, identical to the last, and
   * the burst would prove nothing while looking like it had. The panel grows
   * downwards, so the region has to reach past it.
   */
  async function cardRect() {
    return win.webContents.executeJavaScript([
      '(function () {',
      '  var card = document.querySelector("#gateways .settings-group");',
      '  var r = card.getBoundingClientRect();',
      '  var top = Math.max(0, Math.round(r.top) - 6);',
      '  return {',
      '    x: Math.max(0, Math.round(r.left) - 6),',
      '    y: top,',
      '    width: Math.round(r.width) + 12,',
      '    height: Math.max(120, window.innerHeight - top),',
      '  };',
      '})()',
    ].join('\n'));
  }

  /**
   * One change: traced on its own, then captured.
   *
   * Two passes rather than one, because grabbing a composited frame costs
   * milliseconds: a loop that captured while it traced would sample the animation
   * too coarsely to say what was true at a given frame. So the trace runs with
   * nothing but the page on it, and the captures follow with each frame tagged with
   * the height and the opacity that were on screen when it was grabbed.
   */
  async function traced(label, name, burst) {
    await win.webContents.executeJavaScript(TRACE_JS);
    const rect = await cardRect();
    const press = await win.webContents.executeJavaScript(PRESS_JS(label));
    const frames = [];
    if (burst) {
      const until = Date.now() + 420;
      while (Date.now() < until) {
        const at = await win.webContents.executeJavaScript(NOW_JS);
        const image = await win.capturePage(rect);
        const file = name + '-' + String(frames.length).padStart(2, '0') + '.png';
        fs.writeFileSync(path.join(OUT, file), image.toPNG());
        frames.push({ t: at.t, has: at.has, h: at.h, o: at.o, file: file });
      }
    } else {
      await delay(420);
    }
    const trace = await win.webContents.executeJavaScript(READ_TRACE_JS);
    return { press: press, trace: trace, frames: frames, rect: rect };
  }

  const values = (samples, key) => samples.map((s) => s[key]);

  /**
   * The heights that are neither the closed end nor the open one.
   *
   * A pop's signature is exact and this is it: every value is one of the two ends.
   * So the count of strictly intermediate values is the assertion, and the SET of
   * values is printed rather than summarised.
   */
  const intermediates = (list, full) => list.filter((v) => v !== null && v > 0.5 && Math.abs(v - full) > 1.5);

  /**
   * How long the panel was visibly changing.
   *
   * Measured from the samples rather than read off the stylesheet: the first frame
   * the widget differs from where it came from, to the last frame it differs from
   * where it is going. Both ends are the widget's own geometry, so this cannot be
   * satisfied by a class being present.
   */
  function measured(openSamples, from, to) {
    const moving = openSamples.filter((s) => s.h !== null && Math.abs(s.h - from) > 1.5 && Math.abs(s.h - to) > 1.5);
    if (!moving.length) return null;
    return Number((moving[moving.length - 1].t - moving[0].t).toFixed(1));
  }

  const summary = {};
  for (const mode of ['light', 'dark']) {
    nativeTheme.themeSource = mode;
    await loadPage(mode);

    /* ---- the opening ---------------------------------------------------- */
    const openTrace = await traced('Edit', 'expand-' + mode, true);
    const openSamples = openTrace.trace.samples;
    const openPresent = openSamples.filter((s) => s.has);
    const fullHeight = openPresent.length ? Math.max.apply(null, openPresent.map((s) => s.h)) : 0;
    const openHeights = values(openPresent, 'h');
    const openMid = intermediates(openHeights, fullHeight);
    const cardHeights = values(openPresent, 'card');
    const cardFull = cardHeights.length ? Math.max.apply(null, cardHeights) : 0;
    const cardMid = intermediates(cardHeights, cardFull);
    const openOpacities = Array.from(new Set(values(openPresent, 'o')));
    const firstOpenHeight = openPresent.length ? openPresent[0].h : null;
    const openAnimations = (openTrace.press.animations || []).filter((a) => /^editor-/.test(a.name));
    // Both ends are reported from the PRESS, not from when the trace was armed: the
    // claim is how long the reader waited, and the arm happens a millisecond or two
    // before the click.
    const openEnds = (openTrace.trace.ends || [])
      .filter((e) => /^editor-/.test(e.name))
      .map((e) => ({ name: e.name, ms: Number((e.t - (openTrace.press.pressOffset || 0)).toFixed(1)) }));
    const openSpan = measured(openPresent, openPresent.length ? openPresent[0].h : 0, fullHeight);

    console.log('');
    console.log('[' + mode + '] opening');
    console.log('     pinned animations: ' + JSON.stringify(openAnimations));
    console.log('     animationend:      ' + JSON.stringify(openEnds));
    console.log('     frames: ' + openSamples.map((s) => (s.has ? s.t + 'ms h=' + s.h + ' o=' + s.o : s.t + 'ms -')).join(' | '));
    if (openTrace.frames.length) {
      console.log('     captured: ' + openTrace.frames
        .map((f) => f.t + 'ms ' + (f.has ? 'h=' + f.h + ' o=' + f.o : 'gone') + ' ' + f.file).join(' | '));
    }

    check(mode + ': the Edit press opened the panel',
      openTrace.press.pressed === true && openPresent.some((s) => s.h > 1),
      JSON.stringify({ press: openTrace.press.pressed, heights: values(openSamples, 'h') }));

    if (REDUCED) {
      check(mode + ': with reduced motion the panel is OPEN on its first frame',
        firstOpenHeight !== null && Math.abs(firstOpenHeight - fullHeight) < 1.5 && openMid.length === 0,
        'first frame ' + firstOpenHeight + ' against a resting height of ' + fullHeight
          + ', ' + openMid.length + ' intermediate frames');
      check(mode + ': and no animation ran to get there',
        openAnimations.length === 0 && openEnds.length === 0, JSON.stringify(openAnimations));
      console.log('     reduced motion: no ramp, panel at ' + fullHeight + 'px from its first frame');
    } else {
      check(mode + ': the panel EXPANDED through intermediate frames rather than popping',
        openMid.length >= 2, 'heights seen: ' + Array.from(new Set(openHeights)).join(', '));
      check(mode + ': the card below it ramped too, so the page did not jump',
        cardMid.length >= 2, 'card heights: ' + Array.from(new Set(cardHeights)).join(', '));
      check(mode + ": the panel's content arrived on opacity rather than in one frame",
        openOpacities.length >= 3 && openOpacities[0] < 0.35 && openOpacities[openOpacities.length - 1] > 0.9,
        'opacities: ' + openOpacities.join(', '));
      check(mode + ': two pinned animations ran for the opening, at --duration-fast',
        openAnimations.length >= 2
          && openAnimations.every((a) => a.duration === 100)
          && openAnimations.every((a) => /cubic-bezier\(0\.16, 1, 0\.3, 1\)/.test(String(a.curve))),
        JSON.stringify(openAnimations));
      check(mode + ': the opening took the token, not longer',
        openSpan !== null && openSpan >= 30 && openSpan <= 220,
        'measured ' + openSpan + 'ms of visibly changing frames');
      check(mode + ': and both animations ended, once each, within the token plus a frame',
        openEnds.length >= 2 && openEnds.every((e) => e.ms >= 80 && e.ms <= 200),
        JSON.stringify(openEnds));
      console.log('     measured: open ' + openSpan + 'ms of changing frames (' + openMid.length + ' of '
        + openPresent.length + ' intermediate), resting height ' + fullHeight + 'px');
      summary['open-' + mode] = { span: openSpan, endMs: openEnds.map((e) => e.ms), full: fullHeight };
    }

    /* ---- the closing ---------------------------------------------------- */
    const closeTrace = await traced('Done', 'collapse-' + mode, true);
    const closeSamples = closeTrace.trace.samples;
    const closing = closeSamples.filter((s) => s.has);
    const closeHeights = values(closing, 'h');
    const closeFull = closeHeights.length ? Math.max.apply(null, closeHeights) : 0;
    const closeMid = intermediates(closeHeights, closeFull);
    const goneAt = closeSamples.filter((s) => !s.has)[0] || null;
    const closeAnimations = (closeTrace.press.animations || []).filter((a) => /^editor-/.test(a.name));
    const closeEnds = (closeTrace.trace.ends || [])
      .filter((e) => /^editor-/.test(e.name))
      .map((e) => ({ name: e.name, ms: Number((e.t - (closeTrace.press.pressOffset || 0)).toFixed(1)) }));
    const closeSpan = measured(closing, closeFull, 0);

    console.log('');
    console.log('[' + mode + '] closing');
    console.log('     pinned animations: ' + JSON.stringify(closeAnimations));
    console.log('     state on the press: mounted=' + closeTrace.press.mounted + ' classes=' + JSON.stringify(closeTrace.press.classes));
    console.log('     animationend:      ' + JSON.stringify(closeEnds));
    console.log('     frames: ' + closeSamples.map((s) => (s.has ? s.t + 'ms h=' + s.h + ' o=' + s.o : s.t + 'ms gone')).join(' | '));
    if (closeTrace.frames.length) {
      console.log('     captured: ' + closeTrace.frames
        .map((f) => f.t + 'ms ' + (f.has ? 'h=' + f.h + ' o=' + f.o : 'gone') + ' ' + f.file).join(' | '));
    }

    check(mode + ': the Done press closed the panel',
      closeTrace.press.pressed === true && closing.length > 0 && !closeSamples[closeSamples.length - 1].has,
      JSON.stringify({ pressed: closeTrace.press.pressed, heights: values(closeSamples, 'h') }));
    // The regression guard. A panel removed on the same tick as the press never
    // paints a frame of its own departure, and that is invisible to every endpoint
    // check above: the state at the end is the same either way.
    //
    // Not under reduced motion, and the difference is the point rather than an
    // exception to it: the preference removes MOTION, not the correct end state, so
    // there is no departure to hold the panel for and it goes on the press. The
    // check below is what the reduced-motion reader gets instead.
    if (!REDUCED) {
      check(mode + ': the panel was still mounted, mid-departure, on the tick of the press',
        closeTrace.press.mounted === true
          && /editor-disclosure--leaving/.test(closeTrace.press.classes)
          && !/editor-disclosure--arriving/.test(closeTrace.press.classes),
        JSON.stringify({ mounted: closeTrace.press.mounted, classes: closeTrace.press.classes }));
    }

    if (REDUCED) {
      check(mode + ': with reduced motion the panel is GONE at once',
        closeMid.length === 0 && Boolean(goneAt) && goneAt.t < 80,
        closeMid.length + ' intermediate frames, gone at ' + (goneAt ? goneAt.t : 'never') + 'ms');
      check(mode + ': and no animation ran to get it gone',
        closeAnimations.length === 0 && closeEnds.length === 0, JSON.stringify(closeAnimations));
      console.log('     reduced motion: gone at ' + (goneAt ? goneAt.t : 'never') + 'ms with no ramp');
    } else {
      check(mode + ': the panel COLLAPSED through intermediate frames rather than popping',
        closeMid.length >= 2, 'heights seen: ' + Array.from(new Set(closeHeights)).join(', '));
      check(mode + ': two pinned animations ran for the closing, at --duration-fast',
        closeAnimations.length >= 2 && closeAnimations.every((a) => a.duration === 100),
        JSON.stringify(closeAnimations));
      check(mode + ': the closing took the token, not longer',
        closeSpan !== null && closeSpan >= 30 && closeSpan <= 220 && goneAt !== null && goneAt.t <= 320,
        'measured ' + closeSpan + 'ms of visibly changing frames, the element gone at ' + (goneAt ? goneAt.t : 'never') + 'ms');
      check(mode + ': and both animations ended, once each, within the token plus a frame',
        closeEnds.length >= 2 && closeEnds.every((e) => e.ms >= 80 && e.ms <= 200),
        JSON.stringify(closeEnds));
      console.log('     measured: close ' + closeSpan + 'ms of changing frames (' + closeMid.length + ' of '
        + closing.length + ' intermediate) from ' + closeFull + 'px, gone at ' + (goneAt ? goneAt.t : 'never') + 'ms');
      summary['close-' + mode] = { span: closeSpan, endMs: closeEnds.map((e) => e.ms), gone: goneAt ? goneAt.t : null };
    }

    /* ---- the state the reader is left in -------------------------------- */
    const settled = await win.webContents.executeJavaScript([
      '(function () {',
      '  var card = document.querySelector("#gateways .settings-group");',
      '  return {',
      '    panel: Boolean(card.querySelector(".editor-disclosure")),',
      '    label: Array.prototype.slice.call(card.querySelectorAll(".row__actions button"))',
      '      .map(function (b) { return b.textContent.trim(); }).join("/"),',
      '  };',
      '})()',
    ].join('\n'));
    check(mode + ': the panel is gone and the row is back to Edit',
      settled.panel === false && settled.label.indexOf('Edit') !== -1, JSON.stringify(settled));
  }

  /* ---- per row rather than per page ------------------------------------- */
  await loadPage('dark');
  const other = await win.webContents.executeJavaScript([
    '(function () {',
    '  var cards = document.querySelectorAll("#gateways .settings-group");',
    '  var button = Array.prototype.slice.call(cards[1].querySelectorAll(".row__actions button"))',
    '    .filter(function (b) { return b.textContent.trim() === "Edit"; })[0];',
    '  if (!button) return { pressed: false };',
    '  button.click();',
    // Re-queried AFTER the press: the render replaces every card, so a list
    // captured before it is a list of detached elements and every reading from it
    // is about a page that is no longer on screen.
    '  cards = document.querySelectorAll("#gateways .settings-group");',
    '  return {',
    '    pressed: true,',
    '    panels: document.querySelectorAll("#gateways .editor-disclosure").length,',
    '    underSecond: Boolean(cards[1].querySelector(".editor-disclosure")),',
    '    firstRow: Array.prototype.slice.call(cards[0].querySelectorAll(".row__actions button"))',
    '      .map(function (b) { return b.textContent.trim(); }).join("/"),',
    '    secondRow: Array.prototype.slice.call(cards[1].querySelectorAll(".row__actions button"))',
    '      .map(function (b) { return b.textContent.trim(); }).join("/"),',
    '  };',
    '})()',
  ].join('\n'));
  check('the panel opens under ITS own row, one at a time',
    other.pressed === true && other.panels === 1 && other.underSecond === true
      && other.secondRow.indexOf('Done') !== -1 && other.firstRow.indexOf('Edit') !== -1,
    JSON.stringify(other));

  console.log('');
  console.log('SHOTS ' + OUT);
  if (!REDUCED) console.log('measured: ' + JSON.stringify(summary));
  fs.rmSync(PROFILE, { recursive: true, force: true });
  console.log(failed ? 'FAILED' : 'OK   the editor moves in both directions');
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error('FAIL harness: ' + (err && err.stack ? err.stack : err));
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(1);
});
