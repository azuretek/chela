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
pairs: `core/test/` in JavaScript and `mobile/ClawTests/*ParityTests`
in Swift. That is what turns "the two interfaces agree" into something a failing
test can contradict, and it is why a spec change regenerates the fixtures in the
same commit.

## A green unit run is not evidence the app starts

Which is the whole reason the smoke exists, and worth repeating here: no exit
code, no "success" line and no passing suite says an Electron app boots, a window
appears, or a page renders. Those are separate checks, and `desktop/test/`
plus `desktop/scripts/dump-overlays.js` are where they live.
