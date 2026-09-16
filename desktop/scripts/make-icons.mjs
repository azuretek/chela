// Rasterises the icon artwork into every platform's icon files.
//
// One mark, one generator, every platform. This file is the repo's icon
// pipeline rather than the desktop's: src/assets/claw.svg is read ONCE here and
// rasterised into the desktop's PNGs and into the iOS app icon, so the two
// cannot drift. Copying a bitmap from one platform to another would be a second
// owner of the artwork, and the two copies disagree the first time only one of
// them is regenerated. It lives under desktop/ because sharp does, which is the
// same arrangement desktop/scripts/build-version.js has, and the mobile release
// workflow already runs that one from this directory.
//
// Two sources, not one. src/assets/claw.svg is the application icon, a tile with
// a window and a title bar in it. src/assets/claw-tray.svg is the same mark with
// all of that removed, because at 16 physical pixels the frame and the title-bar
// dots turn to mush, and a filled dark square is the wrong shape to hang in a
// menu bar. Rendering one file at both sizes is what forces artwork to be timid
// at large sizes and illegible at small ones.
//
// The outputs are COMMITTED to the repo on purpose: sharp is the only heavy
// native dependency here, and baking the PNGs in keeps `npm start` and the
// Windows build working on a clean clone without it. The iOS icon has to be
// committed for a second reason: nothing in the mobile workflow runs npm, so a
// generated-only file would mean a build with no icon in it, which compiles,
// signs, exports and uploads without a warning and is rejected by App Store
// Connect. Re-run `npm run icons` only when the artwork changes.
//
// The two treatments, and why a platform gets one or the other:
//
//   canvas  The artwork as drawn: the tile, rounded, with the margin claw.svg
//           leaves around it, on transparent. This is the shape macOS wants,
//           and the tray artwork takes this treatment too.
//
//   square  A full-bleed opaque square of the same tile, which is what iOS
//           requires, and both halves of that are requirements rather than
//           taste. App Store Connect REJECTS an icon carrying an alpha channel,
//           and iOS applies its own corner mask to the icon it is given, so
//           shipping the tile's baked rounding unsquared produces a
//           double-rounded icon with transparent corners. The tile is cropped
//           to its own edges, its transparent corners are filled from the
//           artwork's own pixels, its wallpaper hairline is dropped, and its
//           alpha channel is removed. On screen the two platforms then look the
//           same, which is the point.
//
// Adding a platform is adding entries to `targets`. A tvOS or visionOS icon is
// a square of the same artwork in that platform's own asset catalog, at
// whatever size that platform asks for, so each becomes one entry naming its
// file and its size with no change to the rasterising below and no new
// treatment.
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // desktop/
const repo = path.dirname(root);                                            // the repo
const read = (p) => readFileSync(path.join(root, p));

const artwork = {
  app: read('src/assets/claw.svg'),
  tray: read('src/assets/claw-tray.svg'),
};

// One entry per file that ships. `file` is relative to the repo root rather
// than to desktop/, because a target can belong to another package and a path
// that says which one it is reads as one.
const targets = [
  // electron-builder derives .icns and .ico from this; it requires >= 512px.
  { file: 'desktop/build/icon.png', size: 1024, svg: artwork.app, treatment: 'canvas' },
  { file: 'desktop/src/assets/icon.png', size: 512, svg: artwork.app, treatment: 'canvas' },
  { file: 'desktop/src/assets/tray.png', size: 16, svg: artwork.tray, treatment: 'canvas' },
  { file: 'desktop/src/assets/tray@2x.png', size: 32, svg: artwork.tray, treatment: 'canvas' },

  // The iOS app icon, one 1024x1024 entry that Xcode derives every size the app
  // needs from, so there is no AppIcon60x60@2x.png to keep in step with
  // anything. The filename is the one AppIcon.appiconset/Contents.json names.
  {
    file: 'mobile/Claw/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png',
    size: 1024,
    svg: artwork.app,
    treatment: 'square',
  },
];

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// --------------------------------------------------------------------------
// How many pixels one SVG user unit is worth
// --------------------------------------------------------------------------

// The square treatment works in the artwork's own pixels, so this is the whole
// of its resolution: sharp renders the 120-unit viewBox at this many pixels per
// unit, and the tile is then measured in those pixels rather than in numbers
// copied out of the SVG. At 16 the canvas is 1920px and the tile inside claw.svg
// is 1600px across, which is well clear of the 1024 that ships.
const UNIT = 16;

