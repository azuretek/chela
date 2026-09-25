import XCTest
import WebKit

@testable import Chela

/// A custom theme reaching the paint of our own controls, on the phone.
///
/// Reported 2026-09-25: "I notice some of the buttons still turn red, we should
/// follow the theme". A tweakcn theme writes a FIXED list of names into its style
/// tag (live.customTheme in core/spec/tokens.json, upstream's MODE_TOKEN_ORDER),
/// and every other name keeps upstream's base value on the page. --primary-hover
/// is not in that list, so the page computed it as upstream's default red, the
/// probe took it as though it were the theme's, and a primary button tapped on
/// the phone (WebKit keeps :hover after a tap) went red inside a themed surface.
///
/// This drives the SHIPPED probe against a page shaped like upstream's (its base
/// palette on :root, the custom theme in the openclaw-custom-theme tag), applies
/// what it read to our real stylesheet the way the settings and About surfaces
/// do, and requires the colours our controls paint to move with the theme. The
/// desktop half, every control in every state on every page, is
/// desktop/scripts/test-controls-follow-theme.js.
@MainActor
final class ControlsFollowThemeTests: XCTestCase {
    /// Upstream's base red for --primary-hover (ui/src/styles/base.css), which is
    /// what a custom theme leaves it at.
    private static let upstreamRed = "rgb(194, 46, 46)"

    private static func gatewayPage(primary: String, accent: String, bg: String, text: String) -> String {
        """
        <!doctype html>
        <html data-theme="custom" data-theme-mode="dark">
        <head><meta charset="utf-8"><title>Custom theme fixture</title>
        <style>
          :root { color-scheme: dark; --bg: #0e1015; --text-strong: #f4f4f5; --accent: #ff5c5c;
                  --primary: #d13c3c; --primary-hover: #c22e2e; --primary-foreground: #ffffff; }
        </style>
        <style id="openclaw-custom-theme">
        :root[data-theme="custom"] {
          --bg: \(bg);
          --text-strong: \(text);
          --accent: \(accent);
          --primary: \(primary);
        }
        </style>
        </head>
        <body><h1>Fixture</h1></body>
        </html>
        """
    }

    /// What the app reads out of a gateway page, through the shipped probe.
    private func readTokens(fromGatewayPage html: String) async throws -> [String: String] {
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 402, height: 800))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 800))
        window.addSubview(webView)
        window.isHidden = false
        defer {
            webView.removeFromSuperview()
            window.isHidden = true
        }
        let waiter = ControlsThemeNavigationWaiter()
        webView.navigationDelegate = waiter
        webView.loadHTMLString(html, baseURL: nil)
        await waiter.waitForLoad()
        let value = try await webView.callAsyncJavaScript(
            "return " + ThemeTokens.probeScript,
            arguments: [:],
            in: nil,
            contentWorld: .page
        )
        guard let json = value as? String, let data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
            XCTFail("the probe answered nothing this test could read")
            return [:]
        }
        return parsed
    }

    /// The colours our controls paint, on our real stylesheet under those tokens.
    private func paints(tokens: [String: String], capture name: String) async throws -> [String: String] {
        let ui = try Fixtures.directory("ui")
        let css = try String(contentsOf: ui.appendingPathComponent("ui.css"), encoding: .utf8)
        let html = """
        <!doctype html><html><head><meta charset="utf-8">
        <style>\(css)</style>
        <script>\(ThemeTokens.applyScript(tokens))</script>
        </head><body>
        <div style="display:flex;gap:12px;align-items:center;padding:16px">
        <button class="primary" id="primary">At rest</button>
        <button class="primary" style="background:var(--primary-hover);border-color:var(--primary-hover)">Hover and press</button>
        <span class="settings-row--toggle"><input type="checkbox" id="box" checked></span>
        <span class="settings-row--toggle"><input type="checkbox"></span>
        </div>
        </body></html>
        """
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 402, height: 800))
        webView.overrideUserInterfaceStyle = ThemeTokens.pageTrait(tokens: tokens, own: .dark)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 800))
        window.overrideUserInterfaceStyle = webView.overrideUserInterfaceStyle
        window.addSubview(webView)
        window.isHidden = false
        defer {
            webView.removeFromSuperview()
            window.isHidden = true
        }
        let waiter = ControlsThemeNavigationWaiter()
        webView.navigationDelegate = waiter
        webView.loadHTMLString(html, baseURL: nil)
        await waiter.waitForLoad()
        // The hover and press paint is read as the token the rule paints with,
        // because a web view in a test cannot be made to hover: the declaration is
        // button.primary:hover { background: var(--primary-hover) }.
        let probe = """
        const span = document.createElement('span');
        span.style.backgroundColor = 'var(--primary-hover)';
        document.body.appendChild(span);
        const box = document.getElementById('box');
        return JSON.stringify({
          primaryHover: getComputedStyle(span).backgroundColor,
          primary: getComputedStyle(document.getElementById('primary')).backgroundColor,
          boxFill: getComputedStyle(box).backgroundColor,
          boxTick: getComputedStyle(box, '::before').borderRightColor,
        });
        """
        let value = try await webView.callAsyncJavaScript(probe, arguments: [:], in: nil, contentWorld: .page)
        // Before and after proof for a PR: the paint as WebKit on this device draws
        // it, written only when a run asks for it (TEST_RUNNER_CHELA_CAPTURE_DIR).
        if let directory = ProcessInfo.processInfo.environment["CHELA_CAPTURE_DIR"] {
            let configuration = WKSnapshotConfiguration()
            configuration.rect = CGRect(x: 0, y: 0, width: 402, height: 80)
            if let image = try? await webView.takeSnapshot(configuration: configuration), let png = image.pngData() {
                try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
                try? png.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
            }
        }
        guard let json = value as? String, let data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
            XCTFail("our page answered nothing this test could read")
            return [:]
        }
        return parsed
    }

    func testEveryControlColourMovesWithTheCustomTheme() async throws {
        let first = try await readTokens(fromGatewayPage: Self.gatewayPage(
            primary: "oklch(0.65 0.17 255)", accent: "oklch(0.7 0.17 255)", bg: "oklch(0.2 0.03 255)", text: "oklch(0.97 0.02 255)"))
        let second = try await readTokens(fromGatewayPage: Self.gatewayPage(
            primary: "oklch(0.65 0.17 145)", accent: "oklch(0.7 0.17 145)", bg: "oklch(0.2 0.03 145)", text: "oklch(0.97 0.02 145)"))
        XCTAssertNotEqual(first["--primary"], second["--primary"], "the fixture's two themes did not differ, so this measures nothing")

        let underFirst = try await paints(tokens: first, capture: "ios-first-theme")
        let underSecond = try await paints(tokens: second, capture: "ios-second-theme")
        XCTAssertNotEqual(underFirst["primary"], underSecond["primary"], "the primary button did not follow the theme at rest")
        XCTAssertNotEqual(underFirst["primaryHover"], Self.upstreamRed,
            "a primary button hovered or pressed paints upstream's default red under a custom theme")
        for key in ["primaryHover", "boxFill", "boxTick"] {
            XCTAssertNotEqual(underFirst[key], underSecond[key],
                "\(key) paints \(underFirst[key] ?? "(none)") under both custom themes, so it does not come from the theme")
        }
    }
}

@MainActor
private final class ControlsThemeNavigationWaiter: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false

    func waitForLoad() async {
        if finished { return }
        await withCheckedContinuation { continuation in
            if finished { continuation.resume() } else { self.continuation = continuation }
        }
    }

    private func done() {
        finished = true
        continuation?.resume()
        continuation = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { done() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { done() }
}
