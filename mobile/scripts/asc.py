#!/usr/bin/env python3
"""The App Store Connect API, for the mobile release workflow.

Four things the Xcode toolchain cannot answer, and all four are the API's:
whether the app record exists before three minutes are spent on an archive,
which team the account belongs to (`project.yml` deliberately carries no team
id, see build-device.sh), whether the build that was just uploaded actually
arrived, and whether it reached the internal TestFlight group. This is the one
place any of them is implemented.

Two subcommands, run as separate CI steps on either side of the xcodebuild work:

    asc.py preflight    before anything is built
    asc.py wait         after the upload, to prove the build arrived

Authentication is a JWT signed with the key at `ASC_KEY_PATH`, ES256, which is
the only signing algorithm App Store Connect accepts. The private key is read
from that file and never leaves this process: it is not printed, and it is not
passed as an argument to anything. The key id and the issuer id do travel on the
command line, because Apple's token format puts them in the JWT header and
claims and there is no other way to name a key, and neither is a credential:
both are visible in the App Store Connect UI, the key itself is the secret.

Reads and writes only what the release needs, so nothing here can change an app
record, a certificate or a profile.
"""

import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.appstoreconnect.apple.com/v1"
BUNDLE_ID = os.environ.get("BUNDLE_ID", "com.azuretek.claw-mobile")


def env(name, default=None):
    value = os.environ.get(name, default)
    if value is None or value == "":
        fail(f"{name} is not set")
    return value


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def output(name, value):
    """A GitHub Actions output, when running under Actions, silence otherwise."""
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        print(f"{name}={value}")
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(f"{name}={value}\n")


# --------------------------------------------------------------------------
# The JWT
# --------------------------------------------------------------------------

def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def read_length(buf, i):
    """A DER length field, short or long form."""
    first = buf[i]
    i += 1
    if first < 0x80:
        return first, i
    count = first & 0x7F
    return int.from_bytes(buf[i:i + count], "big"), i + count


def der_to_raw(der):
    """`openssl dgst -sign` output as the fixed width pair a JWT carries.

    OpenSSL returns a DER `SEQUENCE` of two `INTEGER`s, each of which is a
    variable length signed value, so every signature comes back a different
    length. ES256 in a JWT is `r || s`, 32 bytes each, no length fields. The
    two conversions that matter: a positive integer with its top bit set comes
    back with a leading zero byte that has to go, and a short integer has to be
    left padded to exactly 32.
    """
    if len(der) < 8 or der[0] != 0x30:
        fail("openssl returned something that is not a DER signature")
    _, i = read_length(der, 1)
    parts = []
    for _ in range(2):
        if der[i] != 0x02:
            fail("openssl returned a DER signature with no INTEGER in it")
        length, i = read_length(der, i + 1)
        value = der[i:i + length]
        i += length
        value = value.lstrip(b"\x00")
        if len(value) > 32:
            fail(f"a signature component is {len(value)} bytes, longer than 32")
        parts.append(value.rjust(32, b"\x00"))
    return parts[0] + parts[1]


def token():
    """A short lived App Store Connect JWT, signed with the key on disk."""
    key_id = env("ASC_KEY_ID")
    issuer = env("ASC_ISSUER_ID")
    key_path = env("ASC_KEY_PATH")

    now = int(time.time())
    header = json.dumps({"alg": "ES256", "kid": key_id, "typ": "JWT"}, separators=(",", ":"))
    claims = json.dumps(
        # 20 minutes: Apple rejects a token whose lifetime is over an hour, and
        # this one only has to outlive the few API calls in the step that mints
        # it. `exp` is checked against Apple's clock, not ours.
        {"iss": issuer, "iat": now, "exp": now + 20 * 60, "aud": "appstoreconnect-v1"},
        separators=(",", ":"),
    )
    signing_input = f"{b64url(header.encode())}.{b64url(claims.encode())}"

    # The key reaches openssl as a path, never as data in an argument, and the
    # signing input arrives on stdin, so neither is visible in `ps`.
    signed = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", key_path, "-binary"],
        input=signing_input.encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if signed.returncode != 0:
        fail(f"openssl could not sign with the key at {key_path}: {signed.stderr.decode().strip()}")

    return f"{signing_input}.{b64url(der_to_raw(signed.stdout))}"


# --------------------------------------------------------------------------
# The API
# --------------------------------------------------------------------------

def api(auth, path, params=None, method="GET", body=None):
    """One request. Returns the parsed body, or exits with Apple's own words.

    Every failure is reported with the status and the `errors` array App Store
    Connect returned, because that text is the difference between "the app
    record is missing" and "this key lacks a permission", and a paraphrase of it
    would send someone to the wrong place.
    """
    url = API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {auth}", "Accept": "application/json"},
    )
    if data:
        request.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        raw = error.read()
        detail = ""
        try:
            parsed = json.loads(raw)
            detail = "; ".join(
                f"{e.get('title', 'error')}: {e.get('detail', '')}".strip()
                for e in parsed.get("errors", [])
            )
        except Exception:
            detail = raw.decode("utf-8", "replace")[:400]
        return {"__status__": error.code, "__error__": f"{error.code} {error.reason}", "__detail__": detail}
    except urllib.error.URLError as error:
        fail(f"could not reach {url}: {error.reason}")

    return json.loads(raw) if raw else {}


