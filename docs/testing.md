# Testing

What runs where, so a green result is read as evidence of the thing it actually
covers.

| Where | Command | Covers |
|---|---|---|
| the root | `pnpm run lint` | ESLint over core + desktop and SwiftLint over mobile, run in parallel, each platform with its own tool. |
| the root | `pnpm run test` | Every platform's tests through the root fan-out (core and desktop via pnpm, mobile via its own toolchain). |
| `core/` | `pnpm --filter claw-core test` | The shared rules and every parity fixture, by `node --test`. |
| `desktop/` | `pnpm --filter chela-desktop test`, `run measure`, `run check:imports`, `run smoke`, `run check:package` | The Electron interface, the pages and the forms as RENDERED, the static import audit, a real GUI boot, and the packaged artifact. |
| `mobile/` | `node scripts/mobile.mjs lint` (SwiftLint), and the CI legs, one per iOS version | Style, and compile and unit tests on a simulator plus the Swift parity tests. |
| `mobile/`, on a Mac | `node scripts/mobile-surface-proof.mjs --out DIR --device UDID --quiet-gate PATH --apply` | The opt-in sheet UI tests (`SheetBandUITests`, `SurfacesHandoffUITests`) against their fixtures, in the light and the dark appearance: the band's colour, the dim, the blur, and a tap outside a sheet. Builds before it boots the simulator, and writes `DIR/all.state` only once the simulator is shut down again. |
| `scripts/release/` | `node scripts/release/release.mjs check --version <v>` | Whether a release carries every package it must. |
| all three | `.github/workflows/` | The same suites headless, on every push and pull request. |

The root scripts are the entry point, and each reaches a platform through that
platform's own tooling: the JS lint and tests through pnpm's workspace, mobile
through `scripts/mobile.mjs`. No platform's directory is the root, and neither is
the desktop package's.

## The local gate, and why it is a hook

CI covers the headless half: the unit tests, the static import audit, and the
packaged-artifact audit. What CI cannot run is the GUI boot smoke, because
GitHub's macOS runners have no session to launch Electron into, and that is the
check that catches the fault which actually shipped: a build that passed every
test and still opened a fatal error dialog on start.

So the smoke is a **push gate**, in `.githooks/pre-push`, which runs
`npm run verify` in `desktop/`. It is advisory and deliberately so:
`git push --no-verify` skips it, and a fresh clone has no hook until
`core.hooksPath` points at it. **A green hook is the fast local signal, never
the only one**; the unskippable gate is the CI run on the commit that was pushed.

## The commit gate: the measured half

The unit suites read source. What they cannot see is the RENDERED page, and that is
where this project's repeated faults have lived: a rule that applies to nobody
because a later one overrides it, a strip that paints where the design says the page
shows through, a control that is present in the DOM and dead on screen.
`desktop/scripts/capture-pages.js` and `capture-gateway-form.js` load the real pages
from `core/ui` in Electron with a stub host, in both appearances, and assert over
what was DRAWN.

So they are a **commit gate**, in `.githooks/pre-commit`, which runs `npm run
measure`. It is advisory in the same two ways the push gate is, and it SKIPS by name
rather than passing quietly on a host with no Electron: a silent pass is a green line
for work nobody did.

The reason it is worth its minute, measured rather than argued: two assertions in
`capture-pages.js` had been failing on `main` for a day and nothing could report
them. CI cannot run the harnesses, no unit test reads them, and the last run was a
person's memory of having run one by hand. Both were corrected on 2026-09-18, when
this gate was added: they asserted the strip was UNPAINTED, which was the design the
banner had already reversed, because a pixel of its view that the page does not paint
is a dead zone over the Control UI.

## Parity is proven, not asserted

`core/fixtures/` holds input/output pairs, and both sides reproduce the same
pairs: `core/test/` in JavaScript and `mobile/ChelaTests/*ParityTests`
in Swift. That is what turns "the two interfaces agree" into something a failing
test can contradict, and it is why a spec change regenerates the fixtures in the
same commit.

## A green unit run is not evidence the app starts

Which is the whole reason the smoke exists, and worth repeating here: no exit
code, no "success" line and no passing suite says an Electron app boots, a window
appears, or a page renders. Those are separate checks, and `desktop/test/`
plus `desktop/scripts/dump-overlays.js` are where they live.

## A pixel test names the surface it judged

**★ A capture is judged only after the screen is shown to be the app's** (issue #174).
A screenshot cannot say whether the frame it holds is the app or a system surface drawn
over it, and both pixel lanes have been bitten by the difference: a cold Android
emulator's launcher ANR dialog holds focus over the app and fails every pixel test that
blames the page, and on iOS a system surface winning the foreground arrives as
"Failed to get screenshot: Timed out while requesting screenshot". So the lane asks
first.

- Android: `android/scripts/boot-proof.sh` hides system error dialogs
  (`settings put global hide_error_dialogs 1`), reads the setting back so a silent no-op
  fails there, asserts the three animation scales are zero, waits bounded for our window
  to hold input focus, and clears another app's ANR dialog with the system's close-dialogs
  broadcast.
- iOS: `mobile/ChelaUITests/SystemSurface.swift` requires the app to be frontmost and no
  SpringBoard alert to be up before `SheetBandUITests` and `SurfacesHandoffUITests` read
  a pixel; a covered screen fails naming the surface, and the same suffix is appended to a
  capture comparison failure.

Why: the failure mode is not a broken test, it is an environment fault accusing the app,
and every occurrence costs a re-run to clear. Held by `desktop/test/surface-guard.test.js`
"the android boot script prepares the device surface and reads it back" and "a system
surface is named before a pixel is judged on the iOS lane", which fail if a rewrite drops
either half.
