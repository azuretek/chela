// The project's rule: every dialog is one of the app's own overlay pages, never
// a native one.
//
// This is a source scan rather than a behaviour test because the failure it
// guards against is silent and one line long. `dialog.showMessageBox` works,
// looks approximately right on the machine of whoever added it, and only
// afterwards turns out to be a different dialog on each platform, in the
// system's colours rather than the Control UI's, with no room for anything but
// a line of text, which is how the About box ended up native in the first
// place. Nothing at runtime objects to it, so nothing but this would notice.
//
// Run with: npm test

import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SRC = path.join(HERE, '..', 'src');
const UI = path.join(HERE, '..', '..', 'core', 'ui');
// Our own pages live in the repo's core/ui rather than beside this source.
// Settings is there because the iOS app loads that same page; the rest are there
// with it because a page in desktop/src cannot reach a stylesheet in core/ by a
// relative href that is correct in both the checkout and the packaged app, where
// packing flattens `desktop/` into the archive's root. See the note on UI_DIR in
// src/main.js.

/**
 * The one page with no script, and why. It is a title strip, drawn and sized by
 * the main process, with nothing in it to click. Every other page here has
 * controls, and a page whose script did not load is a page whose buttons do
 * nothing, which is why the rest are required to load one. The assertion below
 * fails if this page gains a script, so the list cannot go stale.
 */
const SCRIPTLESS = new Set(['titlebar.html']);

/** Every page in the pages directory, with its own text. */
function pages() {
  return fs.readdirSync(UI)
    .filter((f) => f.endsWith('.html'))
    .map((file) => ({ file, html: fs.readFileSync(path.join(UI, file), 'utf8') }));
}

// There are no exceptions. The last one was the certificate prompt, and it went
// because the failed handshake means there is often no page to lay a dialog
// over, and because a yes/no box in front of someone waiting for their app to
// open is the worst place to put a security decision. It is refused on the spot
// and settled in Settings instead; see src/certs.js.

const sourceFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));

/**
 * Source with its comments removed.
 *
 * Needed because saying why we do *not* call a thing is the point of half the
 * comments in this codebase, so scanning raw text flags the explanations along
 * with the offences. Block comments are stripped as blocks rather than by
 * matching the start of each line: a wrapped `/* ... *\/` has continuation
 * lines that begin with an ordinary word.
 */
function code(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('the app has source files to scan', () => {
  // A rename or a restructure that empties this list would turn every
  // assertion below into a test that cannot fail.
  assert.ok(sourceFiles.length >= 10, `only found ${sourceFiles.length} source files`);
});

test('nothing opens a native dialog', () => {
  for (const file of sourceFiles) {
    assert.doesNotMatch(code(path.join(SRC, file)), /dialog\.show(MessageBox|ErrorBox)/, `${file} opens a native dialog`);
  }
});

test('nothing imports Electron’s dialog module at all', () => {
  // Stronger than scanning for the call, and the reason it is worth having:
  // reaching for `dialog` is what someone does when the in-app path looks like
  // more work, and the import is the moment to notice rather than the call.
  for (const file of sourceFiles) {
    assert.doesNotMatch(code(path.join(SRC, file)), /\bdialog\b\s*[,}]/, `${file} imports dialog`);
  }
});

test('nothing uses the built-in About panel', () => {
  // Electron's `role: 'about'` cannot show the build commit, cannot say
  // anything about updating, and cannot carry a button, the two things people
  // open About to do. On Windows it did not exist before Electron 15.
  for (const file of sourceFiles) {
    assert.doesNotMatch(code(path.join(SRC, file)), /role:\s*['"]about['"]/, `${file} uses the native About panel`);
  }
});

test('every page the app can load is loadable and locked down', () => {
  // Covers the banner too, which is not an overlay but is still one of the
  // app's own pages, and fails the same two ways: no script, or an inline one
  // its own CSP then blocks. Settings is one of these too, out of the shared
  // directory, which is why both trees are read: a page that cannot load is the
  // same fault wherever it lives.
  const all = pages();
  assert.ok(all.length >= 5, `only found ${all.length} pages`);
  for (const { file, html } of all) {
    assert.match(html, /Content-Security-Policy/, `${file} has no CSP`);
    assert.doesNotMatch(html, /<script>/, `${file} has an inline script its CSP blocks`);
    // Every page is loaded into a sandboxed view with contextIsolation on (or,
    // on iOS, into a web view whose only bridge is a named message handler), so
    // its own script is the only way it can do anything at all.
    if (SCRIPTLESS.has(file)) {
      assert.doesNotMatch(html, /<script/, `${file} has a script now: take it off SCRIPTLESS`);
      continue;
    }
    const script = /<script src="([^"]+)"/.exec(html);
    assert.ok(script, `${file} loads no script`);
    assert.ok(fs.existsSync(path.join(UI, script[1])), `${file} loads a missing ${script[1]}`);
  }
});

