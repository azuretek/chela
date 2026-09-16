// The App-settings affordance: the ONE injected script that adds a control to
// the Control UI's sidebar footer and opens the app's own settings surface.
//
// A fixture cannot carry the behaviour this asserts: that the script is ONE file
// rather than a copy per client, that it places the control in the footer and
// falls back defensively when the footer is gone, that it FAILS SOFT rather than
// throwing into a page it does not own, and that its click reaches the client's
// bridge without reimplementing settings. The script runs in a page, so this
// drives it against a minimal DOM stub, the same way prompt-metadata's test runs
// its hook against a fake WebSocket.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AFFORDANCE_GLOBAL, AFFORDANCE_CONFIG_GLOBAL, AFFORDANCE_MARKER, AFFORDANCE_ANCHORS,
  affordanceSource, configStatement, installation,
} from '../app-settings-affordance.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const SPEC_PATH = path.join(REPO, 'core', 'spec', 'app-settings-affordance.json');
const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));

/* ------------------------------------------------------------- a minimal DOM */

// Just enough of a DOM for the script: elements with a class list, children,
// attributes, an id, a style with setProperty, event listeners with dispatch,
// and a document with querySelector over a flat registry. Deliberately small,
// so the harness itself is readable and cannot hide a false pass.
function makeDom({ selectors = [] } = {}) {
  const registry = [];

  function makeElement(tag) {
    const listeners = {};
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      children: [],
      attributes: {},
      classNames: [],
      id: '',
      innerHTML: '',
      textContent: '',
      title: '',
      style: {
        props: {},
        setProperty(name, value) { this.props[name] = value; },
        getPropertyValue(name) { return this.props[name] || ''; },
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
      appendChild(child) { this.children.push(child); child.parent = this; registry.push(child); return child; },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      dispatch(type, event = {}) { (listeners[type] || []).forEach((fn) => fn(event)); },
      matches(selector) { return (this._selectors || []).includes(selector); },
      querySelector() { return null; },
    };
    return el;
  }

  const anchorElements = new Map();
  for (const selector of selectors) {
    const el = makeElement('div');
    el._selectors = [selector];
    anchorElements.set(selector, el);
    registry.push(el);
  }

  const documentElement = makeElement('html');
  registry.push(documentElement);

  const document = {
    readyState: 'complete',
    documentElement,
    _domListeners: {},
    createElement: (tag) => makeElement(tag),
    addEventListener(type, fn) { (this._domListeners[type] = this._domListeners[type] || []).push(fn); },
    dispatch(type, event = {}) { (this._domListeners[type] || []).forEach((fn) => fn(event)); },
    // Match against the marker attribute or a known anchor selector. A comma
    // list is tried left to right, which is what the sidebar fallback uses.
    querySelector(selector) {
      const attr = /^\[(.+?)\]$/.exec(selector.trim());
      if (attr) {
        return registry.find((el) => el.getAttribute && el.getAttribute(attr[1].split('=')[0]) !== null) || null;
      }
      for (const part of selector.split(',').map((s) => s.trim())) {
        if (anchorElements.has(part)) return anchorElements.get(part);
      }
      return null;
    },
  };

  const observers = [];
  class MutationObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    trigger() { this.cb([]); }
  }

  return { document, MutationObserver, anchorElements, registry, observers };
}

function run(dom, { open, frozenBridge = false } = {}) {
  const bridge = { open: open || (() => {}) };
  const window = {};
  const context = {
    window,
    document: dom.document,
    MutationObserver: dom.MutationObserver,
    console: { debug() {} },
  };
  // The bridge is on its own global. `frozenBridge` reproduces the desktop's
  // contextBridge case: a non-writable, frozen property the script must never
  // assign to. The config goes on the SEPARATE plain global.
  if (frozenBridge) {
    Object.defineProperty(window, AFFORDANCE_GLOBAL, { value: Object.freeze(bridge), writable: false, configurable: false });
  } else {
    window[AFFORDANCE_GLOBAL] = bridge;
  }
  vm.runInNewContext(`${configStatement({ label: 'App settings' })}\n${affordanceSource()}`, context);
  return { window, context };
}

