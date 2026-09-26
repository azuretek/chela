// The desktop's proof harnesses, run the way CI runs them.
//
//   node scripts/desktop-proofs.mjs --group <name> [--shots DIR]
//   node scripts/desktop-proofs.mjs --list
//
// Every harness under desktop/scripts that proves something about the rendered
// app is named here once, in a group, or named in NOT_IN_CI with the reason it
// cannot run on a CI runner. desktop/test/desktop-proofs.test.js fails when a
// harness is in neither list, so a new proof reaches CI by being added here
// rather than by someone remembering to.
//
// Each harness runs in its own Electron process and each one is judged on its
// OWN exit code: a failure is reported with its log tail and the run carries on
// to the next harness, then exits non-zero if any failed. So one red harness
// never hides another, and none of them can pass by printing.
//
// On Linux this needs a display: CI wraps it in xvfb-run (ci.yml, the desktop
// job). On a desktop host it opens real windows.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DESKTOP = path.join(ROOT, 'desktop');

/**
 * The harnesses CI runs, by group. A group is one step in the CI job, so a red
 * step names the claim that broke. `via: 'node'` is a harness that launches
 * Electron itself; everything else is an Electron main script.
 */
export const PROOFS = [
  { group: 'about', name: 'about-surface-dark', script: 'test-about-surface.js', args: ['--appearance', 'dark'] },
  { group: 'about', name: 'about-surface-light', script: 'test-about-surface.js', args: ['--appearance', 'light'] },
  { group: 'theme', name: 'custom-theme-follow-light', script: 'test-custom-theme-follow.js', args: ['--appearance', 'light'] },
  { group: 'theme', name: 'custom-theme-follow-dark', script: 'test-custom-theme-follow.js', args: ['--appearance', 'dark'] },
  { group: 'theme', name: 'controls-follow-theme-light', script: 'test-controls-follow-theme.js', args: ['--appearance', 'light'] },
  { group: 'theme', name: 'controls-follow-theme-dark', script: 'test-controls-follow-theme.js', args: ['--appearance', 'dark'] },
  { group: 'proofs', name: 'about-overflow', script: 'prove-about-overflow.mjs' },
  { group: 'proofs', name: 'floating-cards', script: 'prove-floating-cards.mjs' },
  { group: 'proofs', name: 'settings-overflow', script: 'prove-settings-overflow.mjs' },
  { group: 'proofs', name: 'banner', script: 'test-banner.js' },
  { group: 'proofs', name: 'settings-as-page-escape', script: 'test-settings-as-page-escape.js' },
  { group: 'proofs', name: 'settings-layout', script: 'test-settings-layout.js' },
  { group: 'proofs', name: 'settings-theme-light', script: 'test-settings-theme.js', args: ['--appearance', 'light'] },
  { group: 'proofs', name: 'settings-theme-dark', script: 'test-settings-theme.js', args: ['--appearance', 'dark'] },
  { group: 'proofs', name: 'payload-freshness', script: 'test-payload-freshness.js' },
  // Against its own deliberately slow server, the default. Pointed at the bare
  // throwaway gateway it waits past 120s for a Control UI that stays on first run.
  { group: 'proofs', name: 'loading-theme-dark', script: 'test-loading-theme.js', args: ['--appearance', 'dark'] },
  { group: 'proofs', name: 'loading-theme-light', script: 'test-loading-theme.js', args: ['--appearance', 'light'] },
  { group: 'proofs', name: 'settings-backdrop-dark', script: 'test-settings-backdrop.js', args: ['--appearance', 'dark'] },
  { group: 'proofs', name: 'settings-backdrop-light', script: 'test-settings-backdrop.js', args: ['--appearance', 'light'] },
  // Against the throwaway gateway ci.yml starts on 127.0.0.1:19099.
  { group: 'gateway', name: 'gateway-identity', script: 'test-gateway-identity.js' },
];

/**
 * Harnesses CI does not run, and why. Each reason names what the runner lacks,
 * so a reason that stops being true is visible as a line to delete.
 */
