// The artwork has one owner, scripts/artwork.mjs, and every file that draws the
// claw is generated from it. These tests hold the generated files to that owner
// and the pages to the mark, so a hand edit to a generated file, or a page that
// goes back to an <img> the theme cannot reach, fails here rather than in a
// screenshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedFiles, appIcon, paperIcon, trayTemplate, TILE } from '../scripts/artwork.mjs';
import { inflateSync } from 'node:zlib';
import { BUCKETS, iconFile, choose, trayFor, trayIsTemplate, TRAY_TEMPLATE, TRAY_TEMPLATE_LIGHT } from '../../core/app-icons.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(repo, p), 'utf8');

test('every generated artwork file is committed exactly as the generator writes it', () => {
  for (const [file, text] of Object.entries(generatedFiles())) {
    assert.equal(read(file), text, file + " differs from scripts/artwork.mjs's output: run npm run icons");
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
    const icons = [iconFile(bucket, 'dark'), iconFile(bucket, 'light'), iconFile(bucket, 'dark', { full: true }), iconFile(bucket, 'light', { full: true })];
    for (const rel of icons) {
      const file = path.join(repo, 'desktop', 'src', 'assets', rel);
      assert.ok(existsSync(file), file + ' is missing: run npm run icons');
    }
  }
});

test('the tray art family this replaces is gone', () => {
  // #155: the tray drew a second, tiny drawing (icons/tray-<bucket>-<mode>.png)
  // beside the app's own icon, and the two disagreed. The whole family is
  // removed, so nothing can quietly come back as a third rendition.
  const iconsDir = path.join(repo, 'desktop', 'src', 'assets', 'icons');
  assert.ok(!readdirSync(iconsDir).some((n) => /^tray-/.test(n)), 'a per-bucket tray rendition is back under src/assets/icons');
  assert.ok(!existsSync(path.join(repo, 'desktop', 'src', 'assets', 'tray.png')), 'the generic tray.png is back');
  assert.ok(!existsSync(path.join(repo, 'core', 'ui', 'assets', 'claw-tray.svg')), 'core/ui/assets/claw-tray.svg is back');
});

test('the edge-to-edge icons are the same drawing framed to the tile, with no margin', () => {
  // Windows and Linux draw an icon at the size of its square, so the macOS
  // margin round the tile only made the icon smaller there. The full icon is
  // framed to the tile's own rectangle and otherwise identical.
  const tile = TILE.x + ' ' + TILE.y + ' ' + TILE.size + ' ' + TILE.size;
  for (const draw of [appIcon, paperIcon]) {
    const canvas = draw(), full = draw({ full: true });
    assert.match(canvas, /viewBox="0 0 120 120"/);
    assert.match(full, new RegExp('viewBox="' + tile + '"'));
    assert.equal(full.replace(tile, '0 0 120 120'), canvas, 'the full icon changed more than its frame');
    assert.match(canvas, new RegExp('<rect x="' + TILE.x + '" y="' + TILE.y + '" width="' + TILE.size + '" height="' + TILE.size + '"'), 'TILE no longer matches the drawn tile');
  }
});

test('Windows and Linux package the edge-to-edge icon, macOS the one on Apple' + String.fromCharCode(39) + 's grid', () => {
  const yml = read('desktop/electron-builder.yml');
  // The section's own indented lines, up to the next top-level key.
  const iconOf = (section) => yml.match(new RegExp('^' + section + ':\\n((?:[ #].*\\n|\\n)*)', 'm'))?.[1].match(/^  icon: (\S+)/m)?.[1];
  assert.equal(iconOf('mac'), 'build/icon.png');
  assert.equal(iconOf('win'), 'build/icon.ico');
  assert.equal(iconOf('linux'), 'build/icon-full.png');
  assert.match(read('desktop/src/main.js'), /icon: process\.platform === 'linux' \? path\.join\(ASSETS, 'icon-full\.png'\)/);
  assert.match(read('desktop/src/main.js'), /appIcons\.choose\([^)]*full: appIcons\.fillsSquare\(process\.platform\)/);
});

