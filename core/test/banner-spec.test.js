// The two banners, held to one spec.
//
// The desktop banner (core/ui/banner.js, sweep.html, sweep.js) and the iOS banner
// (mobile/Chela/NoticeBanner.swift) are two programs in two languages drawing the
// same card. They drifted while each was right on its own terms: the phone's X
// always marked read and always said so, the desktop drew no tone icon, and the
// phone's Mark all read was bare text. core/spec/banner.json is now the one owner
// of those facts, and this file fails when either client stops drawing from it.
//
// It reads SOURCE, because that is the only place both clients can be compared
// from one runner: the Swift half is also asserted at runtime by
// mobile/ChelaTests/BannerSpecParityTests.swift.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spec from '../spec/banner.json' with { type: 'json' };
import tokens from '../spec/tokens.json' with { type: 'json' };
import { create } from '../notices.js';
import { CONTROLS, dismissCopy, sweepWanted, toneIcon, forPages } from '../banner.js';
import { checkout } from './upstream-classes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
  .map((line) => line.replace(/^\s*\/\/.*$/, '')).join('\n');

const DESKTOP_CARD = code(read('core/ui/banner.js'));
const DESKTOP_SWEEP_JS = code(read('core/ui/sweep.js'));
const DESKTOP_SWEEP_HTML = read('core/ui/sweep.html');
const IOS_CARD = code(read('mobile/Chela/NoticeBanner.swift'));
const IOS_SPEC = code(read('mobile/Chela/BannerSpec.swift'));
const IOS_BOARD = code(read('mobile/Chela/NoticeBoard.swift'));

const LABELS = [spec.dismiss.read.label, spec.dismiss.clears.label, spec.sweep.label];
const TOOLTIPS = [spec.dismiss.read.tooltip, spec.dismiss.clears.tooltip, spec.sweep.tooltip];

test('the spec says what a card draws, both dismiss meanings and the sweep', () => {
  assert.deepStrictEqual(CONTROLS, ['icon', 'message', 'detail', 'progress', 'action', 'dismiss']);
  assert.equal(spec.dismiss.shownWhen, 'dismissible');
  assert.equal(spec.dismiss.clearsWhen, 'dismissClears');
  assert.equal(spec.sweep.shownWhen, 'anyUnread');
  for (const text of [...LABELS, ...TOOLTIPS]) assert.ok(text.length > 3, `an empty string in the spec: ${text}`);
  assert.notEqual(spec.dismiss.read.label, spec.dismiss.clears.label, 'reading and clearing say the same thing');
  // The copy is true on BOTH clients, and the phone has no Problems tab.
  for (const text of TOOLTIPS) assert.doesNotMatch(text, /Problems/, 'a tooltip names a desktop-only tab');
});

test('every tone has an icon, and every icon both clients can draw', () => {
  const tones = Object.keys(tokens.tone);
  assert.deepStrictEqual(Object.keys(spec.toneIcon).sort(), [...tones].sort(), 'a tone with no icon, or an icon for no tone');
  for (const name of [...Object.values(spec.toneIcon), spec.dismiss.icon]) {
    const entry = spec.icons[name];
    assert.ok(entry, `${name} is named but not defined`);
    assert.match(entry.sfSymbol, /^[a-z.]+$/, `${name} has no SF Symbol for the phone`);
    assert.ok(entry.svg.length > 0, `${name} has no SVG for the desktop`);
  }
  assert.equal(toneIcon('error'), spec.toneIcon.error);
});

test('the icons are the Control UI\'s own, element for element', () => {
  const { dir, present } = checkout();
  assert.ok(present, `no OpenClaw checkout at ${dir}, so the icons cannot be checked against upstream`);
  const source = fs.readFileSync(path.join(dir, 'src', 'components', 'icons.ts'), 'utf8');
  const tools = fs.readFileSync(path.join(dir, 'src', 'components', 'icons-tools.ts'), 'utf8');
  for (const [attr, value] of Object.entries(spec.stroke)) {
    if (attr === 'viewBox') assert.ok(tools.includes(`viewBox="${value}"`), 'strokeIcon() no longer draws on a 24 box');
    else assert.ok(tools.includes(`${attr}="${value}"`), `strokeIcon() no longer sets ${attr}="${value}"`);
  }
  for (const [name, entry] of Object.entries(spec.icons)) {
    const start = source.indexOf(`\n  ${name}: strokeIcon(`);
    assert.notEqual(start, -1, `upstream icons.ts has no ${name}`);
    const rest = source.slice(start + 1);
    const body = rest.slice(0, rest.slice(1).search(/\n {2}[a-zA-Z]+: /) + 1);
    const parts = [...body.matchAll(/<(\w+)\s+([^>]*?)\s*\/>/g)].map(([, tag, attrs]) =>
      [tag, Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]))]);
    assert.deepStrictEqual(parts, entry.svg, `${name} is not upstream's ${name}`);
  }
});

test('the dismiss rule the controls describe is the store\'s dismiss()', () => {
  const store = create();
  store.set('plain', { message: 'Refused' });
  store.set('download', { message: 'Downloading', dismissClears: true, progress: 0.4 });
  store.set('pinned', { message: 'Pinned', dismissible: false });
  assert.deepStrictEqual(dismissCopy(store.get('plain')), spec.dismiss.read);
  assert.deepStrictEqual(dismissCopy(store.get('download')), spec.dismiss.clears);
  assert.equal(dismissCopy(store.get('pinned')), null);
  store.dismiss('plain');
  store.dismiss('download');
  assert.ok(store.get('plain') && store.get('plain').read, 'a read-meaning X did not read');
  assert.equal(store.get('download'), undefined, 'a clear-meaning X did not clear');
  assert.equal(sweepWanted([]), false);
  assert.equal(sweepWanted([store.get('pinned')]), true, 'the sweep refused a card that refuses its X');
});