test('every stylesheet and script a page asks for resolves beside it', () => {
  // The failure this catches is the one a move produces, and it is silent: a
  // stylesheet href that no longer points anywhere leaves an unstyled page, and
  // a script src that does leaves a page whose buttons do nothing, neither with
  // anything in the console and neither noticed by a suite that never loads the
  // page. Settings moved into core/ui while the desktop's other pages stayed, so
  // their stylesheet is now reached two directories up, which is exactly the
  // kind of href nothing else checks.
  for (const { file, html } of pages()) {
    for (const [, ref] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(https?:|data:|#)/.test(ref)) continue;
      assert.ok(fs.existsSync(path.join(UI, ref)), `${file} points at a missing ${ref}`);
    }
  }
});

test('every overlay page main.js can open exists on disk', () => {
  // main.js maps a name to a path, and a typo there is a modal that opens as a
  // blank sheet over the whole window until the watchdog tears it down. The paths
  // are built from a directory constant now rather than being bare filenames,
  // because the pages no longer share one directory, so each constant is resolved
  // here and one this test does not know about fails loudly rather than being
  // skipped.
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const block = /const OVERLAY_PAGES = \{([^}]*)\}/.exec(main);
  assert.ok(block, 'OVERLAY_PAGES not found in main.js');

  const pages = [...block[1].matchAll(/(\w+):\s*'([^']+)'/g)].map(([, name, file]) => ({ name, file }));
  assert.ok(pages.length >= 2, `expected settings and about; found ${pages.length}`);

  for (const { name, file } of pages) {
    assert.ok(fs.existsSync(path.join(UI, file)), `${name} -> ${file} is not in ${path.basename(UI)}`);
  }

  // And they are loaded out of the SHARED tree, which is the assertion this test
  // is really for. Settings is the page the iOS app also renders, so a copy of it
  // back under desktop/src would still open, still render and still be green
  // everywhere else, while being a second implementation of one surface. The
  // directory is read out of main.js rather than assumed, so moving the pages
  // again fails here rather than passing quietly.
  const dir = /const UI_DIR = path\.join\(([^)]*)\)/.exec(main);
  assert.ok(dir, 'UI_DIR not found in main.js');
  assert.ok(dir[1].includes("'core'") && dir[1].includes("'ui'"), `UI_DIR must name core/ui; got ${dir[1]}`);
});

test('the app has no modal message dialog left to reach for', () => {
  // Stronger than "not a native dialog", and a separate rule: every message the
  // app used to interrupt with is now a notice in the banner. The queue, the
  // page and the IPC pair that carried them are gone, so this guards the
  // regression of adding one back rather than raising a notice, which would
  // read as reasonable in review and quietly reintroduce a modal that steals
  // focus to say "you are up to date".
  const main = code(path.join(SRC, 'main.js'));
  assert.doesNotMatch(main, /\bshowMessage\s*\(/, 'main.js opens a modal message dialog');
  assert.ok(!fs.existsSync(path.join(UI, 'message.html')), 'ui/message.html is back');
});

test('every command a notice can name is one main knows how to run', () => {
  // A notice's button is a *string* main looks up, because the banner is a
  // sandboxed page and cannot be handed a callback. An unknown name resolves to
  // nothing on purpose, a renderer must not be able to invent commands, so a
  // typo here is not an error anywhere. It is a button that does nothing, which
  // on the "Install update" of a downloaded update is the whole feature failing
  // in silence.
  const main = code(path.join(SRC, 'main.js'));

  const lookup = /const commands = \{([\s\S]*?)\n {4}\};/.exec(main);
  assert.ok(lookup, 'the notice-action command lookup was not found');
  const known = new Set([...lookup[1].matchAll(/(?:'([^']+)'|(\w+)):/g)].map((m) => m[1] || m[2]));
  assert.ok(known.size >= 4, `only found ${known.size} commands`);

  const offered = [...main.matchAll(/command:\s*'([^']+)'/g)].map(([, c]) => c);
  assert.ok(offered.length >= 4, `only found ${offered.length} offers`);
  for (const command of offered) {
    assert.ok(known.has(command), `a notice offers '${command}', which main cannot run`);
  }
});

test('the notice banner draws above the overlays', () => {
  // The banner is the app's only way of saying anything now, so it has to be
  // visible from everywhere, including over Settings, which is exactly where
  // "the gateway is up, here is the way through" has to appear. Stacked under
  // the overlays it is drawn behind them: the notice is raised, the store says
  // so, and nothing is on screen.
  const main = code(path.join(SRC, 'main.js'));
  const order = /for \(const view of \[([^\]]*)\]\)/.exec(main);
  assert.ok(order, 'the restackViews z-order list was not found');
  const names = order[1].split(',').map((s) => s.trim());
  assert.ok(names.indexOf('bannerView') > names.indexOf('...overlayViews.values()'),
    `banner must come after the overlays; got ${names.join(', ')}`);
});