// --------------------------------------------------------------------------
// The treatments
// --------------------------------------------------------------------------

// Each treatment owns how its output is written, so the loop below has nothing
// in it that knows about a platform.
const treatments = {
  canvas: async ({ svg, size }, file) => {
    // Rasterise at the final size rather than downsampling a large render: the
    // marks are shaped by their outline, and a 1024px render squeezed to 16px
    // loses the points at both ends of each one.
    await sharp(svg, { density: Math.max(72, size) })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(file);
  },

  square: async ({ svg, size }, file) => {
    writeFileSync(file, await squarePng(svg, size));
  },
};

// The full-bleed opaque square, in four steps: drop the edge hairline, isolate
// the tile, fill its corners, and hand the result a resize it cannot put any
// transparency back into.
async function squarePng(svg, size) {
  const mark = withoutEdgeHairline(svg);

  const canvas = await sharp(mark, { density: UNIT * 72 }).png().toBuffer();

  // Where the tile is, read off the artwork rather than written down here.
  // trim() drops the transparent margin claw.svg leaves around the tile, so
  // moving the tile inside the SVG moves this with it instead of cropping the
  // wrong rectangle. The crop is the tile exactly, not a little inside it: it is
  // the tile that is the icon, and nothing needs trimming off an edge whose
  // hairline has already gone.
  const tile = await sharp(canvas).trim().png().toBuffer();
  const { width, height } = await sharp(tile).metadata();
  if (width !== height) {
    fail(`the artwork's tile is ${width}x${height}, so it is not the square tile this treatment assumes`);
  }

  // Squared off at this resolution and resized afterwards, in this order on
  // purpose. Resizing first would resample the corner arc into a few pixels of
  // partial alpha just inside it, and those would then have to be repaired in
  // the shipped file; squared off first, the resize is handed an image with no
  // transparency in it at all, so the file that comes out of it cannot have any
  // either. That is the property App Store Connect checks, and it is worth
  // making structural rather than something to clean up at the end.
  const squared = await squareOffCorners(tile);

  const { data, info } = await sharp(squared)
    .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Asserted here rather than assumed, because this is the property Apple
  // checks and because removing the alpha channel is what would hide it: a
  // partly transparent pixel is composited against black when the channel goes,
  // so a stray one would ship as a dark speck rather than as a rejection.
  for (let i = 3; i < data.length; i += info.channels) {
    if (data[i] !== 255) {
      fail(`pixel ${(i - 3) / info.channels} is alpha ${data[i]} after the resize, so the icon is not opaque`);
    }
  }

  // removeAlpha is the other half of the guarantee, and it is not the same thing
  // as making every pixel opaque: an all-opaque image still HAS an alpha
  // channel, and a PNG carrying one is rejected by App Store Connect whatever is
  // in it. `sips -g hasAlpha` on the written file reads exactly this.
  return sharp(data, { raw: info }).removeAlpha().png().toBuffer();
}

// Drops the artwork's edge hairline, which is the one element that is about the
// tile having an edge at all: a 7% white stroke sitting on the inside of the
// tile's boundary, drawn to lift the tile off a dark wallpaper. An icon that
// fills its square has no edge for a hairline to sit on, and left in it reads as
// a faint outline down all four sides of the icon. Along the straight edges a
// tighter crop could get rid of it, but along the corners nothing can, because
// the hairline follows the arc and a square crop cannot cut a band that curls.
//
// Found by its own stroke-opacity rather than by position, and required to match
// exactly once: if the artwork stops drawing it or draws it differently this
// fails here, which is a loud line during `npm run icons` rather than a line
// through the corner of a shipped icon.
function withoutEdgeHairline(svg) {
  const markup = svg.toString('utf8');
  const hairline = /<rect\b[^>]*stroke-opacity="0\.07"[^>]*\/>/g;
  const found = markup.match(hairline) ?? [];
  if (found.length !== 1) {
    fail(`expected exactly one edge hairline (a rect with stroke-opacity 0.07) in the artwork, found ${found.length}`);
  }
  // A Buffer rather than a string: sharp reads a string as a filename.
  return Buffer.from(markup.replace(hairline, ''), 'utf8');
}

