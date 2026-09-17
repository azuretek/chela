// The banner page.
//
// core/ui/banner.js is a browser script, so it is loaded here against a minimal
// DOM rather than required. That is worth the shim for one reason: the stack is
// rebuilt key by key so a banner that has been sitting there for an hour does
// not replay its slide every time an unrelated one appears, and the Mark all
// read row is the one node in it that is not a notice. A rebuild that treats it
// like a card either duplicates it or prunes it as a condition that passed, and
// neither shows up in a screenshot of a working banner.
//
// Run with: npm test

import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

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
    // The page reports this to main, which sizes the view to it. Any number will
    // do here; what matters is that an empty stack reports zero.
    getBoundingClientRect() { return { height: this.kids.length * 40 }; },
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
  const calls = { markAll: 0, dismissed: [], actions: [], heights: [] };
  let unread = [];

  global.document = {
    createElement: makeNode,
    getElementById: (id) => (id === 'stack' ? stack : find(stack, id)),
  };
  global.window = {
    clawDesktop: {
      notices: async () => unread,
      bannerHeight: (h) => { calls.heights.push(h); },
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
    // The stack itself, and a count over the WHOLE tree by id. The sweep row now
    // hangs inside a card, so "how many rows are there" and "is the row still in
    // the stack" became questions about the tree rather than about one level.
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
  message: 'Downloading Claw Control UI 1.0.2.',
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
  message: 'Downloading Claw Control UI 1.0.2 has stopped making progress.',
  detail: 'Nothing has arrived for 45 seconds. It has not been cancelled, so it may still finish on its own.',
  dismissible: true,
  dismissClears: true,
  action: { label: 'Open release page', command: 'update-release-page' },
};

test('a dismissible notice gets a way to close the whole bar', () => {
  const b = mount();
  b.set([failure]);
  return b.render().then(() => {
    // The row hangs inside the card rather than beside it, so the stack holds
    // cards and nothing else: see the strip guard at the end of this file for
    // why that is a hit-testing rule and not a layout preference.
    assert.deepEqual(b.rows(), ['n-connection']);
    const row = b.node('banner-actions');
    assert.ok(row, 'no way to close the whole bar was drawn');
    assert.equal(row.parent, b.node('n-connection'), 'the sweep must hang inside the last card');
  });
});

test('nothing offers to mark all read when nothing can be', async () => {
  // Otherwise the bar carries a control whose only effect is to do nothing.
  const b = mount();
  b.set([pinned]);
  await b.render();
  assert.deepEqual(b.rows(), ['n-update-available']);
});

test('the close-the-bar row lands on whichever card is last, as cards come and go', async () => {
  const b = mount();
  b.set([pinned]);
  await b.render();
  b.set([pinned, failure]);
  await b.render();
  assert.deepEqual(b.rows(), ['n-update-available', 'n-connection']);
  const row = b.node('banner-actions');
  assert.ok(row, 'the sweep row is gone');
  assert.equal(row.parent, b.node('n-connection'), 'the sweep must hang inside the LAST card');
});

test('a re-render leaves exactly one close-the-bar row', async () => {
  // The stack is rebuilt by id and this row has no notice behind it, so it is
  // the one node that could stack up unnoticed: three renders, three rows, and
  // a banner that grows every time anything else changes.
  const b = mount();
  b.set([failure]);
  await b.render();
  await b.render();
  await b.render();
  assert.equal(b.count('banner-actions'), 1, 'a re-render left more than one sweep row');
  assert.ok(b.node('n-connection'), 'and the card it sits under survives too');
});

test('pressing it marks everything read, and the card X marks only its own', async () => {
  const b = mount();
  b.set([failure]);
  await b.render();

  await b.node('banner-actions').kids[0].onclick();
  assert.equal(b.calls.markAll, 1);

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

test('the stack holds cards and nothing else, so the bar has no dead strip of its own', async () => {
  // ★ The third instance of one fault in this area, and the reason it is a guard
  // rather than a comment: the bar is drawn in a view sized to the stack, and a
  // view claims every mouse event inside its own rectangle whatever the page
  // draws there. So every child of the stack has to DRAW something. A child that
  // draws nothing is a full-width strip of the overlay's rectangle that the
  // reader sees the page through and cannot click, and that is exactly what the
  // sweep's own row was.
  //
  // Measured 2026-09-17 on the desktop: the row was correct in every other way.
  // It held the right control, it was rebuilt exactly once, it sat in the right
  // place, and a click on its empty leading half was delivered into the banner's
  // document at the root element and reached neither the control nor the page.
  // Moving the control inside the last card, which is drawn there anyway, is what
  // made that strip the page again.
  const b = mount();
  b.set([failure, pinned]);
  await b.render();
  const children = b.root().kids;
  assert.ok(children.length, 'the stack was empty, so this guard proves nothing');
  for (const child of children) {
    assert.match(String(child.className), /(^|\s)banner(\s|$)/,
      `the stack holds a ${child.tag}.${child.className}, which is not a card. Only a card draws a surface, `
      + 'so anything else is a transparent strip inside the overlay\'s own rectangle eating clicks on the page '
      + 'the reader can see through it');
  }
  const row = b.node('banner-actions');
  assert.ok(row, 'the sweep row is gone');
  assert.equal(parentClass(row), 'banner',
    'the sweep row must hang inside a card, where it costs no pixel of its own');
});

/** The first class token of a node's parent, or null when it has no parent. */
function parentClass(node) {
  return node.parent ? String(node.parent.className).split(/\s+/)[0] : null;
}

test('an empty bar reports zero height, so the view stops eating clicks', async () => {
  // A view swallows every mouse event inside its bounds whatever is drawn there,
  // so a bar that empties without saying so leaves an invisible strip over the
  // Control UI.
  const b = mount();
  b.set([failure]);
  await b.render();
  b.set([]);
  await b.render();
  assert.deepEqual(b.rows(), []);
  assert.equal(b.calls.heights[b.calls.heights.length - 1], 0);
});
