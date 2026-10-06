# Chela (chela-mobile)

The native iOS client for the OpenClaw Control UI. SwiftUI wrapping the Control
UI in a `WKWebView`, signed with an Apple Developer account and delivered via
TestFlight. The home-screen label is **Chela**.

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
is the single source of truth; `Chela.xcodeproj` and `xcuserdata/` are gitignored
output, so the project's shape has exactly one owner and a change to it arrives
in review as a readable diff rather than as an unreadable `pbxproj` one.

Regenerate after anything that changes the project's shape, meaning
`project.yml` or the layout of the sources:

```
cd mobile && xcodegen generate
```

From the repo root the same step, and the lint that goes with it, are `node scripts/mobile.mjs build` (which generates the project first), `node scripts/mobile.mjs test` (which generates it and builds for testing on the simulator) and `node scripts/mobile.mjs lint` (SwiftLint). `pnpm run lint` at the root runs SwiftLint alongside the JS lint. A fresh checkout has no `Chela.xcodeproj` until one of them, or `xcodegen generate`, has run, and `xcodebuild` before then exits 66 with `'Chela.xcodeproj' does not exist` and builds nothing.

Then, from `mobile/`:

```
# build for the simulator
xcodebuild -project Chela.xcodeproj -scheme Chela -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' build

# run the shared-core parity tests
xcodebuild test -project Chela.xcodeproj -scheme Chela \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

To run part of a suite, name it with `-only-testing` as `<target>/<class>` or `<target>/<class>/<test>`, where the target is `ChelaTests` or `ChelaUITests`:

```
xcodebuild test -project Chela.xcodeproj -scheme Chela \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:ChelaUITests/<class>
```

Signing is `CODE_SIGN_STYLE = Automatic` with `DEVELOPMENT_TEAM` deliberately
left blank in `project.yml`: Xcode fills it from the Apple ID that signs in, so
there is one place the team id lives rather than two that can disagree. Pick the
team once in Xcode's Signing & Capabilities pane before building for a device.

## Driving a debug build

A script cannot tap, type into or swipe a simulator, so a debug build takes launch arguments that put it in the state a check needs: a gateway to load, a sheet open, a button pressed, a notice or a refusal seeded. Each one drives the app's real path (the real store and raisers, the page's own button handler), so a screenshot or a UI test shows the real screen rather than a mock of it. Every one is compiled out of a release build and does nothing without its argument.

Pass them after the bundle id, which is the app target's `PRODUCT_BUNDLE_IDENTIFIER` in `project.yml`, or in a UI test's `launchArguments`:

```
xcrun simctl launch booted <bundle id> -claw-open-settings -claw-settings-tab <id>
```

| Argument | What the run does |
|---|---|
| `-claw-gateway-url <url>` | Loads that gateway instead of the list the device keeps. |
| `-claw-seed-notices` | Fills the notice banner with one sample notice per tone. |
| `-claw-settings-tab <id>` | Opens the settings page on that tab. |
| `-claw-open-settings` | Opens the settings sheet at launch. |
| `-claw-open-about` | Opens About from Settings, by the route its button takes. |
| `-claw-settings-scroll-bottom` | Scrolls the settings page to its foot, so the footer of a long tab can be shown. |
| `-claw-check-updates` | Presses About's Check for updates, whose answer is drawn only after a press. |
| `-claw-open-testflight` | Presses the update notice's own action. |
| `-claw-press <settings\|about>:<element id>` | Presses that button on the shared page, through the page's own handler. |
| `-claw-seed-update-feed <version>` | Runs the update check against a seeded feed advertising that version, instead of the network. |
| `-claw-seed-pairing` | Shows the pairing screen for a sample refusal, through the real pairing state and its retry timer. |
| `-claw-seed-revocation` | Drives an authenticated session into a revocation and its route to the gateway list. It needs `-claw-gateway-url` for a gateway to draw over. |

The two credentials a run can need are environment variables rather than arguments, so neither appears in the argument list a process listing shows. `OPENCLAW_SEED_TOKEN` is a gateway token, stored for the `-claw-gateway-url` gateway through the settings page's write-only path, so a run can connect and authenticate end to end. `OPENCLAW_SEED_BOOTSTRAP_TOKEN` is a setup-code bootstrap token, handed to the Control UI's pairing handshake on the URL fragment, so a run can take the real pairing path. Set them in a UI test's `launchEnvironment`, or for `simctl launch` with the `SIMCTL_CHILD_` prefix, which `simctl` strips before the app sees them.

Where a check needs a state none of these reaches, add an argument the same way: under `#if DEBUG`, inert without its argument, driving the real path, with a doc comment saying why it exists, and a row in this table.

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
| `Chela/Gateway.swift` | Turns what someone typed into the address the web view loads, or refuses it. |
| `Chela/ConfigModel.swift` | The list's rules: add, edit, remove, and which one is active. A port of `core/config-model.js`, proven against `core/fixtures/config-model.json`. |
| `Chela/GatewayStore.swift` | The persistence, and the only reader and writer of the key. `UserDefaults`, and it reads the single address an older build left behind. |
| `Chela/GatewayURL.swift` | Hands a stored token over on the URL fragment, ported from `core/gateway-url.js`. |
| `Chela/SettingsCredentials.swift` | The token and password, in the Keychain, write-only from the page. |

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
host is running it. On this client the host is `Chela/SettingsHost.swift`: it
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
`ChelaTests/SettingsSpecTests.swift` asserts the split agrees with what this client
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
pnpm --filter chela-desktop run icons
```

The icon follows the Control UI's theme without knowing any theme. `core/app-icons.js` owns the design's two palettes (neon for dark, paper for light) and one rule that recolours them for any accent: the accent's hue first, a near-complement 130 degrees round the wheel as a small second accent. The app ships one pair per hue step round the wheel plus a neutral pair, and each half of a pair is its own alternate icon set with a single rendition: paper for light and neon for dark. They are separate sets, not one set with a dark-appearance rendition, because iOS picks a set's rendition by the home screen's icon appearance rather than the app's theme, so with the interface in one mode and the phone in the other, switching to a two-rendition set changes nothing visible. The primary `AppIcon`, the one the App Store and a fresh install show, keeps both renditions. `AppIcons.swift` sets the icon for the live accent in the mode the Control UI resolved (the device's, when the page resolved none), whenever the theme changes and when the app returns to the foreground, and iOS confirms each change with its own alert. The buckets it reads come from `core/spec/app-icons.json`, which is generated.

That writes `Chela/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`, which is
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

Styling comes from the same place as the desktop's. `Chela/Assets.xcassets/AccentColor`
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
shared: [../docs/RELEASE.md](../docs/RELEASE.md). What is specific to this
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
| `Chela/` | The app: the SwiftUI shell, the web view host, and the Swift port of the pieces of `core/` the client needs. |
| `ChelaTests/` | Parity tests, run against `core/fixtures/`. |
| `ChelaUITests/` | UI tests through XCUITest, which launch the app with the debug arguments above and assert what it draws. |

## Parity with the desktop client

`ChelaTests` reads `core/fixtures/*.json` and asserts that the Swift port
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
