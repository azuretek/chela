import Foundation

/// The device-identity persistence bridge, ported from `core/device-identity.js`,
/// plus the two scripts this client installs so the Control UI's device keypair
/// survives a reinstall.
///
/// The gateway recognises an already-paired device by its Ed25519 keypair, not by
/// the operator token: the token is the auth gate, the keypair is the pairing
/// gate (see `deriveDeviceIdFromPublicKey` and `verifyGatewayConnectDeviceProof`
/// in the OpenClaw checkout). The Control UI generates that keypair, derives the
/// device id from the public key, keeps the pair in `localStorage` under one key,
/// and signs the gateway's connect challenge with it. On the desktop that storage
/// persists; here the same page runs in a `WKWebView` whose `localStorage` is
/// wiped on uninstall, so every reinstall re-pairs.
///
/// Two injected scripts bridge that `localStorage` value to the Keychain, which
/// does survive a reinstall. The SEED script runs at document start and restores
/// a persisted identity into `localStorage` before the page boots and reads it,
/// so a reinstalled app presents the same key. The CAPTURE script posts the
/// page's current identity out to `DeviceIdentityBridge`, which stores it. The
/// page stays the one owner of generation: this client never derives or signs
/// anything, it moves one opaque string between the Keychain and the page.
///
/// **The split mirrors `NativeControlAuth` and `PromptMetadata`, deliberately.**
/// The storage key, the seed global and the message name are the shared contract
/// and are proven against `core/fixtures/device-identity.json` by
/// `DeviceIdentityParityTests`, which is what a parity test can do for a value.
/// The two scripts are NOT ported: a mirrored script is a second copy of it,
/// which is the fork the shared file exists to prevent, so they are read from the
/// bundled `device-identity.json` and installed through `WKUserScript`. The seed
/// takes the persisted identity from the seed global rather than spliced into the
/// script text, so the script body has no per-client parts and no credential
/// reaches its bytes; only the assignment above it carries the value.
enum DeviceIdentity {
    // MARK: - The spec

    /// `core/spec/device-identity.json`, in the shape the file already has.
    private struct Spec: Decodable {
        let storageKey: String
        let seedGlobal: String
        let messageName: String
        let pollIntervalMs: Int
        let seed: [String]
        let capture: [String]
    }

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(storageKey: "", seedGlobal: "", messageName: "", pollIntervalMs: 0, seed: [], capture: [])
        guard let url = Bundle.main.url(forResource: "device-identity", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let spec = try? JSONDecoder().decode(Spec.self, from: data),
              !spec.storageKey.isEmpty,
              !spec.seedGlobal.isEmpty,
              !spec.messageName.isEmpty,
              !spec.seed.isEmpty,
              !spec.capture.isEmpty
        else {
            // A build that did not bundle the spec cannot bridge the identity. It
            // installs nothing rather than something invented, and
            // `DeviceIdentityParityTests` turns that into a failing build rather
            // than a quiet absence in the field, where it would silently re-pair.
            return empty
        }
        return spec
    }

    /// The message-handler name the capture script posts to, which the web view
    /// registers. Read from the spec so a rename there cannot leave the two
    /// disagreeing.
    static var messageName: String { spec.messageName }

    // MARK: - The install statements

    /// The seed statement: the persisted identity assigned to the seed global,
    /// then the seed script that restores it into `localStorage`.
    ///
    /// Installed at document start, before the page's own script reads the
    /// storage key. The identity is included only when it is a non-empty string;
    /// with none to restore the assignment is `null` and the seed script does
    /// nothing, which is the first-ever launch where the page mints its own.
    ///
    /// Built with the same `null`-for-absent rule as the JS, and the assignment is
    /// a JSON string literal so an identity containing quotes or backslashes
    /// survives being spliced into the page. The parity test drives this with the
    /// fixture's inputs and compares the exact bytes.
    static func seedInstallation(identity: String?) -> String {
        let value: String = {
            guard let identity, !identity.isEmpty else { return "null" }
            // Encode the identity as a JSON string so quotes and backslashes in
            // the opaque value cannot break out of the assignment. `JSONEncoder`
            // on a lone String produces exactly that literal.
            guard let data = try? JSONEncoder().encode(identity),
                  let text = String(data: data, encoding: .utf8)
            else { return "null" }
            return text
        }()
        let assignment = "window.\(spec.seedGlobal) = \(value);"
        return "\(assignment)\n\(spec.seed.joined(separator: "\n"))"
    }

    /// The capture script, exactly as `core/spec/device-identity.json` holds it.
    /// The desktop needs no capture (Chromium persists the page's storage); this
    /// client installs these same bytes through a `WKUserScript`.
    static var captureScript: String { spec.capture.joined(separator: "\n") }
}
