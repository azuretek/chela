import Combine
import Foundation

/// How the app's one connection is going, for the settings page's gateway rows.
///
/// A small state machine rather than a flag, because the row has to say five
/// different things and one of them is "still trying": the settings page shows a
/// badge per gateway and disables the button under the one it is already
/// connecting to, exactly as the desktop's page does.
///
/// **The words come from `core/connection.js`, deliberately, and that is a mirror
/// rather than a shared file.** The desktop has that mapping as JS and this client
/// has no port of it, because the only thing it needs is the badge: the sentence
/// explaining a failure is raised by `NoticeBoard`, which is the client's own and
/// reads the reason the OS gave. So these five labels are the one part of the
/// desktop's status vocabulary this client repeats, and they are repeated here,
/// in one place, with the case they came from named. `ConnectionStateTests` pins
/// them against the strings in that file, and the pending pair against
/// `core/spec/connection.json`, so a reword there fails here.
///
/// **`pending` is the phase that was missing, and its absence was a lie on
/// screen**: a device the gateway has not approved still gets served the page, so
/// the load succeeded and the row said "Connected" while the gateway was refusing
/// the session behind it. Awaiting approval is its own state, entered when the
/// pairing contract says so, and `nextPhase` below is the port of the shared
/// reducer that owns the moves, including the one that matters here: an attempt
/// issued while pending HOLDS pending, so the row does not flicker through
/// "Connecting..." and "Connected" once per retry while a device waits to be
/// approved.
///
/// What is deliberately NOT here: certificate state. A refused certificate on this
/// client is not decided yet (the navigation delegate does not evaluate trust),
/// so the row has no certificate case to report, and inventing one would be a
/// badge for a condition the app cannot detect.
@MainActor
final class ConnectionState: ObservableObject {
    enum Phase: String {
        case idle
        case connecting
        case connected
        case failed
        /// Answered, but not accepted: the page loaded and the gateway is holding
        /// the session until an operator approves this device. Mirrors
        /// `PENDING` in core/connection.js.
        case pending
    }

    /// What just happened, for the reducer below. Mirrors the event names
    /// `nextPhase` takes in core/connection.js.
    ///
    /// `unknown` is the JS reducer's `default` branch given a case, because a
    /// client that only has the events it sends cannot express "some other event
    /// arrived" and the shared fixture carries exactly that case: an event the
    /// rules do not name leaves the phase alone rather than moving it.
    enum Event {
        case pending
        case connect
        case connected
        case confirm
        case failed
        case unknown
    }

    @Published private(set) var phase: Phase = .idle
    /// Which gateway the phase is about. Nil once nothing has been attempted.
    @Published private(set) var gatewayId: String?

    /// The two sentences a pending row shows, mirrored from
    /// `core/spec/connection.json` and asserted against it by
    /// `ConnectionStateTests`. The row's copy comes from the spec for the same
    /// reason the phases do: both clients must word an unapproved device the same
    /// way, and only one of them can read the file at runtime.
    static let pendingLabel = "Needs approval"
    static let pendingDetail = "Approve this device on the gateway host, then it reconnects on its own."

    /// The next phase, given the phase now and what just happened.
    ///
    /// The port of `nextPhase` in `core/connection.js`, proven against the same
    /// fixture cases by `ConnectionStateTests`. `connect` and `connected` from
    /// `pending` HOLD it, and both halves of that are the anti-flicker rule: a
    /// device waiting for approval is reconnected every few seconds on purpose,
    /// and each attempt moves this state twice, once when the load starts and once
    /// when the page arrives. Surfacing either one pulled the visible phase off
    /// pending and put it back a moment later, which is the flicker this row was
    /// reported for. Only a `confirm` (a socket that survived the pairing settle
    /// window) means the device is approved.
    static func nextPhase(_ phase: Phase, _ event: Event) -> Phase {
        switch event {
        case .pending: return .pending
        case .connect: return phase == .pending ? .pending : .connecting
        case .connected: return phase == .pending ? .pending : .connected
        case .confirm: return phase == .pending ? .connected : phase
        case .failed: return .failed
        case .unknown: return phase
        }
    }

    /// The page was asked for and has not answered yet.
    func connecting(_ gatewayId: String) {
        self.gatewayId = gatewayId
        phase = ConnectionState.nextPhase(phase, .connect)
    }

    /// The page loaded. Whatever a previous failure said is no longer true.
    ///
    /// NOT the same as accepted, which is why it goes through the reducer: an
    /// unapproved device is served this page too, so from `pending` this holds the
    /// phase rather than claiming Connected.
    func connected(_ gatewayId: String) {
        self.gatewayId = gatewayId
        phase = ConnectionState.nextPhase(phase, .connected)
    }

    /// The gateway is holding this session until an operator approves the device.
    /// Raised by the pairing state, which is the only thing that can know.
    func pending(_ gatewayId: String) {
        self.gatewayId = gatewayId
        phase = ConnectionState.nextPhase(phase, .pending)
    }

    /// The socket survived the pairing settle window, so the device is approved
    /// and this is a genuine connect. The one move that leaves `pending`.
    func confirm() {
        phase = ConnectionState.nextPhase(phase, .confirm)
    }

    /// The page could not be fetched. The reason travels with the notice, not with
    /// the row, matching the desktop: the banner is the surface that can carry the
    /// action that answers a failure, and a row cannot.
    func failed(_ gatewayId: String) {
        self.gatewayId = gatewayId
        phase = ConnectionState.nextPhase(phase, .failed)
    }

    /// What one gateway's row says, as the page renders it.
    ///
    /// The same shape and the same answers as `status()` in
    /// `core/connection.js`, so a row reads identically on both clients.
    func status(for gateway: Gateway, active: Bool) -> (tone: String, label: String, detail: String?) {
        guard active else { return ("muted", "Not connected", nil) }
        switch phase {
        case .connected: return ("ok", "Connected", nil)
        case .connecting: return ("muted", "Connecting...", nil)
        case .failed: return ("err", "Cannot connect", nil)
        // The one row that carries a detail, and it is not a failure reason: it is
        // the requirement, and it is the thing to act on. A failed row says
        // nothing about why because the banner carries that and a row cannot offer
        // the way out; here the way out is a sentence the reader needs.
        case .pending: return ("warn", ConnectionState.pendingLabel, ConnectionState.pendingDetail)
        case .idle: return ("muted", "Not connected", nil)
        }
    }
}
