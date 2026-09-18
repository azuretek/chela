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
| `Claw/Gateway.swift` | Turns what someone typed into the address the web view loads, or refuses it. |
| `Claw/ConfigModel.swift` | The list's rules: add, edit, remove, and which one is active. A port of `core/config-model.js`, proven against `core/fixtures/config-model.json`. |
| `Claw/GatewayStore.swift` | The persistence, and the only reader and writer of the key. `UserDefaults`, and it reads the single address an older build left behind. |
| `Claw/GatewayURL.swift` | Hands a stored token over on the URL fragment, ported from `core/gateway-url.js`. |
| `Claw/SettingsCredentials.swift` | The token and password, in the Keychain, write-only from the page. |

A bare host is accepted and given `https`, because that is what a phone keyboard
makes easy to type. When a load fails the connection notice offers **Open
Settings**, which opens the surface below on the gateway list, so a typo is
recoverable without reinstalling the app.

## The settings surface

The phone renders the DESKTOP's settings page. `core/ui/settings.html`, with
`core/ui/settings.js` and `core/ui/ui.css`, is bundled into this app and loaded in
a `WKWebView`, so there is one implementation of every tab rather than a native
screen per client. That is the same arrangement as the shared core, one step
further out: one page, rendered by both, rather than two that agree until somebody
edits one.

What differs between the clients is which tabs and which settings apply, and that
is data in `core/spec/settings.json`, handed to the page at runtime by whichever
host is running it. On this client the host is `Claw/SettingsHost.swift`: it
answers the command names the desktop's preload answers, over a
`WKScriptMessageHandler` instead of IPC, and the page never asks which client it is.

So the phone has **Gateways** and **Behaviour** in full, and does not have:

- **Certificates**, because deciding a refused certificate needs the navigation
delegate to evaluate trust, which is not built. The rules are already shared and
already ported, so turning it on is that work plus one word in that spec.
- **Problems**, because it is the on-disk record: a raise and its clear paired into
one row, a file per month, three months kept. The live conditions are already
shared here, and nothing writes them down.
- the desktop-only settings on Behaviour (tray, launch at login, the global
shortcut, automatic updates), and the extra request headers on a gateway, each with
its reason written beside it in that spec.

Every one of those absences is a decision recorded there rather than a gap, and
`ClawTests/SettingsSpecTests.swift` asserts the split agrees with what this client
implements, in both directions. `-claw-settings-tab <id>` opens a named tab in a
debug build, for the same reason `-claw-seed-notices` exists: a simulator cannot be
tapped by a script, and a screen nobody has looked at is a screen nobody has
checked.

Two facts reach the page on the host object rather than in its URL, and that is not
a preference: a file URL with a query renders a blank document in this web view,
with no error anywhere. The desktop passes both as query parameters, and stating
them at document start lands at the same moment, before first paint.

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

## Testing and releasing

The triggers, the version table, the signing story and the iOS install path are
shared: [../docs/release.md](../docs/release.md). What is specific to this
interface:

- The whole pipeline is `.github/workflows/mobile-pipeline.yml`, one file:
  version, a test leg per iOS version, then release. The release job needs the
  test matrix, so a failing leg cannot produce a build.
- The legs build for the simulator and the release job archives for a device, so
  nothing is shared across that boundary. Within a leg the compile gate and the
  test run use one `build-for-testing` product; within the release job the
  single archive is verified, exported and uploaded without being rebuilt.
- The app record in App Store Connect is the one thing CI cannot create: the
  workflow checks for it before building and stops with Apple's own message when
  it is missing, and the bundle id itself is registered.
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

`core/spec/*.json` is the source of truth for the values and the programs both
interfaces use. How a client consumes one is declared rather than assumed, and
`core/test/specs.test.js` is the inventory that fails when a spec is neither
classified nor shipped:

- **Mirrored** specs are ported as Swift constants and proven against the file on
  disk by a parity test, which is right for a name or a number because two copies
  of a value can be compared. The fixtures enforce the behaviour the port
  reproduces: change the spec, regenerate, and the Swift test fails until the
  port moves with it.
- **Bundled** specs are copied into the app by `project.yml` and read at
  runtime through one loader, `BundledSpec`, and this is the pattern everything is
  moving to: a mirror is a second copy kept in step by a test, and the app can
  carry the one owner instead. The inventory in `core/test/specs.test.js` is both
  the list and its owner, and the specs bundled today are the ones a mirror cannot
  serve: `prompt-metadata.json`, `app-settings-affordance.json`,
  `pairing.json` and `device-identity.json` hold the injected scripts the
  clients install, `native-control-auth.json` and `gateway-identity.json` hold
  the global a page authenticates with and the signals it is recognised by, and
  `naming.json`, `progress.json`, `settings.json` and
  `upstream-reference.json` are values a client reads rather than re-declares.

A Swift copy of a script would be a second copy of the program in another
language, which is exactly the drift the shared file exists to prevent, so the
copy that ships IS the one owner. The parity tests prove it twice over: the
bundled copy is asserted byte for byte against the repository's, and every value
the client uses (the marker, the field order, the framing, the value rules, the
identity) is read from that same file rather than mirrored.
