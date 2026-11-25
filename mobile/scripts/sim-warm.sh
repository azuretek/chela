#!/usr/bin/env bash
# sim-warm.sh: give the iOS test leg a simulator that has booted before.
#
# Why (issue #190): every leg ran its UI tests on a device that had never booted.
# xcodebuild booted it inside the test step and launched the app minutes into
# iOS's first-boot setup, which on the 3-core runners keeps every core busy for
# several minutes (CPU idle 0%, load average 100 to 650). The first app launch of
# the UI tests landed in that and took up to 220 s, and twice it failed outright:
# "Timed out while launching application via Xcode" and "Failed to get background
# assertion for target app". A second boot of the same device skips the setup.
#
#   sim-warm.sh warm <udid> <archive>   boot the device for the first time, wait
#                                       until it settles, shut it down and archive
#                                       its data, so the cache can carry it to the
#                                       next run on the same image
#   sim-warm.sh boot <udid> <archive>   put the archived data in place unless the
#                                       device already holds it, then boot it and
#                                       wait for the boot to finish
#   sim-warm.sh settle                  only the wait, for the tests
#
# Settled means the simulator's own processes used at most QUIET_MILLICORES
# thousandths of a core, measured between samples WINDOW seconds apart, for
# QUIET_WINDOWS samples in a row. It is a rate over the real time between samples
# because taking a sample is itself slow on a starved runner: measured, one took
# a minute. On the first warm, the rate fell from 74% of a core to under 20% about
# five minutes after the boot and then rose again with periodic work, so the
# threshold is 25% rather than idle. SETTLE_LIMIT bounds the wait; reaching it
# archives the device anyway and says so, because a device that booted once is
# still the better one to test on.
set -euo pipefail

cmd=${1:?usage: sim-warm.sh warm|boot <udid> <archive>, or sim-warm.sh settle}
: "${WINDOW:=10}" "${QUIET_MILLICORES:=250}" "${QUIET_WINDOWS:=3}" "${SETTLE_LIMIT:=600}"

# CPU seconds used so far by every process of the booted simulator runtime. Only
# one simulator is booted on a test leg, so the runtime's processes are its own.
sim_cpu() {
  ps -Ao cputime=,args= | awk '/RuntimeRoot|launchd_sim/ && !/awk/ {
    n = split($1, p, ":"); s = 0
    for (i = 1; i <= n; i++) s = s * 60 + p[i]
    t += s
  } END { printf "%d", t }'
}

settle() {
  local t0=$SECONDS last=$SECONDS quiet=0 prev now used dt rate
  prev=$(sim_cpu)
  while [ "$quiet" -lt "$QUIET_WINDOWS" ]; do
    if [ $(( SECONDS - t0 )) -ge "$SETTLE_LIMIT" ]; then
      echo "::warning::the simulator was still busy after ${SETTLE_LIMIT} s; archiving it anyway"
      return 0
    fi
    sleep "$WINDOW"
    now=$(sim_cpu)
    dt=$(( SECONDS - last )) last=$SECONDS
    [ "$dt" -gt 0 ] || dt=1
    used=$(( now - prev )) prev=$now
    rate=$(( used * 1000 / dt ))
    if [ "$rate" -le "$QUIET_MILLICORES" ]; then quiet=$(( quiet + 1 )); else quiet=0; fi
    echo "settling: ${used} CPU s over ${dt} s, $(( rate / 10 ))% of a core ($(( SECONDS - t0 )) s in)"
  done
  echo "settled after $(( SECONDS - t0 )) s"
}

if [ "$cmd" = settle ]; then
  settle
  exit 0
fi

udid=${2:?missing udid}
archive=${3:?missing archive path}
data="$HOME/Library/Developer/CoreSimulator/Devices/$udid/data"
marker="$data/.chela-warm"

boot_and_wait() {
  local t0=$SECONDS
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b > /dev/null
  echo "booted $udid in $(( SECONDS - t0 )) s"
}

case "$cmd" in
  warm)
    boot_and_wait
    settle
    xcrun simctl shutdown "$udid"
    touch "$marker"
    tar -cf "$archive" -C "$data" .
    echo "archived the warmed device: $(du -h "$archive" | cut -f1)"
    ;;
  boot)
    if [ ! -f "$marker" ]; then
      [ -f "$archive" ] || { echo "::error::no warmed device at $archive"; exit 1; }
      rm -rf "$data"
      mkdir -p "$data"
      tar -xf "$archive" -C "$data"
      echo "restored the warmed device"
    fi
    boot_and_wait
    ;;
  *)
    echo "usage: sim-warm.sh warm|boot <udid> <archive>, or sim-warm.sh settle" >&2
    exit 2
    ;;
esac
