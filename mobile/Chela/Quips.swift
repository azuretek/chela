import Foundation

/// The loading screen's rotating lines, read from `core/spec/quips.json`.
///
/// The desktop computes the line in its main process (`core/quips.js`) and pushes
/// it to the shared loading page, because the page is sandboxed and draws only what
/// it is handed. This client hosts the same page (`LoadingSurface`) and hands it
/// the same line, computed the same way from the same file: `QuipsParityTests`
/// holds `quipAt` and `startAt` to the JS.
enum Quips {
    private struct Spec: Decodable {
        let rotateMs: Int
        let quips: [String]
    }

    static let decodedKeys: Set<String> = ["rotateMs", "quips"]

    private static let spec: Spec = (try? BundledSpec.load("quips", as: Spec.self)) ?? Spec(rotateMs: 3200, quips: [])

    static var all: [String] { spec.quips }
    static var rotateMs: Int { spec.rotateMs }

    /// The line at `step`, starting from `offset`, wrapping rather than stopping.
    static func quipAt(_ step: Double, offset: Int = 0) -> String? {
        let n = all.count
        guard n > 0 else { return nil }
        let raw = Int(step.rounded(.down)) + offset
        let i = ((raw % n) + n) % n
        return all[i]
    }

    /// Where to start, so two launches in a row do not open on the same line.
    static func startAt(seed: Double = Double.random(in: 0..<1)) -> Int {
        let n = all.count
        guard n > 0 else { return 0 }
        return Int((abs(seed) * Double(n)).rounded(.down)) % n
    }
}
