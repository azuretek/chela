import Combine
import Foundation

/// Device pairing, ported from `core/pairing.js`.
///
/// The gateway holds a second gate after the token check: a new device is not
/// paired on sight, an operator has to approve it. A device that passed auth but
/// is not approved is refused at the WebSocket with the policy close code 1008
/// and a reason of the shape `pairing required: <requirement> (requestId: <id>)`.
/// This client hosts the Control UI in a web view, and the PAGE opens that socket,
/// so the refusal is an event inside the page rather than a native navigation
/// failure: the HTML loaded fine, so `didFinishNavigation` already fired and the
/// web view thinks it connected. The observer script (read from the bundled spec)
/// watches the page's own socket and posts the pairing close out; this type reads
/// that report into a state a SwiftUI screen draws.
///
/// **The split mirrors `NativeControlAuth`, deliberately.** The parser rules (the
/// policy code, the reason substrings, the requestId pattern, the phase reducer)
/// are Swift constants here, proven against `core/fixtures/pairing.json` by
/// `PairingParityTests`, which is what a parity test can do for a value. The one
/// thing that is NOT ported is the observer script: a script mirrored into Swift
/// is a second copy of it, which is the fork the shared file exists to prevent,
/// so it is read from the bundled `pairing.json` and installed through a
/// `WKUserScript`. The copy the screen shows is read from that spec too, so both
/// clients say the same thing.
///
/// What is deliberately NOT collapsed: an auth failure and a network drop. Those
/// are different states with different messaging, raised by `NoticeBoard` from the
/// reason the OS gave, and a 1008 close whose reason is not a pairing reason stays
/// one of those rather than becoming a pairing screen.
enum Pairing {
    // MARK: - The spec

    /// `core/spec/pairing.json`, in the shape the file already has.
    private struct Spec: Decodable {
        let phases: Phases
        let policyCloseCode: Int
        /// Where a pairing close sends the reader. One owner: `routing` in
        /// core/spec/pairing.json, read here exactly as the parser rules are, so
        /// the two clients route one event the same way.
        let routing: Routing
        /// The cadence both clients keep. One owner: `timing` in
        /// core/spec/pairing.json, which `core/pairing.js` exports as
        /// `RETRY_SECONDS`/`CONFIRM_SECONDS` for the JS half. Read here rather
        /// than kept as two numbers, because two copies of a cadence drift the
        /// first time one is tuned and the symptom is one client flickering
        /// where the other holds still.
        let timing: Timing
        let reasonSubstrings: [String: String]
        let requestIdPattern: String
        let requestIdInReason: String
        let requirements: [String: String]
        let copy: Copy
        let global: String
        let messageName: String
        let hook: [String]

        struct Phases: Decodable {
            let connecting: String
            let pairingRequired: String
            let authenticated: String
            let failed: String
        }

        struct Routing: Decodable {
            let pairingScreen: String
            let settingsGateways: String
            let settingsTab: String
        }

        /// Seconds, both of them, exactly as the spec writes them.
        struct Timing: Decodable {
            let retrySeconds: Double
            let confirmSeconds: Double
        }
    }

    /// The copy the pairing screen shows, decoded straight from the spec. One
    /// owner: the screen reads these fields and nothing mirrors them, so a field
    /// added to `spec/pairing.json` is added here once and reaches the screen.
    struct Copy: Decodable {
        let title: String
        let body: String
        let commandLabel: String
        let commandWithId: String
        let commandNoId: String
        let requestIdLabel: String
        let deviceIdLabel: String
        let waiting: String
        let cannotRunHere: String
        let docsHref: String
    }

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(
            phases: .init(connecting: "connecting", pairingRequired: "pairing-required", authenticated: "authenticated", failed: "failed"),
            policyCloseCode: 0,
            routing: .init(pairingScreen: "", settingsGateways: "", settingsTab: ""),
            // Zero, because nothing was read. A spec that cannot be decoded
            // cannot describe a cadence either, and `loadSpec` already refuses
            // one, so this is the broken-build case rather than a default: see
            // `startRetry` and `startConfirm`, which refuse to arm on a
            // non-positive interval rather than spinning.
            timing: .init(retrySeconds: 0, confirmSeconds: 0),
            reasonSubstrings: [:],
            requestIdPattern: "",
            requestIdInReason: "",
            requirements: [:],
            copy: .init(
                title: "", body: "", commandLabel: "", commandWithId: "", commandNoId: "",
                requestIdLabel: "", deviceIdLabel: "", waiting: "", cannotRunHere: "", docsHref: ""
            ),
            global: "", messageName: "", hook: []
        )
        guard let url = Bundle.main.url(forResource: "pairing", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let spec = try? JSONDecoder().decode(Spec.self, from: data),
              spec.policyCloseCode != 0,
              !spec.hook.isEmpty
        else {
            // A build that did not bundle the spec cannot observe a pairing close
            // and cannot draw the screen. It reports nothing rather than something
            // invented, and `PairingParityTests` turns that into a failing build
            // rather than a quiet absence in the field.
            return empty
        }
        return spec
    }

