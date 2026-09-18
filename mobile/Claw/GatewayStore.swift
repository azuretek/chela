import Combine
import Foundation

/// The gateway list this device holds, and the only thing that writes it.
///
/// The client is the only place an address exists. Nothing in the repository
/// names one and nothing in the build carries one, which is why this store has no
/// default to fall back on: an unconfigured install has no gateway rather than
/// somebody else's, and the app asks for one instead of loading a guess.
///
/// The rules for what adding, editing and removing do to the list are NOT here.
/// They are `ConfigModel`, which is a port of `core/config-model.js` proven
/// against the shared fixture, so the phone and the desktop cannot disagree about
/// the list while both look right on their own. This file is the part that is
/// genuinely this platform's: where the bytes live, and what is done with them
/// when the app upgrades.
///
/// `UserDefaults` rather than a file, because this is a small preference and not a
/// document. **The address is not a secret**: it is the credential that belongs in
/// the Keychain, and that is `SettingsCredentials`.
final class GatewayStore: ObservableObject {
    /// The whole list, published, so a change redraws the settings page and the
    /// app behind it.
    @Published private(set) var config: Config

    /// Where the list is stored. One value, one key.
    static let storageKey = "clawGatewayConfig"

    /// Where the single gateway this store used to hold was stored.
    ///
    /// Kept, and read once, because an install that predates the list has its
    /// address under this key and losing it would mean asking someone to type it
    /// again. It is not written to any more, and it is deliberately not deleted
    /// after the move: the read is cheap, and a value left behind cannot lose an
    /// address the way a deletion done in the wrong order can.
    static let legacyStorageKey = "clawGatewayURL"

    private let defaults: UserDefaults
    private let key: String
    private let legacyKey: String

    init(
        defaults: UserDefaults = .standard,
        key: String = GatewayStore.storageKey,
        legacyKey: String = GatewayStore.legacyStorageKey
    ) {
        self.defaults = defaults
        self.key = key
        self.legacyKey = legacyKey
        self.config = GatewayStore.load(from: defaults, key: key, legacyKey: legacyKey)
    }

    /// The list, in the order it was added.
    var gateways: [Gateway] { config.gateways }

    /// The gateway the app loads, or nil while this device has not been pointed
    /// at one. Read from the config rather than kept beside it, so the pointer and
    /// the list cannot come apart.
    var activeGateway: Gateway? { ConfigModel.active(config) }

    /// Whether there is nothing to load, which is when the settings surface is not
    /// a sheet over the app but the app itself. The desktop has the same state and
    /// the same answer for it: with no gateway, settings IS the window.
    var needsSetup: Bool { config.gateways.isEmpty }

    /// Whether this device has a gateway to load. Read by the notice board's
    /// failure path, which offers a way in only when there is something to fix.
    var hasGateway: Bool { !config.gateways.isEmpty }

    // MARK: Writing

    /// Stores what someone typed as a new gateway, and answers with the entry or
    /// nil when the address is not one this app can load.
    ///
    /// A refusal stores nothing, so a mistyped correction cannot lose an address
    /// that works. The new gateway is NOT made active: on the desktop, adding a
    /// gateway and connecting to it are two presses, and the second one is
    /// deliberate because it throws away the page you are reading.
    @discardableResult
    func add(label: String, url raw: String) -> Gateway? {
        guard let parsed = Gateway.parse(raw) else { return nil }
        let (next, entry) = ConfigModel.add(config, label: label, url: parsed.url, id: parsed.id)
        write(next)
        return entry
    }

    /// Edits a gateway's label or address. A nil argument leaves that field alone.
    func update(id: String, label: String? = nil, url raw: String? = nil) {
        var parsed: URL?
        if let raw {
            // An unparseable address is refused rather than stored: the alternative
            // is a row the app cannot load, with the old address already gone.
            guard let candidate = Gateway.parse(raw) else { return }
            parsed = candidate.url
        }
        write(ConfigModel.update(config, id: id, label: label, url: parsed))
    }

    /// Removes a gateway, and clears the active pointer if it named that one.
    func remove(id: String) {
        write(ConfigModel.remove(config, id: id))
    }

    /// Points the app at one of the gateways it already has.
    func setActive(id: String) {
        guard config.gateways.contains(where: { $0.id == id }) else { return }
        var next = config
        next.activeGatewayId = id
        write(next)
    }

    /// Stores the one preference this client shares with the desktop.
    func setPromptMetadata(_ enabled: Bool) {
        var next = config
        next.promptMetadata = enabled
        write(next)
    }

    /// Pins a certificate, which nothing calls until the navigation delegate
    /// evaluates trust. Here because the rule is shared, not because it is live.
    func trustCert(host: String, fingerprint: String) {
        write(ConfigModel.trustCert(config, host: host, fingerprint: fingerprint))
    }

