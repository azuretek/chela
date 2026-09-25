import Foundation
import SwiftUI

/// The shared answer to "has the page painted", read from core/spec/render-ready.json.
///
/// The desktop runs the same probe through core/render-ready.js. This client has
/// no Swift copy of it: it bundles the spec and evaluates those bytes in the web
/// view, so the two clients cannot disagree about what "rendered" means.
enum RenderReady {
    private struct Spec: Decodable {
        let backstopMs: Int
        let probe: [String]
    }

    private static let spec: Spec? = try? BundledSpec.load("render-ready", as: Spec.self)

    /// The probe, an expression that evaluates to a Promise resolving once the
    /// page has painted content and that frame has been presented. Nil when the
    /// build did not bundle the spec, which RenderReadyParityTests fails on.
    static var probe: String? {
        guard let lines = spec?.probe, !lines.isEmpty else { return nil }
        return lines.joined(separator: "\n")
    }

    /// How long a cover is held for a page that never reports a paint.
    static var backstopMs: Int { spec?.backstopMs ?? 4000 }

    static let decodedKeys: Set<String> = ["backstopMs", "probe"]
    static let ignoredKeys: Set<String> = []
}

/// The loading cover over the gateway page, held until the page has PAINTED.
///
/// A finished load is not a page on screen: the Control UI builds itself after its
/// load event, so a page revealed on didFinish showed the reader an empty web view
/// first. The same gate as core/render-ready.js createCoverGate: hold() raises the
/// cover and voids every lift in flight, loaded() lifts once the probe settles or
/// the backstop fires, whichever is first, and only if nothing has held since.
@MainActor
final class PageCover: ObservableObject {
    @Published private(set) var isCovered = false
    /// Whether the load under the cover failed. The cover then STAYS, in the shared
    /// loading page's failed state with its Try again, which is what the desktop
    /// does (Abi, 2026-09-25): a failure is shown where the reader is looking,
    /// never by taking the cover down onto a page that did not load.
    @Published private(set) var failed = false
    /// The furthest load milestone reached, and when, for the shared progress curve
    /// (`Progress`, core/spec/progress.json). The navigation reports them.
    private(set) var milestone: String = Progress.start
    private(set) var milestoneAt = Date()
    /// Why the cover last came down: "rendered", "backstop", "probe-failed",
    /// "no-probe", or a failure's own reason. Read by the tests and the log.
    private(set) var lastLift: String?

    private let backstop: Duration
    private var generation = 0
    private var finished: Set<Int> = []

    /// The minimum-visible floor, for the one path that asks for it: a restart the
    /// reader asked for (Clear cache and refresh) is a state they are meant to SEE,
    /// and a page that paints while the sheets are still sliding away would lift the
    /// cover before it was ever on screen. `distantFuture` while the sheets go,
    /// then the floor from the moment the cover is revealed. Nil otherwise, so a
    /// launch or a reconnect lifts the moment its page has painted, as before.
    private var floorUntil: Date?
    /// A paint that arrived inside the floor, played when the floor ends unless a
    /// new hold has voided it by then.
    private var pending: (generation: Int, why: String)?
    private var pendingTask: Task<Void, Never>?

    init(backstop: Duration = .milliseconds(RenderReady.backstopMs)) {
        self.backstop = backstop
    }

    /// A load started: cover the page, and void any lift still on its way.
    func hold() {
        generation += 1
        pending = nil
        failed = false
        milestone = Progress.start
        milestoneAt = Date()
        isCovered = true
    }

    /// The load reached `name` (`navigated` on commit, `dom` on finish). Only
    /// ever forward, so a late event cannot move the bar backwards.
    func reached(_ name: String) {
        let order = Progress.order
        guard let next = order.firstIndex(of: name),
              next > (order.firstIndex(of: milestone) ?? -1) else { return }
        milestone = name
        milestoneAt = Date()
    }

    /// The load under the cover failed: keep the cover up in its failed state and
    /// void any lift in flight, so nothing reveals the page that did not load.
    /// Try again (or any new load) clears it through `hold()`.
    func fail(_ why: String) {
        generation += 1
        pending = nil
        floorUntil = nil
        failed = true
        isCovered = true
        lastLift = nil
        NSLog("[claw] the load under the cover failed (%@); holding it in its failed state", why)
    }

    /// Hold the cover up through any lift until `releaseFloor` is called. See
    /// `floorUntil`.
    func holdFloor() {
        floorUntil = .distantFuture
    }

    /// The sheets have gone and the cover is what the reader sees: keep it at
    /// least `ms` from now, then play any paint that arrived meanwhile.
    func releaseFloor(after ms: Int) {
        floorUntil = Date().addingTimeInterval(Double(max(0, ms)) / 1000)
        schedulePending()
    }

    /// The load finished. Lift once the page has painted, or at the backstop.
    func loaded(probe: @escaping @MainActor () async throws -> Void) {
        generation += 1
        let mine = generation
        Task { @MainActor [weak self, backstop] in
            try? await Task.sleep(for: backstop)
            self?.finish(mine, "backstop")
        }
        Task { @MainActor [weak self] in
            do {
                try await probe()
                self?.finish(mine, "rendered")
            } catch {
                self?.finish(mine, "probe-failed")
            }
        }
    }

    /// The load failed, and the notice says so: nothing is coming to paint, so
    /// the cover must not sit over the banner that explains why.
    func lift(_ why: String) {
        generation += 1
        finished.insert(generation)
        pending = nil
        floorUntil = nil
        failed = false
        isCovered = false
        lastLift = why
    }

    private func finish(_ mine: Int, _ why: String) {
        guard !finished.contains(mine) else { return }
        finished.insert(mine)
        guard mine == generation else { return }
        if let floorUntil, floorUntil > Date() {
            pending = (mine, why)
            schedulePending()
            return
        }
        reveal(why)
    }

    private func reveal(_ why: String) {
        floorUntil = nil
        isCovered = false
        lastLift = why
        if why != "rendered" {
            NSLog("[claw] lifting the loading cover on %@ rather than a painted page", why)
        }
    }

    private func schedulePending() {
        pendingTask?.cancel()
        guard let waiting = pending, let floorUntil, floorUntil != .distantFuture else { return }
        let wait = max(0, floorUntil.timeIntervalSinceNow)
        pendingTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(wait * 1000)))
            guard let self, !Task.isCancelled, let now = self.pending,
                  now.generation == waiting.generation, now.generation == self.generation else { return }
            self.pending = nil
            self.reveal(now.why)
        }
    }
}
