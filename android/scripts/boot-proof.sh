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
#
# ★ The instrumented tests that run after this judge the screen by its pixels, so the
# screen this script hands them must be OURS. The wait for our window to take focus and
# the close-dialogs broadcast below are this repo's own answer to a launcher ANR dialog
# holding the screen (issue #149), and the sibling app borrowed the shape. Issue #174
# adds the two settings the run depends on, each READ BACK rather than trusted: system
# error (crash and ANR) dialogs are hidden so one cannot cover the tests, and the three
# animation scales are asserted zero so a settle capture is never racing a transition.
# A setting that silently did not take fails here, in one line, rather than in a pixel
# test far from its cause.

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

# Which window holds input focus right now, as the window manager states it. Each
# poll appends it to the trace, so a wait that gives up says what held focus instead.
focus_line() { adb_bounded shell dumpsys window 2>/dev/null | grep -m1 "mCurrentFocus" | tr -d '\r' | sed 's/^ *//'; }
#
# ★ Another app's "isn't responding" dialog is cleared rather than waited out. A cold
# emulator is loaded enough that the Pixel launcher misses an input deadline now and
# then, and its ANR dialog then holds focus over our app, which is already resumed and
# drawn underneath: that is the whole of the "our window is the focused one never
# happened" failure (measured 2026-10-03, 1 boot in 20, focus trace and UI dump in the
# proof). The dialog does not go away on its own while the launcher stays stuck, and
# BACK does not dismiss it; the system's close-dialogs broadcast does. Our OWN package
# in that dialog is never cleared, because then the app is what is not responding.
focused() {
  local line
  line="$(focus_line)"
  echo "$(date -u +%H:%M:%S) ${line:-<no mCurrentFocus line>}" >> "$PROOF/focus-trace.txt"
  case "$line" in
    *"Application Not Responding: $PKG"*) return 1 ;;
    *"Application Not Responding:"*)
      echo "$(date -u +%H:%M:%S) another app's ANR dialog holds focus; closing system dialogs" >> "$PROOF/focus-trace.txt"
      adb_bounded shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
      return 1 ;;
    *"$PKG"*) return 0 ;;
    *) return 1 ;;
  esac
}

# When the focus wait gives up, keep the device's own account of why: who holds
# focus, what is resumed, whether our process is alive, and any crash or ANR.
diagnose_focus() {
  echo "== diagnosing: our window never took focus" >&2
  { echo "--- window focus"; adb_bounded shell dumpsys window 2>/dev/null | grep -E "mCurrentFocus|mFocusedApp|mFocusedWindow" | tr -d '\r'
    echo "--- resumed activities"; adb_bounded shell dumpsys activity activities 2>/dev/null | grep -E "ResumedActivity|mFocusedRootTask|topResumed" | tr -d '\r'
    echo "--- our process"; adb_bounded shell pidof "$PKG" 2>&1 | tr -d '\r' || echo "not running"
    echo "--- crash buffer"; adb_bounded logcat -d -b crash 2>&1 | tail -60
    echo "--- ANR and activity log"; adb_bounded logcat -d 2>/dev/null | grep -iE "ANR in|not responding|FATAL|ActivityTaskManager|WindowManager.*focus|$PKG" | tail -120
  } > "$PROOF/focus-diagnosis.txt" 2>&1 || true
  timeout "$ADB_TIMEOUT" adb exec-out screencap -p > "$PROOF/focus-failure.png" 2>/dev/null || true
  timeout "$ADB_TIMEOUT" adb exec-out uiautomator dump /dev/tty > "$PROOF/focus-failure-ui.xml" 2>/dev/null || true
  cat "$PROOF/focus-trace.txt" "$PROOF/focus-diagnosis.txt" >&2 || true
}
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

# The screen the instrumented tests judge must be ours, so the run depends on the system
# not raising an error dialog and on the animations being off. Both are applied here,
# before any capture, and read back: a setting that silently did not take fails here, in
# one line, rather than in a pixel test far from its cause. The emulator action sets the
# animation scales too (disable-animations in the workflow); asserting them makes the
# dependency explicit, so turning it off cannot pass unnoticed.
echo "== preparing the device's surface"
adb_bounded shell settings put global hide_error_dialogs 1
hide="$(adb_bounded shell settings get global hide_error_dialogs 2>/dev/null | tr -d '\r')"
if [ "$hide" != "1" ]; then
  echo "error: hide_error_dialogs is '$hide', not 1; a system dialog could cover the tests" >&2
  exit 1
fi
for scale in window_animation_scale transition_animation_scale animator_duration_scale; do
  value="$(adb_bounded shell settings get global "$scale" 2>/dev/null | tr -d '\r')"
  case "$value" in
    0|0.0|0.00) ;;
    *)
      echo "error: $scale is '$value', not 0; a settle capture could race an animation" >&2
      exit 1 ;;
  esac
done

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
if ! wait_for 30 2 "our window is the focused one" focused; then
  diagnose_focus
  exit 1
fi
if grep -q "closing system dialogs" "$PROOF/focus-trace.txt"; then
  echo "   (cleared another app's ANR dialog on the way)"
  cat "$PROOF/focus-trace.txt"
fi

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
