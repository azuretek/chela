#!/usr/bin/env bash
#
# Build the current Claw app, run it in the iOS Simulator, and drive it all the
# way to a CONNECTED, paired state against the gateway, in one command, using a
# REVOCABLE credential it cleans up afterward. Repeatable sim test harness.
#
# Why this exists: the device flow is mobile/build-device.sh, which needs a
# physical phone. Testing a change without a phone means the simulator, and a
# simulator cannot be typed into by a script and has no URL scheme, so the app
# ships DEBUG-only launch seams (compiled out of a release build):
#
#   -claw-gateway-url <https-url>        seeds the active gateway into the config
#                                        (GatewayStore.screenshotGateway)
#   OPENCLAW_SEED_BOOTSTRAP_TOKEN=<tok>  seeds a setup-code (bootstrap) token onto
#                                        the load URL fragment as #bootstrapToken=
#                                        so the Control UI runs the real pairing
#                                        handshake (WebView.loadURL)
#
# HOW THIS CONNECTS WITHOUT THE SHARED, TIER-ONE TOKEN
#
#   The gateway's connect auth has two distinct credentials. auth.token is the
#   SHARED connect secret (auth.mode=token), sourced from the vault, tier-one:
#   it must never land in argv, a log or a file. auth.bootstrapToken is a
#   short-lived, REVOCABLE setup-code minted per pairing. They are different
#   gates: a setup code fed as the shared token is refused ("This Gateway expects
#   its token"), which is the bug an earlier version of this script tripped by
#   seeding a token into the native connect global.
#
#   So this harness never touches the shared token. It mints a LIMITED setup code
#   locally (openclaw qr --limited: a local state-DB write, no gateway
#   connection, no shared token), hands its bootstrapToken to the app on the URL
#   fragment, lets the app's own keypair + pairing handshake run, then APPROVES
#   the pending request and REVOKES the resulting device with local state-DB
#   writes (mobile/scripts/pair-local.mjs), which the running gateway picks up on
#   the next connect (it re-reads the pairing store per connect). Every credential
#   this creates is revoked before the script exits: no live temp credential is
#   left behind.
#
#   The gateway URL must be https/http, NOT wss. The app is a WKWebView that loads
#   the Control UI over HTTPS; Gateway.parse refuses a wss scheme, so a wss url
#   silently seeds nothing and the app boots to empty setup.
#
# Usage:
#   ./build-sim.sh                 # build, install, launch, pair, approve, shoot, revoke
#   ./build-sim.sh <sim-udid>      # target a specific sim (else the booted one)
#   GATEWAY_URL=https://host ./build-sim.sh
#   SKIP_BUILD=1 ./build-sim.sh    # reuse the last build
#   NO_REVOKE=1 ./build-sim.sh     # leave the paired device in place (debugging only)
#
# The generated project and build output are gitignored and rebuilt here.

set -euo pipefail
cd "$(dirname "$0")"

BUNDLE_ID="com.azuretek.claw-mobile"
GATEWAY_URL="${GATEWAY_URL:-https://minizilla.tail8a6fef.ts.net}"
SHOT_DIR="${SHOT_DIR:-build-sim}"
SHOT="${SHOT_DIR}/claw-sim.png"
PAIR_LOCAL="./scripts/pair-local.mjs"

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

# Mint a LIMITED, revocable setup code locally. This is a local state-DB write
# (no gateway connection, no shared token); the bootstrapToken inside is what the
# app exchanges in the pairing handshake.
echo "== minting a limited, revocable setup code (local; no shared token)"
SETUP_CODE="$(openclaw qr --limited --setup-code-only)"
BOOTSTRAP_TOKEN="$(printf '%s' "$SETUP_CODE" | python3 -c '
import sys, json, base64
raw = sys.stdin.read().strip()
pad = "=" * (-len(raw) % 4)
print(json.loads(base64.urlsafe_b64decode(raw + pad))["bootstrapToken"])')"
if [ -z "$BOOTSTRAP_TOKEN" ]; then
  echo "error: could not mint a setup code / decode its bootstrapToken" >&2
  exit 1