    // MARK: - Constants, from the spec

    /// The connection phases every client names the same way.
    enum Phase: String {
        case connecting
        case pairingRequired = "pairing-required"
        case authenticated
        case failed
    }

    /// The WebSocket close code the gateway uses for a policy refusal.
    static var policyCloseCode: Int { spec.policyCloseCode }

    /// How long between reconnect attempts while pairing. The spec's, not a
    /// number kept here: `timing.retrySeconds` is the one owner, and
    /// `PairingParityTests` asserts this equals it.
    static var retrySeconds: TimeInterval { spec.timing.retrySeconds }

    /// How long an open must survive, with no pairing close, before it counts as
    /// the approval and the screen comes down. The spec's, for the same reason.
    static var confirmSeconds: TimeInterval { spec.timing.confirmSeconds }

    /// The message-handler name the observer posts to, which the web view registers.
    static var messageName: String { spec.messageName }

    /// The global the observer falls back to when no handler is registered.
    static var global: String { spec.global }

    /// The copy the pairing screen shows, read from the spec so both clients agree.
    static var copy: Copy { spec.copy }

    /// The reason keys, in the order the parser tries them. The spec's order is the
    /// tried order, so an upgrade phrasing is not swallowed by the broader match.
    private static var reasonOrder: [String] {
        // A JSON object has no guaranteed key order, so the order the parser
        // depends on is fixed here rather than read from the decoded dictionary.
        // Upgrades first, then the general `pairing required`. Pinned by a parity
        // test against the spec's own documented order.
        ["role-upgrade", "scope-upgrade", "metadata-upgrade", "not-paired"]
    }

    // MARK: - The parser

    /// What a pairing close carries: which reason, and the id the operator matches.
    struct Refusal: Equatable {
        let reason: String
        let requestId: String?
    }

    /// Pull a requestId out of a close reason, or nil.
    ///
    /// Held to the spec's id pattern, so a malformed reason cannot put arbitrary
    /// text on a screen the way an unchecked capture would.
    static func readRequestId(_ reason: String?) -> String? {
        guard let reason else { return nil }
        guard let inReason = try? NSRegularExpression(pattern: spec.requestIdInReason, options: [.caseInsensitive]),
              let pattern = try? NSRegularExpression(pattern: spec.requestIdPattern)
        else { return nil }
        let range = NSRange(reason.startIndex..<reason.endIndex, in: reason)
        guard let match = inReason.firstMatch(in: reason, range: range),
              match.numberOfRanges >= 2,
              let captured = Range(match.range(at: 1), in: reason)
        else { return nil }
        let candidate = String(reason[captured])
        let candidateRange = NSRange(candidate.startIndex..<candidate.endIndex, in: candidate)
        return pattern.firstMatch(in: candidate, range: candidateRange) != nil ? candidate : nil
    }

