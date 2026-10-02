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
import { generatedFiles, appIcon, paperIcon, trayIcon, TILE } from '../scripts/artwork.mjs';
import { existsSync } from 'node:fs';
import { BUCKETS, iconFile, trayFile, palettesFor, choose } from '../../core/app-icons.js';

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
  for (const bucket of BUCKETS) {
    const trays = ['dark', 'light'].flatMap((mode) => [trayFile(bucket, mode), trayFile(bucket, mode).replace(/\.png$/, '@2x.png')]);
    const icons = [iconFile(bucket, 'dark'), iconFile(bucket, 'light'), iconFile(bucket, 'dark', { full: true }), iconFile(bucket, 'light', { full: true })];
    for (const rel of [...icons, ...trays]) {
      const file = path.join(repo, 'desktop', 'src', 'assets', rel);
      assert.ok(existsSync(file), `${file} is missing: run npm run icons`);
    }
  }
});

test('the edge-to-edge icons are the same drawing framed to the tile, with no margin', () => {
  // Windows and Linux draw an icon at the size of its square, so the macOS
  // margin round the tile only made the icon smaller there. The full icon is
  // framed to the tile's own rectangle and otherwise identical.
  const tile = `${TILE.x} ${TILE.y} ${TILE.size} ${TILE.size}`;
  for (const draw of [appIcon, paperIcon]) {
    const canvas = draw(), full = draw({ full: true });
    assert.match(canvas, /viewBox="0 0 120 120"/);
    assert.match(full, new RegExp(`viewBox="${tile}"`));
    assert.equal(full.replace(tile, '0 0 120 120'), canvas, 'the full icon changed more than its frame');
    assert.match(canvas, new RegExp(`<rect x="${TILE.x}" y="${TILE.y}" width="${TILE.size}" height="${TILE.size}"`), 'TILE no longer matches the drawn tile');
  }
});

test('Windows and Linux package the edge-to-edge icon, macOS the one on Apple\'s grid', () => {
  const yml = read('desktop/electron-builder.yml');
  // The section's own indented lines, up to the next top-level key.
  const iconOf = (section) => yml.match(new RegExp(`^${section}:\\n((?:[ #].*\\n|\\n)*)`, 'm'))?.[1].match(/^  icon: (\S+)/m)?.[1];
  assert.equal(iconOf('mac'), 'build/icon.png');
  assert.equal(iconOf('win'), 'build/icon.ico');
  assert.equal(iconOf('linux'), 'build/icon-full.png');
  assert.match(read('desktop/src/main.js'), /icon: process\.platform === 'linux' \? path\.join\(ASSETS, 'icon-full\.png'\)/);
  assert.match(read('desktop/src/main.js'), /appIcons\.choose\([^)]*full: appIcons\.fillsSquare\(process\.platform\)/);
});

test('the tray icon is the app icon, small: the same tile in the same palette, per mode', () => {
  // #114: the tray showed the bare claw, which read badly at tray size. It is the
  // app icon's own tile now, framed edge to edge like the full icon, in the
  // bucket's neon or paper palette, so it follows whichever icon is showing.
  for (const bucket of BUCKETS) {
    const p = palettesFor(bucket);
    const neon = trayIcon({ mode: 'dark', palette: p.dark });
    const paper = trayIcon({ mode: 'light', palette: p.light });
    for (const svg of [neon, paper]) {
      assert.match(svg, new RegExp(`viewBox="${TILE.x} ${TILE.y} ${TILE.size} ${TILE.size}"`), 'the tray is framed to the tile');
      assert.match(svg, new RegExp(`<rect x="${TILE.x}" y="${TILE.y}" width="${TILE.size}" height="${TILE.size}" rx="23"`), 'the tray carries the icon\'s tile');
    }
    // The tile's colours are the app icon's own, in that bucket and mode.
    assert.ok(neon.includes(p.dark.tileTop) && neon.includes(p.dark.tileBottom) && neon.includes(p.dark.coral), bucket.id + ' neon');
    assert.ok(paper.includes(p.light.skyTop) && paper.includes(p.light.deep), bucket.id + ' paper');
    assert.ok(appIcon({ palette: p.dark }).includes(p.dark.tileTop) && paperIcon({ palette: p.light }).includes(p.light.skyTop));
  }
  // Nothing under a pixel at 16 px: no hairline, no title-bar dots.
  assert.doesNotMatch(trayIcon(), /stroke-opacity="0\.07"|<circle/);
});

test('the tray follows the app icon\'s mode as well as its bucket', () => {
  const dark = choose('#ff5e62', 'dark'), light = choose('#ff5e62', 'light');
  assert.equal(dark.bucket.id, light.bucket.id);
  assert.notEqual(dark.tray, light.tray, 'one tray icon for both modes cannot match both app icons');
  assert.equal(dark.tray, trayFile(dark.bucket, 'dark'));
  assert.equal(light.tray, trayFile(light.bucket, 'light'));
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
