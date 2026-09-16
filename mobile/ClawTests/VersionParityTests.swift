import Foundation
import XCTest

@testable import Claw

/// Parity with `compare()`/`isNewer()` in `core/version.js`, proven
/// against the same golden fixture the JS side asserts
/// (`core/fixtures/version.json`, checked by `desktop/test/version.test.js`).
///
/// This is the contract that lets the phone's update check reach the same answer
/// as the desktop's updater without a second comparator: both reproduce these
/// pairs, in both directions, so a build the desktop would offer an update to is a
/// build the phone offers one to as well. Change the comparison, regenerate the
/// fixture, and this is what makes the Swift move with it.
final class VersionParityTests: XCTestCase {
    private struct Fixture: Decodable {
        let cases: [Case]
    }

    private struct Case: Decodable {
        let name: String
        let a: String
        let b: String
        let compare: Int
    }

    func testCompareReproducesEveryFixtureInBothDirections() throws {
        let fixture = try Fixtures.load("version", as: Fixture.self)
        XCTAssertFalse(fixture.cases.isEmpty, "expected version fixtures")

        for testCase in fixture.cases {
            let forward = try Version.compare(testCase.a, testCase.b)
            XCTAssertEqual(sign(forward), testCase.compare,
                           "\(testCase.name): compare(\(testCase.a), \(testCase.b))")
            // The reverse must be the exact negation, which is the property an
            // ordering has and a broken comparator most often lacks.
            let reverse = try Version.compare(testCase.b, testCase.a)
            XCTAssertEqual(sign(reverse), -testCase.compare,
                           "\(testCase.name): compare(\(testCase.b), \(testCase.a)) must be the negation")
        }
    }

    func testIsNewerIsCompareGreaterThanZero() throws {
        XCTAssertTrue(try Version.isNewer("1.0.1", than: "1.0.0"))
        XCTAssertFalse(try Version.isNewer("1.0.0", than: "1.0.1"))
        // Equal is not newer, which is the case the "absent when the feed matches"
        // proof rests on.
        XCTAssertFalse(try Version.isNewer("1.0.0", than: "1.0.0"))
        XCTAssertFalse(try Version.isNewer("1.0.1-dev.5", than: "1.0.1"),
                       "a dev build is not newer than its release")
        XCTAssertTrue(try Version.isNewer("1.0.1", than: "1.0.1-dev.5"),
                      "the release is newer than its dev build")
    }

    func testCompareThrowsOnAVersionItCannotRead() {
        // A feed that handed the check a value this cannot parse is a fault to
        // surface, not a silent "not newer" that would leave a real update
        // unnoticed. Same rule as the JS, which throws rather than sorting.
        XCTAssertThrowsError(try Version.compare("1.0", "1.0.0"))
        XCTAssertThrowsError(try Version.compare("1.0.0", "latest"))
    }

    private func sign(_ value: Int) -> Int {
        value == 0 ? 0 : (value < 0 ? -1 : 1)
    }
}
