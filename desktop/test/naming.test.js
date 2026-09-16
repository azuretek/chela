// One owner for the name, and a test that proves nothing drifted from it.
//
// `core/spec/naming.json` is where the product name and the per-client
// shorthands actually live, and every module that can import it does (through
// core/naming.js), so most of the repo cannot hold a stale copy of a name at
// all. What is left is the handful of surfaces that CANNOT import a JavaScript
// module: Electron's package.json, electron-builder's YAML, the two workflow
// display names, and the app's own pages. This file asserts those against the
// owner, one by one, so a rename fails loudly and names the file it missed
// rather than shipping a half-renamed app.
//
// Then the sweep, which is the part that catches what nobody thought of:
// every retired name anywhere in the tree has to be one of a short list of
// places that say why they hold it. A new hit is a surface a rename missed,
// which is exactly the failure the previous rename produced three times (an
// asset comment, a doc, and the README's own release filenames).
//
// Two surfaces are deliberately not asserted here, because they already have a
// better witness: `mobile/Claw/Info.plist` and the Swift mirror are asserted
// from the Swift side, where the value is used (mobile/ClawTests/
// NamingParityTests.swift), and the profile-migration constants are asserted
// through the behaviour they cause in test/profile.test.js.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as naming from '../../core/naming.js';

const DESKTOP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(DESKTOP, '..');
// Line endings are normalised because a Windows checkout gets CRLF from
// autocrlf and this file has no .gitattributes to stop it, so a regex written
// against `\n` matches there and not here. Measured: the publish-block pattern
// below passed on macOS and failed the Windows leg of CI. What these assertions
// care about is the text, not how the checkout stores its line breaks.
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8').replace(/\r\n/g, '\n');

/* ------------------------------------------------------- the non-JS surfaces */

test('Electron is given the product name, the desktop name and the repo', () => {
  const pkg = JSON.parse(read(DESKTOP, 'package.json'));

  // productName is what Electron derives userData and its app name from; the
  // profile migration in src/profile.js moves a directory to exactly this value.
  assert.equal(pkg.productName, naming.product);

  // The .desktop entry name pairs with syncDesktopName in electron-builder.yml
  // and with ENTRY in src/autostart.js, which is what ties a window to its icon.
  assert.equal(pkg.desktopName, `${naming.desktop.shorthand}.desktop`);
  assert.equal(pkg.name, naming.desktop.shorthand);

  assert.ok(pkg.repository.url.includes(naming.repo), `repository.url should name ${naming.repo}`);
  for (const key of ['homepage', 'bugs']) {
    assert.ok(JSON.stringify(pkg[key]).includes(naming.repo), `${key} should name ${naming.repo}`);
  }
});

test('electron-builder is given the same names, and its artifacts the shorthand', () => {
  const yml = read(DESKTOP, 'electron-builder.yml');
  const value = (pattern) => (yml.match(pattern) || [])[1];

  assert.equal(value(/^productName: (.+)$/m), naming.product);
  assert.equal(value(/^  shortcutName: (.+)$/m), naming.product);
  // Identity, not naming: this is what an install, an update and a Keychain
  // item are keyed to, so a rename must not move it.
  assert.equal(value(/^appId: (.+)$/m), naming.desktop.bundleId);

  const artifacts = [...yml.matchAll(/^\s+artifactName: (\S+)$/gm)].map((m) => m[1]);
  assert.equal(artifacts.length, 3, 'expected an artifactName per platform');
  for (const artifact of artifacts) {
    assert.ok(artifact.startsWith(`${naming.desktop.shorthand}-`), `${artifact} should start with the shorthand`);
    // ${version} and ${arch} are electron-builder's own interpolations and have
    // to survive in the value it is given.
    assert.match(artifact, /\$\{version\}/);
  }
});

test('the update feed reads from the repo the spec names', () => {
  const yml = read(DESKTOP, 'electron-builder.yml');
  const publish = yml.match(/^publish:\n(?:.*\n)*?  owner: (\S+)\n  repo: (\S+)$/m);
  assert.ok(publish, 'expected a publish block with owner and repo');
  assert.equal(`${publish[1]}/${publish[2]}`, naming.repo);
});

test('the workflow display names use the shorthand', () => {
  for (const [file, client] of [
    ['.github/workflows/release.yml', naming.desktop],
    ['.github/workflows/mobile-pipeline.yml', naming.mobile],
  ]) {
    const name = read(ROOT, file).match(/^name: (.+)$/m)?.[1];
    assert.ok(name, `${file} has no top-level name`);
    assert.ok(
      name.startsWith(client.shorthand),
      `${file} is displayed as "${name}", which should start with ${client.shorthand}`,
    );
  }
});

