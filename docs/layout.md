# One project, three trees

Claw Control UI is one project with a shared core and one interface per form
factor. The trees are parts of one product, and the test for whether something
belongs where it is: if two interfaces need it, it is core's.

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
2. **A value more than one surface must agree on has one owner.** The specs in
   `core/spec/` hold those values: imported where the language allows it,
   mirrored with a parity test where it cannot be (`mobile/Claw` mirrors
   `core/`), and asserted against the owner in a test for the planes that
   import nothing at all, which is how a plist, a YAML and a paragraph stay in
   step. A rename is then one edit plus whatever those assertions name.
3. **A shared entry point does not live in a child.** `mobile-pipeline.yml`
   used to call `desktop/scripts/build-version.js`, which made one interface
   own something both use. Shared tooling lives in `scripts/`, and a CLI in
   core would break the rule that core modules do no I/O and read no clock.
4. **The mechanism a change replaces is deleted in the same commit as its
   replacement.** A surface with two owners has no owner.
