import Foundation
import UIKit

/// The app icon that matches the Control UI's theme, from the bundled
/// `core/spec/app-icons.json`, the same spec the desktop reads through
/// `core/app-icons.js`.
///
/// Light and dark need no code here: every icon set carries the paper icon as its
/// default rendition and the neon icon under dark appearance, so the home screen
/// follows the device. What this chooses is the THEME, and it only ever offers:
/// iOS confirms every icon change with an alert of its own, so switching behind
/// the user's back on each theme change would put that alert up unasked.
enum AppIcons {
    struct Theme: Decodable, Equatable {
        let id: String
        let label: String
        let dark: String
        let light: String
        let primary: Bool?

        var isPrimary: Bool { primary == true }
        /// The alternate icon's name, or nil for the primary icon.
        var alternateIconName: String? { isPrimary ? nil : "AppIcon-\(id)" }
    }

    private struct Spec: Decodable { let themes: [Theme] }

    static let themes: [Theme] = (try? BundledSpec.load("app-icons", as: Spec.self).themes) ?? []

    static var primary: Theme? { themes.first(where: { $0.isPrimary }) }

    /// `#rgb`, `#rrggbb`, or `rgb()`/`rgba()` as lowercase `#rrggbb`; nil otherwise.
    /// The same forms core/app-icons.js hex() reads.
    static func hex(_ value: String?) -> String? {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !raw.isEmpty else { return nil }
        if raw.hasPrefix("#") {
            let body = String(raw.dropFirst())
            guard body.allSatisfy(\.isHexDigit) else { return nil }
            if body.count == 6 { return "#" + body }
            if body.count == 3 { return "#" + body.map { "\($0)\($0)" }.joined() }
            return nil
        }
        guard raw.hasPrefix("rgb"), let open = raw.firstIndex(of: "(") else { return nil }
        let inside = raw[raw.index(after: open)...].prefix { $0 != ")" && $0 != "/" }
        let parts = inside.split(whereSeparator: { $0 == "," || $0 == " " }).prefix(3).compactMap { Double($0) }
        guard parts.count == 3, parts.allSatisfy({ $0 >= 0 && $0 <= 255 }) else { return nil }
        return "#" + parts.map { String(format: "%02x", Int($0.rounded())) }.joined()
    }

    /// The built-in theme with this accent, in either mode, or nil.
    static func theme(forAccent accent: String?) -> Theme? {
        guard let h = hex(accent) else { return nil }
        return themes.first(where: { $0.dark == h || $0.light == h })
    }
}

/// Offers the live theme's icon through a notice that can simply be ignored.
///
/// Offered once per theme: the theme is remembered when the notice goes up, so
/// ignoring it means it is not raised again on the next launch, and moving to a
/// different theme offers that one. Choosing it applies the icon, which is where
/// iOS shows its own confirmation.
@MainActor
enum AppIconOffer {
    static let noticeId = "app-icon"
    static let commandPrefix = "app-icon:"
    private static let offeredKey = "chela.appIcon.offeredTheme"

    static func consider(tokens: [String: String], board: NoticeBoard) {
        guard UIApplication.shared.supportsAlternateIcons,
              let accent = tokens["--accent"] else { return }
        let theme = AppIcons.theme(forAccent: accent) ?? AppIcons.primary
        guard let theme else { return }
        if UIApplication.shared.alternateIconName == theme.alternateIconName {
            board.clear(noticeId)
            return
        }
        let defaults = UserDefaults.standard
        guard defaults.string(forKey: offeredKey) != theme.id else { return }
        defaults.set(theme.id, forKey: offeredKey)
        board.raise(noticeId, NoticeRaise(
            tone: NoticeTone.info,
            message: "Match the app icon to \(theme.label)?",
            detail: "Paper in light mode, neon in dark. iOS asks you to confirm an icon change.",
            action: NoticeAction(label: "Use this icon", command: commandPrefix + theme.id)
        ))
    }

    /// Answers the notice's action. Returns false for a command that is not ours.
    static func run(_ command: String, board: NoticeBoard) -> Bool {
        guard command.hasPrefix(commandPrefix) else { return false }
        let id = String(command.dropFirst(commandPrefix.count))
        guard let theme = AppIcons.themes.first(where: { $0.id == id }) else { return true }
        Task { @MainActor in
            do {
                try await UIApplication.shared.setAlternateIconName(theme.alternateIconName)
                board.clear(noticeId)
            } catch {
                NSLog("[claw] could not change the app icon to %@: %@", id, String(describing: error))
            }
        }
        return true
    }
}
