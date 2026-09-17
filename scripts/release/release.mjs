// The release entry point both interfaces' workflows call.
//
// Why it lives here rather than in an interface or in core: it is the one thing
// both workflows need, so leaving it in desktop/scripts would keep one interface
// owning what both use, and putting it in core would add I/O and a clock to a
// tree whose modules are pure on purpose. This is a consumer of core, not part of
// it: every answer it gives is core/release.js's, and the only things it owns are
// reading gh and writing a file.
//
//   node scripts/release/release.mjs assets   --version <v> [--channel dev]
//   node scripts/release/release.mjs check    --version <v> [--release <tag>] [--assets <file>]
//   node scripts/release/release.mjs manifest --version <v> --out <path>
//
// check exits 0 when the release carries every package it must, 1 when something
// is missing (naming what and whose it is), and 2 when it could not answer.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  requiredAssets, completeness, otaManifest, releaseTag,
} from '../../core/release.js';

const USAGE = [
  'release.mjs assets   --version <v> [--channel dev]',
  'release.mjs check    --version <v> [--release <tag>] [--assets <file>]',
  'release.mjs manifest --version <v> --out <path>',
].join('\n');

function arg(argv, name) {
  const at = argv.indexOf('--' + name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : null;
}

function die(message) {
  process.stdout.write('release: ' + message + '\n');
  process.exit(2);
}

// What a release has, asked of the one place that knows: the release itself.
function assetsOf(tag) {
  const result = spawnSync('gh', ['release', 'view', tag, '--json', 'assets', '--jq', '.assets[].name'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    die('could not read ' + tag + ': ' + String(result.stderr || result.error || '').trim());
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function assetsFromFile(path) {
  return readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

const argv = process.argv.slice(2);
const command = argv[0];
const rest = argv.slice(1);

if (!command) die('no command given\n' + USAGE);

if (command === 'assets') {
  const version = arg(rest, 'version');
  if (!version) die('assets needs --version');
  const channel = arg(rest, 'channel');
  const options = channel ? { channel } : undefined;
  process.stdout.write(requiredAssets(version, options).join('\n') + '\n');
  process.exit(0);
}

if (command === 'check') {
  const version = arg(rest, 'version');
  if (!version) die('check needs --version');
  const tag = arg(rest, 'release');
  const file = arg(rest, 'assets');
  if (!tag && !file) die('check needs --release <tag> or --assets <file>');
  const assets = tag ? assetsOf(tag) : assetsFromFile(file);
  const result = completeness(version, assets);
  const where = tag || file;
  if (result.complete) {
    process.stdout.write('complete: ' + releaseTag(version) + ' carries all ' + assets.length + ' assets\n');
    process.exit(0);
  }
  process.stdout.write('incomplete: ' + where + ' is missing ' + result.missing.length + ' package(s)\n');
  for (const child of Object.keys(result.missingByChild)) {
    process.stdout.write('  ' + child + ':\n');
    for (const name of result.missingByChild[child]) process.stdout.write('    ' + name + '\n');
  }
  if (result.unexpected.length) {
    process.stdout.write('  unclaimed: ' + result.unexpected.join(', ') + '\n');
  }
  process.exit(1);
}

if (command === 'manifest') {
  const version = arg(rest, 'version');
  const out = arg(rest, 'out');
  if (!version || !out) die('manifest needs --version and --out');
  writeFileSync(out, otaManifest({ version }));
  process.stdout.write('wrote ' + out + '\n');
  process.exit(0);
}

die('unknown command: ' + command + '\n' + USAGE);
