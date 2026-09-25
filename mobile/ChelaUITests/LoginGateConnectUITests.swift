import XCTest

/// The Control UI's OWN connection screen must never be the surface in Chela
/// (Abi, 2026-09-25: "if we never show the control UIs own connection screen that
/// would be ideal, control the whole auth flow").
///
/// The phone's half of the proof. The desktop's is
/// desktop/scripts/test-login-gate-connect.js, which can drive the gate's own
/// Connect inside the page and so measures the press as well; a tap on the phone
/// cannot reach a control that is behind the cover, which is the point.
///
/// The gate is reached on purpose through the login-gate proxy
/// (desktop/scripts/login-gate-proxy.js) in front of a real gateway: it serves the
/// page and refuses the page's socket, so the page draws "Gateway unreachable". The
/// app must cover it, land on its own failed state with Try again, and never hand
/// the reader the page's Connect.
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

    @discardableResult
    private func control(_ base: String, _ path: String) -> [String: Any] {
        let done = expectation(description: path)
        var answer: [String: Any] = [:]
        URLSession.shared.dataTask(with: URL(string: base + path)!) { data, _, _ in
            if let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { answer = object }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 5)
        return answer
    }

    /// The gate was really reached: the page loaded through the proxy and its
    /// socket was refused. Without this, a page that never loaded passes every
    /// assertion below, because the app's own failed-load screen is also a cover.
    private func assertTheGateWasReached(_ controlBase: String) {
        let deadline = Date().addingTimeInterval(30)
        var refused = 0
        repeat {
            refused = (control(controlBase, "/state")["refused"] as? Int) ?? 0
            if refused > 0 { break }
            usleep(500_000)
        } while Date() < deadline
        XCTAssertGreaterThan(refused, 0, "the page never loaded and tried its socket, so the gate was never reached and nothing here is measured")
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    /// iOS confirms every icon change with its own alert, and the app changes its
    /// icon when the page reports its theme. Accept any that is up, so the alert is
    /// not what the test is looking at.
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

    /// The page's own Connect, which must never be reachable.
    private func pageConnect(_ app: XCUIApplication) -> XCUIElement {
        app.webViews.buttons["Connect"].firstMatch
    }

    /// The page's own screen is under our cover, not on screen. isHittable cannot
    /// say this: it reports the page's Connect as hittable from inside its own web
    /// view even while a separate view is drawn over it (measured 2026-09-25, with
    /// the cover's failed state on screen). What the reader sees is decided by the
    /// cover being up and its frame holding the page's control.
    private func pagesOwnScreenIsUnreachable(_ app: XCUIApplication, _ whenIt: String) {
        let connect = pageConnect(app)
        guard connect.exists else { return }
        let cover = cover(app)
        XCTAssertTrue(cover.exists, "the Control UI's own connection screen was on screen with nothing over it " + whenIt)
        XCTAssertTrue(cover.frame.contains(connect.frame), "the Control UI's own Connect was outside the cover " + whenIt)
    }

    /// Launch onto a gate: the page is served, its socket is refused, and the page
    /// draws its own "Gateway unreachable".
    private func launchOntoTheGate() throws -> (XCUIApplication, String) {
        guard let gateway = env("CLAW_GATE_GATEWAY"), let controlBase = env("CLAW_GATE_CONTROL") else {
            throw XCTSkip("needs CLAW_GATE_GATEWAY and CLAW_GATE_CONTROL")
        }
        control(controlBase, "/set?socket=refuse")
        let app = XCUIApplication()
        app.launchArguments += ["-claw-gateway-url", gateway]
        app.launchEnvironment["OPENCLAW_SEED_TOKEN"] = env("CLAW_GATE_TOKEN") ?? "login-gate-test"
        app.launch()
        assertTheGateWasReached(controlBase)
        return (app, controlBase)
    }

    func testTheControlUisOwnConnectionScreenIsNeverTheSurface() throws {
        let (app, _) = try launchOntoTheGate()
        XCTAssertTrue(cover(app).waitForExistence(timeout: 60),
            "the loading screen must be what is shown, not the page's own connection screen")
        pagesOwnScreenIsUnreachable(app, "when the gate was reached")
        XCTAssertTrue(cover(app).buttons["Try again"].waitForExistence(timeout: 30),
            "the gate lands on the failed state with Try again, never a screen that spins")
        pagesOwnScreenIsUnreachable(app, "after the failed state")
        acceptIconAlerts(app, for: 1)
        shot(app, "gate-covered")
    }

    func testTryAgainFromTheFailedStateCoversRatherThanShowingThePage() throws {
        let (app, _) = try launchOntoTheGate()
        XCTAssertTrue(cover(app).buttons["Try again"].waitForExistence(timeout: 60), "the failed state never came up")
        shot(app, "failed")
        cover(app).buttons["Try again"].tap()
        XCTAssertTrue(cover(app).waitForExistence(timeout: 10), "Try again goes through the loading screen")
        pagesOwnScreenIsUnreachable(app, "after Try again")
        shot(app, "retry")
    }
}
