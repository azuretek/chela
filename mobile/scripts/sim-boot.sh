#!/usr/bin/env bash
# sim-boot.sh <udid>: boot the test leg's simulator, wait for the boot to finish,
# and stop the services the tests never use before anything is tested (#190).
#
# A booted iOS simulator runs about 300 processes. On the 3-core, 7.5 GB runners
# that keeps the CPU at 100% and memory full for the whole test step, and the
# first UI launch waited up to 220 s on SpringBoard, runningboardd and dyld and
# failed the leg. Waiting for the boot to finish was measured alone and is not
# enough: a first launch still took 27.6 s after it. The jobs listed with their
# reasons in sim-disabled-jobs.txt are the largest users of CPU and memory that
# the app and the tests never touch, and they are disabled and booted out of the
# device here. `simctl boot --disabledJob` was measured not to stop them: most
# run in the user/foreground domain, which that flag does not reach.
#
# It prints the simulator's process count and resident memory before and after,
# so every run shows what was taken off the runner.
set -euo pipefail

udid=${1:?usage: sim-boot.sh <udid>}
list="$(cd "$(dirname "$0")" && pwd)/sim-disabled-jobs.txt"
: "${SETTLE:=30}"

sim_usage() {
  ps -Ao rss=,comm= | awk '/RuntimeRoot/ { r += $1; n++ } /RuntimeRoot.*[Ww]idget/ { w++ }
    END { printf "%d processes, %d of them widgets, %d MB resident", n, w, r / 1024 }'
}

t0=$SECONDS
xcrun simctl boot "$udid"
booted=$(( SECONDS - t0 ))
xcrun simctl bootstatus "$udid" -b > /dev/null
echo "simulator $udid reported Booted after ${booted} s and finished booting after $(( SECONDS - t0 )) s"
echo "before: $(sim_usage)"

stopped=0
while IFS= read -r line; do
  job=${line%%#*}
  job=${job//[[:space:]]/}
  [ -n "$job" ] || continue
  for domain in user/foreground system; do
    xcrun simctl spawn "$udid" launchctl disable "$domain/$job" > /dev/null 2>&1 || true
    if xcrun simctl spawn "$udid" launchctl bootout "$domain/$job" > /dev/null 2>&1; then
      stopped=$(( stopped + 1 ))
    fi
  done
done < "$list"

# The widget extensions exit after their host; give them until SETTLE seconds
# have passed with the widget count at zero or no longer falling.
t1=$SECONDS last=-1
while [ $(( SECONDS - t1 )) -lt "$SETTLE" ]; do
  now=$(ps -Ao comm= | grep -c 'RuntimeRoot.*[Ww]idget' || true)
  [ "$now" -eq 0 ] && break
  [ "$now" -eq "$last" ] && break
  last=$now
  sleep 5
done
echo "stopped $stopped services; after: $(sim_usage)"
