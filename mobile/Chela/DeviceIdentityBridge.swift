import Foundation
import WebKit

/// The iOS half of the device-identity capture.
///
/// The capture script (read from the bundled `device-identity.json`, one copy
/// shared with the desktop's owner) reads the page's device keypair from
/// `localStorage` and posts it to `window.webkit.messageHandlers.clawDeviceIdentity`
/// whenever it changes; this handler writes what it receives into the Keychain,
/// which survives an app uninstall. On the next launch `DeviceIdentity.seedInstallation`
/// restores it into `localStorage` before the page boots, so the page presents
/// the same public key and the gateway recognises an already-paired device
/// instead of raising a fresh pairing request.
///
/// A message handler rather than anything richer, for the same reason
/// `AppSettingsBridge` and `PairingBridge` are: the page is reporting a value it
/// owns, with a small payload and no reply. The payload is untrusted, so it is
/// read defensively (a string only, non-empty) and anything else is dropped
/// rather than stored. This handler never parses the keypair or derives anything
/// from it: the page owns the crypto, and this moves one opaque string to the
/// store.
///
/// Why this is separate from the other bridges: each is one channel with one job,
/// and folding them together would put one report's handler in another's path.
/// This one lives on the gateway page's web view alongside the token handoff and
/// the pairing observer, and captures the one value that must outlive the web
/// view for pairing to stick.
@MainActor
final class DeviceIdentityBridge: NSObject, WKScriptMessageHandler {
    /// The name the capture script posts under, and the name the web view
    /// registers. Read from the spec so a rename there cannot leave the two
    /// disagreeing; the script posts to the spec's `messageName` and this
    /// registers under it.
    nonisolated static var messageName: String { DeviceIdentity.messageName }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName,
              let identity = message.body as? String,
              !identity.isEmpty
        else { return }
        // Write-through to the Keychain. The store is idempotent on the value, so
        // the repeated reports the poll produces for an unchanged identity cost
        // nothing, and only a genuine rotation rewrites the item.
        DeviceIdentityStore.write(identity)
    }
}
