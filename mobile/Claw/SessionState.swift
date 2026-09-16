import Combine
import Foundation

/// How the app's one connection is going, for the settings page's gateway rows.
///
/// A small state machine rather than a flag, because the row has to say three
/// different things and one of them is "still trying": the settings page shows a
/// badge per gateway and disables the button under the one it is already
/// connecting to, exactly as the desktop's page does.
///
/// **The words come from `core/connection.js`, deliberately, and that is a mirror
/// rather than a shared file.** The desktop has that mapping as JS and this client
/// has no port of it, because the only thing it needs is the badge: the sentence
/// explaining a failure is raised by `NoticeBoard`, which is the client's own and
/// reads the reason the OS gave. So these four labels are the one part of the
/// desktop's status vocabulary this client repeats, and they are repeated here,
/// in one place, with the case they came from named. `ConnectionStateTests` pins
/// them against the strings in that file so a reword there fails here.
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
    }

    @Published private(set) var phase: Phase = .idle
    /// Which gateway the phase is about. Nil once nothing has been attempted.
    @Published private(set) var gatewayId: String?

    /// The page was asked for and has not answered yet.
    func connecting(_ gatewayId: String) {
        self.gatewayId = gatewayId
        phase = .connecting
    }

    /// The page loaded. Whatever a previous failure said is no longer true.
    func connected(_ gatewayId: String) {
        self.gatewayId = gatewayId
        phase = .connected
    }

    /// The page could not be fetched. The reason travels with the notice, not with
    /// the row, matching the desktop: the banner is the surface that can carry the
    /// action that answers a failure, and a row cannot.
    func failed(_ gatewayId: String) {
        self.gatewayId = gatewayId
        phase = .failed
    }

    /// What one gateway's row says, as the page renders it.
    ///
    /// The same shape and the same four answers as `status()` in
    /// `core/connection.js`, so a row reads identically on both clients.
    func status(for gateway: Gateway, active: Bool) -> (tone: String, label: String, detail: String?) {
        guard active else { return ("muted", "Not connected", nil) }
        switch phase {
        case .connected: return ("ok", "Connected", nil)
        case .connecting: return ("muted", "Connecting...", nil)
        case .failed: return ("err", "Cannot connect", nil)
        case .idle: return ("muted", "Not connected", nil)
        }
    }
}
