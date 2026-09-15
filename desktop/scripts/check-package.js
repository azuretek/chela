// Audit the built artifact for the faults that only exist once it is packaged.
//
// Why this exists, and how it differs from the other two checks. `npm test` runs
// under Node against the source tree and cannot see a packaging fault.
// check-imports.js reads the source and catches a wrong-depth path and a
// CommonJS package imported by name. Neither can see the thing that actually
// broke a release: the shared core was not copied to where the packaged app
// resolves it, so the app died `ERR_MODULE_NOT_FOUND` on a user's machine while
// every test was green.
//
// This reads the built artifact directly, headlessly, so it runs on any runner
// with no display. It asserts the files the app needs are present, and then
// re-resolves every relative import in the packaged source against the package
// layout, accepting either place the runtime may look:
//
//   inside the asar          app.asar/core/config-model.js
//   beside the asar          Contents/Resources/core/config-model.js
//
// The two do not agree (Electron's ESM resolver clamps the climb at the archive
// root; the shipped app's own error climbed out to Resources), which is why
// electron-builder.yml ships core in both. This check requires it in at least
// one, so dropping it from both fails here rather than on a user's machine.
//
// Why not just boot the app: a GUI Electron app cannot be launched on GitHub's
// macOS runners (measured: zero output, no config written, 30s timeout), so a
// boot gate is not portable. scripts/smoke.js still does exactly that, and runs
// locally on every platform.
//
//   node scripts/check-package.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { importsIn, isRelative, isBuiltin } from './lib/imports.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const DIST = path.join(DESKTOP, 'dist');

// @electron/asar arrives with electron-builder; it is the same reader the packer
// used to write the archive, so listing and extracting here cannot disagree with
// what was packaged.
function loadAsar() {
  try {
    return require('@electron/asar');
  } catch (err) {
    console.error(`check-package: cannot load @electron/asar (${err.message})`);
    process.exit(1);
  }
}

/** The app.asar inside the unpacked build, wherever this platform puts it. */
function findAsar() {
  if (!fs.existsSync(DIST)) return null;
  const candidates = [];
  for (const entry of fs.readdirSync(DIST)) {
    const full = path.join(DIST, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    // mac: <dist>/mac*/X.app/Contents/Resources/app.asar
    // win/linux: <dist>/<name>-unpacked/resources/app.asar
    candidates.push(path.join(full, 'Claw Desktop.app', 'Contents', 'Resources', 'app.asar'));
    candidates.push(path.join(full, 'resources', 'app.asar'));
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

const asar = loadAsar();
const asarPath = findAsar();
if (!asarPath) {
  console.error(`check-package: no app.asar under ${DIST}; run \`npm run pack\` first`);
  process.exit(1);
}
const resourcesDir = path.dirname(asarPath);

// Normalised to '/' with a leading slash, so the asar namespace and the Resources
// sibling can be compared in one place.
const entries = new Set(asar.listPackage(asarPath).map((p) => p.replace(/\\/g, '/').replace(/^([^/])/, '/$1')));

const problems = [];
const notes = [];

/** The files a boot needs, regardless of what any import says. */
const REQUIRED = [
  '/package.json',
  '/src/main.js',
  '/src/preload.cjs',
  '/node_modules/electron-updater/package.json',
];
for (const key of REQUIRED) {
  if (!entries.has(key)) problems.push(`missing from the package: ${key}`);
}

/** The core, and which of the two worlds it landed in. */
const CORE_MODULES = ['quips.js', 'progress.js', 'connection.js', 'notices.js', 'config-model.js', 'gateway-url.js'];
const coreInAsar = CORE_MODULES.every((m) => entries.has(`/core/${m}`));
const coreInResources = CORE_MODULES.every((m) => fs.existsSync(path.join(resourcesDir, 'core', m)));
if (coreInAsar) notes.push('core present at app.asar/core');
if (coreInResources) notes.push('core present at Resources/core');
if (!coreInAsar && !coreInResources) {
  problems.push('the shared core is in neither app.asar/core nor Resources/core; the app cannot import it');
}

/** Both possible targets for a relative specifier from a packaged module. */
function candidatesFor(fromKey, spec) {
  const dir = path.posix.dirname(fromKey);
  const joined = path.posix.normalize(path.posix.join(dir, spec));
  const out = [];
  if (joined.startsWith('/')) out.push({ where: 'asar', key: joined });
  // The climb that escapes the archive: '../..' from /src lands beside app.asar.
  const stripped = spec.replace(/^(\.\.\/)+/, '');
  out.push({ where: 'resources', file: path.join(resourcesDir, stripped) });
  return out;
}

// Every packaged module, re-resolved against the package layout.
for (const key of [...entries].filter((k) => /^\/src\/.*\.js$/.test(k))) {
  const source = asar.extractFile(asarPath, key.replace(/^\//, '')).toString('utf8');
  for (const { spec, line } of importsIn(source)) {
    if (!isRelative(spec) || isBuiltin(spec)) continue;
    const ok = candidatesFor(key, spec).find((c) => (c.key ? entries.has(c.key) : fs.existsSync(c.file)));
    if (!ok) {
      problems.push(`${key}:${line}  '${spec}' resolves in neither the asar nor ${path.basename(resourcesDir)}`);
    } else {
      notes.push(`${key}:${line}  '${spec}' -> ${ok.where}`);
    }
  }
}

if (problems.length === 0) {
  const resolved = notes.filter((n) => n.includes('->')).length;
  console.log(`check-package: OK (${entries.size} entries, ${resolved} relative imports resolved, ${notes.filter((n) => n.startsWith('core present')).join(', ')})`);
  process.exit(0);
}

console.error(`check-package: ${problems.length} problem(s) in ${path.relative(DESKTOP, asarPath)}`);
for (const p of problems) console.error(`  ${p}`);
process.exit(1);
