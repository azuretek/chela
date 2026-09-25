import XCTest
@testable import Chela

/// `Quips` against `core/quips.js`: the same file, the same wrap, the same start.
final class QuipsParityTests: XCTestCase {
    private struct Spec: Decodable { let rotateMs: Int; let quips: [String] }

    func testReadsTheSpec() throws {
        let spec = try BundledSpec.load("quips", as: Spec.self)
        XCTAssertEqual(Quips.all, spec.quips)
        XCTAssertEqual(Quips.rotateMs, spec.rotateMs)
        XCTAssertFalse(Quips.all.isEmpty)
    }

    func testQuipAtWrapsBothWaysLikeTheJS() {
        let n = Quips.all.count
        XCTAssertEqual(Quips.quipAt(0), Quips.all[0])
        XCTAssertEqual(Quips.quipAt(Double(n)), Quips.all[0], "the list wraps rather than stopping")
        XCTAssertEqual(Quips.quipAt(1.9), Quips.all[1], "a step is floored, as Math.floor does")
        XCTAssertEqual(Quips.quipAt(0, offset: -1), Quips.all[n - 1], "a negative index wraps from the end")
    }

    func testStartAtIsSeededLikeTheJS() {
        XCTAssertEqual(Quips.startAt(seed: 0), 0)
        XCTAssertEqual(Quips.startAt(seed: 0.999999), Quips.all.count - 1)
    }
}
