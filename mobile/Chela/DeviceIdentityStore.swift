import Foundation
import Security

/// Where this device's Control UI keypair is kept so it outlives the web view.
///
/// The gateway recognises an already-paired device by its Ed25519 keypair, not
/// by the operator token: the token is the auth gate, the keypair is the pairing
/// gate. The Control UI generates that keypair, derives the device id from the
/// public key, and keeps the pair in the page's `localStorage`. On the desktop
/// that storage is Chromium origin storage and persists across launches, so the
/// desktop pairs once. Here the same page runs in a `WKWebView` whose
/// `localStorage` is wiped when the app is uninstalled, so without this every
/// reinstall mints a new keypair, a new device id, and a fresh pairing request.
///
/// The Keychain, not the web view's storage and not the config, and that choice
/// matches `SettingsCredentials`: a Keychain item survives an app uninstall on a
/// real device, which is exactly the reinstall case the dev build hits over and
/// over. The value stored is the opaque identity JSON the page owns; this store
/// keeps the string verbatim and never parses the keypair, so a change to the
/// page's identity shape needs no change here. The device keypair is a
/// credential, so it is stored this-device-only and never synced.
///
/// **Write-through, not a second owner.** The page still generates and owns the
/// identity. This store is written from `DeviceIdentityBridge` when the page
/// reports its current identity, and read by `DeviceIdentity.seedInstallation`
/// to restore it into `localStorage` before the page boots. Neither derives nor
/// signs anything: it moves one string between the Keychain and the page.
enum DeviceIdentityStore {
    /// The Keychain account this identity is stored under. One per app install
    /// identity, not per gateway: the page keys its keypair by origin inside its
    /// own storage, and a device presents the same public key to every gateway it
    /// pairs with, so the native persistence layer holds the one value the page
    /// keeps under its single storage key. Named for that key so the mapping is
    /// legible in a Keychain dump.
    private static let account = "device-identity:openclaw-device-identity-v1"

    private static var service: String {
        Bundle.main.bundleIdentifier ?? "com.azuretek.claw-mobile"
    }

    /// The persisted identity JSON, or nil when none has been captured yet (the
    /// first-ever launch, where the page mints its own and the bridge captures it).
    static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
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

    /// Store the identity the page reported, replacing any earlier one.
    ///
    /// The answer is whether the store now holds what was asked for, so a Keychain
    /// refusal can be told apart from a save that worked. An empty string is
    /// ignored rather than stored: the page never reports an empty identity, and
    /// clearing the persisted keypair is not something a capture should ever do.
    @discardableResult
    static func write(_ identity: String) -> Bool {
        let trimmed = identity.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return false }
        // Idempotent on the value: re-storing the same identity the page already
        // reported is a no-op, so the bridge can write on every report without
        // Keychain churn. Only a genuine change rewrites the item.
        if read() == trimmed { return true }
        delete()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            // The keypair is a credential and is read only while the app is in
            // use, so it is available whenever the device is unlocked and never
            // synced to another device, matching how the token is stored.
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    private static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