def ok(result):
    return "__error__" not in result


def describe(result):
    return f"{result.get('__error__')} ({result.get('__detail__') or 'no detail'})"


def one(items):
    return items[0] if items else None


def account_summary(auth):
    """What the account does contain, for when a lookup comes up empty.

    An empty answer is the one failure where the next step depends on the
    difference between "this account has nothing" and "this account has apps,
    but not this one", so the two lists are printed with the failure rather than
    guessed at. It also rules out the other reading of an empty result: a key
    whose role cannot read apps answers 403, and that arrives as an error rather
    than as an empty list.
    """
    lines = []

    apps = api(auth, "/apps", {"limit": 50, "fields[apps]": "name,bundleId,sku"})
    if ok(apps):
        records = apps.get("data", [])
        lines.append(f"app records in the account: {len(records)}")
        for record in records[:10]:
            attributes = record.get("attributes", {})
            lines.append(f"  {attributes.get('name')} [{attributes.get('bundleId')}]")
    else:
        lines.append(f"listing app records failed: {describe(apps)}")

    ids = api(auth, "/bundleIds", {"limit": 50, "fields[bundleIds]": "identifier,seedId"})
    if ok(ids):
        known = [record.get("attributes", {}).get("identifier") for record in ids.get("data", [])]
        if BUNDLE_ID in known:
            lines.append(f"the App ID {BUNDLE_ID} IS registered in this account")
        else:
            lines.append(f"the App ID {BUNDLE_ID} is not registered in this account either")
            for identifier in known[:10]:
                lines.append(f"  registered: {identifier}")
    else:
        lines.append(f"listing bundle ids failed: {describe(ids)}")

    return lines


def fetch_app(auth):
    """The app record, which no API can create: it is made in the web UI."""
    result = api(auth, "/apps", {"filter[bundleId]": BUNDLE_ID, "limit": 1})
    if not ok(result):
        fail(f"looking up the app record for {BUNDLE_ID} failed: {describe(result)}")
    app = one(result.get("data", []))
    if not app:
        print(f"no app record for {BUNDLE_ID}. What this account does have:", file=sys.stderr)
        for line in account_summary(auth):
            print(f"  {line}", file=sys.stderr)
        fail(
            f"no app record exists in App Store Connect for {BUNDLE_ID}, so an upload has "
            "nothing to attach to. Create it once in App Store Connect (My Apps, then the "
            "+ button, then New App) with this bundle id, a name and a SKU, then re-run. "
            "No API can create an app record, and Xcode can only create the bundle id."
        )
    return app


def fetch_team_id(auth):
    """The team id, read from the bundle id record rather than kept anywhere.

    `project.yml` has no team id on purpose, the same reason build-device.sh
    takes one from the environment: it is a property of the account, and a
    committed copy is a second place to keep in step with it. This asks the
    account instead, from the App ID prefix, which is the team id.
    """
    result = api(auth, "/bundleIds", {"filter[identifier]": BUNDLE_ID, "limit": 10})
    if not ok(result):
        fail(f"looking up the bundle id {BUNDLE_ID} failed: {describe(result)}")
    for record in result.get("data", []):
        seed = record.get("attributes", {}).get("seedId")
        if seed:
            return seed
    fail(
        f"the bundle id {BUNDLE_ID} exists but carries no seed id, so the team cannot be "
        "read from it. Register the App ID in the developer portal, or check that this key "
        "belongs to the account that owns it."
    )


def fetch_build(auth, app_id, build_number):
    """The build carrying this number, or None.

    Matched on the build number alone, which under this repo's scheme is the
    commit count and so increases with every commit: nothing else can carry the
    same number, and no second build can be confused for this one. The build
    number is what Apple orders uploads by, so it is also the exact field that
    decides whether an upload is accepted at all.
    """
    result = api(auth, "/builds", {
        "filter[app]": app_id,
        "sort": "-uploadedDate",
        "limit": 50,
        "include": "preReleaseVersion",
        "fields[builds]": "version,processingState,uploadedDate,expired,preReleaseVersion",
        "fields[preReleaseVersions]": "version,platform",
    })
    if not ok(result):
        fail(f"listing builds failed: {describe(result)}")

    prereleases = {item["id"]: item.get("attributes", {}) for item in result.get("included", [])}
    for build in result.get("data", []):
        attributes = build.get("attributes", {})
        if str(attributes.get("version")) != str(build_number):
            continue
        prerelease_id = build.get("relationships", {}).get("preReleaseVersion", {}).get("data", {}).get("id")
        return {
            "id": build["id"],
            "build_number": attributes.get("version"),
            "state": attributes.get("processingState"),
            "uploaded": attributes.get("uploadedDate"),
            "expired": attributes.get("expired"),
            "marketing": (prereleases.get(prerelease_id) or {}).get("version"),
        }
    return None


