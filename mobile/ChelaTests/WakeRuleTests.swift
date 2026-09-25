import XCTest
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
        XCTAssertEqual(r.actions, ["close", "reconnect", "none", "uncover"])
        XCTAssertEqual(r.reconnects, 1)
        XCTAssertEqual(r.state, "awake")
    }

    func testActiveWithNoNetworkWaitsForThePath() {
        let r = run(["scenePhase:background", "NWPathMonitor:unsatisfied", "scenePhase:active", "NWPathMonitor:satisfied", "page:rendered"])
        XCTAssertEqual(r.actions, ["close", "none", "cover", "reconnect", "uncover"])
        XCTAssertEqual(r.reconnects, 1)
    }

    func testMissedHeartbeatWhileOpenReconnects() {
        let r = run(["page:socket-dropped", "page:rendered"])
        XCTAssertEqual(r.actions, ["reconnect", "uncover"])
    }

    func testInterfaceChangeReconnects() {
        XCTAssertEqual(run(["NWPathMonitor:interface-changed"]).reconnects, 1)
    }
}
