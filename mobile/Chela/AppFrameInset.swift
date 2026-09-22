import Foundation

/// The app frame inset, read from core/spec/app-frame-inset.json, plus the
/// installation this client puts in the page at document start.
///
/// ONE script, TWO clients. The script is not ported: it is read from the spec the
/// app bundles, exactly as AppSettingsAffordance and PromptMetadata read theirs, so
/// the bytes the desktop installs into the gateway page and the bytes this client
/// installs through a WKUserScript are one copy rather than two dialects. The rule
/// the page receives is built by that script from the spec's own fields, so neither
/// client holds a copy of the rule either.
///
/// ## What this is for
///
/// This client covers the whole screen, deliberately: the Control UI's navigation
/// drawer is a 100dvh surface and has to reach the top, which is why the web view is
/// not inset into the safe area (see ContentView). The page insets its own CONTENT
/// through the standalone body padding WebView.safeAreaScript applies, but a
/// position: fixed overlay is not bounded by its ancestor's padding: it anchors to
/// the display edges and takes its height from window.innerHeight, so the Control
/// UI's Ask Open Claw surface is drawn across the status bar and the home indicator,
/// which are the parts of the screen this app's own chrome owns.
///
/// So the two halves are: the app already owns those bands geometrically, and the
/// page is told where they are. The published value is the safe area, which is
/// exactly the region this client's chrome leaves for the page.
///
/// Read the spec's why for the marker that gates the rule, the 100vh stragglers and
/// the removal trigger.
///
/// The spec is read at runtime rather than mirrored as Swift constants, for the same
/// reason the other scripts are: a script cannot be mirrored without a second copy
/// existing, and a second copy is the fork the shared file exists to prevent.
enum AppFrameInset {
    private struct Spec: Decodable {
        let global: String
        let configGlobal: String
        let initialGlobal: String
        let marker: String
        /// The published property names, by edge. Decoded by NAME rather than
        /// restated in Swift, because both clients and the script have to agree on
        /// them and only the spec can own that agreement.
        let properties: [String: String]
        /// The page's viewport-anchored overlays the clamp names.
        let clampSelectors: [String]
        /// The page's own viewport-height containers the frame's height bounds.
        let boundSelectors: [String]
        /// The edges those in-flow containers are bounded by, by name: the frame
        /// takes them off the side a container starts from, never off the far edge.
        let boundCapEdges: [String]
        let script: [String]
    }

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(global: "", configGlobal: "", initialGlobal: "", marker: "",
                         properties: [:], clampSelectors: [], boundSelectors: [],
                         boundCapEdges: [], script: [])
        guard let url = Bundle.main.url(forResource: "app-frame-inset", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let spec = try? JSONDecoder().decode(Spec.self, from: data),
              !spec.global.isEmpty,
              !spec.properties.isEmpty,
              !spec.script.isEmpty
        else {
            // A build that did not bundle the spec installs nothing rather than
            // something invented, and AppFrameInsetTests turns that into a failing
            // build rather than a quiet absence in the field.
            return empty
        }
        return spec
    }

    /// The writable global the page's setter is installed on.
    static var global: String { spec.global }

    /// The page's viewport-anchored overlays the clamp names, read by the tests
    /// rather than by this client: the rule is the script's to build.
    static var clampSelectors: [String] { spec.clampSelectors }

    /// The page's own viewport-height containers, which the frame's height bounds.
    /// Read by the tests rather than by this client: the rule is the script's to
    /// build, and these are the boxes the cap alone can hold.
    static var boundSelectors: [String] { spec.boundSelectors }

    /// The edges those in-flow containers are bounded by, by name: the frame takes
    /// them off the side a container starts from, never off the far edge.
    static var boundCapEdges: [String] { spec.boundCapEdges }

    /// The published property names, by edge.
    static var properties: [String: String] { spec.properties }

    /// The keys this reader decodes, for BundledSpecTests to check against the spec
    /// on disk in both directions: a key the decoder does not name is dropped in
    /// silence, and a client that quietly knows less is the failure that test exists
    /// to catch.
    static let decodedKeys: Set<String> = [
        "global", "configGlobal", "initialGlobal", "marker", "properties", "clampSelectors",
        "boundSelectors", "boundCapEdges", "script",
    ]

    /// Nothing is deliberately left on the floor. Said out loud because the test
    /// requires the reader to declare that rather than let it be assumed.
    static let ignoredKeys: Set<String> = []

    /// The spec's own fields, as the statement that hands them to the script.
    ///
    /// Encoded from the spec rather than restated, so the selectors, the property
    /// names and the marker have exactly one owner. The desktop builds this same
    /// object from the same file, in core/app-frame-inset.js.
    static var configStatement: String {
        let config: [String: Any] = [
            "marker": spec.marker,
            "properties": spec.properties,
            "selectors": spec.clampSelectors,
            "boundSelectors": spec.boundSelectors,
            "boundCapEdges": spec.boundCapEdges,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: config, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8)
        else {
            return "window.\(spec.configGlobal) = {};"
        }
        return "window.\(spec.configGlobal) = \(json);"
    }

    /// One inset, as the JSON an edge map is published from. Zero is written as
    /// zero rather than omitted, because a client that takes no band on an edge has
    /// to say so: an absent property would leave the page's own value in place.
    private static func insetJSON(top: Double, bottom: Double) -> String {
        let values: [String: Double] = [
            "top": max(0, top.rounded()),
            "right": 0,
            "bottom": max(0, bottom.rounded()),
            "left": 0,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8)
        else {
            return "{}"
        }
        return json
    }

    /// What this client installs into the page at document start: the spec's own
    /// fields, this client's numbers, then the shared script, in that order, because
    /// the script reads both globals as it runs.
    ///
    /// At document START and not at the end, for the reason the other userscripts
    /// are: the panel's geometry is computed as the page renders, so a rule added
    /// after the first paint is a visible jump from full bleed to bounded.
    static func installation(top: Double, bottom: Double) -> String {
        guard !spec.script.isEmpty else { return "" }
        let inset = "window.\(spec.initialGlobal) = \(insetJSON(top: top, bottom: bottom));"
        return [configStatement, inset, spec.script.joined(separator: "\n")].joined(separator: "\n")
    }

    /// The statement that moves the published frame while the page is open.
    ///
    /// This client's frame is the safe area, so the install above carries the
    /// ordinary case and a rotation is the only thing that moves it. The setter is
    /// exposed here so that push is one call rather than a new mechanism.
    static func setStatement(top: Double, bottom: Double) -> String {
        """
        (function () {
          try {
            var frame = window.\(spec.global);
            if (!frame || typeof frame.set !== 'function') return null;
            return frame.set(\(insetJSON(top: top, bottom: bottom)));
          } catch (e) { return null; }
        })()
        """
    }
}

