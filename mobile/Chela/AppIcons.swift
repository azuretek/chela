import Foundation
import UIKit

/// The app icon for the live Control UI theme, chosen from its accent alone.
///
/// Mirrors `core/app-icons.js` through the bundled `core/spec/app-icons.json`,
/// which is generated from it. Nothing here knows a theme: the app ships one icon
/// pair per BUCKET (hues evenly spaced round the wheel, plus a neutral pair), and
/// an accent takes the nearest hue, or the neutral pair when it has no real
/// colour. A theme added upstream is followed with no change here. The spec's
/// samples are the desktop's own answers, and AppIconsTests holds this to them.
///
/// Light and dark need no code: every icon set carries the paper icon as its
/// default rendition and the neon icon under dark appearance.
enum AppIcons {
    struct Bucket: Decodable, Equatable {
        let id: String
        let hue: Double?
        let primary: Bool

        /// The alternate icon's name, or nil for the primary icon.
        var alternateIconName: String? { primary ? nil : "AppIcon-\(id)" }
    }

    struct Sample: Decodable {
        let accent: String
        let bucket: String
    }

    struct Spec: Decodable {
        let neutralChroma: Double
        let buckets: [Bucket]
        let samples: [Sample]
    }

    static let spec: Spec? = try? BundledSpec.load("app-icons", as: Spec.self)
    static var buckets: [Bucket] { spec?.buckets ?? [] }
    static var primary: Bucket? { buckets.first(where: { $0.primary }) }

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

    /// OKLCH chroma and hue (degrees) of a `#rrggbb` colour, as core/app-icons.js lch().
    static func chromaAndHue(_ hex: String) -> (chroma: Double, hue: Double)? {
        let digits = Array(hex.dropFirst())
        guard hex.hasPrefix("#"), digits.count == 6 else { return nil }
        func channel(_ i: Int) -> Double? { UInt8(String(digits[i..<(i + 2)]), radix: 16).map { Double($0) / 255 } }
        guard let r0 = channel(0), let g0 = channel(2), let b0 = channel(4) else { return nil }
        func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        let r = linear(r0), g = linear(g0), b = linear(b0)
        let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        let a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
        let bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
        let hue = (atan2(bb, a) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
        return (hypot(a, bb), hue)
    }

    /// The bucket for an accent: neutral when it has no real colour, else the
    /// nearest hue, and the primary icon when there is no accent to read.
    static func bucket(forAccent accent: String?) -> Bucket? {
        guard let spec, let h = hex(accent), let (chroma, hue) = chromaAndHue(h) else { return primary }
        if chroma < spec.neutralChroma { return spec.buckets.first(where: { $0.hue == nil }) }
        func gap(_ other: Double) -> Double { let d = abs(hue - other).truncatingRemainder(dividingBy: 360); return min(d, 360 - d) }
        return spec.buckets.filter { $0.hue != nil }.min(by: { gap($0.hue ?? 0) < gap($1.hue ?? 0) })
    }
}

/// Offers the live theme's icon through a notice that can simply be ignored.
///
/// Offered once per bucket: the bucket is remembered when the notice goes up, so
/// ignoring it means it is not raised again on the next launch, and a theme in a
/// different colour offers its own. Choosing it applies the icon, which is where
/// iOS shows its own confirmation. Never automatic, because iOS puts that alert
/// up on every icon change.
@MainActor
enum AppIconOffer {
    static let noticeId = "app-icon"
    static let commandPrefix = "app-icon:"
    private static let offeredKey = "chela.appIcon.offeredBucket"

    static func consider(tokens: [String: String], board: NoticeBoard) {
        guard UIApplication.shared.supportsAlternateIcons,
              let accent = tokens["--accent"],
              let bucket = AppIcons.bucket(forAccent: accent) else { return }
        if UIApplication.shared.alternateIconName == bucket.alternateIconName {
            board.clear(noticeId)
            return
        }
        let defaults = UserDefaults.standard
        guard defaults.string(forKey: offeredKey) != bucket.id else { return }
        defaults.set(bucket.id, forKey: offeredKey)
        board.raise(noticeId, NoticeRaise(
            tone: NoticeTone.info,
            message: "Match the app icon to your theme?",
            detail: "Paper in light mode, neon in dark. iOS asks you to confirm an icon change.",
            action: NoticeAction(label: "Use this icon", command: commandPrefix + bucket.id)
        ))
    }

    /// Answers the notice's action. Returns false for a command that is not ours.
    static func run(_ command: String, board: NoticeBoard) -> Bool {
        guard command.hasPrefix(commandPrefix) else { return false }
        let id = String(command.dropFirst(commandPrefix.count))
        guard let bucket = AppIcons.buckets.first(where: { $0.id == id }) else { return true }
        Task { @MainActor in
            do {
                try await UIApplication.shared.setAlternateIconName(bucket.alternateIconName)
                board.clear(noticeId)
            } catch {
                NSLog("[claw] could not change the app icon to %@: %@", id, String(describing: error))
            }
        }
        return true
    }
}
