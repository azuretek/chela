#!/usr/bin/env python3
"""How long each UI test waited for the app to launch, read from the test log.

XCTest prints a timeline for every UI test. The span from "Launch <bundle>" to
"Setting up automation session" is the launch itself: the app starting and
coming up on the simulator, before the test can touch it. On a starved
simulator that span is what grows, and it grew to 220 s and failed the leg
before anything else in the test was slow (#190). So this reports it for every
UI test and warns when one is over the budget, which is how a return of that
problem shows itself while the leg is still green.

Run: python3 scripts/ui_launch_times.py <log> [--budget SECONDS] [--summary PATH]

It never fails the leg itself: the tests decide pass or fail. A launch that
never finished is reported as such, with the failure Xcode gave.
"""

import argparse
import re
import sys

STARTED = re.compile(r"Test Case '-\[(\w+)\.(\w+) (\w+)\]' started")
FINISHED = re.compile(r"Test Case '-\[(\w+)\.(\w+) (\w+)\]' (passed|failed|skipped) \(([\d.]+) seconds\)")
LAUNCH = re.compile(r"t =\s+([\d.]+)s\s+Launch \S+")
AUTOMATION = re.compile(r"t =\s+([\d.]+)s\s+Setting up automation session")
LAUNCH_FAILED = re.compile(r"error: .*(Failed to launch|Failed to get background assertion)[^\n]*")


def parse(lines):
    """One record per UI test that launched the app.

    Each record: test, launches (seconds per launch that finished), failure
    (the launch error, if one did not), result and duration.
    """
    records = []
    current = None
    launch_at = None
    for line in lines:
        m = STARTED.search(line)
        if m:
            current = {"test": m.group(2) + "." + m.group(3), "launches": [], "failure": None,
                       "result": None, "duration": None}
            launch_at = None
            continue
        if current is None:
            continue
        m = LAUNCH.search(line)
        if m:
            launch_at = float(m.group(1))
            continue
        m = AUTOMATION.search(line)
        if m and launch_at is not None:
            current["launches"].append(round(float(m.group(1)) - launch_at, 1))
            launch_at = None
            continue
        m = LAUNCH_FAILED.search(line)
        if m:
            current["failure"] = m.group(1)
            continue
        m = FINISHED.search(line)
        if m:
            current["result"] = m.group(4)
            current["duration"] = float(m.group(5))
            if current["launches"] or current["failure"]:
                records.append(current)
            current = None
    return records


def report(records, budget):
    """The summary table, and one warning per launch over the budget."""
    rows = ["| UI test | app launch | test | result |", "|---|---|---|---|"]
    warnings = []
    for r in records:
        launches = ", ".join("%.1f s" % s for s in r["launches"]) or "none finished"
        if r["failure"]:
            launches += " (" + r["failure"] + ")"
        rows.append("| %s | %s | %.1f s | %s |" % (r["test"], launches, r["duration"] or 0, r["result"]))
        for seconds in r["launches"]:
            if seconds > budget:
                warnings.append("::warning::%s waited %.1f s for the app to launch, over the %d s budget (#190)"
                                % (r["test"], seconds, budget))
        if r["failure"]:
            warnings.append("::warning::%s could not launch the app: %s (#190)" % (r["test"], r["failure"]))
    if not records:
        rows.append("| no UI test launched the app | | | |")
    return "\n".join(rows) + "\n", warnings


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("log")
    parser.add_argument("--budget", type=int, default=20)
    parser.add_argument("--summary")
    args = parser.parse_args(argv)
    try:
        with open(args.log, errors="replace") as f:
            records = parse(f)
    except FileNotFoundError:
        print("no test log at %s, so there is nothing to report" % args.log)
        return 0
    table, warnings = report(records, args.budget)
    print(table)
    for w in warnings:
        print(w)
    if args.summary:
        with open(args.summary, "a") as f:
            f.write("### UI test app launches\n\n" + table)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
