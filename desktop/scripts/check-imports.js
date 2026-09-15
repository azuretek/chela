// Static audit of every ESM import in the app's module graph.
//
// Why this exists. Three separate faults shipped a build that passed `npm test`
// (296 green) and still booted to a fatal dialog:
//
//   1. a relative specifier one level short (`../core/x.js` from src/, where the
//      module is at the repo root and needs `../../core/x.js`);
//   2. a CommonJS package imported by name (`import { autoUpdater } from
//      'electron-updater'`), which throws at link time because a CJS module
//      exposes no named ESM exports;
//   3. the shared core not being copied into the package at all.
//
// The unit tests cannot see any of them: they run under Node against the source
// tree, so a path that is wrong only once the app is packaged, or an import the
// runtime refuses to link, is invisible. This check reads the source the way the
// runtime will, and fails loudly on 1 and 2. (3 is a packaging fault, and
// scripts/check-package.js audits the built artifact for it.)
//
// It deliberately does not import the modules: importing them would execute the
// app's top-level code and need Electron. It parses the import statements.
//
//   node scripts/check-imports.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importsIn, isRelative, isBuiltin, packageNameOf } from './lib/imports.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const CORE = path.join(DESKTOP, '..', 'core');

// Electron is CommonJS, but its ESM loader synthesizes named exports for the
// main-process API (`import { app } from 'electron'` works in Electron 44,
// verified in scripts/smoke.js). It is the one package where a named import is
// correct despite the CJS package.json.
const NAMED_IMPORT_CJS_OK = new Set(['electron']);

// The app's runtime graph, plus the build scripts. `preload.cjs` is CommonJS on
// purpose and is skipped; test/ is covered by `node --test`.
function moduleFiles() {
  const roots = [
    path.join(DESKTOP, 'src'),
    CORE,
    path.join(DESKTOP, 'scripts'),
  ];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'test') continue;
        walk(full);
      } else if (/\.(m?js)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const root of roots) if (fs.existsSync(root)) walk(root);
  return out;
}

/** A package is ESM if it declares type: module, a `module` field, or an
 *  `exports` map with an `import` condition; otherwise importing it by name is
 *  unsafe. */
function packageIsEsm(spec) {
  const name = packageNameOf(spec);
  const dirs = [
    path.join(DESKTOP, 'node_modules', name),
    path.join(DESKTOP, '..', 'node_modules', name),
  ];
  const dir = dirs.find((d) => fs.existsSync(path.join(d, 'package.json')));
  if (!dir) return { unknown: true, name };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const esm = pkg.type === 'module'
      || typeof pkg.module === 'string'
      || (pkg.exports && JSON.stringify(pkg.exports).includes('"import"'));
    return { esm: Boolean(esm), name };
  } catch {
    return { unknown: true, name };
  }
}

/** When a relative import does not resolve, find the depth that does, so the
 *  report can say the fix rather than only the fault. */
function suggestFor(file, spec) {
  const base = path.basename(spec);
  const dir = path.dirname(file);
  for (let up = 1; up <= 4; up += 1) {
    const prefix = '../'.repeat(up);
    for (const rest of [spec.replace(/^(\.\.\/)+/, ''), `core/${base}`, base]) {
      const candidate = path.resolve(dir, prefix + rest);
      if (fs.existsSync(candidate)) return `${prefix}${rest}`;
    }
  }
  return null;
}

const problems = [];
const files = moduleFiles();

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(path.join(DESKTOP, '..'), file);
  for (const { clause, spec, line } of importsIn(source)) {
    if (isRelative(spec)) {
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) {
        const fix = suggestFor(file, spec);
        problems.push({
          file: rel, line, spec,
          message: `does not resolve to a file${fix ? `; did you mean '${fix}'?` : ''}`,
        });
      }
      continue;
    }
    if (isBuiltin(spec)) continue;

    if (!clause.includes('{')) continue;
    const pkg = packageIsEsm(spec);
    if (pkg.unknown) {
      problems.push({ file: rel, line, spec, message: 'package not found in node_modules' });
    } else if (!pkg.esm && !NAMED_IMPORT_CJS_OK.has(pkg.name)) {
      problems.push({
        file: rel, line, spec,
        message: `'${pkg.name}' is CommonJS and exposes no named ESM export; `
          + 'use a default import and destructure, or require() it at point of use',
      });
    }
  }
}

if (problems.length === 0) {
  console.log(`check-imports: ${files.length} files, no problems`);
  process.exit(0);
}

console.error(`check-imports: ${problems.length} problem(s) in ${files.length} files`);
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}  '${p.spec}'  ${p.message}`);
}
process.exit(1);
