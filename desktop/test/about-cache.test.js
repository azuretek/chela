// Clear cache and refresh, from the About page.
//
// The requirement this exists for is honesty rather than presence: a button that
// clears caches must say WHICH caches it cleared and confirm the reload, and it
// must reuse the app's one clear-and-reload path rather than growing a second
// that could come to mean something different. All four of those are checkable
// from the source and from the shared page, and the live proof is
// scripts/test-about-cache.js, which presses the real button in the real app.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const CORE_UI = path.join(HERE, '..', '..', 'core', 'ui');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const main = stripComments(readFileSync(path.join(SRC, 'main.js'), 'utf8'));
const preload = stripComments(readFileSync(path.join(SRC, 'preload.cjs'), 'utf8'));
const html = readFileSync(path.join(CORE_UI, 'about.html'), 'utf8');
const page = stripComments(readFileSync(path.join(CORE_UI, 'about.js'), 'utf8'));

/* ------------------------------------------------------------- the button */

test('the About page carries the button, in the interface\'s own components', () => {
  assert.match(html, /id="clear-cache"/, 'the About page has no clear-cache control');
  assert.match(html, />\s*Clear cache and refresh\s*</, 'the control is not labelled for what it does');
  // Upstream's section shape, the same as the Updates group above it: a stacked
  // text row and an actions row, rather than our own markup.
  assert.match(html, /settings-group" id="clear-cache-group"/, 'the section is not a settings group');
  assert.match(html, /id="clear-result"/, 'the section has nowhere to report what it did');
});

test('the button runs the host command, and never clears anything itself', () => {
  // The page is sandboxed and cannot reach a cache API; it asks the host, which
  // owns the one path. A page-side implementation would be a second one.
  assert.match(page, /api\.clearCacheAndReload\(\)/, 'the page does not call the host command');
  assert.doesNotMatch(page, /caches\.|serviceWorker|clearStorageData/,
    'the page clears something itself, so the app has two clear paths');
});

test('a host without the command hides the section rather than offering a dead button', () => {
  // The rule the settings page already follows: a control whose command is absent
  // is not offered, because a button that appears to work and does nothing is the
  // bug class this whole area keeps producing.
  assert.match(page, /const hasClear = typeof api\.clearCacheAndReload === 'function'/,
    'the page does not check whether the host can do this');
  assert.match(page, /if \(clearButton && !hasClear\) \$\('clear-cache-group'\)\.hidden = true/,
    'a host without the command still shows the button');
});

/* ------------------------------------------------------- the host's half */

test('one clear-and-reload path, shared with the menu and the tray', () => {
  // `void clearCacheAndReload()` at three call sites and one implementation: the
  // menu item, the tray item and this. A second implementation is how two
  // meanings of "clear the cache" get to exist.
  const definitions = main.match(/async function clearCacheAndReload\(/g) || [];
  assert.strictEqual(definitions.length, 1, `there are ${definitions.length} clear-and-reload implementations`);
  assert.match(main, /ipcMain\.handle\('app:clear-cache-and-reload', \(\) => clearCacheAndReload\(\)\)/,
    'the About page does not reach the same path the menu does');
  // And it goes through cache.clear, which is the module that knows what must NOT
  // be cleared: the gateway's paired-device identity lives in origin storage.
  const clearBlock = main.match(/async function clearCacheAndReload\(\)[\s\S]*?\n\}/);
  assert.ok(clearBlock, 'clearCacheAndReload is gone');
  assert.match(clearBlock[0], /cache\.clear\(session\.defaultSession, origins\)/,
    'the clear does not go through the cache module');
  assert.doesNotMatch(clearBlock[0], /clearStorageData\(|clearData\(/,
    'the clear reaches past the module that decides what must be kept');
});

test('the clear reports what it actually cleared, including what refused', () => {
  const clearBlock = main.match(/async function clearCacheAndReload\(\)[\s\S]*?\n\}/);
  assert.match(clearBlock[0], /cleared: results\.filter\(\(r\) => r\.ok\)\.map\(\(r\) => r\.origin\)/,
    'the report does not say which origins were cleared');
  assert.match(clearBlock[0], /failed: failed\.map\(\(r\) => \(\{ origin: r\.origin, error: r\.error \}\)\)/,
    'a step that refused is silently dropped from the report');
  assert.match(clearBlock[0], /ok: failed\.length === 0/, 'the report cannot say it was partial');
  assert.match(clearBlock[0], /kinds: \[\.\.\.cache\.CACHE_STORAGES\]/, 'the report does not name what kind of cache this drops');
});

test('the reload is confirmed from the LOAD, not from the press', () => {
  // The two are genuinely different events: with a document already on screen the
  // attempt is made off to the side, so a confirmation sent when the clear
  // returned would be the app asserting something it had not seen.
  assert.match(main, /let clearedLoadPending = false/, 'there is no record of a reload the reader asked for');
  assert.match(main, /clearedLoadPending = true;/, 'the press does not arm the confirmation');
  const loadHandler = main.match(/wc\.on\('did-finish-load'[\s\S]*?\n  \}\);/);
  assert.ok(loadHandler, 'the load handler is gone');
  assert.match(loadHandler[0], /if \(clearedLoadPending\) \{[\s\S]{0,200}notifyCacheCleared\(true,/,
    'the confirmation is not sent from the load that landed');
  const failHandler = main.match(/wc\.on\('did-fail-load'[\s\S]*?\n  \}\);/);
  assert.ok(failHandler, 'the failure handler is gone');
  assert.match(failHandler[0], /if \(clearedLoadPending\) \{[\s\S]{0,260}notifyCacheCleared\(false,/,
    'a reload that failed leaves the About box saying "Reloading..." forever');
});

test('the confirmation reaches the page on its own channel', () => {
  assert.match(preload, /clearCacheAndReload: \(\) => ipcRenderer\.invoke\('app:clear-cache-and-reload'\)/,
    'the preload does not expose the clear command');
  assert.match(preload, /onCacheCleared: \(fn\) => ipcRenderer\.on\('app:cache-cleared', \(_event, report\) => fn\(report\)\)/,
    'the preload does not forward the confirmation');
  // Wrapped rather than handed the raw event, the same as every other listener
  // here: a renderer given `event` gets a way back into IPC.
  assert.doesNotMatch(preload, /app:cache-cleared', fn\)/, 'the raw event is handed to the renderer');
});

/* ----------------------------------------------------------- the sentence */

test('the page says what was cleared and what refused, in the reader\'s terms', () => {
  assert.match(page, /function describeClear\(report\)/, 'there is no reporting function');
  assert.match(page, /Cleared cached code and service workers for/, 'the report does not name what it cleared');
  assert.match(page, /No gateway is configured, so there was no cached code to clear/,
    'the first-run case has no sentence, so the reader sees an empty result');
  assert.match(page, /refused it/, 'a partial clear is smoothed over rather than reported');
  assert.match(page, /function reloadPending\(report\)/, 'the pending reload has no sentence');
  assert.match(page, /Reloading \$\{where\} from the server/, 'the report does not say a reload is coming');
  // And the confirmation is ADDED to what was cleared rather than replacing it:
  // the two arrive at different moments, so a line that swapped one for the other
  // would lose the answer to the question the reader actually asked.
  assert.match(page, /`\$\{clearSummary \? `\$\{clearSummary\} ` : ''\}\$\{confirmation\}`/,
    'the confirmation replaces the clear report instead of joining it');
});

test('the result line is coloured with the shared classes, not a private scheme', () => {
  assert.match(page, /node\.className = `result\$\{tone \? ` \$\{tone\}` : ''\}`/,
    'the result line does not use the shared .result classes the stylesheet defines');
});
