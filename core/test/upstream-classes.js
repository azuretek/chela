// Reading the Control UI's own stylesheet, so our pages can be checked against
// the classes they borrow from it.
//
// This is a helper rather than a test: `node --test test/*.test.js` runs only
// the `.test.js` files, so nothing here executes on its own. It lives beside the
// guard that uses it because it is the guard's instrument, and the same
// functions are what produced the pin in core/spec/upstream-classes.json, so
// the recorded text and the checked text come from one reading of one file.
//
// Everything here is a pure function over a string, except `checkout()`, which
// locates the OpenClaw checkout and never guesses a path that does not exist.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** This repo's root, from core/test/. */
export const REPO = path.join(HERE, '..', '..');

/** The pinned reference itself. */
export const PIN = path.join(REPO, 'core', 'spec', 'upstream-reference.json');

/** The XML/HTML entity the back control's label and the esc chip carry. */
export const CLASSES_UI = path.join(REPO, 'core', 'ui');

/**
 * Where the OpenClaw checkout is, and whether it is readable.
 *
 * The checkout is NOT vendored here and must not be: it is upstream's, it is
 * read-only, and a copy of its stylesheet in this repo would be a second owner
 * of it that goes stale silently. So the guard needs a directory. `$CLAW_OPENCLAW_UI`
 * overrides it, and the default is the fleet convention (`~/src/<repo>`), not an
 * absolute path belonging to one machine.
 */
export function checkout() {
  const override = process.env.CLAW_OPENCLAW_UI;
  const dir = override ? path.resolve(override) : path.join(os.homedir(), 'src', 'openclaw', 'ui');
  let present = false;
  try {
    present = fs.statSync(dir).isDirectory();
  } catch {
    present = false;
  }
  return { dir, present, source: override ? 'CLAW_OPENCLAW_UI' : 'default (~/src/openclaw/ui)' };
}

/** The pin, parsed. Throws rather than returning a partial object. */
export function readPin(file = PIN) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** CSS with its comments removed, so a brace inside a comment cannot move a rule. */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every TOP-LEVEL rule in a stylesheet, as `{ selector, body }`.
 *
 * Rules inside an at-rule are not top-level, and that matters: the same
 * selector is redeclared inside media queries all over upstream's sheets, and
 * the narrow-width override of `.settings-row` is a one-line rule that would
 * match first if the nesting were ignored. A rule found at depth zero is the
 * base declaration, which is what a component's shape is.
 */
export function topLevelRules(css) {
  const src = stripComments(css);
  const rules = [];
  let depth = 0;
  let pending = '';
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') {
      if (depth === 0) {
        // Find the matching close brace, so the body can be sliced in one go
        // and the loop can continue past it.
        let inner = 0;
        let end = -1;
        for (let j = i + 1; j < src.length; j += 1) {
          if (src[j] === '{') inner += 1;
          else if (src[j] === '}') {
            if (inner === 0) { end = j; break; }
            inner -= 1;
          }
        }
        if (end === -1) break;
        rules.push({ selector: pending.trim(), body: src.slice(i + 1, end) });
        i = end;
        pending = '';
        continue;
      }
      depth += 1;
      continue;
    }
    if (c === '}') { depth = Math.max(0, depth - 1); pending = ''; continue; }
    if (depth === 0) pending += c;
  }
  return rules;
}

/**
 * The base rule for one selector, or null.
 *
 * A selector list counts as a match, because upstream groups rules that share a
 * body (`.settings-row--stacked, .settings-row--stacked-on-narrow`), and a guard
 * that only matched an exact single selector would report a rule that is right
 * there as missing. Each alternative is trimmed before comparison, so the
 * spacing inside the list is not part of the identity.
 */
export function ruleBody(css, selector) {
  const found = topLevelRules(css).find((r) => r.selector
    .split(',')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .includes(selector));
  return found ? found.body : null;
}

/**
 * A declaration list reduced to one canonical form.
 *
 * Whitespace is collapsed and comments are gone, so a reformat upstream (or a
 * reindent here) is not a change, and the comparison is on the declarations
 * rather than on how they were typed. A property that appears twice is kept
 * twice, in order, because the later one wins and dropping it would make two
 * different rules compare equal.
 */
export function normalizeDeclarations(text) {
  return stripComments(String(text))
    .split(';')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('; ')
    .concat(';');
}

/** Our own pages and stylesheet, as one string, for the "do we use it" check. */
export function uiSources() {
  return fs.readdirSync(CLASSES_UI)
    .filter((f) => /\.(html|js|css)$/.test(f))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(CLASSES_UI, f), 'utf8') }));
}
