import SwiftUI

/// The appearance vocabulary this client's views carry, and where the answer comes
/// from. There is one answer, and that is the rule: the sixth in
/// core/ui/CONVENTIONS.md.
///
/// The DEVICE's appearance flows down, and the Control UI's resolved theme flows
/// up. `ThemeTokens.pageTrait` is the whole of it: our shared pages are given the
/// appearance the Control UI resolved for its own palette, read off the page, and
/// the device is the answer for a page that resolved none. Every view here carries
/// `system`, which is `.unspecified` and therefore leaves its trait collection
/// driven by the device, so a live system change reaches the app and the page.
///
/// What stood in this file: three modes, a `UserDefaults`-backed store, a selector
/// for them on the shared settings page, and a `saveSettings` field to carry the
/// choice back. It was a second control for a choice the Control UI already owns,
/// and it did not work right, because the palette we inject is the Control UI's
/// while the trait was ours: in one of the two combinations the page painted one
/// mode and the platform drew the other. Reported 2026-09-17. The row, the store
/// and the command went together, so there is no path left by which a mode is
/// chosen or persisted.
///
/// One case rather than no type, deliberately: the views and the trait layer carry
/// an `AppearanceMode`, so reducing it here removes every value a reader could have
/// produced while leaving that threading alone. `named` went with the row that
/// used to send one.
enum AppearanceMode: String, CaseIterable {
    /// Follow the device, and keep following it while the app is open.
    case system

    /// What UIKit is asked for. `unspecified` is not a fallback here: it is the
    /// answer, and it is what leaves the trait collection driven by the device.
    var userInterfaceStyle: UIUserInterfaceStyle { .unspecified }

    /// The same answer as a SwiftUI scheme, and it is nil for the same reason.
    var colorScheme: ColorScheme? { nil }
}

