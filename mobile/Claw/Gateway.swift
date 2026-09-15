import Foundation

/// A gateway the app can open.
///
/// A record rather than a bare `URL`, even though there is exactly one of them
/// this phase: Phase 6 turns this into a list the user switches between, and
/// that needs a label to show and a URL to load. Keeping the pair together now
/// means the list, its store and its picker are additive later, rather than a
/// rewrite of every call site that only ever wanted a URL.
struct Gateway: Equatable {
    /// What a picker would show. The host name by default, since that is what
    /// tells two gateways on the same tailnet apart.
    let name: String
    let url: URL
}

extension Gateway {
    /// The gateway loaded until Phase 6 offers a choice.
    ///
    /// The Tailscale Serve address rather than a LAN address or the gateway's
    /// own `:18789` listener. Serve terminates a real certificate for
    /// `<host>.<tailnet>.ts.net`, so this loads as ordinary HTTPS: no trust
    /// prompt, and in Phase 4 a real chain to check instead of a self-signed
    /// one. It is also why `Info.plist` carries no ATS exception (see the note
    /// there). Same reasoning as `desktop/src/defaults.js`, which lists the
    /// Serve form first for the same reason.
    static let `default` = Gateway(
        name: "example-host",
        url: URL(string: "https://example-host.example-tailnet.ts.net")!
    )
}
