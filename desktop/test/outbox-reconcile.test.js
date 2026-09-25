// The outbox reconcile's desktop wiring: the preload evaluates the shared bytes
// into the gateway page at document start, over a synchronous channel main
// serves, and reports whether they ran. The script itself is tested in
// core/test/outbox-reconcile.test.js; this file asserts the two wires, the same
// way app-frame-inset.test.js asserts the frame's.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { reconcileScript } from '../../core/outbox-reconcile.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('main serves the shared reconcile bytes over the synchronous channel the preload reads', () => {
  const main = stripComments(readFileSync(path.join(SRC, 'main.js'), 'utf8'));
  assert.match(main, /import \* as outboxReconcile from '\.\.\/\.\.\/core\/outbox-reconcile\.js'/);
  assert.match(main, /ipcMain\.on\('outbox:reconcile-script', \(event\) => \{\s*event\.returnValue = outboxReconcile\.reconcileScript\(\);/);
  assert.match(main, /ipcMain\.on\('outbox:injected'/);
  assert.ok(reconcileScript().includes('__clawOutboxReconcile'), 'the bytes are the shared script');
});

test('the preload evaluates them into the gateway page at document start, and reports it', () => {
  const preload = stripComments(readFileSync(path.join(SRC, 'preload.cjs'), 'utf8'));
  const injection = preload.match(/if \(!isLocalPage\) \{[\s\S]*?\n\}/);
  assert.ok(injection, 'the remote-page injection block exists');
  assert.ok(injection[0].includes("ipcRenderer.sendSync('outbox:reconcile-script')"), 'read synchronously, inside the remote-page block only');
  assert.ok(injection[0].includes('webFrame.executeJavaScript(outboxScript)'));
  assert.ok(injection[0].includes("ipcRenderer.send('outbox:injected'"));
});
