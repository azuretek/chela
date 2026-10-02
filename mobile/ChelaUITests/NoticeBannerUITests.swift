import XCTest

/// The notice banner's controls, pressed the way a person presses them.
///
/// Abi, 2026-09-23: "banners on iOS still cant be interacted with, X doesnt work
/// and neither does the read all button". The banner lives in a window above the
/// app that claims a touch only inside the box its cards reported, so a box
/// reported in the wrong coordinate space makes a control that draws and cannot
/// be pressed, and nothing short of a real tap sees that. These taps go through
/// UIKit's own hit test, the same path a finger takes.
///
/// The app is launched with `-claw-seed-notices`, the debug seed of one notice per
/// tone plus the download whose X clears it (NoticeBoard.live()).
@MainActor
final class NoticeBannerUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-claw-seed-notices"]
        app.launch()
    }

    // By label: the controls carry their spec label as their accessibility label.
    private func buttons(_ label: String) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "label == %@", label))
    }
    // Scoped to the banner by identifier, then by label: "Clear" alone can match
    // a control on the page underneath, which is what made a cleared download
    // look like it was still there.
    private var banner: XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "notice-dismiss-"))
    }
    private var sweep: XCUIElement { app.buttons["notice-sweep"] }
    private var readButtons: XCUIElementQuery { banner.matching(NSPredicate(format: "label == %@", "Mark read")) }
    private var clearButtons: XCUIElementQuery { banner.matching(NSPredicate(format: "label == %@", "Clear")) }


    // Each evaluation of `count` is a fresh accessibility snapshot of the app, and on
    // the iOS 26 CI leg one snapshot of this hierarchy took 2 to 4.5 seconds, longer
    // again when the banner's window was torn down mid-snapshot and XCTest retried it.
    // A 5 second wait left room for one evaluation, so a banner that had cleared still
    // failed the wait. 20 seconds admits several, and a banner that never clears fails
    // the same way it always did.
    private static let countTimeout: TimeInterval = 20

    private func waitForCount(_ query: XCUIElementQuery, _ expected: Int, _ message: String) {
        let predicate = NSPredicate(format: "count == %d", expected)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: query)
        let result = XCTWaiter().wait(for: [expectation], timeout: Self.countTimeout)
        // Read after the wait has ended, so it is the count now, not the one the wait last saw.
        XCTAssertEqual(result, .completed,
                       "\(message): expected \(expected) within \(Int(Self.countTimeout))s, "
                       + "and \(query.count) once the wait had ended")
    }

    func testTheXOnACardMarksItRead() {
        XCTAssertTrue(sweep.waitForExistence(timeout: 10), "the seeded banner never drew")
        let before = readButtons.count
        XCTAssertGreaterThan(before, 0, "no card offers a Mark read X")
        readButtons.element(boundBy: 0).tap()
        waitForCount(readButtons, before - 1, "tapping the first card's X did not take the card away")
    }

    func testTheXOnTheDownloadClearsIt() {
        XCTAssertTrue(sweep.waitForExistence(timeout: 10), "the seeded banner never drew")
        XCTAssertEqual(clearButtons.count, 1, "the download card does not offer its Clear X")
        XCTAssertEqual(sweep.label, "Mark all read")
        clearButtons.element(boundBy: 0).tap()
        waitForCount(clearButtons, 0, "tapping the download's X did not clear it")
    }

    func testMarkAllReadTakesTheWholeBannerAway() {
        XCTAssertTrue(sweep.waitForExistence(timeout: 10), "the seeded banner never drew")
        sweep.tap()
        waitForCount(readButtons, 0, "Mark all read left cards on the banner")
        waitForCount(clearButtons, 0, "Mark all read left the download on the banner")
        XCTAssertFalse(sweep.exists, "Mark all read is still offered with nothing left to read")
    }
}