test('the pages get the whole spec they draw from', () => {
  const given = forPages();
  for (const key of ['card', 'dismiss', 'sweep', 'toneIcon', 'stroke', 'icons']) {
    assert.deepStrictEqual(given[key], spec[key], `the pages are given a different ${key}`);
  }
});

test('★ the desktop banner draws from the spec and carries no copy of its own', () => {
  assert.match(DESKTOP_CARD, /api\.bannerSpec\(\)/, 'banner.js does not ask for the spec');
  assert.match(DESKTOP_CARD, /spec\.dismiss\.clears/, 'banner.js does not draw the clearing X from the spec');
  assert.match(DESKTOP_CARD, /spec\.dismiss\.read/, 'banner.js does not draw the reading X from the spec');
  assert.match(DESKTOP_CARD, /spec\.toneIcon\[notice\.tone\]/, 'banner.js draws no tone icon from the spec');
  assert.match(DESKTOP_CARD, /banner__icon/, 'banner.js draws no icon box');
  assert.match(DESKTOP_CARD, /api\.dismissNotice\(/, 'the desktop X no longer reaches the store\'s dismiss');
  // As a string literal: an identifier like dismissClears is not a copy of "Clear".
  for (const text of [...LABELS, ...TOOLTIPS]) {
    for (const quote of ["'", '"', '`']) {
      assert.ok(!DESKTOP_CARD.includes(quote + text + quote), `banner.js holds its own copy of "${text}"`);
    }
  }
  assert.ok(!DESKTOP_CARD.includes('✕'), 'banner.js draws a text X rather than the Control UI icon');
  assert.match(DESKTOP_SWEEP_JS, /spec\.sweep\.label/, 'sweep.js does not take its label from the spec');
  assert.match(DESKTOP_SWEEP_JS, /spec\.sweep\.tooltip/, 'sweep.js does not take its tooltip from the spec');
  // The page's first paint, before the spec arrives, is the spec's own words, so the
  // view is sized right the first time.
  assert.ok(DESKTOP_SWEEP_HTML.includes(`>${spec.sweep.label}</button>`), 'sweep.html carries a different label');
  assert.ok(DESKTOP_SWEEP_HTML.includes(`title="${spec.sweep.tooltip}"`), 'sweep.html carries a different tooltip');
  const main = read('desktop/src/main.js');
  assert.match(main, /bannerFacts\.sweepWanted\(/, 'the desktop sweep is not offered by the shared rule');
  assert.match(main, /'app:banner-spec'/, 'main does not hand the pages the spec');
  assert.match(read('desktop/src/preload.cjs'), /bannerSpec:/, 'the preload does not expose the spec');
});

test('★ the iOS banner draws from the same spec, with the same dismiss rule', () => {
  // The X reaches the board's dismiss, which is NoticeStore.dismiss: a
  // dismissClears notice is cleared, anything else is read.
  assert.match(IOS_CARD, /dismiss: \{ board\.dismiss\(notice\.id\) \}/, 'the iOS X does not reach the board\'s dismiss');
  assert.doesNotMatch(IOS_CARD, /board\.markRead\(/, 'the iOS X marks read whatever the notice says');
  assert.match(IOS_BOARD, /func dismiss\(_ id: String\)[\s\S]*store\.dismiss\(id\)/, 'the board does not dismiss through the store');
  assert.match(IOS_CARD, /BannerSpec\.dismissCopy\(for: notice\)/, 'the iOS X does not take its words from the spec');
  assert.match(IOS_CARD, /\.accessibilityLabel\(copy\.label\)/, 'the iOS X is not labelled from the spec');
  assert.match(IOS_CARD, /BannerSpec\.sweepWanted\(board\.unread\)/, 'the iOS sweep is not offered by the shared rule');
  assert.match(IOS_CARD, /BannerSpec\.sweep\b/, 'the iOS sweep does not take its words from the spec');
  assert.match(IOS_CARD, /BannerSpec\.toneSymbol\(notice\.tone\)/, 'the iOS tone icon is not the spec\'s');
  assert.match(IOS_CARD, /BannerSpec\.dismissSymbol/, 'the iOS X is not the spec\'s icon');
  for (const text of [...LABELS, ...TOOLTIPS]) {
    assert.ok(!IOS_CARD.includes(`"${text}"`), `NoticeBanner.swift holds its own copy of "${text}"`);
  }
  assert.doesNotMatch(IOS_CARD, /toneTint/, 'the iOS icon sits on a tinted square the Control UI does not draw');
  assert.match(IOS_SPEC, /BundledSpec\.load\("banner"/, 'BannerSpec.swift does not read the bundled spec');
});

test('★ the sweep is the same floating pill on both clients', () => {
  // The desktop pill: the card's surface, hairline, radius, shadow and blur.
  const css = read('core/ui/banner.css');
  const start = css.indexOf('.banner__readall {');
  const rule = css.slice(start, css.indexOf('}', start));
  for (const decl of ['var(--notice-surface)', 'var(--notice-border)', 'var(--notice-radius)', 'var(--notice-shadow)', 'blur(var(--notice-blur))']) {
    assert.ok(rule.includes(decl), `the desktop pill no longer draws ${decl}`);
  }
  // The phone pill: the same five, from the same card style.
  const row = IOS_CARD.slice(IOS_CARD.indexOf('struct MarkAllReadRow'));
  const body = row.slice(0, row.indexOf('\n}\n'));
  for (const piece of ['style.surface', 'style.border', 'style.radius', 'style.shadowColour', '.ultraThinMaterial']) {
    assert.ok(body.includes(piece), `the iOS pill no longer draws ${piece}`);
  }
});