test('the icon choice resolves the window, the Dock and the tray through ONE call', () => {
  // #155: the tray no longer has a file of its own. It draws the app's own icon,
  // chosen here and read by main.js applyAppIcon for the strip and the tray alike.
  const dark = choose('#ff5e62', 'dark'), light = choose('#ff5e62', 'light');
  assert.equal(dark.bucket.id, light.bucket.id);
  assert.equal(dark.file, iconFile(dark.bucket, 'dark'));
  assert.equal(light.file, iconFile(light.bucket, 'light'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dark, 'tray'), 'choose() hands back a separate tray file again');
});

test('the macOS tray is a template image, and Windows and Linux draw the app icon', () => {
  // #139: macOS draws every menu-bar item as a one-colour glyph in the bar's own
  // colour. Windows and Linux draw the app's own edge-to-edge icon, the same file
  // the strip draws (#155), which is not a template.
  const full = iconFile(BUCKETS[0], 'dark', { full: true });
  assert.deepEqual(trayFor('darwin', full), { file: TRAY_TEMPLATE, template: true });
  assert.deepEqual(trayFor('darwin', full, { darkBar: false }), { file: TRAY_TEMPLATE_LIGHT, template: true });
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(trayFor(platform, full), { file: full, template: false }, platform);
    assert.equal(trayIsTemplate(platform), false, platform);
  }
  assert.equal(trayIsTemplate('darwin'), true);
  // Electron also reads a name ending in Template as a template image, so the
  // file says what it is even where the flag is not set.
  assert.match(TRAY_TEMPLATE, /Template\.png$/);
});

