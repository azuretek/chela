#!/usr/bin/env bash
#
# Build the current Claw app, run it in the iOS Simulator, and drive it toward a
# connected state against a gateway, in one command. Repeatable sim test harness.
#
# Why this exists: the device flow is mobile/build-device.sh, which needs a
# physical phone. Testing a change without a phone means the simulator, and a
# simulator cannot be typed into by a script and has no URL scheme, so the app
# ships two DEBUG-only launch seams (compiled out of a release build):
#
#   -claw-gateway-url <https-url>   seeds the active gateway into the config
#                                   (GatewayStore.screenshotGateway)
#   OPENCLAW_SEED_TOKEN=<token>     seeds the gateway's connect token into the
#                                   credential store (seedDebugTokenFromEnvironment)
#
# ★ TWO THINGS TO KNOW ABOUT THE INPUTS
#
#   1. The gateway URL must be https/http, NOT wss. The app is a WKWebView that
#      loads the Control UI page over HTTPS; `Gateway.parse` refuses a wss scheme,
#      so a wss url silently seeds nothing and the app boots to empty setup.
#
#   2. OPENCLAW_SEED_TOKEN must be the gateway's OWN connect token, the shared
#      token the gateway validates on connect (auth.mode=token). It is NOT the
#      `openclaw qr` setup code's bootstrapToken: that is a device-onboarding
#      credential and the gateway rejects it as a connect secret ("This Gateway
#      expects its token"). On this fleet the connect token is sourced from the
#      vault, and it is a tier-one credential: it must never land in argv, a log
#      or a file. So this script reads it from the CALLER's environment and passes
#      it to the app via SIMCTL_CHILD_ (which keeps it out of the app's argv), and
#      it is the caller's responsibility to export it safely, e.g.
#
#        export OPENCLAW_SEED_TOKEN="$(<secure source>)"   # never echoed
#        ./build-sim.sh
#
#      Without it the app loads the Control UI and shows the gateway's own token
#      prompt, which is a real, correct result: it proves the app reached the
#      gateway, just unauthenticated.
#
# Usage:
#   OPENCLAW_SEED_TOKEN=... ./build-sim.sh            # build, install, launch
#   OPENCLAW_SEED_TOKEN=... ./build-sim.sh <sim-udid> # target a specific sim
#   GATEWAY_URL=https://host OPENCLAW_SEED_TOKEN=... ./build-sim.sh
#   SKIP_BUILD=1 OPENCLAW_SEED_TOKEN=... ./build-sim.sh   # reuse the last build
#
# After it launches, approve the sim's device-pairing request from the gateway:
#   openclaw devices list          # find the pending ios request
#   openclaw devices approve --latest
# then re-screenshot:
#   xcrun simctl io <udid> screenshot proof.png
#
# The generated project and build output are gitignored and rebuilt here.

set -euo pipefail
cd "$(dirname "$0")"

BUNDLE_ID="com.azuretek.claw-mobile"
GATEWAY_URL="${GATEWAY_URL:-https://minizilla.tail8a6fef.ts.net}"
SHOT_DIR="${SHOT_DIR:-build-sim}"
SHOT="${SHOT_DIR}/claw-sim.png"

# The target simulator: an argument if given, otherwise the one booted device.
SIM="${1:-}"
if [ -z "$SIM" ]; then
  SIM="$(xcrun simctl list devices booted -j \
    | python3 -c 'import json,sys
d=json.load(sys.stdin)
ids=[dev["udid"] for runtime in d.get("devices",{}).values() for dev in runtime if dev.get("state")=="Booted"]
print(ids[0] if ids else "")')"
fi
if [ -z "$SIM" ]; then
  echo "error: no booted simulator. Boot one (open -a Simulator) and rerun." >&2
  exit 1
fi
echo "== simulator: $SIM"

case "$GATEWAY_URL" in
  wss://*|ws://*)
    echo "error: GATEWAY_URL must be https/http, not a websocket url. The app" >&2
    echo "  loads the Control UI over HTTPS; a wss url seeds nothing." >&2
    exit 1;;
esac

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "== generating the Xcode project from project.yml"
  xcodegen generate
  # A simulator build is unsigned (CODE_SIGNING_ALLOWED=NO), so no team id is
  # needed. Niced because minizilla also serves Plex/Ollama/the gateway.
  echo "== building for the simulator (the slow part)"
  nice -n 19 xcodebuild -project Claw.xcodeproj -scheme Claw \
    -sdk iphonesimulator -configuration Debug \
    -destination "platform=iOS Simulator,id=$SIM" \
    CODE_SIGNING_ALLOWED=NO \
    -derivedDataPath ./build-sim \
    build
fi

APP="./build-sim/Build/Products/Debug-iphonesimulator/Claw.app"
if [ ! -d "$APP" ]; then
  echo "error: build reported success but $APP is missing" >&2
  exit 1
fi

# A reinstall keeps the sim's stores, so the device keypair survives and the
# gateway raises no new pairing request. Uninstall first so every run is the
# fresh-install path: seed, connect, pair, approve.
echo "== uninstalling any previous copy (fresh install => real pairing)"
xcrun simctl uninstall "$SIM" "$BUNDLE_ID" 2>/dev/null || true

echo "== installing"
xcrun simctl install "$SIM" "$APP"

# The connect token, from the caller's environment. simctl has no --env flag;
# a child env var is passed by prefixing SIMCTL_CHILD_, which keeps the token out
# of the app's argv (and so out of any process listing).
LAUNCH_ENV=()
if [ -n "${OPENCLAW_SEED_TOKEN:-}" ]; then
  export SIMCTL_CHILD_OPENCLAW_SEED_TOKEN="$OPENCLAW_SEED_TOKEN"
  echo "== launching with a seeded connect token (len ${#OPENCLAW_SEED_TOKEN})"
else
  echo "== launching WITHOUT a token: the app will reach the gateway and show its"
  echo "   own token prompt. Set OPENCLAW_SEED_TOKEN to prove an authenticated"
  echo "   connection. See the header of this script."
fi

echo "== launching pointed at $GATEWAY_URL"
xcrun simctl launch --terminate-running-process \
  "$SIM" "$BUNDLE_ID" -claw-gateway-url "$GATEWAY_URL" >/dev/null

# The device keypair is the pairing gate. A fresh install mints a new one, so if
# the token authenticates, the gateway now has a pending request. Poll and
# approve. Bounded so a run that never pairs ends with a message, not a hang.
echo "== waiting up to ~30s for the sim's pairing request"
HAVE_PENDING=""
for i in $(seq 1 15); do
  HAVE_PENDING="$(openclaw devices list --json 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
print("yes" if d.get("pending") else "")
' 2>/dev/null || true)"
  [ -n "$HAVE_PENDING" ] && break
  sleep 2
done

if [ -n "$HAVE_PENDING" ]; then
  echo "== approving the latest pending pairing request"
  openclaw devices approve --latest
  sleep 4
else
  echo "== no pending pairing request surfaced." >&2
  echo "   With a valid token this means already-paired or a connection issue;" >&2
  echo "   without a token this is expected (the token prompt is showing)." >&2
fi

sleep 4
echo "== capturing screenshot -> $SHOT"
mkdir -p "$SHOT_DIR"
xcrun simctl io "$SIM" screenshot "$SHOT"

echo
echo "== done."
echo "   screenshot: $(cd "$(dirname "$SHOT")" && pwd)/$(basename "$SHOT")"
echo "   verify: openclaw devices list   (the sim's device, connected:true,"
echo "     remoteIp = this host's tailscale ip)"
