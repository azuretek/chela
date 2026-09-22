// The preference controls commit on the reader's own gesture, and that wiring has
// to happen AFTER the first state arrives.
//
// Everything wirePreferences() wires is gated on hasSetting(), which reads the
// surface out of \`state\`, and \`state\` is null until the boot IIFE has awaited its
// first \`state\` command. With the wiring at module scope it ran against an empty
// surface, every hasSetting() answered false, and each switch was left with no
// listener: the click still flipped the native box, nothing was sent, and the next
// render reset it from the host's own value. Reported as a checkbox that is
// unchecked again when the page is opened a second time.
//
// The harness is deliberately small: an element registry, a host that answers the
// two commands this needs, and the page's own source run in a vm. It asserts the
// BEHAVIOUR (a flip reaches saveSettings) rather than the shape of the code, so it
// cannot pass by the wiring existing and never running.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, '..', '..');
const SPEC = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'spec', 'settings.json'), 'utf8'));
const SETTINGS_JS = fs.readFileSync(path.join(REPO, 'core', 'ui', 'settings.js'), 'utf8');

/** A stand-in element: the properties the page sets, plus listeners it adds. */
function makeElement(id, listeners) {
  const node = {
    id,
    tagName: 'DIV',
    checked: false,
    disabled: false,
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    dataset: {},
    style: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, handler) {
      const list = listeners.get(id) || new Map();
      const forType = list.get(type) || [];
      forType.push(handler);
      list.set(type, forType);
      listeners.set(id, list);
    },
    removeEventListener() {},
    dispatchEvent(event) {
      const list = (listeners.get(id) || new Map()).get(event.type) || [];
      for (const handler of list) handler(event);
      return true;
    },
    appendChild(child) { node.children.push(child); return child; },
    append() {},
    insertBefore(child) { return child; },
    removeChild() {},
    replaceChildren() {},
    replaceWith() {},
    remove() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    focus() {},
    blur() {},
    click() {},
    closest: () => null,
    matches: () => false,
    contains: () => false,
    cloneNode: () => node,
    scrollIntoView() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  return node;
}

function harness() {
  const listeners = new Map();
  const registry = new Map();
  const calls = [];
  const elementFor = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id, listeners));
    return registry.get(id);
  };
  const document = {
    body: elementFor('body'),
    documentElement: elementFor('html'),
    getElementById: (id) => elementFor(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement('created:' + tag, listeners),
    createDocumentFragment: () => makeElement('fragment', listeners),
    addEventListener() {},
    dispatchEvent: () => true,
  };
  const state = {
    client: 'desktop',
    surface: SPEC,
    settings: {
      closeToTray: true,
      launchAtLogin: false,
      startHidden: false,
      promptMetadata: false,
      autoUpdate: true,
      globalShortcut: '',
    },
    gateways: [],
    activeGatewayId: null,
    connection: { gatewayId: null, phase: 'idle', milestone: null, milestoneAt: null },
    updates: { canInstall: true },
    notices: [],
  };
  const host = {
    asPage: false,
    invoke(command, args) {
      calls.push({ command, args });
      // The list commands answer with lists; everything else this harness needs
      // answers with the state it would follow a write from.
      if (command === 'liveNotices' || command === 'noticeHistory') return Promise.resolve([]);
      if (command === 'saveSettings') return Promise.resolve({ ...state });
      return Promise.resolve(state);
    },
    on() {},
  };
  const context = {
    window: { clawSettings: host, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document,
    location: { search: '', href: 'file:///settings.html' },
    navigator: { userAgent: 'node', platform: 'mac' },
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  context.window.document = document;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SETTINGS_JS, context, { filename: 'settings.js' });
  return { listeners, registry, calls, elementFor };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a switch flip reaches saveSettings once the page has booted', async () => {
  const { listeners, elementFor, calls } = harness();
  await settle();

  // The first state arrived, or the page never booted and this test would be
  // asserting against nothing.
  assert.ok(
    calls.some((c) => c.command === 'state'),
    'the page asked for its first state',
  );

  const handlers = (listeners.get('promptMetadata') || new Map()).get('change') || [];
  assert.equal(
    handlers.length,
    1,
    'the context-injection switch is wired to a change handler: without it the click flips the box and sends nothing',
  );

  const box = elementFor('promptMetadata');
  box.checked = true;
  box.dispatchEvent({ type: 'change', target: box });
  await settle();

  const save = calls.find((c) => c.command === 'saveSettings');
  assert.ok(save, 'the flip committed');
  assert.deepEqual(save.args[0], { promptMetadata: true }, 'the one key the control owns was sent, from its own gesture');
});
