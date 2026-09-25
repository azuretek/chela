// A Windows .ico, written and read. No dependency: the format is a small
// directory of images, and the one thing that matters here is WHICH SIZES it
// holds.
//
// Why sizes are the whole point. The Windows shell does not scale an icon to
// the slot it draws: it picks the closest size the file holds, and for a slot
// the file has no image for it takes the next one DOWN and centres it. At 150%
// scaling the taskbar slot is 36 pixels, and the .ico electron-builder derived
// from a PNG held 16, 24, 32, 48, 64, 128 and 256, so the taskbar drew the 32
// in a 36 slot and the icon read smaller than every other app beside it
// (measured 2026-09-24: 30 pixels against its neighbours' 36). WINDOWS_SIZES is
// every size the shell asks for from 100% to 200% scaling, so each slot has an
// image of its own size.

/** Every icon size the Windows shell draws, 100% through 200% scaling: the small
 *  icon (16 at 100%), the taskbar and title bar (24), the large icon (32), the
 *  extra-large (48), and the jumbo view (256). */
export const WINDOWS_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256];

/** The sizes a live WINDOW icon is drawn at, 100% through 200% scaling: the
 *  title bar and taskbar (16 to 36) and the big icon Alt+Tab and the taskbar
 *  scale from (32 to 64). The themed icons main.js swaps in carry these, which
 *  keeps 26 of them small; the jumbo sizes only matter for the exe in Explorer. */
export const WINDOW_SIZES = WINDOWS_SIZES.filter((s) => s <= 64);

/**
 * An .ico from images of each size, as RGBA pixels.
 *
 * Below 256 each image is a 32-bit bitmap, the form every Windows icon loader
 * reads; 256 is a PNG, which is how Windows stores the jumbo size.
 *
 * @param {{size: number, rgba: Buffer, png: Buffer}[]} images
 */
export function encodeIco(images) {
  const sorted = [...images].sort((a, b) => a.size - b.size);
  const blobs = sorted.map(({ size, rgba, png }) => (size >= 256 ? png : bitmap(size, rgba)));
  const header = Buffer.alloc(6 + 16 * sorted.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sorted.length, 4);
  let offset = header.length;
  sorted.forEach(({ size }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(blobs[i].length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += blobs[i].length;
  });
  return Buffer.concat([header, ...blobs]);
}

function bitmap(size, rgba) {
  if (rgba.length !== size * size * 4) throw new Error(`a ${size}px icon needs ${size * size * 4} bytes of RGBA, got ${rgba.length}`);
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(size, 4);
  info.writeInt32LE(size * 2, 8);   // the colour image and its mask, stacked
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;   // bottom-up
    for (let x = 0; x < size; x++) {
      const s = src + x * 4, d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  // The 1-bit mask is all zero: the alpha channel above is what Windows reads.
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([info, pixels, mask]);
}

/**
 * The images an .ico holds: each entry's size, and for a bitmap entry its RGBA
 * pixels top-down. A PNG entry is returned as its bytes.
 */
export function decodeIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an .ico');
  const count = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    const size = buf.readUInt8(at) || 256;
    const length = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    const data = buf.subarray(offset, offset + length);
    if (data.subarray(0, 4).toString('latin1') === '\x89PNG') {
      out.push({ size, png: data });
      continue;
    }
    const w = data.readInt32LE(4);
    const bpp = data.readUInt16LE(14);
    if (w !== size || bpp !== 32) throw new Error(`entry ${i} is ${w}px at ${bpp} bits, expected ${size}px at 32`);
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      const src = 40 + (size - 1 - y) * size * 4;
      for (let x = 0; x < size; x++) {
        const s = src + x * 4, d = (y * size + x) * 4;
        rgba[d] = data[s + 2];
        rgba[d + 1] = data[s + 1];
        rgba[d + 2] = data[s];
        rgba[d + 3] = data[s + 3];
      }
    }
    out.push({ size, rgba });
  }
  return out;
}
