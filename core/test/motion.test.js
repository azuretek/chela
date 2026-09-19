// The motion rules, as the thing that makes them hold rather than as a comment.
//
// ui/CONVENTIONS.md states the rule and pins the specifics. This is the half that
// fails when the code stops following it, and there are three ways that happens
// silently:
//
//   1. An animation is added and the reduced-motion form is forgotten, which
//      produces an app that ignores the reader's preference and reports nothing.
//      Every animation is therefore asserted to have a `prefers-reduced-motion`
//      counterpart in the same stylesheet.
//   2. A duration or a curve is written as a literal in one place and as a token
//      in another, so the rule's own table and the stylesheets stop agreeing.
//      The view-change rules are asserted to use the tokens.
//   3. The document and the code drift apart, so the rule describes motion nobody
//      implements. The doc is asserted to name what the stylesheets use.
//
// Run with: cd core && npm test

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const UI = path.join(REPO, 'core', 'ui');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const UI_CSS = read(UI, 'ui.css');
const BANNER_CSS = read(UI, 'banner.css');
const SURFACE_JS = read(UI, 'surface.js');
const DOC = read(UI, 'CONVENTIONS.md');
const CORE_README = read(REPO, 'core', 'README.md');

// The minimum-visible-duration primitive itself, imported so the constant and the
// remaining-time maths are checked as code rather than described. See the section
// at the end of this file.
import { MIN_VISIBLE_MS, remainingVisibleMs, heldLongEnough } from '../ui/motion.js';
import tokenSpec from '../spec/tokens.json' with { type: 'json' };

const SHEETS = [
  ['ui.css', UI_CSS],
  ['banner.css', BANNER_CSS],
];

/**
 * The same sheets with their comments removed.
 *
 * Comments have to go before any brace matching, and not for tidiness: a comment
 * ABOVE a rule is inside the selector match, so a stray `{` or the word
 * `animation` in prose becomes a "selector" spanning half a paragraph. Measured
 * the hard way, on this file's own first run, which reported the motion section's
 * comments as twenty animated rules with no reduced-motion form.
 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const CLEAN = SHEETS.map(([name, css]) => [name, stripComments(css)]);

/** Every block whose header matches, as the text inside its braces. */
function blocks(source, header) {
  const found = [];
  let at = source.indexOf(header);
  while (at !== -1) {
    const open = source.indexOf('{', at);
    if (open === -1) break;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { found.push(source.slice(open + 1, i)); at = source.indexOf(header, i); break; }
      }
    }
    if (depth !== 0) break;
  }
  return found;
}

/** The reduce blocks, concatenated, which is what the coverage assertions read. */
const REDUCED = CLEAN.map(([, css]) => blocks(css, '@media (prefers-reduced-motion: reduce)').join('\n')).join('\n');

