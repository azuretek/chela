// The rule that keeps a view from swallowing the notice banner's clicks.
//
// The fault this exists for came back twice, so it is worth naming precisely.
// A drag region is not a drawing: the OS never delivers a mouse-down inside one
// to any web contents, so a control under one is dead however it is painted. And
// it is registered against the WINDOW rather than against the view that declared
// it, which is the part that makes it a class rather than an incident: a page
// does not have to be on top of anything to swallow a click on something else.
// Measured 2026-09-16 on the desktop client: every page carried a 50px grab band
// across its own top, the notice banner is a separate view drawn over the page's
// top, and with the band claiming a region the banner's ✕ and Open Settings did
// nothing at their own centres while the same click a few pixels lower worked.
//
// The first fix took the region off the shared band. That stopped the bleeding
// and left the wound: nothing then stopped the NEXT page, or the next view, from
// putting a band in the same place, and the second report was exactly that, on
// the loading cover rather than on a gateway page.
//
// So the shape being enforced here is:
//
//   * exactly two selectors may claim a drag region. `.strip-body`, which IS the
//     title strip, and `.dragbar--window`, which a page opts into;
//   * the opt-in is refused when the page is presented as the window's OWN
//     content, because that presentation puts the page in a view that begins
//     below the strip, where the banner lives;
//   * the band is pinned to the top of its view and is the title bar's own
//     height, so a band that claims a region stops exactly where the strip ends
//     and cannot reach the content area at all;
//   * a page the app hosts BELOW the strip may not carry a band at all, which is
//     the loading cover.
//
// Every page in core/ui is read from the directory rather than listed here, and
// every one of them is classified by where the app actually puts its view, which
// is read out of main.js rather than restated. So a NEW page is covered the day
// it is added: if it lands in the content area and carries a band, this fails,
// and if it is given a new drag region anywhere this fails.
//
// Run with: cd desktop && npm test

import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { STRIP_HEIGHT } from '../src/chrome.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const UI = path.join(HERE, '..', '..', 'core', 'ui');

const read = (file) => fs.readFileSync(file, 'utf8');

/** Every rule in a stylesheet, at-rules walked into, comments removed. */
function rules(css) {
  const text = read(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const walk = (body) => {
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf('{', i);
      if (open === -1) break;
      const selector = body.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < body.length && depth > 0) {
        if (body[j] === '{') depth += 1;
        else if (body[j] === '}') depth -= 1;
        j += 1;
      }
      const inner = body.slice(open + 1, Math.max(open + 1, j - 1));
      if (selector.startsWith('@')) walk(inner);
      else out.push({ selector, inner });
      i = j;
    }
  };
  walk(text);
  return out;
}

