import XCTest

@testable@testable import Chela

/// Parity with `core/progress.js`, proven against the same golden fixtures the
/// JS side asserts in `core/test/fixtures.test.js`.
///
/// This is the mechanism the design leans on so the two clients cannot drift:
/// the fixtures are generated from the JS, both clients reproduce them, and so
/// "the phone and the desktop agree" is a thing that is checked rather than
/// hoped for. Changing a spec value means regenerating the fixtures, and this
/// test is what makes the Swift move with them.
final class ProgressParityTests: XCTestCase {
    func testPercentReproducesEveryFixture() throws {
        let fixture: ProgressFixture = try Fixtures.load("progress")
        // An empty case list would make the loop below vacuously green, which is
        // the failure mode a parity test can least afford.
        XCTAssertFalse(fixture.cases.isEmpty, "expected cases in core/fixtures/progress.json")

        for testCase in fixture.cases {
            let input = testCase.input
            let actual = Progress.percent(
                milestone: input.milestone ?? Progress.start,
                sinceMs: input.sinceMs ?? 0,
                failed: input.failed ?? false
            )
            XCTAssertEqual(
                actual,
                testCase.output,
                "percent(\(input)) should be \(testCase.output)"
            )
        }
    }
}

/// `core/fixtures/progress.json`: the milestone, the elapsed time, whether the
/// load failed, and the percentage the curve must produce.
struct ProgressFixture: Decodable {
    let cases: [FixtureCase]

    struct FixtureCase: Decodable {
        let input: Input
        let output: Int
    }

    /// Every field is optional because the fixtures include a bare `{}`, which
    /// is the call with no arguments at all.
    struct Input: Decodable, CustomStringConvertible {
        let milestone: String?
        let sinceMs: Double?
        let failed: Bool?

        var description: String {
            var parts: [String] = []
            if let milestone { parts.append("milestone: \(milestone)") }
            if let sinceMs { parts.append("sinceMs: \(sinceMs)") }
            if let failed { parts.append("failed: \(failed)") }
            return parts.joined(separator: ", ")
        }
    }
}
