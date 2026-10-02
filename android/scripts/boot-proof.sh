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

# The capture waits for OUR window to be the focused one, so the proof is of the
# app rather than of whatever happened to be on screen, and it is then RETRIED and
# its result checked. Both halves answer the same measured failure: on the first
# run of this workflow the shell had built, installed and launched, and the run
# went red on an adb "error: closed", which is the exec-out stream closing under a
# screencap on a loaded emulator and leaving a truncated file. Under set -e that
# is one line in the log that says nothing at all about the app.
for _ in $(seq 1 30); do
  if adb shell dumpsys window 2>/dev/null | grep -q "mCurrentFocus.*$PKG"; then
    break
  fi
  sleep 2
done

echo "== capturing"
captured=0
for attempt in 1 2 3 4 5; do
  : > "$PROOF/android-boot.png"
  adb exec-out screencap -p > "$PROOF/android-boot.png" 2>"$PROOF/capture-$attempt.err" || true
  if [ -s "$PROOF/android-boot.png" ] && file -b "$PROOF/android-boot.png" | grep -q "^PNG image data"; then
    captured=1
    break
  fi
  echo "capture attempt $attempt produced no PNG ($(wc -c < "$PROOF/android-boot.png" | tr -d " ") bytes); trying again"
  sleep 5
  adb wait-for-device || true
done
rm -f "$PROOF"/capture-*.err
ls -l "$PROOF"

if [ "$captured" != "1" ]; then
  echo "error: no PNG after 5 captures; the emulator returned nothing readable" >&2
  exit 1
fi
echo "boot proof captured at $PROOF/android-boot.png"
