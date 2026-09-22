import XCTest
import WebKit

@testable@testable import Chela

/// The appearance our own pages are given, and the measured half of it.
///
/// Reported 2026-09-17, and it is the second time a page of ours has gone wrong:
/// "the settings page lost its theme, it's using the default dark", with the
/// accent still arriving. Colours arriving and the appearance not is what puts the
/// fault at THIS seam rather than at the palette: the palette reaches the page by
/// NAME (a custom property per name), and the appearance reaches it through
/// `prefers-color-scheme`, which follows the web view's trait. A page in the wrong
/// mode keeps every mode-keyed declaration it owns in the wrong block while the
/// palette's own names are right, so it wears two palettes at once.
///
/// The rule, and the same one the desktop follows: the theme changes only from the
/// Control UI's theme UI or from switching to a gateway with a different theme, so
/// our own surfaces READ what that chain resolves and never decide an appearance
/// for themselves. A default is the same failure as a decision, just quieter.
///
/// Both halves are asserted, and they are different claims. The first is the
/// decision itself. The second loads the REAL `core/ui/ui.css` into a real
/// `WKWebView`, applies a palette the way the app does, and reads a name only the
/// MODE can move: it fails against the wiring this replaces, where the trait came
/// from this client's own appearance setting, and it reads the palette's own
/// background through the same page so "the colours arrived" is measured too.
final class PageAppearanceTests: XCTestCase {
    // MARK: - Where the page's mode comes from

    func testThePalettesAppearanceWinsOverThisClientsOwnSetting() {
        XCTAssertEqual(
            ThemeTokens.pageTrait(tokens: ["\(ThemeTokens.schemeKey)": "light"], own: .dark),
            .light,
            "the page's trait came from this client's setting while the palette said light"
        )
        XCTAssertEqual(
            ThemeTokens.pageTrait(tokens: ["\(ThemeTokens.schemeKey)": "dark"], own: .light),
            .dark,
            "the page's trait came from this client's setting while the palette said dark"
        )
    }

    func testAPageThatResolvedNothingFallsBackToThisClientsSetting() {
        // The stated fallback, and the only case where the setting may answer:
        // nothing resolved, so ui.css's own palette is what is on screen and the
        // device is the only appearance available.
        XCTAssertEqual(ThemeTokens.pageTrait(tokens: [:], own: .dark), .dark)
        XCTAssertEqual(ThemeTokens.pageTrait(tokens: [:], own: .light), .light)
        XCTAssertEqual(ThemeTokens.pageTrait(tokens: [:], own: .unspecified), .unspecified)
        // And nothing else is read as an appearance: a palette that published
        // something unpublishable must not pin one.
        XCTAssertEqual(ThemeTokens.pageTrait(tokens: ["\(ThemeTokens.schemeKey)": "sepia"], own: .dark), .dark)
    }

    // MARK: - The measured half

    /// A name only the MODE can move, the palette's own background, and the
    /// colour scheme the page resolved, read off a rendered page as JSON.
    private static let probe = """
    (function () {
      var root = getComputedStyle(document.documentElement);
      return JSON.stringify({
        ok: root.getPropertyValue('--ok').trim(),
        bg: root.getPropertyValue('--bg').trim(),
        scheme: String(root.colorScheme).trim()
      });
    })()
    """

