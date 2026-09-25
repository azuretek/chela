import XCTest
import WebKit

@testable import Chela

/// A custom theme reaching the app: the strips, the palette, and the mark.
///
/// An imported theme is not a picker setting. Upstream keeps it in a STYLE TAG in
/// the document head (syncCustomThemeStyleTag, id "openclaw-custom-theme") and
/// REWRITES that tag text when another one is imported, so nothing on the root
/// changes: the theme attribute stays "custom" and the mode attribute stays put.
/// Every leg this client has hangs off that one observer, and the leg that reads
/// the palette hangs off the report it makes, so a swap reached none of them: the
/// strips kept the previous background, the token re-read never ran, and the mark
/// kept the previous accent.
///
/// The palettes below are authored in oklch(), which is what the palette exporters
/// write. That is the second half: Chromium KEEPS the space in the value it
/// computes, and both readers here are parsers that understand #hex and rgb(), so
/// an unconverted accent was refused by AppIcons and an unconverted background was
/// not even reportable. Reported 2026-09-25 on the desktop build, and the same
/// chain is what this drives on this client.
///
/// It drives the SHIPPED scripts, the relay (WebView.themeScript) and the reader
/// (ThemeTokens.probeScript), against a page that swaps its custom theme with no
/// attribute change.
@MainActor
final class CustomThemeFollowTests: XCTestCase {
    private static let firstAccent = "oklch(0.63 0.21 22)"
    private static let secondAccent = "oklch(0.72 0.17 155)"
    private static let firstBackground = "oklch(0.97 0.01 95)"
    private static let secondBackground = "oklch(0.96 0.02 155)"

    /// The style tag text as upstream writes it: one block per appearance.
    private static func customTheme(accent: String, background: String) -> String {
        """
        :root[data-theme="custom"] {
          --bg: \(background);
          --accent: \(accent);
        }
        :root[data-theme="custom-light"] {
          --bg: \(background);
          --accent: \(accent);
        }
        """
    }

    private static func page(custom: String) -> String {
        """
        <!doctype html>
        <html data-theme="custom-light" data-theme-mode="light">
        <head><meta charset="utf-8"><title>Custom theme fixture</title>
        <style>
          :root { color-scheme: light; --bg: #0b0d12; --accent: #ff5c5c; }
          body { background: var(--bg); }
        </style>
        <style id="openclaw-custom-theme">
        \(custom)
        </style>
        </head>
        <body><h1>Fixture</h1></body>
        </html>
        """
    }

    /// Every colour the relay posted, in order. A report is the page telling the
    /// app its theme moved, which is where the strips and the token re-read start.
    private final class Reports: NSObject, WKScriptMessageHandler {
        private(set) var colours: [[Int]] = []

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [NSNumber] else { return }
            colours.append(body.map { $0.intValue })
        }
    }

    private func waitForReports(_ reports: Reports, atLeast count: Int, seconds: TimeInterval = 8) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if reports.colours.count >= count { return true }
            try? await Task.sleep(nanoseconds: 50 * 1_000_000)
        }
        return reports.colours.count >= count
    }

    /// What the app reads out of the page, through the shipped probe.
    private func readTokens(_ webView: WKWebView) async throws -> [String: String] {
        let value = try await webView.callAsyncJavaScript(
            "return " + ThemeTokens.probeScript,
            arguments: [:],
            in: nil,
            contentWorld: .page
        )
        guard let json = value as? String, let data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
            return [:]
        }
        return parsed
    }

    private func themeAttributes(_ webView: WKWebView) async throws -> String? {
        try await webView.callAsyncJavaScript(
            "return document.documentElement.getAttribute('data-theme') + '/' + document.documentElement.getAttribute('data-theme-mode');",
            arguments: [:],
            in: nil,
            contentWorld: .page
        ) as? String
    }

    func testACustomThemeSwapWithNoAttributeChangeReachesTheStripsAndTheMark() async throws {
        let configuration = WKWebViewConfiguration()
        let reports = Reports()
        configuration.userContentController.add(reports, name: WebView.themeMessageName)
        // INJECTED EXACTLY AS THE APP INJECTS IT, so what is under test is the
        // shipped relay rather than a copy of it.
        configuration.userContentController.addUserScript(WKUserScript(
            source: WebView.themeScript,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))

        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 402, height: 800), configuration: configuration)
        // IN A WINDOW, because a detached web view resolves its own media queries
        // from the test process rather than from the page.
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 800))
        window.addSubview(webView)
        window.isHidden = false
        defer {
            webView.removeFromSuperview()
            window.isHidden = true
            configuration.userContentController.removeScriptMessageHandler(forName: WebView.themeMessageName)
        }

        webView.loadHTMLString(
            Self.page(custom: Self.customTheme(accent: Self.firstAccent, background: Self.firstBackground)),
            baseURL: nil
        )

        let reportedAtLoad = await waitForReports(reports, atLeast: 1)
        XCTAssertTrue(reportedAtLoad,
            "the page came up wearing a custom theme and the relay never reported it, so the strips and the token re-read never ran")

        let firstTokens = try await readTokens(webView)
        let firstTarget = AppIconFollower.target(tokens: firstTokens, deviceIsDark: false)
        XCTAssertNotNil(firstTarget,
            "the mark could not read the accent of a palette exporter theme: \(firstTokens["--accent"] ?? "(none)")")

        // The swap, and NOTHING else: the tag text changes, no attribute does.
        let attributesBefore = try await themeAttributes(webView)
        _ = try await webView.callAsyncJavaScript(
            "const tag = document.getElementById('openclaw-custom-theme'); tag.textContent = css; return tag.textContent.length;",
            arguments: ["css": Self.customTheme(accent: Self.secondAccent, background: Self.secondBackground)],
            in: nil,
            contentWorld: .page
        )
        let attributesAfter = try await themeAttributes(webView)
        XCTAssertEqual(attributesBefore, attributesAfter,
            "this test changed an attribute, so it is not the reported case")

        let reportedAgain = await waitForReports(reports, atLeast: 2)
        XCTAssertTrue(reportedAgain,
            "the page swapped its custom theme and the relay never reported again, so the strips and the token re-read stayed on the previous theme")

        let secondTokens = try await readTokens(webView)
        XCTAssertNotEqual(secondTokens["--accent"], firstTokens["--accent"],
            "the palette the app reads did not move with the swap")
        if let accent = secondTokens["--accent"] {
            XCTAssertTrue(accent.hasPrefix("rgb"),
                "the accent arrived as \(accent), which is the notation the palette was authored in rather than a colour AppIcons can read")
        }
        let secondTarget = AppIconFollower.target(tokens: secondTokens, deviceIsDark: false)
        XCTAssertNotNil(secondTarget,
            "the mark could not read the swapped accent: \(secondTokens["--accent"] ?? "(none)")")
        XCTAssertNotEqual(secondTarget, firstTarget,
            "the mark kept the previous accent bucket, so the icon did not follow the theme")

        XCTAssertNotEqual(reports.colours.last, reports.colours.first,
            "the relay reported the same background after the swap")
    }
}