/** Every rule outside the reduce blocks, as `[selector, body]`. */
function animatedRules(source) {
  const withoutReduced = blocks(source, '@media (prefers-reduced-motion: reduce)')
    .reduce((text, body) => text.replace(body, ''), source);
  const withoutKeyframes = withoutReduced.replace(/@keyframes[^{]*\{[\s\S]*?\n\}/g, '');
  return [...withoutKeyframes.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => [selector.trim().replace(/\s+/g, ' '), body])
    .filter(([selector]) => selector && !selector.startsWith('@'))
    .filter(([, body]) => /(^|[;\s])animation\s*:/.test(body) && !/animation\s*:\s*none/.test(body));
}

/* -------------------------------------------------- every animation is reducible */

test('every animation in the shared sheets has a reduced-motion counterpart', () => {
  // The failure this exists for is silent by construction: the animation plays,
  // nothing errors, and a reader who asked for no motion gets it anyway. So the
  // check is per selector rather than per file, and it fails naming the selector
  // that would keep moving.
  const uncovered = [];
  for (const [name, css] of CLEAN) {
    for (const [selector, body] of animatedRules(css)) {
      for (const one of selector.split(',').map((s) => s.trim())) {
        const escaped = one.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const covered = new RegExp(`${escaped}\\s*[,{]?[^{}]*\\{[^{}]*animation:\\s*none`).test(REDUCED);
        if (!covered) uncovered.push(`${name}: ${one} (${body.trim().slice(0, 60)})`);
      }
    }
  }
  assert.deepStrictEqual(
    uncovered,
    [],
    'these animate and have no `prefers-reduced-motion` form, so a reader who asked for no motion gets motion:\n'
      + uncovered.map((line) => `  - ${line}`).join('\n'),
  );
});

test('the sweep is looking at real animations, not at nothing', () => {
  // A parser that stopped matching would make the test above pass by finding no
  // animations at all, which is the way this kind of guard dies.
  const found = CLEAN.flatMap(([, css]) => animatedRules(css).map(([selector]) => selector));
  for (const expected of ['.scrim', '.modal', '.banner--enter', '.banner--leave', '.loading',
    '.editor-disclosure--arriving', '.editor-disclosure--arriving > *',
    '.editor-disclosure--leaving', '.editor-disclosure--leaving > *']) {
    assert.ok(found.includes(expected), `${expected} is no longer seen as animated, so the sweep is broken`);
  }
  assert.ok(REDUCED.includes('animation: none'), 'no reduce block was parsed at all');
});

/* --------------------------------------------------------- the pinned specifics */

test('the view-change rules use the timings the conventions pin', () => {
  // The table in ui/CONVENTIONS.md, asserted against the stylesheets: a surface
  // arrives over --duration-normal and leaves over the shorter --duration-fast, so
  // leaving is always quicker than arriving.
  const expected = [
    [CLEAN[0][1], '.scrim', '--duration-normal'],
    [CLEAN[0][1], '.modal', '--duration-normal'],
    [CLEAN[0][1], 'body.surface--leaving .scrim', '--duration-fast'],
    [CLEAN[0][1], 'body.surface--leaving .modal', '--duration-fast'],
    [CLEAN[0][1], '.panel--in-from-left', '--duration-fast'],
    [CLEAN[0][1], '.panel--in-from-right', '--duration-fast'],
    [CLEAN[1][1], '.banner--enter', '--duration-normal'],
    [CLEAN[1][1], '.banner--leave', '--duration-fast'],
    // The in-place case, added with the rule's widening. Both directions are here
    // for the reason the rule is: the departure is the half nothing navigated for,
    // and it is the half that gets left as a pop.
    [CLEAN[0][1], '.editor-disclosure--arriving', '--duration-fast'],
    [CLEAN[0][1], '.editor-disclosure--arriving > *', '--duration-fast'],
    [CLEAN[0][1], '.editor-disclosure--leaving', '--duration-fast'],
    [CLEAN[0][1], '.editor-disclosure--leaving > *', '--duration-fast'],
  ];
  for (const [css, selector, token] of expected) {
    // The rule that DECLARES the animation, not simply the first rule with this
    // selector: `.scrim` and `.modal` are laid out by one rule and set moving by
    // another, and taking the first match would read the layout rule and report
    // that nothing animates.
    // Group 2 is the body: `[,, body]`, not `[, body]`, which is group 1 and would
    // test the SELECTOR against the animation pattern and find nothing. And the
    // `none` case is excluded, because a selector can carry TWO animation rules:
    // the one that sets it moving and the reduced-motion one that stops it, which
    // sits inside a media query this scan does not skip.
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, sel]) => sel.trim().replace(/\s+/g, ' ') === selector)
      .filter(([,, body]) => /(^|[;\s])animation\s*:/.test(body) && !/animation\s*:\s*none/.test(body));
    assert.ok(rules.length > 0, `${selector} has no rule that animates, so the conventions describe something that is not there`);
    const animation = /animation\s*:\s*([^;]+)/.exec(rules[rules.length - 1][2]);
    assert.ok(
      animation[1].includes(`var(${token})`),
      `${selector} does not take its duration from ${token}: ${animation[1].trim()}`,
    );
  }
});