    // MARK: Persistence

    private func write(_ next: Config) {
        config = next
        if let data = try? JSONEncoder().encode(next) {
            defaults.set(data, forKey: key)
        }
    }

    /// Reads the stored list, or migrates the single address an older build left.
    ///
    /// A stored value that will not decode is treated as no value at all, and the
    /// legacy key is then read as the fallback. That ordering is the safe one: a
    /// list that failed to decode cannot be recovered from the legacy key, and
    /// trying to merge the two would be inventing topology from two sources
    /// rather than reading one.
    private static func load(from defaults: UserDefaults, key: String, legacyKey: String) -> Config {
        #if DEBUG
        // A screenshot run points the app at a gateway from a launch argument,
        // because a simulator cannot be typed into by a script and the seeded
        // UserDefaults a `simctl` run writes are not the sandbox the app reads.
        // The same reasoning as `-claw-open-settings` and `-claw-seed-notices`,
        // and compiled out of a release build so no launch argument can point a
        // shipped app anywhere. `-claw-gateway-url <url>` is the whole of it.
        if let seeded = screenshotGateway() { return seeded }
        #endif
        if let data = defaults.data(forKey: key), let stored = try? JSONDecoder().decode(Config.self, from: data) {
            return stored
        }
        if let legacy = defaults.string(forKey: legacyKey), let gateway = Gateway.parse(legacy) {
            // The migrated gateway becomes active, because it was the one the app
            // was loading.
            return Config(
                gateways: [gateway],
                activeGatewayId: gateway.id,
                trustedCerts: [:],
                promptMetadata: false,
                autoUpdate: true
            )
        }
        return Config.blank { UUID().uuidString }
    }

    #if DEBUG
    /// The gateway a screenshot run was launched with, or nil. Inert without the
    /// argument, and absent from a release build entirely.
    private static func screenshotGateway() -> Config? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-claw-gateway-url"), index + 1 < arguments.count,
              let gateway = Gateway.parse(arguments[index + 1])
        else { return nil }
        return Config(
            gateways: [gateway],
            activeGatewayId: gateway.id,
            trustedCerts: screenshotTrust(for: gateway),
            promptMetadata: false,
            autoUpdate: true
        )
    }

    /// The certificate a screenshot run was launched with, or nothing.
    ///
    /// A simulator reaches a gateway on the host's loopback, where the gateway's
    /// certificate is self-signed, and the trust flow that accepts one is a TAP on
    /// the phone ("Open Settings" in the connection notice). A script cannot tap, so
    /// without this no local run gets past the certificate notice and the page a
    /// screenshot is meant to show never loads: measured 2026-09-18, where the app
    /// sat on its own "The certificate for this server is invalid" notice in a
    /// simulator, which is the app behaving correctly and the run going nowhere.
    ///
    /// Read from the process ENVIRONMENT rather than a launch argument, for the same
    /// reason the token beside it is: it is credential-shaped, and the argv a process
    /// listing shows is the wrong place for it. Compiled out of a release build
    /// entirely, so no shipped app can be told to trust anything this way.
    ///
    /// Paired with `-claw-gateway-url`: the host it pins is that gateway's, which is
    /// the only host the seeded run will load, so a screenshot run cannot widen the
    /// trust of anything else.
    private static func screenshotTrust(for gateway: Gateway) -> [String: String] {
        guard let host = gateway.url.host,
              let fingerprint = ProcessInfo.processInfo.environment["OPENCLAW_SEED_TRUST"],
              !fingerprint.isEmpty
        else { return [:] }
        return [host: fingerprint]
    }

    /// Store the gateway token a debug run was launched with into the Keychain,
    /// so a simulator can exercise a real authenticated connection.
    ///
    /// A simulator's Keychain is empty, and the settings page stores a token
    /// write-only, so there is otherwise no way to prove the phone authenticates
    /// end to end. This reads the token from the process ENVIRONMENT, not from a
    /// launch argument, so the credential never appears in the argv a process
    /// listing shows; it is stored through the same write-only path the settings
    /// page uses and then dropped, never held and never logged. Compiled out of a
    /// release build entirely, so no shipped app can be seeded this way.
    ///
    /// Paired with `-claw-gateway-url`: the gateway it belongs to is the one the
    /// run was pointed at, which is the active gateway that `screenshotGateway`
    /// returned, so the id they share is read back from the seeded config.
    static func seedDebugTokenFromEnvironment() {
        guard let config = screenshotGateway(), let gatewayId = config.activeGatewayId else { return }
        guard let token = ProcessInfo.processInfo.environment["OPENCLAW_SEED_TOKEN"], !token.isEmpty else { return }
        SettingsCredentials.set(gatewayId, field: "token", value: token)
    }
    #endif
}