fi
echo "== minted (bootstrapToken len ${#BOOTSTRAP_TOKEN})"

# Hand the bootstrap token to the app on the URL fragment via the DEBUG seam.
# simctl has no --env flag; a child env var is passed by prefixing SIMCTL_CHILD_,
# which keeps it out of the app's argv (and so out of any process listing).
export SIMCTL_CHILD_OPENCLAW_SEED_BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN"

echo "== launching pointed at $GATEWAY_URL (bootstrap token on the fragment)"
xcrun simctl launch --terminate-running-process \
  "$SIM" "$BUNDLE_ID" -claw-gateway-url "$GATEWAY_URL" >/dev/null

# The device keypair is the pairing gate. A fresh install mints a new one, so the
# bootstrap handshake raises a pending request. Poll the LOCAL pairing store
# (no shared token) and grab the request's public key so cleanup targets exactly
# this device and nothing else. Bounded so a run that never pairs ends with a
# message, not a hang.
echo "== waiting up to ~40s for the sim's pairing request"
PENDING_PUBKEY=""
for i in $(seq 1 20); do
  PENDING_PUBKEY="$(node "$PAIR_LOCAL" list-json 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
p=d.get("pending") or []
if p:
    latest=max(p, key=lambda r: r.get("ts",0))
    print(latest.get("publicKey",""))' 2>/dev/null || true)"
  [ -n "$PENDING_PUBKEY" ] && break
  sleep 2
done

APPROVED_PUBKEY=""
if [ -n "$PENDING_PUBKEY" ]; then
  echo "== approving the latest pending pairing request (local; no shared token)"
  APPROVE_JSON="$(node "$PAIR_LOCAL" approve-latest)"
  echo "   $APPROVE_JSON"
  APPROVED_PUBKEY="$(printf '%s' "$APPROVE_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("publicKey",""))' 2>/dev/null || true)"
  sleep 6
else
  echo "== no pending pairing request surfaced within the window." >&2
  echo "   The app reached the gateway but did not raise a pairing request; check" >&2
  echo "   the screenshot below (it may be showing the token/pairing prompt)." >&2
fi

sleep 3
echo "== capturing screenshot -> $SHOT"
mkdir -p "$SHOT_DIR"
xcrun simctl io "$SIM" screenshot "$SHOT"

if [ -n "$APPROVED_PUBKEY" ]; then
  echo "== connection check (local pairing store):"
  APPROVED_PUBKEY="$APPROVED_PUBKEY" node "$PAIR_LOCAL" list-json 2>/dev/null | python3 -c '
import json,sys,os
pk=os.environ.get("APPROVED_PUBKEY","")
d=json.load(sys.stdin)
dev=next((x for x in d.get("paired",[]) if x.get("publicKey")==pk), None)
if dev:
    print("   paired: deviceId=%s platform=%s remoteIp=%s lastSeenReason=%s"
          % (dev.get("deviceId","")[:16], dev.get("platform"), dev.get("remoteIp"), dev.get("lastSeenReason")))
else:
    print("   (device not found in paired store yet)")' || true
fi

# Cleanup: revoke + remove the device this run created, by its EXACT public key,
# so no live temp credential is left behind. A public key is unique to the
# keypair this fresh install minted; matching by clientId/platform would risk the
# household's real iPhone, which shares clientId "openclaw-ios".
if [ "${NO_REVOKE:-}" = "1" ]; then
  echo "== NO_REVOKE=1: leaving the paired sim device in place (debugging only)."
  echo "   Revoke it later with: node $PAIR_LOCAL remove-by-pubkey ${APPROVED_PUBKEY:-<pubkey>}"
elif [ -n "$APPROVED_PUBKEY" ]; then
  echo "== revoking + removing the sim's device token (cleanup; local)"
  node "$PAIR_LOCAL" remove-by-pubkey "$APPROVED_PUBKEY"
else
  echo "== nothing to revoke (no device was paired this run)."
fi

echo
echo "== done."
echo "   screenshot: $(cd "$(dirname "$SHOT")" && pwd)/$(basename "$SHOT")"
