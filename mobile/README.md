# Claw Control UI (claw-mobile)

The native iOS client for the OpenClaw Control UI. SwiftUI wrapping the Control
UI in a `WKWebView`, signed with an Apple Developer account and delivered via
TestFlight. The home-screen label is **Claw Control UI**.

Status: **in development**. The design and phased plan live in the Projects
database; this directory fills in as the phases land.

## Why native and not a port

The desktop client is Electron. Apple's App Store rules forbid any third-party browser
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

## The gateway the app loads

No address is in this repository, and none is compiled into the app. It is this
device's own configuration: entered on the phone, stored on the phone, and read
from there at launch. The reason is the same one that keeps real hostnames out
of the fixtures. This repository is public, so a gateway baked into it would be
one machine's own address shipped to everyone who builds the repo, and wrong for
all of them anyway.

Where it lives:

| Where | What it does |
|---|---|
| `Claw/GatewaySetupView.swift` | Asks for the address, once, on first run. |
| `Claw/GatewayStore.swift` | Validates it and stores it in `UserDefaults`, and is the only reader and writer of the key. |
| `Claw/Gateway.swift` | Turns what someone typed into the address the web view loads, or refuses it. |

A bare host is accepted and given `https`, because that is what a phone keyboard
makes easy to type. When a load fails the connection notice offers **Open
Settings**, which brings the same surface back with the current address in it,
so a typo is recoverable without reinstalling the app. Phase 6 replaces this
single value with a list and a picker.

## The app icon

The icon is **the desktop app's mark**, and there is exactly one of it. The
artwork is `core/ui/assets/claw.svg`, the same file the desktop icon is
rasterised from, and `desktop/scripts/make-icons.mjs` emits every platform's
icon from it with one command, from the repo root:

```
npm --prefix desktop run icons
```

That writes `Claw/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`, which is
the file the icon set names in its `Contents.json`, alongside the desktop app's
own PNGs. A bitmap copied from one platform to another would be a second owner
of the artwork, and the two copies would disagree the first time only one of
them was regenerated, so there is no copy: the generator reads the SVG and
writes both.

The PNG is committed rather than built, for the same reason the desktop ones
are: sharp is a heavy native dependency, and nothing in the mobile workflow runs
npm, so a generated-only file would mean a build with no icon in it.

Two things about the iOS output are deliberate, and both are Apple's
requirement rather than a style choice:

- **Square and opaque.** App Store Connect rejects an icon carrying an alpha
  channel, and iOS applies its own corner mask to whatever it is given, so an
  icon shipped as the desktop tile would arrive double-rounded with transparent
  corners. The square treatment crops the tile to its own edges, fills the
  transparent corners out of the tile's own gradient, drops the hairline the
  artwork draws along its edge to lift the tile off a dark wallpaper, and
  removes the alpha channel. iOS rounds the result, which is why the two
  platforms look the same on screen.
- **One size, not a pile of them.** The icon set has a single 1024x1024
  `universal` entry and Xcode derives every size the app needs from it, so
  there is no `AppIcon60x60@2x.png` to keep in step with anything.
  Hand-authoring the legacy sizes would be several files that can only disagree
  with each other.

Styling comes from the same place as the desktop's. `Claw/Assets.xcassets/AccentColor`
carries the desktop's own accent reds, `#c62828` in the light appearance and
`#ff4d4d` in the dark one, which is what `desktop/src/ui/ui.css` declares for
the same two appearances.

An icon set with no image in it is the failure this replaced, and it is worth
knowing why it is easy to miss: it compiles, signs, exports and uploads without
a single warning, and App Store Connect is the first thing to object, as
`ITMS-90713` (no `CFBundleIconName`) and `ITMS-90022` (no 120x120 rendition).
The archive step of the release job therefore asserts both halves before
anything is uploaded: that `CFBundleIconName` is in the built plist, under
either the top level or `CFBundleIcons`, and that the compiled `Assets.car`
really holds an icon of that name.

## Testing and releasing to TestFlight

`.github/workflows/mobile-pipeline.yml` is the whole mobile pipeline in one
file, and the only one that owns it: version, then a test leg per iOS version,
then release. Pushing to `main` touching `mobile/` or `core/` tests the commit
and uploads a dev build; a `v*` tag makes a release; a manual dispatch makes a
dev build of any ref; a pull request runs the test legs only, needs no Apple
credential and never signs anything.

The release job needs the test matrix, so a failing leg cannot produce a
TestFlight build. The legs build for the simulator and the release archives for
a device, so there is no build to share between them: what is shared is within a
leg, where the compile gate and the test run use one `build-for-testing` product
through `test-without-building`, and within the release job, where the single
archive is verified, exported and uploaded without being rebuilt.

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

Signing needs no certificate export, for the archive. The `ASC_*` secrets are an
App Store Connect key with the App Manager role, and `-allowProvisioningUpdates`
lets Apple issue the certificate and the profile itself: a run that starts with
an empty keychain archives successfully, signed by an `Apple Development`
certificate the service mints on the spot, which is what "Created via API" in
its name records. The archive therefore carries a development identity, which is
what an automatically signed archive is; the App Store export is the step that
re-signs it with an Apple Distribution certificate.

That export is where cloud signing stops, and it stops for a reason in the
account rather than in this workflow. Xcode asks Apple for a cloud-managed
distribution certificate and Apple refuses with a 403:

    You haven't been given access to cloud-managed distribution certificates.
    Please contact your team's Account Holder or an Admin to give you access.

Measured on 2026-09-15 (run 35045131182), and the refusal is specifically about
the managed certificate Xcode wants rather than about the key's reach: the same
key registers bundle ids and issues an Apple Distribution certificate through
the App Store Connect API when it is asked directly. So the export cannot
succeed until somebody with the Account Holder or Admin role grants access to
cloud-managed distribution certificates. Until then the run gets past the
archive and dies in the export with "Cloud signing permission error" and "No
profiles for 'com.azuretek.claw-mobile' were found", neither of which names a
cause, which is why the step after the export reads Apple's own answer back out
of Xcode's distribution log.

One consequence of signing this way is worth knowing: the development
certificate is minted per run, because every runner starts with an empty
keychain and no private key that matches one already in the account, so each run
leaves a certificate behind that can never sign anything again. They are issued
to a key that died with its runner, and they accumulate in the account.

The app record in App Store Connect is the other thing CI cannot create. The
workflow checks for it before building and stops with Apple's own message if it
is missing, and the bundle id itself is registered, so that check fails on the
app record alone.

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

One spec is the exception, and it is the interesting one. `spec/
prompt-metadata.json` holds the script the clients inject to put the
client-context block on every outgoing prompt, and a script cannot be mirrored:
a Swift copy of it would be a second copy of the same script in another
language, which is exactly the drift the shared file exists to prevent. So the
app BUNDLES that one spec (`project.yml` copies it in as a resource) and reads
it at runtime, and `PromptMetadataParityTests` asserts that what it reads is
byte-identical to the repo's copy and to what the desktop installs. Everything
else about the block (the marker, the field order, the value rules, the identity)
is ported and proven against the fixtures in `core/fixtures/prompt-metadata.json`
like any other rule.
