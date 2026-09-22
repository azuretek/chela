import Foundation
import UIKit

/// The native token handoff, ported from `core/native-control-auth.js`, plus the
/// one assignment this client installs so the Control UI authenticates as the
/// operator who entered the token rather than as nobody.
///
/// The Control UI reads `window.__OPENCLAW_NATIVE_CONTROL_AUTH__` during boot,
/// before it opens its gateway socket, and deletes it (see
/// resolveApplicationStartupSettings in the OpenClaw checkout at
/// ui/src/app/startup-settings.ts). So this client sets that global at document
/// START, before the page's own script runs, which is the same timing the
/// client-context hook uses (`PromptMetadata`) and for the same reason: installed
/// at document end it would race a socket the page had already opened, and the
/// credential would never reach the connection.
///
/// The token is put on this global and NOT on the navigation URL. The Control UI
/// reads either, but the global keeps a real credential out of the address
/// entirely and carries a client identity beside it, so the gateway's own logs
/// can tell this app from Safari on the same phone. Neither path weakens the
/// gateway's auth: the token is still checked, and the client id grants no
/// admission of its own.
///
/// The wire contract, the global name and the object's shape, is shared:
/// `core/spec/native-control-auth.json` owns it, and `NativeControlAuthParityTests`
/// proves this port reproduces `core/fixtures/native-control-auth.json`, the same
/// pairs `core/test/native-control-auth.test.js` asserts on the JS side. What
/// stays here is the per-client half: the id, the platform and the device family,
/// which name THIS client, and the Keychain read that supplies the token, which
/// is iOS's own and never leaves Swift.
enum NativeControlAuth {
    // MARK: - The spec

    /// `core/spec/native-control-auth.json`, in the shape the file already has.
    private struct Spec: Decodable {
        let global: String
        let mode: String
        let scopes: [String]
    }

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(global: "", mode: "", scopes: [])
        guard let url = Bundle.main.url(forResource: "native-control-auth", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let spec = try? JSONDecoder().decode(Spec.self, from: data),
              !spec.global.isEmpty,
              !spec.mode.isEmpty,
              !spec.scopes.isEmpty
        else {
            // A build that did not bundle the spec cannot hand the token over.
            // It installs an empty object rather than something invented, and
            // `NativeControlAuthParityTests` is what turns that into a failing
            // build rather than a quiet absence in the field.
            return empty
        }
        return spec
    }

    /// The global the Control UI reads at boot. Read here so the message handler
    /// and the tests name one owner rather than a literal each.
    static var global: String { spec.global }

    /// The coarse client mode native UI clients connect with.
    static var mode: String { spec.mode }

    /// The operator scopes this connection requests, mirroring the Control UI's own.
    static var scopes: [String] { spec.scopes }

    // MARK: - This client's descriptor

    /// The canonical native client id for the phone, from the gateway client
    /// registry (openclaw-ios). Per-client, which is why it is here and not in
    /// the shared spec: a later Android client sends its own id, openclaw-android.
    static let clientId = "openclaw-ios"

    /// The runtime platform string this client reports. iOS, lowercased to match
    /// the platform strings the gateway groups clients by.
    static let platform = "ios"

    /// The device family hint, iPad on an iPad and iPhone otherwise.
    ///
    /// Mirrors the browser's own `browserDeviceFamily` split in the Control UI:
    /// an iPad reports the same idiom whether or not it is in desktop mode, and
    /// that is the one this client hands over so a paired device reads the same
    /// on both.
    ///
    /// Takes the idiom rather than reading `UIDevice.current` itself, because that
    /// property is main-actor isolated and this is called from the install path,
    /// so the reader (`WebView`, which is on the main actor) passes it in. The
    /// default is `.phone`, the value this iPhone-only build always resolves to,
    /// so a caller with no idiom to hand still gets the honest answer for this app.
    static func deviceFamily(idiom: UIUserInterfaceIdiom = .phone) -> String {
        idiom == .pad ? "iPad" : "iPhone"
    }

    /// The device family for the device this build is running on, read on the main
    /// actor. The one entry point that touches `UIDevice.current`, kept separate
    /// so `object` and `installation` stay callable off the main actor for the
    /// parity tests, which pass the facts in explicitly.
    @MainActor
    static func currentDeviceFamily() -> String {
        deviceFamily(idiom: UIDevice.current.userInterfaceIdiom)
    }

    // MARK: - The handoff object

    /// The native handoff object, from the token and this client's descriptor.
    ///
    /// The token is included only when it is a non-empty string: an absent or
    /// empty token hands no credential over, and an object with an empty `token`
    /// would tell the page to retire shared-owner auth rather than to stay as it
    /// was. The descriptor is included only when its per-client facts are all
    /// present, which they always are here, so the guard exists to keep the port
    /// identical to the shared rule rather than because this client can fail it.
    ///
    /// An ordered dictionary is not what `JSONSerialization` gives, so the JSON is
    /// built with `.sortedKeys` and the fixture's expected output is sorted to
    /// match; the object's MEANING does not depend on key order, and the parity
    /// test compares the decoded objects, not the bytes, for exactly that reason.
    static func object(
        token: String?,
        clientId: String? = NativeControlAuth.clientId,
        platform: String? = NativeControlAuth.platform,
        deviceFamily: String? = NativeControlAuth.deviceFamily()
    ) -> [String: Any] {
        // `deviceFamily()` with no argument is the constant `.phone` case, which
        // is not main-actor isolated, so this default is safe off the main actor;
        // `WebView` hands in the live idiom through `currentDeviceFamily()`.
        var auth: [String: Any] = [:]
        if let token, !token.isEmpty {
            auth["token"] = token
        }
        if let clientId, let platform, let deviceFamily,
           !clientId.isEmpty, !platform.isEmpty, !deviceFamily.isEmpty {
            auth["client"] = [
                "id": clientId,
                "mode": spec.mode,
                "platform": platform,
                "deviceFamily": deviceFamily,
                "scopes": spec.scopes,
            ]
        }
        return auth
    }

    // MARK: - The install statement

    /// The one assignment that sets the global, installed at document start.
    ///
    /// A single assignment rather than a script with logic in it, because the
    /// whole of the mechanism is "the page reads this global at boot". Built with
    /// `.sortedKeys` so a build produces a stable string; the page does not care
    /// about order, and the parity test decodes rather than compares bytes.
    static func installation(
        token: String?,
        clientId: String? = NativeControlAuth.clientId,
        platform: String? = NativeControlAuth.platform,
        deviceFamily: String? = NativeControlAuth.deviceFamily()
    ) -> String {
        let auth = object(token: token, clientId: clientId, platform: platform, deviceFamily: deviceFamily)
        let json: String = {
            guard let data = try? JSONSerialization.data(withJSONObject: auth, options: [.sortedKeys]),
                  let text = String(data: data, encoding: .utf8)
            else { return "{}" }
            return text
        }()
        return "window.\(spec.global) = \(json);"
    }
}
