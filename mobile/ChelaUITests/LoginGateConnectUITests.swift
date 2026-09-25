import XCTest

/// Connect pressed on the Control UI's OWN login gate must put the loading screen
/// up at once and hold it until the interface has rendered. The phone's half of
/// the proof; the desktop's is desktop/scripts/test-login-gate-connect.js.
///
/// The gate is reached on purpose through the login-gate proxy
/// (desktop/scripts/login-gate-proxy.js) in front of a real gateway: it serves the
/// page and refuses the page's socket, so the page draws "Gateway unreachable".
/// The test then switches the proxy to pass the socket after a delay, presses
/// Connect, and samples whether the loading cover (the shared loading page, whose
/// web view carries the identifier "loading-cover") is on screen.
///
/// Opt-in, because it needs a gateway: skipped unless the runner is given
/// CLAW_GATE_GATEWAY (the proxy's address) and CLAW_GATE_CONTROL (its control
/// address); xcodebuild forwards them with the TEST_RUNNER_ prefix.
@MainActor
final class LoginGateConnectUITests: XCTestCase {
    private func env(_ name: String) -> String? {
        let value = ProcessInfo.processInfo.environment[name]
        return (value?.isEmpty ?? true) ? nil : value
    }

    private func control(_ base: String, _ path: String) {
        let done = expectation(description: path)
        URLSession.shared.dataTask(with: URL(string: base + path)!) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 5)
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    /// iOS confirms every icon change with its own alert, and the app changes its
    /// icon when the page reports its theme. Accept any that is up, so the alert
    /// is not what the press lands on.
    @discardableResult
    private func acceptIconAlerts(_ app: XCUIApplication, for seconds: TimeInterval) -> Int {
        var accepted = 0
        let until = Date().addingTimeInterval(seconds)
        repeat {
            for source in [app, springboard] {
                let alert = source.alerts.firstMatch
                if alert.exists {
                    let ok = alert.buttons["OK"].firstMatch
                    if ok.exists { ok.tap(); accepted += 1 }
                }
            }
            if accepted == 0 && seconds > 0 { usleep(300_000) }
        } while Date() < until
        return accepted
    }

    private func cover(_ app: XCUIApplication) -> XCUIElement {
        app.webViews.matching(identifier: "loading-cover").firstMatch
    }

    /// Launch onto the gate, and return the gate's Connect.
    private func launchOntoTheGate() throws -> (XCUIApplication, XCUIElement, String) {
        guard let gateway = env("CLAW_GATE_GATEWAY"), let controlBase = env("CLAW_GATE_CONTROL") else {
            throw XCTSkip("needs CLAW_GATE_GATEWAY and CLAW_GATE_CONTROL")
        }
        control(controlBase, "/set?socket=refuse")
        let app = XCUIApplication()
        app.launchArguments += ["-claw-gateway-url", gateway]
        app.launchEnvironment["OPENCLAW_SEED_TOKEN"] = env("CLAW_GATE_TOKEN") ?? "login-gate-test"
        app.launch()
        let connect = app.webViews.buttons["Connect"].firstMatch
        XCTAssertTrue(connect.waitForExistence(timeout: 90), "the Control UI login gate never came up")
        // The launch cover lifts once the gate has painted; wait for that, so the
        // press below is the only thing that can raise it again.
        let deadline = Date().addingTimeInterval(20)
        while cover(app).exists && Date() < deadline { usleep(200_000) }
        acceptIconAlerts(app, for: 6)
        shot(app, "gate")
        return (app, connect, controlBase)
    }

    func testConnectOnTheGateShowsTheLoadingScreenUntilTheInterfaceRenders() throws {
        let (app, connect, controlBase) = try launchOntoTheGate()
        control(controlBase, "/set?socket=pass&delay=3000")
        let pressed = Date()
        connect.tap()
        var firstCover: TimeInterval?
        var lastCover: TimeInterval?
        while Date().timeIntervalSince(pressed) < 9 {
            let at = Date().timeIntervalSince(pressed)
            if cover(app).exists {
                if firstCover == nil { firstCover = at; shot(app, "cover") }
                lastCover = at
            }
            acceptIconAlerts(app, for: 0)
            usleep(100_000)
        }
        shot(app, "after")
        let first = try XCTUnwrap(firstCover, "the loading screen never came up; the gate sat there for the whole connect")
        XCTAssertLessThan(first, 1.5, "the loading screen must come up at once")
        XCTAssertGreaterThan(lastCover ?? 0, 2.5, "it must be held while the page connects, not flashed")
        XCTAssertFalse(cover(app).exists, "the interface is on screen at the end")
        XCTAssertFalse(app.webViews.buttons["Connect"].exists, "the gate has gone")
    }

    func testARefusedConnectLandsOnTheFailedState() throws {
        let (app, connect, _) = try launchOntoTheGate()
        let pressed = Date()
        connect.tap()
        XCTAssertTrue(cover(app).waitForExistence(timeout: 1.5), "the loading screen must come up at once")
        while Date().timeIntervalSince(pressed) < 5 { acceptIconAlerts(app, for: 0); usleep(200_000) }
        shot(app, "failed")
        XCTAssertTrue(cover(app).exists, "a refused connect stays on the loading screen's failed state, never back on the bare gate")
        XCTAssertTrue(cover(app).buttons["Try again"].exists, "with Try again")
    }
}
