# Claw Control UI

Native clients for the [OpenClaw](https://github.com/openclaw/openclaw) Control
UI. **One project, one shared core, one interface per form factor.**

| Tree | What it is |
|---|---|
| [`core/`](core/) | The platform-agnostic rules both interfaces share: gateway config model, token handoff, connection state, loading progress, notices, the release primitives, and the app's own pages. No Electron, no SwiftUI. |
| [`desktop/`](desktop/) | The desktop interface (`claw-desktop`), an Electron app for macOS, Windows and Linux. Ships today. |
| [`mobile/`](mobile/) | The iOS interface (`claw-mobile`), native SwiftUI. Distributed through our own releases. |
| [`docs/`](docs/) | The shared documentation: how the trees fit together, how a release works, and what runs where. |

These are not separate projects that happen to share code. The interfaces differ
in how they present things and in what the platform makes possible, and
everything else has one owner: it lives in core, or in a spec that both sides
import or mirror, or in a shared script both workflows call.

## Start here

- **Using or building the desktop app:** [`desktop/README.md`](desktop/README.md).
- **Building the iOS client:** [`mobile/README.md`](mobile/README.md).
- **How the shared rules work and how to change one:** [`core/README.md`](core/README.md).
- **How a build becomes a release:** [`docs/release.md`](docs/release.md).
- **What to run before pushing:** [`docs/testing.md`](docs/testing.md).
- **Where something belongs:** [`docs/layout.md`](docs/layout.md).

## Why a shared core

The interfaces must behave identically where it counts: how a token is handed to
the Control UI, what a connection failure says, how the loading bar moves, which
certificate is trusted, what a release must contain. Those rules live once in
`core/` and both interfaces consume them, so a change is made in one place
and cannot drift. `core/fixtures/` pins that behaviour as input/output pairs
each side's tests reproduce, which is what turns "should match" into "does match".

## Status and licence

A personal project, shared because it might be useful, not a product. No support
commitment, no release schedule.

**Not affiliated with the OpenClaw project.** These are independent clients for
its Control UI.

MIT, see [LICENSE](LICENSE).
