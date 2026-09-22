import XCTest
import WebKit

@testable import Chela

/// The safe-area inset the app supplies to the Control UI, so the page insets its
/// content while its \`100dvh\` surfaces fill the whole screen.
///
/// WHY THIS EXISTS. The web view covers the whole screen (see
/// \`ContentView.controlUiPage\`), which is what lets the Control UI's slide-open
/// navigation drawer reach the top: reported 2026-09-19, "when the menu bar slides
/// open it doesn't follow all the way up the screen", because the page had been
/// laid out inside the safe area, so \`100dvh\` was the safe height and the drawer
/// stopped at the status bar. Covering the whole screen fixes the drawer but would
/// draw the page's content under the status bar, which is the fault the previous
/// arrangement was there to avoid, so \`WebView.safeAreaScript\` sets the standalone
/// body inset the Control UI ships for itself, applied because a WKWebView cannot
/// report the \`display-mode: standalone\` that would apply it.
///
/// Two claims, both measured on a rendered page rather than asserted in prose:
///
///   - the script sets the page's OWN \`:root\` safe-area tokens as body padding, so
///     content insets by the real device insets and this couples to no class of the
///     Control UI's;
///   - it sizes \`html, body\` to \`100dvh\`, so the shell fills the screen the drawer
///     slides up, rather than the safe height.
///
/// The device insets are simulated by giving the page concrete \`--safe-area-*\`
/// values (a test host has no real safe area), which is exactly the substitution
/// WebKit performs from a real inset: the tokens are \`env(safe-area-inset-*, 0px)\`
/// at \`:root\`, so a page with real insets resolves them to the same place this
/// test reads.
final class WebViewSafeAreaTests: XCTestCase {
    // MARK: - The rule the script sets

    func testTheScriptSetsTheStandaloneBodyInsetFromThePagesOwnTokens() {
        // Assert on the CSS the injector installs, not the injector's JS: the
        // "names no Control UI class" invariant is a property of the CSS selectors,
        // and a blanket "no dot" check on the JS would trip over its own DOM calls
        // (document.createElement and the like), not a class. safeAreaScript embeds
        // exactly this CSS.
        let css = WebView.safeAreaCss
        XCTAssertTrue(WebView.safeAreaScript.contains(css),
            "the injector does not install the safe-area CSS verbatim")

        // The four edges, each from the page's own --safe-area token, marked
        // !important so it wins over the browser-mode default the page draws with.
        for edge in ["top", "right", "bottom", "left"] {
            XCTAssertTrue(
                css.contains("padding-" + edge + ":var(--safe-area-" + edge + ","),
                "the body inset does not read the page's own --safe-area-" + edge + " token"
            )
        }
        XCTAssertTrue(css.contains("!important"),
            "the body inset is not marked important, so the page's browser-mode default wins")
        // The shell fills the viewport, which is what the drawer slides up.
        XCTAssertTrue(css.contains("height:100dvh"),
            "the CSS does not size the shell to the viewport, so 100dvh surfaces would not fill the screen")
        XCTAssertTrue(css.contains("position:fixed"),
            "the body is not pinned, which is part of the standalone rule the Control UI ships")
        // It couples to no Control UI class: the CSS touches html and body only, so
        // it carries no class selector (and, being pure CSS, no dot at all).
        XCTAssertFalse(css.contains("."),
            "the CSS names a selector class, which would couple it to the Control UI's markup")
    }

    // MARK: - The rule actually applies