    /// Read a WebSocket close into a pairing refusal, or nil when it is not pairing.
    ///
    /// The two guards are both load-bearing: 1008 is a general policy code, so
    /// pairing is code AND a pairing reason. A 1008 with any other reason, and a
    /// close on any other code, are left to the caller as an ordinary failure,
    /// which is a different state with different copy.
    static func readPairingClose(code: Int?, reason: String?) -> Refusal? {
        guard code == spec.policyCloseCode else { return nil }
        let text = (reason ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !text.isEmpty else { return nil }
        for key in reasonOrder {
            guard let substring = spec.reasonSubstrings[key] else { continue }
            if text.contains(substring) {
                return Refusal(reason: key, requestId: readRequestId(reason))
            }
        }
        return nil
    }

    /// A pairing-screen event, mirroring `core/pairing.js`'s reducer input.
    enum Event {
        case connect
        case open
        case confirm
        case close(Refusal?)
        case fail
    }

    /// The next phase, given the phase now and what just happened.
    ///
    /// A `close` that is not pairing is an ordinary failure, kept distinct.
    ///
    /// A `connect` from `pairing-required` HOLDS pairing-required rather than
    /// dropping to connecting. This is the anti-flap rule, ported from
    /// `core/pairing.js` and proven against the shared fixtures: a retry attempt
    /// while the screen is up must not pull the visible state off pairing, or the
    /// screen flashes once per retry. The device stays unapproved until an open is
    /// confirmed, and the fresh attempt happens underneath the overlay. From any
    /// other phase a `connect` is still `connecting`, the first-connect case.
    ///
    /// An `open` from `pairing-required` HOLDS the screen too, and this is the
    /// anti-FLICKER rule ported from the same reducer. A 1008 pairing close is
    /// deliverable only after a WebSocket handshake completes, so the gateway
    /// opens the socket and then closes it 1008 on every retry: the page's socket
    /// fires `open` before the pairing close. Clearing the screen on that `open`
    /// tore the overlay away for the gap between open and close, once per retry,
    /// which exposed the reloading page underneath and was the flicker. So an
    /// unconfirmed open holds, and only a `confirm` (an open that survived the
    /// settle window without a pairing close) clears the screen, which is
    /// auto-recovery. From any other phase an `open` is authenticated at once,
    /// because there is no pairing screen to protect, and a `confirm` without a
    /// held open changes nothing.
    static func nextPhase(_ phase: Phase, _ event: Event) -> Phase {
        switch event {
        case .connect: return phase == .pairingRequired ? .pairingRequired : .connecting
        case .open: return phase == .pairingRequired ? .pairingRequired : .authenticated
        case .confirm: return phase == .pairingRequired ? .authenticated : phase
        case .close(let refusal): return refusal != nil ? .pairingRequired : .failed
        case .fail: return .failed
        }
    }

    /// Where a pairing close sends the reader.
    ///
    /// The port of `pairingRoute()` in `core/pairing.js`, proven against the same
    /// fixture cases by `PairingParityTests`. A first connection is a setup
    /// problem and the pairing screen is the whole answer; the SAME close arriving
    /// at a session that had already been approved and was working is a
    /// revocation, which wants the settings surface on the gateways tab, because
    /// the first question there is which gateway this client is even pointed at.
    static func route(fromPhase: Phase, toPhase: Phase = .pairingRequired) -> String? {
        guard toPhase == .pairingRequired else { return nil }
        return fromPhase == .authenticated ? spec.routing.settingsGateways : spec.routing.pairingScreen
    }

    /// The two route names, so a caller compares against the spec rather than a
    /// literal of its own.
    static var routePairingScreen: String { spec.routing.pairingScreen }
    static var routeSettingsGateways: String { spec.routing.settingsGateways }
    /// The tab the settings route names, for the surface that has tabs.
    static var routeSettingsTab: String { spec.routing.settingsTab }

    /// The approve command to show, built from the requestId. The real instruction
    /// the gateway and the Control UI give, reflected rather than invented: the
    /// exact command with an id, the `--latest` form without one.
    static func approveCommand(_ requestId: String?) -> String {
        guard let requestId,
              let pattern = try? NSRegularExpression(pattern: spec.requestIdPattern) else {
            return spec.copy.commandNoId
        }
        let range = NSRange(requestId.startIndex..<requestId.endIndex, in: requestId)
        let valid = pattern.firstMatch(in: requestId, range: range) != nil
        return valid ? spec.copy.commandWithId.replacingOccurrences(of: "{requestId}", with: requestId) : spec.copy.commandNoId
    }

    /// The requirement sentence for a pairing reason, with a safe default.
    static func requirement(_ reason: String) -> String {
        spec.requirements[reason] ?? spec.requirements["not-paired"] ?? ""
    }

    /// Whether a reason is one the contract knows, distinct from `requirement`,
    /// which always answers with a fallback. A bridge uses this to narrow an
    /// untrusted reason to a known one rather than show a fallback for a typo.
    static func isKnownReason(_ reason: String) -> Bool {
        spec.reasonSubstrings[reason] != nil
    }

    // MARK: - The injected observer

    /// The observer script, exactly as `core/spec/pairing.json` holds it. The
    /// desktop's web contents run these same bytes; this client installs them
    /// through a `WKUserScript`.
    static var observerScript: String { spec.hook.joined(separator: "\n") }
}

/// The timers a `PairingState` runs on, injected.
///
/// The same seam `createState` in `desktop/src/pairing.js` has: its `schedule`
/// and `cancel` default to `setTimeout`/`clearTimeout`, and its tests hand in a
/// clock with no time in it (`fakeClock()` in `desktop/test/pairing.test.js`).
/// This port did not have one, and that is what made its two settle-window
/// tests wrong rather than merely slow.
///
/// The rule those tests pin is about a DURATION, so a test that proves it through
/// the real clock is not proving the rule, it is racing everything else the main
/// run loop is doing. Measured on 2026-09-17, all three failures on the iOS 27
/// leg: the runner starved the main thread past both deadlines, the assertion was
/// evaluated before the settle timer's work had been delivered, and a settle
/// window that clears the screen correctly was reported as keeping it up. The
/// sibling test lost the same race the other way, its expectation never
/// fulfilled inside its own timeout.
///
/// A `Timer` and a main-queue deadline are two unsynchronised deliveries to the
/// same thread: with the thread starved, a 0.9s block can run before a 0.6s timer
/// has been serviced, and the timer's own hop adds one more turn of the queue on
/// top of that. Injection removes the race by removing the clock, which is what
/// the desktop has always done.
struct PairingClock: Sendable {
    /// A pending callback, so it can be taken away again.
    final class Handle {
        private let onCancel: @MainActor () -> Void

