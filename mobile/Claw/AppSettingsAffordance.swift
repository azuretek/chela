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
        /// The handoff's timing, which both clients must hold to the same line.
        /// Read from the spec for the same reason the route is: a number two
        /// clients have to agree on needs one owner. See
        /// `readyTimeoutMs` and `pollMs` in the spec's `handoff` object.
        struct Handoff: Decodable {
            let readyTimeoutMs: Int
            let pollMs: Int
        }

        let global: String
        let configGlobal: String
        let marker: String
        let anchors: [String: String]
        /// The Control UI route the script may hand the reader to when there is no
        /// control to press, read from the same spec as the anchors. Decoded by
        /// NAME rather than mirrored in Swift, because it is a path the Control UI
        /// owns and a second copy could be wrong the day upstream moves a route.
        let routes: [String: String]?
        let handoff: Handoff
        let script: [String]
    }

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(global: "", configGlobal: "", marker: "", anchors: [:], routes: nil,
                         handoff: Spec.Handoff(readyTimeoutMs: 0, pollMs: 0), script: [])
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
            // The same two things the desktop's configStatement() hands over, from
            // the same spec: the anchors, and the Control UI's own route for the
            // destination its settings entry opens.
            "routes": spec.routes ?? [String: String](),
            "tokens": [String: String](),
        ]
    }

    /// The call that takes the reader to the CONTROL UI's own settings.
    ///
    /// The port of `controlUiSettingsSource()` in
    /// `core/app-settings-affordance.js`, and the same split as everything else
    /// here: the script that does the pressing is the shared one (bundled and
    /// installed above), and this is the one line that asks the page to run it.
    /// The function is left on the CONFIG global by the installation, which is
    /// why this looks it up there rather than on the bridge: the bridge may be a
    /// frozen object on another client, and the config global is a plain one.
    static func controlUiSettingsSource() -> String {
        """
        (function () {
          try {
            var config = window.\(spec.configGlobal);
            if (config && typeof config.openControlUiSettings === 'function') return config.openControlUiSettings();
          } catch (e) { return false; }
          return false;
        })()
        """
    }

    /// How long to hold our own surface waiting for the destination, and how
    /// often to ask. The spec's, so the phone and the desktop wait alike.
    static var readyTimeoutMs: Int { spec.handoff.readyTimeoutMs }
    static var pollMs: Int { spec.handoff.pollMs }

    /// The question that tells this client whether the destination has ARRIVED.
    ///
    /// The port of `controlUiSettingsReadySource()` in
    /// `core/app-settings-affordance.js`, built from the same spec fields, so the
    /// claim about the Control UI's DOM has one owner rather than one per client.
    /// Asked repeatedly against the live page, never awaited inside it: the
    /// shipping Control UI has no footer settings control to press, so the ask
    /// falls through to its own settings ROUTE, and a route is a full document
    /// load that destroys any promise waiting on it.
    ///
    /// Both halves are necessary and neither is sufficient. The route is what
    /// makes it the page the reader asked for, and also what makes the answer mean
    /// "arrived" rather than "already there": the settings shell is up on every
    /// `/settings/*` route, including the first-run flow, so a reader who came
    /// from the Control UI's own settings page would satisfy a node-only question
    /// the instant they pressed. The painted node is what makes it rendered rather
    /// than merely committed.
    ///
    /// `nil` when this build's spec carries no surface or route to look for, which
    /// is a broken bundle rather than a state to guess at: the caller skips the
    /// wait and says so, rather than holding the reader against a question it
    /// cannot ask. A shipped build cannot reach this, because
    /// `AppSettingsAffordanceParityTests` asserts the spec carries both.
    static func controlUiSettingsReadySource() -> String? {
        guard let surface = spec.anchors["controlUiSettingsSurface"], !surface.isEmpty,
              let route = spec.routes?["appearance"], !route.isEmpty
        else { return nil }
        return """
        (function () {
          try {
            if (location.pathname !== \(jsonString(route))) return false;
            var node = document.querySelector(\(jsonString(surface)));
            if (!node) return false;
            var box = node.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          } catch (e) { return false; }
        })()
        """
    }

    /// A Swift string as a JavaScript string literal. The values spliced into the
    /// statements above are the Control UI's own selectors and route, so a quote
    /// or a backslash in one is unlikely rather than impossible, and an escaping
    /// mistake would produce a script that throws inside a page we do not own.
    private static func jsonString(_ value: String) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let json = String(data: data, encoding: .utf8)
        else { return "\"\"" }
        return json
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
