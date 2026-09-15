import SwiftUI
import WebKit

/// The Control UI, hosted in a `WKWebView`.
///
/// Deliberately thin: this phase loads a URL and nothing else. The things that
/// belong here are the ones that need a navigation delegate (Phase 4's
/// certificate pinning) and a loading or failure surface (Phase 5), which is why
/// the delegate is absent rather than stubbed out: a delegate that does nothing
/// is a surface someone will later read as the place pinning happens.
struct WebView: UIViewRepresentable {
    let url: URL

    /// Remembers what has been asked for, so a SwiftUI update cannot reload the
    /// page under the user. `updateUIView` runs on every layout pass, and the
    /// web view's own `url` is not a usable guard for that: it stays nil until
    /// the navigation commits, so the pass that follows `load` would load it a
    /// second time.
    final class Coordinator {
        var requested: URL?
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The Control UI plays audio and video in the page. Without this, iOS
        // hands playback to the system player, full screen and outside the page
        // it belongs to.
        configuration.allowsInlineMediaPlayback = true
        // WebKit's default user agent stops at `Mobile/15E148`, which says
        // nothing about which client asked for the page. Naming ourselves is
        // what lets a gateway's own logs tell this app from Safari on the same
        // phone, and the Control UI only ever reads the user agent to detect a
        // legacy browser, so replacing the token is safe as well as useful.
        configuration.applicationNameForUserAgent = "ClawMobile/\(Self.version)"

        let webView = WKWebView(frame: .zero, configuration: configuration)
        // Not opaque, and painted with the system background rather than left
        // transparent: a transparent web view shows the window behind it for the
        // frame before the page paints, which reads as a flash of the wrong
        // colour in whichever appearance the user is not in.
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground

        // `allowsBackForwardNavigationGestures` is deliberately not set. The
        // Control UI is a single-page app, so there is no history worth
        // swiping through, and a swipe that moved the whole app off the page
        // with no visible back button would strand someone in it.
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.requested != url else { return }
        context.coordinator.requested = url
        webView.load(URLRequest(url: url))
    }

    /// The app's own version, so the token stays true across releases. Read from
    /// the bundle rather than written twice: `MARKETING_VERSION` in
    /// `project.yml` is already the source of it.
    private static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }
}