        init(onCancel: @escaping @MainActor () -> Void) {
            self.onCancel = onCancel
        }

        @MainActor func cancel() { onCancel() }
    }

    /// Run `body` once, `seconds` from now.
    let schedule: @MainActor (TimeInterval, @escaping @MainActor () -> Void) -> Handle

    /// Take a pending callback away. Idempotent, like `clearTimeout`.
    let cancel: @MainActor (Handle) -> Void
}

extension PairingClock {
    /// The real clock: a one-shot `Timer` on the main run loop, in common mode so
    /// a scroll or a gesture cannot pause a cadence the gateway is waiting on.
    ///
    /// The callback lands on the main actor directly rather than through another
    /// `Task` hop, which is both closer to the desktop's `setTimeout` and the
    /// right thing for a window that is measuring elapsed time: a hop is one more
    /// turn of the main queue between the deadline and the work it was for. A
    /// timer added to `RunLoop.main` fires on the main thread, so re-entering the
    /// main actor from it is not a guess.
    static let live = PairingClock(
        schedule: { seconds, body in
            let timer = Timer(timeInterval: seconds, repeats: false) { _ in
                MainActor.assumeIsolated { body() }
            }
            RunLoop.main.add(timer, forMode: .common)
            return Handle { timer.invalidate() }
        },
        cancel: { $0.cancel() }
    )
}

/// The live pairing state a SwiftUI screen observes.
///
/// One per web view, held by `ContentView` and fed by the observer's message
/// handler. It holds the current phase and, while pairing, the refusal that
/// names the reason and the requestId. The screen reads `isPairing` and the
/// derived copy; the web view reads nothing back, it only reports.
@MainActor
final class PairingState: ObservableObject {
    @Published private(set) var phase: Pairing.Phase = .connecting
    @Published private(set) var refusal: Pairing.Refusal?

    /// Where this stay in pairing-required should send the reader, or nil when
    /// there is no pairing state at all. Published as its own value rather than
    /// derived by the view, because the view would have to remember the phase the
    /// wait started from to derive it, and the one place that knows is the move
    /// that entered the state.
    @Published private(set) var route: String?

    /// The phase the current stay in pairing-required was entered from. Recorded
    /// only on an entry: a retry, or a repeat close, must not overwrite the phase
    /// the wait actually started from, or a revocation would start reporting
    /// itself as a first connection a few seconds in.
    private var enteredFrom: Pairing.Phase = .connecting

    /// A monotonic counter the web view watches to know it should reload.
    ///
    /// Auto-recovery needs a fresh connect attempt after the device is approved,
    /// and the page's own socket retry cannot be relied on to make one: observed
    /// against the live gateway on 2026-09-16, the Control UI stopped reattaching
    /// its socket a few seconds after the pairing close, so an approval that
    /// landed afterwards produced no reconnect and the screen stayed up. So the
    /// native layer drives the retry: while pairing, this counter is bumped on a
    /// sane cadence, and `WebView` reloads the page each time it changes, which
    /// re-runs the page's OWN connect rather than reimplementing it. The moment
    /// one of those attempts opens a socket that STAYS open, the observer reports
    /// `open` and, once it survives the settle window, the screen comes down. See
    /// `opened` for why a bare open is not enough.
    @Published private(set) var retryTick: Int = 0

