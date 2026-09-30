import XCTest
import WebKit

@testable import Chela

/// The About header, measured on the page this client actually renders.
///
/// Reported on 1.0.1-dev.358: the Chela mark in the header sat left of the cards'
/// own edge while the card headings ("Updates", "Cached Control UI code") started
/// further in, and it sat 25px off its own name. Both are properties of the shared
/// stylesheet, so they are read here off the bundled about.html in a real web view,
/// the way the phone draws it, rather than restated from the CSS. The desktop reads
/// the same two numbers in desktop/scripts/test-about-surface.js.
final class AboutLayoutTests: XCTestCase {
    @MainActor
    private func measure(width: CGFloat) async throws -> [String: Any] {
        guard let page = AboutSurface.page, let directory = AboutSurface.directory else {
            XCTFail("core/ui/about.html is not in the bundle")
            return [:]
        }
        let host = AboutHost(notices: NoticeBoard(), onClose: {})
        let configuration = WKWebViewConfiguration()
        let scripts = WKUserContentController()
        scripts.add(host, name: AboutHost.messageName)
        // At document start, as AboutSurface installs it: the page's own script
        // throws if the host is not there yet.
        scripts.addUserScript(WKUserScript(
            source: host.bootstrapScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController = scripts

        let frame = CGRect(x: 0, y: 0, width: width, height: 900)
        let webView = WKWebView(frame: frame, configuration: configuration)
        // In a window, so layout resolves against a real view tree.
        let window = UIWindow(frame: frame)
        window.addSubview(webView)
        window.isHidden = false
        defer {
            webView.removeFromSuperview()
            window.isHidden = true
            scripts.removeScriptMessageHandler(forName: AboutHost.messageName)
        }

        let waiter = AboutLayoutNavigationWaiter()
        webView.navigationDelegate = waiter
        webView.loadFileURL(page, allowingReadAccessTo: directory)
        await waiter.waitForLoad()

        // Settle first: the page's entrance motion is finished rather than waited
        // out, and two frames let layout land after it.
        let probe = """
        await document.fonts.ready;
        for (const a of document.getAnimations()) { try { a.finish(); } catch (e) {} }
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const root = getComputedStyle(document.documentElement);
        const mark = document.querySelector('.modal__headline .modal__icon');
        const title = document.getElementById('title');
        const headings = [...document.querySelectorAll('.modal__body .settings-group .settings-row__title')];
        if (!mark || !title) return JSON.stringify({});
        const m = mark.getBoundingClientRect();
        const t = title.getBoundingClientRect();
        return JSON.stringify({
          markLeft: m.left,
          headingLefts: headings.map((h) => h.getBoundingClientRect().left),
          markToName: t.left + parseFloat(getComputedStyle(title).paddingLeft) - m.right,
          space3: parseFloat(root.getPropertyValue('--space-3')),
        });
        """
        let value = try await webView.callAsyncJavaScript(probe, arguments: [:], in: nil, contentWorld: .page)
        guard let json = value as? String, let data = json.data(using: .utf8),
              let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("the page answered nothing this test could read")
            return [:]
        }
        return parsed
    }

    @MainActor
    private func assertHeaderLinesUp(width: CGFloat) async throws {
        let measured = try await measure(width: width)
        let markLeft = measured["markLeft"] as? Double ?? .nan
        let headings = measured["headingLefts"] as? [Double] ?? []
        XCTAssertGreaterThan(headings.count, 1,
            "at \(Int(width))px the page has no card headings to line the mark up against: \(measured)")
        for heading in headings {
            XCTAssertEqual(markLeft, heading, accuracy: 0.5,
                "at \(Int(width))px the header mark starts at x \(markLeft) but a card heading at x \(heading)")
        }
        let gap = measured["markToName"] as? Double ?? .nan
        let space3 = measured["space3"] as? Double ?? .nan
        XCTAssertEqual(gap, space3, accuracy: 0.5,
            "at \(Int(width))px the mark sits \(gap)px from its name rather than --space-3 (\(space3)px)")
    }

    @MainActor
    func testTheHeaderMarkLinesUpWithTheCardHeadingsOnAPhone() async throws {
        try await assertHeaderLinesUp(width: 402)
    }

    @MainActor
    func testTheHeaderMarkLinesUpWithTheCardHeadingsOnAWideScreen() async throws {
        try await assertHeaderLinesUp(width: 1024)
    }
}

private final class AboutLayoutNavigationWaiter: NSObject, WKNavigationDelegate {
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
