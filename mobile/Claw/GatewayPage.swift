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

    /// Ask the Control UI to open its own settings, and report when the
    /// destination has ARRIVED.
    ///
    /// The completion is the whole fix and it is why this is not fire-and-forget
    /// any more. The reader used to be returned to the gateway page FIRST and the
    /// ask sent second, so they watched whatever the Control UI had been showing
    /// for the whole of the destination's load, a visible few seconds, before the
    /// settings page painted. The destination was never wrong; the journey showed
    /// them a page they had not asked for. So the ask goes first, the settings
    /// sheet stays up while it lands, and the sheet is dismissed from the
    /// completion once the Control UI's own settings page is genuinely on screen.
    /// Same shape as the desktop's `openControlUiSettings()`, and the same shape
    /// as the loading cover: revealed only once there is something to reveal.
    ///
    /// The completion runs on every path, including the ones that go wrong, so a
    /// sheet that cannot be dismissed is not a state this can produce: a client
    /// holding the reader behind a surface that will not let go is a worse fault
    /// than the one being fixed.
    ///
    /// Every non-answer is logged rather than swallowed: no page at all, a script
    /// that threw, or a footer with no settings control to press. The reader is
    /// then handed back the sheet they were on, which is where they started.
    func openControlUiSettings(completion: @escaping () -> Void) {
        guard let webView else {
            NSLog("[claw] no gateway page to open the Control UI settings in")
            completion()
            return
        }
        webView.evaluateJavaScript(AppSettingsAffordance.controlUiSettingsSource()) { result, error in
            if let error {
                NSLog("[claw] could not open the Control UI settings: %@", String(describing: error))
                completion()
                return
            }
            guard (result as? Bool) == true else {
                NSLog("[claw] the Control UI has no footer settings control to press; the reader stays on the page")
                completion()
                return
            }
            self.waitForControlUiSettings(completion: completion)
        }
    }

    /// Hold the completion until the Control UI has rendered the settings page the
    /// handoff promises.
    ///
    /// Polled from out here rather than awaited inside the page, and that is
    /// forced by the mechanism rather than chosen: the shipping Control UI has no
    /// footer settings control, so the ask falls through to the Control UI's own
    /// settings ROUTE, which is a full document load. A promise waiting inside the
    /// page is destroyed by the very navigation it is waiting on, so the question
    /// has to be asked again from outside, where it survives the swap. The SPA
    /// case is unchanged: if upstream ever ships the control, this same wait
    /// resolves on the render that follows the click.
    ///
    /// Bounded by the spec's deadline, past which the completion runs anyway and
    /// the log says which happened, so a Control UI that never arrives costs the
    /// reader the wait and nothing else.
    private func waitForControlUiSettings(completion: @escaping () -> Void) {
        guard let source = AppSettingsAffordance.controlUiSettingsReadySource() else {
            NSLog("[claw] this build's affordance spec names no settings surface to wait for; revealing at once")
            completion()
            return
        }
        askReady(source: source, deadline: Date().addingTimeInterval(Double(AppSettingsAffordance.readyTimeoutMs) / 1000), completion: completion)
    }

    /// One readiness question. Anything that is not a yes re-asks rather than
    /// giving up, because the commonest non-answer here is not a failure but the
    /// navigation itself: asking a document that is being replaced cannot be
    /// answered, and the answer worth having is in the document that replaces it.
    private func askReady(source: String, deadline: Date, completion: @escaping () -> Void) {
        guard let webView else {
            completion()
            return
        }
        webView.evaluateJavaScript(source) { result, _ in
            if (result as? Bool) == true {
                completion()
                return
            }
            if Date() >= deadline {
                NSLog("[claw] the Control UI did not render its settings page within %dms; revealing anyway", AppSettingsAffordance.readyTimeoutMs)
                completion()
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(AppSettingsAffordance.pollMs) / 1000) {
                Task { @MainActor in self.askReady(source: source, deadline: deadline, completion: completion) }
            }
        }
    }
}
