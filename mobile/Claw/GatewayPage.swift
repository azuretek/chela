import Foundation
import WebKit

/// The handle this client keeps on the gateway page, so a surface that needs the
/// page to DO something can ask it rather than growing a web view of its own.
///
/// There is one such ask today. The settings page's "Go to the Control UI" takes
/// the reader to the Control UI's OWN settings, which is a different place from
/// this app's settings and is not ours to navigate: the Control UI owns that
/// route, and its own footer control is the shortest path to it. So the client
/// closes its surface and lets the page open its own settings, by pressing that
/// control through one shared line of script
/// (`core/app-settings-affordance.js`'s `controlUiSettingsSource()`), which is
/// the same bytes the desktop evaluates. Building a URL here instead would be a
/// second copy of a decision the Control UI already made, and a full reload of a
/// page that is already loaded behind the sheet.
///
/// Weak on purpose. The `WebView` that makes the page owns it, and a strong
/// reference here would keep a torn-down web view alive behind a settings sheet
/// that had already been dismissed.
@MainActor
final class GatewayPage: ObservableObject {
    /// Set by `WebView.makeUIView`, which is the only thing that creates one.
    weak var webView: WKWebView?

    /// Ask the Control UI for its live design tokens.
    ///
    /// The settings and About surfaces are our own pages, and until this existed
    /// they were the only surfaces in the app not wearing the interface's type and
    /// palette: the desktop hands the same two pages the tokens it reads from this
    /// same page (main.js applyThemeCss), and this client had no such leg at all.
    /// `ThemeTokens` holds the shared list of names and the two scripts; this is
    /// the read half.
    ///
    /// Every non-answer is empty rather than an error: no page, a page that
    /// throws, or a page that publishes none of these names all mean the surface
    /// keeps ui.css's fallback palette, which is styled, just not matched.
    func liveTokens(_ done: @escaping ([String: String]) -> Void) {
        guard let webView else {
            NSLog("[claw] no gateway page to read the live theme tokens from")
            done([:])
            return
        }
        webView.evaluateJavaScript(ThemeTokens.probeScript) { result, error in
            if let error {
                NSLog("[claw] could not read the live theme tokens: %@", String(describing: error))
                done([:])
                return
            }
            guard let json = result as? String,
                  let data = json.data(using: .utf8),
                  let map = (try? JSONSerialization.jsonObject(with: data)) as? [String: String]
            else {
                done([:])
                return
            }
            done(map)
        }
    }

    /// Ask the Control UI to open its own settings.
    ///
    /// Every non-answer is logged rather than swallowed: no page at all, a script
    /// that threw, or a footer with no settings control to press all leave the
    /// reader exactly where they were, and a button that appears to do nothing is
    /// worth a line in the app's own log. Nothing is fetched or navigated here,
    /// so the worst a failure can mean is that the settings sheet closed and the
    /// Control UI is showing what it showed before.
    func openControlUiSettings() {
        guard let webView else {
            NSLog("[claw] no gateway page to open the Control UI settings in")
            return
        }
        webView.evaluateJavaScript(AppSettingsAffordance.controlUiSettingsSource()) { result, error in
            if let error {
                NSLog("[claw] could not open the Control UI settings: %@", String(describing: error))
                return
            }
            if (result as? Bool) == false {
                NSLog("[claw] the Control UI has no footer settings control to press; the reader stays on the page")
            }
        }
    }
}