test('the exit curve is ours and declared in the stylesheet that uses it', () => {
  // `--motion-leave-ease` is NOT in spec/tokens.json on purpose: every value in
  // that spec is checked against the upstream checkout, so a value of ours there
  // would fail the day upstream has no such name. It lives with the other values
  // ui.css owns.
  assert.match(UI_CSS, /--motion-leave-ease:\s*cubic-bezier\(/,
    'ui.css declares no exit curve, so the leaving rules fall back to no easing');
  const spec = JSON.parse(read(REPO, 'core', 'spec', 'tokens.json'));
  const borrowed = new Set([...Object.keys(spec.shape || {})]);
  assert.ok(!borrowed.has('--motion-leave-ease'),
    'the exit curve was added to the borrowed token spec, where it is checked against upstream');
});

test('nothing animates for longer than the longer token', () => {
  // "An animation the reader can notice the length of is a delay." Read from the
  // sheets rather than from the doc, because the doc is the half that cannot fail.
  const offenders = [];
  for (const [name, css] of CLEAN) {
    for (const [selector, body] of animatedRules(css)) {
      // Only our view-change rules: the loading cover's own spinners are loops,
      // and a loop has no duration to compare.
      if (!/infinite/.test(body)) {
        for (const value of body.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)) {
          const ms = value[2] === 's' ? Number(value[1]) * 1000 : Number(value[1]);
          // The one pre-existing exception, and it is not a view change: the
          // cover's fade-in is held a beat so a connect that resolves at once
          // never flashes the cover up at all.
          if (ms > 180 && !/loading-in/.test(body)) offenders.push(`${name}: ${selector} (${value[0]})`);
        }
      }
    }
  }
  assert.deepStrictEqual(offenders, [], `these animate longer than the pinned maximum: ${offenders.join(', ')}`);
});

/* --------------------------------------------------- the page-side handshake */

/** Run surface.js against just enough of a page. */
function runSurface({ reduced = false, fast = '100ms' } = {}) {
  const classes = new Set();
  const context = {
    // `matchMedia` goes ON the window, not beside it: the script asks
    // `window.matchMedia`, so a context with it only at the top level makes the
    // page look like one that cannot read the preference at all.
    window: {
      matchMedia: (query) => ({ matches: reduced && /prefers-reduced-motion/.test(query) }),
    },
    document: {
      documentElement: {},
      body: { classList: { add: (name) => classes.add(name) } },
    },
    getComputedStyle: () => ({ getPropertyValue: (name) => (name === '--duration-fast' ? fast : '') }),
    setTimeout,
    Promise,
  };
  vm.runInNewContext(SURFACE_JS, context);
  return { surface: context.window.clawSurface, classes };
}

test('a surface leaves by asking the page, and the page says when it is done', async () => {
  const { surface, classes } = runSurface();
  assert.strictEqual(typeof surface.leave, 'function', 'the host has nothing to call');
  const started = Date.now();
  const animated = await surface.leave();
  assert.strictEqual(animated, true, 'the departure reported nothing animated');
  assert.ok(classes.has('surface--leaving'), 'the leaving class never landed, so nothing would move');
  // Bounded by the token the stylesheet declares, plus the frame of slack: a
  // surface that answers far later than this would hold a view on screen.
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 100, `the departure resolved after ${elapsed}ms, before its own duration`);
  assert.ok(elapsed < 400, `the departure took ${elapsed}ms, which is a delay rather than an animation`);
});

test('reduced motion resolves at once, and the host is told nothing moved', async () => {
  // The half that makes the preference real rather than decorative: a host that
  // waited anyway would leave a still surface on screen for a duration nothing is
  // animating, which reads as the app hanging.
  const { surface, classes } = runSurface({ reduced: true });
  assert.strictEqual(surface.reducedMotion(), true, 'the preference was not read');
  const started = Date.now();
  const animated = await surface.leave();
  assert.strictEqual(animated, false, 'a reduced-motion departure claimed to have animated');
  assert.ok(Date.now() - started < 40, 'reduced motion waited for an animation that will not run');
  assert.ok(!classes.has('surface--leaving'), 'the leaving class landed with motion turned off');
});

test('the duration comes from the stylesheet, in both units, with a fallback', () => {
  assert.strictEqual(runSurface({ fast: '100ms' }).surface.durationMs('--duration-fast'), 100);
  // `0.1s` is the same time written the other way, and a parse that dropped the
  // unit would read it as 0.1ms.
  assert.strictEqual(runSurface({ fast: '0.1s' }).surface.durationMs('--duration-fast'), 100);
  // No stylesheet, so no token: a departure must be instant rather than a surface
  // that never lets go.
  assert.strictEqual(runSurface({ fast: '' }).surface.durationMs('--duration-fast'), 100);
  assert.strictEqual(runSurface({ fast: 'nonsense' }).surface.durationMs('--duration-fast'), 100);
});

/* ---------------------------------------------------------- the doc is the rule */

