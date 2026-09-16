import SwiftUI
import WebKit

/// The shared settings page, in a web view.
///
/// The page is `core/ui/settings.html`: the desktop's own settings page, bundled
/// into this app rather than reimplemented, so the two clients cannot drift into
/// two surfaces. What makes it the phone's settings page is `SettingsHost`, which
/// answers the same command names the desktop's preload answers, and
/// `core/spec/settings.json`, which is what tells the page which tabs and settings
/// this client has.
///
/// Deliberately not a native screen per tab. Both clients are web views, so a
/// native SwiftUI version of each tab would be a second implementation of every
/// one of them: two things to keep in step, with the same design tokens, the same
/// notices and the same gateway rules already shared precisely to avoid that.
struct SettingsSurface: UIViewRepresentable {
    let host: SettingsHost

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let scripts = WKUserContentController()
        scripts.add(host, name: SettingsHost.messageName)
        // At document START, because the page's own script is the last element in
        // its body and throws if the host is not there yet. See the bootstrap's own
        // comment.
        scripts.addUserScript(WKUserScript(
            source: host.bootstrapScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController = scripts

        let webView = WKWebView(frame: .zero, configuration: configuration)
        // Painted with the system background rather than left transparent: the
        // page's first frame would otherwise show whatever is behind the sheet.
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        // The page scrolls its own card, and it is a settings form rather than
        // reading matter, so the rubber-band overscroll would only ever reveal
        // background.
        webView.scrollView.bounces = false

        host.webView = webView
        guard let page = SettingsSpec.page, let directory = SettingsSpec.directory else {
            // A missing page is a packaging fault, and it is worth saying so on
            // screen rather than showing an empty sheet: the failure it would
            // otherwise look like is "the settings page is blank", which sends
            // someone looking at the wrong thing entirely.
            webView.loadHTMLString(Self.missingPageHTML, baseURL: nil)
            return webView
        }
        webView.loadFileURL(page, allowingReadAccessTo: directory)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // Nothing to push: the page re-reads its own state when the host raises an
        // event, and every command answers with the state it produced.
    }

    /// Shown when the page is not in the bundle, which is a build fault rather
    /// than something a user can fix.
    private static let missingPageHTML = """
    <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font: -apple-system-body; padding: 24px; background: Canvas; color: CanvasText;">
    <h1>Settings are missing from this build</h1>
    <p>The settings page is shipped inside the app, and this copy does not contain it.
    That is a build fault, not something you can fix here.</p>
    </body></html>
    """
}

/// The way into the settings surface.
///
/// A native control, and it is here because there has to be one: the desktop
/// reaches Settings from a tray icon and a menu bar, and a phone has neither, so
/// without this the page would exist and be unreachable. It is an overlay *over*
/// the Control UI rather than chrome beside it, so the page keeps every pixel of
/// the safe area it lays itself out in.
///
/// It draws no iconography of its own beyond a system symbol, and it is not a
/// second consumer of the design tokens: the settings page it opens is where the
/// shared styling is.
struct SettingsButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "slider.horizontal.3")
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 44, height: 44)
                .background(.ultraThinMaterial, in: Circle())
                .overlay(Circle().stroke(.quaternary, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .padding(.trailing, 8)
        .padding(.top, 4)
        .accessibilityLabel("Settings")
        .accessibilityHint("Gateway, behaviour and certificate settings")
    }
}
