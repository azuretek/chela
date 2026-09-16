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
    ///
    /// ## Why no address is written here
    ///
    /// This repository is public. A client that compiled in its author's own
    /// gateway address would ship that address to everyone who reads the
    /// source, which is the same leak as a real hostname in a fixture and has
    /// the same fix: the address must not be a constant in the repo.
    ///
    /// So it arrives in the bundle's `ClawGatewayURL`, which `project.yml`
    /// feeds from the `CLAW_GATEWAY_URL` build setting. That setting's neutral
    /// default is in `Config/Local.xcconfig`, and a build that should reach a
    /// real gateway takes its value from `Config/Local.private.xcconfig` beside
    /// it, which git ignores. It is the same shape `build-device.sh` uses for
    /// the Apple team id: a value personal to one machine arrives from outside
    /// the repo, and the repo keeps only what is true for everyone.
    ///
    /// The name is the address's own host, which is what tells two gateways on
    /// one tailnet apart, so it is derived rather than written down a second
    /// time.
    static let `default` = Gateway(
        name: configuredURL.host ?? configuredURL.absoluteString,
        url: configuredURL
    )

    /// The address a fresh clone suggests, and the one the desktop's own
    /// suggested list carries (`desktop/src/defaults.js`). Obviously an example
    /// rather than somebody's machine, which is the whole point of it.
    private static let placeholderURL = URL(string: "https://your-host.your-tailnet.ts.net")!

    /// The address this build was compiled with, or the placeholder when it
    /// carries none, which is the state of a fresh clone.
    ///
    /// A value that did not substitute, which is what an unset build setting
    /// would leave in the plist, has no host and so falls back here as well:
    /// the placeholder is a better failure than loading a literal `$(...)`.
    private static var configuredURL: URL {
        let raw = Bundle.main.object(forInfoDictionaryKey: "ClawGatewayURL") as? String ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed), url.host != nil else {
            return placeholderURL
        }
        return url
    }
}
