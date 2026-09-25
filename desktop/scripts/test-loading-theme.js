'use strict';

// Prove that the loading cover starts in the resolved appearance, in both
// appearances, and that the Control UI which follows it agrees.
//
// The claim is about the STARTUP SEQUENCE rather than about either page on its
// own, and that is the whole reason this harness exists: a cover styled a
// moment after its first paint looks exactly like one styled before it in any
// screenshot taken once the app has settled. What has to be caught is the first
// frame that reaches the screen, so this samples the window from the moment it
// is revealed and compares three things:
//
//   - the cover's own resolved `--bg`, read out of the page;
//   - the pixels on screen, read out of the composited window, because a
//     stylesheet saying the right thing and the screen showing it are two
//     different facts;
//   - the Control UI's `--bg` once it arrives, which is what "no flip" means.
//
//   npx electron scripts/test-loading-theme.js --appearance dark --gateway URL [--shots DIR]
//
// `--gateway` is what the run connects to. A deliberately slow server holds the
// CONNECTING phase open so the cover is observable as a sequence rather than
// only as a frame; a real gateway is what shows the Control UI that follows it,
// and both runs make the same first-frame assertion.
//
// The profile is pinned BOTH ways, which is not tidiness: main.js decides
// whether a run is isolated from the `--user-data-dir` SWITCH rather than from
// the path, so a harness that set only the path runs on the real profile.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { app, BrowserWindow, desktopCapturer, webContents } from 'electron';

import { values } from '../../core/tokens.js';

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const APPEARANCE = flag('appearance', 'dark');
if (!['dark', 'light'].includes(APPEARANCE)) throw new Error(`unknown appearance ${APPEARANCE}`);
let GATEWAY = flag('gateway', '');
const SHOTS = flag('shots', null);
const HOLD_MS = Number(flag('hold', '5000'));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// A real server that accepts the connection and then sits on it before
// answering, which is what makes the cover observable at all: against a refused
// port the whole connect fails in milliseconds.
let holdServer = null;
if (!GATEWAY) {
  holdServer = http.createServer((_req, res) => {
    setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html data-openclaw-control-ui-build-id="harness"><title>Gateway</title>held'); }, HOLD_MS);
  });
  await new Promise((r) => holdServer.listen(0, '127.0.0.1', r));
  GATEWAY = `http://127.0.0.1:${holdServer.address().port}/`;
}

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-loading-theme-'));
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('user-data-dir', PROFILE);
fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Harness gateway', url: GATEWAY }],
  activeGatewayId: 'harness',
  // The stored appearance this cold start resolves to, which is what the cover
  // is supposed to be painted with: the app writes it from the page on every
  // run, so this is what "the last known appearance" means.
  themeMode: APPEARANCE,
}, null, 2)}\n`);

await import('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}
function note(text) { console.log(`note ${text}`); }

const loading = () => webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes('loading.html')) || null;
const gatewayPage = () => webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().startsWith('http')) || null;

const BG_OF = `getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`;
const PAINTED_OF = `getComputedStyle(document.body).backgroundColor`;

/** The colour the window itself is painted with, at a point the cover owns. */
function pixel(image, fx, fy) {
  const size = image.getSize();
  const x = Math.min(size.width - 1, Math.max(0, Math.round(size.width * fx)));
  const y = Math.min(size.height - 1, Math.max(0, Math.round(size.height * fy)));
  const bitmap = image.toBitmap(); // BGRA
  const i = (y * size.width + x) * 4;
  const hex = (n) => n.toString(16).padStart(2, '0');
  return `#${hex(bitmap[i + 2])}${hex(bitmap[i + 1])}${hex(bitmap[i])}`;
}

/** One composited frame of the window, which is the only place the truth is. */
async function capture(win) {
  const [width, height] = win.getContentSize();
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
  const mine = sources.find((s) => s.id === win.getMediaSourceId()) || sources.find((s) => /claw/i.test(s.name));
  if (!mine || mine.thumbnail.isEmpty()) return null;
  return mine.thumbnail;
}

