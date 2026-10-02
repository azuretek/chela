// The app-icon choice, issue #115.
//
// What this holds, one claim per test:
//
//   1. the spec offers the icon on the desktop and states why the phone has none,
//      so "absent" cannot be mistaken for "unfinished";
//   2. the resolution lives in ONE call (bucketForChoice, core/app-icons.js) and
//      the window, the Dock and the tray glyph all read that one answer, so a
//      chosen icon cannot show in one and the accent's in another;
//   3. our own pages are told a theme whose accent STANDS FOR the chosen bucket,
//      so the in-app mark (and the Settings preview) draws the same icon the
//      window does, and the auto choice leaves the live accent alone;
//   4. the state carries the choice AND the list it is picked from, because the
//      page cannot import core/app-icons.js;
//   5. a saved choice takes effect at once;
//   6. and the page BUILDS its options from that list and commits the chosen id,
//      exercised in a vm rather than read off the source.
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const REPO = path.join(DESKTOP, '..');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const main = read(DESKTOP, 'src', 'main.js');
const page = read(REPO, 'core', 'ui', 'settings.js');
const html = read(REPO, 'core', 'ui', 'settings.html');
const spec = JSON.parse(read(REPO, 'core', 'spec', 'settings.json'));

test('the spec offers the icon on the desktop, with a reason for the phone', () => {
  const entry = spec.settings.find((s) => s.id === 'appIcon');
  assert.ok(entry, 'the spec does not declare an appIcon setting');
  assert.equal(entry.tab, 'behaviour');
  assert.deepEqual(entry.clients, ['desktop']);
  assert.ok(entry.absent && entry.absent.ios, 'the phone is left without a stated reason, so absent reads as unfinished');
});

test('the row that makes the choice is in the shared page', () => {
  assert.match(html, /data-setting="appIcon"/, 'no row carries the setting');
  assert.match(html, /<select id="appIcon"><\/select>/, 'the picker itself is absent');
  assert.match(html, /id="appIcon-preview"/, 'the row offers no preview of the chosen icon');
});

test('the window, the Dock and the tray resolve the choice through ONE call', () => {
  const body = main.slice(main.indexOf('function applyAppIcon()'));
  const fn = body.slice(0, body.indexOf('function trayImage()'));
  assert.match(fn, /appIcons\.choose\(/, 'the live icon is no longer chosen by the shared rule');
  assert.match(fn, /choice: appIcons\.normalizeChoice\(config\.get\(\)\.appIcon\)/,
    'the drawn icon does not read the stored choice');
  // Both the window/Dock image and the tray glyph come from the SAME choice
  // object, which is what stops them disagreeing.
  assert.match(fn, /choice\.file/);
  assert.match(fn, /choice\.tray/);
});

test('a chosen icon replaces the accent our own pages draw the mark from', () => {
  const body = main.slice(main.indexOf('function pagesTheme()'));
  const fn = body.slice(0, body.indexOf('async function applyThemeCss('));
  assert.match(fn, /if \(!appIcons\.isManualChoice\(choice\)\) return currentTheme;/,
    'the auto choice must leave the live theme and its accent untouched');
  assert.match(fn, /'--accent': appIcons\.accentFor\(bucket\)/,
    'a manual choice does not replace the accent the in-app mark is recoloured from');
  assert.match(main, /chrome\.themeCss\(pagesTheme\(\)\)/,
    'our pages are still handed the live theme, so the mark would not follow the choice');
});

test('the state carries the choice and the list it is picked from', () => {
  assert.match(main, /appIcon: appIcons\.normalizeChoice\(cfg\.appIcon\)/,
    'the choice is not in the settings the page reads');
  assert.match(main, /auto: appIcons\.AUTO,/, 'the auto value is not handed over');
  assert.match(main, /buckets: appIcons\.BUCKETS\.map\(/, 'the bucket list is not handed over');
});

test('a saved icon takes effect at once, not on the next launch', () => {
  const handler = /ipcMain\.handle\('app:save-settings'[\s\S]*?\n  \}\);/.exec(main);
  assert.ok(handler, 'the save-settings handler is not readable here');
  assert.match(handler[0], /hasOwnProperty\.call\(patch \|\| \{\}, 'appIcon'\)/,
    'the icon is not applied when it is the thing that changed');
  assert.match(handler[0], /applyAppIcon\(\);/, 'the window icon is not redrawn on a save');
  assert.match(handler[0], /refreshThemedPages\(\);/, 'our pages are not repainted, so the mark and the preview would lag');
});

/* ---------------------------------------------------------------- the page */

function makeElement(id, listeners) {
  const node = {
    id, tagName: 'DIV', checked: false, disabled: false, hidden: false,
    value: '', textContent: '', innerHTML: '', className: '', dataset: {}, style: {},
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
    append(...kids) { for (const kid of kids) if (kid) node.children.push(kid); },
    replaceChildren(...kids) { node.children.length = 0; for (const kid of kids) if (kid) node.children.push(kid); },
    insertBefore(child) { node.children.push(child); return child; },
    removeChild() {}, replaceWith() {}, remove() {},
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
    focus() {}, blur() {}, click() {},
    closest: () => null, matches: () => false, contains: () => false,
    cloneNode: () => node, scrollIntoView() {},
    querySelector: () => null, querySelectorAll: () => [],
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
    surface: spec,
    settings: { appIcon: 'theme', closeToTray: true, launchAtLogin: false, startHidden: false, promptMetadata: false, autoUpdate: true, globalShortcut: '' },
    iconChoices: { auto: 'theme', buckets: [{ id: 'h22', name: 'Red' }, { id: 'h52', name: 'Orange' }] },
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
  vm.runInContext(page, context, { filename: 'settings.js' });
  return { state, calls, elementFor };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the page builds the picker from the host list, then commits the chosen id', async () => {
  const h = harness();
  await settle();

  const select = h.elementFor('appIcon');
  // Built from the host's own list rather than written into the page: the auto
  // option first, then one per bucket the host sent.
  assert.equal(select.children.length, 1 + h.state.iconChoices.buckets.length,
    'the picker is not built from the buckets the host sent');
  assert.equal(select.children[0].value, h.state.iconChoices.auto, 'the auto option is not first');
  assert.equal(select.children[1].textContent, h.state.iconChoices.buckets[0].name, 'an option does not name its bucket');

  // The initial value is the stored choice, which the host sent as auto here.
  assert.equal(select.value, 'theme');

  const picked = h.state.iconChoices.buckets[1].id;
  select.value = picked;
  select.dispatchEvent({ type: 'change', target: select });
  await settle();

  const save = h.calls.find((c) => c.command === 'saveSettings');
  assert.ok(save, 'choosing an icon committed nothing');
  assert.deepEqual(save.args[0], { appIcon: picked }, 'the one key the picker owns was not sent from its own gesture');
});
