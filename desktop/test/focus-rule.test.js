// The focus rule: nothing takes focus unless by rule.
//
// Why this is a source guard rather than a click test. The fault Abi reported on
// 2026-09-17 ("when they pop up what I'm typing gets stopped") had NO focus call
// in it. Measured on Electron 44 that day, a WebContentsView added to the window
// and THEN loaded hands the window's keyboard to its own page the moment its
// document commits, and it keeps it; constructing the view does not do it, adding
// it to the window does not do it, hiding it does not stop it, and removing it
// afterwards drops the keyboard to nothing rather than handing it back.
//
// So what can be asserted here is the ORDER that prevents it, and the rule that
// outlives it: a surface nobody asked for is loaded OFF the window and attached
// once its document is ready, and the search that would find this again is a
// search for the order, not for focus(). desktop/scripts/test-banner-focus.js is
// the measurement (it types into a real composer while the bar comes and goes);
// this file is the guard that keeps the wiring from drifting back.
//
// Run with: cd desktop && npm test

import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = fs.readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
const UI = path.join(HERE, '..', '..', 'core', 'ui');
const CONVENTIONS = fs.readFileSync(path.join(UI, 'CONVENTIONS.md'), 'utf8');

/** One function's body, from its declaration to the first unindented close. */
function body(name, source = MAIN) {
  const start = source.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} is gone from the file this test reads`);
  const open = source.indexOf('{', start);
  let depth = 1;
  let i = open + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
    i += 1;
  }
  return source.slice(open, i);
}

test('★ the notice bar is loaded BEFORE it is put on the window', () => {
  // The whole fix, in the one place it can be checked: the order inside the create
  // path. Attaching first is what took the reader's keyboard, and it looks exactly
  // like this code did before, so the assertion names the two calls and their
  // order rather than trusting a reader to notice.
  const refresh = body('refreshBanner');
  const armed = refresh.indexOf("wc.once('dom-ready'");
  const attach = refresh.indexOf('attachReadyView(bannerView)');
  const load = refresh.indexOf("loadFile(path.join(UI_DIR, 'banner.html')");
  assert.notStrictEqual(armed, -1, 'refreshBanner no longer arms a dom-ready handler for the bar');
  assert.notStrictEqual(attach, -1, 'refreshBanner no longer attaches the bar through attachReadyView');
  assert.notStrictEqual(load, -1, 'refreshBanner no longer loads banner.html');
  // The attach is INSIDE the handler, and the handler is armed before the load is
  // asked for: so the attach runs when the document is ready rather than inline,
  // which is the whole point. Source order alone would also be satisfied by
  // attaching before loading, so the two facts are asserted together.
  assert.ok(armed < attach && attach < load,
    'the bar is no longer attached from its dom-ready handler: attaching it inline is what takes the '
    + "reader's keyboard, because a view loaded while it is on the window takes it by itself");
  // And nothing attaches it directly, which would be the same fault one line away.
  assert.ok(!/mainWindow\.contentView\.addChildView\(bannerView\)/.test(MAIN),
    'main.js attaches the banner view directly again; the only door is attachReadyView');
});

test('★ the loading cover is loaded before it is put on the window', () => {
  // The same fault on a surface that is not the banner, and the same answer: a
  // cover appearing is not an action the reader took, so it may not move the caret
  // out of the page it is covering.
  const cover = body('styleLoadingCover');
  assert.match(cover, /attachReadyView\(loadingView\)/,
    'the cover is no longer attached through attachReadyView, so it may take the keyboard again');
  const show = body('showLoadingCover');
  assert.ok(!/addChildView\(loadingView\)/.test(show),
    'showLoadingCover attaches the cover before its page loads: that is the fault, not a tidy-up');
  assert.match(show, /loadFile\(path\.join\(UI_DIR, 'loading\.html'\)/,
    'showLoadingCover no longer loads loading.html');
  // And the styling comes before the attach, so the cover's first visible frame is
  // the styled one rather than a bare page in front of the reader.
  const tokens = cover.indexOf('applyTokenCss(wc)');
  const theme = cover.indexOf('applyThemeCss(wc)');
  const attach = cover.indexOf('attachReadyView(loadingView)');
  assert.ok(tokens !== -1 && theme !== -1 && attach !== -1, 'styleLoadingCover no longer styles and attaches');
  assert.ok(tokens < theme, 'the shared token layer must go in before the live theme');
  assert.ok(theme < attach, 'the cover is put on the window before its own stylesheet, so it can paint unstyled');
});

test('★ a view that is still preparing is never restacked onto the window', () => {
  // The other way the order could be lost: restackViews is called by the cover, by
  // every overlay and on every promote, and it re-adds what it is given. If it
  // carried a view that is still loading, the load would happen ON the window and
  // the keyboard would go with it, whatever refreshBanner did.
  const restack = body('restackViews');
  assert.match(restack, /attachedViews\.has\(view\)/,
    'restackViews no longer filters on attachedViews, so it can put a half-loaded view on the window');
  const attach = body('attachReadyView');
  assert.match(attach, /addChildView\(view\)/, 'attachReadyView no longer adds the view');
  assert.match(attach, /attachedViews\.add\(view\)/, 'attachReadyView no longer records that it did');
  assert.match(attach, /restackViews\(\)/, 'attachReadyView no longer restacks, so the view could land under a modal');
});

test('a dismissal hands the keyboard back only if the bar was holding it', () => {
  // A view taken off the window while it holds the keyboard leaves the window with
  // NONE, which is a dismissal stealing the reader's focus rather than restoring
  // it. So the removal asks first, and only then puts the keyboard somewhere.
  const refresh = body('refreshBanner');
  const away = refresh.indexOf('removeChildView(view)');
  const asked = refresh.indexOf('wc.isFocused()');
  assert.notStrictEqual(away, -1, 'refreshBanner no longer removes the bar\'s view');
  assert.notStrictEqual(asked, -1,
    'the removal no longer asks whether the bar held the keyboard, so a dismissal can leave the window with none');
  assert.ok(asked < away, 'the keyboard must be asked about BEFORE the view that holds it is taken away');
});

test('no page of ours takes focus on its own', () => {
  // The rule, in the markup and in the pages: no autofocus attribute, and the
  // notice page never calls focus or select on anything. A surface the reader
  // opened takes the keyboard by an explicit call in the host, which is where that
  // belongs; a page that reaches for it is a page that takes it whenever it feels
  // like it.
  for (const file of fs.readdirSync(UI).filter((f) => f.endsWith('.html'))) {
    const text = fs.readFileSync(path.join(UI, file), 'utf8');
    assert.ok(!/autofocus/i.test(text), `${file} carries an autofocus, which takes focus with no reader action`);
  }
  const bannerJs = fs.readFileSync(path.join(UI, 'banner.js'), 'utf8');
  assert.ok(!/\.focus\(|\.select\(/.test(bannerJs),
    'banner.js calls focus() or select() on something: the bar may not take the keyboard, however it is worded');
});

test('★ the rule is written down, in Abi\'s words and with its audit', () => {
  // The third fault in this one area, so the rule has to outlive the fix: a source
  // guard stops the wiring drifting, and this stops the REASON being lost, which is
  // what happened to the first two.
  assert.match(CONVENTIONS, /nothing takes focus unless by rule/,
    'CONVENTIONS.md no longer states the rule in the words it was given in');
  assert.match(CONVENTIONS, /MAY take focus/, 'the rule no longer says what may take focus');
  assert.match(CONVENTIONS, /MAY NOT take focus/, 'the rule no longer says what may not');
  assert.match(CONVENTIONS, /attachReadyView/,
    'the rule no longer names the mechanism, so the next reader will look for a focus() call and find none');
  // And the audit, so a new focus call has somewhere to be added rather than being
  // discovered by a report. Every host call site this repo has is named there.
  for (const site of ['showMainWindow()', 'openOverlay()', 'closeOverlay()', 'hideLoadingCover()', 'refreshBanner()']) {
    assert.ok(CONVENTIONS.includes(site),
      `CONVENTIONS.md's audit does not mention ${site}, so a call site can be added without being accounted for`);
  }
});
