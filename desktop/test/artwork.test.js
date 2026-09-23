// The artwork has one owner, scripts/artwork.mjs, and every file that draws the
// claw is generated from it. These tests hold the generated files to that owner
// and the pages to the mark, so a hand edit to a generated file, or a page that
// goes back to an <img> the theme cannot reach, fails here rather than in a
// screenshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedFiles, appIcon, paperIcon } from '../scripts/artwork.mjs';
import { existsSync } from 'node:fs';
import { THEMES, iconFile } from '../../core/app-icons.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(repo, p), 'utf8');

test('every generated artwork file is committed exactly as the generator writes it', () => {
  for (const [file, text] of Object.entries(generatedFiles())) {
    assert.equal(read(file), text, `${file} differs from scripts/artwork.mjs's output: run npm run icons`);
  }
});

test('the application icon carries the one edge hairline the square treatment removes', () => {
  // make-icons.mjs's withoutEdgeHairline finds this by its stroke-opacity and
  // requires exactly one, so the icon pipeline fails if the artwork stops
  // drawing it or draws two.
  assert.equal(appIcon().match(/<rect\b[^>]*stroke-opacity="0\.07"[^>]*\/>/g)?.length, 1);
});

test('every themed icon the desktop can switch to ships under src/assets', () => {
  // main.js applyAppIcon loads these by the name core/app-icons.js gives, and a
  // missing one is refused at runtime rather than drawn, so it would never show.
  for (const theme of THEMES) {
    for (const mode of ['dark', 'light']) {
      const file = path.join(repo, 'desktop', 'src', 'assets', iconFile(theme.id, mode));
      assert.ok(existsSync(file), `${file} is missing: run npm run icons`);
    }
  }
});

test('the paper icon carries the one edge hairline too', () => {
  assert.equal(paperIcon().match(/<rect\b[^>]*stroke-opacity="0\.07"[^>]*\/>/g)?.length, 1);
});

test('main.js follows the theme with the app icon', () => {
  const main = read('desktop/src/main.js');
  // Both theme paths, the page's report and a gateway switch, and a new window.
  assert.ok((main.match(/applyAppIcon\(\);/g) || []).length >= 3, 'applyAppIcon is not called on every theme change');
});

test('the app pages draw the themed mark rather than an image of the icon', () => {
  // An <img> cannot see the page's custom properties, so a page that went back
  // to one would show the icon's fixed pink under every theme.
  for (const page of ['core/ui/loading.html', 'core/ui/about.html', 'core/ui/pairing.html']) {
    const html = read(page);
    assert.match(html, /<span class="chela-mark [\w-]+" aria-hidden="true"><span class="chela-mark__neon"><\/span><\/span>/, page);
    assert.doesNotMatch(html, /<img[^>]*assets\/claw\.svg/, page);
  }
});

test('ui.css imports the mark masks before any rule, where an @import still counts', () => {
  const css = read('core/ui/ui.css').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  assert.ok(css.startsWith('@import url(assets/claw-mark.css);'), 'the @import must be the first statement in ui.css');
});

test('the mark masks are data: URLs, which a file:// page can use as a mask', () => {
  // CSS fetches a mask image in CORS mode and a file:// page has an opaque
  // origin, so a url() to a file beside the page draws nothing on the desktop.
  const css = generatedFiles()['core/ui/assets/claw-mark.css'];
  for (const name of ['--chela-mark-ring', '--chela-mark-horizon']) {
    assert.match(css, new RegExp(`${name}: url\\("data:image/svg\\+xml,`), name);
  }
});
