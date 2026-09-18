// ESLint flat config for the JS platforms (core + desktop). Mobile is Swift and
// linted by SwiftLint from the root scripts, not here.
//
// Why this exists, and what it is the off-the-shelf guard FOR. A build that
// passed 296 green tests still crashed at boot with a fatal main-process dialog,
// because desktop/src/issue-reporter.js took a DEFAULT import of
// core/issue-report.js, which has only NAMED exports and no default:
//
//   import issueReport from '../../core/issue-report.js';   // no default export
//
// The ESM link fails before any code runs, so the app never starts. The unit
// tests cannot see it (they run under Node against the source tree and never link
// the packaged main-process graph), and scripts/check-imports.js audits
// specifiers and CJS-by-name but not whether an imported BINDING exists in the
// target module. eslint-plugin-import's import/default and import/named check
// exactly that binding, statically, across the whole graph. It was fixed by hand
// in b9b5112 (#29); this config is the guard that makes the class impossible to
// reintroduce silently.
//
// Run from the root:  pnpm run lint   (this is desktop+core; mobile runs beside
// it via scripts/mobile.mjs).

import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    // This config owns ONLY the import rules below. The tree carries inline
    // eslint-disable directives for other rules (no-await-in-loop, no-eval,
    // no-new-func) that belonged to a linter setup that is not this one; with no
    // rule enabling them, ESLint would flag every such directive as "unused".
    // That is noise about directives this config never asked about, so the
    // unused-directive report is off. When a broader ruleset lands, this is the
    // line to reconsider.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },

  // What is NOT source. dist/ is build output; node_modules is dependencies;
  // core/spec is JSON data, not code; the generated build-info.json cannot exist
  // in a clean tree and is stamped at pack time; the mobile tree is Swift.
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'mobile/**',
      'desktop/src/build-info.json',
    ],
  },

  // The JS surface of both packages. preload.cjs is CommonJS on purpose and is
  // handled by its own block below.
  {
    files: ['core/**/*.js', 'core/**/*.mjs', 'desktop/**/*.js', 'desktop/**/*.mjs'],
    languageOptions: {
      // Import attributes (`with { type: 'json' }`) are ES2025 syntax, and the
      // tree uses them for every JSON spec import. A lower ecmaVersion makes the
      // parser reject those lines as a syntax error, which reads as a lint
      // failure on correct code.
      ecmaVersion: 2025,
      sourceType: 'module',
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      // The resolver has to find both the relative core imports (../../core/x.js)
      // and the workspace-linked package (claw-core). Node's own resolution
      // covers both: the relative paths resolve on disk, and claw-core resolves
      // through desktop/node_modules/claw-core -> ../../core.
      'import/resolver': {
        node: {
          extensions: ['.js', '.mjs', '.json'],
        },
      },
      // A .json specifier resolves to data, not a module with named exports, so
      // it is never a candidate for import/named or import/default; listing the
      // extension here keeps the plugin from parsing JSON as JS and inventing a
      // problem. The default import of a JSON file (import spec from './x.json')
      // is legitimate and must pass.
      'import/extensions': ['.js', '.mjs'],
    },
    rules: {
      // The three that catch the boot-fatal class and its neighbours:
      //   import/default        a default import of a module with no default
      //                         export (the issue-reporter bug, exactly).
      //   import/named          a named import of a binding the target does not
      //                         export.
      //   import/no-unresolved  a specifier that resolves to nothing on disk.
      'import/default': 'error',
      'import/named': 'error',
      'import/no-unresolved': 'error',
    },
  },

  // preload.cjs is CommonJS by design (the Electron preload runs before the ESM
  // loader). It is not part of the ESM import graph these rules police, so it is
  // parsed as a script and left to Node's own require resolution.
  {
    files: ['desktop/src/preload.cjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'commonjs',
    },
  },
];
