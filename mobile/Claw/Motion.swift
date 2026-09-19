import Foundation

/// The minimum-visible-duration primitive, as the thing that makes the rule hold.
///
/// This is the iOS half of `core/ui/motion.js`, ported so the phone honours the
/// same design-language floor the desktop does (`ui/CONVENTIONS.md`, the eighth
/// rule: "a transient state is held long enough to read"). It is clock-free on
/// purpose: it takes `now` and a `shownAt` and answers a duration, so the rule can
/// be exercised for every timing from one test run and shared by every surface
/// without any of them owning a clock.
///
/// THE FAULT THIS ANSWERS. A state that changes faster than a reader can read it
/// is a flash: it appears and is gone before the eye settles on it, which is worse
/// than not showing it, because the reader knows something happened and never
/// learned what. The answer is not to slow the WORK down; it is to floor how long
/// the state it produces STAYS on screen. The desktop applies it in its update
/// lane (`raiseAnswer` in `desktop/src/main.js`); this client applies it in
/// `NoticeBoard`, where a transient answer can replace another transient answer.
///
/// The floor value is the one owner's, `motion.minVisibleMs` in
/// `core/spec/tokens.json`, read here through `NoticeTokens` exactly as every
/// other token value is, so a change to the floor moves both clients from one
/// edit. `MotionParityTests` proves this port answers what `core/test/motion.test.js`
/// asserts of the JS.
enum Motion {
    /// ★ How long a transient state must stay on screen before it may be replaced,
    /// in milliseconds.
    ///
    /// Read from the token spec rather than a literal here, because it is a
    /// design-language constant every transient state floors itself against, and a
    /// second copy of it is the drift this primitive exists to remove. `NoticeTokens`
    /// owns the decode of the spec; this is the one place iOS names the value.
    ///
    /// 900ms, and the reasoning is about reading rather than taste: a transient
    /// state carries a short sentence a reader has to find, fixate and read, which
    /// runs to most of a second. It is far longer than the animation tokens (those
    /// govern how a thing MOVES, this governs how long it STAYS) and shorter than
    /// the answer TTL (a floor on the minimum is not a ceiling on the whole life).
    static let minVisibleMs: Int = NoticeTokens.minVisibleMs

    /// How much longer a transient state must remain before it may be replaced.
    ///
    /// Given when a state was shown and how long the floor is, it answers how many
    /// milliseconds are still owed. Zero once the floor is met, which is the
    /// caller's signal that a replacement may proceed now; a positive number is how
    /// long to hold before it does. A caller with something newer to show waits
    /// this long and then shows it; a caller with nothing newer ignores it.
    ///
    /// ★ Measured from when the state was SHOWN, never from when the work started:
    /// a check that took two seconds has already shown nothing for two seconds, so
    /// its answer, once drawn, is still owed the full floor. That is why `shownAt`
    /// is the argument and not `startedAt`.
    ///
    /// Defensive about its inputs, matching the JS: an unusable floor is "no floor"
    /// (nothing owed), so the failure mode is a state held too long rather than one
    /// that flashes.
    ///
    /// - Parameters:
    ///   - shownAt: when the transient state went on screen.
    ///   - minMs: the floor; `minVisibleMs` by default.
    ///   - now: the clock, injectable so the rule is testable.
    /// - Returns: milliseconds still owed, 0 once the floor is met.
    static func remainingVisibleMs(shownAt: Date, minMs: Int = minVisibleMs, now: Date = Date()) -> Int {
        let floor = minMs > 0 ? minMs : 0
        if floor == 0 { return 0 }
        let elapsed = Int((now.timeIntervalSince(shownAt) * 1000).rounded())
        if elapsed <= 0 { return floor }
        return max(0, floor - elapsed)
    }

    /// Whether a transient state shown at `shownAt` has been up long enough to
    /// replace. The boolean form of the function above, for a caller that only
    /// wants the yes/no and not the wait.
    static func heldLongEnough(shownAt: Date, minMs: Int = minVisibleMs, now: Date = Date()) -> Bool {
        remainingVisibleMs(shownAt: shownAt, minMs: minMs, now: now) == 0
    }
}
