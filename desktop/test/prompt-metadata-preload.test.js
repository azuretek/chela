// The client-context hook desktop wiring: the preload evaluates the shared bytes
// into the gateway page at document start, over a synchronous channel main serves,
// and reports whether they ran.
//
// The hook itself, and every shape a rewind arrives in, is
// core/test/prompt-metadata.test.js's. This file asserts the two wires, the same
// way outbox-reconcile.test.js asserts the outbox's, because the install has to
// land before the page builds its socket. Measured 2026-10-01: rolling back to a
// message handed the composer the client-context block, sometimes, and dom-ready
// was the reason.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { CONTEXT_MARKER, clientScript, contextHeader } from '../../core/prompt-metadata.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('main serves the hook bytes over the synchronous channel the preload reads', () => {
  const main = stripComments(readFileSync(path.join(SRC, 'main.js'), 'utf8'));
  assert.match(
    main,
    /ipcMain\.on\('prompt-metadata:script', \(event\) => \{\s*event\.returnValue = promptMetadata\.clientScript\(promptMetadataConfig\(\)\);/,
  );
  assert.match(main, /ipcMain\.on\('prompt-metadata:injected'/);
  // And the late path is gone: dom-ready is after the page own script has run.
  const atDomReady = main.slice(main.indexOf('reachMilestone(progress.DOM)'));
  assert.ok(!atDomReady.slice(0, 400).includes('installPromptMetadata'), 'dom-ready must no longer install the hook');
});

test('the preload evaluates them into the gateway page at document start, and reports it', () => {
  const preload = stripComments(readFileSync(path.join(SRC, 'preload.cjs'), 'utf8'));
  const injection = preload.match(/if \(!isLocalPage\) \{[\s\S]*?\n\}/);
  assert.ok(injection, 'the remote-page injection block exists');
  assert.ok(injection[0].includes("ipcRenderer.sendSync('prompt-metadata:script')"), 'read synchronously, inside the remote-page block only');
  assert.ok(injection[0].includes('webFrame.executeJavaScript(metadataScript)'));
  assert.ok(injection[0].includes("ipcRenderer.send('prompt-metadata:injected'"));
});

test('the bytes are the shared script, with this client header', () => {
  const block = 'Desktop client context: ' + CONTEXT_MARKER + '\nhost: example-host';
  const script = clientScript({ enabled: true, block });
  assert.ok(script.includes('__clawPromptMetadata'), 'the shared global');
  assert.ok(script.includes(contextHeader('desktop')), 'the desktop header');
  assert.ok(script.includes('stripContextBlock'), 'the inbound boundary rides the same bytes both clients install');
});
