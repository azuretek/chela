// Prove the app icon sits beside the session title on the title strip, and that a
// right click on it, and only on it, is what opens the tray's menu (#113).
//
// The strip is loaded from core/ui/titlebar.html with the geometry src/chrome.js
// injects, and the icon is handed in exactly as main.js does it: the bucket's
// edge-to-edge PNG, resized to twice the drawn size, as a data URL through
// chrome.stripIconScript. A right click is a real input event into the page, and
// the context-menu event it raises is answered with chrome.stripIconHitScript,
// the same question onStripContextMenu asks before it pops the menu up.
//
// What this cannot show is the OS half: that a right click inside a DRAG region
// never reaches the page on macOS and Windows. Linux draws no strip and honours no
// drag region, so the label is hit-testable here; the assertion is therefore that
// the hit test says "not the icon" for it, which is what keeps the menu closed
// wherever such a click does arrive.
//
// It also proves the CSP change is load-bearing: the same page with the strip's
// previous policy (no img-src) does not draw the icon at all.
//
//   npx electron scripts/prove-titlebar-icon.mjs [--shots DIR]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, '..', '..', 'core', 'ui');
const ASSETS = path.join(HERE, '..', 'src', 'assets');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-titlebar-icon-'));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-titlebar-csp-'));
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
const LABEL = 'Planning the week';

const failures = [];
const pass = (label) => console.log('OK   ' + label);
const fail = (label) => { console.log('FAIL ' + label); failures.push(label); };

const MEASURE = `(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  const icon = document.getElementById('icon');
  const label = document.getElementById('label');
  const strip = document.querySelector('.strip');
  return {
    hidden: icon.hidden,
    loaded: icon.complete && icon.naturalWidth > 0,
    natural: icon.naturalWidth,
    region: getComputedStyle(icon).getPropertyValue('-webkit-app-region') || getComputedStyle(icon).getPropertyValue('app-region'),
    icon: r(icon), label: r(label), strip: r(strip),
  };
})()`;


/**
 * Where the DRAWN pixels are, in one column band of a captured strip.
 *
 * Boxes are not the question and they are what hid the fault: `getBoundingClientRect`
 * on the label answers its line box, which the flex row centres perfectly, while the
 * GLYPHS inside it sit above that box centre because a font's ascent carries far more
 * room than its descender. So the label reads high and the icon, whose artwork fills
 * its box, reads low, with every rectangle agreeing. Abi, 2026-10-03: "the icon doesnt
 * look too low, the text actually looks like its too high". Measured from the bitmap,
 * the same way every other claim in this harness is: from what was drawn.
 */
function inkBand(image, band, background, scale) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const x0 = Math.max(0, Math.round(band.left * scale));
  const x1 = Math.min(size.width, Math.round(band.right * scale));
  let top = null;
  let bottom = null;
  // The strip's bottom edge is a 1px border and box-sizing keeps it inside the 36px,
  // so the last rows of the capture are the HAIRLINE, drawn edge to edge: left in the
  // scan, every band reports ink down to the strip's last row (measured 2026-10-04,
  // both bands bottoming at 36) and the centring is being asked about the border.
  const lastRow = Math.max(1, size.height - Math.ceil(2 * scale));
  for (let y = 1; y < lastRow; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * size.width + x) * 4;
      const distance = Math.abs(bitmap[i] - background.b) + Math.abs(bitmap[i + 1] - background.g) + Math.abs(bitmap[i + 2] - background.r);
      if (distance > 24) {
        if (top === null) top = y;
        bottom = y;
        break;
      }
    }
  }
  if (top === null) return null;
  return { top: top / scale, bottom: (bottom + 1) / scale, centre: (top + bottom + 1) / 2 / scale };
}

/**
 * The strip's background, as the most common colour on its top row.
 *
 * NOT a corner sample: the strip's bottom edge carries a 1px border hairline, so a
 * pixel taken near the bottom is the BORDER, and every pixel that is not the border
 * then scores as ink. Measured 2026-10-04: that made both bands report the same
 * bogus 24.5px centre and the assertion below passed while measuring nothing. The
 * background is whatever the widest row of the strip is mostly made of.
 */
function stripBackground(image) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const counts = new Map();
  const y = 2;
  for (let x = 0; x < size.width; x += 1) {
    const i = (y * size.width + x) * 4;
    const key = bitmap[i] + ',' + bitmap[i + 1] + ',' + bitmap[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const [key, count] of counts) if (count > bestCount) { bestCount = count; best = key; }
  const parts = best.split(',').map(Number);
  return { b: parts[0], g: parts[1], r: parts[2] };
}
const cleanup = () => {
  for (const dir of [PROFILE, SCRATCH]) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} }
};

