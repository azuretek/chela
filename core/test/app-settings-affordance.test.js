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
  AFFORDANCE_GLOBAL, AFFORDANCE_CONFIG_GLOBAL, AFFORDANCE_MARKER, AFFORDANCE_ANCHORS, AFFORDANCE_ROUTES,
  affordanceSource, configStatement, installation, controlUiSettingsSource,
  controlUiSettingsReadySource, CONTROL_UI_SETTINGS_READY_TIMEOUT_MS, CONTROL_UI_SETTINGS_POLL_MS,
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
        // Moving out of the corner clears what the corner set, so the stub has to
        // be able to remove a property: without it a control that moved into the
        // footer would still read as absolutely positioned and the test would pass
        // on a broken placement.
        removeProperty(name) { delete this.props[name]; },
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
      appendChild(child) { this.children.push(child); child.parent = this; registry.push(child); return child; },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      dispatch(type, event = {}) { (listeners[type] || []).forEach((fn) => fn(event)); },
      // A press, as a browser makes one: the count is what the assertions about
      // the Control UI's own control read, and it is dispatched so a listener the
      // page attached still runs.
      click() { this.clicks += 1; this.dispatch('click', { preventDefault() {}, stopPropagation() {} }); },
      clicks: 0,
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
    //
    // A selector containing a SPACE is a descendant selector rather than an
    // attribute test, and the attribute branch is skipped for it: without that
    // guard a compound fallback like `[class*="sidebar"] button[class*="settings"]`
    // starts and ends with a bracket, so it was read as an attribute lookup,
    // found nothing, and made a fallback nothing here could press look untested
    // rather than broken.
    querySelector(selector) {
      const attr = selector.trim().includes(' ') ? null : /^\[(.+?)\]$/.exec(selector.trim());
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
  // Where the script navigates when there is no control to press. Recorded
  // rather than followed: the assertion is which route it handed the OS.
  const visited = [];
  window.location = { assign(url) { visited.push(url); } };
  const context = {
    window,
    location: window.location,
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
  return { window, context, visited };
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

/* ------------------------------------------------- where it lands, and staying there */

test('the control MOVES into the footer when the footer appears after a corner placement', () => {
  // The measured bug, 2026-09-16 on a live Control UI: the page opened on a
  // settings route, where there is no footer action row, so the last-resort
  // corner was used; the marker then made that placement final, and the control
  // stayed in the corner for the life of the page even after the chat layout
  // rendered a real footer. A fallback that fires permanently is not a fallback.
  const sidebarSelector = spec.anchors.sidebar.split(',')[0].trim();
  const dom = makeDom({ selectors: [sidebarSelector] });
  run(dom);
  dom.document.dispatch('DOMContentLoaded');
  const corner = affordanceButton(dom);
  assert.ok(corner, 'it starts in the corner, because that is all the page offered');
  assert.strictEqual(corner.style.getPropertyValue('position'), 'absolute');

  // The app navigates to the chat layout, whose footer has the action row.
  const actions = dom.document.createElement('div');
  actions._selectors = [spec.anchors.primary];
  dom.anchorElements.set(spec.anchors.primary, actions);
  dom.registry.push(actions);
  dom.observers.forEach((o) => o.trigger());

  const moved = affordanceButton(dom);
  assert.strictEqual(moved, corner, 'the same control is moved rather than a second one added');
  assert.strictEqual(moved.parent, actions, 'and it is now in the footer actions row');
  assert.strictEqual(moved.style.getPropertyValue('position'), '', 'with the corner positioning cleared');
  assert.strictEqual(moved.style.getPropertyValue('left'), '', 'and the corner offsets gone with it');
});

test('the placement never moves back down to a worse anchor', () => {
  // The footer can be re-rendered on every navigation. A control that followed it
  // back into the corner whenever the action row blinked would be worse than one
  // that never moved.
  const dom = makeDom({ selectors: [spec.anchors.primary] });
  run(dom);
  dom.document.dispatch('DOMContentLoaded');
  const actions = dom.anchorElements.get(spec.anchors.primary);
  const button = affordanceButton(dom);
  assert.strictEqual(button.parent, actions);

  dom.anchorElements.delete(spec.anchors.primary);
  dom.observers.forEach((o) => o.trigger());
  assert.strictEqual(affordanceButton(dom).parent, actions, 'it stays where it was put');
});

test('the last-resort anchor is the main sidebar, not anything whose class contains sidebar', () => {
  // `aside[class*="sidebar"]` matched `.settings-sidebar` on the live page, so a
  // page that opened on a settings route parked the control inside the settings
  // page's own sidebar. The class-substring test is what made that possible.
  assert.ok(!/class\*=/.test(spec.anchors.sidebar),
    `the sidebar anchor must not test a class substring; got ${spec.anchors.sidebar}`);
  assert.ok(spec.anchors.sidebar.split(',').some((s) => s.trim() === '.sidebar-shell'),
    'it names the main shell');
});

test('the fallback click target cannot match an unrelated settings button', () => {
  // Measured on the same live page: `[class*="sidebar"] button[class*="settings"]`
  // pressed `.chat-talk-input-picker__settings`, the chat composer's own settings
  // button, and navigated the reader to /chat/main. A control that does something
  // unrelated is worse than one that does nothing.
  const fallback = spec.anchors.controlUiSettingsFallback;
  assert.ok(/sidebar-footer/.test(fallback), `the fallback is scoped to the footer strip; got ${fallback}`);
  assert.ok(/aria-label/.test(fallback), 'and it is matched by the control\'s accessible name');
  assert.ok(!/button\[class\*="settings"\]/.test(fallback), 'not by a class substring');
});

/* ---------------------------------------------------- one copy in the tree */

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

/* ------------------------------------ handing the reader to the Control UI */

// The second thing this script can do, and the reason the app's settings page
// offers a link at all: take the reader to the CONTROL UI's own settings. It is
// a different surface from ours and not ours to navigate, so the script presses
// the Control UI's own footer control rather than building a URL, which keeps the
// route the Control UI's and the two clients from coming to mean different pages.

test('the press is the Control UI footer control named by the spec, pressed once', () => {
  const dom = makeDom({ selectors: [spec.anchors.controlUiSettings] });
  const { window } = run(dom);
  const config = window[spec.configGlobal];

  assert.strictEqual(typeof config.openControlUiSettings, 'function', 'the press is installed on the config global');
  assert.strictEqual(config.openControlUiSettings(), true, 'a control in the footer is pressed');
  assert.strictEqual(
    dom.anchorElements.get(spec.anchors.controlUiSettings).clicks,
    1,
    'exactly one press, on the Control UI control itself',
  );
});

test('the fallback anchor is pressed when the first selector finds nothing', () => {
  const dom = makeDom({ selectors: [spec.anchors.controlUiSettingsFallback] });
  const { window } = run(dom);
  assert.strictEqual(window[spec.configGlobal].openControlUiSettings(), true, 'the fallback control is pressed');
  assert.strictEqual(dom.anchorElements.get(spec.anchors.controlUiSettingsFallback).clicks, 1);
});

test('a Control UI with no control to press goes to its OWN route instead of doing nothing', () => {
  // This changed on 2026-09-16, and the reason is the bug the whole area keeps
  // producing. The Control UI build serving Abi's clients has no settings control
  // in the sidebar at all (upstream added one after that release), so the old
  // contract, answer false and log, was a button that appeared to work and did
  // nothing. The Control UI publishes the route its own settings entry opens, so
  // the reader is taken there.
  const dom = makeDom({ selectors: [] });
  const { window, visited } = run(dom);
  assert.strictEqual(window[spec.configGlobal].openControlUiSettings(), true, 'the reader is taken somewhere');
  assert.deepStrictEqual(visited, [spec.routes.appearance], 'to the Control UI route its own entry opens');
});

test('with no control and no route it still fails soft rather than throwing', () => {
  // A page we do not own may move both. A press that threw inside it would break
  // the Control UI rather than leaving the reader where they were. Installed with
  // an empty config rather than re-assigning the global afterwards: the script
  // reads its config ONCE at install time, so a later write is not what a page
  // without these values would look like.
  const dom = makeDom({ selectors: [] });
  const window = {};
  window.location = { assign() { throw new Error('nothing should be navigated to'); } };
  const context = {
    window,
    location: window.location,
    document: dom.document,
    MutationObserver: dom.MutationObserver,
    console: { debug() {} },
  };
  vm.runInNewContext(
    `window.${AFFORDANCE_CONFIG_GLOBAL} = { anchors: {}, routes: {} };\n${affordanceSource()}`,
    context,
  );
  assert.strictEqual(window[AFFORDANCE_CONFIG_GLOBAL].openControlUiSettings(), false,
    'nothing to press and nowhere to go answers false');
});

test('the route is the Control UI\'s own, and it comes from the spec rather than a client', () => {
  assert.strictEqual(spec.routes.appearance, '/settings/appearance', 'the route table path for appearance');
  assert.strictEqual(AFFORDANCE_ROUTES.appearance, spec.routes.appearance);
  // Handed to the page with the anchors, so the script that uses it is one copy.
  const dom = makeDom({ selectors: [] });
  const { window } = run(dom);
  assert.strictEqual(window[spec.configGlobal].routes.appearance, spec.routes.appearance);
});

test('the call a client evaluates presses the same control the script would', () => {
  const dom = makeDom({ selectors: [spec.anchors.controlUiSettings] });
  const { window, context } = run(dom);
  const source = controlUiSettingsSource();

  assert.ok(source.includes(spec.configGlobal), 'the call reads the config global the installation wrote');
  assert.ok(!source.includes(`${spec.global}.open`), 'the call never reaches for the app-settings bridge');
  assert.strictEqual(vm.runInNewContext(source, context), true, 'the client evaluates this exact string');
  assert.strictEqual(dom.anchorElements.get(spec.anchors.controlUiSettings).clicks, 1);
});

test('installing twice leaves one press rather than a queue of them', () => {
  // The installation is re-run on every load of a page whose footer can be
  // rebuilt, so a second install must replace the function rather than add a
  // second one that would open settings once per install.
  const dom = makeDom({ selectors: [spec.anchors.controlUiSettings] });
  const { window, context } = run(dom);
  vm.runInNewContext(`${configStatement({ label: 'App settings' })}\n${affordanceSource()}`, context);

  assert.strictEqual(window[spec.configGlobal].openControlUiSettings(), true);
  assert.strictEqual(dom.anchorElements.get(spec.anchors.controlUiSettings).clicks, 1, 'one press per call, not per install');
});

test('the anchors are flat strings, so the client that mirrors them can decode the file', () => {
  // Measured the hard way: a nested object for the Control UI settings control
  // failed the phone's `[String: String]` decode of this whole file, which takes
  // the script and the config with it, and an affordance that never installs
  // reports nothing anywhere.
  for (const [key, value] of Object.entries(spec.anchors)) {
    assert.strictEqual(typeof value, 'string', `anchors.${key} must be a string`);
  }
  assert.ok(spec.anchors.controlUiSettings, 'the Control UI settings control is named');
  assert.ok(spec.anchors.controlUiSettingsFallback, 'and has a fallback');
  assert.ok(spec.anchors.controlUiSettingsSurface, 'and the surface that proves the destination arrived');
});

/* ------------------------------- waiting for the destination to be ready */

// The atomic half of the handoff. Both clients used to take the reader to the
// Control UI's settings by CLOSING their own surface first and asking second, so
// the reader watched whatever the Control UI had been showing for the whole of the
// destination's load. The ask is unchanged; what is new is that nothing is
// revealed until this question answers yes.
//
// Run against a stub rather than a browser because the question is a claim about
// the Control UI's DOM, which is another program's: what is asserted here is the
// RULE (route and painted node, neither alone), the fail-soft direction, and that
// every Control UI fact it depends on comes from the spec.

/** Evaluate the readiness question against just enough of a page. */
function runReady({ pathname = '/settings/appearance', found = true, box = { width: 287, height: 884 }, throws = false } = {}) {
  const node = {
    getBoundingClientRect() {
      if (throws) throw new Error('the page refused the question');
      return box;
    },
  };
  const context = {
    location: { pathname },
    document: { querySelector: (selector) => (found && selector === spec.anchors.controlUiSettingsSurface ? node : null) },
    console: { debug() {} },
  };
  return vm.runInNewContext(controlUiSettingsReadySource(), context);
}

test('the destination is not ready until the route AND the painted surface are both there', () => {
  assert.strictEqual(runReady(), true, 'on the destination route, with the surface painted');
  // Neither half alone. This is the pair that the handoff needs and the one the
  // first version of this would have got wrong in the field.
  assert.strictEqual(runReady({ found: false }), false, 'the route without the surface is the load, not the page');
  assert.strictEqual(
    runReady({ box: { width: 0, height: 0 } }),
    false,
    'a surface that is present but unpainted is a committed route, not a rendered page',
  );
});

test('a reader who came from the Control UI\'s OWN settings page is not already "ready"', () => {
  // The reason the route is required and not just the node, measured against a
  // live Control UI: the settings SHELL is on screen for every `/settings/*`
  // route, including the first-run model-setup flow. A node-only question would
  // answer yes the instant the reader pressed, on the page they were already
  // looking at, and the reveal would be the non-atomic sequence again.
  assert.strictEqual(
    runReady({ pathname: '/settings/model-setup', found: true, box: { width: 287, height: 884 } }),
    false,
    'the first-run settings flow has the same shell but is not the destination',
  );
  assert.strictEqual(runReady({ pathname: '/chat/main' }), false, 'and neither is the chat layout');
});

test('the readiness question fails soft, and the soft direction is "not ready"', () => {
  // A page we do not own may throw inside it, and a question that cannot be
  // answered must not be read as an answer. This is the direction that costs the
  // reader a bounded wait rather than revealing something they did not ask for:
  // the caller re-asks, and the deadline is what ends it.
  assert.doesNotThrow(() => runReady({ throws: true }));
  assert.strictEqual(runReady({ throws: true }), false, 'a question that throws is not a yes');
});

test('the readiness question is built from the spec, so both clients claim the same thing', () => {
  const source = controlUiSettingsReadySource();
  assert.ok(source.includes(JSON.stringify(spec.anchors.controlUiSettingsSurface)),
    'the surface it looks for is the spec\'s, not a selector copied into a client');
  assert.ok(source.includes(JSON.stringify(spec.routes.appearance)),
    'and so is the route it requires');
  // It reads the PAGE, never the app: a readiness question that needed our own
  // config global would be unanswerable in the document that replaces one.
  assert.ok(!source.includes(spec.configGlobal), 'it depends on no global a client installs');
});

test('the handoff timing has one owner, and the clients read it rather than carrying it', () => {
  // Two clients have to hold the same line, so the numbers live in the spec the
  // phone bundles and the desktop imports.
  assert.strictEqual(CONTROL_UI_SETTINGS_READY_TIMEOUT_MS, spec.handoff.readyTimeoutMs);
  assert.strictEqual(CONTROL_UI_SETTINGS_POLL_MS, spec.handoff.pollMs);
  assert.ok(CONTROL_UI_SETTINGS_READY_TIMEOUT_MS > CONTROL_UI_SETTINGS_POLL_MS,
    'the deadline is longer than one interval, or the wait would never ask twice');
  assert.ok(CONTROL_UI_SETTINGS_READY_TIMEOUT_MS >= 3000,
    'and long enough to cover a remote destination\'s own load, which is what the gap was');
});
