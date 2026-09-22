import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installation, AFFORDANCE_GLOBAL, AFFORDANCE_CONFIG_GLOBAL } from '../../core/app-settings-affordance.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

// The desktop's half of the App-settings affordance is two wires: the gateway
// page gets the shared script installed into it (main.js), and the same page
// gets a one-call bridge exposed to answer the script's open() (preload.cjs).
// Both are edits to files that cannot be unit-run here (one drives Electron
// windows, the other is a sandboxed preload), so this asserts the wiring in the
// source, the same way entry-guard.test.js asserts the build guard.

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the desktop installs the shared affordance into the gateway page on dom-ready', () => {
  const main = stripComments(readFileSync(path.join(SRC, 'main.js'), 'utf8'));
  assert.match(
    main,
    /import \* as appSettingsAffordance from '\.\.\/\.\.\/core\/app-settings-affordance\.js'/,
    'main.js installs the SHARED affordance rather than a desktop-only copy',
  );
  assert.match(
    main,
    /appSettingsAffordance\.installation\(/,
    'main.js composes the affordance from the shared module',
  );
  assert.match(
    main,
    /installAppSettingsAffordance\(wc\)/,
    'the affordance is installed into the gateway page',
  );
  // Installed on the same event the client-context hook is, which is the one
  // that fires once the gateway page has a document.
  const domReady = main.match(/wc\.on\('dom-ready'[\s\S]*?\}\);/);
  assert.ok(domReady, 'the dom-ready handler is present');
  assert.match(domReady[0], /installAppSettingsAffordance\(wc\)/, 'the affordance is installed on dom-ready');
});

test('the preload exposes the open bridge on the REMOTE gateway page, not only local pages', () => {
  const preload = readFileSync(path.join(SRC, 'preload.cjs'), 'utf8');
  const stripped = stripComments(preload);

  // The bridge global the injected script calls.
  assert.match(
    stripped,
    new RegExp(`exposeInMainWorld\\('${AFFORDANCE_GLOBAL}'`),
    `the preload exposes window.${AFFORDANCE_GLOBAL} for the affordance`,
  );
  // It opens settings over the existing IPC, and does nothing else: no state to
  // read, nothing to write, so a remote page can do no more than the footer
  // control could.
  const bridgeBlock = stripped.match(
    new RegExp(`exposeInMainWorld\\('${AFFORDANCE_GLOBAL}',[\\s\\S]*?\\}\\);`),
  );
  assert.ok(bridgeBlock, 'the affordance bridge block is present');
  assert.match(bridgeBlock[0], /app:open-settings/, 'open() runs the open-settings IPC');
  assert.doesNotMatch(bridgeBlock[0], /app:save-settings|app:state|app:set-credentials/, 'the remote bridge exposes only open');

  // Critically, it is exposed OUTSIDE the `if (isLocalPage)` block, because the
  // gateway page is remote. The local-page block is where the full settings host
  // lives, and the affordance must not be limited to it.
  const gateIndex = stripped.indexOf('if (isLocalPage) {');
  const exposeIndex = stripped.indexOf(`exposeInMainWorld('${AFFORDANCE_GLOBAL}'`);
  assert.ok(gateIndex >= 0, 'the isLocalPage gate is present');
  assert.ok(exposeIndex >= 0 && exposeIndex < gateIndex, 'the affordance bridge is exposed before/outside the local-page gate');
});

test('the composed installation sets the config global, and never assigns the frozen bridge', () => {
  const out = installation({ label: 'App settings', tooltip: 'Chela settings' });
  assert.ok(out.includes(`window.${AFFORDANCE_CONFIG_GLOBAL} =`), 'the installation sets the config global');
  // The bridge global is a frozen contextBridge object on the desktop, so the
  // installation must never assign to it: that threw in the real renderer.
  assert.ok(!out.includes(`window.${AFFORDANCE_GLOBAL} =`), 'the installation never assigns the bridge global');
  // The desktop passes a label and tooltip; both reach the config.
  assert.ok(out.includes('App settings'), 'the label is carried into the page');
  assert.ok(out.includes('Chela settings'), 'the tooltip is carried into the page');
});
