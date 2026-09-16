import Combine
import Foundation

/// The gateway this client loads, as configured on this device.
///
/// The client is the only place the address exists. Nothing in the repository
/// names one and nothing in the build carries one, which is why this store has
/// no default to fall back on: an unconfigured install has no gateway rather
/// than somebody else's, and the app asks for one instead of loading a guess.
///
/// Persistence is `UserDefaults`, which is what a single preference of this size
/// needs, and is where the value lives until Phase 6's list and picker arrive.
/// The address is not a secret, it is a preference: the credential that belongs
/// in the Keychain is the token, which is a later phase. This store is the only
/// reader and writer of the key, so moving to a stored list is a change here and
/// nowhere else.
final class GatewayStore: ObservableObject {
    /// The configured gateway, or nil while this device has not been set up.
    @Published private(set) var gateway: Gateway?

    /// Whether the setup surface is still needed.
    var needsSetup: Bool { gateway == nil }

    /// The key the address is stored under. One value, one key.
    static let storageKey = "clawGatewayURL"

    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults = .standard, key: String = GatewayStore.storageKey) {
        self.defaults = defaults
        self.key = key
        self.gateway = Gateway.parse(defaults.string(forKey: key) ?? "")
    }

    /// Stores what someone typed, and answers whether it was usable.
    ///
    /// A refusal leaves whatever was already stored alone, so a mistyped
    /// correction cannot lose an address that works.
    @discardableResult
    func save(_ raw: String) -> Bool {
        guard let parsed = Gateway.parse(raw) else { return false }
        defaults.set(parsed.url.absoluteString, forKey: key)
        gateway = parsed
        return true
    }

    /// Forgets the address, so the setup surface comes back.
    func clear() {
        defaults.removeObject(forKey: key)
        gateway = nil
    }
}
