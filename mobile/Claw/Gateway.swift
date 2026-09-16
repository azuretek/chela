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
    /// A gateway from what someone typed, or nil when it is not an address this
    /// app can load.
    ///
    /// ## Why there is no default address here
    ///
    /// There used to be one, and there is deliberately not now. This repository
    /// is public, so an address compiled into this file is one machine's own
    /// gateway shipped to everyone who builds the repository, and wrong for all
    /// of them. The address is this device's own configuration instead: entered
    /// on the device, stored on the device, and read from there. See
    /// `GatewayStore`.
    ///
    /// `Info.plist` carries no gateway key and `project.yml` defines no build
    /// setting for one either, for the same reason at one remove: a value that
    /// arrives at build time is still a value baked into an artifact, and the
    /// client is supposed to be the only place the address exists.
    ///
    /// ## The rule, and what it deliberately does not do
    ///
    /// A scheme of `http` or `https`, and a host. Nothing else is required and
    /// no hostname is validated, because a typo is answered by the load itself
    /// with the real reason for it, where a guess here would refuse an address
    /// the device could actually reach.
    ///
    /// A bare host is accepted and given `https`, because that is what someone
    /// types on a phone keyboard and the address these clients are designed
    /// around is a Tailscale Serve one: it terminates a real certificate for
    /// `<host>.<tailnet>.ts.net`, so it loads as ordinary HTTPS with no trust
    /// prompt, which is also why `Info.plist` carries no ATS exception. `http`
    /// stays reachable for the gateway's own `:18789` listener, whose
    /// self-signed certificate is Phase 4's problem rather than this function's.
    static func parse(_ raw: String) -> Gateway? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let url = URL(string: candidate),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let host = url.host,
              !host.isEmpty
        else { return nil }
        return Gateway(name: host, url: url)
    }
}
