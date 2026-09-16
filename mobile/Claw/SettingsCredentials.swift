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
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { return false }
        return true
    }

    /// The two credentials, for the connect that needs them. Never sent to a page.
    static func values(_ gatewayId: String) -> (token: String?, password: String?) {
        (read(gatewayId, "token"), read(gatewayId, "password"))
    }

    /// Everything for one gateway, which is what removing a gateway does.
    static func forget(_ gatewayId: String) {
        delete(gatewayId, "token")
        delete(gatewayId, "password")
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
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8),
              !value.isEmpty
        else { return nil }
        return value
    }

    private static func delete(_ gatewayId: String, _ field: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(gatewayId, field),
        ]
        SecItemDelete(query as CFDictionary)
    }
}
