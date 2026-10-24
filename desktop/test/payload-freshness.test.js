// The Control UI payload the app renders must be the gateway's, not a cached one.
//
// Chela wraps someone else's product, and that product is served by the gateway.
// The app must not PAINT a pre-loaded or previously-cached Control UI: a launch
// after the gateway moved to a new build has to render what the gateway is serving
// now, with no user action. This is measured with markers in
// scripts/test-payload-freshness.js, which serves two distinguishable payloads and
// reads what the app drew; this file is the cheap half, keeping the mechanism that
// does it from being dropped in an edit no run would catch.
//
// The mechanism is exactly one line: the gateway page is loaded with revalidation
// forced, so the document cannot come from a cache. That is sufficient because the
// document decides which asset urls the page wants and upstream's assets are
// content-hashed, so a fresh document selects the matching bundle. Worker cache
// policy belongs to the page rather than to this client.
//
// `src/main.js` is Electron's entry and cannot be imported here, so this reads it
// the way the other desktop tests that reach it do (see dialogs.test.js).
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const SCRIPTS = path.join(HERE, '..', 'scripts');

/** A source file with its comments removed, so a quoted header is not read as one. */
function code(file) {
  const src = fs.readFileSync(file, 'utf8');
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
    i += 1;
  }
  return out;
}

const main = code(path.join(SRC, 'main.js'));

test('the gateway page is loaded with revalidation forced', () => {
  // Without this the document can come from the HTTP cache, which is what painted
  // the previous payload on a launch in the cacheable-document run of the harness.
  const load = main.match(/page\(\)\?\.loadURL\([^;]*\);/);
  assert.ok(load, 'the gateway page is not loaded through page().loadURL() any more');
  assert.match(load[0], /FRESH_DOCUMENT/,
    'the gateway page is loaded without forcing the document to revalidate, so a launch can paint a cached Control UI');
  assert.match(main, /FRESH_DOCUMENT\s*=\s*\{\s*extraHeaders:\s*[^}]*no-cache/,
    'the freshness options no longer ask for revalidation; a request with no Cache-Control is a request the cache answers');
  // One owner for the headers: two copies is how one of them stops being updated.
  const definitions = main.match(/const FRESH_DOCUMENT\b/g) || [];
  assert.equal(definitions.length, 1, `FRESH_DOCUMENT is defined ${definitions.length} times`);
});

test('the marker harness that proves this still asserts a first paint', () => {
  // The pointer, the way desktop/test/tokens.test.js points at the class guard: the
  // real evidence is a run rather than an assertion, so this fails loudly if the
  // harness or the part of it that can FAIL on a stale first paint is removed.
  const harness = path.join(SCRIPTS, 'test-payload-freshness.js');
  assert.ok(fs.existsSync(harness), 'the harness that measures the rendered payload is gone');
  const source = fs.readFileSync(harness, 'utf8');
  assert.match(source, /EXPECT_FIRST/, 'the harness no longer has a first-paint expectation, so a stale first paint would pass it');
  assert.match(source, /did-start-navigation/, 'the harness no longer records the navigations a launch made');
  assert.match(source, /AFTER-RECONNECT/, 'the harness no longer checks what survives a failed reconnect');
  assert.match(source, /AFTER-RESTORE/, 'the harness no longer checks that a fresh payload replaces the kept one');
});

test('the hold is keyed to the gateway it belongs to, and only that gateway', () => {
  // A bare boolean meant "there is a payload" without saying whose, so a connect
  // to a DIFFERENT gateway held the previous gateway's document on screen through
  // the attempt and left it there afterwards. Measured 2026-09-16 with
  // scripts/test-held-gateway-view.js --case switch: the second gateway refused the
  // connection and the reader was left looking at the first gateway's Control UI,
  // which looked authenticated and working because it was.
  assert.doesNotMatch(main, /payloadOnScreen/, 'the payload is a boolean again, so nothing records WHOSE document is on screen');
  assert.match(main, /let payloadGateway = null;/, 'there is no record of which gateway\'s document the view holds');
  assert.match(main, /payloadGateway = config\.get\(\)\.activeGatewayId;/, 'a finished load no longer records the gateway it brought in');
});

