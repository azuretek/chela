import Foundation

/// The number under the loading cover's progress bar, ported from
/// `core/progress.js` and reading `core/spec/progress.json` at runtime.
///
/// A gateway load reports no percentage. WebKit will tell you a navigation
/// started, that the document parsed, and that the load finished, and nothing at
/// all about the distance between them, so a bar driven only by those events
/// would sit still for four seconds and then jump, which reads as frozen.
///
/// So the milestones set the floor and the ceiling and time fills the gap: each
/// milestone has a share of the bar, and within one the number eases toward the
/// next milestone's floor without ever arriving, because arriving would promise
/// something that has not happened yet. That makes the number honest in the way
/// that matters. It can be behind, it can crawl, but it cannot claim a stage the
/// app has not reached, and 100 is reserved for a load that finished.
///
/// The values come from the bundled spec rather than from constants here, which is
/// the one pattern for every spec the app shares. `ProgressParityTests` proves
/// this port reproduces the golden fixtures in `core/fixtures/progress.json`
/// that `core/test/fixtures.test.js` asserts on the JS side, and
/// `BundledSpecTests` asserts the client decodes every key the file carries.
enum Progress {
    /// `core/spec/progress.json`, in the shape the file already has.
    private struct Spec: Decodable {
        let order: [String]
        let floor: [String: Int]
        let tauMs: Double
        let creep: Double
    }

    /// The top-level keys this decodes, asserted against the file by
    /// `BundledSpecTests`.
    static let decodedKeys: Set<String> = ["order", "floor", "tauMs", "creep"]

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(order: [], floor: [:], tauMs: 0, creep: 0)
        guard let spec = try? BundledSpec.load("progress", as: Spec.self), !spec.order.isEmpty else {
            return empty
        }
        return spec
    }

    /// Milestones, in the order a load reaches them.
    static var order: [String] { spec.order }

    /// The stage a load begins at, and the one that means it is over. Derived
    /// from the order rather than named twice, which is what the JS does too.
    static var start: String { spec.order.first ?? "start" }
    static var done: String { spec.order.last ?? "done" }

    /// Where each milestone puts the bar the instant it lands. Weighted by how
    /// long each stage typically takes rather than evenly: the wait for a host
    /// to answer is the long one, so it gets the widest band and the most room
    /// to move.
    static var floor: [String: Int] { spec.floor }

    /// How fast the creep inside a stage decays, in ms. One time constant covers
    /// about 63% of the remaining band, two about 86%.
    static var tauMs: Double { spec.tauMs }

    /// How much of the band to the next milestone the creep may take. Short of
    /// 1, so there is always a visible step when the real event lands.
    static var creep: Double { spec.creep }

    /// The percentage to show, as an integer.
    ///
    /// - Parameters:
    ///   - milestone: the furthest stage reached. An unknown one is treated as
    ///     the start, which is what the JS does with it.
    ///   - sinceMs: ms since that stage was reached.
    ///   - failed: the load stopped, so the bar freezes where it is.
    static func percent(milestone: String = start, sinceMs: Double = 0, failed: Bool = false) -> Int {
        let index = order.firstIndex(of: milestone) ?? 0
        let stage = order[index]
        let floorValue = floor[stage] ?? 0

        // A finished load is the only thing allowed to claim 100, and it is also
        // the moment the cover comes off, so it is answered before anything else.
        if stage == done { return 100 }

        // A failure holds the bar at the last stage it genuinely reached.
        // Creeping on afterwards would keep promising progress toward a load
        // that has stopped.
        if failed { return floorValue }

        // Safe to step forward: `done` is last and has already returned.
        let ceiling = floor[order[index + 1]] ?? 100
        let band = Double(ceiling - floorValue) * creep
        let eased = 1 - exp(-max(0, sinceMs) / tauMs)
        return min(max(Int((Double(floorValue) + band * eased).rounded()), 0), 99)
    }
}
