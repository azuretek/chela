import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The gateway view wears the theme's surface, and it keeps wearing it across a
// theme change. This is the CI-gating half of that claim; the visual half, read
// off the composited window, is scripts/test-gateway-view-theme.js, which needs a
// real display and so cannot run on GitHub's macOS runners (the same reason
// smoke.js does not). So the property is also asserted here, where node --test
// runs it on every leg.
//
// WHY A SOURCE ASSERTION IS THE RIGHT SHAPE HERE. main.js boots the whole app on
// import, so it cannot be imported as a unit; theme-store.test.js reads it as text
// for the same reason. The risk with a source assertion is that it passes on a
// comment, so this does not match a string: it isolates the refreshThemedPages
// function body and asserts that BOTH the gateway view and the in-flight attempt
// view are handed setBackgroundColor(currentTheme.surface) inside it. That is the
// exact repaint whose absence let the strip (top) and window follow a theme change
// while the gateway view behind the Control UI kept the old surface, which the
// reader saw as a mismatched band at the top or bottom (reported 2026-09-18, "we
// still have some color issues on the top and bottom").

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = fs.readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');

/** The body of a top-level \`function name(...) { ... }\`, braces balanced. */
function functionBody(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notStrictEqual(start, -1, 'no function ' + name + ' in main.js');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(open + 1, i); }
  }
  throw new Error('unbalanced braces in ' + name);
}

/** Comments stripped, so an assertion cannot be satisfied by prose about it. */
function code(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

test('refreshThemedPages repaints the strip surface, the one it always has', () => {
  const body = code(functionBody(MAIN_JS, 'refreshThemedPages'));
  assert.match(body, /stripView\.setBackgroundColor\(currentTheme\.surface\)/,
    'the strip lost its own surface repaint');
});

test('refreshThemedPages repaints the gateway view and the in-flight attempt', () => {
  // The regression: these were set once at createGatewayView and never moved on a
  // theme change, so the surface behind the Control UI (overscroll rubber-band, a
  // payload swap, the frame before a navigation paints) kept the old colour.
  const body = code(functionBody(MAIN_JS, 'refreshThemedPages'));
  for (const view of ['pageView', 'attemptView']) {
    assert.ok(
      referencesSurfaceRepaint(body, view),
      view + ' is not repainted to currentTheme.surface on a theme change, so the '
        + 'surface behind the Control UI keeps the old colour and reads as a band '
        + 'at the top or bottom disagreeing with the rest',
    );
  }
});

/**
 * True when the function body hands \`view\` (directly or as a loop variable that
 * iterates over it) a setBackgroundColor(currentTheme.surface). This tolerates the
 * loop form the fix uses (\`for (const v of [pageView, attemptView]) v.setBackgroundColor(...)\`)
 * as well as a direct call, so a later refactor of the same behaviour does not
 * fail a test that was really about the behaviour.
 */
function referencesSurfaceRepaint(body, view) {
  // Direct: view.setBackgroundColor(currentTheme.surface)
  const direct = new RegExp(view + '\\.setBackgroundColor\\(currentTheme\\.surface\\)');
  if (direct.test(body)) return true;
  // Loop: the view appears in an array literal that a loop variable then repaints
  // with currentTheme.surface. Require both the array membership and the repaint
  // of the loop variable, so naming the view in an unrelated array cannot pass.
  const inArray = new RegExp('\\[[^\\]]*\\b' + view + '\\b[^\\]]*\\]');
  const loopRepaint = /for\s*\(\s*(?:const|let)\s+(\w+)\s+of\s+\[[^\]]*\][\s\S]*?\1\.setBackgroundColor\(currentTheme\.surface\)/;
  return inArray.test(body) && loopRepaint.test(body);
}
