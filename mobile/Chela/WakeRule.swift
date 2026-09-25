import Foundation
import Network

/// The wake and reconnect rule, read from `core/spec/wake.json` at runtime.
///
/// The desktop walks the same table through `core/wake.js`. This client only
/// REPORTS its events into it: scenePhase for sleep and wake, the network path
/// for a drop and its return, the page's socket for a missed heartbeat, and the
/// connection reaching `connected` for the render. What each event does is the
/// table's, so the two clients cannot disagree about it.
enum WakeRule {
    private struct Spec: Decodable {
        let initial: String
        let states: [String]
        let events: [String]
        let actions: [String]
        let platformEvents: [String: [String: [String]]]
        let transitions: [String: [String: [String]]]
    }

    static let decodedKeys: Set<String> = ["initial", "states", "events", "actions", "platformEvents", "transitions"]
    static let ignoredKeys: Set<String> = ["$comment"]

    private static let spec: Spec? = try? BundledSpec.load("wake", as: Spec.self)

    static var initial: String { spec?.initial ?? "awake" }

    /// One step. An unknown state or event changes nothing and does nothing, and
    /// an unbundled spec is the same: `BundledSpecTests` fails that build.
    static func step(_ state: String, _ event: String) -> (state: String, action: String) {
        guard let cell = spec?.transitions[state]?[event], cell.count == 2 else { return (state, "none") }
        return (cell[0], cell[1])
    }

    /// This platform's raw event name onto the rule's event, or nil.
    static func event(for raw: String) -> String? {
        guard let table = spec?.platformEvents["ios"] else { return nil }
        return table.first(where: { $0.value.contains(raw) })?.key
    }
}

/// Carries the rule's state and its actions for this client.
@MainActor
final class WakeMonitor: ObservableObject {
    private(set) var state: String = WakeRule.initial
    private var monitor: NWPathMonitor?
    private var lastSatisfied: Bool?
    private var lastInterfaces: [NWInterface.InterfaceType] = []

    /// What a `reconnect` does: a fresh load of the gateway page. Set by the view.
    var reconnect: () -> Void = {}

    /// Report a raw platform event. Returns the action taken, for the tests.
    @discardableResult
    func report(_ raw: String) -> String {
        guard let event = WakeRule.event(for: raw) else { return "none" }
        let next = WakeRule.step(state, event)
        if next.state != state || next.action != "none" {
            NSLog("[claw] wake: %@: %@ -> %@ (%@)", raw, state, next.state, next.action)
        }
        state = next.state
        if next.action == "reconnect" { reconnect() }
        // close and cover need nothing of their own here: iOS suspends the process
        // on background, and the page's own connecting phase is what the cover
        // follows. uncover is the connection reaching connected.
        return next.action
    }

    /// Watch the network path. Only a change is reported.
    func start() {
        guard monitor == nil else { return }
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            let kinds = [NWInterface.InterfaceType.wifi, .cellular, .wiredEthernet].filter { path.usesInterfaceType($0) }
            Task { @MainActor in
                guard let self else { return }
                defer { self.lastSatisfied = satisfied; self.lastInterfaces = kinds }
                guard let was = self.lastSatisfied else { return }
                if was != satisfied {
                    self.report(satisfied ? "NWPathMonitor:satisfied" : "NWPathMonitor:unsatisfied")
                } else if satisfied && kinds != self.lastInterfaces {
                    self.report("NWPathMonitor:interface-changed")
                }
            }
        }
        m.start(queue: DispatchQueue(label: "chela.wake.path"))
        monitor = m
    }
}
