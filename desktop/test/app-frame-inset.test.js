// The app frame inset, at the desktop's half.
//
// The wiring is two wires: the preload evaluates the shared bytes into the gateway
// page at document start, and main.js both serves them over the synchronous
// channel the preload reads and pushes new numbers from the layout pass when its
// own chrome moves. None of that can be unit-run here (one drives Electron
// windows, the other is a sandboxed preload), so the wires are asserted in the
// source, the same way the affordance's test and entry-guard.test.js assert
// theirs.
//
// The last test is the one that matters: it runs the bytes the channel actually
// returns against a document stand-in and asserts the frame binds. A guard that
// only greps for an import passes while the injection is inert.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installation, FRAME_INSET_MARKER, FRAME_INSET_PROPERTIES } from '../../core/app-frame-inset.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the desktop serves the shared frame bytes over the synchronous channel the preload reads', () => {
  const main = stripComments(readFileSync(path.join(SRC, 'main.js'), 'utf8'));
  assert.match(
    main,
    /import \* as appFrameInset from '\.\.\/\.\.\/core\/app-frame-inset\.js'/,
    'main.js installs the SHARED frame inset rather than a desktop-only copy',
  );
  assert.match(main, /appFrameInset\.installation\(frameInsets\(\)\)/, 'the bytes are composed from the shared module');
  assert.match(main, /ipcMain\.on\('frame:inset-script'/, 'the preload has a channel to read them from, synchronously');
  assert.match(
    main,
    /ipcMain\.on\('frame:injected'/,
    'and the installation is reported, because a silent non-installation is how this failed before',
  );
});

test('the preload evaluates them at document start, like the observer it sits beside', () => {
  const preload = stripComments(readFileSync(path.join(SRC, 'preload.cjs'), 'utf8'));
  assert.match(
    preload,
    /ipcRenderer\.sendSync\('frame:inset-script'\)/,
    'read synchronously: an async read lands after the page own first script, which is the frame the rule must precede',
  );
  assert.match(
    preload,
    /webFrame\.executeJavaScript\(frameScript\)/,
    'and evaluated into the page MAIN world, before the page has a document',
  );
  assert.match(preload, /ipcRenderer\.send\('frame:injected'/);
  const injection = preload.match(/if \(!isLocalPage\) \{[\s\S]*?\n\}/);
  assert.ok(injection, 'the remote-page branch is present');
  assert.ok(
    injection[0].includes('frame:inset-script'),
    'the frame script is read in that branch, not from somewhere that runs later',
  );
});

test('the frame follows the clients own chrome: pushed from the layout pass, only on a change', () => {
  const main = stripComments(readFileSync(path.join(SRC, 'main.js'), 'utf8'));

  assert.match(main, /function frameInsets\(\)/, 'the client computes its own numbers');
  assert.match(
    main,
    /bannerView && !bannerView\.webContents\.isDestroyed\(\) \? Math\.max\(0, bannerSize\.height\) : 0/,
    'the published band is the notice banner, the one piece of our chrome drawn over the page',
  );
  assert.match(main, /appFrameInset\.setStatement\(insets\)/, 'a move is pushed through the page setter');

  const layout = main.match(/function layoutViews\(\)[\s\S]*?\n\}/);
  assert.ok(layout, 'layoutViews is present');
  assert.ok(
    /publishFrameInsets\(\);/.test(layout[0]),
    'the push rides the layout pass, so a band appearing takes the published frame with it',
  );
  assert.match(
    main,
    /if \(key === lastFrameInsetKey\) return;/,
    'and it is skipped when nothing moved, because a resize fires that pass constantly',
  );
});

test('the bytes the channel returns actually bind the pages overlays to the frame', () => {
  const script = installation({ top: 59, bottom: 34 });

  const created = [];
  const root = {
    attributes: {},
    setAttribute(name) { this.attributes[name] = ''; },
    removeAttribute(name) { delete this.attributes[name]; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
    style: { props: {}, setProperty(name, value) { this.props[name] = value; } },
  };
  const document = {
    documentElement: root,
    head: { appendChild(node) { created.push(node); } },
    createElement() { return { attributes: {}, setAttribute(name) { this.attributes[name] = ''; }, textContent: '' }; },
  };

  new Function('window', 'document', script)({}, document);

  assert.equal(root.style.props[FRAME_INSET_PROPERTIES.top], '59px');
  assert.equal(root.style.props[FRAME_INSET_PROPERTIES.bottom], '34px');
  assert.ok(root.hasAttribute(FRAME_INSET_MARKER), 'the clamp is on for the page that needs it');
  assert.equal(created.length, 1, 'and the rule was actually appended to the document');
  assert.ok(
    created[0].textContent.includes(':root[' + FRAME_INSET_MARKER + '] openclaw-assistant-panel'),
    'naming the surface that was reported',
  );
});

