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
        // Painted with the PAGE's own resolved background rather than the system's,
        // and that is what the two shades at the top of the screen were.
        //
        // This page draws its card on a wash: `.scrim` is `--scrim`, which ui.css
        // resolves to `--bg` at 70%, so whatever sits behind the page shows
        // through it. The web view is not opaque and it was painted with
        // `.systemBackground`, which follows the DEVICE's appearance rather than
        // the Control UI's palette, so on a page whose palette is not the system's
        // default the strip above the card composited to a second colour and met
        // the card's own opaque surface at an edge. Reported 2026-09-17: "the top
        // of the screen looks a little strange, should it be dark with different
        // shades like that?"
        //
        // So the host paints what the page will show through, from the same map it
        // hands the page. Not by tinting the card into the strip: that hides the
        // fault in one appearance by making the card wrong in the other, which is
        // exactly how the earlier black-bar version of this fault was written.
        //
        // A page with no resolved palette keeps the system colour, which is what
        // the first frame of a page that has not loaded yet is painted on.
        let pageBackground = PaletteColour.uiColor(from: tokens["--bg"]) ?? .systemBackground
        webView.isOpaque = false
        webView.backgroundColor = pageBackground
        webView.scrollView.backgroundColor = pageBackground
        // The page's appearance comes from the PALETTE rather than from this
        // client's own setting: see `ThemeTokens.pageTrait`. The setting still
        // paints the native chrome around the page.
        webView.overrideUserInterfaceStyle = ThemeTokens.pageTrait(tokens: tokens, own: appearance.userInterfaceStyle)
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
            // The palette carries the appearance it belongs to, so a map that
            // arrives after the view was built moves the trait too: a mode is not
            // something the page can pick up on its own.
            webView.overrideUserInterfaceStyle = ThemeTokens.pageTrait(tokens: tokens, own: appearance.userInterfaceStyle)
        }
        if context.coordinator.appliedAppearance != appearance {
            context.coordinator.appliedAppearance = appearance
            webView.overrideUserInterfaceStyle = ThemeTokens.pageTrait(tokens: tokens, own: appearance.userInterfaceStyle)
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
