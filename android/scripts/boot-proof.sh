#!/usr/bin/env bash
#
# Builds the debug app, installs it in the running emulator, launches it and
# captures a screenshot as the proof that the shell boots, not merely compiles.
#
# A shell that only compiles is not a shell that runs, so the boot is the
# acceptance rather than the compile. The emulator is started by the workflow
# before this runs.

set -euo pipefail

PKG="com.azuretek.claw.android"
APK="app/build/outputs/apk/debug/app-debug.apk"
PROOF="proof"

mkdir -p "$PROOF"

echo "== building the debug app"
./gradlew --no-daemon :app:assembleDebug

if [ ! -f "$APK" ]; then
  echo "error: $APK is missing; the build did not produce it" >&2
  exit 1
fi

echo "== waiting for the emulator"
adb wait-for-device
# The device is up when its boot has completed, not merely when it answers.
for _ in $(seq 1 90); do
  if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
    break
  fi
  sleep 2
done

echo "== installing a fresh copy"
adb uninstall "$PKG" >/dev/null 2>&1 || true
adb install -r "$APK"

echo "== launching the app"
adb shell am start -n "$PKG/.MainActivity" | tee "$PROOF/launch.txt"

# The web view loads the bundled page and paints it; give that a real chance
# before the capture, so the screenshot is of the page rather than of its cover.
sleep 20

echo "== capturing"
adb exec-out screencap -p > "$PROOF/android-boot.png"
ls -l "$PROOF"

# An empty capture is a failed boot, so the size is asserted rather than assumed.
test -s "$PROOF/android-boot.png"
echo "boot proof captured at $PROOF/android-boot.png"