    /// Render one of our pages with the real stylesheet, a palette applied the way
    /// the app applies it, and a trait, then read it back.
    @MainActor
    private func render(trait: UIUserInterfaceStyle, tokens: [String: String]) async throws -> [String: String] {
        let ui = try Fixtures.directory("ui")
        let css = try String(contentsOf: ui.appendingPathComponent("ui.css"), encoding: .utf8)
        let html = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <style>\(css)</style>
        <script>\(ThemeTokens.applyScript(tokens))</script>
        </head><body class="as-page"></body></html>
        """

        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 402, height: 800))
        // The one line under test: the same call the settings and About surfaces
        // make, so a host that stopped making it fails here.
        webView.overrideUserInterfaceStyle = ThemeTokens.pageTrait(tokens: tokens, own: trait)

        // IN A WINDOW, and this is not decoration. A web view's trait reaches the
        // page's `prefers-color-scheme` through the window it is in; a detached one
        // resolves the query from the test process instead, so BOTH appearances
        // came back as the machine's and this measured nothing while looking like
        // it measured the page. Measured: both renders returned the light block's
        // values with the trait set to dark, which is how this was found.
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 800))
        window.overrideUserInterfaceStyle = webView.overrideUserInterfaceStyle
        window.addSubview(webView)
        window.isHidden = false
        defer {
            webView.removeFromSuperview()
            window.isHidden = true
        }

        let waiter = NavigationWaiter()
        webView.navigationDelegate = waiter
        webView.loadHTMLString(html, baseURL: nil)
        await waiter.waitForLoad()

        let value = try await webView.callAsyncJavaScript(
            "return \(Self.probe)",
            arguments: [:],
            in: nil,
            contentWorld: .page
        )
        guard let json = value as? String, let data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
            XCTFail("the page answered nothing this test could read, so it measured no colours")
            return [:]
        }
        return parsed
    }

    /// The two values `--ok` resolves to, one per appearance, read off the page
    /// rather than written here: the stylesheet owns them, and a copy in this file
    /// would agree with whatever it happened to say on the day it was typed.
    @MainActor
    private func okValues() async throws -> (dark: String, light: String) {
        let dark = try await render(trait: .dark, tokens: [:])
        let light = try await render(trait: .light, tokens: [:])
        XCTAssertNotEqual(dark["ok"], light["ok"],
            "ui.css no longer resolves --ok per appearance, so this guard measures nothing")
        return (dark["ok"] ?? "", light["ok"] ?? "")
    }

    @MainActor
    func testAPageTakesTheAppearanceOfThePaletteItWasGiven() async throws {
        let reference = try await okValues()

        // The device in one mode and the palette in the other: the state the reader
        // was in, and the one a single-appearance check sails past.
        let palette: [String: String] = [
            "\(ThemeTokens.schemeKey)": "light",
            "--bg": "rgb(250, 244, 237)",
            "--card": "rgb(255, 252, 250)",
        ]

        let deviceDark = try await render(trait: .dark, tokens: palette)
        XCTAssertEqual(deviceDark["ok"], reference.light,
            "the page kept its mode-keyed colours from the device while the palette said light")
        XCTAssertEqual(deviceDark["bg"], "rgb(250, 244, 237)",
            "the palette's own colours did not reach the page, which is the OTHER fault")
        XCTAssertEqual(deviceDark["scheme"], "light", "the page's color-scheme is not the palette's")

        let deviceLight = try await render(trait: .light, tokens: ["\(ThemeTokens.schemeKey)": "dark", "--bg": "rgb(25, 23, 36)"])
        XCTAssertEqual(deviceLight["ok"], reference.dark,
            "the page kept its mode-keyed colours from the device while the palette said dark")
        XCTAssertEqual(deviceLight["bg"], "rgb(25, 23, 36)")
    }

    @MainActor
    func testAPageWithNoPaletteUsesThisClientsOwnAppearance() async throws {
        // The no-palette case, which is the one that produces a dark default: with
        // nothing resolved the page is on ui.css's own palette, and the only
        // appearance available is this client's, so that is what it must wear.
        let reference = try await okValues()
        let dark = try await render(trait: .dark, tokens: [:])
        let light = try await render(trait: .light, tokens: [:])
        XCTAssertEqual(dark["ok"], reference.dark)
        XCTAssertEqual(light["ok"], reference.light)
        XCTAssertNotEqual(dark["bg"], light["bg"], "ui.css no longer resolves --bg per appearance")
    }
}

/// Answers the first load, which is all any of these renders needs.
@MainActor
private final class NavigationWaiter: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false

    func waitForLoad() async {
        if finished { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            self.continuation = continuation
        }
    }

    private func complete() {
        finished = true
        continuation?.resume()
        continuation = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { complete() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { complete() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { complete() }
}