test('what may be shown is the shared rule, not a decision taken at the call site', () => {
  // core/connection.js owns it (and core/test/connection.test.js drives its truth
  // table), so a client cannot decide separately that a document from another
  // gateway, or one whose connection has failed, is still the reader's place.
  assert.match(main, /connectionState\.mayPresentGatewayView\(\{[\s\S]{0,200}?gatewayId: gw\.id,[\s\S]{0,120}?heldGatewayId: payloadGateway,[\s\S]{0,120}?phase: connection\.phase,/,
    'loadActiveGateway no longer asks the shared rule what may be shown, so the hold is a local decision again');
});

test('a failed attempt ends the hold, and the failure surface takes the screen', () => {
  // The two halves of the rule that a connected-looking screen breaks. A failure
  // used to be reportable OVER a held document, with no cover, on the reasoning
  // that hiding a working interface is worse than leaving it. It is not: the
  // reader is left looking at a gateway nothing is connected to, so the hold ends
  // and the app's own surface -- the cover, in its stopped state, with the notice
  // over it -- is what is on screen.
  assert.match(main, /function showConnectionFailure\(detail\) \{/,
    'showConnectionFailure can still be told to leave the screen alone');
  assert.doesNotMatch(main, /showConnectionFailure\([^)]*\{ cover/, 'a failure can still be reported without the cover');
  assert.match(main, /showConnectionFailure\(\{ errorCode, errorDescription, url: validatedURL \}\)/,
    'a failed load no longer reports the ordinary way');

  const failure = main.slice(main.indexOf("wc.on('did-fail-load'"), main.indexOf("wc.on('render-process-gone'"));
  const crash = main.slice(main.indexOf("wc.on('render-process-gone'"), main.indexOf('return view;'));
  assert.match(failure, /payloadGateway = null;/, 'a failed load leaves the document it was going to replace on screen');
  assert.match(crash, /payloadGateway = null;/, 'a dead renderer leaves the previous gateway on screen');
});

test('a dropped transport retains the document while the page reconnects', () => {
  const start = main.indexOf("if (report.kind === 'dropped')");
  assert.ok(start > 0, 'socket reports are still classified');
  const drop = main.slice(start, main.indexOf("if (report.kind === 'open')", start));
  assert.doesNotMatch(drop, /payloadGateway = null|showConnectionFailure|loadActiveGateway/);
  assert.doesNotMatch(main, /function handleSocketDropped/);
  // Load/authentication failures and a dead renderer remain separate boundaries.
  assert.match(main, /showConnectionFailure\(\{ errorCode, errorDescription, url: validatedURL \}\)/);
});

test('the harness that proves this still measures frames, and all three cases', () => {
  // The pointer, the way this file already points at its own marker harness: the
  // evidence for a claim about what was on screen is a run, so this fails loudly if
  // the harness or one of its cases is removed.
  const harness = path.join(SCRIPTS, 'test-held-gateway-view.js');
  assert.ok(fs.existsSync(harness), 'the harness that measures what is on screen after a failure is gone');
  const source = fs.readFileSync(harness, 'utf8');
  for (const kase of ['switch', 'drop', 'normal']) {
    assert.match(source, new RegExp(`'${kase}'`), `the ${kase} case is gone from the harness`);
  }
  assert.match(source, /function viewTimeline\(frames\)/, 'the harness no longer records what each frame showed');
  // The reader's answer comes from the app's view stack, and the pixels are
  // corroboration that is checked for having actually painted: a run of black
  // captures compares equal to itself, which is how a harness passes while
  // measuring nothing.
  assert.match(source, /const MIN_CONTRAST = 6;/, 'the harness no longer refuses a frame with nothing painted on it');
  assert.match(source, /function contrast\(bitmap\)/, 'the harness no longer measures whether a frame painted anything');
  assert.match(source, /const visible = win \? win\.isVisible\(\) : false;/, 'the harness records frames from a window that was not on screen');
  assert.match(source, /desktopCapturer\.getSources/, 'the harness no longer captures the composited window, so the child views are invisible to it');
});

/* ------------------------------------------------ a payload that is on screen */

// No fresh payload must not mean no payload. A failed navigation commits Chromium's
// own error document over the frame, so an attempt made in the view on screen
// destroys what is there and there is nothing left to fall back to by the time the
// failure is known. Measured 2026-09-16, and the assertions below are the ways that
// guarantee is arranged: the attempt happens elsewhere and is promoted only once it
// has loaded. What changed the same night: the hold ENDS on a failure, because a
// document kept over a connection that has failed is a screen claiming to be
// authenticated when nothing is connected.

test('a load attempt is made beside the payload on screen, not over it', () => {
  assert.match(main, /function startGatewayAttempt\(/,
    'there is no attempt-off-screen path, so a reconnect can only be made in the visible view');
  assert.match(main, /if \(hasPayload\) \{\s*startGatewayAttempt\(gw, url\);\s*return;/,
    'loadActiveGateway no longer diverts to an off-screen attempt when a payload is on screen, so a failed reconnect will destroy it');
  assert.match(main, /createGatewayView\(\{ attempt: true \}\)/,
    'the attempt view is not created as an attempt, so its failure would be handled as the visible view\'s');
  // The cold case is deliberately unchanged: with nothing on screen there is
  // nothing to protect, and the visible view takes the load as it always did.
  assert.match(main, /page\(\)\?\.loadURL\(url, FRESH_DOCUMENT\)/,
    'the first load no longer goes into the visible view');
});

test('a loaded attempt takes the place of the view on screen, and a failed one never does', () => {
  const finish = main.slice(main.indexOf("wc.on('did-finish-load'"), main.indexOf("wc.on('did-fail-load'"));
  const failure = main.slice(main.indexOf("wc.on('did-fail-load'"), main.indexOf("wc.on('render-process-gone'"));
  assert.match(finish, /if \(attempt\) promoteGatewayView\(view\);/, 'a loaded attempt no longer takes the place of the view on screen');
  assert.doesNotMatch(failure, /promoteGatewayView/, 'a FAILED attempt can be promoted, which is how an error document becomes the payload');
  assert.match(failure, /destroyGatewayView\(view\)/, 'a failed attempt is no longer thrown away');
});

// scripts/test-held-gateway-view.js --case switch is the frame evidence. The
// header comment above records what changed and why.