const WATCHDOG_MS = 120000;
setTimeout(() => { console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`); app.exit(1); }, WATCHDOG_MS).unref();

app.whenReady().then(async () => {
  // The window is not this app's first act: startup clears a stale cache
  // before createMainWindow(), so a harness that asks for it here instead of
  // waiting gets "no window" on every run. Wait for it.
  let win = null;
  for (let i = 0; i < 60 && !win; i += 1) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await delay(250);
  }
  if (!win) { console.error('FAIL harness: no window'); app.exit(1); return; }

  const expected = values(APPEARANCE)['--bg'];
  const samples = [];
  let firstShot = null;
  let uiShot = null;

  // From the moment the window is on screen, every 250ms, for as long as the
  // cover is up and a little after it goes: the first sample is the frame the
  // fix is about, and the later ones are what "no flip" means.
  //
  // The window is captured only twice, and that is deliberate: desktopCapturer
  // is slow enough to stretch the loop past the sequence it is trying to catch
  // (measured: a capture per sample turned a 15s run into one that never
  // finished). The CSS is sampled on every tick, which is cheap, and the pixels
  // are read on the two frames that matter.
  for (let i = 0; i < 60; i += 1) {
    const cover = loading();
    const page = gatewayPage();
    const sample = {
      atMs: i * 250,
      windowVisible: win.isVisible(),
      cover: Boolean(cover),
      coverBg: cover ? await cover.executeJavaScript(BG_OF, true).catch(() => null) : null,
      coverPainted: cover ? await cover.executeJavaScript(PAINTED_OF, true).catch(() => null) : null,
      page: page ? page.getURL() : null,
      pageBg: page ? await page.executeJavaScript(BG_OF, true).catch(() => null) : null,
      pixel: null,
    };
    const wantCoverShot = !firstShot && sample.cover && win.isVisible();
    const wantUiShot = !uiShot && sample.pageBg && !sample.cover && win.isVisible();
    if (wantCoverShot || wantUiShot) {
      const image = await capture(win).catch(() => null);
      if (image) {
        sample.pixel = pixel(image, 0.12, 0.5);
        const file = path.join(SHOTS || os.tmpdir(), `${APPEARANCE}-${wantCoverShot ? '01-cover' : '02-control-ui'}.png`);
        fs.writeFileSync(file, image.toPNG());
        if (wantCoverShot) firstShot = file; else uiShot = file;
      }
    }
    samples.push(sample);
    if (uiShot && sample.pageBg) break;
    await delay(250);
  }

  const coverFrames = samples.filter((s) => s.cover && s.windowVisible);
  const first = coverFrames[0] || null;
  check('the cover paints at all, so the sequence is observable', Boolean(first), 'no visible frame with the cover up');
  if (first) {
    check(`the cover's first frame is already the resolved ${APPEARANCE} background`,
      first.coverBg === expected, `--bg ${first.coverBg}, expected ${expected}`);
    check('and the page paints that colour rather than only declaring it',
      first.coverPainted === rgbOf(expected), `body background ${first.coverPainted}, expected ${rgbOf(expected)}`);
    if (first.pixel) {
      check('and the pixels on screen are that colour, not just the CSS',
        first.pixel === expected, `screen ${first.pixel}, expected ${expected}`);
    }
  }

  // No frame of the cover may disagree with the first one: that would BE the
  // flip, caught in the act rather than inferred from the settled state.
  const drifting = coverFrames.filter((s) => s.coverBg !== expected);
  check('no frame of the cover is a different background from the first',
    drifting.length === 0, `${drifting.length} frame(s): ${drifting.map((s) => `${s.atMs}ms ${s.coverBg}`).join(', ')}`);

  const withPage = samples.filter((s) => s.pageBg);
  if (withPage.length) {
    check('the Control UI that follows the cover is the same background',
      withPage.every((s) => s.pageBg === expected || s.pageBg === '' ),
      `the Control UI painted ${withPage.map((s) => s.pageBg).join(', ')} against the cover's ${expected}`);
  } else {
    note('no Control UI arrived in this run, so the second half of the claim is the other run\'s');
  }

  console.log(`     samples: ${samples.length}, cover frames: ${coverFrames.length}, expected ${APPEARANCE} --bg ${expected}`);
  console.log(`     first frame: ${first ? `${first.coverBg} / ${first.coverPainted} / screen ${first.pixel}` : 'none'}`);
  if (firstShot) console.log(`     shot: ${firstShot}`);
  if (uiShot) console.log(`     shot: ${uiShot}`);
  fs.writeFileSync(path.join(SHOTS || os.tmpdir(), `${APPEARANCE}-loading-theme.json`), `${JSON.stringify({ appearance: APPEARANCE, gateway: GATEWAY, expected, samples }, null, 2)}\n`);

  fs.rmSync(PROFILE, { recursive: true, force: true });
  if (holdServer) holdServer.close();
  app.exit(failed ? 1 : 0);
});

/** `#rrggbb` as the `rgb(r, g, b)` a computed style answers with. */
function rgbOf(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  return `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})`;
}
