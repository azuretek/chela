import Foundation

/// A gateway the app can open.
///
/// A record rather than a bare `URL`: a row in the settings list is shown under a
/// label, edited, and then removed or connected by identity. `label` is what the
/// list shows and what someone can change; `url` is what the app loads; `id` is
/// what an edit or a removal names, because two gateways can share a host and the
/// same one can be re-addressed, and an operation matching on the address would
/// act on the wrong row in the first case and lose that row's credentials in the
/// second.
///
/// `ConfigModel` holds the rules for adding, editing and removing these, and the
/// list itself lives in `GatewayStore`.
struct Gateway: Equatable, Codable {
    let id: String
    var label: String
    var url: URL
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
    /// self-signed certificate is a later phase's problem rather than this
    /// function's.
    ///
    /// The id is a parameter with a default rather than generated inside and
    /// inaccessible: `core/config-model.js` passes an id generator in for the
    /// same reason, because a fixture compared between two ports cannot contain a
    /// generated value.
    static func parse(_ raw: String, id: String = UUID().uuidString) -> Gateway? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let url = URL(string: candidate),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let host = url.host,
              !host.isEmpty
        else { return nil }
        // The label starts as the host, which is what tells two gateways on one
        // tailnet apart and what `desktop/src/defaults.js` names its own
        // suggestions from. It is editable afterwards.
        return Gateway(id: id, label: host, url: url)
    }
}
