# Claw Mobile

The native iOS client for the OpenClaw Control UI. SwiftUI wrapping the Control
UI in a `WKWebView`, signed with an Apple Developer account and delivered via
TestFlight. The home-screen label is **Claw**.

Status: **in development**. The design and phased plan live in the Projects
database; this directory fills in as the phases land.

## Why native and not a port

Claw Desktop is Electron. Apple's App Store rules forbid any third-party browser
engine, so Electron cannot run on iOS, and there is no iOS Electron target. The
mobile client is therefore a native app that reuses two things from the rest of
the repo:

- **The Control UI itself**, loaded in a `WKWebView`. That is web code and runs
  anywhere.
- **The shared [`core/`](../core/)**, whose rules (config model, token handoff,
  connection state, loading progress, quips, notices, update policy) are mirrored
  in Swift and proven against `core/fixtures/` so the two clients cannot drift.

What is reimplemented natively, because it has no cross-platform form:

- The web view host (`WKWebView` instead of an Electron BrowserView).
- Per-gateway secrets in the iOS Keychain, write-only from the web layer.
- Certificate pinning via the navigation delegate: refuse first, trust on an
  explicit tap, pin the exact fingerprint per host.
- Native chrome that tracks the Control UI theme, a loading screen, and a
  connection-failure banner.

What is dropped, because iOS has no equivalent: tray, windows, menus,
close-to-tray, and the self-updater (the App Store and TestFlight own updates).

## Building

The Xcode project is generated, not committed. `project.yml` describes it and
is the single source of truth; `Claw.xcodeproj` and `xcuserdata/` are gitignored
output, so the project's shape has exactly one owner and a change to it arrives
in review as a readable diff rather than as an unreadable `pbxproj` one.

Regenerate after anything that changes the project's shape, meaning
`project.yml` or the layout of the sources:

```
cd mobile && xcodegen generate
```

Then, from `mobile/`:

```
# build for the simulator
xcodebuild -project Claw.xcodeproj -scheme Claw -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' build

# run the shared-core parity tests
xcodebuild test -project Claw.xcodeproj -scheme Claw \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

Signing is `CODE_SIGN_STYLE = Automatic` with `DEVELOPMENT_TEAM` deliberately
left blank in `project.yml`: Xcode fills it from the Apple ID that signs in, so
there is one place the team id lives rather than two that can disagree. Pick the
team once in Xcode's Signing & Capabilities pane before building for a device.

## Releasing to TestFlight

`.github/workflows/mobile-release.yml` builds the client for a device, signs it
with cloud managed signing, and uploads it to TestFlight. Pushing to `main`
touching `mobile/` or `core/` makes a dev build; a `v*` tag makes a release; a
manual dispatch makes a dev build of any ref. `mobile.yml` remains the
credential-free compile-and-test half and never signs anything.

TestFlight is the channel for both kinds of build, so the two differ only in
what they may do once they arrive: a dev build is internal-testing-only and a
tag build may also go to external testers. How either is signed and uploaded is
identical.

The versions come from `desktop/scripts/build-version.js`, the same file the
desktop app is versioned by, and CI passes them to `xcodebuild` as build setting
overrides rather than editing `project.yml`:

| Where it lands | Dev build | Release build |
|---|---|---|
| `CFBundleShortVersionString` | `X.Y.Z` (the next patch) | `X.Y.Z` (the tag) |
| `CFBundleVersion` | the commit count | the commit count |
| `ClawBuildVersion` (read by the app) | `X.Y.Z-dev.<count>.<sha>` | `X.Y.Z` |

The first two are the only shapes App Store Connect accepts: three dot separated
integers, and a build number that increases. The commit count is already the
leading part of the dev version, so a build number and a version name are one
number rather than two that can drift.

Signing needs no certificate export. The `ASC_*` secrets are an App Store
Connect key with the App Manager role, and `-allowProvisioningUpdates` lets
Apple issue the distribution certificate and profile itself. The key is written
to a file with mode 600 for the length of the job and removed by its last step.
The app record in App Store Connect is the one thing CI cannot create; the
workflow checks for it before building and stops with Apple's own message if it
is missing.

## Layout

| Path | What it is |
|---|---|
| `project.yml` | The xcodegen spec, and the project's only source of truth. |
| `Claw/` | The app: the SwiftUI shell, the web view host, and the Swift port of the pieces of `core/` the client needs. |
| `ClawTests/` | Parity tests, run against `core/fixtures/`. |

## Parity with the desktop client

`ClawTests` reads `core/fixtures/*.json` and asserts that the Swift port
reproduces them, which is the same contract `core/test/fixtures.test.js` asserts
for the JS. A port that disagrees with a fixture fails the test; so does a
checkout where the fixtures cannot be found, because a parity test that silently
ran no cases would read as a pass.

The fixtures are located by walking up from the test source file's own path
(`#filePath`), never from a configured or absolute path: an absolute path would
pass on the machine that wrote it and fail everywhere else, and the failure
would look like a parity disagreement rather than a missing file.

`core/spec/*.json` is the source of truth for the data those rules read (the
milestone floors, the easing constants). The Swift mirrors that data as
constants rather than reading it at runtime, because a built app cannot read a
file that lives in the repo and a bundled second copy would be one more thing to
keep in step. The fixtures are what enforce that: change the spec, regenerate,
and the Swift test fails until the port moves with it.
