#!/usr/bin/env bash
#
# Installs the built debug app in the running emulator, launches it, and captures a
# screenshot as the proof that the shell boots, not merely compiles.
#
# A shell that only compiles is not a shell that runs, so the boot is the acceptance
# rather than the compile. The APK is built by the workflow and this script does NOT
# rebuild it: assembling here as well made the step pay for a second full Gradle
# configuration on a runner already loaded by an emulator, and it meant the thing that
# installed was not the thing that was tested.
#
# ★ EVERY wait and every adb call here is BOUNDED, and an exhausted wait is a named
# failure. That is the fix for what actually happened on 2026-10-01: the step ran for
# its whole 45-minute budget and was cancelled, because `adb wait-for-device` has no
# timeout of its own and the emulator never answered. Under `set -e` an unbounded wait
# is a step that says nothing at all about the app, which is the worst shape a CI
# failure can take.

set -euo pipefail

PKG="com.azuretek.claw.android"
APK="${CHELA_APK:-app/build/outputs/apk/debug/app-debug.apk}"
PROOF="${CHELA_PROOF:-proof}"

# How long any single adb call may take. Generous for a loaded emulator, and far
# below the step budget, so one stuck call names itself instead of hanging the job.
ADB_TIMEOUT="${CHELA_ADB_TIMEOUT:-90}"

adb_bounded() { timeout "$ADB_TIMEOUT" adb "$@"; }

# wait_for <attempts> <seconds between> <description> <test command...>
#
# A state change ends the wait; the count is only the failsafe. An exhausted wait is a
# failure with the description in it, never a silent fall-through to the next step.
wait_for() {
  local attempts="$1"; shift
  local pause="$1"; shift
  local what="$1"; shift
  local i
  for i in $(seq 1 "$attempts"); do
    if "$@" >/dev/null 2>&1; then
      echo "   $what (after $((i * pause))s)"
      return 0
    fi
    sleep "$pause"
  done
  echo "error: $what never happened; waited $((attempts * pause))s" >&2
  return 1
}

focused() { adb_bounded shell dumpsys window 2>/dev/null | grep -q "mCurrentFocus.*$PKG"; }
boot_completed() { [ "$(adb_bounded shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; }

mkdir -p "$PROOF"

if [ ! -f "$APK" ]; then
  echo "error: $APK is missing; the build did not produce it" >&2
  exit 1
fi
ls -l "$APK"

echo "== waiting for the emulator"
if ! timeout 300 adb wait-for-device; then
  echo "error: no device answered within 300s; the emulator never came up" >&2
  exit 1
fi
wait_for 60 2 "the emulator finished booting" boot_completed

echo "== installing a fresh copy"
adb_bounded uninstall "$PKG" >/dev/null 2>&1 || true
adb_bounded install -r "$APK"

echo "== launching the app"
adb_bounded shell am start -n "$PKG/.MainActivity" | tee "$PROOF/launch.txt"

# The capture waits for OUR window to be the focused one, so the proof is of the app
# rather than of whatever happened to be on screen. That wait replaces a fixed sleep:
# a duration is a guess about how long a page takes to paint, and the focus flag is the
# state itself.
echo "== waiting for the shell to be on screen"
wait_for 30 2 "our window is the focused one" focused

echo "== capturing"
captured=0
for attempt in 1 2 3 4 5; do
  : > "$PROOF/android-boot.png"
  timeout "$ADB_TIMEOUT" adb exec-out screencap -p > "$PROOF/android-boot.png" 2>"$PROOF/capture-$attempt.err" || true
  if [ -s "$PROOF/android-boot.png" ] && file -b "$PROOF/android-boot.png" | grep -q "^PNG image data"; then
    captured=1
    break
  fi
  echo "capture attempt $attempt produced no PNG ($(wc -c < "$PROOF/android-boot.png" | tr -d " ") bytes, $(head -c 120 "$PROOF/capture-$attempt.err" | tr -d "\n") ); trying again"
  sleep 5
  timeout 60 adb wait-for-device || true
done

if [ "$captured" != "1" ]; then
  echo "error: no PNG after 5 captures; the emulator returned nothing readable" >&2
  exit 1
fi
rm -f "$PROOF"/capture-*.err
ls -l "$PROOF"
echo "boot proof captured at $PROOF/android-boot.png"