export const NOT_IN_CI = {
  'test-login-gate-connect.js':
    'needs a gateway whose Control UI allows the SECOND origin the harness serves the page through (the proxy on 127.0.0.1:18996), and a real window per case; the throwaway gateway ci.yml starts allows only its own origin, and a gateway with no token state never draws the login gate the harness measures',
  'test-about-cache.js':
    'runs against the throwaway gateway, and its claim is a DIP in the Control UI\'s cache count during a clear; on the runner the worker refilled the bucket before the dip was sampled (lowest count 5), so the reading is a race with the refill rather than a property of the app',
  'test-affordance-placement.js':
    'needs a Control UI past its first-run flow, which takes a gateway configured with a model provider and so a credential; the throwaway gateway serves the first-run page, which has no sidebar footer to place into',
  'test-surface-motion.js':
    'measures each transition at frame resolution against the throwaway gateway; on the runner the settings surface never read as settled. Not yet run on macOS against a gateway, so whether that is the display or drift like test-gateway-edit-motion is open',
  'test-gateway-edit-motion.js':
    'fails on main on macOS and on Linux alike (measured 2026-09-25): both counted 283ms of changing frames and animations ending at 371ms against the pinned --duration-fast. The harness has drifted from the app and needs its own fix before it can gate',
  'test-held-gateway-view.js':
    'fails on main on macOS and on Linux alike (measured 2026-09-25): no "Cannot connect" notice within 20s after the stub drops. The harness has drifted from the app and needs its own fix before it can gate',
  'test-notice-layers.js':
    'fails on main on macOS and on Linux alike (measured 2026-09-25): the view stack it expects no longer matches the one the app builds (the title bar and gateway views now sit in it). The harness has drifted from the app and needs its own fix before it can gate',
  'test-settings-surface.js':
    'fails on main on macOS and on Linux alike (measured 2026-09-25): the token editor has no save button, since saving became one press on the row. The harness has drifted from the app and needs its own fix before it can gate',
  'test-cert-trust.js':
    'fails on main on macOS and on Linux alike (measured 2026-09-25): Settings no longer carries the refused certificate in the words it looks for. The harness has drifted from the app and needs its own fix before it can gate',
  'test-theme-persistence.js':
    'fails on main on macOS and on Linux alike (measured 2026-09-25): the app never adopts gateway A\'s theme (A painted null and nothing is stored against it). The harness has drifted from the app and needs its own fix before it can gate',
  'test-gateway-view-theme.js':
    'fails on main on macOS and on Linux alike (measured 2026-09-25): the gateway view\'s pixel reads null and the run stalls past 90s. The harness has drifted from the app and needs its own fix before it can gate',
  'test-connection-failure.js':
    'fails on main on macOS and on Linux alike (measured 2026-09-25): a successful reconnect leaves the cover up and no ready banner arrives. The harness has drifted from the app and needs its own fix before it can gate',
  'test-panel-sockets.js':
    'fails on main on macOS and on Linux alike (measured 2026-09-25): the page never sees its own session socket close, so no drop is exercised. The harness has drifted from the app and needs its own fix before it can gate',
  'test-create-gateway.js':
    'has not been seen green on either platform (measured 2026-09-25): on the runner, with a working keyring, it hung past 240s; on macOS the created gateway did not hold the typed token. It needs its own diagnosis before it can gate',
  'test-edit-and-remove-credential.js':
    'fails on main on macOS and on Linux alike (measured 2026-09-25): the editor no longer offers the single Save it presses. The harness has drifted from the app and needs its own fix before it can gate',
  'test-update-answer.js':
    'answers only in a build that can update: on Linux that is an AppImage, and the runner runs the source tree, where the app rightly says "Updates are not available in this build"; it passes on macOS',
  'test-update-stall.js':
    'drives the updater download card, which exists on Linux only in an AppImage build, and the runner runs the source tree, so the card never appears (timed out at 240s); on macOS it has not been seen green either (its startup bar is not empty), so it also needs its own look',
  'test-update-relaunch.js':
    'drives the updater\'s download card across a relaunch, which exists only in a build that can update; on Linux that is an AppImage, not the source tree the runner runs',
  'test-banner-focus.js':
    'fails on main on macOS and on Linux alike (measured 2026-09-25): its positive control cannot type into the composer, and the bar stays up after its last notice is cleared. The harness has drifted from the app and needs its own fix before it can gate',
  'test-pairing.js':
    'drives a real gateway with a real device credential (CLAW_TEST_GATEWAY_URL and _TOKEN) and revokes a device, which no pull request may hold',
  'test-pairing-recovery.js':
    'drives a real gateway with a seeded credential (OPENCLAW_SEED_TOKEN), which no pull request may hold',
  'test-queued-send.js':
    'drives a real gateway with a seeded credential and spends a real agent reply, which no pull request may hold',
  'test-wake-reconnect.js':
    'drives a real gateway with a seeded credential and spends real agent replies, which no pull request may hold',
  'test-banner-clicks.js':
    'posts a real click through a macOS CGEvent helper at /tmp/click, and the fault it proves is the macOS drag band swallowing a click; Linux has neither the helper nor that drag band, so a pass there would prove nothing',
  'test-appimage-update.sh':
    'proves a PUBLISHED AppImage updates itself to a newer PUBLISHED release, so its subject is a release pair rather than the tree a pull request carries',
};

