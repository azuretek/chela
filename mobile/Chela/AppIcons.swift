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
/// Light and dark are separate alternate icons, one per mode, so the icon
/// follows the interface's own mode rather than the home screen's.
enum AppIcons {
    struct Bucket: Decodable, Equatable {
        let id: String
        let hue: Double?
        let primary: Bool

        /// The alternate icon for this bucket in one mode, as core/app-icons.js
        /// alternateIconName names it. Every bucket has one per mode, the
        /// primary's included.
        func alternateIconName(mode: String) -> String { "AppIcon-\(id)-\(mode == "light" ? "light" : "dark")" }
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

    /// The mode the icon takes: the one the Control UI resolved, published under
    /// ThemeTokens.schemeKey, and the device's only when the page resolved none.
    static func mode(scheme: String?, deviceIsDark: Bool) -> String {
        switch scheme?.lowercased() {
        case "light": return "light"
        case "dark": return "dark"
        default: return deviceIsDark ? "dark" : "light"
        }
    }

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

/// Keeps the app icon on the live theme: its accent's bucket, in the mode the
/// Control UI resolved (paper for light, neon for dark).
///
/// Applied on every change, not offered. It used to be a notice raised once per
/// bucket, so a second theme change never asked again, and the icon sets carried
/// both modes as appearance renditions, which follow the DEVICE's home screen
/// rather than the interface: accepting the offer with the interface pinned to
/// the other mode showed no change at all (reported 2026-09-24). Each bucket now
/// ships one alternate icon per mode, and this sets the one the theme calls for
/// whenever it differs from the one showing. iOS confirms every change with its
/// own alert, which is accepted as the cost (Abi, 2026-09-24).
@MainActor
enum AppIconFollower {
    /// The alternate icon the live tokens call for, or nil when there is nothing
    /// to read yet (no page, or a page that published no accent), which must not
    /// move the icon.
    static func target(tokens: [String: String], deviceIsDark: Bool) -> String? {
        guard let accent = tokens["--accent"], AppIcons.hex(accent) != nil,
              let bucket = AppIcons.bucket(forAccent: accent) else { return nil }
        return bucket.alternateIconName(mode: AppIcons.mode(scheme: tokens[ThemeTokens.schemeKey], deviceIsDark: deviceIsDark))
    }

    /// The name last asked for, so a refresh that lands while iOS is still
    /// answering does not ask again.
    private static var inFlight: String?

    /// Sets the icon the tokens call for, when it is not the one showing.
    /// Returns the name it asked for, or nil when it asked for nothing.
    @discardableResult
    static func follow(tokens: [String: String], deviceIsDark: Bool, app: AlternateIconSetting = UIApplication.shared) -> String? {
        guard app.supportsAlternateIcons, app.isActive,
              let name = target(tokens: tokens, deviceIsDark: deviceIsDark),
              name != app.alternateIconName, name != inFlight else { return nil }
        inFlight = name
        Task { @MainActor in
            defer { if inFlight == name { inFlight = nil } }
            do {
                try await app.setAlternateIconName(name)
            } catch {
                NSLog("[claw] could not change the app icon to %@: %@", name, String(describing: error))
            }
        }
        return name
    }

    /// For tests: forget a request still in flight.
    static func reset() { inFlight = nil }
}

/// The part of UIApplication the follower uses, so the tests can hold it to
/// asking iOS for the icon without a real icon change.
@MainActor
protocol AlternateIconSetting {
    var supportsAlternateIcons: Bool { get }
    var alternateIconName: String? { get }
    /// Whether the app is in the foreground: iOS refuses an icon change otherwise.
    var isActive: Bool { get }
    func setAlternateIconName(_ name: String?) async throws
}

extension UIApplication: AlternateIconSetting {
    var isActive: Bool { applicationState == .active }
}