def internal_group(auth, app_id):
    result = api(auth, "/betaGroups", {"filter[app]": app_id, "limit": 50})
    if not ok(result):
        return None, describe(result)
    groups = result.get("data", [])
    for group in groups:
        if group.get("attributes", {}).get("isInternalGroup"):
            return group, None
    return None, f"the app has {len(groups)} beta group(s) and none is an internal one"


def add_to_group(auth, group_id, build_id):
    return api(auth, f"/betaGroups/{group_id}/relationships/builds", method="POST",
               body={"data": [{"type": "builds", "id": build_id}]})


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def preflight():
    """Everything that must be true before an archive is worth building.

    Run first, on purpose. Every check here fails in seconds what would
    otherwise fail after the archive and the export, which is several minutes
    later and in a place where Apple's message is buried in toolchain output.
    """
    auth = token()
    app = fetch_app(auth)
    team_id = fetch_team_id(auth)
    print(f"app record: {app['attributes'].get('name')} ({app['id']}) for {BUNDLE_ID}")
    print(f"team id: {team_id}")

    build_number = env("BUILD_NUMBER")
    marketing = env("MARKETING_VERSION")
    existing = fetch_build(auth, app["id"], build_number)
    if existing:
        print(
            f"build {existing['build_number']} for {marketing} is already in App Store Connect "
            f"({existing['state']}, uploaded {existing['uploaded']})"
        )
        output("already-uploaded", "true")
    else:
        output("already-uploaded", "false")

    output("app-id", app["id"])
    output("team-id", team_id)


def wait():
    """Prove the upload arrived, then put the build in the internal group.

    Arrival is the claim worth checking, and the upload command's exit code is
    not evidence of it: `xcodebuild -exportArchive` with an upload destination
    reports success when Apple's content delivery service accepted the bytes,
    which is before the build exists as a record anyone can see or install. So
    this polls App Store Connect until the build is there, prints each state it
    moves through, and fails if the build never appears or arrives unusable.
    """
    auth = token()
    app_id = env("APP_ID")
    build_number = env("BUILD_NUMBER")
    marketing = env("MARKETING_VERSION")
    deadline = time.time() + int(os.environ.get("WAIT_SECONDS", "900"))

    build = None
    last_state = None
    while time.time() < deadline:
        build = fetch_build(auth, app_id, build_number)
        if build:
            if build["state"] != last_state:
                print(
                    f"build {build['build_number']} (marketing {build['marketing'] or marketing}) "
                    f"is {build['state']}, uploaded {build['uploaded']}"
                )
                last_state = build["state"]
            if build["state"] == "INVALID":
                fail(
                    "Apple processed the upload and rejected it, so the build arrived but cannot "
                    "be installed or tested. The reason is in App Store Connect under TestFlight, "
                    "or in the email its processing sent."
                )
            if build["state"] == "VALID":
                break
        time.sleep(int(os.environ.get("POLL_SECONDS", "30")))

    if not build:
        fail(
            f"build {build_number} did not appear in App Store Connect within "
            f"{int(os.environ.get('WAIT_SECONDS', '900')) // 60} minutes. The upload step may have "
            "reported success without delivering, so treat this build as NOT uploaded."
        )

    print(f"build arrived: id {build['id']}, state {build['state']}")
    output("build-id", build["id"])
    output("processing-state", build["state"] or "")

    if build["state"] != "VALID":
        # Arrival is what this job promised; a build still processing is a
        # later, ordinary wait. Saying so beats reporting a failure it is not.
        print(
            f"note: still {build['state']}, so it is not installable yet. Nothing is wrong; "
            "processing usually finishes within half an hour and TestFlight will notify."
        )

    assign(auth, app_id, build, deadline)


def assign(auth, app_id, build, deadline):
    """Put the build in the app's internal TestFlight group.

    Retried rather than attempted once because App Store Connect refuses a build
    it is still processing, and the refusal is a 409 rather than a queue. A
    failure here is reported and does not fail the job: the upload is the thing
    that had to happen, the build is internal-only either way, and the group is
    one click in the web UI.
    """
    group, problem = internal_group(auth, app_id)
    if not group:
        print(f"::warning::could not find an internal TestFlight group ({problem}); "
              "add the build to one in App Store Connect to let testers install it")
        return

    print(f"internal group: {group['attributes'].get('name')} ({group['id']})")
    last = None
    while time.time() < deadline:
        result = add_to_group(auth, group["id"], build["id"])
        if ok(result):
            print(f"added build {build['build_number']} to {group['attributes'].get('name')}")
            return
        last = describe(result)
        if "already" in (last or "").lower():
            print(f"build {build['build_number']} is already in the internal group")
            return
        time.sleep(int(os.environ.get("POLL_SECONDS", "30")))

    print(f"::warning::the build arrived but was not added to the internal group: {last}. "
          "Add it under TestFlight, then the internal testing group, to let testers install it.")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "preflight":
        preflight()
    elif command == "wait":
        wait()
    else:
        fail("usage: asc.py preflight | asc.py wait")
