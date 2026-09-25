import XCTest

@testable import Chela

/// Parity with core/spec/login-gate-connect.json.
final class LoginGateConnectParityTests: XCTestCase {
    func testTheBundledSpecIsTheRepositorysByteForByte() throws {
        let bundled = try XCTUnwrap(Bundle.main.url(forResource: "login-gate-connect", withExtension: "json"), "login-gate-connect.json is not in the bundle")
        let repo = try Fixtures.spec().appendingPathComponent("login-gate-connect.json")
        XCTAssertEqual(try Data(contentsOf: bundled), try Data(contentsOf: repo))
    }

    func testTheScriptIsReadAndPostsOnThePairingChannel() throws {
        let script = try XCTUnwrap(LoginGateConnect.script, "the bundled spec carries no script, so a Connect press would go unseen")
        XCTAssertTrue(script.contains("messageHandlers." + PairingBridge.messageName))
        XCTAssertTrue(script.contains("'.login-gate__connect'"))
        XCTAssertGreaterThan(LoginGateConnect.deadlineMs, 0)
    }

    func testReportsAreNarrowedToTheThreeKinds() {
        XCTAssertEqual(LoginGateConnect.read(["kind": "connect-pressed"]), .pressed)
        XCTAssertEqual(LoginGateConnect.read(["kind": "connect-rendered"]), .rendered)
        XCTAssertEqual(LoginGateConnect.read(["kind": "connect-failed", "title": "  Gateway\n unreachable "]), .failed(title: "Gateway unreachable"))
        XCTAssertNil(LoginGateConnect.read(["kind": "authenticated"]))
        XCTAssertNil(LoginGateConnect.read([:]))
    }
}

@MainActor
final class PageCoverConnectPressTests: XCTestCase {
    private func settle() async { for _ in 0..<10 { await Task.yield() } }

    func testPressingConnectCoversUntilTheInterfaceRendered() async throws {
        let cover = PageCover(backstop: .seconds(60))
        XCTAssertFalse(cover.isCovered)
        cover.connectPressed(deadline: .seconds(60), floorMs: 0)
        XCTAssertTrue(cover.isCovered, "the press must put the loading screen up at once")
        await settle()
        XCTAssertTrue(cover.isCovered, "nothing lifts it before the interface has rendered")
        cover.connectRendered()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(cover.isCovered)
        XCTAssertEqual(cover.lastLift, "rendered")
    }

    func testAPressNobodyAnswersFailsOnTheDeadlineAndNeverLifts() async throws {
        let cover = PageCover(backstop: .seconds(60))
        cover.connectPressed(deadline: .milliseconds(20), floorMs: 0)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertTrue(cover.isCovered)
        XCTAssertTrue(cover.failed, "a press with no answer lands on the failed state with Try again")
        cover.connectRendered()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(cover.isCovered, "a render after the deadline must not lift a cover that has failed")
    }

    func testARefusalLandsOnTheFailedState() async {
        let cover = PageCover(backstop: .seconds(60))
        cover.connectPressed(deadline: .seconds(60), floorMs: 0)
        cover.connectFailed("Gateway unreachable")
        XCTAssertTrue(cover.isCovered)
        XCTAssertTrue(cover.failed)
    }

    func testTheLiftWaitsOutTheFloor() async throws {
        let cover = PageCover(backstop: .seconds(60))
        cover.connectPressed(deadline: .seconds(60), floorMs: 300)
        cover.connectRendered()
        await settle()
        XCTAssertTrue(cover.isCovered, "held the minimum-visible floor from the press, so it is seen")
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertFalse(cover.isCovered)
    }

    func testAReportWithNoPressIsIgnoredAndALoadOfOurOwnVoidsThePress() async throws {
        let cover = PageCover(backstop: .seconds(60))
        cover.connectRendered()
        cover.connectFailed("x")
        XCTAssertFalse(cover.isCovered)
        XCTAssertFalse(cover.failed)
        cover.connectPressed(deadline: .milliseconds(20), floorMs: 0)
        cover.hold()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(cover.failed, "the press deadline must not fail a load of our own that replaced it")
        cover.connectRendered()
        XCTAssertTrue(cover.isCovered, "and its render report must not lift that load's cover")
    }
}
