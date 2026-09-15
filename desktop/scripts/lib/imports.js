// One parser for static ESM imports, shared by the source audit
// (scripts/check-imports.js) and the packaged-artifact audit
// (scripts/check-package.js).
//
// It is deliberately regex-based rather than a full parser: the goal is to catch
// a specifier that does not resolve or a CommonJS package imported by name, not
// to understand the language. Dynamic `import()` is out of scope, because the
// faults it would hide are visible at the call site instead.

import { builtinModules } from 'node:module';

// import <clause> from '<spec>'   |   export <clause> from '<spec>'
// import '<spec>'                (side effect only)
const IMPORT_RE = /^[ \t]*(?:import|export)\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_RE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;

/** Every static import specifier in one source string, with its clause and line. */
export function importsIn(source) {
  const found = [];
  for (const re of [IMPORT_RE, SIDE_EFFECT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const sideEffect = re === SIDE_EFFECT_RE;
      const clause = sideEffect ? '' : m[1].trim();
      const spec = sideEffect ? m[1] : m[2];
      const line = source.slice(0, m.index).split('\n').length;
      found.push({ clause, spec, line });
    }
  }
  return found;
}

export const isRelative = (spec) => spec.startsWith('./') || spec.startsWith('../');

// The real builtin list, not "any bare name with no slash": that shortcut would
// treat a single-segment package like `electron-updater` as a builtin and skip
// it, which is precisely the CommonJS-named-import fault these audits exist to
// catch.
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
export const isBuiltin = (spec) => BUILTINS.has(spec);

/** The package name behind a specifier, scoped names included. */
export function packageNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}
