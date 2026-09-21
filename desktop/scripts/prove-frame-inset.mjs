// * Prove the app frame inset BOUNDS the page, and never moves an edge the page
// anchored for itself.
//
// Abi, 2026-09-21, on the iOS Claw client: "For some reason it's not going into
// the top area anymore, but things are going off the bottom of the screen now".
//
// Measured against the real Control UI at a 390x844 viewport with the frame
// published as top 59 / bottom 34 (the safe area of an iPhone 16 Pro), before the
// rule was corrected:
//   - the page's own viewport-height container ran 59 to 903. It is sized in dvh,
//     which is the DISPLAY, and the client insets the page's content by padding the
//     body, so the container started at the top inset and ended 59px past the
//     frame's bottom edge. Its block-end cluster, the composer, put its action row
//     at 810 to 846: 36px of it in the home-indicator band and its last 2px past
//     the display, cut off by the screen edge. That is the composer going off the
//     bottom, and it became visible the moment the panel stopped covering it.
//   - an overlay anchored by its TRAILING edge (a bottom-docked panel carrying its
//     own 420px height) was over-constrained by the rule's forced top, so CSS
//     resolved the box from its leading edge and reparented it to 59 to 479. The
//     depth it vacated revealed the page behind, and the panel no longer sat where
//     the reader docked it.
//
// So the rule takes the frame's edges with block-axis MARGINS, which inset a box
// without ever over-constraining one, and bounds the page's own viewport-height
// containers with the height cap alone, which is the half an in-flow box needs.
//
//   npx electron scripts/prove-frame-inset.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VIEW = { width: 390, height: 844, top: 59, bottom: 34 };
const DOCKED_HEIGHT = 420;
const FRAME_BOTTOM = VIEW.height - VIEW.bottom;
const EPSILON = 1;