function affordanceButton(dom) {
  return dom.registry.find((el) => el.getAttribute && el.getAttribute(AFFORDANCE_MARKER) !== null) || null;
}

/* -------------------------------------------------------------- the exports */

test('the module exposes the spec is the one owner of the script', () => {
  assert.strictEqual(AFFORDANCE_GLOBAL, spec.global);
  assert.strictEqual(AFFORDANCE_CONFIG_GLOBAL, spec.configGlobal);
  assert.strictEqual(AFFORDANCE_MARKER, spec.marker);
  assert.deepStrictEqual(AFFORDANCE_ANCHORS, spec.anchors);
  assert.strictEqual(affordanceSource(), spec.script.join('\n'));
});

test('installation composes the config statement then the script', () => {
  const out = installation({ label: 'App settings' });
  assert.ok(out.includes(`window.${spec.configGlobal}`), 'the config sets the CONFIG global the script reads');
  assert.ok(out.endsWith(affordanceSource()), 'the script is appended verbatim after the config');
});

test('the config statement writes the config global, never the bridge global', () => {
  // The bridge global may be a frozen contextBridge object on the desktop, so the
  // config must land on its own plain global and never assign to the bridge.
  const statement = configStatement({ label: 'App settings' });
  assert.ok(statement.startsWith(`window.${spec.configGlobal} =`), 'the config targets the config global');
  assert.ok(!statement.includes(`window.${spec.global} =`), 'the config never assigns to the bridge global');
});

test('the script does not throw against a FROZEN contextBridge bridge global', () => {
  // This is the desktop case that failed in the real renderer: a frozen,
  // non-writable window.__clawAppSettings. The script must read it and never
  // assign to it.
  const dom = makeDom({ selectors: [spec.anchors.primary] });
  let opened = 0;
  assert.doesNotThrow(() => {
    run(dom, { open: () => { opened += 1; }, frozenBridge: true });
    dom.document.dispatch('DOMContentLoaded');
  }, 'the script must not assign to the frozen bridge object');
  const button = affordanceButton(dom);
  assert.ok(button, 'the control was still placed');
  button.dispatch('click', { preventDefault() {}, stopPropagation() {} });
  assert.strictEqual(opened, 1, 'the frozen bridge was read and its open() called');
});

/* --------------------------------------------------------------- placement */

test('the control is placed in the footer actions, beside the gateway settings control', () => {
  const dom = makeDom({ selectors: [spec.anchors.primary] });
  run(dom);
  dom.document.dispatch('DOMContentLoaded');
  const actions = dom.anchorElements.get(spec.anchors.primary);
  const button = affordanceButton(dom);
  assert.ok(button, 'a control was placed');
  assert.strictEqual(button.parent, actions, 'the control sits in the footer actions row');
  assert.strictEqual(button.getAttribute('aria-label'), 'App settings');
});

test('the control falls back to the footer bar when the actions row is gone', () => {
  const dom = makeDom({ selectors: [spec.anchors.footer] });
  run(dom);
  dom.document.dispatch('DOMContentLoaded');
  const footer = dom.anchorElements.get(spec.anchors.footer);
  const button = affordanceButton(dom);
  assert.ok(button, 'a control was placed on the fallback');
  assert.strictEqual(button.parent, footer, 'the control sits in the footer bar');
});

test('the control falls back to a sidebar corner when the whole footer is gone', () => {
  const sidebarSelector = spec.anchors.sidebar.split(',')[0].trim();
  const dom = makeDom({ selectors: [sidebarSelector] });
  run(dom);
  dom.document.dispatch('DOMContentLoaded');
  const button = affordanceButton(dom);
  assert.ok(button, 'a control was placed in the last-resort corner');
  assert.strictEqual(button.style.getPropertyValue('position'), 'absolute', 'the corner control is positioned');
});

