// The banner page.
//
// core/ui/banner.js is a browser script, so it is loaded here against a minimal
// DOM rather than required. That is worth the shim for one reason: the stack is
// rebuilt key by key so a banner that has been sitting there for an hour does
// not replay its slide every time an unrelated one appears, and a rebuild that
// treats a card as a row to append either duplicates it or prunes it, and neither
// shows up in a screenshot of a working banner.
//
// ★ THIS PAGE DRAWS NOTICES AND NOTHING ELSE. The sweep (Mark all read) is not
// here and must not be: anything drawn on this page is inside the bar's own
// rectangle, which its view claims whole, so a control on a line of its own makes
// the rest of that line a strip that eats clicks over the Control UI. Abi caught
// that twice, on 2026-09-17 and again on 2026-09-18. The sweep is a view of its
// own, sized to the button, in core/ui/sweep.html; the guard below is that the
// stack has no non-card child and that nothing on this page offers the sweep. The
// stack still paints the whole rectangle its cards sit in (asserted against the
// stylesheet in drag-regions.test.js), which is what keeps the cards safe.
//
// Run with: npm test

import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { forPages as bannerSpec } from '../../core/banner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SOURCE = path.join(HERE, '..', '..', 'core', 'ui', 'banner.js');

function makeNode(tag) {
  const node = {
    tag,
    id: '',
    className: '',
    textContent: '',
    parent: null,
    kids: [],
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] ?? null; },
    get children() { return this.kids; },
    get childElementCount() { return this.kids.length; },
    append(...items) {
      for (const item of items) {
        if (!item) continue;
        item.parent = this;
        this.kids.push(item);
      }
    },
    remove() {
      if (!this.parent) return;
      this.parent.kids = this.parent.kids.filter((n) => n !== this);
      this.parent = null;
    },
    replaceWith(next) {
      if (!this.parent) return;
      const i = this.parent.kids.indexOf(this);
      next.parent = this.parent;
      this.parent.kids[i] = next;
      this.parent = null;
    },
    // The page reports this to main, which sizes the view to the card cluster.
    // Any numbers will do here; what matters is that an empty stack reports a zero
    // box and a non-empty one reports a card-sized box. width is a card's, not the
    // window's, since the view now hugs the cards (see report() in banner.js).
    getBoundingClientRect() { return { width: this.kids.length ? 420 : 0, height: this.kids.length * 40 }; },
  };
  // The real element has one, and the banner uses it to mark a card that is new
  // to the stack. Without it here, a real change would arrive as a TypeError
  // rather than as a test that could fail honestly.
  node.classList = {
    add(name) {
      const parts = new Set(String(node.className).split(/\s+/).filter(Boolean));
      parts.add(name);
      node.className = [...parts].join(' ');
    },
    contains: (name) => String(node.className).split(/\s+/).includes(name),
  };
  return node;
}

function find(node, id) {
  if (node.id === id) return node;
  for (const kid of node.kids) {
    const hit = find(kid, id);
    if (hit) return hit;
  }
  return null;
}

/** The first descendant carrying this class. A card's parts are nested inside
    its own column, so searching one level would miss them. */
function byClass(node, className) {
  for (const kid of node.kids) {
    if (String(kid.className).split(/\s+/).includes(className)) return kid;
    const hit = byClass(kid, className);
    if (hit) return hit;
  }
  return null;
}

/** The real banner script, wired to a fake page. */
function mount() {
  const stack = makeNode('div');
  stack.id = 'stack';
  const calls = { markAll: 0, dismissed: [], actions: [], bounds: [] };
  let unread = [];

  global.document = {
    createElement: makeNode,
    createElementNS: (_ns, tag) => makeNode(tag),
    getElementById: (id) => (id === 'stack' ? stack : find(stack, id)),
  };
  global.window = {
    clawDesktop: {
      notices: async () => unread,
      bannerSpec: async () => bannerSpec(),
      bannerBounds: (b) => { calls.bounds.push(b); },
      markNoticesRead: async () => { calls.markAll += 1; },
      dismissNotice: async (id) => { calls.dismissed.push(id); },
      noticeAction: async (c) => { calls.actions.push(c); },
      onNoticesChanged: () => {},
    },
    addEventListener: () => {},
  };

  // Minus its own boot lines, which would subscribe and render on load.
  const src = fs.readFileSync(SOURCE, 'utf8')
    .replace(/^api\.onNoticesChanged.*$/m, '')
    .replace(/^window\.addEventListener.*$/m, '')
    .replace(/^void render\(\);$/m, '');
  // The script is strict, so eval gives it its own scope: hand the function back
  // explicitly rather than hoping it leaks.
  // eslint-disable-next-line no-eval
  const { render } = eval(`${src}\n;({ render })`);

  return {
    calls,
    render,
    set(next) { unread = next; },
    rows: () => stack.kids.map((n) => n.id || n.className),
    node: (id) => find(stack, id),
    // The stack itself, and a count over the WHOLE tree by id, so "is the node
    // still there" is asked of the tree rather than of one level: a card nests its
    // own parts inside its body column.
    root: () => stack,
    count: (id) => {
      let n = 0;
      const walk = (node) => {
        if (node.id === id) n += 1;
        for (const kid of node.kids) walk(kid);
      };
      walk(stack);
      return n;
    },
  };
}

