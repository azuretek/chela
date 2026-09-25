// Every spec is classified, and the classification is checked.
//
// A spec in core/spec/ is consumed in one of three ways, and which one it is has
// to be decided rather than assumed:
//
//   mirrored   the interface ports the values as constants and a parity test
//              asserts them against this file on disk. Now the exception rather
//              than the rule: it is only right while the value has no reader that
//              can carry the file.
//
//   bundled    the interface ships the file and reads it at runtime through one
//              loader, so there is no copy to drift. This is where everything is
//              going, and where a file holding a PROGRAM has to be, because a
//              port of a script is a second copy of the program in another
//              language.
//
//   not-read   no interface here reads it at all. Said out loud rather than left
//              out, so a spec no client uses is a decision rather than an
//              oversight.
//
// This file is the inventory. A spec with no entry fails it, so its author has to
// say how it is consumed rather than leave the next reader to work it out.

import test from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPECS = path.join(HERE, '..', 'spec');
const PROJECT = path.join(HERE, '..', '..', 'mobile', 'project.yml');

// Still ported as constants, proven against the spec by a parity test. Nothing
// is left here: every spec a client reads is bundled now, and this map stays as
// the place an exception has to be declared rather than assumed.
const MIRRORED = {};

// Shipped as a resource and read at runtime through BundledSpec.
const BUNDLED = {
  'banner.json': 'read at runtime for the banner card\'s controls, their labels, the dismiss rule, the sweep and the tone icons, so both banners draw from one owner',
  'app-icons.json': 'read at runtime for the icon buckets a live accent is matched to, and the samples the Swift mirror is tested against',
  'app-settings-affordance.json': 'holds the one injected script that adds the footer control',
  'app-frame-inset.json': 'holds the one injected script that publishes our chrome as a frame the page overlays are clamped to',
  'wake.json': 'read at runtime for the wake and reconnect transition table, so sleep, wake, network and heartbeat handling is one rule walked by both clients',
  'connection.json': 'read at runtime for the two sentences a pending row shows',
  'device-identity.json': 'holds two injected scripts, the device keypair seed and the capture',
  'feed.json': 'read at runtime for the feed path, the release-notes path, the iOS availability marker and the channel names',
  'gateway-identity.json': 'holds the signals a payload is recognised by, so "is this an OpenClaw gateway" is one answer rather than one per platform',
  'naming.json': 'read at runtime for the product name, the repo slug and each client shorthand',
  'native-control-auth.json': 'read at runtime for the global name, the client mode and the operator scopes',
  'outbox-reconcile.json': 'holds the one injected script that reconciles a queued message stuck on a live connection against the gateway record',
  'notices.json': 'read at runtime for the tone names and their sort order',
  'pairing.json': 'holds the one injected script that observes the page gateway socket for a pairing close',
  'progress.json': 'read at runtime for the milestone order, the floors and the easing constants',
  'prompt-metadata.json': 'holds the injected script that puts the client-context block on every prompt',
  'reconnect-resume-shim.json': 'holds the one injected script that strips the Control UI reconnect-resume marker from a chat.send frame before it leaves the page',
  'release.json': 'read at runtime for the release asset names the OTA install URL is built from',
  'render-ready.json': 'holds the one probe that says a loaded page has painted, which the loading cover waits on',
  'settings.json': 'travels with the shared settings page, which cannot read it at runtime itself',
  'tokens.json': 'read at runtime for the notice palettes, the card geometry, the type scale and the tone map',
  'updates.json': 'read at runtime for the check intervals; its action and outcome names are Swift enum raw values, which are compile-time',
  'upstream-reference.json': 'read at runtime by the reference page host',
};

// Read by nothing in this repo's clients.
const NOT_READ_HERE = {
  'quips.json': 'the loading quips belong to the desktop loading cover; no iOS surface draws them',
  'bootstrap-health.json': 'the crash-loop rollback is a desktop bootstrap concern (iOS cannot self-update); the desktop imports it directly as ESM, so no iOS surface ships it',
  'issue-report.json': 'the opt-out issue reporter is desktop-only (there is no iOS reporter); the desktop imports it directly as ESM, so no iOS surface ships it',
};

function specNames() {
  return readdirSync(SPECS).filter((name) => name.endsWith('.json')).sort();
}

// What the iOS app ships, read from the file that knows: its own project.
function shippedByProject() {
  const yaml = readFileSync(PROJECT, 'utf8');
  const found = new Set();
  for (const line of yaml.split('\n')) {
    const match = line.match(/^\s+-\s+path:\s+\.\.\/core\/spec\/([a-z0-9-]+\.json)\s*$/);
    if (match) found.add(match[1]);
  }
  return found;
}

test('every spec is classified exactly once, and the bundled half is what the app ships', () => {
  const names = specNames();
  assert.ok(names.length > 0, 'expected specs in core/spec');

  for (const name of names) {
    const where = [MIRRORED[name], BUNDLED[name], NOT_READ_HERE[name]].filter(Boolean);
    assert.equal(
      where.length,
      1,
      name + ' must be classified exactly once, in MIRRORED, BUNDLED or NOT_READ_HERE, with a reason: a value can be mirrored and compared, a program has to be shipped, and a spec nothing reads has to say so.',
    );
  }
  for (const name of [...Object.keys(MIRRORED), ...Object.keys(BUNDLED), ...Object.keys(NOT_READ_HERE)]) {
    assert.ok(names.includes(name), name + ' is classified here but is not in core/spec');
  }

  // project.yml is the authority on what the app carries, so a spec this test
  // calls bundled and that file does not must fail here rather than at runtime,
  // where a missing resource is a client that silently knows less.
  assert.deepEqual(
    [...shippedByProject()].sort(),
    Object.keys(BUNDLED).sort(),
    'mobile/project.yml and this test disagree about which specs the app reads at runtime',
  );
});

test('a mirrored spec holds no program, so a mirror of it stays comparable', () => {
  for (const name of Object.keys(MIRRORED)) {
    const text = readFileSync(path.join(SPECS, name), 'utf8');
    assert.ok(
      !/"hook"\s*:/.test(text),
      name + ' now holds a script, so it cannot be mirrored any more: move it to BUNDLED and ship it.',
    );
  }
});