test('the conventions doc names what the stylesheets actually use', () => {
  // The drift guard. A rule that lives only in the code that implements it is the
  // thing this file exists to prevent, and a doc that has stopped describing the
  // code is the same fault with the arrow reversed.
  for (const token of ['--duration-fast', '--duration-normal', '--ease-out', '--motion-leave-ease']) {
    assert.ok(DOC.includes(token), `the doc does not name ${token}, which the sheets use`);
  }
  assert.ok(DOC.includes('prefers-reduced-motion'), 'the doc does not mention the preference');
  // The core of the rule, in the doc rather than only in a commit message.
  assert.match(DOC, /never shows a view the reader did not ask for|never show the reader a view they did not ask for/i,
    'the doc does not carry the sequencing rule the motion sits under');
  // Every selector the sheets animate for a view change is described by name, so a
  // reader can find the rule for the thing they are looking at.
  for (const name of ['panel', 'scrim', 'card', 'notice card']) {
    assert.ok(DOC.toLowerCase().includes(name), `the doc does not describe what a ${name} does`);
  }
  // The widened scope, asserted as wording rather than left to a reader's memory of
  // a conversation. Each of the three claims is one a future edit could quietly drop
  // while every sheet above went on passing.
  assert.match(DOC, /any change the reader can SEE/i, 'the doc no longer says what a transition is');
  assert.match(DOC, /in-place change is NOT exempt/i,
    'the doc no longer says an in-place change is covered, which is the whole correction');
  assert.match(DOC, /BOTH directions/i, 'the doc no longer says a transition runs both ways');
  assert.ok(/expanding or collapsing in place/i.test(DOC), 'the doc does not name the form-disclosure case');
  assert.ok(DOC.includes('grid-template-rows'),
    'the doc does not describe what the disclosure\'s own height animation is');
  assert.ok(DOC.includes('--motion-rise'), 'the doc does not name the rise the panel content arrives on');
  // The audit's outcome, in the doc rather than only in a reply: the in-place
  // changes that stay still are named with their reasons, so the next reader finds
  // an answer where the rule is instead of a gap they have to guess about.
  assert.ok(DOC.includes('In-place changes that deliberately snap'),
    'the doc no longer names the in-place changes that deliberately snap');
  for (const named of ['status line', 'Retry', 'filtering', 'notice']) {
    assert.ok(DOC.includes(named), `the doc no longer gives a reason for the ${named} case`);
  }
});

/* ------------------------------------ the in-place case, in the page's half */

