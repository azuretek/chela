#!/usr/bin/env python3
"""Tests for the App Store Connect gate in asc.py.

The one behaviour worth pinning: wait() gates the release on the build being
INSTALLABLE (processingState VALID), not on it merely arriving. Publishing on
arrival is what let the in-app "upgrade available" banner point at a build still
in Processing, so a build that never reaches VALID within the window must FAIL
the run rather than pass. These stub the network so no credential or Apple round
trip is needed.

Run: python3 scripts/asc_test.py
"""

import importlib.util
import os
import sys
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("asc", os.path.join(HERE, "asc.py"))
asc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(asc)

FAILURES = []


def check(name, condition):
    print(("ok  " if condition else "FAIL") + " " + name)
    if not condition:
        FAILURES.append(name)


def run_wait(states, wait_seconds=1, poll_seconds=0):
    """Drive wait() over a scripted sequence of processingState values.

    Returns ("ok",) on success or ("fail", message) when wait() calls fail().
    """
    seq = list(states)

    def fake_fetch_build(auth, app_id, build_number):
        state = seq.pop(0) if seq else (states[-1] if states else None)
        if state is None:
            return None
        return {"id": "b1", "build_number": build_number, "state": state,
                "uploaded": "now", "expired": False, "marketing": "1.0"}

    calls = {"assigned": False}

    orig = {
        "token": asc.token, "fetch_build": asc.fetch_build, "assign": asc.assign,
    }
    asc.token = lambda: {"header": {}, "id": "k"}
    asc.fetch_build = fake_fetch_build
    asc.assign = lambda *a, **k: calls.__setitem__("assigned", True)
    os.environ.update({
        "APP_ID": "app1", "BUILD_NUMBER": "42", "MARKETING_VERSION": "1.0",
        "WAIT_SECONDS": str(wait_seconds), "POLL_SECONDS": str(poll_seconds),
        "ASC_KEY_ID": "x", "ASC_ISSUER_ID": "y",
    })
    import contextlib, io
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            asc.wait()
        return ("ok", calls["assigned"])
    except SystemExit:
        # fail() prints the reason to stderr and exits non-zero; the message is
        # in stderr, not in the SystemExit (which carries only the exit code).
        return ("fail", err.getvalue())
    finally:
        asc.token, asc.fetch_build, asc.assign = orig["token"], orig["fetch_build"], orig["assign"]


# 1. Reaches VALID: succeeds and assigns to the internal group.
outcome = run_wait(["PROCESSING", "PROCESSING", "VALID"])
check("VALID build passes the gate", outcome[0] == "ok")
check("VALID build is assigned to the group", outcome[0] == "ok" and outcome[1] is True)

# 2. Never leaves PROCESSING before the deadline: FAILS (must not publish).
outcome = run_wait(["PROCESSING", "PROCESSING", "PROCESSING", "PROCESSING", "PROCESSING"])
check("a build stuck in PROCESSING fails the gate", outcome[0] == "fail")
check("the failure names it not installable", outcome[0] == "fail" and "installable" in outcome[1].lower())

# 3. INVALID: fails hard (Apple rejected it).
outcome = run_wait(["PROCESSING", "INVALID"])
check("an INVALID build fails the gate", outcome[0] == "fail")

# 4. Never appears at all: fails as not-uploaded.
outcome = run_wait([None, None, None, None])
check("a build that never appears fails", outcome[0] == "fail")

if FAILURES:
    print(f"\n{len(FAILURES)} failed: {', '.join(FAILURES)}")
    sys.exit(1)
print("\nall asc gate tests passed")
