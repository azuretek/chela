// The Control UI payload the app renders must be the gateway's, not a cached one.
//
// Claw wraps someone else's product, and that product is served by the gateway.
// The app must not PAINT a pre-loaded or previously-cached Control UI: a launch
// after the gateway moved to a new build has to render what the gateway is serving
// now, with no user action, and the manual Clear cache and reload has to reach the
// same place. Both halves are measured with markers in
// scripts/test-payload-freshness.js, which serves two distinguishable payloads and
// reads what the app drew; this file is the cheap half, keeping the mechanism that
// does it from being dropped in an edit no run would catch.
//
// The mechanism is exactly one line: the gateway page is loaded with revalidation
// forced, so the document cannot come from a cache. That is sufficient because the
// document decides which asset urls the page wants and upstream's assets are
// content-hashed, so a fresh document cannot pull a stale bundle. What it does NOT
// cover is the service worker's own cache of an asset at a FIXED url, which only a
// cache clear moves; upstream hashes its asset names, and the app also drops the
// worker's caches when the gateway's build id moves.
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

test('Reload keeps the browser meaning and the menu keeps the escape hatch', () => {
  // Stated so the boundary is a decision rather than an omission. Reload is the
  // browser's own command and is left as it is; the two ways the payload is brought
  // current are the build-id refresh on load and the menu item below, and the
  // harness presses the real item rather than calling anything behind it.
  assert.match(main, /reload:\s*\{[^}]*page\(\)\?\.reload\(\)/,
    'Reload no longer reloads the page the browser way, which is a behaviour change this work did not ask for');
  assert.match(main, /clearCache:\s*\{[^}]*clearCacheAndReload\(\)/,
    'the Clear cache and reload command is gone, so there is no way to drop the worker caches by hand');
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
  assert.match(source, /Clear cache and reload/, 'the harness no longer reaches the manual cache clear');
  assert.match(source, /AFTER-RECONNECT/, 'the harness no longer checks what survives a failed reconnect');
  assert.match(source, /AFTER-RESTORE/, 'the harness no longer checks that a fresh payload replaces the kept one');
});

/* ------------------------------------------------ a payload that is on screen */

// No fresh payload must not mean no payload. A failed navigation commits Chromium's
// own error document over the frame, so an attempt made in the view on screen
// destroys what is there and there is nothing left to fall back to by the time the
// failure is known. Measured 2026-09-16, and the three assertions below are the
// three ways that guarantee is arranged: the attempt happens elsewhere, it is
// promoted only once it has loaded, and its failure is reported over the payload
// rather than in place of it.

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

test('an attempt is promoted only once it has actually loaded', () => {
  const finish = main.slice(main.indexOf("wc.on('did-finish-load'"), main.indexOf("wc.on('did-fail-load'"));
  const failure = main.slice(main.indexOf("wc.on('did-fail-load'"), main.indexOf("wc.on('render-process-gone'"));
  assert.match(finish, /if \(attempt\) promoteGatewayView\(view\);/, 'a loaded attempt no longer takes the place of the view on screen');
  assert.doesNotMatch(failure, /promoteGatewayView/, 'a FAILED attempt can be promoted, which is how an error document becomes the payload');
  assert.match(failure, /destroyGatewayView\(view\)/, 'a failed attempt is no longer thrown away');
});

test('a failed attempt is reported over the payload, with no cover', () => {
  // The cover exists to cover a gap where nothing is on screen. Putting it up over
  // a payload that was kept would hide a working interface in order to announce
  // that a fresh copy of it could not be fetched.
  assert.match(main, /function showConnectionFailure\(detail, \{ cover = true \} = \{\}\)/,
    'showConnectionFailure cannot be told to leave the screen alone');
  assert.match(main, /if \(cover\) showLoadingCover\(\);\s*else hideLoadingCover\(\);/,
    'the cover is raised unconditionally again, so a kept payload is covered by the failure surface');
  assert.match(main, /showConnectionFailure\(\{ errorCode, errorDescription, url: validatedURL \}, \{ cover: false \}\)/,
    'a failed attempt reports with the cover, hiding the payload it just preserved');
});
