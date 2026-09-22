import Foundation
import WebKit

/// The iOS half of the device-pairing observer.
///
/// The observer script (read from the bundled `pairing.json`, one copy shared
/// with the desktop) wraps the page's `WebSocket` and posts a small payload when
/// the gateway socket opens or closes for a pairing reason. It runs in the page's
/// main world and posts to `window.webkit.messageHandlers.clawPairing`; this
/// handler reads that payload and drives `PairingState`.
///
/// A message handler rather than anything richer, for the same reason
/// `AppSettingsBridge` is one: the page is reporting a condition it observed, with
/// a tiny payload and no reply. The payload is untrusted, so every field is read
/// defensively and a shape that is not one of the two kinds is dropped rather than
/// guessed at.
///
/// Why this is separate from `AppSettingsBridge` and `SettingsHost`: each is one
/// channel with one job, and folding them together would put one page's handler on
/// another page's web view. This handler lives on the gateway page's web view
/// alongside the others, and reports the one condition the native layer cannot see
/// any other way.
@MainActor
final class PairingBridge: NSObject, WKScriptMessageHandler {
    /// The name the observer posts under, and the name the web view registers.
    /// Read from the spec so a rename there cannot leave the two disagreeing;
    /// the observer posts to the spec's `messageName` and this registers under it.
    nonisolated static let messageName = "clawPairing"

    /// The state the report drives. Held weakly is unnecessary here: the bridge is
    /// owned by the coordinator for the life of the web view, and so is the state.
    private let state: PairingState

    init(state: PairingState) {
        self.state = state
        super.init()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName,
              let body = message.body as? [String: Any],
              let kind = body["kind"] as? String
        else { return }

        switch kind {
        case Pairing.Phase.authenticated.rawValue:
            // The socket opened, which is the recovery leg: an approval that landed
            // while the pairing screen was up ends here, and the screen comes down.
            state.opened()
        case Pairing.Phase.pairingRequired.rawValue:
            // A pairing close. The observer already classified it, but the reason
            // and id are re-read through the ported parser here rather than trusted
            // from the payload, so the one owner of "what counts as pairing" is the
            // shared contract and not the injected script's copy of it. `reason` is
            // a spec key; `requestId` is null or a checked id.
            let reason = body["reason"] as? String
            let requestId = body["requestId"] as? String
            state.closed(Self.refusal(reason: reason, requestId: requestId))
        default:
            break
        }
    }

    /// Build a refusal from the payload, validating both fields through the shared
    /// contract. A payload naming a reason the contract does not know, or an id
    /// that fails the pattern, is narrowed rather than shown: an unknown reason
    /// falls back to the general one, and a bad id is dropped to nil so the screen
    /// shows the `--latest` command.
    private static func refusal(reason: String?, requestId: String?) -> Pairing.Refusal {
        let known = reason.flatMap { Pairing.isKnownReason($0) ? $0 : nil }
        let checkedId = requestId.flatMap { Pairing.readRequestId("(requestId: \($0))") }
        return Pairing.Refusal(reason: known ?? "not-paired", requestId: checkedId)
    }
}
