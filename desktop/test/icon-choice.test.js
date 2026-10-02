// The app-icon choice, issues #115 and #132.
//
// What this holds, one claim per test:
//
//   1. the spec offers the icon on the desktop and states why the phone has none,
//      so "absent" cannot be mistaken for "unfinished";
//   2. the resolution lives in ONE call (bucketForChoice, core/app-icons.js) and
//      the window, the Dock and the tray glyph all read that one answer;
//   3. ★ an icon choice leaves every theme token untouched, in both appearances
//      (issue #132): our own pages are handed the live theme and nothing else,
//      and no icon path rewrites a token;
//   4. the state carries the choice AND the drawn list it is picked from, with a
//      colour per bucket, because the page cannot import core/app-icons.js;
//   5. a saved choice takes effect at once without repainting a token;
//   6. and the page BUILDS a grid that draws each bucket, marks the chosen cell,
//      commits the chosen id, and previews the set light or dark, exercised in a
//      vm rather than read off the source.
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import * as chrome from '../src/chrome.js';

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

test('the row that makes the choice is a drawn grid with a light/dark toggle', () => {
  assert.match(html, /data-setting="appIcon"/, 'no row carries the setting');
  assert.match(html, /id="appIcon-grid"/, 'the picker grid is absent');
  assert.match(html, /id="appIcon-mode-light"/, 'there is no light preview control');
  assert.match(html, /id="appIcon-mode-dark"/, 'there is no dark preview control');
  assert.doesNotMatch(html, /<select id="appIcon">/, 'the picker is still a dropdown of names');
});

