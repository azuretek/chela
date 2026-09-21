// The app frame inset, driven against a fake window and document.
//
// The script under test runs in the page's MAIN world, where it cannot be
// imported: these tests run the exact bytes the clients install against a
// document stand-in, the same way the reconnect-resume shim and the pairing
// observer are driven. What is asserted is the CONTRACT rather than the DOM: the
// properties the client publishes, the marker that turns the clamp on, and the
// rule the script builds for the page.

import test from 'node:test';
import assert from 'node:assert';

import {
  installation,
  setStatement,
  configStatement,
  FRAME_INSET_PROPERTIES,
  FRAME_INSET_MARKER,
  FRAME_INSET_SELECTORS,
} from '../app-frame-inset.js';

function makeDom() {
  const created = [];
  const root = {
    attributes: {},
    setAttribute(name) { this.attributes[name] = ''; },
    removeAttribute(name) { delete this.attributes[name]; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
    style: { props: {}, setProperty(name, value) { this.props[name] = value; } },
    appendChild(node) { created.push(node); },
  };
  const head = { appendChild(node) { created.push(node); } };
  const document = {
    documentElement: root,
    head,
    createElement() {
      return { attributes: {}, setAttribute(name) { this.attributes[name] = ''; }, textContent: '' };
    },
  };
  return { document, root, created };
}

function run(script) {
  const dom = makeDom();
  const window = {};
  new Function('window', 'document', script)(window, dom.document);
  return { window, ...dom };
}

test('the first paint is bounded: installation publishes the frame and installs the setter', () => {
  const { window, root, created } = run(installation({ top: 59, bottom: 34 }));

  assert.equal(typeof window.__clawFrameInset.set, 'function', 'the setter the client pushes through is on the global');
  assert.equal(root.style.props[FRAME_INSET_PROPERTIES.top], '59px');
  assert.equal(root.style.props[FRAME_INSET_PROPERTIES.bottom], '34px');
  assert.equal(root.style.props[FRAME_INSET_PROPERTIES.left], '0px');
  assert.equal(root.style.props[FRAME_INSET_PROPERTIES.right], '0px');
  assert.ok(root.hasAttribute(FRAME_INSET_MARKER), 'a frame that takes space turns the clamp on');

  assert.equal(created.length, 1, 'one stylesheet, appended at document start');
  const css = created[0].textContent;
  for (const selector of FRAME_INSET_SELECTORS) {
    assert.ok(css.includes(':root[' + FRAME_INSET_MARKER + '] ' + selector), selector + ' is named in the rule');
  }
  assert.ok(css.includes('top: var(' + FRAME_INSET_PROPERTIES.top + ', 0px) !important'), 'the leading edge lands on the frame');
  assert.ok(css.includes('bottom: var(' + FRAME_INSET_PROPERTIES.bottom + ', 0px) !important'), 'and so does the trailing edge');
  assert.ok(css.includes('max-height: calc(100dvh'), 'the height cap is the visible viewport, not the largest one');
  assert.ok(!/(^|[^d])100vh/.test(css), 'a phone 100vh is the LARGEST viewport, so it must not decide the height');
  assert.ok(!css.includes('body'), 'the page shell keeps the whole display: the nav drawer is a 100dvh surface');
  assert.equal(created[0].attributes[FRAME_INSET_MARKER], '', 'the sheet is marked like the global it pairs with');
});

test('a client whose page already excludes its chrome publishes zeros and stays inert', () => {
  const { window, root } = run(installation({ top: 0, bottom: 0 }));

  assert.equal(root.style.props[FRAME_INSET_PROPERTIES.top], '0px', 'the value is published rather than omitted');
  assert.equal(root.hasAttribute(FRAME_INSET_MARKER), false, 'nothing is clamped, so the desktop is untouched');
  assert.equal(window.__clawFrameInset.set({ top: 0, bottom: 0 }), false);
});

test('the frame moves with the clients own chrome', () => {
  const { window, root, created } = run(installation({ top: 0, bottom: 0 }));
  assert.equal(root.hasAttribute(FRAME_INSET_MARKER), false);

  assert.equal(window.__clawFrameInset.set({ top: 72 }), true, 'a banner band reported as taking space');
  assert.equal(root.style.props[FRAME_INSET_PROPERTIES.top], '72px');
  assert.ok(root.hasAttribute(FRAME_INSET_MARKER));

  assert.equal(window.__clawFrameInset.set({ top: 0 }), false, 'and the band going away turns it back off');
  assert.equal(root.hasAttribute(FRAME_INSET_MARKER), false);
  assert.equal(created.length, 1, 'moving the frame does not re-install anything');
});

test('every edge is normalised to a pixel value the page can use', () => {
  const { window, root } = run(installation());
  window.__clawFrameInset.set({ top: '12.6', bottom: -40, left: NaN, right: undefined });
  assert.equal(root.style.props[FRAME_INSET_PROPERTIES.top], '13px', 'a fractional value is rounded');
  assert.equal(root.style.props[FRAME_INSET_PROPERTIES.bottom], '0px', 'a negative inset is not a reverse inset');
  assert.equal(root.style.props[FRAME_INSET_PROPERTIES.left], '0px');
  assert.equal(root.style.props[FRAME_INSET_PROPERTIES.right], '0px');
});

test('setStatement is the later push, and says so when there is nothing to push to', () => {
  const { window } = run(installation({ top: 0 }));
  const statement = setStatement({ top: 44 });
  assert.equal(new Function('window', 'return ' + statement)(window), true, 'the installed setter took the new frame');
  assert.equal(new Function('window', 'return ' + statement)({}), null, 'a page the script never reached answers null rather than throwing');
});

test('the spec fields reach the script as data, so neither client restates them', () => {
  const statement = configStatement();
  assert.ok(statement.startsWith('window.__clawFrameInsetConfig = '), 'the config is one plain assignment');
  const config = JSON.parse(statement.slice(statement.indexOf('{'), statement.lastIndexOf(';')));
  assert.deepEqual(config.properties, FRAME_INSET_PROPERTIES);
  assert.deepEqual(config.selectors, FRAME_INSET_SELECTORS);
  assert.equal(config.marker, FRAME_INSET_MARKER);
});

