import Foundation
import Security

/// The per-gateway credentials this device holds: the gateway token, and the
/// gateway password for a gateway in password mode.
///
/// In the Keychain rather than in the config, and that split is deliberate on
/// both clients. The config is a preference, readable and hand-editable; the
/// moment it carried a token it would stop being something you could open on a
/// screen share. On the desktop the same values live in a separate file
/// encrypted with the OS keychain; here they are Keychain items, which is what
/// the platform provides for exactly this.
///
/// **Write-only from the page's side.** The settings page can set a credential,
/// clear one, and learn whether one exists. It can never read one back: there is
/// no command that returns a value, and `summary` answers only with booleans,
/// which is why a bug in the page cannot become a credential disclosure. The
/// token is read here for one purpose, the URL handoff at connect time.
enum SettingsCredentials {
    /// What the settings page is told about a gateway's stored credentials.
    struct Summary: Equatable {
        var hasToken: Bool
        var hasPassword: Bool
        /// Always empty on this client, and part of the shape because the page
        /// renders the same object on both. Extra request headers are desktop
        /// only: a `WKWebView` can put a header on the top-level load and on
        /// nothing the page then fetches, so a proxy header would work once and
        /// silently fail afterwards. See core/spec/settings.json.
        var headers: [String] = []
    }

    /// Which gateway and which field a Keychain item is for.
    ///
    /// The gateway's id rather than its address, so editing the address keeps the
    /// credential: that is the whole reason a gateway has an id.
    private static func account(_ gatewayId: String, _ field: String) -> String {
        "gateway:\(gatewayId):\(field)"
    }

    private static var service: String {
        Bundle.main.bundleIdentifier ?? "com.azuretek.claw-mobile"
    }

    /// Whether either credential is stored, for the row's own summary line.
    static func summary(_ gatewayId: String) -> Summary {
        Summary(
            hasToken: read(gatewayId, "token") != nil,
            hasPassword: read(gatewayId, "password") != nil
        )
    }

    /// Stores or clears one credential.
    ///
    /// An empty string deletes, which is what the page's Clear button sends. The
    /// answer is whether the store now holds what was asked for, so a Keychain
    /// refusal can be reported rather than looking like a save that worked.
    @discardableResult
    static func set(_ gatewayId: String, field: String, value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            delete(gatewayId, field)
            return read(gatewayId, field) == nil
        }
        guard let data = trimmed.data(using: .utf8) else { return false }
        delete(gatewayId, field)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(gatewayId, field),
            kSecValueData as String: data,
            // The token is handed to the gateway the user configured and to
            // nothing else, and it is read while the app is in use, so it is
            // available whenever the device is unlocked and never synced to
            // another device.
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        if addStatus == errSecSuccess { return true }
        #if DEBUG
        // An unsigned simulator build has no keychain-access-group entitlement,
        // so `SecItemAdd` refuses every write with `errSecMissingEntitlement`
        // (-34018). That is exactly the environment the debug token seed exists
        // for (`GatewayStore.seedDebugTokenFromEnvironment`), so on that one
        // refusal, and only in a debug build, the value is kept in memory for the
        // life of the process instead. A release build compiles this whole branch
        // out and a signed build on a real device never sees the refusal, so
        // shipped behaviour is unchanged: the Keychain stays the only store there.
        return debugFallbackSet(gatewayId, field, trimmed, keychainStatus: addStatus)
        #else
        return false
        #endif
    }

    /// The two credentials, for the connect that needs them. Never sent to a page.
    static func values(_ gatewayId: String) -> (token: String?, password: String?) {
        (read(gatewayId, "token"), read(gatewayId, "password"))
    }

    /// Everything for one gateway, which is what removing a gateway does.
    static func forget(_ gatewayId: String) {
        delete(gatewayId, "token")
        delete(gatewayId, "password")
        #if DEBUG
        DebugCredentialStore.shared.forget(gatewayId)
        #endif
    }

    private static func read(_ gatewayId: String, _ field: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(gatewayId, field),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess,
           let data = result as? Data,
           let value = String(data: data, encoding: .utf8),
           !value.isEmpty {
            return value
        }
        #if DEBUG
        // The read side of the same simulator fallback: a value the debug seed
        // could not write to the Keychain is read back from memory. Only when the
        // Keychain genuinely holds nothing, so a real credential always wins.
        if status == errSecItemNotFound || status == errSecMissingEntitlement {
            return DebugCredentialStore.shared.read(account(gatewayId, field))
        }
        #endif
        return nil
    }

    private static func delete(_ gatewayId: String, _ field: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(gatewayId, field),
        ]
        SecItemDelete(query as CFDictionary)
        #if DEBUG
        DebugCredentialStore.shared.delete(account(gatewayId, field))
        #endif
    }

    #if DEBUG
    /// The debug-only write fallback. Kept out of the release build entirely, and
    /// entered only on `errSecMissingEntitlement`, which is the unsigned-simulator
    /// refusal and nothing else: any other failure is a real one and is reported
    /// as `false` the way it always was.
    private static func debugFallbackSet(
        _ gatewayId: String, _ field: String, _ value: String, keychainStatus: OSStatus
    ) -> Bool {
        guard keychainStatus == errSecMissingEntitlement else { return false }
        DebugCredentialStore.shared.set(account(gatewayId, field), value)
        return true
    }
    #endif
}

#if DEBUG
/// A process-lifetime credential store, for the one case the Keychain cannot
/// serve: an unsigned simulator build, whose `SecItemAdd` is refused for want of
/// a keychain-access-group entitlement. It exists so the debug token seed
/// (`-claw-gateway-url` plus `OPENCLAW_SEED_TOKEN`) can put a real credential
/// where `SettingsCredentials.values` will find it, which is what lets a
/// simulator prove an authenticated connection end to end.
///
/// Compiled out of a release build, so nothing shipped keeps a credential in
/// memory: on a device the Keychain write succeeds and this is never reached.
/// Thread-safe because credentials are read on the connect path and written on
/// launch, which are not the same thread: an `NSLock` guards the one dictionary,
/// which is what `@unchecked Sendable` asserts to the compiler here.
private final class DebugCredentialStore: @unchecked Sendable {
    static let shared = DebugCredentialStore()
    private let lock = NSLock()
    private var values: [String: String] = [:]

    func set(_ account: String, _ value: String) {
        lock.lock(); defer { lock.unlock() }
        values[account] = value
    }

    func read(_ account: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return values[account]
    }

    func delete(_ account: String) {
        lock.lock(); defer { lock.unlock() }
        values[account] = nil
    }

    func forget(_ gatewayId: String) {
        lock.lock(); defer { lock.unlock() }
        values = values.filter { !$0.key.hasPrefix("gateway:\(gatewayId):") }
    }
}
#endif
