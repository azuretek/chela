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
    static let retryInterval: TimeInterval = 3

    /// How long a socket must stay open, with no pairing close, before an open is
    /// taken as an approval and the screen clears. A pairing close arrives right
    /// after the open on every retry (the gateway opens the socket, then closes
    /// it 1008), so this window has only to outlast that gap. Kept well under the
    /// retry interval so a genuine approval clears the screen promptly, and long
    /// enough that the refusal that follows an unapproved open always lands first.
    static let confirmInterval: TimeInterval = 0.6

    private var retryTimer: Timer?
    private var confirmTimer: Timer?

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
        phase = next
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
        phase = next
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
        phase = Pairing.nextPhase(phase, .close(refusal))
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
        phase = Pairing.nextPhase(phase, .fail)
        refusal = nil
        stopRetry()
        stopConfirm()
    }

    // MARK: Auto-recovery timer

    /// Arm the reconnect timer if it is not already running. Idempotent, so a
    /// second pairing close does not stack a second timer.
    private func startRetry() {
        guard retryTimer == nil else { return }
        let timer = Timer(timeInterval: Self.retryInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        // Common mode so the timer still fires while a scroll or a gesture is
        // tracking, which a default-mode timer would pause.
        RunLoop.main.add(timer, forMode: .common)
        retryTimer = timer
    }

    private func stopRetry() {
        retryTimer?.invalidate()
        retryTimer = nil
    }

    // MARK: Settle-confirm timer

    /// Arm the settle timer for an unconfirmed open. Restarted rather than
    /// stacked, so a fresh open (a later retry that also opened before its close)
    /// resets the window rather than firing on the previous open's clock.
    private func startConfirm() {
        stopConfirm()
        let timer = Timer(timeInterval: Self.confirmInterval, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.confirmOpen() }
        }
        RunLoop.main.add(timer, forMode: .common)
        confirmTimer = timer
    }

    private func stopConfirm() {
        confirmTimer?.invalidate()
        confirmTimer = nil
    }

    /// The settle window elapsed with the socket still open: no pairing close
    /// cancelled it, so the open was an approval. Clear the screen. Guarded on
    /// `isPairing` so a late fire after some other transition does nothing.
    private func confirmOpen() {
        confirmTimer = nil
        guard isPairing else { return }
        phase = Pairing.nextPhase(phase, .confirm)
        refusal = nil
        stopRetry()
    }

    /// One reconnect beat: bump the counter the web view watches. Only while the
    /// screen is actually up, so a race where the timer fires once after the phase
    /// moved does not force a needless reload of a page that is already connected.
    private func tick() {
        guard isPairing else { stopRetry(); return }
        retryTick += 1
    }

    // No `deinit` invalidation: each timer's closure holds `self` weakly, so
    // neither can keep this object alive, and every phase that leaves the pairing
    // screen calls `stopRetry` and `stopConfirm`. A timer with no strong reference
    // back to its target is not a leak, and reaching a main-actor property from a
    // nonisolated deinit is what Swift 6 refuses here anyway.

    /// The command the operator runs on the gateway host for the current refusal.
    var approveCommand: String { Pairing.approveCommand(refusal?.requestId) }

    /// The one-line requirement for the current refusal.
    var requirement: String { Pairing.requirement(refusal?.reason ?? "not-paired") }
}
