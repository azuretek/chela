# Claw Control UI

Native clients for the [OpenClaw](https://github.com/openclaw/openclaw) Control
UI. One product, one shared core, a client per form factor.

| Directory | What it is |
|---|---|
| [`desktop/`](desktop/) | Claw Control UI, desktop (`claw-desktop`). The Electron app for macOS, Windows and Linux: own icon, tray, global shortcut, multiple gateway profiles. Ships today. |
| [`mobile/`](mobile/) | Claw Control UI, mobile (`claw-mobile`). The native iOS client (SwiftUI + WKWebView), delivered via TestFlight. In development. |
| [`core/`](core/) | The platform-agnostic rules both clients share: gateway config model, token handoff, connection state, loading progress, notices. No Electron, no SwiftUI. |

## Why a shared core

The clients must behave identically where it counts: how a token is handed to
the Control UI, what a connection failure says, how the loading bar moves, which
certificate is trusted. Those rules live once in `core/` and both clients
consume them, so a change is made in one place and cannot drift between the two.
`core/fixtures/` pins the behaviour as input/output pairs that each client's
tests reproduce, which is what turns "should match" into "does match".

## Clients

**`claw-desktop`** is the mature one. Its own README in [`desktop/`](desktop/)
covers setup, connecting to a gateway, where data lives, and the whole
build/release pipeline. It is Electron, so it does not and cannot run on a
phone.

**`claw-mobile`** is the native iOS client, because Apple forbids third-party
browser engines and Electron has no iOS target. It reuses `core/` and the
Control UI itself; only the shell (web view host, Keychain-backed secrets,
certificate pinning, native chrome) is reimplemented in Swift.

## Status and licence

A personal project, shared because it might be useful, not a product. No support
commitment, no release schedule.

**Not affiliated with the OpenClaw project.** These are independent clients for
its Control UI.

MIT, see [LICENSE](LICENSE).
