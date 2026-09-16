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
    /// The gateway to load. The address and the name travel together, because a
    /// failure has to name the gateway it was about.
    let gateway: Gateway

    /// Which appearance the app is in, so the page can be told.
    ///
    /// The relay is two-way: the page reports the colour it is actually painted
    /// with (see `themeScript`), and the app passes the appearance down in return.
    /// Down is the web view's own trait collection, which is what a page's
    /// `prefers-color-scheme` resolves against, so `system` keeps following the
    /// device live and an explicit light or dark pins the page to the same answer
    /// the native chrome is wearing. Nothing is written into the page: the hidden
    /// leg is the platform's own channel, and a page we do not own is not a place
    /// to inject state. See the note on `WebView.themeScript`.
    let appearance: AppearanceMode

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

    /// What the settings page's gateway rows read for their badge.
    ///
    /// This view is the only thing that knows whether a load is in flight, so it
    /// is where the phase is set, and the settings host reads it rather than
    /// sniffing the web view for it.
    let connection: ConnectionState

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
        /// The last appearance pushed down to this web view, so `updateUIView`
        /// only touches the view and the page when it actually changed.
        var appliedAppearance: AppearanceMode?
        private let themeColour: Binding<Color>
        private let notices: NoticeBoard
        private let connection: ConnectionState
        /// The gateway's name, for the notice a failed load raises. Carried
        /// rather than read from `Gateway`, which no longer has a default to
        /// read, and rather than re-derived from a URL that a provisional
        /// failure may not have delivered yet.
        private let gatewayName: String
        /// The same gateway's id, for the row that reports the phase. A name can
        /// be edited; the id cannot, and a row is looked up by id.
        private let gatewayId: String

        init(
            themeColour: Binding<Color>,
            notices: NoticeBoard,
            connection: ConnectionState,
            gatewayName: String,
            gatewayId: String
        ) {
            self.themeColour = themeColour
            self.notices = notices
            self.connection = connection
            self.gatewayName = gatewayName
            self.gatewayId = gatewayId
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
            Task { @MainActor in
                notices.connectionRecovered()
                connection.connected(gatewayId)
            }
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
                    label: gatewayName,
                    description: "The page stopped responding and will be reloaded."
                )
                connection.failed(gatewayId)
                webView.reload()
            }
        }

        private func report(_ error: Error) {
            let urlError = error as? URLError
            if urlError?.code == .cancelled { return }
            let description = urlError?.localizedDescription ?? error.localizedDescription
            Task { @MainActor in
                notices.connectionFailed(label: gatewayName, description: description)
                connection.failed(gatewayId)
            }
        }
    }

    /// The name the injected script posts under.
    static let themeMessageName = "clawTheme"

    /// The hook the app calls to make the page report again.
    ///
    /// The script installs it, and the app calls it whenever the appearance
    /// changes, so the strips are repainted at the moment of the choice rather
    /// than at the next trait propagation. Named with the same prefix as the
    /// message, because both are one relay's two ends.
    static let themeReportHook = "__clawThemeReport"

    /// Reports the page's own background as three channel values, and re-reports
    /// whenever the page's theme changes.
    ///
    /// Two things about this are deliberate, and both were arrived at by getting
    /// them wrong first.
    ///
    /// **It reads the page's background, not its `theme-color` meta.** The meta is
    /// declared per `prefers-color-scheme`, which is the *device's* appearance, and
    /// the Control UI's own theme picker is free to disagree with it: set the
    /// Control UI to light on a phone in dark mode and the page is cream while the
    /// media query still says dark. Reading the meta then reports a colour the page
    /// is not painted with, and the strips come out black on a light page. Assigning
    /// `var(--bg)` to a real property and reading the *computed* value makes the
    /// engine answer for the page as it is actually styled, whatever the palette was
    /// authored in, which is also how the desktop's relay reads the same page (see
    /// readTheme in desktop/src/preload.cjs). The meta stays as the fallback for a
    /// page that paints itself some other way.
    ///
    /// **It watches for changes rather than reading once.** The theme picker
    /// rewrites `data-theme` and `data-theme-mode` in place with no navigation, so
    /// there is no load event to hang this off; the attribute IS the event. The same
    /// observer catches the page repainting after a `prefers-color-scheme` change,
    /// which is the leg the app drives when the appearance is changed here.
    ///
    /// `WKWebView.themeColor` is the native route to the same value and was tried
    /// first, on the reasoning that a property beats an injected script. Observed
    /// through KVO it never delivered a value, and left the strips the window's
    /// colour while looking like it worked. A mechanism that silently does nothing
    /// is worse here than no mechanism, so it was replaced rather than kept
    /// alongside this.
    private static var themeScript: String {
        """
        (function () {
          // A colour as three channels, or null. Anything not fully opaque is a
          // failure rather than a colour: `rgba(0, 0, 0, 0)` is what a probe
          // resolves to when the token does not exist at all, and reading it as
          // black would paint the strips black on precisely the pages that have
          // no background of their own.
          function channels(colour) {
            if (typeof colour !== 'string') { return null; }
            var text = colour.trim().toLowerCase();
            var hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
            if (hex) {
              var digits = hex[1];
              if (digits.length === 3) {
                digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2];
              }
              return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
            }
            var rgb = /^rgba?\\(\\s*([\\d.]+)[\\s,]+([\\d.]+)[\\s,]+([\\d.]+)\\s*(?:[,/]\\s*([\\d.]+%?)\\s*)?\\)$/.exec(text);
            if (!rgb) { return null; }
            if (rgb[4] !== undefined) {
              var alpha = rgb[4].indexOf('%') >= 0 ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
              if (!(alpha > 0.5)) { return null; }
            }
            // Held to 0-255 so a page cannot hand the app a colour channel out of
            // range, the same way the desktop parses every value before it reaches
            // an API.
            var out = [];
            for (var i = 1; i <= 3; i += 1) {
              var n = Math.round(Number(rgb[i]));
              if (!isFinite(n)) { return null; }
              out.push(Math.min(255, Math.max(0, n)));
            }
            return out;
          }

          // The page's background, through a real property so the engine
          // flattens whatever notation the palette was authored in. The probe is
          // temporary and changes nothing about the page.
          function pageBackground() {
            var probe = document.createElement('span');
            probe.setAttribute('aria-hidden', 'true');
            probe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;height:0;pointer-events:none;background-color:var(--bg)';
            document.documentElement.appendChild(probe);
            var value = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return value;
          }

          // What the page declares for the appearance in force. Only reached when
          // the page paints its background some way the probe cannot see.
          function declaredColour() {
            var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            var meta = document.querySelector('meta[name="theme-color"][media*="' + (dark ? 'dark' : 'light') + '"]')
                    || document.querySelector('meta[name="theme-color"]');
            return meta ? (meta.getAttribute('content') || '') : '';
          }

          function report() {
            var rgb = channels(pageBackground()) || channels(declaredColour());
            if (!rgb) { return; }
            try { window.webkit.messageHandlers.\(themeMessageName).postMessage(rgb); } catch (e) {}
          }

          // The app calls this when the appearance changes, which is the one case
          // the observer cannot see: the trait collection moved before the page
          // re-resolved its own palette.
          window.\(themeReportHook) = report;

          report();
          try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', report); } catch (e) {}
          try {
            new MutationObserver(report).observe(document.documentElement, {
              attributes: true,
              attributeFilter: ['data-theme', 'data-theme-mode', 'data-theme-resolved', 'style', 'class']
            });
          } catch (e) {}
        })();
        """
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            themeColour: $themeColour,
            notices: notices,
            connection: connection,
            gatewayName: gateway.label,
            gatewayId: gateway.id
        )
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

        // The appearance the app is in, applied where the page can see it. A
        // WKWebView resolves a page's `prefers-color-scheme` from its own trait
        // collection, so this is the whole of the downward leg: no attribute is
        // written into a page we do not own, and an explicit light or dark here
        // is the same answer the native chrome and the settings surface are
        // wearing. `system` is `.unspecified`, which leaves the trait collection
        // driven by the device, so a live device change still reaches the page.
        webView.overrideUserInterfaceStyle = appearance.userInterfaceStyle

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
        // Before the load guard below, because the appearance has to reach a page
        // that is already on screen: changing it in settings must repaint what is
        // in front of you rather than wait for the next navigation. Applied only
        // when it differs from the last one, because this method runs on every
        // layout pass and a script call per pass would be work nobody asked for.
        if context.coordinator.appliedAppearance != appearance {
            context.coordinator.appliedAppearance = appearance
            webView.overrideUserInterfaceStyle = appearance.userInterfaceStyle
            // And told to report again, because the trait collection moved before
            // the page re-resolved its palette: the strips would otherwise keep
            // the previous appearance's colour until something else repainted
            // them. The hook is installed by `themeScript`, and the `&&` is what
            // makes this a no-op on a page that has not run it yet.
            webView.evaluateJavaScript("window.\(Self.themeReportHook) && window.\(Self.themeReportHook)()")
        }

        guard context.coordinator.requested != gateway.url else { return }
        context.coordinator.requested = gateway.url
        // Recorded before the load rather than after it, because the settings page
        // shows this row while the load is in flight: a phase set on completion
        // would only ever report the two ends of a connect and never the middle,
        // which is the state someone opening Settings to check is the one they
        // would find missing.
        connection.connecting(gateway.id)
        // The stored token rides on the fragment, so nobody is asked to paste one
        // into the page. Read here rather than held, for the same reason
        // `SettingsCredentials` hands out no getter: the value exists for the
        // length of this call.
        let token = SettingsCredentials.values(gateway.id).token
        webView.load(URLRequest(url: GatewayURL.withTokenHandoff(gateway.url, token)))
    }
}