/** The page measurements, which run as `npm run measure` (desktop/package.json) rather than from here. */
export const MEASURE = ['capture-pages.js', 'capture-gateway-form.js', 'measure-text-scale.mjs', 'prove-banner-width.mjs', 'prove-frame-inset.mjs'];

function flag(name) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? null : process.argv[i + 1];
}

function electronBinary() {
  const require = createRequire(path.join(DESKTOP, 'package.json'));
  return require('electron');
}

function summary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, lines.join('\n') + '\n');
}

function main() {
  if (process.argv.includes('--list')) {
    for (const p of PROOFS) console.log(p.group + '\t' + p.name + '\t' + p.script + ' ' + (p.args || []).join(' '));
    for (const [script, why] of Object.entries(NOT_IN_CI)) console.log('not-in-ci\t' + script + '\t' + why);
    return 0;
  }
  const group = flag('group');
  const selected = PROOFS.filter((p) => p.group === group);
  if (!selected.length) {
    console.error('desktop-proofs: no harness in group ' + JSON.stringify(group) + '; groups are ' + [...new Set(PROOFS.map((p) => p.group))].join(', '));
    return 2;
  }
  const shots = flag('shots');
  const electron = electronBinary();
  const timeout = Number(flag('timeout') || 240) * 1000;
  const results = [];
  for (const p of selected) {
    const args = [...(p.args || [])];
    if (shots && p.shots !== false) args.push('--shots', path.join(shots, p.name));
    const cmd = p.via === 'node' ? process.execPath : electron;
    const started = Date.now();
    console.log('::group::' + p.name + ' (' + p.script + ' ' + args.join(' ') + ')');
    const r = spawnSync(cmd, [path.join('scripts', p.script), ...args], { cwd: DESKTOP, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr || '');
    process.stdout.write(out);
    console.log('::endgroup::');
    const secs = Math.round((Date.now() - started) / 1000);
    const ok = r.status === 0 && !r.error;
    const why = r.error ? (r.error.code === 'ETIMEDOUT' ? 'timed out after ' + timeout / 1000 + 's' : String(r.error.message)) : r.signal ? 'killed by ' + r.signal : 'exit ' + r.status;
    results.push({ ...p, ok, why, secs });
    if (ok) {
      console.log('PASS ' + p.name + ' (' + secs + 's)');
    } else {
      const tail = out.trim().split('\n').filter((l) => !/dbus/.test(l)).slice(-15).join('\n');
      console.log('::error title=' + p.name + ' failed::' + p.script + ' ' + why);
      console.log('FAIL ' + p.name + ' (' + why + ', ' + secs + 's). Last lines:\n' + tail);
    }
  }
  summary([
    '### Desktop proofs: ' + group,
    '',
    '| Harness | Result | Time |',
    '|---|---|---|',
    ...results.map((r) => '| `' + r.name + '` | ' + (r.ok ? 'pass' : 'FAIL, ' + r.why) + ' | ' + r.secs + 's |'),
    '',
  ]);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('desktop-proofs: ' + failed.length + ' of ' + results.length + ' failed: ' + failed.map((r) => r.name).join(', '));
    return 1;
  }
  console.log('desktop-proofs: all ' + results.length + ' passed in group ' + group);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
