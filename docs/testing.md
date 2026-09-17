# Testing

What runs where, so a green result is read as evidence of the thing it actually
covers.

| Where | Command | Covers |
|---|---|---|
| `core/` | `npm test` | The shared rules and every parity fixture, by `node --test`. |
| `desktop/` | `npm test`, `npm run check:imports`, `npm run smoke`, `npm run check:package` | The Electron interface, the static import audit, a real GUI boot, and the packaged artifact. |
| `mobile/` | The CI legs, one per iOS version | Compile and unit tests on a simulator, plus the Swift parity tests. |
| `scripts/release/` | `node scripts/release/release.mjs check --version <v>` | Whether a release carries every package it must. |
| Both | `.github/workflows/` | The same suites headless, on every push and pull request. |

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