    /// How long between reconnect attempts while pairing. A few seconds: long
    /// enough not to hammer a gateway that is deliberately refusing this device,
    /// short enough that an approval reaches the user quickly. An operator
    /// approving a device is a human action, so a sub-second cadence would buy
    /// nothing but load.
    ///
    /// The SPEC's value, not a number kept here. Two clients with two copies of a
    /// cadence drift the first time one is tuned, and the visible symptom is one
    /// client flickering where the other holds still, so this reads the same
    /// `timing` block `core/pairing.js` exports for the desktop and
    /// `PairingParityTests` asserts it still matches.
    static var retryInterval: TimeInterval { Pairing.retrySeconds }

    /// How long a socket must stay open, with no pairing close, before an open is
    /// taken as an approval and the screen clears. A pairing close arrives right
    /// after the open on every retry (the gateway opens the socket, then closes
    /// it 1008), so this window has only to outlast that gap. Kept well under the
    /// retry interval so a genuine approval clears the screen promptly, and long
    /// enough that the refusal that follows an unapproved open always lands first.
    ///
    /// The spec's, for the same one-owner reason as `retryInterval`.
    static var confirmInterval: TimeInterval { Pairing.confirmSeconds }

    /// Where this state's two timers go. Injected so a test can prove the settle
    /// window with no clock in the room, which is the arrangement the desktop has
    /// had since `createState` was written. See `PairingClock`.
    private let clock: PairingClock
    private var retryHandle: PairingClock.Handle?
    private var confirmHandle: PairingClock.Handle?

    /// A state driven by the real main run loop unless a caller says otherwise.
    init(clock: PairingClock = .live) {
        self.clock = clock
    }

    /// Apply a move, recording the entry and the route it produces.
    ///
    /// One place, so `route` cannot go stale: every phase change in this object
    /// goes through here, and the route is recomputed from the shared rule rather
    /// than set by hand at each call site.
    private func move(to next: Pairing.Phase) {
        if next == .pairingRequired && phase != .pairingRequired { enteredFrom = phase }
        phase = next
        route = Pairing.route(fromPhase: enteredFrom, toPhase: next)
    }

    /// Whether the pairing screen should be up.
    var isPairing: Bool { phase == .pairingRequired }

    /// A connect attempt is starting. Two cases, and the reducer decides which.
    ///
    /// A FIRST connect (from any phase but pairing-required) moves to connecting,
    /// and any earlier refusal is no longer the current truth, so it is cleared
    /// and the retry timer is stopped because a fresh load is in flight.
    ///
    /// A RETRY connect while the pairing screen is up (from pairing-required)
    /// HOLDS pairing-required, which is the anti-flap rule the shared reducer now
    /// owns: the device is still unapproved, so the screen must not drop to
    /// connecting and flash. In that case the refusal is KEPT (the command and
    /// requestId on screen do not change) and the retry timer is LEFT RUNNING
    /// (the next beat is still needed until an approval lands). The fresh attempt
    /// happens underneath the overlay, which is full-cover, so nothing on screen
    /// moves.
    func connecting() {
        let next = Pairing.nextPhase(phase, .connect)
        move(to: next)
        if next != .pairingRequired {
            refusal = nil
            stopRetry()
        }
        // Else: hold the screen. Refusal and the retry timer are left as they are.
    }

    /// The gateway socket opened. Two cases, and the reducer decides which.
    ///
    /// A FIRST open (from any phase but pairing-required) is a genuine connect:
    /// it moves to authenticated at once, the refusal is cleared, and both timers
    /// stop. There is no pairing screen up to protect.
    ///
    /// An open while the pairing screen is up (from pairing-required) is
    /// UNCONFIRMED, and this is the anti-flicker rule. A 1008 pairing close is
    /// deliverable only after a WebSocket handshake completes, so on every retry
    /// the gateway opens the socket and then closes it 1008: this `opened` fires
    /// before the pairing close lands. Clearing the screen here tore the overlay
    /// away for that gap, once per retry, exposing the reloading page underneath,
    /// which was the flicker. So the screen HOLDS, and a settle timer is armed:
    /// if the socket is still open when it fires (no pairing close cancelled it),
    /// the open is an approval and `confirm` clears the screen; if a pairing close
    /// arrives first, `closed` cancels the settle timer and nothing on screen ever
    /// moved. The retry timer is left running so the next beat still comes if this
    /// open turns out to be another refusal.
    func opened() {
        let next = Pairing.nextPhase(phase, .open)
        move(to: next)
        if next == .pairingRequired {
            // Unconfirmed: hold the screen and wait for the settle window. Refusal
            // and the retry timer are left as they are; the command on screen does
            // not change while we wait to see if this open survives.
            startConfirm()
        } else {
            refusal = nil
            stopRetry()
            stopConfirm()
        }
    }