/** The declarations of one rule, as a Map. Inner blocks are not expected here. */
function declarations(inner) {
  const out = new Map();
  for (const part of inner.split(';')) {
    const at = part.indexOf(':');
    if (at === -1) continue;
    out.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  return out;
}

/** The stylesheets every page links, read once, as rules with declarations. */
function pageStylesheets(pages) {
  const sheets = new Set();
  for (const page of pages) {
    for (const m of page.text.matchAll(/<link[^>]+href="([^"]+)"/g)) sheets.add(m[1]);
  }
  const all = [];
  for (const name of sheets) {
    const file = path.join(UI, name);
    if (!fs.existsSync(file)) continue;
    for (const rule of rules(file)) all.push({ ...rule, file: name, decls: declarations(rule.inner) });
  }
  return all;
}

/** A class token, so `dragbar--window` is never read as `dragbar`. */
const hasClass = (text, name) =>
  [...text.matchAll(/class="([^"]*)"/g)].some((m) => m[1].split(/\s+/).includes(name));

const pageFiles = fs.readdirSync(UI).filter((f) => f.endsWith('.html'));
const pages = pageFiles.map((name) => ({ name, text: read(path.join(UI, name)) }));
const css = pageStylesheets(pages);

test('every page of ours is read, so a new one cannot hide', () => {
  // The list is the directory, and the assertion is that it holds the pages the
  // app loads. A page added tomorrow is in this list the moment it exists.
  for (const expected of ['titlebar.html', 'loading.html', 'settings.html', 'about.html', 'pairing.html', 'banner.html', 'sweep.html']) {
    assert.ok(pageFiles.includes(expected), `${expected} is missing from ${UI}`);
  }
});

test('the app hosts a page either at the window top or below the strip', () => {
  // Where each view begins is the app's fact, not this file's, so it is read out
  // of layoutViews and asserted rather than restated. `top` is the strip's
  // height, which is where the content area -- and so the notice banner -- begins.
  const main = read(path.join(SRC, 'main.js'));
  const layout = /function layoutViews\(\)[\s\S]*?\n\}/.exec(main);
  assert.ok(layout, 'layoutViews was not found in main.js');
  const bounds = (name) => {
    const m = new RegExp(`${name}\\.setBounds\\(\\{ x: 0, y: ([^,]+),`).exec(layout[0]);
    assert.ok(m, `${name} has no setBounds in layoutViews`);
    return m[1].trim();
  };
  assert.equal(bounds('stripView'), '0', 'the title strip must begin at the window top');
  assert.equal(bounds('pageView'), 'top', 'the gateway page must begin below the strip');
  assert.equal(bounds('loadingView'), 'top', 'the loading cover must begin below the strip');
  assert.equal(bounds('bannerView'), 'top', 'the notice banner must begin below the strip');
  // ★ The sweep is a view of its own, and BOTH halves of that are the rule: it is
  // sized to the control rather than to the window, and it is placed below the
  // bar. A view claims every mouse event inside its rectangle whatever the page
  // draws there, so a sweep sized like the bar would put an inert strip of the
  // Control UI under it, which is the fault Abi reported twice.
  const sweepAt = layout[0].indexOf('if (sweepView) {');
  assert.ok(sweepAt !== -1, 'the sweep is never laid out, so nothing sizes it to the control');
  const sweepBlock = layout[0].slice(sweepAt, layout[0].indexOf('setBounds', sweepAt) + 120);
  assert.ok(sweepBlock.includes('width: w'),
    'the sweep view must be sized to the control it draws, not to the window');
  assert.ok(sweepBlock.includes('top + bannerHeight'),
    'the sweep must be placed below the bar, which is where Abi asked for it');
  assert.ok(!sweepBlock.includes('width, height'),
    'the sweep view is taking the window shape, which would make it a full-width strip');
  // Every overlay is full-window, which is why a band inside one is the title
  // bar's own rectangle rather than something 36px lower.
  const overlays = /for \(const view of overlayViews\.values\(\)\) view\.setBounds\(\{ x: 0, y: ([^,]+),/.exec(layout[0]);
  assert.ok(overlays, 'the overlay bounds were not found in layoutViews');
  assert.equal(overlays[1].trim(), '0', 'an overlay covers the whole window');
});

test('the cover begins below the strip, so a band on it would sit on the banner', () => {
  // The arithmetic the whole rule rests on, asserted rather than described: the
  // banner's band starts at `top`, and a band at the top of a view that starts
  // at `top` therefore covers the banner's own first 50px -- which is where its
  // controls are.
  const bannerTop = STRIP_HEIGHT; // layoutViews: y: top, height: min(bannerHeight, ...)
  assert.ok(bannerTop > 0, 'the content area begins at the title strip, so a cover band overlaps it');
});

test('only the title strip and the opt-in band may claim a drag region', () => {
  const region = /drag/i;
  const claiming = css.filter((rule) => {
    const value = rule.decls.get('app-region') || rule.decls.get('-webkit-app-region') || '';
    return region.test(value.replace(/^no-/, '')) && !/^no-/i.test(value);
  });
  assert.ok(claiming.length, 'no drag region exists at all; the title strip should still be one');
  for (const rule of claiming) {
    const allowed = rule.selector.includes('.strip-body') || rule.selector.includes('.dragbar--window');
    assert.ok(allowed,
      `${rule.file}: "${rule.selector}" claims a drag region. Only .strip-body (the title strip) and `
      + '.dragbar--window (a page that covers the strip) may, because a region swallows the mouse-down '
      + 'it covers in whatever view is underneath it');
  }
});

test('the opt-in is refused when the page is the window itself, not a dialog over it', () => {
  // The second instance of the same fault, and the guard is what found it: the
  // settings page is an overlay (view at window y 0) AND, on a first run, the
  // window's own content (view at y = the strip's height). In the second
  // presentation its band would sit at window y 36..72, on the banner's controls,
  // so the region is claimed only in the first.
  const optIn = css.find((rule) => rule.selector.includes('.dragbar--window')
    && (rule.decls.get('app-region') === 'drag' || rule.decls.get('-webkit-app-region') === 'drag'));
  assert.ok(optIn, 'the .dragbar--window rule no longer claims a drag region');
  assert.match(optIn.selector, /:not\(\.as-page\)/,
    'the opt-in must be refused when body carries .as-page, which settings.js sets for the presentation '
    + 'where the page IS the window and its view begins below the strip');
  // And the class that decides it is set from the one fact that also decides
  // where the card sits, so the two cannot disagree.
  const settings = read(path.join(UI, 'settings.js'));
  assert.match(settings, /if \(asPage\) document\.body\.classList\.add\('as-page'\)/,
    'settings.js must keep setting .as-page for the page presentation');
});

test('the band is the title bar rectangle, from the title bar height', () => {
  const band = css.find((rule) => rule.selector.split(',').map((s) => s.trim()).includes('.dragbar'));
  assert.ok(band, 'the .dragbar rule was not found');
  assert.equal(band.decls.get('position'), 'fixed', 'the band is positioned against its view');
  assert.equal(band.decls.get('top'), '0', 'the band is pinned to the top of its view');
  const height = band.decls.get('height') || '';
  const fallback = /var\(--strip-height,\s*(\d+)px\)/.exec(height);
  assert.ok(fallback, `.dragbar height should read var(--strip-height, <n>px), got "${height}"`);
  // The pages that never receive chrome.stripCss fall back to this literal, so
  // it is the one place the number could drift from its owner.
  assert.equal(Number(fallback[1]), STRIP_HEIGHT,
    'the band\'s fallback height must equal chrome.STRIP_HEIGHT, or a band grows past the strip and '
    + 'onto the banner in the views that never receive the injection');
});

test('a page the app hosts below the strip carries no band at all', () => {
  // The loading cover is this page. Its view begins at window y = the strip's
  // height, so a band at its top is over the banner by construction; this asserts
  // the element is not there to be given a region in the first place.
  const main = read(path.join(SRC, 'main.js'));
  const overlayPages = new Set(
    [...(/const OVERLAY_PAGES = \{([^}]*)\}/.exec(main)?.[1] || '').matchAll(/'([\w.-]+\.html)'/g)].map((m) => m[1]));
  assert.ok(overlayPages.size, 'OVERLAY_PAGES was not found in main.js');

  for (const page of pages) {
    if (page.name === 'titlebar.html') continue; // the strip itself, a drag surface by design
    if (overlayPages.has(page.name)) continue; // hosted in a full-window view, at window y 0
    assert.ok(!hasClass(page.text, 'dragbar'),
      `${page.name} is hosted below the title strip and must not carry a drag band: its view begins at `
      + 'the same y as the notice banner, so a band there lands on the banner\'s own controls');
  }
});

test('the overlay that is not a control gives the click up', () => {
  // The other half of the same rule, and the third instance of the same fault in
  // this one area: the page's grab band over the banner, then the banner itself,
  // then the banner's OWN transparent furniture.
  //
  // A drag region is one way a click is lost. A hit test is the other, and the
  // shape is inverted: a drag region must NOT be claimed over content, while here
  // the overlay's containers must GIVE the click up and only its controls may
  // keep it. Two declarations, one per side, and both are asserted rather than
  // described, because the stylesheet was correct-looking in each earlier
  // instance while the click was still swallowed.
  //
  // Measured 2026-09-17, on the desktop: with the containers hit-testable, a
  // click at a transparent pixel inside the banner's own rectangle was delivered
  // into the banner's document at its root element and reached nothing, and the
  // page underneath saw nothing either.
  const rules = pageStylesheets(pages.filter((p) => p.name === 'banner.html'));
  assert.ok(rules.length, 'banner.html links no stylesheet that exists');

  const off = rules.filter((rule) => rule.decls.get('pointer-events') === 'none');
  const on = rules.filter((rule) => rule.decls.get('pointer-events') === 'auto');

  // 1. Hit testing is off at the ROOT, which is the one declaration a container
  //    added tomorrow cannot escape: `pointer-events` is inherited, so a new
  //    element on this page is out of hit testing unless it asks to be in.
  const root = off.find((rule) => rule.selector.split(',')
    .some((part) => /^html\b/.test(part.trim())));
  assert.ok(root,
    'banner.css must turn hit testing OFF at the root. This page is drawn over a page it does not own, so a '
    + 'pixel of it that draws nothing is the page underneath, and one that claims the click anyway is a dead '
    + 'zone that looks live');

  // 2. The only things put back are CONTROLS. A class or an id here is the fault
  //    itself: it is a region that is not a control claiming the click.
  assert.ok(on.length, 'nothing in banner.css puts a control back, so no control on the banner could be pressed');
  const INTERACTIVE = /^(button|a|input|select|textarea|summary|\[role=)/;
  for (const rule of on) {
    for (const part of rule.selector.split(',').map((s) => s.trim()).filter(Boolean)) {
      // The subject of the selector, meaning its last compound: `... button` is a
      // control, `.banner__readall` is a region that happens to be pressable.
      const subject = part.split(/\s+/).pop();
      assert.match(subject, INTERACTIVE,
        `banner.css: "${rule.selector}" claims the click for something that is not a control. Only an `
        + 'interactive element may be hit-testable in a page drawn over another page; everything visible and '
        + 'not interactive has to let the click through');
    }
  }

  // 3. And the controls the page actually builds are among them, or a control is
  //    drawn and cannot be pressed. Read out of the page's own script rather than
  //    listed, so a control added tomorrow is covered the day it exists.
  const script = read(path.join(UI, 'banner.js'));
  const controls = [...script.matchAll(/el\('(\w+)',\s*\{[^}]*className:\s*'([\w-]+)'[^}]*onclick/g)]
    .map((m) => ({ tag: m[1], className: m[2] }));
  assert.ok(controls.length >= 2, 'only ' + controls.length + ' controls were read out of banner.js');
  // The sweep is a control of ours in a view of ours, so it obeys the same rule
  // even though it is not on the bar: its page draws one button, and buttons are
  // the elements banner.css puts back into hit testing.
  const sweepPage = pages.find((p) => p.name === 'sweep.html');
  assert.ok(sweepPage, 'core/ui/sweep.html is missing');
  assert.ok(sweepPage.text.includes('class="banner__readall"'), 'sweep.html draws no control');
  assert.ok(on.some((rule) => rule.selector.includes('button')),
    'banner.css leaves buttons out of hit testing, so the sweep page control could not be pressed');
  for (const control of controls) {
    const kept = on.some((rule) => rule.selector.split(',').some((part) => part.trim().includes(`.${control.className}`)
      || new RegExp(`(^|\\s|>)${control.tag}(\\b|\\s|:|,|$)`).test(part.trim())));
    assert.ok(kept,
      `banner.js builds a ${control.tag}.${control.className} to press, and banner.css leaves it out of hit `
      + 'testing: it would draw and could not be pressed');
  }
});

test('★ the bar paints the whole rectangle its view is sized to', () => {
  // The rule the sweep row's place depends on, and the one thing the earlier fixes
  // in this area did not have. The banner's view is sized to exactly the stack's
  // height (refreshBanner in src/main.js), and a view claims every mouse event
  // inside its own rectangle whatever the page draws there, so any pixel of that
  // rectangle left unpainted is a strip the reader can see the page through and
  // cannot click. Painting the bar is what makes a row of its own safe again:
  // every child of the stack, a card or the sweep footer, then sits on a pixel the
  // bar draws, which is why the invariant in banner.test.js is about the bar's
  // shape rather than about every child being a card.
  //
  // Asserted on the declarations rather than in a screenshot, because a stack that
  // paints and one that does not are indistinguishable until the pixel under them
  // is measured, and because the three ways it can silently stop painting are
  // exactly what is checked: a surface that is transparent or absent, a margin
  // that puts the bar's own edge inside the view, and a radius that leaves the
  // corners of the view unpainted.
  const rules = pageStylesheets(pages.filter((p) => p.name === 'banner.html'));
  const stack = rules.find((rule) => rule.selector.split(',').map((s) => s.trim()).includes('.banner-stack'));
  assert.ok(stack, 'banner.css has no .banner-stack rule');

  const background = stack.decls.get('background');
  assert.ok(background, 'the bar paints nothing: .banner-stack must carry the bar\'s own surface, or the view '
    + 'sized to it is a transparent strip eating clicks on the page underneath');
  assert.notEqual(background, 'transparent',
    'the bar\'s surface is transparent, so the view sized to it is a strip of nothing');
  const clip = stack.decls.get('background-clip');
  assert.ok(!clip || clip === 'border-box' || clip === 'padding-box',
    `the bar's surface is clipped to \"${clip}\", which does not cover its own padding: the view inside it is `
    + 'sized to the padding BOX, so anything the surface does not cover is an unpainted strip');

  // A margin is inside the view and outside the bar, and the sizing cannot know
  // about it: the one pixel band that would go on eating clicks with every check
  // in this file still passing.
  assert.equal(stack.decls.get('margin'), undefined,
    'the bar must not carry a margin: the view is sized to the stack\'s box, so a margin is an unpainted band '
    + 'inside it over the Control UI');

  // A radius rounds the bar's own corners off and leaves them unpainted, which is
  // the same fault at four pixels instead of a strip. The bar spans the window
  // under the title strip, so its corners are the window's anyway.
  assert.equal(stack.decls.get('border-radius'), undefined,
    'the bar must not be rounded: its corners would be unpainted pixels inside the view, and the bar spans '
    + 'the window, so its corners are the window\'s');
});

test('★ the sweep is a plain button in a view of its own, so it adds no dead zone', () => {
  // Abi, 2026-09-18: the Mark all read control had become a full-width row of the
  // bar that ate clicks on the Control UI where the button itself was not, and the
  // line it was moved onto did the same for the rest of that line; Abi then asked
  // for it below the card. The bar's view claims every mouse event in its
  // rectangle whatever is painted there, so ANY control sharing that view shares
  // its rectangle, and a row carrying one right-aligned button is a dead zone
  // across its empty part however it is coloured.
  //
  // ★ So the sweep is a view of its own, sized to the button: core/ui/sweep.html,
  // raised by refreshSweep in src/main.js. Three things keep it that way, and each
  // is read out of source rather than described:
  //   1. the bar's page builds no sweep at all;
  //   2. sweep.html builds exactly one control, as a <button>;
  //   3. nothing sizes it to anything but its own label.
  const bar = read(path.join(UI, 'banner.js'));
  assert.doesNotMatch(bar, /banner__readall/,
    'banner.js draws the sweep again: anything on the bar shares the bar\'s rectangle, so a control '
    + 'there makes the rest of its line a dead zone over the Control UI');
  assert.doesNotMatch(bar, /banner-actions/,
    'banner.js still builds a banner-actions row, which is the shape that ate clicks');

  const sweepPage = pages.find((p) => p.name === 'sweep.html');
  assert.ok(sweepPage, 'core/ui/sweep.html is missing');
  const buttonTags = sweepPage.text.split('<button').length - 1;
  assert.equal(buttonTags, 1, 'the sweep page must draw exactly one control');
  assert.ok(sweepPage.text.includes('class="banner__readall"'),
    'the sweep page draws a control, and it is not the sweep');

  const sheets = pageStylesheets([sweepPage]);
  const readall = sheets.find((rule) => rule.selector.split(',').map((s) => s.trim()).includes('.banner__readall'));
  assert.ok(readall, 'banner.css has no .banner__readall rule');
  // Sized to the label, because the view main raises is the button's own box: a
  // button stretched to its view would make the two chase each other.
  assert.equal(readall.decls.get('width'), 'max-content',
    'the sweep button must be sized to its label, and the view sized to the button');
  assert.notEqual(readall.decls.get('width'), '100%', 'the sweep button must not span the window width');
  assert.notEqual(readall.decls.get('flex'), '1', 'the sweep button must not grow to fill anything');
});

test('the pages that cover the strip are the ones that may move the window', () => {
  // The other side of the same rule, so the guard cannot be satisfied by simply
  // deleting every band: while an overlay covers the strip the band is the only
  // thing left to drag the window by, and each of those pages must carry one.
  const main = read(path.join(SRC, 'main.js'));
  const overlayPages = [...(/const OVERLAY_PAGES = \{([^}]*)\}/.exec(main)?.[1] || '').matchAll(/'([\w.-]+\.html)'/g)]
    .map((m) => m[1]);
  assert.deepEqual(overlayPages.slice().sort(), ['about.html', 'pairing.html', 'settings.html']);
  for (const name of overlayPages) {
    const page = pages.find((p) => p.name === name);
    assert.ok(page, `${name} is in OVERLAY_PAGES but not in ${UI}`);
    assert.ok(hasClass(page.text, 'dragbar--window'),
      `${name} covers the title strip, so it must opt into the drag band or the window cannot be moved `
      + 'while it is open');
  }
  assert.ok(hasClass(pages.find((p) => p.name === 'titlebar.html').text, 'strip-body'),
    'the title strip must keep its own drag surface');
});