test('clicking the control calls the client bridge and opens nothing itself', () => {
  const dom = makeDom({ selectors: [spec.anchors.primary] });
  let opened = 0;
  run(dom, { open: () => { opened += 1; } });
  dom.document.dispatch('DOMContentLoaded');
  const button = affordanceButton(dom);
  let prevented = false;
  button.dispatch('click', { preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.strictEqual(opened, 1, 'the click reached the client bridge exactly once');
  assert.ok(prevented, 'the click does not fall through to the page');
});

test('the page-side fallback route opens settings without any injected node', () => {
  // config.openAppSettings is set even before placement, so app settings is
  // reachable when the footer is never found. This is the page half of the
  // fail-soft promise; the client also has a native route of its own.
  const dom = makeDom({ selectors: [] });
  let opened = 0;
  const { window } = run(dom, { open: () => { opened += 1; } });
  dom.document.dispatch('DOMContentLoaded');
  assert.strictEqual(affordanceButton(dom), null, 'no control was placed, because no anchor matched');
  // The fallback route is on the config global, which is writable even when the
  // bridge global is frozen.
  assert.strictEqual(typeof window[AFFORDANCE_CONFIG_GLOBAL].openAppSettings, 'function', 'the fallback route exists');
  window[AFFORDANCE_CONFIG_GLOBAL].openAppSettings();
  assert.strictEqual(opened, 1, 'the fallback opened settings');
});

/* ---------------------------------------------------------------- fail soft */

test('a missing anchor leaves the page untouched and does not throw', () => {
  const dom = makeDom({ selectors: [] });
  assert.doesNotThrow(() => {
    run(dom);
    dom.document.dispatch('DOMContentLoaded');
  }, 'the script must not throw when it finds no anchor');
  assert.strictEqual(affordanceButton(dom), null, 'nothing was added to a page with no footer');
});

test('an anchor that appears later is picked up by the observer, without stacking', () => {
  const dom = makeDom({ selectors: [] });
  run(dom);
  dom.document.dispatch('DOMContentLoaded');
  assert.strictEqual(affordanceButton(dom), null, 'no control yet, because the footer is not there');

  // The footer arrives, and a re-render fires the observer.
  const actions = dom.document.createElement('div');
  actions._selectors = [spec.anchors.primary];
  dom.anchorElements.set(spec.anchors.primary, actions);
  dom.registry.push(actions);
  dom.observers.forEach((o) => o.trigger());
  const first = affordanceButton(dom);
  assert.ok(first, 'the observer placed the control when the footer appeared');

  // A further re-render must not add a second control.
  dom.observers.forEach((o) => o.trigger());
  const buttons = dom.registry.filter((el) => el.getAttribute && el.getAttribute(AFFORDANCE_MARKER) !== null);
  assert.strictEqual(buttons.length, 1, 'a re-render must not stack a second control');
});

/* ----------------------------------------------------- one copy in the tree */

test('the injected script exists in exactly one file: the spec', () => {
  const distinctive = spec.script.filter((line) => line.trim().length >= 30);
  assert.ok(distinctive.length >= 3, 'expected distinctive lines in the script to search for');

  const tracked = execFileSync(
    'git', ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO, encoding: 'utf8' },
  ).split('\n').filter(Boolean);
  assert.ok(tracked.length > 0, 'expected a git checkout to sweep');

  const sources = [];
  for (const file of tracked) {
    try {
      sources.push([file, fs.readFileSync(path.join(REPO, file), 'utf8')]);
    } catch { /* a directory or binary cannot hold a copy of the script */ }
  }

  for (const line of distinctive) {
    const escaped = JSON.stringify(line).slice(1, -1);
    const owners = sources.filter(([, source]) => source.includes(escaped)).map(([file]) => file);
    assert.deepStrictEqual(
      owners,
      ['core/spec/app-settings-affordance.json'],
      `the injected script has been copied, and this line is held by ${owners.length} files (${owners.join(', ')}): ${line.trim()}`,
    );
  }
});