const failure = { id: 'connection', tone: 'error', message: 'Cannot connect', detail: 'Refused.', dismissible: true };
// A notice that refuses the X, which the page still has to draw without a control.
// The real download card used to be this, and is not any more: it refused the X
// because a progress bar that reappeared on the next whole percent would be worse
// than one with no control at all. That reasoning was right about the reappearing
// and wrong about the remedy, and the card Abi could not clear on 2026-09-17 was
// the result. The reappearing is fixed where it belongs now (main drops the raise
// for an attempt the reader cleared), so the control is back.
const pinned = { id: 'update-available', tone: 'info', message: 'Downloading', progress: 0.4, dismissible: false };
// A download in flight, as it actually reaches this page: dismissible, and with a
// dismissal that MEANS stop rather than "I have seen this".
const downloading = {
  id: 'update-available',
  tone: 'info',
  message: 'Downloading Chela 1.0.2.',
  detail: 'Starting the download.',
  progress: 0.4,
  dismissible: true,
  dismissClears: true,
};
// The same download after it produced nothing for the stall window: no bar, a way
// out, and the one action that is honest about being able to do anything.
const stalled = {
  id: 'update-available',
  tone: 'warn',
  message: 'Downloading Chela 1.0.2 has stopped making progress.',
  detail: 'Nothing has arrived for 45 seconds. It has not been cancelled, so it may still finish on its own.',
  dismissible: true,
  dismissClears: true,
  action: { label: 'Open release page', command: 'update-release-page' },
};

test('★ the bar draws notices and nothing else: the sweep is a view of its own', async () => {
  // ★ The sixth version of one fault in this area, and the reason it is a guard
  // rather than a comment: the bar is drawn in a view sized to the stack, and a
  // view claims every mouse event inside its own rectangle whatever the page
  // draws there. A CHILD OF THE STACK THAT IS NOT A CARD is a strip of that
  // rectangle carrying no notice, and its empty part swallows clicks meant for the
  // Control UI beneath it.
  //
  // The history, because the invariant moved rather than the fault: 2026-09-17,
  // the sweep's own row was a stack child with nothing painted behind it, so a
  // click on its empty leading half reached neither the control nor the page. The
  // next fix moved the row inside the last card, which read wrong. The one after
  // painted the BAR so the row was visually safe, but the view still ate the click
  // across the row's full width, which is the regression Abi reported on
  // 2026-09-18; the one after that hung the button on the last card's line, and
  // Abi asked for it below the card instead. It is now a view of its own, sized to
  // the button (refreshSweep in src/main.js, core/ui/sweep.html), so this page
  // draws no sweep at all and its rectangle is its cards plus the bar's padding.
  const b = mount();
  b.set([pinned, failure]);
  await b.render();
  const children = b.root().kids;
  assert.ok(children.length, 'the stack was empty, so this guard proves nothing');
  // Every child of the stack is a card. The sweep is not among them, and nothing
  // on this page offers it either: a control here would sit inside this view's
  // rectangle and make the rest of its line a dead zone.
  const cards = children.filter((n) => /(^|\s)banner(\s|$)/.test(String(n.className)));
  assert.equal(cards.length, children.length,
    'the stack holds a non-card child, which is a strip that can eat clicks: '
    + children.map((n) => n.tag + '.' + (n.className || n.id)).join(', '));
  assert.ok(!children.some((n) => n.id === 'banner-actions'),
    'the sweep is a child of the bar again, which is the shape that ate clicks');
  assert.equal(byClass(b.root(), 'banner__readall'), null,
    'the bar is drawing the sweep button again; it belongs in its own view');
  assert.equal(b.calls.markAll, 0,
    'drawing the bar asked to mark notices read, which only the sweep may do');
});

test('the card X marks only its own notice read', async () => {
  const b = mount();
  b.set([failure]);
  await b.render();

  const card = b.node('n-connection');
  await card.kids.find((k) => k.className === 'banner__close').onclick();
  assert.deepEqual(b.calls.dismissed, ['connection']);
});

test('a notice that cannot be dismissed is drawn without an X', async () => {
  const b = mount();
  b.set([pinned]);
  await b.render();
  const card = b.node('n-update-available');
  assert.ok(!card.kids.some((k) => k.className === 'banner__close'));
});

