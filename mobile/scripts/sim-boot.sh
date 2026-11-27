#!/usr/bin/env bash
# sim-boot.sh <udid>: boot the test leg's simulator and wait for the boot to
# finish before anything is tested (#190).
#
# xcodebuild used to boot the device inside the test step and start testing as
# soon as it reported Booted, which comes while iOS is still starting its system
# apps and services. `simctl bootstatus -b` returns only once the boot has
# finished. The simulator's process count and resident memory are printed after,
# so every run shows how much of the runner the simulator takes.
set -euo pipefail

udid=${1:?usage: sim-boot.sh <udid>}

t0=$SECONDS
xcrun simctl boot "$udid"
booted=$(( SECONDS - t0 ))
xcrun simctl bootstatus "$udid" -b > /dev/null
echo "simulator $udid reported Booted after ${booted} s and finished booting after $(( SECONDS - t0 )) s"
ps -Ao rss=,comm= | awk '/RuntimeRoot/ { r += $1; n++ } END { printf "simulator: %d processes, %d MB resident\n", n, r / 1024 }'
