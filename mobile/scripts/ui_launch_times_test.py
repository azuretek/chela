#!/usr/bin/env python3
"""Tests for the UI launch report in ui_launch_times.py.

The behaviour worth pinning: the launch span is read from XCTest's own timeline,
a launch that never finished is reported with Xcode's error rather than dropped,
and the budget warns per launch. The fixtures are the lines the iOS 27 leg
printed for main at cec254d, where the first launch failed after 203 s, and a
healthy run of the same class.

Run: python3 scripts/ui_launch_times_test.py
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ui_launch_times", os.path.join(HERE, "ui_launch_times.py"))
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)

FAILURES = []


def check(name, condition):
    print(("ok  " if condition else "FAIL") + " " + name)
    if not condition:
        FAILURES.append(name)


FAILED_LEG = """
Test Case '-[ChelaUITests.AboutHeaderUITests testTheAboutHeaderAsDrawn]' started.
    t =     0.84s Set Up
Test Case '-[ChelaUITests.AboutHeaderUITests testTheAboutHeaderAsDrawn]' skipped (1.337 seconds).
Test Case '-[ChelaUITests.NoticeBannerUITests testMarkAllReadTakesTheWholeBannerAway]' started.
    t =     0.04s     Open com.azuretek.claw-mobile
    t =     0.04s         Launch com.azuretek.claw-mobile
/Users/runner/work/chela/chela/mobile/ChelaUITests/NoticeBannerUITests.swift:22: error: -[ChelaUITests.NoticeBannerUITests testMarkAllReadTakesTheWholeBannerAway] : Failed to launch <XCUIApplicationImpl: 0x1061f1500 com.azuretek.claw-mobile at /Users/runner/work/_temp/DerivedData/Build/Products/Debug-iphonesimulator/Chela.app> via Xcode: Timed out while launching application via Xcode.
    t =   202.36s     Tear Down
Test Case '-[ChelaUITests.NoticeBannerUITests testMarkAllReadTakesTheWholeBannerAway]' failed (202.999 seconds).
Test Case '-[ChelaUITests.NoticeBannerUITests testTheXOnACardMarksItRead]' started.
    t =     0.14s         Launch com.azuretek.claw-mobile
    t =     2.04s             Setting up automation session
    t =     6.79s             Wait for com.azuretek.claw-mobile to idle
Test Case '-[ChelaUITests.NoticeBannerUITests testTheXOnACardMarksItRead]' passed (16.769 seconds).
""".splitlines()

SLOW_LEG = """
Test Case '-[ChelaUITests.NoticeBannerUITests testMarkAllReadTakesTheWholeBannerAway]' started.
    t =     3.73s         Launch com.azuretek.claw-mobile
    t =    92.73s             Setting up automation session
Test Case '-[ChelaUITests.NoticeBannerUITests testMarkAllReadTakesTheWholeBannerAway]' passed (114.941 seconds).
""".splitlines()

records = ui.parse(FAILED_LEG)
check("a skipped test that never launched is not reported", [r["test"] for r in records] ==
      ["NoticeBannerUITests.testMarkAllReadTakesTheWholeBannerAway", "NoticeBannerUITests.testTheXOnACardMarksItRead"])
check("a launch that never finished carries Xcode's error", records[0]["failure"] == "Failed to launch" and records[0]["launches"] == [])
check("a finished launch is the span from Launch to the automation session", records[1]["launches"] == [1.9])
check("the result and duration come from the test's own line", (records[0]["result"], records[0]["duration"]) == ("failed", 202.999))

table, warnings = ui.report(records, 20)
check("the failed launch is a warning", any("could not launch the app: Failed to launch" in w for w in warnings))
check("a fast launch is not a warning", not any("testTheXOnACardMarksItRead" in w for w in warnings))
check("the table names every launching test", table.count("NoticeBannerUITests.") == 2)

slow = ui.parse(SLOW_LEG)
_, slow_warnings = ui.report(slow, 20)
check("a launch over the budget is a warning with its time", slow[0]["launches"] == [89.0] and
      any("waited 89.0 s" in w for w in slow_warnings))
_, generous = ui.report(slow, 120)
check("the same launch under a larger budget is not", generous == [])

check("a missing log reports nothing and does not fail", ui.main([os.path.join(HERE, "no-such-log")]) == 0)

if FAILURES:
    print("%d failed" % len(FAILURES))
    sys.exit(1)
print("all passed")
