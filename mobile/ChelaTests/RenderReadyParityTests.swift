import XCTest

@testable import Chela

/// Parity with core/spec/render-ready.json, and the cover gate that uses it.
final class RenderReadyParityTests: XCTestCase {
    func testTheBundledSpecIsTheRepositorysByteForByte() throws {
        let bundled = try XCTUnwrap(Bundle.main.url(forResource: "render-ready", withExtension: "json"), "render-ready.json is not in the bundle")
        let repo = try Fixtures.spec().appendingPathComponent("render-ready.json")
        XCTAssertEqual(try Data(contentsOf: bundled), try Data(contentsOf: repo))
    }

    func testTheProbeIsReadAndWaitsForAPaint() throws {
        let probe = try XCTUnwrap(RenderReady.probe, "the bundled spec carries no probe, so the cover would lift on the load")
        XCTAssertTrue(probe.contains("first-contentful-paint"))
        XCTAssertTrue(probe.hasPrefix("new Promise"))
        XCTAssertGreaterThan(RenderReady.backstopMs, 0)
    }
}

@MainActor
final class PageCoverTests: XCTestCase {
    private func settle() async { for _ in 0..<10 { await Task.yield() } }

    func testALoadIsCoveredUntilThePagePaints() async {
        let cover = PageCover(backstop: .seconds(60))
        cover.hold()
        XCTAssertTrue(cover.isCovered)
        var paint: CheckedContinuation<Void, Never>?
        cover.loaded { await withCheckedContinuation { paint = $0 } }
        await settle()
        XCTAssertTrue(cover.isCovered, "the load finishing must not lift the cover: the page has not painted yet")
        paint?.resume()
        await settle()
        XCTAssertFalse(cover.isCovered)
        XCTAssertEqual(cover.lastLift, "rendered")
    }

    func testAPageThatNeverPaintsIsReleasedByTheBackstop() async throws {
        let cover = PageCover(backstop: .milliseconds(20))
        cover.hold()
        cover.loaded { try await Task.sleep(for: .seconds(60)) }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(cover.isCovered)
        XCTAssertEqual(cover.lastLift, "backstop")
    }

    func testARetryIsNotUncoveredByTheLoadBeforeIt() async {
        let cover = PageCover(backstop: .seconds(60))
        cover.hold()
        var paint: CheckedContinuation<Void, Never>?
        cover.loaded { await withCheckedContinuation { paint = $0 } }
        await settle()
        cover.hold()
        paint?.resume()
        await settle()
        XCTAssertTrue(cover.isCovered, "the earlier load painting must not lift the cover a later load raised")
    }

    /// A failed load keeps the cover up in its failed state, the shared loading
    /// page's "Not connected" with Try again, as the desktop does (Abi,
    /// 2026-09-25), and a paint still on its way cannot take it down.
    func testAFailedLoadHoldsTheCoverInItsFailedState() async {
        let cover = PageCover(backstop: .seconds(60))
        cover.hold()
        var paint: CheckedContinuation<Void, Never>?
        cover.loaded { await withCheckedContinuation { paint = $0 } }
        await Task.yield()
        cover.fail("load-failed")
        XCTAssertTrue(cover.isCovered)
        XCTAssertTrue(cover.failed)
        paint?.resume()
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(cover.isCovered, "a paint from before the failure took the failed cover down")
        // Try again starts a new load, which clears the failed state.
        cover.hold()
        XCTAssertFalse(cover.failed)
        XCTAssertTrue(cover.isCovered)
    }

    /// The progress milestones only move forward, and a new load starts over.
    func testMilestonesMoveForwardOnly() {
        let cover = PageCover(backstop: .seconds(60))
        cover.hold()
        XCTAssertEqual(cover.milestone, Progress.start)
        cover.reached("dom")
        cover.reached("navigated")
        XCTAssertEqual(cover.milestone, "dom", "a late commit moved the bar backwards")
        cover.hold()
        XCTAssertEqual(cover.milestone, Progress.start)
    }
}
