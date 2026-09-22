import XCTest

@testable import Claw

/// Parity with `core/ui/motion.js` and the assertions in `core/test/motion.test.js`.
///
/// The minimum-visible-duration primitive is a pure computed contract rather than
/// a fixtures table, so this proves the SAME arithmetic the JS proves: the floor
/// is read from the spec (not a second copy), it is a real dwell longer than the
/// longest animation token, and `remainingVisibleMs`/`heldLongEnough` answer
/// exactly what the JS answers for the same inputs. If the two clients ever
/// disagree about how long a transient state is held, one of these fails.
final class MotionParityTests: XCTestCase {
    /// The spec's floor, read the way the app reads it, so a change to
    /// core/spec/tokens.json moves this expectation with it rather than freezing a
    /// literal here.
    private var floor: Int { NoticeTokens.minVisibleMs }

    /// A fixed instant to measure from, matching the JS test's `shownAt` of 1,000,000ms.
    private func at(_ ms: Int) -> Date { Date(timeIntervalSince1970: TimeInterval(ms) / 1000.0) }

    func testFloorComesFromTheSpecAndIsARealDwell() {
        // The constant is the spec's, not a number in the module: a second copy is
        // the drift this primitive exists to remove.
        XCTAssertEqual(Motion.minVisibleMs, NoticeTokens.minVisibleMs,
                       "Motion.minVisibleMs does not read the token spec's motion.minVisibleMs")
        // It is longer than the longest ANIMATION token: how long a thing STAYS
        // versus how it MOVES are different questions, and a floor shorter than a
        // single animation would be no floor at all. --duration-normal is 180ms.
        let normalMs = NoticeTokens.shape["--duration-normal"].flatMap { Double($0.replacingOccurrences(of: "ms", with: "")) } ?? 0
        XCTAssertGreaterThan(Double(Motion.minVisibleMs), normalMs,
                             "the visible floor is not longer than --duration-normal")
        // Below the span of a glance that reads a short sentence, it would be no floor.
        XCTAssertGreaterThanOrEqual(Motion.minVisibleMs, 400,
                                    "the visible floor is below the span of a glance that reads a short sentence")
    }

    func testRemainingOwesTheWholeFloorAtTheStartAndNothingPastIt() {
        let shownAt = at(1_000_000)
        // Shown this instant: the whole floor is still owed.
        XCTAssertEqual(Motion.remainingVisibleMs(shownAt: shownAt, minMs: 900, now: at(1_000_000)), 900)
        // Part-way through: exactly the remainder.
        XCTAssertEqual(Motion.remainingVisibleMs(shownAt: shownAt, minMs: 900, now: at(1_000_300)), 600)
        // At the floor and past it: nothing owed, never negative.
        XCTAssertEqual(Motion.remainingVisibleMs(shownAt: shownAt, minMs: 900, now: at(1_000_900)), 0)
        XCTAssertEqual(Motion.remainingVisibleMs(shownAt: shownAt, minMs: 900, now: at(1_005_000)), 0)
    }

    func testRemainingIsMeasuredFromWhenShownNotWhenWorkBegan() {
        // ★ The core of the rule: a check that took two seconds has shown nothing
        // for two seconds, so its answer, once drawn, is still owed the full floor.
        let startedAt = 1_000_000
        let shownAt = at(startedAt + 2000) // the answer only reached the screen here
        XCTAssertEqual(Motion.remainingVisibleMs(shownAt: shownAt, minMs: 900, now: shownAt), 900,
                       "the floor was consumed by work that happened before the state was on screen")
    }

    func testRemainingIsDefensiveRatherThanReturningAFlash() {
        let now = at(1_000_000)
        // A zero or negative floor is "no floor", so nothing is owed.
        XCTAssertEqual(Motion.remainingVisibleMs(shownAt: now, minMs: 0, now: now), 0)
        XCTAssertEqual(Motion.remainingVisibleMs(shownAt: now, minMs: -5, now: now), 0)
        // A now BEFORE shownAt (a clock that went backwards) owes the full floor
        // rather than a negative, so the safe failure is a state held too long.
        XCTAssertEqual(Motion.remainingVisibleMs(shownAt: at(1_000_500), minMs: 900, now: at(1_000_000)), 900)
    }

    func testHeldLongEnoughIsTheBooleanFormOfTheSameAnswer() {
        let shownAt = at(1_000_000)
        XCTAssertFalse(Motion.heldLongEnough(shownAt: shownAt, minMs: 900, now: at(1_000_000)))
        XCTAssertFalse(Motion.heldLongEnough(shownAt: shownAt, minMs: 900, now: at(1_000_899)))
        XCTAssertTrue(Motion.heldLongEnough(shownAt: shownAt, minMs: 900, now: at(1_000_900)))
        XCTAssertTrue(Motion.heldLongEnough(shownAt: shownAt, minMs: 900, now: at(1_001_500)))
    }
}
