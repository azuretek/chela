// The app icon at the start of the title strip, and the tray's menu on a right
// click (#113).
//
// Plain `node --test`, no Electron. What the strip DRAWS and what a right click on
// it reaches is scripts/prove-titlebar-icon.mjs, under Electron; this holds the
// declarations that make it so, read from the files that carry them, because each
// one has a failure that looks fine until somebody clicks:
//
//   * the icon out of the drag region, or the OS keeps the right click for itself
//     and a double click maximises the window;
//   * the strip's CSP admitting a data: image, or the icon is a broken box;
//   * ONE menu template for the tray and the icon, or the two drift;
//   * the icon drawn from the same choice as the window's, or the strip shows a
//     different icon from the taskbar's.
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import chrome from '../src/chrome.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, '..', '..', 'core', 'ui');
const SRC = path.join(HERE, '..', 'src');

const read = (file) => readFileSync(file, 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const flat = (css) => css.replace(/\s+/g, ' ').trim();

/** The body of a top-level function in main.js, by name. */
function fnBody(src, name) {
  const start = src.search(new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`));
  assert.ok(start >= 0, `main.js has no function ${name}`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open + 1, i); }
  }
  throw new Error(`unbalanced function ${name}`);
}

const main = stripComments(read(path.join(SRC, 'main.js')));

test('the strip carries the app icon immediately before the session title', () => {
  const html = read(path.join(UI, 'titlebar.html'));
  const icon = html.indexOf('id="icon"');
  const label = html.indexOf('id="label"');
  assert.ok(icon >= 0, 'titlebar.html has no icon');
  assert.ok(icon < label, 'the icon sits before the label, at the strip\'s start');
  const tag = /<img[^>]*id="icon"[^>]*>/.exec(html)?.[0] || '';
  assert.match(tag, /\bhidden\b/, 'hidden until the image arrives, so the strip never shows a broken-image box');
  assert.match(tag, /alt=""/, 'decorative to a screen reader: the label beside it already names the window');
});

test('the strip\'s CSP admits the icon as a data URL, and nothing wider', () => {
  const html = read(path.join(UI, 'titlebar.html'));
  const csp = /Content-Security-Policy"\s*content="([^"]*)"/.exec(html)?.[1] || '';
  assert.match(csp, /default-src 'none'/, 'the default stays closed');
  assert.match(csp, /img-src data:;/, 'the main process hands the icon in as data:');
  assert.ok(!/img-src[^;]*(\*|https?:|file:|'self')/.test(csp), 'no image source beyond data:');
});

test('the icon is out of the drag region and sized by chrome.js', () => {
  const css = read(path.join(UI, 'ui.css'));
  const rule = /\.strip__icon\s*\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(rule, /-webkit-app-region:\s*no-drag/,
    'a right click inside a drag region never reaches the page, so the menu would never open');
  assert.match(rule, /width:\s*var\(--strip-icon-size/);
  assert.match(rule, /height:\s*var\(--strip-icon-size/);
  assert.match(css, /\.strip__icon\[hidden\]\s*\{[^}]*display:\s*none/,
    'the hidden attribute has to win over the rule that sizes it');
  for (const platform of ['darwin', 'win32']) {
    assert.ok(flat(chrome.stripCss(platform)).includes(`--strip-icon-size: ${chrome.STRIP_ICON_PX}px`),
      `${platform}: the size has one owner`);
  }
});

test('the scripts the main process runs in the strip carry data, never code', () => {
  const hostile = '"); alert(1); ("';
  const shown = chrome.stripIconScript(hostile);
  assert.ok(shown.includes(JSON.stringify(hostile)), 'the URL is JSON-encoded');
  const hit = chrome.stripIconHitScript('1); alert(1', '2');
  assert.match(hit, /elementFromPoint\(0, 2\)/, 'a point that is not a number reads as 0');
  assert.match(hit, /closest\('#icon:not\(\[hidden\]\)'\)/, 'only the icon, and only once it is shown');
});

test('the tray and the strip icon open ONE menu', () => {
  const tray = fnBody(main, 'buildTray');
  assert.match(tray, /setContextMenu\(Menu\.buildFromTemplate\(trayMenuTemplate\(\)\)\)/,
    'the tray builds its menu from the shared template');
  assert.ok(!/label:/.test(tray), 'buildTray holds no menu items of its own');
  const strip = fnBody(main, 'onStripContextMenu');
  assert.match(strip, /chrome\.stripIconHitScript\(x, y\)/, 'the menu opens only on the icon');
  assert.match(strip, /Menu\.buildFromTemplate\(trayMenuTemplate\(\)\)\.popup\(\{ window: mainWindow \}\)/,
    'the strip pops up the tray\'s own template, built fresh');
  const create = fnBody(main, 'createStrip');
  assert.match(create, /wc\.on\('context-menu',[^;]*onStripContextMenu\(wc, params\)/,
    'the strip routes its right clicks to the handler');
});

test('the strip shows the icon chosen for the window, from the same choice', () => {
  const apply = fnBody(main, 'applyAppIcon');
  assert.match(apply, /const choice = appIcons\.choose\(/);
  assert.match(apply, /applyStripIcon\(appIcons\.iconFile\(choice\.bucket, choice\.mode, \{ full: true \}\)\)/,
    'the strip\'s file comes from the window\'s own choice, so the two cannot differ');
  const create = fnBody(main, 'createStrip');
  assert.match(create, /appliedStripIconFile = null;\s*applyAppIcon\(\);/,
    'a freshly loaded strip is given the icon, whatever the last document had');
  const show = fnBody(main, 'applyStripIcon');
  assert.match(show, /chrome\.stripIconScript\(url\)/);
});
