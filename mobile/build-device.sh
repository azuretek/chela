#!/usr/bin/env bash
#
# Build Chela and install it on a connected iPhone.
#
# Why this exists rather than a team id in project.yml: the team is a personal
# identifier, and project.yml is committed and shared. A team encoded there is a
# second place to keep in step with the Apple ID, and when it drifts the build
# fails somewhere nobody is reading. So the project stays teamless and the team
# arrives here, from the environment or a local untracked file.
#
# Usage:
#   DEVELOPMENT_TEAM=ABCDE12345 ./build-device.sh
#   echo ABCDE12345 > .team && ./build-device.sh
#   ./build-device.sh <device-udid>        # pick a device other than the first
#
# The generated project and build output are gitignored, and both are rebuilt
# here, so there is no state to keep in step by hand.

set -euo pipefail
cd "$(dirname "$0")"

# The team, in order of preference: explicit env, then the local file. The file
# exists so a repeated build is one bare command, and it is gitignored so the
# identifier never reaches the repo.
TEAM="${DEVELOPMENT_TEAM:-}"
if [ -z "$TEAM" ] && [ -f .team ]; then
  TEAM="$(tr -d '[:space:]' < .team)"
fi
if [ -z "$TEAM" ]; then
  echo "error: no Apple team id." >&2
  echo "  pass it: DEVELOPMENT_TEAM=ABCDE12345 $0" >&2
  echo "  or write it once: echo ABCDE12345 > .team   (gitignored)" >&2
  exit 1
fi

# The device: an argument if given, otherwise a physical one from the
# toolchain's own list. Picking it by `hardwareProperties.reality` rather than by
# name matters, because a simulator can carry any name and this script can only
# work on a real phone.
#
# Prints: <identifier> <tunnelState> <name>, preferring a device whose tunnel is
# already up. The state is carried out rather than filtered on, so a paired but
# unreachable phone produces a sentence naming it instead of a bare "none
# found", which is the failure that wastes the most time here.
DEVICE="${1:-}"
DEVICE_STATE="assumed"
DEVICE_NAME="$DEVICE"
if [ -z "$DEVICE" ]; then
  read -r DEVICE DEVICE_STATE DEVICE_NAME <<<"$(xcrun devicectl list devices --json-output /dev/stdout --quiet 2>/dev/null \
    | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
phones = []
for d in data.get("result", {}).get("devices", []):
    hw = d.get("hardwareProperties", {})
    cp = d.get("connectionProperties", {})
    dp = d.get("deviceProperties", {})
    if hw.get("reality") != "physical":
        continue
    if cp.get("pairingState") != "paired":
        continue
    phones.append((cp.get("tunnelState") == "connected",
                   d.get("identifier", ""),
                   cp.get("tunnelState", "unknown"),
                   dp.get("name", "")))
phones.sort(key=lambda p: not p[0])
if phones:
    _, ident, state, name = phones[0]
    print(ident, state, name)
')"
fi
if [ -z "$DEVICE" ]; then
  echo "error: no paired iPhone found. Connect one and trust it, then rerun." >&2
  exit 1
fi
# A disconnected tunnel cannot be installed to, and building for it would fail
# later with a timeout that says nothing about the real cause.
if [ "$DEVICE_STATE" != "connected" ]; then
  echo "error: $DEVICE_NAME is paired but not reachable right now (tunnel: $DEVICE_STATE)." >&2
  echo "  Plug it in or wake it, then rerun. Nothing was built." >&2
  exit 1
fi
echo "== device: $DEVICE_NAME ($DEVICE)"

# The project is generated output. Regenerating is cheap and means a stale
# checked-out copy can never be what gets built.
echo "== generating the Xcode project from project.yml"
xcodegen generate

echo "== building for the device"
xcodebuild -project Chela.xcodeproj -scheme Chela \
  -destination "platform=iOS,id=$DEVICE" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" \
  -derivedDataPath ./build-device \
  build

APP=./build-device/Build/Products/Debug-iphoneos/Chela.app
if [ ! -d "$APP" ]; then
  echo "error: build reported success but $APP is missing" >&2
  exit 1
fi

echo "== installing"
xcrun devicectl device install app --device "$DEVICE" "$APP"

echo "== launching"
xcrun devicectl device process launch --device "$DEVICE" com.azuretek.claw-mobile

echo "== done"
