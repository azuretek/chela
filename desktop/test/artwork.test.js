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
import { generatedFiles, appIcon, paperIcon, trayIcon, trayTemplate, TILE } from '../scripts/artwork.mjs';
import { existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { BUCKETS, iconFile, trayFile, palettesFor, choose, trayFor, trayIsTemplate, TRAY_TEMPLATE } from '../../core/app-icons.js';

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

test('the macOS tray is a template image, and the Windows and Linux trays are not', () => {
  // #139: macOS draws every menu-bar item as a one-colour glyph in the bar's own
  // colour, and the coloured tile was the one item that did not follow it.
  // Windows and Linux keep the coloured app icon, small (#114).
  const coloured = choose('#ff5e62', 'dark').tray;
  assert.deepEqual(trayFor('darwin', coloured), { file: TRAY_TEMPLATE, template: true });
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(trayFor(platform, coloured), { file: coloured, template: false }, platform);
    assert.equal(trayIsTemplate(platform), false, platform);
  }
  assert.equal(trayIsTemplate('darwin'), true);
  // The menu-bar glyph does not change with the icon choice or the theme (#132):
  // a template carries no colour for either to change.
  for (const bucket of BUCKETS) {
    for (const mode of ['dark', 'light']) assert.equal(trayFor('darwin', trayFile(bucket, mode)).file, TRAY_TEMPLATE);
  }
  // Electron also reads a name ending in Template as a template image, so the
  // file says what it is even where the flag is not set.
  assert.match(TRAY_TEMPLATE, /Template\.png$/);
});

test('main.js sets the tray image and its template flag from trayFor, on every path', () => {
  // The first image (trayImage) and every later swap (applyAppIcon) both draw
  // from trayFor, and the flag comes from it too, so no path can put the
  // coloured tile in the macOS menu bar or a template in the Windows tray.
  const main = read('desktop/src/main.js');
  const fn = (name) => {
    const body = main.slice(main.indexOf(`function ${name}()`));
    return body.slice(0, body.indexOf('\n}\n'));
  };
  for (const name of ['trayImage', 'applyAppIcon']) {
    const body = fn(name);
    assert.match(body, /appIcons\.trayFor\(process\.platform, /, name + ' does not ask trayFor what the tray draws');
    assert.match(body, /setTemplateImage\(\w+\.template\)/, name + ' does not set the template flag from trayFor');
  }
  assert.doesNotMatch(main, /setTemplateImage\((true|false)\)/, 'a tray image has a hard-coded template flag again');
});

// The RGBA pixels of an 8-bit, non-interlaced RGBA PNG, which is what the icon
// pipeline writes. Read here with zlib rather than sharp so the suite needs no
// native image library.
function pngPixels(file) {
  const buf = readFileSync(file);
  let at = 8, width = 0, height = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.deepEqual([data[8], data[9], data[12]], [8, 6, 0], `${file} is not 8-bit non-interlaced RGBA`);
    } else if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 4, px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= 4 && y ? px[(y - 1) * stride + x - 4] : 0;
      const pred = [0, a, b, (a + b) >> 1, (() => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })()][filter];
      px[y * stride + x] = (line[x] + pred) & 255;
    }
  }
  return { width, height, px };
}

test('the menu-bar glyph is the claw in alpha alone, at 16 pt with its @2x', () => {
  // macOS reads a template image's alpha and nothing else, so the glyph is black
  // on transparent: any colour in it is a sign it was drawn as something else.
  const svg = trayTemplate();
  assert.doesNotMatch(svg, /<rect|Gradient|url\(/, 'the glyph has a tile or a gradient in it');
  assert.deepEqual([...new Set(svg.match(/#[0-9a-fA-F]{3,8}\b/g))], ['#000000'], 'the glyph is drawn in more than one colour');
  for (const [rel, size] of [[TRAY_TEMPLATE, 16], [TRAY_TEMPLATE.replace(/\.png$/, '@2x.png'), 32]]) {
    const file = path.join(repo, 'desktop', 'src', 'assets', rel);
    assert.ok(existsSync(file), `${file} is missing: run npm run icons`);
    const { width, height, px } = pngPixels(file);
    assert.deepEqual([width, height], [size, size], rel);
    let covered = 0, opaque = 0;
    for (let i = 0; i < px.length; i += 4) {
      assert.deepEqual([px[i], px[i + 1], px[i + 2]], [0, 0, 0], `${rel} pixel ${i / 4} carries colour`);
      if (px[i + 3]) covered++;
      if (px[i + 3] === 255) opaque++;
    }
    // A claw, not an empty frame and not a filled square: measured 129 of 256
    // and 452 of 1024 pixels covered when this was written.
    assert.ok(covered > size * size * 0.25 && covered < size * size * 0.75, `${rel} covers ${covered} of ${size * size} pixels`);
    assert.ok(opaque > 0, rel + ' has no solid pixel');
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