/**
 * The body of a top-level function, by its opening line.
 *
 * The same walk desktop/test/settings-surface.test.js and
 * desktop/test/surface-motion.test.js each carry their own copy of, and a copy here
 * for the same reason they give: these are three files asserting three different
 * claims about one source, and a shared helper would be a fourth thing to keep in
 * step.
 */
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is gone from the source`);
  const paren = source.indexOf('(', start);
  let depth = 0;
  let close = -1;
  for (let i = paren; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  assert.ok(close > 0, `${signature} has an unbalanced parameter list`);
  const open = source.indexOf('{', close);
  depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

const SETTINGS_JS = read(UI, 'settings.js');

test('the panel is asked to leave, and only then taken away', () => {
  // The page's half of the in-place rule, in the same order main.js uses for a whole
  // surface: a panel removed on the same tick as the press never paints a frame of
  // its own departure, so the animation would exist in the stylesheet and nowhere a
  // reader could see it. Measured before it was fixed: the closing press removed the
  // panel within a millisecond, and it showed as a collapse with no frames in it.
  const body = functionBody(SETTINGS_JS, 'function collapseEditor(');
  const asked = body.indexOf("classList.add('editor-disclosure--leaving')");
  assert.ok(asked >= 0, 'the panel is never asked to leave');
  // The render that takes it away is the LAST one in here and it is inside the
  // bounded wait. The earlier ones are the early returns, and those exist for the
  // two cases with no motion to play.
  const lastRender = body.lastIndexOf('render()');
  assert.ok(lastRender > asked, 'the panel is re-rendered before it has been asked to leave');
  assert.ok(body.slice(asked, lastRender).includes('setTimeout('),
    'the taking-away render is not inside the wait, so the departure cannot be seen');
  // The wait is the page's own token and not a number worked out here.
  assert.match(body, /motionMs\('--duration-fast'\)/, 'the wait does not use the pinned duration');
  assert.match(body, /if \(reducedMotion\(\)\) \{ render\(\); return; \}/,
    'reduced motion does not take the panel away on the press, so it waits for an animation that will not run');
});

test('the arrival is played once, and never with motion turned off', () => {
  const body = functionBody(SETTINGS_JS, 'function editorDisclosure(');
  assert.match(body, /if \(opening !== gw.id\) return node;/,
    'the arrival is not keyed to the press that opened it, so a re-render would replay it');
  assert.match(body, /opening = null;/, 'the arrival is not consumed');
  const reduced = body.indexOf('if (reducedMotion()) return node;');
  const added = body.indexOf("classList.add('editor-disclosure--arriving')");
  assert.ok(reduced >= 0, 'reduced motion is not handled on the arrival');
  assert.ok(added > reduced, 'the arriving class can land with motion turned off, so a reader who asked for none gets it');
  // Read from the page's own handshake rather than the media query a second time.
  assert.match(body, /reducedMotion\(\)/, 'the arrival decides about motion for itself');
});

test('the row hands over a panel only when there is one', () => {
  // The bug this exists for, measured on the second gateway: the loop runs for every
  // row, so an unconditional assignment left the handle nulled by the last row that
  // had no panel, and the closing press took the panel away on the same tick.
  assert.match(SETTINGS_JS, /if \(editor\) editorElement = editor;/,
    'the panel handle is assigned for every row, so a row with no panel nulls it');
});

test('the one layout animation is the disclosure, and it is bounded to it', () => {
  // The rule says a view's height must be final on its first frame, and the
  // disclosure's own growth is the named exception. This asserts the exception stays
  // where it was granted rather than becoming licence to animate layout.
  const open = blocks(CLEAN[0][1], '@keyframes editor-open')[0];
  const close = blocks(CLEAN[0][1], '@keyframes editor-close')[0];
  assert.ok(open && close, 'the disclosure keyframes are gone');
  for (const [name, keyframes] of [['opening', open], ['closing', close]]) {
    assert.match(keyframes, /grid-template-rows/, `the ${name} keyframes no longer move the track`);
    for (const property of ['width', 'margin', 'padding', 'position', 'top', 'left', 'transform']) {
      assert.ok(!new RegExp(`(^|[;{\\s])${property}\\s*:`).test(keyframes),
        `the disclosure's ${name} keyframes animate ${property}, which is beyond the exception`);
    }
  }
  // The content arrives on opacity and the rise, which is where every other entering
  // thing on this page arrives from.
  const content = blocks(CLEAN[0][1], '@keyframes editor-content-in')[0];
  assert.match(content, /opacity/);
  assert.match(content, /transform: translateY\(var\(--motion-rise\)\)/,
    'the panel content no longer rises into place');
  // Clipping is for the moving classes only. On the resting rule it would cut the
  // focus ring of the last control in the panel for the whole of the visit.
  const resting = /\.editor-disclosure \{([^}]*)\}/.exec(CLEAN[0][1]);
  assert.ok(resting, 'the disclosure has no resting rule, so its height is not fixed when it is still');
  assert.match(resting[1], /display:\s*grid/, 'the resting rule is not the grid the animated one measures against');
  assert.ok(!/overflow/.test(resting[1]),
    'the element at rest is a clip container, so it can cut a focus ring');
  // And the bare panel level, without which the track cannot reach zero and the
  // closing press ends in a jump of the editor's own margin, padding and border.
  assert.match(CLEAN[0][1], /\.editor-disclosure > \* \{[^}]*min-height:\s*0/,
    'the track item can no longer shrink, so the closing press ends in a jump');
  assert.match(SETTINGS_JS, /editor-disclosure__panel/,
    'the bare panel level is gone from the page, so the track floors above zero');
});

test('the doc is reachable from where the shared surface is documented', () => {
  // A conventions doc nobody links to is a file, not a convention.
  assert.ok(CORE_README.includes('ui/CONVENTIONS.md'),
    'core/README.md does not point at the conventions doc');
  // And the page-side handshake is referenced by the pages that use it, so a page
  // added later has a worked example to copy.
  for (const page of ['settings.html', 'about.html', 'pairing.html', 'loading.html']) {
    assert.ok(read(UI, page).includes('surface.js'), `${page} does not load the shared departure handshake`);
  }
});

/* --------------------------------- the minimum-visible-duration primitive */

