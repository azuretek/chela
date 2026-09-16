import SwiftUI

/// Which appearance this client is in, and where the choice is kept.
///
/// The phone has a native half the page cannot paint: the status bar, the strips
/// the safe area leaves above and below the web view, and the settings sheet. It
/// also owns the web view's own trait collection, which is what a page's
/// `prefers-color-scheme` resolves against. So "light", "dark" or "follow the
/// device" has to be decided somewhere the native half can read it, and this is
/// that place.
///
/// Deliberately NOT in the shared config model, and the difference is the same one
/// that keeps window bounds and a global shortcut off this client: those are the
/// desktop's, this is a display preference of this device's, and a field carried
/// by a client that cannot use it is a field with two meanings. The desktop has
/// no equivalent to share: its appearance IS the Control UI's theme, chosen in
/// the Control UI, which the app then follows. The reasoning is recorded as this
/// setting's `absent` entry in core/spec/settings.json.
///
/// The value the shared settings page reads is `state.appearance.mode`, which
/// `SettingsHost` builds from the store below. That is deliberately the only place
/// it is read from, so the row on the page and the appearance the app is actually
/// wearing cannot come apart.
enum AppearanceMode: String, CaseIterable {
    /// Follow the device, and keep following it while the app is open.
    case system
    case light
    case dark

    /// What UIKit is asked for. `unspecified` is not a fallback here: it is the
    /// answer for `system`, and it is what makes a live device change reach the
    /// app, because the trait collection then goes on being driven by the device
    /// rather than pinned by us.
    var userInterfaceStyle: UIUserInterfaceStyle {
        switch self {
        case .system: return .unspecified
        case .light: return .light
        case .dark: return .dark
        }
    }

    /// The same answer as a SwiftUI scheme, or nil to follow the device.
    ///
    /// Applied at the top of the app so the native chrome agrees with the page:
    /// the status bar, the safe-area strips and the sheet's own background are all
    /// resolved from the appearance in force, and pinning them here is what keeps
    /// them from disagreeing with a page the same choice was passed down to.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    /// One of these from what the page sent, or nil for anything else.
    ///
    /// An unknown string is refused rather than defaulted: the page sends what the
    /// page offers, so a value this client does not have is a bug on one side of
    /// the contract, and quietly reading it as "system" would hide it behind a
    /// change nobody asked for.
    static func named(_ raw: Any?) -> AppearanceMode? {
        guard let text = raw as? String else { return nil }
        return AppearanceMode(rawValue: text)
    }
}

/// The appearance this device is set to, persisted between launches.
///
/// `UserDefaults` rather than the Keychain, because this is a preference and not a
/// credential, which is the same split `GatewayStore` makes for the gateway list.
/// One key, one value, and no default of its own beyond the one the setting's own
/// name describes: an install that has never been asked follows the device.
@MainActor
final class AppearanceStore: ObservableObject {
    /// Where the choice is kept. Its own key rather than a field of the gateway
    /// config, and the note at the top of this file says why.
    static let storageKey = "clawAppearanceMode"

    @Published private(set) var mode: AppearanceMode

    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults = .standard, key: String = AppearanceStore.storageKey) {
        self.defaults = defaults
        self.key = key
        // A stored string that is not one of the three modes reads as `system`
        // rather than as a crash or a silent nil: the value can only have come from
        // an older build of this app or from a hand-edited defaults file, and
        // following the device is the honest answer for both.
        self.mode = AppearanceMode(rawValue: defaults.string(forKey: key) ?? "") ?? .system
    }

    /// Chooses an appearance and stores it, so the next launch opens in it.
    func choose(_ next: AppearanceMode) {
        mode = next
        defaults.set(next.rawValue, forKey: key)
    }

    /// What the shared settings page reads, as one key of the state it renders
    /// from. A dictionary rather than a string so the page reads a field of an
    /// object, the same shape the desktop's state uses for the settings it has.
    var state: [String: Any] { ["mode": mode.rawValue] }
}