// Fills the artwork's transparent corners, which is what makes the result a
// square rather than a rounded tile, and it is the one piece of pixel work the
// square treatment needs.
//
// The tile is drawn with rounded corners and its clip path keeps the claw marks
// inside them, so the only thing outside a corner arc is the tile's background:
// a vertical gradient, one colour across every row of it. So the fill is not a
// colour chosen here, and not a background composited underneath, which would
// leave the rounded edge visible as a seam against it. Each row is run out to
// the icon's edge in the colour the tile already has at that row, which
// continues the gradient through the corner exactly.
//
// That colour is read as the row's most common value rather than taken from the
// tile's first opaque pixel, because the two agree only by assumption: the
// former is the colour that covers a row, and stays right if the artwork ever
// draws something that touches a corner arc.
//
// iOS masks the icon with its own corner radius, which falls within a hair of
// where the artwork's arc sits, so the pixels this fills are mostly covered on
// screen anyway. What it buys is an asset that is genuinely square and genuinely
// opaque, which is what an App Store upload requires.
async function squareOffCorners(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels !== 4) fail(`expected 4 channels to square off, got ${channels}`);

  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    // Fully opaque, not merely mostly: the pixels the rasteriser left partly
    // covered along the corner arc are the ones this has to fill as well.
    const opaque = (x) => data[row + x * channels + 3] === 255;

    let first = -1;
    for (let x = 0; x < width; x++) {
      if (opaque(x)) { first = x; break; }
    }
    let last = -1;
    for (let x = width - 1; x >= 0; x--) {
      if (opaque(x)) { last = x; break; }
    }
    if (first < 0) fail(`row ${y} of the tile has no opaque pixel in it, so the crop is not the tile`);
    if (first === 0 && last === width - 1) continue;   // no corner in this row

    // A transparent pixel between the two ends of a row would not be one of the
    // corners this fills: filling it would leave a hard-edged patch of whatever
    // colour sat under it, so it stops the run instead of being papered over.
    // The tile is convex and its marks are inside it, so this cannot happen; it
    // is here so that a future mark that punched a hole through the tile fails
    // loudly rather than shipping.
    for (let x = first; x <= last; x++) {
      if (data[row + x * channels + 3] === 0) {
        fail(`row ${y} of the tile is transparent at x=${x}, which is a hole in the tile rather than a corner`);
      }
    }

    const [r, g, b] = rowBackground(data, row, first, last, channels);
    for (let x = 0; x < first; x++) fillPixel(data, row, x, r, g, b, channels);
    for (let x = last + 1; x < width; x++) fillPixel(data, row, x, r, g, b, channels);
  }

  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

// The colour that covers a row of the tile: the most common value in it.
function rowBackground(data, row, first, last, channels) {
  const counts = new Map();
  for (let x = first; x <= last; x++) {
    const i = row + x * channels;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let best = 0;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return [(best >> 16) & 255, (best >> 8) & 255, best & 255];
}

function fillPixel(data, row, x, r, g, b, channels) {
  data[row + x * channels] = r;
  data[row + x * channels + 1] = g;
  data[row + x * channels + 2] = b;
  data[row + x * channels + 3] = 255;
}

// --------------------------------------------------------------------------
// Write, then read back what was written
// --------------------------------------------------------------------------

for (const target of targets) {
  const file = path.join(repo, target.file);
  mkdirSync(path.dirname(file), { recursive: true });
  await treatments[target.treatment](target, file);

  // Read the file back rather than trusting that writing it worked, the same
  // way the script this replaced did. Both of the things App Store Connect
  // refuses are properties of the file on disk rather than of the call that
  // wrote it: an icon that is the wrong size, and an icon carrying alpha.
  const written = await sharp(file).metadata();
  const alpha = written.hasAlpha ? 'alpha' : 'no alpha';
  console.log(`${target.file}  ${written.width}x${written.height}  ${alpha}  (${target.treatment})`);

  if (written.width !== target.size || written.height !== target.size) {
    fail(`${target.file} is ${written.width}x${written.height}, expected ${target.size}x${target.size}`);
  }
  if (target.treatment === 'square' && written.hasAlpha) {
    fail(`${target.file} carries an alpha channel, which App Store Connect rejects`);
  }
}