/**
 * Load one pass into THE window and hand it back.
 *
 * One window for the whole run, because a window per pass does not work here: the pass
 * destroyed its window, and the NEXT pass then failed to load anything at all with
 * `ERR_FAILED (-2)`. Measured 2026-10-04 on two hosts, four runs, with the same shape
 * every time: dark/win32 completes end to end, and the next load dies. Nothing Electron
 * offers for a missing load fired (no did-fail-load, no render-process-gone), which is
 * what pointed at the app tearing down between windows rather than at the file.
 *
 * The CSS from the previous pass is removed by key, not left in place: the platform
 * padding differs (traffic lights against the edge), so a leftover stylesheet would be
 * measuring the pass before it.
 */
let insertedCss = null;
async function openStrip(window, file, platform, chrome) {
  if (insertedCss) {
    try { await window.webContents.removeInsertedCSS(insertedCss); } catch { /* the document is being replaced anyway */ }
    insertedCss = null;
  }  // Diagnostics for the second-pass failure: the load rejects with ERR_FAILED and
  // nothing else says why, so every signal Electron offers for a load that did not
  // happen is printed with the pass it happened on.
  const tag = platform + '/' + file.split('/').slice(-2).join('/');
  window.webContents.on('did-fail-load', (_e, code, desc, url) => console.log('     did-fail-load ' + code + ' ' + desc + ' ' + url));
  window.webContents.on('render-process-gone', (_e, details) => console.log('     render-process-gone ' + JSON.stringify(details)));
  window.on('closed', () => console.log('     window closed: ' + tag));
  console.log('     loading: ' + tag);
  await window.loadFile(file);
  insertedCss = await window.webContents.insertCSS(chrome.stripCss(platform));
  await window.webContents.executeJavaScript(`document.getElementById('label').textContent = ${JSON.stringify(LABEL)}; true`);
  return window;
}

/** A right click at (x, y), and the point the page's context-menu event reports. */
function rightClick(wc, x, y) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wc.removeListener('context-menu', on); resolve(null); }, 3000);
    function on(_event, params) { clearTimeout(timer); wc.removeListener('context-menu', on); resolve({ x: params.x, y: params.y }); }
    wc.on('context-menu', on);
    const at = { x: Math.round(x), y: Math.round(y), button: 'right', clickCount: 1 };
    wc.sendInputEvent({ type: 'mouseDown', ...at });
    wc.sendInputEvent({ type: 'mouseUp', ...at });
  });
}