test('main.js sets the tray image and its template flag from trayFor, on every path', () => {
  // The first image (trayImage) and every later swap (applyAppIcon) both draw
  // from trayFor, and the flag comes from it too, so no path can put a template
  // in the Windows tray or a coloured file in the macOS menu bar.
  const main = read('desktop/src/main.js');
  const fn = (name) => {
    const body = main.slice(main.indexOf('function ' + name + '()'));
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
      assert.deepEqual([data[8], data[9], data[12]], [8, 6, 0], file + ' is not 8-bit non-interlaced RGBA');
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

test('the menu-bar glyphs are one-colour templates at 16 pt with their @2x', () => {
  // macOS reads a template image's alpha and nothing else, so every glyph is
  // black on transparent: any colour in it is a sign it was drawn as something
  // else. Both cuts carry the tile, so both cover most of the frame.
  for (const appearance of ['dark', 'light']) {
    const svg = trayTemplate({ appearance });
    // Only black ink and the white the mask shows through with: a template is
    // painted by the bar, so any other colour is a sign it was drawn as something else.
    assert.deepEqual([...new Set(svg.match(/#[0-9a-fA-F]{3,8}\b/g))].sort(), ['#000000', '#ffffff'], appearance + ' cut carries a colour other than the mask black and white');
    assert.match(svg, /<rect/, appearance + ' cut has no tile');
    assert.match(svg, /mask=/, appearance + ' cut does not cut the claw out of its tile');
  }
  const files = [[TRAY_TEMPLATE, 16], [TRAY_TEMPLATE.replace(/\.png$/, '@2x.png'), 32], [TRAY_TEMPLATE_LIGHT, 16], [TRAY_TEMPLATE_LIGHT.replace(/\.png$/, '@2x.png'), 32]];
  for (const [rel, size] of files) {
    const file = path.join(repo, 'desktop', 'src', 'assets', rel);
    assert.ok(existsSync(file), file + ' is missing: run npm run icons');
    const { width, height, px } = pngPixels(file);
    assert.deepEqual([width, height], [size, size], rel);
    let covered = 0;
    for (let i = 0; i < px.length; i += 4) {
      assert.deepEqual([px[i], px[i + 1], px[i + 2]], [0, 0, 0], rel + ' pixel ' + (i / 4) + ' carries colour');
      if (px[i + 3]) covered++;
    }
    // Measured when this was written: 252 of 256 (dark) and 222 (light) at 16px,
    // 989 and 832 at 32px. Both are the tile, so both cover most of the frame.
    assert.ok(covered > size * size * 0.7 && covered < size * size, rel + ' covers ' + covered + ' of ' + (size * size) + ' pixels');
  }
});

test('the menu-bar glyph is cut twice, and the two cuts are not the same shape', () => {
  // Abi, 2026-10-04: "Two cut shapes if possible for the tray icon", then, on the
  // candidates, "light mode perfect, dark mode weight 4 is the winner". A template
  // image is painted BY the bar, so the cut is the whole difference: the light cut
  // removes the claw from the tile whole, the dark one cuts it as a weight-4
  // outline. Measured on the DRAWN PNGs, never read back from the SVG.
  const light = trayTemplate({ appearance: 'light' });
  assert.match(light, /<rect/, 'the light cut has no tile for the claw to be cut out of');
  assert.match(light, /mask=/, 'the light cut does not cut anything out');
  const dark = trayTemplate();
  assert.match(dark, /<rect/, 'the dark cut grew no tile');
  assert.match(dark, /mask=/, 'the dark cut does not cut anything out');
  assert.match(dark, /stroke-width="4"/, 'the dark cut is not the weight Abi picked');
  // Enclosed clear pixels: a region the bar shows through that ink surrounds. The
  // claw cut out of the tile is one; the space round a bare claw is not, because it
  // reaches the edge of the image. This is what tells a CUT from a shape.
  const holes = (px, size) => {
    const clear = (x, y) => px[(y * size + x) * 4 + 3] === 0;
    const seen = new Uint8Array(size * size);
    const stack = [];
    for (let x = 0; x < size; x++) for (const y of [0, size - 1]) if (clear(x, y) && !seen[y * size + x]) { seen[y * size + x] = 1; stack.push([x, y]); }
    for (let y = 0; y < size; y++) for (const x of [0, size - 1]) if (clear(x, y) && !seen[y * size + x]) { seen[y * size + x] = 1; stack.push([x, y]); }
    while (stack.length) {
      const [x, y] = stack.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (seen[ny * size + nx] || !clear(nx, ny)) continue;
        seen[ny * size + nx] = 1; stack.push([nx, ny]);
      }
    }
    let n = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (clear(x, y) && !seen[y * size + x]) n += 1;
    return n;
  };
  const at = (rel, size) => {
    const file = path.join(repo, 'desktop', 'src', 'assets', rel);
    assert.ok(existsSync(file), rel + ' is missing: run npm run icons');
    const { width, height, px } = pngPixels(file);
    assert.deepEqual([width, height], [size, size], rel);
    for (let i = 0; i < px.length; i += 4) assert.deepEqual([px[i], px[i + 1], px[i + 2]], [0, 0, 0], rel + ' carries colour at pixel ' + (i / 4));
    let ink = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] === 255) ink += 1;
    return { ink, holes: holes(px, size) };
  };
  for (const size of [16, 32]) {
    const suffix = size === 16 ? '.png' : '@2x.png';
    const d = at(TRAY_TEMPLATE.replace(/\.png$/, suffix), size);
    const l = at(TRAY_TEMPLATE_LIGHT.replace(/\.png$/, suffix), size);
    // Measured when this was written (16px, then 32px): the dark cut inks 150 and
    // 749, the light cut 144 and 673, and the claw hole the light cut leaves is 30
    // and 160 clear pixels against the dark cut's outline groove at 0 and 3.
    assert.ok(d.ink > l.ink, 'the dark cut is no fuller than the light: ' + d.ink + ' against ' + l.ink);
    assert.ok(l.holes > d.holes, "the light cut's claw hole is not larger than the dark cut's groove: " + l.holes + ' against ' + d.holes);
    assert.ok(d.ink > 0, 'the dark cut has no solid pixel at ' + size + 'px');
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
    assert.match(css, new RegExp(name + ': url\\("data:image/svg\\+xml,'), name);
  }
});
