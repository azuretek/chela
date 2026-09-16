import SwiftUI
import WebKit

/// The Control UI, hosted in a `WKWebView`.
///
/// Deliberately thin: this phase loads a URL, relays the page's theme colour and
/// reports whether the load worked, which is the one condition this client can
/// observe on its own and therefore the one notice it raises by itself.
///
/// The navigation delegate the file used to say was absent for a reason is here
/// now for exactly that reason: it exists to answer "did the page load", and the
/// notice board is what consumes the answer. Phase 4's certificate pinning
/// attaches to the same two methods, so it joins a surface that already has a job
/// rather than inventing one.
struct WebView: UIViewRepresentable {
    let url: URL

    /// The page's own background, so the strips the safe area leaves above and
    /// below it are painted with the page's colour rather than the window's.
    ///
    /// Handed down from the view that owns it rather than read here, because
    /// the strips are outside this view: the web view cannot paint what it does
    /// not cover.
    @Binding var themeColour: Color

    /// Where a failed or recovered load is reported. Held rather than observed:
    /// this view raises, and the banner in ContentView draws.
    let notices: NoticeBoard

    /// Remembers what has been asked for, so a SwiftUI update cannot reload the
    /// page under the user. `updateUIView` runs on every layout pass, and the
    /// web view's own `url` is not a usable guard for that: it stays nil until
    /// the navigation commits, so the pass that follows `load` would load it a
    /// second time.
    ///
    /// It is also where the page's theme colour arrives: the script this view
    /// injects posts it through a message handler, which is the only route from
    /// the page back into this app until Phase 4's certificate pinning gives
    /// the navigation delegate a reason to exist.
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var requested: URL?
        private let themeColour: Binding<Color>
        private let notices: NoticeBoard

        init(themeColour: Binding<Color>, notices: NoticeBoard) {
            self.themeColour = themeColour
            self.notices = notices
        }

        func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == WebView.themeMessageName,
                  let parts = message.body as? [NSNumber],
                  parts.count == 3
            else { return }
            themeColour.wrappedValue = Color(uiColor: UIColor(
                red: CGFloat(parts[0].doubleValue) / 255,
                green: CGFloat(parts[1].doubleValue) / 255,
                blue: CGFloat(parts[2].doubleValue) / 255,
                alpha: 1
            ))
        }

        /// The page loaded. Whatever a previous failure said about this gateway is
        /// no longer true, so the notice the banner is showing comes down.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in notices.connectionRecovered() }
        }

        /// The page could not be fetched at all.
        ///
        /// A provisional failure is the one that means the host never answered, or
        /// answered with something that is not a page, which is the condition the
        /// desktop reports as "Cannot connect". A cancelled request is not a
        /// failure of the gateway and is ignored: it is what a superseded load
        /// reports, and raising a banner for it would announce a problem every
        /// time a navigation was replaced.
        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            report(error)
        }

        /// A load that got as far as a response and then failed, or a page that
        /// died after it was up. Both mean the Control UI is not on screen, which
        /// is the same sentence to the reader.
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            Task { @MainActor in
                notices.connectionFailed(
                    label: Gateway.default.name,
                    description: "The page stopped responding and will be reloaded."
                )
                webView.reload()
            }
        }

        private func report(_ error: Error) {
            let urlError = error as? URLError
            if urlError?.code == .cancelled { return }
            let description = urlError?.localizedDescription ?? error.localizedDescription
            Task { @MainActor in
                notices.connectionFailed(label: Gateway.default.name, description: description)
            }
        }
    }

    /// The name the injected script posts under.
    static let themeMessageName = "clawTheme"

    /// Reports the page's `theme-color` as three channel values.
    ///
    /// That meta is the page's own declaration of the colour its surroundings
    /// should be, and the strips above and below the page are exactly that, so
    /// this reads a value the page publishes for the purpose rather than
    /// inspecting the page's styling. It resolves for the appearance in force
    /// and re-reports when the system appearance changes, so the strips follow
    /// the page in both.
    ///
    /// `WKWebView.themeColor` is the native route to the same value and was
    /// tried first, on the reasoning that a property beats an injected script.
    /// Observed through KVO it never delivered a value, and left the strips the
    /// window's colour while looking like it worked. A mechanism that silently
    /// does nothing is worse here than no mechanism, so it was replaced rather
    /// than kept alongside this.
    private static let themeScript = """
    (function () {
      function report() {
        var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        var meta = document.querySelector('meta[name="theme-color"][media*="' + (dark ? 'dark' : 'light') + '"]')
                || document.querySelector('meta[name="theme-color"]');
        if (!meta) { return; }
        var hex = /^\\s*#([0-9a-fA-F]{6})\\s*$/.exec(meta.getAttribute('content') || '');
        if (!hex) { return; }
        var n = parseInt(hex[1], 16);
        window.webkit.messageHandlers.clawTheme.postMessage([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
      }
      report();
      try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', report); } catch (e) {}
    })();
    """

    func makeCoordinator() -> Coordinator {
        Coordinator(themeColour: $themeColour, notices: notices)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The Control UI plays audio and video in the page. Without this, iOS
        // hands playback to the system player, full screen and outside the page
        // it belongs to.
        configuration.allowsInlineMediaPlayback = true
        // The theme-colour relay, described above. Injected at document end so
        // the page's `theme-color` meta is in the document when it runs.
        let scripts = WKUserContentController()
        scripts.add(context.coordinator, name: Self.themeMessageName)
        scripts.addUserScript(WKUserScript(
            source: Self.themeScript,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        // The client-context hook, and the same bytes the desktop installs: the
        // script is read from core/spec/prompt-metadata.json rather than ported,
        // so the two clients cannot drift into two dialects.
        //
        // At document START, unlike the theme relay above, because it replaces
        // `WebSocket.prototype.send` before the page opens a socket. Installed
        // at the end of the document it would be racing a socket the page had
        // already opened, and the frames it missed would be silent.
        scripts.addUserScript(WKUserScript(
            source: PromptMetadata.installation(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController = scripts
        // WebKit's default user agent stops at `Mobile/15E148`, which says
        // nothing about which client asked for the page. Naming ourselves is
        // what lets a gateway's own logs tell this app from Safari on the same
        // phone, and the Control UI only ever reads the user agent to detect a
        // legacy browser, so replacing the token is safe as well as useful.
        configuration.applicationNameForUserAgent = "\(Naming.mobileToken)/\(Naming.buildVersion)"

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
        webView.navigationDelegate = context.coordinator
        return webView
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        // A user content controller keeps its message handlers strongly, so
        // without this the coordinator outlives the view it was made for.
        webView.configuration.userContentController
            .removeScriptMessageHandler(forName: themeMessageName)
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.requested != url else { return }
        context.coordinator.requested = url
        webView.load(URLRequest(url: url))
    }
}