test('★ a download in flight can be cleared, which is the card that could not be', async () => {
  // The regression. This card used to be drawn with no X at all, so the bar Abi
  // was looking at had no control on it, and "Mark all read" skipped it too (see
  // background() below and core/notices.js). Nothing could take it away.
  const b = mount();
  b.set([downloading]);
  await b.render();
  const card = b.node('n-update-available');
  const close = card.kids.find((k) => k.className === 'banner__close');
  assert.ok(close, 'the download card must offer the reader a way out');

  await close.onclick();
  assert.deepEqual(b.calls.dismissed, ['update-available'], 'and that way out reaches main as a dismissal');

  // ★ The tooltip has to be true. This page cannot know what main does with the
  // dismissal, so it reads it off the notice: a dismissClears card is not "Mark
  // read", and promising it stays listed under Settings would be wrong twice over.
  assert.match(close.title, /Clear this/);
  assert.doesNotMatch(close.title, /stays listed/);
  // And the ordinary card keeps the ordinary meaning, so the two cannot be
  // switched by accident.
  const other = mount();
  other.set([failure]);
  await other.render();
  const plain = other.node('n-connection').kids.find((k) => k.className === 'banner__close');
  assert.match(plain.title, /Mark read/);
});

test('★ a stalled download draws no bar, and offers the one thing it can do', async () => {
  // The bar is what was lying: it drew a position for a transfer that had not
  // moved. The stalled phase drops it, keeps the way out, and offers the release.
  const b = mount();
  b.set([stalled]);
  await b.render();
  const card = b.node('n-update-available');
  assert.ok(!byClass(card, 'banner__progress'), 'a stalled download must not draw a progress bar');
  assert.ok(card.kids.find((k) => k.className === 'banner__close'), 'and it must still be clearable');
  const action = card.kids.find((k) => k.className === 'banner__action');
  assert.ok(action, 'and it must offer something that can actually be done');
  assert.equal(action.textContent, 'Open release page');
  await action.onclick();
  assert.deepEqual(b.calls.actions, ['update-release-page']);
});

test('a download in flight draws a bar and its percentage', async () => {
  // A native <progress> with a value rather than a styled div: this page runs
  // under `style-src 'self'`, so an inline width would be refused and the bar
  // would sit at zero looking exactly like a stalled download.
  const b = mount();
  b.set([pinned]);
  await b.render();
  const row = byClass(b.node('n-update-available'), 'banner__progress');
  assert.ok(row, 'no progress row was drawn');
  const [bar, label] = row.kids;
  assert.equal(bar.tag, 'progress');
  assert.equal(bar.max, 100);
  assert.equal(bar.value, 40);
  assert.equal(label.textContent, '40%');
});

test('a notice that is not a download draws no bar', async () => {
  // A bar at zero on a condition that has no progress reads as one that has
  // stalled, which is a worse thing to tell someone than nothing.
  const b = mount();
  b.set([failure]);
  await b.render();
  const card = b.node('n-connection');
  assert.ok(!byClass(card, 'banner__progress'));
});

test('the slide is for a card arriving, not for one changing', async () => {
  // A card is rebuilt whenever anything about it moves, and a download's
  // progress moves once a percent. Animating each rebuild replayed the slide on
  // every one, which reads as the banner flickering.
  const b = mount();
  const first = { id: 'update-available', tone: 'info', message: 'Downloading', progress: 0.1, dismissible: false };
  b.set([first]);
  await b.render();
  assert.ok(b.node('n-update-available').classList.contains('banner--enter'), 'a new card did not slide');

  b.set([{ ...first, progress: 0.2 }]);
  await b.render();
  assert.ok(!b.node('n-update-available').classList.contains('banner--enter'), 'an updated card slid again');
});

test('an empty cluster reports a zero box, so the view stops eating clicks', async () => {
  // A view swallows every mouse event inside its bounds whatever is drawn there,
  // so a cluster that empties without saying so leaves an invisible strip over
  // the Control UI. The floating-cards view is sized to the reported box, so an
  // empty box is what takes the whole view away.
  const b = mount();
  b.set([failure]);
  await b.render();
  // A non-empty cluster reports a card-sized box, not the window's width.
  const populated = b.calls.bounds[b.calls.bounds.length - 1];
  assert.ok(populated && populated.width > 0 && populated.height > 0,
    'a populated cluster reported no box, so the view has nothing to size to');
  b.set([]);
  await b.render();
  assert.deepEqual(b.rows(), []);
  const empty = b.calls.bounds[b.calls.bounds.length - 1];
  assert.deepEqual({ width: empty.width, height: empty.height }, { width: 0, height: 0 },
    'an empty cluster did not report a zero box, so the view keeps eating clicks');
});