    /// The gateway socket closed. A pairing close holds (or shows) the pairing
    /// screen and carries the refusal, and arms the retry timer so a later
    /// approval is picked up without a relaunch; it also cancels any pending
    /// settle timer, because this close is the proof that the last open was not an
    /// approval, so the screen must not clear. Any other close is an ordinary
    /// failure, whose sentence is raised by `NoticeBoard` and not here.
    func closed(_ refusal: Pairing.Refusal?) {
        // A pairing close means the open that may have preceded it was not an
        // approval. Cancel the settle timer first, so a confirm cannot race in
        // after the refusal and clear a screen that should stay up.
        stopConfirm()
        move(to: Pairing.nextPhase(phase, .close(refusal)))
        self.refusal = refusal
        if phase == .pairingRequired {
            startRetry()
        } else {
            stopRetry()
        }
    }

    /// The load itself failed (host unreachable, page did not load). Distinct from
    /// pairing on purpose: this is the network state, not the approval one, so the
    /// pairing retry does not run for it; the web view's own reload path handles a
    /// dead page.
    func failed() {
        move(to: Pairing.nextPhase(phase, .fail))
        refusal = nil
        stopRetry()
        stopConfirm()
    }

    // MARK: Auto-recovery timer

    /// Arm the reconnect cadence if it is not already running. Idempotent, so a
    /// second pairing close does not stack a second beat.
    ///
    /// A recursive one-shot rather than a repeating timer, which is what
    /// `createState` does and what makes the cadence drivable with no clock: each
    /// beat re-arms the next only if it is still the pairing state's to run. The
    /// non-positive guard is the broken-build case (a spec that would not decode,
    /// see `loadSpec`), where arming would spin; refusing to arm is the safe
    /// direction, and `PairingParityTests` is what turns that build red.
    /// Reload the gateway page now, through the same leg the retry beat uses, so
    /// the token handoff and the device seed are reinstalled on the fresh load.
    /// The wake rule's reconnect: see `WakeMonitor`.
    func reconnectNow() {
        retryTick += 1
    }

    private func startRetry() {
        guard retryHandle == nil, Self.retryInterval > 0 else { return }
        retryHandle = clock.schedule(Self.retryInterval) { [weak self] in
            guard let self else { return }
            self.retryHandle = nil
            guard self.isPairing else { return }
            self.retryTick += 1
            self.startRetry()
        }
    }

    private func stopRetry() {
        guard let handle = retryHandle else { return }
        clock.cancel(handle)
        retryHandle = nil
    }

    // MARK: Settle-confirm timer

    /// Arm the settle window for an unconfirmed open. Restarted rather than
    /// stacked, so a fresh open (a later retry that also opened before its close)
    /// resets the window rather than firing on the previous open's clock.
    private func startConfirm() {
        stopConfirm()
        guard Self.confirmInterval > 0 else { return }
        confirmHandle = clock.schedule(Self.confirmInterval) { [weak self] in
            guard let self else { return }
            self.confirmHandle = nil
            self.confirmOpen()
        }
    }

    private func stopConfirm() {
        guard let handle = confirmHandle else { return }
        clock.cancel(handle)
        confirmHandle = nil
    }

    /// The settle window elapsed with the socket still open: no pairing close
    /// cancelled it, so the open was an approval. Clear the screen. Guarded on
    /// `isPairing` so a late fire after some other transition does nothing.
    private func confirmOpen() {
        confirmHandle = nil
        guard isPairing else { return }
        move(to: Pairing.nextPhase(phase, .confirm))
        refusal = nil
        stopRetry()
    }

    // No `deinit` invalidation: the clock owns its pending callbacks, each beat
    // and each settle holds this object weakly, and every phase that leaves the
    // pairing screen calls `stopRetry` and `stopConfirm`, so nothing is left
    // armed on a state nobody holds. Reaching a main-actor property from a
    // nonisolated deinit is what Swift 6 refuses here anyway.

    /// The command the operator runs on the gateway host for the current refusal.
    var approveCommand: String { Pairing.approveCommand(refusal?.requestId) }

    /// The one-line requirement for the current refusal.
    var requirement: String { Pairing.requirement(refusal?.reason ?? "not-paired") }
}
