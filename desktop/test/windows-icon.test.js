// The packaged Windows icon holds an image for every size the shell draws, and
// each one fills its square. See desktop/scripts/ico.mjs for why the sizes are
// the fix: a slot with no image of its own size gets the next one down, centred.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeIco, encodeIco, WINDOWS_SIZES } from '../scripts/ico.mjs';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url));
const builder = read('electron-builder.yml').toString('utf8');
const winIcon = builder.match(/^win:\n(?:[ \t].*\n|\n)*?[ \t]+icon:\s*(\S+)/m)?.[1];

test('the Windows build is packaged with our own multi-size .ico', () => {
  assert.equal(winIcon, 'build/icon.ico', 'win.icon must name the .ico: a PNG leaves electron-builder to pick the sizes, and it leaves out 20, 30, 36, 40 and the rest');
});

test('the .ico holds every size the Windows shell draws', () => {
  const sizes = decodeIco(read('build/icon.ico')).map((e) => e.size);
  assert.deepEqual(sizes, WINDOWS_SIZES);
  for (const s of [20, 24, 30, 36, 40, 48]) assert.ok(sizes.includes(s), `no ${s}px image: at that slot the shell would draw a smaller one`);
});

test('every size fills its square, so it is as big as the icons beside it', () => {
  for (const { size, rgba } of decodeIco(read('build/icon.ico'))) {
    if (!rgba) continue;
    const alpha = (x, y) => rgba[(y * size + x) * 4 + 3];
    const mid = size >> 1;
    for (const [x, y, edge] of [[0, mid, 'left'], [size - 1, mid, 'right'], [mid, 0, 'top'], [mid, size - 1, 'bottom']]) {
      assert.ok(alpha(x, y) > 200, `the ${size}px image is transparent at its ${edge} edge, so it is drawn smaller than its slot`);
    }
  }
});

test('an .ico round-trips through the encoder', () => {
  const rgba = Buffer.alloc(20 * 20 * 4, 0);
  rgba.writeUInt32BE(0x11223344, 0);
  const [back] = decodeIco(encodeIco([{ size: 20, rgba }]));
  assert.equal(back.size, 20);
  assert.deepEqual(back.rgba, rgba);
});