    /// A minimal page carrying the Control UI's own \`:root\` safe-area tokens set to
    /// concrete values, plus a \`100dvh\`-sized inner shell like the one the drawer
    /// lives in, rendered in a real web view with \`safeAreaScript\` installed.
    @MainActor
    private func render(topInset: Int, bottomInset: Int) async throws -> [String: String] {
        // The page's own tokens, the way its :root defines them, given concrete
        // values here because a test host reports no real safe area. A real device
        // inset resolves to the same tokens through the same env() defaults.
        let html = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <style>
          :root {
            --safe-area-top: \(topInset)px;
            --safe-area-right: 0px;
            --safe-area-bottom: \(bottomInset)px;
            --safe-area-left: 0px;
          }
          /* The shell the drawer slides up inside, sized the way the Control UI
             sizes its own: 100dvh. If the script sizes html/body to the viewport,
             this fills the screen; if it were confined to a safe box it would not. */
          #shell { height: 100dvh; margin: 0; }
        </style>
        </head><body><div id="shell"></div></body></html>
        """

        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 402, height: 800))
        // Install the exact script the app installs, at document start, the way
        // makeUIView does.
        webView.configuration.userContentController.addUserScript(WKUserScript(
            source: WebView.safeAreaScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        // In a window, for the same reason PageAppearanceTests renders in one: a
        // detached web view resolves viewport units and layout against the test
        // process rather than a real view tree.
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 800))
        window.addSubview(webView)
        window.isHidden = false
        defer {
            webView.removeFromSuperview()
            window.isHidden = true
        }

        let waiter = SafeAreaNavigationWaiter()
        webView.navigationDelegate = waiter
        webView.loadHTMLString(html, baseURL: nil)
        await waiter.waitForLoad()

        let probe = """
        (function () {
          var body = getComputedStyle(document.body);
          var htmlEl = getComputedStyle(document.documentElement);
          var shell = document.getElementById('shell').getBoundingClientRect();
          return JSON.stringify({
            padTop: body.paddingTop,
            padBottom: body.paddingBottom,
            bodyPosition: body.position,
            htmlHeight: htmlEl.height,
            shellHeight: String(Math.round(shell.height)),
            viewportHeight: String(window.innerHeight)
          });
        })()
        """
        let value = try await webView.callAsyncJavaScript(
            "return \(probe)", arguments: [:], in: nil, contentWorld: .page
        )
        guard let json = value as? String, let data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
            XCTFail("the page answered nothing this test could read")
            return [:]
        }
        return parsed
    }

    @MainActor
    func testTheBodyInsetsByThePagesSafeAreaAndTheShellFillsTheViewport() async throws {
        let insetTop = 47
        let insetBottom = 34
        let measured = try await render(topInset: insetTop, bottomInset: insetBottom)

        // The content is inset by the device's safe area, top and bottom, so it
        // does not draw under the status bar or the home indicator.
        XCTAssertEqual(measured["padTop"], "\(insetTop)px",
            "the body did not inset its content by the top safe area (\(measured["padTop"] ?? "nil"))")
        XCTAssertEqual(measured["padBottom"], "\(insetBottom)px",
            "the body did not inset its content by the bottom safe area (\(measured["padBottom"] ?? "nil"))")
        XCTAssertEqual(measured["bodyPosition"], "fixed",
            "the body is not pinned, so the standalone rule did not take")

        // And the 100dvh shell fills the whole viewport rather than a safe box,
        // which is what lets a full-height surface the page slides open reach the
        // top of the screen. Read as the shell being the viewport's own height.
        let shell = Int(measured["shellHeight"] ?? "0") ?? 0
        let viewport = Int(measured["viewportHeight"] ?? "0") ?? 0
        XCTAssertGreaterThan(shell, 0, "the shell measured no height")
        XCTAssertEqual(shell, viewport,
            "the 100dvh shell (\(shell)) is not the full viewport (\(viewport)), so a surface it sizes would stop short of the screen edge")
    }
}

/// Local navigation waiter, since PageAppearanceTests' own is file-private.
private final class SafeAreaNavigationWaiter: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false

    func waitForLoad() async {
        if finished { return }
        await withCheckedContinuation { continuation = $0 }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { complete() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { complete() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { complete() }

    private func complete() {
        finished = true
        continuation?.resume()
        continuation = nil
    }
}
