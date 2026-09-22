import Foundation
import XCTest

@testable@testable import Chela

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
        let releaseOf: [ReleaseCase]
        let releaseCases: [Case]
    }

    private struct Case: Decodable {
        let name: String
        let a: String
        let b: String
        let compare: Int
    }

    private struct ReleaseCase: Decodable {
        let name: String
        let version: String
        let release: String?
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

    /// ★ The comparison an update check IS allowed to make: the release only.
    ///
    /// The test above pins `compare`, which ranks the build and commit tail. That
    /// is what a version IS, and it is NOT what decides an update: our dev tails
    /// carry build and commit information whose basis has changed, so ranking them
    /// inverted and the check quietly stopped offering builds. This is the rule
    /// that replaced it, and the same fixture is what makes the JS move with it.
    func testReleaseReproducesEveryFixture() throws {
        let fixture = try Fixtures.load("version", as: Fixture.self)
        XCTAssertFalse(fixture.releaseOf.isEmpty, "expected release fixtures")
        for testCase in fixture.releaseOf {
            XCTAssertEqual(Version.release(testCase.version), testCase.release, testCase.name)
        }
    }

    func testCompareReleaseIgnoresTheTailAndReproducesEveryFixtureInBothDirections() throws {
        let fixture = try Fixtures.load("version", as: Fixture.self)
        XCTAssertFalse(fixture.releaseCases.isEmpty, "expected release-comparison fixtures")
        for testCase in fixture.releaseCases {
            let forward = try Version.compareRelease(testCase.a, testCase.b)
            XCTAssertEqual(sign(forward), testCase.compare,
                           "\(testCase.name): compareRelease(\(testCase.a), \(testCase.b))")
            let reverse = try Version.compareRelease(testCase.b, testCase.a)
            XCTAssertEqual(sign(reverse), -testCase.compare,
                           "\(testCase.name): compareRelease(\(testCase.b), \(testCase.a)) must be the negation")
        }
        XCTAssertTrue(try Version.isNewerRelease("1.0.2-dev.1.1", than: "1.0.1-dev.195.6387043585"))
        XCTAssertFalse(try Version.isNewerRelease("1.0.1-dev.12.1758000000", than: "1.0.1-dev.195.6387043585"))
    }

    /// The tail that must never be ranked: the two comparisons, side by side, on
    /// the pair from the reported bug. This is why the update check may not use
    /// `compare`, and why `UpdateFeed.newerVersion` goes through `isNewerBuild`.
    func testTheTailIsNeverRanked() throws {
        let installed = "1.0.1-dev.195.6387043585"
        let published = "1.0.1-dev.12.1758000000"
        XCTAssertFalse(try Version.compare(published, installed) > 0,
                       "the retired comparator puts the published build behind us")
        XCTAssertEqual(try Version.compareRelease(published, installed), 0,
                       "by release they are the same version")
        XCTAssertEqual(Version.release(installed), "1.0.1")
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