// The page's shape at a phone viewport: a body inset by the safe area (what the
// client's standalone padding does), a root container sized in dvh against that
// padded box, a composer cluster at its block end, and the overlays the rule names.
// The heights are the ones the Control UI renders at this viewport.
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
  html, body { height: 100dvh; margin: 0; }
  body { box-sizing: border-box; padding: ${VIEW.top}px 0 ${VIEW.bottom}px; position: fixed; inset: 0; background: #faf9f5; }
  .shell { height: 100dvh; display: flex; flex-direction: column; }
  .transcript { flex: 1 1 auto; min-height: 0; }
  /* The cluster the page draws at its block end: the input row above, the action
     row last, so the action row is the box the display edge cuts first. */
  .composer { flex: 0 0 auto; display: flex; flex-direction: column; justify-content: flex-end; height: 105px; margin-bottom: var(--safe-area-bottom, 34px); background: #fff; }
  .actions { flex: 0 0 auto; height: 36px; background: rgb(0 0 0 / 6%); }
  .assistant-panel { position: fixed; left: 0; right: 0; background: rgb(0 0 0 / 8%); }
  .assistant-panel--right { top: 0; bottom: 0; }
  .assistant-panel--bottom { bottom: 0; height: ${DOCKED_HEIGHT}px; background: rgb(0 0 0 / 16%); }
</style></head><body>
  <div class="shell"><div class="transcript"></div><div class="composer"><div class="actions"></div></div></div>
  <section class="assistant-panel assistant-panel--right"></section>
  <section class="assistant-panel assistant-panel--bottom"></section>
</body></html>`;

const MEASURE = `(() => {
  const box = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
  };
  return {
    displayHeight: window.innerHeight,
    marked: document.documentElement.hasAttribute('data-claw-frame-inset'),
    sheet: !!document.querySelector('style[data-claw-frame-inset]'),
    shell: box('.shell'),
    composer: box('.composer'),
    actions: box('.actions'),
    rightPanel: box('.assistant-panel--right'),
    dockedPanel: box('.assistant-panel--bottom'),
  };
})()`;

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-frame-inset-'));

const failures = [];
const pass = (label) => console.log('OK   ' + label);
const fail = (label) => { console.log('FAIL ' + label); failures.push(label); };
const same = (a, b) => Math.abs(a - b) <= EPSILON;

function report(name, measured) {
  console.log('');
  console.log('-- ' + name + ' --');
  console.log('   ' + JSON.stringify(measured));
  return measured;
}

const cleanup = () => { try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} };

async function main({ app, BrowserWindow }) {
try {
  await app.whenReady();

  const window = new BrowserWindow({
    width: VIEW.width,
    height: VIEW.height,
    show: false,
    useContentSize: true,
  });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(FIXTURE));
  // The page's own safe-area tokens, which WebKit fills from the unsafe regions on
  // a real device and which this engine reports as zero.
  await window.webContents.executeJavaScript(
    'document.documentElement.style.setProperty("--safe-area-top","' + VIEW.top + 'px");'
    + 'document.documentElement.style.setProperty("--safe-area-bottom","' + VIEW.bottom + 'px");'
    + 'true',
  );

  // 1. BASELINE: nothing published, and the page runs past the display. The fault
  //    the frame exists for, reproduced here so the fix is measured against it.
  const baseline = report('baseline, no frame published', await window.webContents.executeJavaScript(MEASURE));
  if (baseline.shell.bottom > baseline.displayHeight + EPSILON) {
    pass('the page runs past the display (' + baseline.shell.bottom + ' > ' + baseline.displayHeight + '), so the fault is reproduced');
  } else {
    fail('the fixture does not reproduce the fault: the container ends at ' + baseline.shell.bottom);
  }
  if (baseline.actions.bottom > baseline.displayHeight) {
    pass("the page's own action row is past the display edge (" + baseline.actions.bottom + ' > ' + baseline.displayHeight + ')');
  } else {
    fail('the fixture leaves the action row on screen: ' + baseline.actions.bottom);
  }
  if (!baseline.marked && !baseline.sheet) pass('and nothing is bound while no frame is published');

  // 2. THE FRAME, in the spec's own bytes at the phone's numbers.
  const { installation } = await import('../../core/app-frame-inset.js');
  await window.webContents.executeJavaScript(installation({ top: VIEW.top, bottom: VIEW.bottom }) + ';true');
  const framed = report('frame published as top ' + VIEW.top + ' / bottom ' + VIEW.bottom, await window.webContents.executeJavaScript(MEASURE));
  if (framed.marked && framed.sheet) pass('the frame turns the rule on');
  else fail('the frame did not reach the page');

  if (same(framed.shell.top, VIEW.top) && same(framed.shell.bottom, FRAME_BOTTOM)) {
    pass('the page container is the frame (' + framed.shell.top + ' to ' + framed.shell.bottom + '), not the display');
  } else {
    fail('the page container is ' + framed.shell.top + ' to ' + framed.shell.bottom + ', expected ' + VIEW.top + ' to ' + FRAME_BOTTOM);
  }
  if (framed.composer.bottom <= FRAME_BOTTOM && framed.actions.bottom <= FRAME_BOTTOM) {
    pass("the page's own block-end cluster is inside the frame (the action row ends at " + framed.actions.bottom + ')');
  } else {
    fail("the page's own cluster is still past the frame: composer " + framed.composer.bottom + ', actions ' + framed.actions.bottom);
  }
  if (same(framed.rightPanel.top, VIEW.top) && same(framed.rightPanel.bottom, FRAME_BOTTOM)) {
    pass('a full-bleed overlay is the frame (' + framed.rightPanel.top + ' to ' + framed.rightPanel.bottom + ')');
  } else {
    fail('the full-bleed overlay is ' + framed.rightPanel.top + ' to ' + framed.rightPanel.bottom);
  }
  if (same(framed.dockedPanel.bottom, FRAME_BOTTOM) && same(framed.dockedPanel.height, DOCKED_HEIGHT)) {
    pass("a docked overlay keeps its own height and hangs at the frame's trailing edge (" + framed.dockedPanel.top + ' to ' + framed.dockedPanel.bottom + ')');
  } else {
    fail('the docked overlay is ' + framed.dockedPanel.top + ' to ' + framed.dockedPanel.bottom + ' at height ' + framed.dockedPanel.height
      + ', expected ' + (FRAME_BOTTOM - DOCKED_HEIGHT) + ' to ' + FRAME_BOTTOM + ' at ' + DOCKED_HEIGHT);
  }

  // 3. ZEROS: the desktop's case, where the page's view already excludes the chrome.
  //    The rule must be inert, and the setter a client pushes through must take the
  //    frame back off.
  await window.webContents.executeJavaScript('window.__clawFrameInset.set({ top: 0, bottom: 0 })');
  const zeroed = report('frame published as zeros', await window.webContents.executeJavaScript(MEASURE));
  if (!zeroed.marked) pass('zeros turn the rule back off');
  else fail('the rule is still on with nothing published');
  if (same(zeroed.shell.bottom, baseline.shell.bottom) && same(zeroed.dockedPanel.bottom, VIEW.height)) {
    pass('and every box is where the page put it again (container ' + zeroed.shell.bottom + ', docked ' + zeroed.dockedPanel.bottom + ')');
  } else {
    fail('a zeroed frame still moved a box: container ' + zeroed.shell.bottom + ', docked ' + zeroed.dockedPanel.bottom);
  }

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
  electron.app.setPath('userData', PROFILE);
  electron.app.commandLine.appendSwitch('user-data-dir', PROFILE);
  return main(electron);
}).catch((error) => { console.error(error); process.exit(1); });
