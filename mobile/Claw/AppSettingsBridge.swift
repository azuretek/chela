import Foundation
import WebKit

/// The iOS half of the App-settings affordance's host bridge.
///
/// The affordance runs in the Control UI's main world and calls
/// `window.__clawAppSettings.open()` when its control is pressed. On the desktop
/// that call reaches an IPC; here it posts to this message handler, which raises
/// the app's own settings sheet. It is the one thing that differs between the two
/// clients, and it differs only in how open() reaches a window.
///
/// A message handler rather than anything richer, because open() carries no
/// argument and returns nothing: the page is asking to be shown settings, which
/// is a request with no payload and no reply. That is the whole of the contract,
/// so a `postMessage({})` and a closure are all it needs.
///
/// This is deliberately NOT `SettingsHost`. That host answers the settings PAGE
/// once it is open, over its own `clawSettings` channel; this one only opens it,
/// from the gateway page, and the two never share a web view. Folding them
/// together would put the gateway page's message handler on the settings surface
/// and the surface's on the gateway page, each carrying the other's commands for
/// no one.
@MainActor
final class AppSettingsBridge: NSObject, WKScriptMessageHandler {
    /// The name the injected shim posts under, and the name the web view registers.
    ///
    /// Nonisolated because it is a compile-time constant read from non-isolated
    /// contexts too: `AppSettingsAffordance.installation()` splices it into the
    /// bridge shim, and the web view registers the handler under it. Nothing about
    /// the name touches the actor's state.
    nonisolated static let messageName = "clawAppSettings"

    /// Raised when the affordance is pressed. The view that owns the sheet supplies
    /// this; the bridge only relays the ask.
    private let onOpen: () -> Void

    init(onOpen: @escaping () -> Void) {
        self.onOpen = onOpen
        super.init()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName else { return }
        onOpen()
    }
}
