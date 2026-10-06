# One project, three trees

Chela is one project with a shared core and one interface per form
factor. The trees are parts of one product, and the test for whether something
belongs where it is: if two interfaces need it, it is core's.

## The repo root is first-class

The root is a real workspace root, not a directory the desktop package happens to
sit in. `package.json` at the root declares the JS workspace (`core` and
`desktop` are its pnpm members), `pnpm-lock.yaml` is the one lockfile, and the
root scripts fan out to every platform:

| Command | Runs |
|---|---|
| `pnpm install` | the workspace install, at the root. `core` is linked into `desktop` as a dependency (`node_modules/claw-core`), not copied. |
| `pnpm run lint` | ESLint over core + desktop (in parallel) and SwiftLint over mobile. |
| `pnpm run test` | every platform's tests: core and desktop through pnpm, mobile through its own toolchain. |
| `pnpm run build` | each platform's build: the desktop package and the iOS app. |

`mobile/` is deliberately NOT a JS workspace member. It is Swift, and it keeps its
own tooling (`xcodegen`, `xcodebuild`, SwiftLint); the root reaches it through
`scripts/mobile.mjs`, so it runs in parallel with the JS platforms rather than
being shoehorned into pnpm. That is what makes the three peers: no platform's
tooling is bolted onto another's, and no platform's directory is the root.

| Tree | What it is | Consumes |
|---|---|---|
| `core/` | The platform-agnostic rules, the specs that name things, the fixtures that pin behaviour, and the app's own pages. No Electron, no SwiftUI. | nothing |
| `desktop/` | The Electron interface for macOS, Windows and Linux. | `core/` |
| `mobile/` | The SwiftUI interface for iOS. | `core/` |
| `scripts/release/` | The release entry point both interfaces' workflows call. | `core/`, `gh` |
| `docs/` | This documentation. | nothing |
| `.github/workflows/` | One workflow per interface, plus the shared conventions they follow. | both trees |

## The rules that keep it one project

1. **Primitives live in core, platform specifics live in the interface.** A
   release primitive, a version comparator and a notice's wording are core's. How
   an Electron window is framed and how an iOS sheet is presented are the
   interface's. A primitive re-implemented in an interface is the fault this rule
   exists to prevent, because the second copy is the one that drifts.
2. **A value more than one surface must agree on has one owner, and how each
   interface consumes it is declared rather than assumed.** A spec in
   `core/spec/` is consumed one of two ways. **Mirrored**: the interface
   ports the values as constants and a parity test asserts them against the file
   on disk, which is right for a name or a number because two copies of a value
   can be compared. **Bundled**: the interface ships the file and reads it at
   runtime, which is right for a file holding a **program**, because a port of a
   script is a second copy of the program in another language rather than a
   comparable value. The planes that import nothing at all, meaning a plist, a
   YAML and a paragraph, are asserted against the owner in a test.
   `core/test/specs.test.js` is the inventory: an unclassified spec fails it,
   and the bundled set is asserted equal to what `mobile/project.yml` ships.
3. **A shared entry point does not live in a child.** `mobile-pipeline.yml`
   used to call `desktop/scripts/build-version.js`, which made one interface
   own something both use. Shared tooling lives in `scripts/`, and a CLI in
   core would break the rule that core modules do no I/O and read no clock.
4. **The mechanism a change replaces is deleted in the same commit as its
   replacement.** A surface with two owners has no owner.