test('the app pages carry the product name the way the spec spells it', () => {
  // Every one of these pages is in core/ui now, Settings because the iOS client
  // loads that same page, and the rest because a page in desktop/src cannot
  // reach a stylesheet in core/ by a relative href that is right in both the
  // checkout and the packaged app. See the note on UI_DIR in src/main.js.
  const ui = path.join(DESKTOP, '..', 'core', 'ui');
  const pages = [
    {
      dir: ui,
      file: 'about.html',
      strings: [
        `<title>About ${naming.product}</title>`,
        `<h1 id="title">${naming.product}</h1>`,
      ],
    },
    {
      dir: ui,
      file: 'titlebar.html',
      strings: [
        `<title>${naming.product}</title>`,
        `id="label">${naming.product}<`,
      ],
    },
    { dir: ui, file: 'banner.html', strings: [`<title>${naming.product} notices</title>`] },
    {
      dir: ui,
      file: 'settings.html',
      strings: [
        `<title>${naming.product} Settings</title>`,
        `Start ${naming.product} automatically when you sign in.`,
        `so ${naming.product} knows which machine is talking`,
      ],
    },
  ];
  for (const { dir, file, strings } of pages) {
    const html = read(dir, file);
    for (const string of strings) {
      assert.ok(html.includes(string), `${file} should contain: ${string}`);
    }
  }
});

/* --------------------------------------------------------------- the sweep */

// Files that may hold a retired name, and why. Everything else in the tree is
// swept: a hit that is not here is a surface a rename missed.
const RETIRED_ALLOWED = new Map([
  ['core/spec/naming.json', 'the owner: the pinned Keychain item, the profile names to migrate from, and the retired list itself'],
  ['desktop/README.md', 'the upgrade note and the Keychain note, which explain what moved and what deliberately did not'],
  ['desktop/test/profile.test.js', 'seeds a profile under the previous name, because the chain from it is the thing under test'],
]);

// Where a name is generated rather than written: build output, dependencies, and
// the Xcode project, which xcodegen renders from project.yml.
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git', 'build-device', 'xcuserdata']);
const TEXT = /\.(js|mjs|cjs|json|md|yml|yaml|swift|html|css|sh|plist|svg|ts)$/i;

function trackedFiles(dir, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.githooks') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name) || entry.name.endsWith('.xcodeproj')) continue;
      found.push(...trackedFiles(path.join(dir, entry.name), rel));
    } else if (TEXT.test(entry.name)) {
      found.push(rel);
    }
  }
  return found;
}

let cachedFiles = null;
function tree() {
  if (!cachedFiles) cachedFiles = trackedFiles(ROOT);
  assert.ok(cachedFiles.length > 50, `expected to sweep a whole repo, saw ${cachedFiles.length} files`);
  return cachedFiles;
}

test('no file outside the allowlist still carries a retired name', () => {
  const files = tree();

  const hits = [];
  for (const file of files) {
    const body = read(ROOT, file);
    for (const retired of naming.retired) {
      if (body.includes(retired)) hits.push(`${file} (${retired})`);
    }
  }

  const unexpected = hits.filter((hit) => !RETIRED_ALLOWED.has(hit.split(' (')[0]));
  assert.deepStrictEqual(
    unexpected,
    [],
    'these files still name a retired product, so a rename missed them:\n  ' + unexpected.join('\n  '),
  );

  // A sweep that finds nothing may be looking nowhere: prove it can see, by
  // checking it found the allowlisted hits it expects.
  for (const file of RETIRED_ALLOWED.keys()) {
    assert.ok(hits.some((hit) => hit.startsWith(`${file} (`)), `the sweep should have found a retired name in ${file}`);
  }
});

// The repo slug is the other value that gets written into places which cannot
// import anything: a README clone line, a shell script's default, release-it's
// announce text. A rename that misses one sends someone to a 404, so the same
// sweep covers it. Derived values (src/main.js RELEASES_URL, .release-it.cjs)
// pass this by construction, which is the point.
test('every azuretek reference in the tree names the repo the spec names', () => {
  const wrong = [];
  for (const file of tree()) {
    for (const match of read(ROOT, file).matchAll(/azuretek\/([A-Za-z0-9._-]+)/g)) {
      // A clone URL carries the `.git` suffix; the slug does not.
      const referenced = `azuretek/${match[1].replace(/\.git$/, '')}`;
      if (referenced !== naming.repo) wrong.push(`${file} -> ${referenced}`);
    }
  }
  assert.deepStrictEqual(wrong, [], `these should name ${naming.repo}:\n  ${wrong.join('\n  ')}`);
});

test('the retired list is not empty, and never contains the current name', () => {
  assert.ok(naming.retired.length > 0, 'a rename that leaves this empty has nothing to sweep for');
  assert.ok(!naming.retired.includes(naming.product), 'the current name cannot also be retired');
});
