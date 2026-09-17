import SwiftUI
import WebKit

/// The shared About page, in a web view.
///
/// The page is `core/ui/about.html`, the desktop's own About page, bundled into
/// this app rather than reimplemented, so the two clients cannot drift into two
/// surfaces. What makes it the phone's About page is `AboutHost`, which answers
/// the same `window.clawDesktop` calls the desktop's preload answers. About was
/// reachable only from a native menu bar before, which this client has none of,
/// so it is opened from Settings through the shared `openAbout` command, and this
/// view is what draws it once it is.
///
/// The same shape as `SettingsSurface`, deliberately: both are shared web pages
/// this client hosts, and the one difference is which host object each installs.
struct AboutSurface: UIViewRepresentable {
    let host: AboutHost

    /// Which appearance the app is in, so the page's own palette resolves the same
    /// way the rest of the app does. `system` leaves the trait collection to the
    /// device, so a live change still reaches the page.
    let appearance: AppearanceMode

    /// The Control UI's live design tokens, read from the gateway page when this
    /// surface is presented. The same map the settings surface gets, applied the
    /// same way: about.html and settings.html draw from one stylesheet, so a token
    /// layer that reached only one of them would make the two disagree.
    let tokens: [String: String]

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let scripts = WKUserContentController()
        scripts.add(host, name: AboutHost.messageName)
        // At document START, because the page's own script is the last element in
        // its body and throws if the host is not there yet.
        scripts.addUserScript(WKUserScript(
            source: host.bootstrapScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        // The interface's own palette and type, before the page paints. See
        // `ThemeTokens`.
        scripts.addUserScript(WKUserScript(
            source: ThemeTokens.applyScript(tokens),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        context.coordinator.appliedTokens = tokens
        context.coordinator.appliedAppearance = appearance
        configuration.userContentController = scripts

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.overrideUserInterfaceStyle = appearance.userInterfaceStyle
        // The page paints its own strips, the same reasoning as the settings
        // surface: with the automatic inset off it fills its frame and insets its
        // own content through `env(safe-area-inset-*)`, which ui.css does.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false

        host.webView = webView
        guard let page = AboutSurface.page, let directory = AboutSurface.directory else {
            webView.loadHTMLString(Self.missingPageHTML, baseURL: nil)
            return webView
        }
        webView.loadFileURL(page, allowingReadAccessTo: directory)
        return webView
    }

    /// What this surface has already pushed into the page, for the same reason
    /// `SettingsSurface.Coordinator` holds it: `updateUIView` runs on every layout
    /// pass, and a layer re-applied per pass is a layer the page cannot settle on.
    final class Coordinator {
        var appliedTokens: [String: String] = [:]
        var appliedAppearance: AppearanceMode?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.appliedTokens != tokens {
            context.coordinator.appliedTokens = tokens
            webView.evaluateJavaScript(ThemeTokens.applyScript(tokens))
        }
        if context.coordinator.appliedAppearance != appearance {
            context.coordinator.appliedAppearance = appearance
            webView.overrideUserInterfaceStyle = appearance.userInterfaceStyle
        }
    }

    /// The About page as it ships, and the directory it may read from. The page's
    /// own relative links (`ui.css`, `about.js`, `assets/claw.svg`) resolve
    /// against this directory, exactly as they do in `core/ui`, which is what
    /// `allowingReadAccessTo` is for.
    static var page: URL? { Bundle.main.url(forResource: "about", withExtension: "html") }
    static var directory: URL? { page?.deletingLastPathComponent() }

    /// Shown when the page is not in the bundle, which is a build fault rather than
    /// something a user can fix.
    private static let missingPageHTML = """
    <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font: -apple-system-body; padding: 24px; background: Canvas; color: CanvasText;">
    <h1>About is missing from this build</h1>
    <p>The About page is shipped inside the app, and this copy does not contain it.
    That is a build fault, not something you can fix here.</p>
    </body></html>
    """
}
