// A click on the dim around Settings or About closes the sheet; a click on the
// sheet never does (#141).
//
// The rule is ONE function, clawSurface.dismissOnOutsideClick in core/ui/surface.js,
// and both pages hand it the same dismiss their "Back to app" control and Escape
// call. This file holds the rule as code, against just enough of a page; the
// pixels and the real mouse are desktop/scripts/test-outside-click.js.
//
// What it replaced compared the release's target with the PRESS event's
// currentTarget from inside a later listener. currentTarget is null once an
// event's dispatch is over, so the comparison never held and a click on the dim
// did nothing at all: the defect reported.
//
// Run with: cd core && npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, '..', 'ui');
const read = (name) => fs.readFileSync(path.join(UI, name), 'utf8');
const SURFACE_JS = read('surface.js');

/** A DOM node that dispatches the way a browser does: target set, bubbling to its parent. */
function node(name, parent = null) {
  const listeners = {};
  return {
    name,
    parent,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type, event) { for (const fn of listeners[type] || []) fn(event); },
  };
}

/** Dispatch a mouse event at `target`, bubbling, with a currentTarget that is null afterwards. */
function dispatch(type, target, button = 0) {
  const event = { type, target, button, currentTarget: null };
  for (let at = target; at; at = at.parent) {
    event.currentTarget = at;
    at.fire(type, event);
  }
  event.currentTarget = null;
  return event;
}

/** surface.js against just enough of a page, with a scrim and a card inside it. */
function page({ native = false } = {}) {
  const context = {
    window: {},
    document: {
      documentElement: {
        classList: { contains: (name) => native && name === 'surface--native-sheet', add() {}, remove() {} },
      },
    },
    location: { search: '' },
    URLSearchParams,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    setTimeout,
    Promise,
  };
  vm.runInNewContext(SURFACE_JS, context);
  const scrim = node('scrim');
  const card = node('card', scrim);
  const text = node('text', card);
  let closed = 0;
  context.window.clawSurface.dismissOnOutsideClick(scrim, () => { closed += 1; });
  const click = (down, up = down, button = 0) => { dispatch('mousedown', down, button); dispatch('mouseup', up, button); };
  return { scrim, card, text, click, closed: () => closed, surface: context.window.clawSurface };
}

test('the shared surface script offers the outside-click rule', () => {
  const { surface } = page();
  assert.strictEqual(typeof surface.dismissOnOutsideClick, 'function',
    'surface.js has no dismissOnOutsideClick, so a click on the dim has no rule behind it');
});

test('a click on the dim closes the sheet, once', () => {
  const p = page();
  p.click(p.scrim);
  assert.strictEqual(p.closed(), 1, 'a press and release on the dim did not close the sheet');
});

test('a click on the sheet never closes it', () => {
  const p = page();
  p.click(p.card);
  p.click(p.text);
  assert.strictEqual(p.closed(), 0, 'a click on the card closed the sheet');
});

test('a press on the sheet released on the dim does not close it, and neither does the reverse', () => {
  const p = page();
  p.click(p.text, p.scrim);
  assert.strictEqual(p.closed(), 0, 'a selection dragged out of the card closed the sheet');
  p.click(p.scrim, p.card);
  assert.strictEqual(p.closed(), 0, 'a press on the dim released on the card closed the sheet');
});

test('a press that was abandoned is not left armed for the next release', () => {
  const p = page();
  // Pressed on the dim and released outside the window: no mouseup reaches the page.
  dispatch('mousedown', p.scrim);
  // The next gesture starts on the card and is released on the dim.
  p.click(p.text, p.scrim);
  assert.strictEqual(p.closed(), 0, 'a stale press on the dim turned a drag out of the card into a close');
});

test('only the primary button closes it', () => {
  const p = page();
  p.click(p.scrim, p.scrim, 2);
  assert.strictEqual(p.closed(), 0, 'a right click on the dim closed the sheet');
});

test('inside a native sheet the scrim is part of the sheet, so a tap on it closes nothing', () => {
  const p = page({ native: true });
  p.click(p.scrim);
  assert.strictEqual(p.closed(), 0, 'a tap on the padding inside the phone sheet closed it; the native host owns outside');
});

/**
 * Both pages: the dim goes through the shared rule, with the SAME dismiss the
 * page's close control and Escape use, and nothing else listens for a press on
 * the scrim. That is what keeps a click outside from being a second way out that
 * behaves differently from "Back to app".
 */
for (const [file, dismissCall] of [['settings.js', "call('closeSettings')"], ['about.js', "api.closeOverlay('about')"]]) {
  test(`${file}: a click on the dim closes through the same dismiss as the close control and Escape`, () => {
    const source = read(file);
    assert.ok(source.includes(`const dismiss = () => ${dismissCall};`), `${file} no longer names its dismiss`);
    assert.match(source, /\$\('close'\)\.addEventListener\('click', dismiss\)/, `${file}: the close control does not dismiss`);
    assert.match(source, /if \(e\.key === 'Escape'\) dismiss\(\)/, `${file}: Escape does not dismiss`);
    assert.match(source, /clawSurface\??\.dismissOnOutsideClick\(\$\('scrim'\), dismiss\)/,
      `${file} does not hand its scrim and its dismiss to the shared outside-click rule`);
    assert.doesNotMatch(source, /\$\('scrim'\)\.addEventListener/,
      `${file} still listens on the scrim itself, a second outside-click path beside the shared one`);
  });
}
