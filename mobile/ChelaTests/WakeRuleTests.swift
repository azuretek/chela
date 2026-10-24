import XCTest
import SwiftUI
import WebKit
@testable import Chela

/// The event orders that stranded a queued message, walked through the bundled
/// table, so the phone is proven against the same file the desktop tests.
@MainActor
final class WakeRuleTests: XCTestCase {
    private func run(_ raws: [String]) -> (actions: [String], reconnects: Int, state: String) {
        let wake = WakeMonitor()
        var reconnects = 0
        wake.reconnect = { reconnects += 1 }
        let actions = raws.map { wake.report($0) }
        return (actions, reconnects, wake.state)
    }

    func testBackgroundThenActiveReconnectsOnce() {
        let r = run(["scenePhase:background", "scenePhase:active", "scenePhase:active", "page:rendered"])
        XCTAssertEqual(r.actions, ["none", "reconnect", "none", "uncover"])
        XCTAssertEqual(r.reconnects, 1)
        XCTAssertEqual(r.state, "awake")
    }

    func testActiveWithNoNetworkWaitsForThePath() {
        let r = run(["scenePhase:background", "NWPathMonitor:unsatisfied", "scenePhase:active", "NWPathMonitor:satisfied", "page:rendered"])
        XCTAssertEqual(r.actions, ["none", "none", "none", "reconnect", "uncover"])
        XCTAssertEqual(r.reconnects, 1)
    }

    func testMissedHeartbeatWhileOpenReconnects() {
        let r = run(["page:socket-dropped", "page:rendered"])
        XCTAssertEqual(r.actions, ["reconnect", "uncover"])
    }

    func testInterfaceChangeReconnects() {
        XCTAssertEqual(run(["NWPathMonitor:interface-changed"]).reconnects, 1)
    }
    func testResumeKeepsWKDocumentAndCompletesHealthyWake() async throws {
        let web = WKWebView()
        let loaded = expectation(description: "fixture loaded")
        let navigation = QuietResumeNavigation(loaded)
        web.navigationDelegate = navigation
        web.loadHTMLString("<input id='draft' value='unsent'><script>window.documentId='existing';window.activations=0;addEventListener('online',()=>window.activations++);</script>", baseURL: nil)
        await fulfillment(of: [loaded], timeout: 15)
        let page = GatewayPage()
        page.webView = web
        let wake = WakeMonitor()
        let resumed = expectation(description: "native activation completed")
        wake.reconnect = {
            page.resumeConnection {
                wake.report("page:rendered")
                resumed.fulfill()
            }
        }
        defer { wake.reconnect = {} }
        wake.report("scenePhase:background")
        wake.report("scenePhase:active")
        await fulfillment(of: [resumed], timeout: 15)
        let result = try await web.evaluateJavaScript("JSON.stringify([window.documentId,document.getElementById('draft').value,window.activations])")
        XCTAssertEqual(result as? String, "[\"existing\",\"unsent\",1]")
        XCTAssertEqual(wake.state, "awake")
        XCTAssertEqual(navigation.finished, 1, "resume must not navigate")
        web.stopLoading()
    }

    func testTerminatedRendererReplacesOnceAndRejectsStalePage() async {
        let web = RecoveryCountingWebView()
        let page = GatewayPage()
        page.webView = web
        let pairing = PairingState()
        pairing.opened()
        let coordinator = WebView.Coordinator(
            themeColour: .constant(.black), themeReports: .constant(0),
            notices: NoticeBoard(), connection: ConnectionState(), pairing: pairing,
            gatewayName: "Fixture", gatewayId: "fixture", cover: PageCover(), onOpenAppSettings: {}
        )
        coordinator.recoveryGatewayId = "fixture"
        coordinator.pageControl = page
        coordinator.recoveryWebView = web
        let replaced = expectation(description: "one replacement")
        web.onReload = { replaced.fulfill() }
        coordinator.webViewWebContentProcessDidTerminate(web)
        await fulfillment(of: [replaced], timeout: 5)
        XCTAssertEqual(web.reloads, 1)
        pairing.opened()
        coordinator.resumeTerminatedRenderer()
        coordinator.webViewWebContentProcessDidTerminate(web)
        await Task.yield()
        XCTAssertEqual(web.reloads, 1, "a second loss must not create a crash loop")
        coordinator.rendererRecoveryUsed = false
        coordinator.rendererRecoveryPending = true
        let replacement = WKWebView()
        page.webView = replacement
        coordinator.resumeTerminatedRenderer()
        XCTAssertTrue(page.webView === replacement)
        XCTAssertEqual(web.reloads, 1, "a detached gateway must not replace the selected page")
    }
}

@MainActor
private final class RecoveryCountingWebView: WKWebView {
    var reloads = 0
    var onReload: () -> Void = {}
    override func reload() -> WKNavigation? {
        reloads += 1
        onReload()
        return nil
    }
}

@MainActor
private final class QuietResumeNavigation: NSObject, WKNavigationDelegate {
    private let loaded: XCTestExpectation
    private(set) var finished = 0
    init(_ loaded: XCTestExpectation) { self.loaded = loaded }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finished += 1
        if finished == 1 { loaded.fulfill() }
    }
}
