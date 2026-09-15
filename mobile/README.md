# Claw Mobile

The native iOS client for the OpenClaw Control UI. SwiftUI wrapping the Control
UI in a `WKWebView`, signed with an Apple Developer account and delivered via
TestFlight. The home-screen label is **Claw**.

Status: **in development**. The design and phased plan live in the Projects
database; this directory fills in as the phases land.

## Why native and not a port

Claw Desktop is Electron. Apple's App Store rules forbid any third-party browser
engine, so Electron cannot run on iOS, and there is no iOS Electron target. The
mobile client is therefore a native app that reuses two things from the rest of
the repo:

- **The Control UI itself**, loaded in a `WKWebView`. That is web code and runs
  anywhere.
- **The shared [`core/`](../core/)**, whose rules (config model, token handoff,
  connection state, loading progress, quips, notices) are mirrored in Swift and
  proven against `core/fixtures/` so the two clients cannot drift.

What is reimplemented natively, because it has no cross-platform form:

- The web view host (`WKWebView` instead of an Electron BrowserView).
- Per-gateway secrets in the iOS Keychain, write-only from the web layer.
- Certificate pinning via the navigation delegate: refuse first, trust on an
  explicit tap, pin the exact fingerprint per host.
- Native chrome that tracks the Control UI theme, a loading screen, and a
  connection-failure banner.

What is dropped, because iOS has no equivalent: tray, windows, menus,
close-to-tray, and the self-updater (the App Store and TestFlight own updates).