test('the window, the Dock and the tray resolve the choice through ONE call', () => {
  const body = main.slice(main.indexOf('function applyAppIcon()'));
  const fn = body.slice(0, body.indexOf('function trayImage()'));
  assert.match(fn, /appIcons\.choose\(/, 'the live icon is no longer chosen by the shared rule');
  assert.match(fn, /choice: appIcons\.normalizeChoice\(config\.get\(\)\.appIcon\)/,
    'the drawn icon does not read the stored choice');
  assert.match(fn, /choice\.file/);
  assert.match(fn, /choice\.tray/);
});

test('an icon choice leaves every theme token untouched, in both appearances', () => {
  // The pages are handed the live theme (applyThemeCss), and no icon path can
  // rewrite a token for them. Both guards are on the app, the same it did not
  // have when a manual icon replaced --accent on every one of our pages.
  const body = main.slice(main.indexOf('async function applyThemeCss('));
  const fn = body.slice(0, body.indexOf('async function applyTokenCss('));
  assert.match(fn, /chrome\.themeCss\(currentTheme\)/, 'our pages are not handed the live theme');
  assert.doesNotMatch(main, /pagesTheme/, 'the icon still has a page theme of its own');
  assert.doesNotMatch(main, /'--accent':/, 'the app icon is rewriting a theme token again');
  // And the tokens the live theme carries reach the pages unchanged, in both
  // appearances: nothing in the app rewrites one on the way through.
  for (const mode of ['dark', 'light']) {
    const theme = {
      mode,
      surface: mode === 'dark' ? '#101010' : '#fafafa',
      symbol: mode === 'dark' ? '#f0f0f0' : '#101010',
      tokens: { '--accent': '#f472b6', '--bg': '#0a0a0a', '--panel': '#141414' },
    };
    const css = chrome.themeCss(theme);
    for (const name of Object.keys(theme.tokens)) {
      assert.ok(css.includes(name + ': ' + theme.tokens[name] + ' !important;'),
        mode + ': ' + name + ' did not reach our pages untouched');
    }
  }
});

test('the state carries the choice and the drawn list it is picked from', () => {
  assert.match(main, /appIcon: appIcons\.normalizeChoice\(cfg\.appIcon\)/,
    'the choice is not in the settings the page reads');
  assert.match(main, /auto: appIcons\.AUTO,/, 'the auto value is not handed over');
  assert.match(main, /buckets: appIcons\.BUCKETS\.map\(/, 'the bucket list is not handed over');
  assert.match(main, /accent: appIcons\.accentFor\(b\)/,
    'a bucket reaches the picker with no colour to draw it by');
  assert.match(main, /mode: currentTheme\.mode === 'light'/,
    'the picker has no starting appearance from the host');
});

test('a saved icon takes effect at once, and does not repaint a theme token', () => {
  const handler = /ipcMain\.handle\('app:save-settings'[\s\S]*?\n  \}\);/ .exec(main);
  assert.ok(handler, 'the save-settings handler is not readable here');
  assert.match(handler[0], /hasOwnProperty\.call\(patch \|\| \{\}, 'appIcon'\)/,
    'the icon is not applied when it is the thing that changed');
  assert.match(handler[0], /applyAppIcon\(\);/, 'the window icon is not redrawn on a save');
  assert.doesNotMatch(handler[0], /refreshThemedPages\(\);/,
    'an icon save repaints our pages, so a theme token could move');
});

/* ---------------------------------------------------------------- the page */

function makeElement(id) {
  const listeners = new Map();
  const attributes = {};
  const node = {
    id, tagName: 'DIV', checked: false, disabled: false, hidden: false,
    value: '', textContent: '', innerHTML: '', className: '', dataset: {},
    style: {
      props: {},
      setProperty(name, value) { this.props[name] = String(value); },
      getPropertyValue(name) { return this.props[name] || ''; },
    },
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener() {},
    dispatchEvent(event) {
      const list = listeners.get(event.type) || [];
      for (const handler of list) handler(event);
      return true;
    },
    appendChild(child) { node.children.push(child); return child; },
    append(...kids) { for (const kid of kids) if (kid) node.children.push(kid); },
    replaceChildren(...kids) { node.children.length = 0; for (const kid of kids) if (kid) node.children.push(kid); },
    insertBefore(child) { node.children.push(child); return child; },
    removeChild() {}, replaceWith() {}, remove() {},
    setAttribute(name, value) { attributes[name] = String(value); },
    removeAttribute(name) { delete attributes[name]; },
    getAttribute(name) { return name in attributes ? attributes[name] : null; },
    hasAttribute(name) { return name in attributes; },
    focus() {}, blur() {}, click() {},
    closest: () => null, matches: () => false, contains: () => false,
    cloneNode: () => node, scrollIntoView() {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  return node;
}

function harness() {
  const registry = new Map();
  const calls = [];
  const elementFor = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };
  const document = {
    body: elementFor('body'),
    documentElement: elementFor('html'),
    getElementById: (id) => elementFor(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement('created:' + tag),
    createDocumentFragment: () => makeElement('fragment'),
    addEventListener() {},
    dispatchEvent: () => true,
  };
  const state = {
    client: 'desktop',
    surface: spec,
    settings: { appIcon: 'theme', closeToTray: true, launchAtLogin: false, startHidden: false, promptMetadata: false, autoUpdate: true, globalShortcut: '' },
    iconChoices: {
      auto: 'theme',
      mode: 'dark',
      buckets: [{ id: 'h22', name: 'Red', accent: '#d13b3b' }, { id: 'h52', name: 'Orange', accent: '#d17a3b' }],
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
      if (command === 'liveNotices' || command === 'noticeHistory') return Promise.resolve([]);
      if (command === 'saveSettings') {
        Object.assign(state.settings, args[0]);
        return Promise.resolve({ ...state });
      }
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

test('the picker is a grid built from the host list, one drawn mark per bucket', async () => {
  const h = harness();
  await settle();
  const grid = h.elementFor('appIcon-grid');
  const choices = h.state.iconChoices;
  assert.equal(grid.children.length, 1 + choices.buckets.length,
    'the picker is not built from the buckets the host sent');
  assert.equal(grid.children[0].dataset.id, choices.auto, 'the auto cell is not first');
  assert.equal(grid.children[1].dataset.id, choices.buckets[0].id, 'a cell does not name its bucket');
  assert.equal(grid.children[1].children[1].textContent, choices.buckets[0].name, 'a cell does not show the bucket name');
  // Each manual cell draws its bucket by the colour the host sent; the auto cell
  // draws the live theme, so it overrides nothing.
  assert.equal(grid.children[1].children[0].style.getPropertyValue('--accent'), choices.buckets[0].accent,
    'a manual cell does not draw its own bucket colour');
  assert.equal(grid.children[0].children[0].style.getPropertyValue('--accent'), '',
    'the theme cell pins an accent instead of following the live theme');
});

test('the chosen cell is the stored one, and choosing a cell commits its id', async () => {
  const h = harness();
  await settle();
  const grid = h.elementFor('appIcon-grid');
  assert.equal(grid.children[0].getAttribute('aria-checked'), 'true', 'the stored auto choice is not marked');
  assert.equal(grid.children[1].getAttribute('aria-checked'), 'false', 'a cell the reader did not choose reads as chosen');
  const picked = h.state.iconChoices.buckets[1].id;
  grid.children[2].dispatchEvent({ type: 'click' });
  await settle();
  const save = h.calls.find((c) => c.command === 'saveSettings');
  assert.ok(save, 'choosing an icon committed nothing');
  assert.deepEqual(save.args[0], { appIcon: picked }, 'the one key the picker owns was not sent from its own gesture');
  assert.equal(grid.children[2].getAttribute('aria-checked'), 'true', 'the chosen cell was not marked after the save');
  assert.equal(grid.children[0].getAttribute('aria-checked'), 'false', 'the old choice is still marked');
});

test('the light/dark toggle previews the set without touching the app theme', async () => {
  const h = harness();
  await settle();
  const grid = h.elementFor('appIcon-grid');
  // It opens in the host's own appearance.
  assert.ok(grid.className.includes('--dark'), 'the grid did not open in the host appearance: ' + grid.className);
  assert.equal(h.elementFor('appIcon-mode-dark').getAttribute('aria-pressed'), 'true', 'the dark control is not pressed');
  // The toggle flips the preview alone: a class on the grid, no token.
  h.elementFor('appIcon-mode-light').dispatchEvent({ type: 'click' });
  await settle();
  assert.ok(grid.className.includes('--light'), 'the grid does not preview the light set: ' + grid.className);
  assert.equal(h.elementFor('appIcon-mode-light').getAttribute('aria-pressed'), 'true', 'the light control is not pressed');
  assert.equal(h.elementFor('appIcon-mode-dark').getAttribute('aria-pressed'), 'false', 'the dark control stayed pressed');
  // And a choice can be made in the previewed mode: the mode is not part of the setting.
  const picked = h.state.iconChoices.buckets[0].id;
  grid.children[1].dispatchEvent({ type: 'click' });
  await settle();
  const save = h.calls.find((c) => c.command === 'saveSettings');
  assert.deepEqual(save.args[0], { appIcon: picked }, 'choosing in the light preview sent something other than the bucket id');
});
