import Foundation

/// The gateway config model, ported from `core/config-model.js`.
///
/// The shape and the CRUD rules are shared with the desktop, and only the
/// persistence differs: the desktop writes `config.json` under Electron's
/// userData, this client writes `UserDefaults` in `GatewayStore`. What must not
/// differ is the model, because a phone that disagreed about what removing the
/// active gateway does, or about whether an unknown id is an error, is a drift
/// bug that shows up as a list that moved on one device and not the other.
///
/// `ConfigModelParityTests` proves this port reproduces the golden cases in
/// `core/fixtures/config-model.json`, the same file `core/test/fixtures.test.js`
/// asserts on the JS side. That test is the contract: change a rule, regenerate
/// the fixture, and this file is what has to move with it.
///
/// Foundation only, deliberately. No disk, no clock, no UIKit: every function
/// takes a config and returns a new one, and the id generator is the caller's,
/// which is what makes every case in the fixture reproducible.
///
/// One field here has no meaning on this client, and is carried on purpose.
/// `autoUpdate` is part of the shared config shape and the desktop has a switch
/// for it; iOS installs its own apps, so `UpdatePolicy` answers `canInstall:
/// false` here and `core/spec/settings.json` marks that setting absent on this
/// client. The value is stored and never surfaced, which keeps the two clients'
/// configs the same shape without putting a control on screen that could not do
/// anything.

/// A whole config, as stored.
struct Config: Equatable, Codable {
    var gateways: [Gateway]
    /// Which gateway the app loads. Nil is a real state rather than a missing
    /// value: it is what a fresh install has, and what removing the active
    /// gateway leaves behind.
    var activeGatewayId: String?
    /// host -> fingerprint, pinned on first accept. Unused on this client until
    /// the navigation delegate evaluates trust, and carried because the config
    /// shape is shared. See the `queued` list in core/spec/settings.json.
    var trustedCerts: [String: String]
    /// Opt-in, because these facts leave the client and become part of each
    /// ordinary chat prompt sent to the configured gateway. The one Behaviour
    /// setting both clients have.
    var promptMetadata: Bool
    /// See the note at the top of this file: shared shape, never surfaced here.
    var autoUpdate: Bool

    /// A fresh config, as a first run materialises it.
    ///
    /// The suggestions and the id generator are arguments, the same as on the JS
    /// side, so this file carries no platform default of its own. There are no
    /// window bounds and no global shortcut, and their absence is the point: a
    /// config carrying them would hold values nothing on this device could use.
    static func blank(suggested: [(label: String, url: String)] = [], uuid: () -> String) -> Config {
        Config(
            gateways: suggested.compactMap { suggestion in
                guard let parsed = Gateway.parse(suggestion.url, id: uuid()) else { return nil }
                // The label is kept EXACTLY as the suggestion gave it, including
                // when it is empty. `add` is what falls back to the address, and
                // blank does not, which is a distinction the shared model makes and
                // the fixture pins: a port that filled an empty label in here would
                // read as a nicety and would be a disagreement about what a stored
                // config contains.
                return Gateway(id: parsed.id, label: suggestion.label, url: parsed.url)
            },
            activeGatewayId: nil,
            trustedCerts: [:],
            promptMetadata: false,
            autoUpdate: true
        )
    }
}

/// The pure CRUD over a config, mirroring `core/config-model.js` case for case.
enum ConfigModel {
    /// The active gateway, or nil.
    static func active(_ config: Config) -> Gateway? {
        guard let id = config.activeGatewayId else { return nil }
        return config.gateways.first { $0.id == id }
    }

    /// A config with a new gateway appended, plus the entry that was created.
    ///
    /// Returns both so the caller can persist the config and report the id it
    /// assigned, without this needing to know how either happens.
    static func add(_ config: Config, label: String, url: URL, id: String) -> (config: Config, entry: Gateway) {
        // An empty label falls back to the address, which is what names a gateway
        // somebody pasted rather than typed a name for.
        let entry = Gateway(id: id, label: label.isEmpty ? url.absoluteString : label, url: url)
        var next = config
        next.gateways = config.gateways + [entry]
        return (next, entry)
    }

    /// A config with gateway `id` patched. A nil field is left alone, and an id
    /// that is not there changes nothing, which is what the fixture pins.
    static func update(_ config: Config, id: String, label: String? = nil, url: URL? = nil) -> Config {
        var next = config
        next.gateways = config.gateways.map { gateway in
            guard gateway.id == id else { return gateway }
            var patched = gateway
            if let label { patched.label = label }
            if let url { patched.url = url }
            return patched
        }
        return next
    }

    /// A config with gateway `id` removed.
    ///
    /// If it was the active gateway the pointer is cleared too, because a pointer
    /// to a gateway that no longer exists is a state nothing else guards against.
    static func remove(_ config: Config, id: String) -> Config {
        var next = config
        next.gateways = config.gateways.filter { $0.id != id }
        if config.activeGatewayId == id { next.activeGatewayId = nil }
        return next
    }

    /// A config with `host` pinned to `fingerprint`, replacing any earlier pin for
    /// that host and leaving the others alone.
    static func trustCert(_ config: Config, host: String, fingerprint: String) -> Config {
        var next = config
        next.trustedCerts[host] = fingerprint
        return next
    }
}
