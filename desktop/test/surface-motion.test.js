// The host's half of the motion rule: a surface is not taken away until the page
// has finished leaving.
//
// The rule and the numbers are core/ui/CONVENTIONS.md, and the page-side half is
// core/ui/surface.js with its own guard in core/test/motion.test.js. What is
// asserted here is the part only the host can get wrong, and every way it is wrong
// is silent:
//
//   1. The view is removed on the same tick as the ask, so the page never paints a
//      frame of its own departure and the animation exists in the stylesheet only.
//   2. The host waits on a page that never answers, leaving a view it can no longer
//      take away. The wait is therefore asserted to be bounded.
//   3. The cover is faded while its own background is still opaque, so the reader
//      sees the cover sit there rather than the app arriving underneath it.
//   4. The phone's bundle stops carrying a file the shared pages ask for, which
//      serves a page with a dead reference in exactly one client.
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const REPO = path.join(DESKTOP, '..');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const MAIN = read(DESKTOP, 'src', 'main.js');

/**
 * The body of a top-level function, by its opening line.
 *
 * The same walk as desktop/test/settings-surface.test.js, and a copy on purpose:
 * these are two files asserting two different claims about one source, and a
 * shared helper between them would be a third thing to keep in step.
 *
 * The PARAMETER list is skipped first, and that is not a detail: a destructured
 * parameter (`{ animate = true } = {}`) puts a brace inside the signature, so
 * searching for the first `{` finds that one and returns the parameter list as the
 * "body". Measured here, on this file's own first run: every assertion about the
 * body was reading `{ animate = true }` and reporting that the function did nothing.
 */
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is gone from the source`);
  const paren = source.indexOf('(', start);
  assert.ok(paren >= 0, `${signature} has no parameter list`);
  let depth = 0;
  let close = -1;
  for (let i = paren; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  assert.ok(close > 0, `${signature} has an unbalanced parameter list`);
  const open = source.indexOf('{', close);
  depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

/* ------------------------------------------------------- the departure wait */

test('a surface is asked to leave, and only then taken away', () => {
  const body = functionBody(MAIN, 'async function closeOverlay(');
  // The ask comes before the removal. A removal first is the fault this whole
  // arrangement exists for: an animation is never seen.
  const asked = body.indexOf('await leaveSurface(');
  const removed = body.indexOf('removeChildView(');
  assert.ok(asked >= 0, 'the host no longer asks the page to leave');
  assert.ok(removed >= 0, 'the view is never removed');
  assert.ok(asked < removed, 'the view is removed before the page is asked to leave');

  // The ask is conditional, because the no-transition paths exist: a view that is
  // already dead, and the surface being replaced as the window's own content.
  assert.match(body, /if \(animate\) await leaveSurface\(view\);/,
    'the departure is no longer optional, so a dead view is asked to animate');

  // Out of the map BEFORE the fade, so a second close or a reopen during those
  // hundred milliseconds cannot find a half-departed view and act on it.
  const forgotten = body.indexOf('overlayViews.delete(name)');
  assert.ok(forgotten >= 0 && forgotten < asked, 'the surface is still findable while it is leaving');

  // Detaching is what unblocks the window, so it stays guarded: this runs on the
  // crash path, where the contents are already gone.
  assert.match(body, /catch \{ \/\* window already gone/, 'the removal is no longer guarded');
});

test('the wait is bounded, and every non-answer means the view goes now', () => {
  const body = functionBody(MAIN, 'function leaveSurface(');
  // Bounded, because a page that never answers must not become a view the host
  // cannot take away.
  assert.match(body, /Promise\.race\(/, 'the wait is no longer bounded');
  assert.match(body, /SURFACE_LEAVE_CEILING_MS/, 'the bound is no longer the named ceiling');
  // The page's own answer, from the shared script, and never a duration the host
  // worked out for itself.
  assert.match(body, /window\.clawSurface \? window\.clawSurface\.leave\(\) : null/,
    'the host is not calling the page-side departure');
  assert.ok(!/duration-fast|100\b/.test(body),
    'the host is guessing at the page\'s timing instead of asking it');
  // No `clawSurface` (a script that did not load), a rejection (a page being torn
  // down), and a timeout all mean the same thing.
  assert.match(body, /\.catch\(\(\) => false\)/, 'a rejected ask no longer means gone now');
  assert.match(body, /isDestroyed\(\)/, 'a destroyed page no longer short-circuits');
});

test('the ceiling is a backstop rather than a duration anyone sees', () => {
  const value = /const SURFACE_LEAVE_CEILING_MS = (\d+)/.exec(MAIN);
  assert.ok(value, 'the ceiling is gone');
  const ms = Number(value[1]);
  // Comfortably past the page's own bound (one --duration-fast plus a frame), so
  // it never fires on a working page, and small enough that a wedged page cannot
  // hold the window for long.
  assert.ok(ms >= 300 && ms <= 1500, `the ceiling is ${ms}ms, which is either a false timeout or a wait`);
});

test('the two no-transition paths say so', () => {
  // The surface being REPLACED as the window's own content: a fade here would be a
  // hundred milliseconds of nothing in the middle of a page load.
  assert.match(MAIN, /closeOverlay\('settings', \{ animate: false \}\);/,
    'the settings-as-page path animates a surface it is replacing');
  // A view that is already dead, reached from both the recovery sweep and the
  // replace-on-reopen path: there is no departure left to play.
  const dead = [...MAIN.matchAll(/closeOverlay\(name, \{ animate: false \}\)/g)].length;
  assert.ok(dead >= 2, `only ${dead} of the dead-view paths say not to animate`);
  assert.match(MAIN, /overlayAlive\(name\)\) closeOverlay\(name, \{ animate: false \}\)/,
    'the recovery sweep animates a dead overlay');
});

/* -------------------------------------------------------------- the cover */

test('the cover is made see-through before it is asked to leave', () => {
  const body = functionBody(MAIN, 'function hideLoadingCover(');
  const transparent = body.indexOf("setBackgroundColor('#00000000')");
  const asked = body.indexOf('await leaveSurface(');
  assert.ok(transparent >= 0, 'the cover is no longer made transparent, so its fade reveals nothing');
  assert.ok(asked >= 0, 'the cover is no longer asked to leave');
  // The order is the whole point: the cover is the ONE view painted opaque, so a
  // fade over its own background is the cover sitting there a moment longer.
  assert.ok(transparent < asked, 'the cover fades while its own background is still opaque');
  // And the view is forgotten first, so a cover raised during the fade is a new one
  // rather than a second reference to this.
  const forgotten = body.indexOf('loadingView = null');
  assert.ok(forgotten >= 0 && forgotten < asked, 'the cover handle outlives the departure');
});

/* ------------------------------------------- the page and the phone agree */

test('every page that offers a departure loads the handshake, and the phone carries it', () => {
  // The desktop side: the pages whose view the host takes away.
  for (const page of ['settings.html', 'about.html', 'pairing.html', 'loading.html']) {
    assert.ok(
      read(REPO, 'core', 'ui', page).includes('src="surface.js"'),
      `${page} does not load surface.js, so its departure cannot be played`,
    );
  }
  // The phone side: it bundles the shared pages rather than mirroring them, so a
  // page's own relative link has to resolve in ITS bundle too. This is the way the
  // two clients drift apart without either one being edited wrongly.
  const project = read(REPO, 'mobile', 'project.yml');
  assert.match(project, /- path: \.\.\/core\/ui\/surface\.js/,
    'the iOS bundle does not carry surface.js, so its settings page loads a dead reference');
});

/* -------------------------------------------------- the measured half is kept */

test('the measured half of the motion is still a proof of the transition', () => {
  // The same shape as the guards in settings-surface.test.js: the claims above are
  // about the SHAPE of the code, and what a reader actually saw is a claim about a
  // composited window, which needs a capture. A harness that stopped capturing the
  // arrival or the departure would go on printing OK.
  const harness = read(DESKTOP, 'scripts', 'test-surface-motion.js');
  for (const claim of ['never showed a view the reader did not ask for', 'arriving', 'departing']) {
    assert.ok(harness.includes(claim), `the harness no longer checks the ${claim}`);
  }
  // Both preferences, because a rule that only describes the animated case is the
  // failing this rule was written to avoid.
  assert.match(harness, /prefers-reduced-motion|reducedMotion/,
    'the harness no longer covers the reduced-motion pass');
});

test('the in-place half is still a proof of the transition, in both directions', () => {
  // The gateway editor's own disclosure, which is the case the rule's widening was
  // written for. Its claims are about what was on screen DURING a change INSIDE one
  // surface, so they need a capture for the same reason the ones above do, and a
  // harness that quietly stopped making them would go on printing OK.
  const harness = read(DESKTOP, 'scripts', 'test-gateway-edit-motion.js');
  for (const claim of [
    'the panel EXPANDED through intermediate frames rather than popping',
    'the panel COLLAPSED through intermediate frames rather than popping',
    'the panel was still mounted, mid-departure, on the tick of the press',
    'the card below it ramped too, so the page did not jump',
  ]) {
    assert.ok(harness.includes(claim), `the harness no longer checks that ${claim}`);
  }
  // Both appearances, and both preferences.
  assert.match(harness, /for \(const mode of \['light', 'dark'\]\)/, 'the harness no longer covers both appearances');
  assert.match(harness, /force-prefers-reduced-motion/, 'the harness no longer covers the reduced-motion pass');
  // The departure is the half that gets skipped, so it is asserted to be measured
  // on its own and not inferred from the arrival.
  assert.match(harness, /'Done'/, 'the harness never presses the control that closes the panel');
});
