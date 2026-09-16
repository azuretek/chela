import Foundation

/// The "App settings" affordance, read from `core/spec/app-settings-affordance.json`,
/// plus the shim this client installs so the injected script can reach the app's
/// own settings sheet.
///
/// ONE script, TWO clients. The script itself is not ported: it is read from the
/// spec the app bundles, exactly as `PromptMetadata` reads its hook, so the bytes
/// the desktop installs into the gateway page and the bytes this client installs
/// through a `WKUserScript` are one copy rather than two dialects. What differs is
/// only the host bridge the script calls, `window.__clawAppSettings.open`, and it
/// differs only in HOW open() reaches a window: an IPC on the desktop, a
/// `WKScriptMessageHandler` here.
///
/// The affordance never reimplements settings. It finds the Control UI's sidebar
/// footer, adds a control, and on a click calls the bridge; the surface it opens
/// is the same `core/ui/settings.html` this client already loads in a sheet. See
/// `AppSettingsBridge` for the handler, and `WebView` for where both are installed.
///
/// The spec is read at runtime rather than mirrored as Swift constants, for the
/// same reason `PromptMetadata`'s is: a script cannot be mirrored without a second
/// copy existing, and a second copy is the fork the shared file exists to prevent.
enum AppSettingsAffordance {
    private struct Spec: Decodable {
        let global: String
        let configGlobal: String
        let marker: String
        let anchors: [String: String]
        let script: [String]
    }

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(global: "", configGlobal: "", marker: "", anchors: [:], script: [])
        guard let url = Bundle.main.url(forResource: "app-settings-affordance", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let spec = try? JSONDecoder().decode(Spec.self, from: data),
              !spec.global.isEmpty,
              !spec.script.isEmpty
        else {
            // A build that did not bundle the spec cannot inject the affordance.
            // It installs nothing rather than something invented, and
            // `AppSettingsAffordanceParityTests` is what turns that into a failing
            // build rather than a quiet absence in the field.
            return empty
        }
        return spec
    }

    /// The global the client installs its host bridge on. Read by the script,
    /// never written by it.
    static var global: String { spec.global }

    /// The plain, writable global the config (label, tooltip, tokens, anchors)
    /// is set on. Separate from the bridge global so the script never assigns to
    /// a frozen object.
    static var configGlobal: String { spec.configGlobal }

    /// The attribute the injected control carries, so a re-render cannot stack two.
    static var marker: String { spec.marker }

    /// The injected script, exactly as the spec holds it. The desktop installs
    /// these same bytes over `executeJavaScript`; this client installs them
    /// through a `WKUserScript`.
    static var script: String { spec.script.joined(separator: "\n") }

    /// The label and tooltip the control reads, plus the resolved tokens it
    /// styles itself with. The tokens are left empty here: the script falls back
    /// to the page's own `currentColor` and neutral values, so the control reads
    /// as part of the footer without this client having to resolve the Control
    /// UI's palette, which is the page's to own.
    private static var config: [String: Any] {
        [
            "label": "App settings",
            "tooltip": "\(Naming.product) settings",
            "anchors": spec.anchors,
            "tokens": [String: String](),
        ]
    }

    /// The bridge shim, then the configuration, then the shared script.
    ///
    /// The bridge is installed on its own global; the config on a separate plain
    /// global; the script reads both. Posting through
    /// `window.webkit.messageHandlers` is the one route a page has back into this
    /// app, the same channel the theme relay and the settings host use; `open`
    /// takes no argument, so there is nothing to carry but the ask.
    ///
    /// Unlike the desktop's contextBridge object, this bridge global is a plain
    /// object the shim assigns, so the two globals could in principle be one here;
    /// they are kept separate so the phone and the desktop install the SAME shared
    /// script, which reads a frozen bridge on the desktop and must never write it.
    static func installation() -> String {
        let configJSON: String = {
            guard let data = try? JSONSerialization.data(withJSONObject: config, options: [.sortedKeys]),
                  let json = String(data: data, encoding: .utf8)
            else { return "{}" }
            return json
        }()
        let bridge = """
        window.\(spec.global) = {
          open: function () {
            try { window.webkit.messageHandlers.\(AppSettingsBridge.messageName).postMessage({}); } catch (e) {}
          }
        };
        """
        return """
        \(bridge)
        window.\(spec.configGlobal) = \(configJSON);
        \(script)
        """
    }
}
