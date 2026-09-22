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

    /// The Control UI's live design tokens, read out of the gateway page when this
    /// surface is presented (see `ThemeTokens`, `GatewayPage.liveTokens`).
    ///
    /// This is the leg that was missing on iOS, and the whole reason Abi's report
    /// exists: the desktop hands these same values to this same page, so its
    /// settings surface wears the interface's Instrument Sans and its `#0e1015`
    /// slate, while the phone's wore ui.css's fallback palette and the system
    /// font. Empty means no gateway page has answered, and the fallback stands.
    let tokens: [String: String]

    /// Which appearance the app is in. The page's own palette resolves from
    /// `prefers-color-scheme`, which a web view answers from its own traits, so
    /// this is what makes the surface the same colour as the rest of the app the
    /// moment the choice is made in it. `system` leaves the trait collection to
    /// the device, so a live change still reaches the page.
    let appearance: AppearanceMode

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
        // The interface's own palette and type, before the page paints. Injected
        // rather than built into ui.css because these values are the RUNNING
        // Control UI's, and a copy of them in our stylesheet would be a copy that
        // goes stale the day upstream re-themes. See `ThemeTokens`.
        scripts.addUserScript(WKUserScript(
            source: ThemeTokens.applyScript(tokens),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        context.coordinator.appliedTokens = tokens
        context.coordinator.appliedAppearance = appearance
        configuration.userContentController = scripts

        let webView = WKWebView(frame: .zero, configuration: configuration)
        // Painted with the PAGE's own resolved background, for the reason About
        // gives in full: this page draws its card on a wash (\`--scrim\` is the
        // palette's \`--bg\` at 70%), it is not opaque, and anything behind it shows
        // through — so a host colour that follows the DEVICE rather than the
        // palette composites to a second shade at the card's edge. Same map, same
        // page, one rule for both surfaces. A page with no resolved palette keeps
        // the system colour, which is what its first frame is painted on.
        let pageBackground = PaletteColour.uiColor(from: tokens["--bg"]) ?? .systemBackground
        webView.isOpaque = false
        webView.backgroundColor = pageBackground
        webView.scrollView.backgroundColor = pageBackground
        // The page's appearance is the PALETTE's, not this client's own setting:
        // see `ThemeTokens.pageTrait`, which is what stops the page's colours and
        // its appearance from being read off two different chains. The setting
        // still paints the native chrome around the page.
        webView.overrideUserInterfaceStyle = ThemeTokens.pageTrait(tokens: tokens, own: appearance.userInterfaceStyle)
        // The page paints the strips too, rather than leaving them to the native
        // layer.
        //
        // A web view insets its own content by the safe area by default, which is
        // right for a page that cannot know where the status bar is and wrong for
        // one that can: the inset region is outside the page, so the strips above
        // and below it were painted by `scrollView.backgroundColor` while the page
        // painted itself up to an invisible line. In light mode that read as a
        // white band under a cream page, and in dark mode as a black one, which is
        // the shape of the report this answers. With the inset off, the page fills
        // its frame and insets its OWN content through `env(safe-area-inset-*)`,
        // which ui.css does and which the page's viewport meta
        // (`viewport-fit=cover`) is what makes non-zero. So the colour at the top
        // and bottom of the screen is the page's own background by construction,
        // rather than a value guessed by the native layer and free to disagree
        // with it.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
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
        #if DEBUG
        // A screenshot run for a tab long enough to scroll (Gateways, with its
        // list) keeps the About footer that sits under every tab below the fold,
        // and a simulator cannot be swiped by a script. So on this launch argument
        // the page is scrolled to its foot once it has laid out, which is what lets
        // a screenshot show the footer on a long tab as well as a short one. Inert
        // without the argument and compiled out of a release build; the delegate is
        // set only in that case so it does not shadow the page's own behaviour
        // otherwise. See `SettingsSpec.screenshotScrollsToBottom`.
        if SettingsSpec.screenshotScrollsToBottom {
            webView.navigationDelegate = context.coordinator
        }
        #endif
        webView.loadFileURL(page, allowingReadAccessTo: directory)
        return webView
    }

    /// What this surface has already pushed into the page.
    ///
    /// Held here rather than recomputed, because `updateUIView` runs on every
    /// layout pass: without it the token layer would be re-applied several times a
    /// second, and a page cannot tell a re-application from a theme change.
    final class Coordinator: NSObject, WKNavigationDelegate {
        var appliedTokens: [String: String] = [:]
        var appliedAppearance: AppearanceMode?

        #if DEBUG
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard SettingsSpec.screenshotScrollsToBottom else { return }
            // After a beat: the file page loads, then its own script renders the
            // gateway list into the DOM, so the content is not its full height
            // until a frame or two later. The scroll region is the page's own
            // `.modal__body` (CSS `overflow-y: auto`), not the web view's outer
            // scroll view, which is why this scrolls that element rather than
            // `webView.scrollView`. Clamped by the browser to the element's own
            // range, so a short tab simply stays at the top.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                webView.evaluateJavaScript(
                    "(function(){var b=document.querySelector('.modal__body');if(b){b.scrollTop=b.scrollHeight;}})()"
                )
            }
        }
        #endif
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // The token layer first: it is the interface's palette, and it is what
        // makes this page look like part of the Control UI rather than beside it.
        // Re-applied when it changes, which is on open and whenever the appearance
        // moved, because a palette read in one mode is the wrong palette in the
        // other.
        if context.coordinator.appliedTokens != tokens {
            context.coordinator.appliedTokens = tokens
            webView.evaluateJavaScript(ThemeTokens.applyScript(tokens))
            // The palette carries the appearance it belongs to, so a map that
            // arrives after the view was built moves the page's trait with it.
            webView.overrideUserInterfaceStyle = ThemeTokens.pageTrait(tokens: tokens, own: appearance.userInterfaceStyle)
        }
        // Then the trait the page's own palette resolves against, so a change made
        // in this surface repaints it rather than waiting for the next navigation.
        if context.coordinator.appliedAppearance != appearance {
            context.coordinator.appliedAppearance = appearance
            webView.overrideUserInterfaceStyle = ThemeTokens.pageTrait(tokens: tokens, own: appearance.userInterfaceStyle)
        }
        // Nothing to push: the page re-reads its own state when the host raises an
        // event, and every command answers with the state it produced.
        //
        // The appearance is the one exception, and it is not state the page reads:
        // it is the trait its own palette resolves against, so the surface can be
        // repainted the moment the row is used rather than at the next open.
        if webView.overrideUserInterfaceStyle != appearance.userInterfaceStyle {
            webView.overrideUserInterfaceStyle = appearance.userInterfaceStyle
        }
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
