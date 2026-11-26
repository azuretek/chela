#!/usr/bin/env bash
# sim-boot.sh <udid>: boot the test leg's simulator without the services the
# tests never use, and wait for the boot to finish.
#
# The jobs are listed, with the reason, in sim-disabled-jobs.txt beside this
# script (#190). The test step finds the device booted and runs on it as it is.
set -euo pipefail

udid=${1:?usage: sim-boot.sh <udid>}
list="$(cd "$(dirname "$0")" && pwd)/sim-disabled-jobs.txt"

args=()
while IFS= read -r line; do
  line=${line%%#*}
  line=${line//[[:space:]]/}
  [ -n "$line" ] && args+=("--disabledJob=$line")
done < "$list"

t0=$SECONDS
xcrun simctl boot "$udid" "${args[@]}"
xcrun simctl bootstatus "$udid" -b > /dev/null
echo "booted $udid in $(( SECONDS - t0 )) s with ${#args[@]} jobs disabled"