test('the minimum-visible floor comes from the token spec, and is a real dwell', () => {
  // The constant is the spec's, not a number in the module: a second copy is the
  // drift this primitive exists to remove.
  assert.strictEqual(MIN_VISIBLE_MS, tokenSpec.motion.minVisibleMs,
    'MIN_VISIBLE_MS does not read spec/tokens.json motion.minVisibleMs');
  // It is a dwell a reader can use, and it is longer than the longest ANIMATION
  // token: the two are different questions (how long a thing STAYS versus how it
  // MOVES), and a floor shorter than a single animation would be no floor at all.
  const normalMs = parseFloat(tokenSpec.shape['--duration-normal']);
  assert.ok(MIN_VISIBLE_MS > normalMs,
    'the visible floor is not longer than --duration-normal, so it does not outlast the movement onto the state');
  assert.ok(MIN_VISIBLE_MS >= 400,
    'the visible floor is below the span of a glance that reads a short sentence');
});

test('remainingVisibleMs owes the whole floor at the start and nothing past it', () => {
  const shownAt = 1_000_000;
  // Shown this instant: the whole floor is still owed.
  assert.strictEqual(remainingVisibleMs(shownAt, 900, shownAt), 900);
  // Part-way through: exactly the remainder.
  assert.strictEqual(remainingVisibleMs(shownAt, 900, shownAt + 300), 600);
  // At the floor and past it: nothing owed, never negative.
  assert.strictEqual(remainingVisibleMs(shownAt, 900, shownAt + 900), 0);
  assert.strictEqual(remainingVisibleMs(shownAt, 900, shownAt + 5000), 0);
});

test('remainingVisibleMs is measured from when shown, not when work began', () => {
  // ★ The core of the rule: a check that took two seconds has shown nothing for two
  // seconds, so its answer, once drawn, is still owed the full floor. The function
  // takes shownAt for exactly this reason, and a caller that passed startedAt would
  // let a slow check's answer flash.
  const startedAt = 1_000_000;
  const shownAt = startedAt + 2000; // the answer only reached the screen here
  assert.strictEqual(remainingVisibleMs(shownAt, 900, shownAt), 900,
    'the floor was consumed by work that happened before the state was on screen');
});

test('remainingVisibleMs is defensive rather than throwing in a handler', () => {
  const now = 1_000_000;
  // An unusable shownAt is treated as "shown now", which owes the FULL floor: the
  // safe failure is a state held too long, never one that flashes.
  assert.strictEqual(remainingVisibleMs(undefined, 900, now), 900);
  assert.strictEqual(remainingVisibleMs(NaN, 900, now), 900);
  // A zero or negative floor is "no floor", so nothing is owed.
  assert.strictEqual(remainingVisibleMs(now, 0, now), 0);
  assert.strictEqual(remainingVisibleMs(now, -5, now), 0);
});

test('heldLongEnough is the boolean form of the same answer', () => {
  const shownAt = 1_000_000;
  assert.strictEqual(heldLongEnough(shownAt, 900, shownAt), false);
  assert.strictEqual(heldLongEnough(shownAt, 900, shownAt + 899), false);
  assert.strictEqual(heldLongEnough(shownAt, 900, shownAt + 900), true);
  assert.strictEqual(heldLongEnough(shownAt, 900, shownAt + 1500), true);
});

test('the conventions doc carries the minimum-visible-duration rule as design language', () => {
  // The drift guard for the eighth rule: a rule that lives only in the code that
  // applies it is the fault this file exists to prevent. Each claim is one a future
  // edit could quietly drop while the primitive above went on passing.
  assert.match(DOC, /minimum-visible-duration|minVisibleMs|held long enough to read/i,
    'the doc no longer names the minimum-visible-duration primitive');
  assert.ok(DOC.includes('motion.minVisibleMs'),
    'the doc does not point at the token the floor is read from');
  assert.ok(DOC.includes('core/ui/motion.js'),
    'the doc does not point at the primitive that applies the floor');
  assert.match(DOC, /how long a state STAYS, not how it MOVES/i,
    'the doc no longer distinguishes the dwell from the animation, which is the whole point');
  assert.match(DOC, /Check for updates/i,
    'the doc no longer records the fault the rule answers');
  // The rollout is proposed rather than swept, and the doc says so.
  assert.match(DOC, /Rollout is deliberate, not a sweep/i,
    'the doc no longer says the rollout is deliberate rather than a mass edit');
});
