// Issue #174: both pixel lanes judge a screenshot without first asking whether the
// screen is the app's, so an environment fault is reported as the app's own: a launcher
// ANR dialog on Android, or a system surface winning the foreground on iOS. The Android
// boot script must prepare the device surface and read it back, and the iOS pixel tests
// must guard the surface before they judge a pixel. This holds both, so a rewrite cannot
// quietly drop either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('the android boot script prepares the device surface and reads it back', () => {
  const boot = read('android/scripts/boot-proof.sh');
  assert.match(boot, /settings put global hide_error_dialogs 1/, 'the boot script must hide system error dialogs on the device');
  assert.match(boot, /settings get global hide_error_dialogs/, 'the boot script must read hide_error_dialogs back, so a silent no-op fails there');
  for (const scale of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
    assert.ok(boot.includes(scale), 'the boot script must assert the ' + scale + ' is off');
  }
  assert.match(boot, /android\.intent\.action\.CLOSE_SYSTEM_DIALOGS/, "the boot script must clear another app's ANR dialog with the system's close-dialogs broadcast");
  assert.match(boot, /mCurrentFocus/, 'the boot script must wait for the app to hold input focus rather than sleep a fixed time');
});

test('a system surface is named before a pixel is judged on the iOS lane', () => {
  const guard = read('mobile/ChelaUITests/SystemSurface.swift');
  assert.match(guard, /springboard/, 'the iOS guard must ask SpringBoard for a system alert that would cover the app');
  assert.match(guard, /runningForeground/, 'the iOS guard must require the app to be frontmost');
  assert.match(guard, /failureSuffix/, 'the iOS guard must offer a suffix a capture failure can carry');
  for (const file of ['SheetBandUITests.swift', 'SurfacesHandoffUITests.swift']) {
    const source = read('mobile/ChelaUITests/' + file);
    assert.match(source, /SystemSurface\.requireOurs\(/, file + ' must guard the surface before it judges a pixel');
  }
});