async function main({ app, BrowserWindow, nativeImage, nativeTheme }) {
try {
  await app.whenReady();
  const { default: chrome } = await import('../src/chrome.js');
  const appIcons = await import('../../core/app-icons.js');

  // The file main.js would pick for the default theme, in both modes.
  // ONE window, created before any pass and destroyed once at the end.
  const window = new BrowserWindow({
    width: 720, height: chrome.STRIP_HEIGHT, show: true, useContentSize: true, frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  for (const mode of ['dark', 'light']) {
    const choice = appIcons.choose(undefined, mode, {});
    const file = appIcons.iconFile(choice.bucket, choice.mode, { full: true });
    const img = nativeImage.createFromPath(path.join(ASSETS, file));
    if (img.isEmpty()) { fail(mode + ': no asset at ' + file); continue; }
    const url = img.resize({ width: chrome.STRIP_ICON_PX * 2, height: chrome.STRIP_ICON_PX * 2, quality: 'best' }).toDataURL();

    // The strip palette IS `prefers-color-scheme`, and nativeTheme.themeSource is what
    // drives that for our own file:// pages (chrome.js pins it at startup for the same
    // reason). Without this the two `light` passes measured a DARK strip: measured
    // 2026-10-04, all four passes sampled a background of rgb(10,10,10), so half of this
    // harness asserted nothing about light at all.
    nativeTheme.themeSource = mode;
    for (const platform of ['win32', 'darwin']) {
      const tag = mode + '/' + platform + ': ';
      await openStrip(window, path.join(UI, 'titlebar.html'), platform, chrome);
      const wc = window.webContents;
      const before = await wc.executeJavaScript(MEASURE);
      if (before.hidden && before.icon.width === 0) pass(tag + 'the icon is hidden until the image arrives (no broken-image box)');
      else fail(tag + 'the icon shows before it has an image: ' + JSON.stringify(before.icon));

      await wc.executeJavaScript(chrome.stripIconScript(url));
      await wc.executeJavaScript('new Promise((r) => { const i = document.getElementById("icon"); i.complete ? r() : i.onload = i.onerror = r; })');
      const m = await wc.executeJavaScript(MEASURE);
      console.log('     ' + tag + JSON.stringify({ icon: m.icon, label: { left: m.label.left }, strip: m.strip.height, natural: m.natural, region: m.region }));
      if (m.loaded && m.natural === chrome.STRIP_ICON_PX * 2) pass(tag + 'the icon is drawn from the data URL (' + m.natural + 'px source)');
      else fail(tag + 'the icon did not load: ' + JSON.stringify({ loaded: m.loaded, natural: m.natural }));
      if (m.icon.width === chrome.STRIP_ICON_PX && m.icon.height === chrome.STRIP_ICON_PX) pass(tag + 'drawn at ' + chrome.STRIP_ICON_PX + 'px');
      else fail(tag + 'drawn at ' + m.icon.width + 'x' + m.icon.height);
      const pad = platform === 'darwin' ? chrome.MAC_CONTENT_INSET : 12;
      if (Math.abs(m.icon.left - pad) <= 0.5) pass(tag + 'at the strip\'s start, after ' + (platform === 'darwin' ? 'the traffic lights' : 'the edge padding') + ' (' + m.icon.left + 'px)');
      else fail(tag + 'the icon starts at ' + m.icon.left + ', expected ' + pad);
      if (m.label.left - m.icon.right === 8) pass(tag + 'immediately before the session title, 8px from it');
      else fail(tag + 'the label is ' + (m.label.left - m.icon.right) + 'px from the icon');
      const centre = (m.icon.top + m.icon.bottom) / 2;
      if (Math.abs(centre - (m.strip.height - 1) / 2) <= 1) pass(tag + 'vertically centred in the strip');
      else fail(tag + 'icon centre ' + centre + ' in a ' + m.strip.height + 'px strip');
      if (/no-drag/.test(m.region)) pass(tag + 'out of the drag region (' + m.region + ')');
      else fail(tag + 'the icon is in the drag region: ' + JSON.stringify(m.region));

      // The two must agree with EACH OTHER and with the strip, measured from the
      // pixels rather than from the boxes: this is the check whose absence let the
      // label read high beside a centred icon.
      // The frame must have PAINTED before anything is measured from pixels. Captured
      // too early the window answers with the frame from before the icon and the label
      // were drawn: the boxes are already correct, so the ink scan then reports the icon
      // as 10px tall inside a 16px box, or (once, on light/darwin) reports nothing drawn
      // at all and the centring is called unmeasurable. Measured 2026-10-04, same passes:
      // icon 14..24 with label 14..26 captured early, against icon 10..26 with label
      // 14..26 on the settled frame, which is the frame the layout is about. Two
      // animation frames and the fonts, because the label ink is the glyphs the font
      // draws rather than the line box that carries them.
      await wc.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
      await wc.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true');
      const shot = await wc.capturePage();
      const scale = shot.getSize().width / m.strip.width;
      const background = stripBackground(shot);
      const iconInk = inkBand(shot, m.icon, background, scale);
      const labelInk = inkBand(shot, m.label, background, scale);
      console.log('     ' + tag + 'ink ' + JSON.stringify({ icon: iconInk, label: labelInk, stripCentre: m.strip.height / 2 }));
      if (!iconInk || !labelInk) fail(tag + 'nothing was drawn in one of the two bands, so the centring cannot be measured');
      else if (Math.abs(iconInk.bottom - labelInk.bottom) <= 0.5) pass(tag + 'the text and the icon share a bottom edge (icon ' + iconInk.bottom + ', text ' + labelInk.bottom + ')');
      else fail(tag + 'the text bottom sits ' + (labelInk.bottom - iconInk.bottom).toFixed(2) + 'px off the icon bottom (icon ' + iconInk.bottom + ', text ' + labelInk.bottom + ')');

      // A right click on the icon is the menu; one on the label is not.
      const onIcon = await rightClick(wc, (m.icon.left + m.icon.right) / 2, (m.icon.top + m.icon.bottom) / 2);
      if (!onIcon) fail(tag + 'a right click on the icon raised no context-menu event');
      else if (await wc.executeJavaScript(chrome.stripIconHitScript(onIcon.x, onIcon.y))) pass(tag + 'a right click on the icon at (' + onIcon.x + ', ' + onIcon.y + ') is answered "the icon": the menu opens');
      else fail(tag + 'a right click on the icon was not recognised as the icon');
      const onLabel = await rightClick(wc, m.label.left + 20, (m.label.top + m.label.bottom) / 2);
      if (onLabel && !(await wc.executeJavaScript(chrome.stripIconHitScript(onLabel.x, onLabel.y)))) pass(tag + 'a right click on the label is answered "not the icon": no menu');
      else if (!onLabel) pass(tag + 'a right click on the label raised no event at all: no menu');
      else fail(tag + 'a right click on the label opens the menu');

      // A left click and a double click on the icon change nothing.
      const boundsBefore = JSON.stringify(window.getBounds());
      const at = { x: Math.round((m.icon.left + m.icon.right) / 2), y: Math.round((m.icon.top + m.icon.bottom) / 2), button: 'left' };
      for (const clickCount of [1, 2]) {
        wc.sendInputEvent({ type: 'mouseDown', ...at, clickCount });
        wc.sendInputEvent({ type: 'mouseUp', ...at, clickCount });
      }
      await new Promise((r) => setTimeout(r, 300));
      if (!window.isDestroyed() && window.isVisible() && !window.isMaximized() && JSON.stringify(window.getBounds()) === boundsBefore) pass(tag + 'a left click and a double click on the icon leave the window as it was');
      else fail(tag + 'a left click on the icon changed the window');

      if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        const shot = await wc.capturePage();
        const out = path.join(SHOTS, 'titlebar-icon-' + mode + '-' + platform + '.png');
        fs.writeFileSync(out, shot.toPNG());
        console.log('     shot: ' + out);
      }
    }
  }

  // The policy is load-bearing: the strip's previous CSP, with no img-src, draws no icon.
  // The directive is removed by PATTERN rather than by one literal spelling: the literal
  // depended on the meta tag's own spacing, which is not the rule, and it turned this
  // control into a throw instead of a test. Measured 2026-10-04, the first time all four
  // passes ran and this step was reached at all: "could not reconstruct the previous CSP".
  // Scoped to the META TAG, not the file: `img-src` appears twice, the policy and a
  // comment explaining the data URL, and a whole-file test threw on the comment the
  // first time this step ever ran (2026-10-04). The rule is about the policy.
  const original = fs.readFileSync(path.join(UI, 'titlebar.html'), 'utf8');
  const policy = (s) => ((s.match(/content="([^"]*default-src[^"]*)"/) || [])[1] || '');
  const before = policy(original);
  if (!/img-src/.test(before)) throw new Error('the strip CSP carries no img-src, so this control proves nothing');
  const html = original.replace(before, before.replace(/\s*img-src[^;]*;?/i, ''));
  if (html === original || /img-src/.test(policy(html))) throw new Error('could not reconstruct the previous CSP');
  fs.writeFileSync(path.join(SCRATCH, 'titlebar.html'), html);
  for (const f of ['ui.css', 'titlebar.js']) fs.copyFileSync(path.join(UI, f), path.join(SCRATCH, f));
  const choice = appIcons.choose(undefined, 'dark', {});
  const url = nativeImage.createFromPath(path.join(ASSETS, appIcons.iconFile(choice.bucket, 'dark', { full: true }))).resize({ width: 32, height: 32 }).toDataURL();
  await openStrip(window, path.join(SCRATCH, 'titlebar.html'), 'win32', chrome);
  await window.webContents.executeJavaScript(chrome.stripIconScript(url));
  await window.webContents.executeJavaScript('new Promise((r) => { const i = document.getElementById("icon"); i.complete ? r() : i.onload = i.onerror = r; })');
  const blocked = await window.webContents.executeJavaScript(MEASURE);
  if (!blocked.loaded) pass('control: under the previous CSP the same data URL is refused (naturalWidth ' + blocked.natural + ')');
  else fail('control: the previous CSP drew the icon too, so the policy change is not what makes it show');
  window.destroy();
} catch (error) {
  console.error(error);
  failures.push('the harness threw: ' + (error && error.message));
}

cleanup();
console.log('');
console.log(failures.length ? 'PROOF FAILED (' + failures.length + ')' : 'PROOF OK');
app.exit(failures.length ? 1 : 0);
}

// A module-level await would suspend Electron's own bootstrap, so the entry point
// returns and the work runs behind the ready handler.
import('electron').then((electron) => {
  // Destroying the harness's own window must not end the run: Electron quits when the
  electron.app.commandLine.appendSwitch('user-data-dir', PROFILE);
  return main(electron);
}).catch((error) => { console.error(error); process.exit(1); });
