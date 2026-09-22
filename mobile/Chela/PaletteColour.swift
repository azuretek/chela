import UIKit

/// A colour the page reported, as a `UIColor`.
///
/// What arrives here is a CSSOM computed string, not a literal this client wrote:
/// the probe reads `getComputedStyle` off the running Control UI, so a palette
/// authored in `oklch()` or `color-mix()` arrives already resolved by the engine.
/// Three shapes come back in practice, and the parser is permissive on exactly
/// those:
///
///     rgb(25, 23, 36)                 -- a colour token
///     rgba(25, 23, 36, 0.7)           -- one with alpha
///     color(srgb 0.098 0.090 0.141)   -- what Chromium answers for a mix
///     #faf4ed                         -- our own fallbacks, written by hand
///
/// Anything else returns nil, and every caller keeps what it already had. That is
/// deliberate: a guess here would be a colour nobody chose, painted over a surface
/// whose whole job is to match the page it sits behind.
enum PaletteColour {
    static func uiColor(from css: String?) -> UIColor? {
        guard let trimmed = css?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        let raw = trimmed.lowercased()
        if raw.hasPrefix("#") { return fromHex(String(raw.dropFirst())) }
        if raw.hasPrefix("rgb") { return fromRgb(raw) }
        if raw.hasPrefix("color(") { return fromColorFunction(raw) }
        return nil
    }

    /// `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`.
    private static func fromHex(_ hex: String) -> UIColor? {
        let digits = hex.filter { $0.isHexDigit }
        guard digits.count == hex.count else { return nil }
        let values: [CGFloat]
        switch digits.count {
        case 3, 4:
            values = digits.map { digit in
                CGFloat(Int(String(digit).appending(String(digit)), radix: 16) ?? 0) / 255
            }
        case 6, 8:
            var out: [CGFloat] = []
            var index = digits.startIndex
            while index < digits.endIndex {
                let next = digits.index(index, offsetBy: 2)
                guard next <= digits.endIndex,
                      let byte = Int(digits[index..<next], radix: 16) else { return nil }
                out.append(CGFloat(byte) / 255)
                index = next
            }
            values = out
        default:
            return nil
        }
        guard values.count == 3 || values.count == 4 else { return nil }
        return UIColor(red: values[0], green: values[1], blue: values[2], alpha: values.count == 4 ? values[3] : 1)
    }

    /// `rgb(...)` and `rgba(...)`, in either the comma or the space syntax, with an
    /// optional slash for alpha.
    private static func fromRgb(_ raw: String) -> UIColor? {
        guard let open = raw.firstIndex(of: "("), let close = raw.lastIndex(of: ")"), open < close else { return nil }
        let body = raw[raw.index(after: open)..<close]
            .replacingOccurrences(of: ",", with: " ")
            .replacingOccurrences(of: "/", with: " ")
        let parts = body.split(separator: " ").map(String.init).filter { !$0.isEmpty }
        guard parts.count == 3 || parts.count == 4 else { return nil }
        guard let red = channel(parts[0]), let green = channel(parts[1]), let blue = channel(parts[2]) else { return nil }
        let alpha = parts.count == 4 ? (CGFloat(Double(parts[3]) ?? 1)) : 1
        return UIColor(red: red, green: green, blue: blue, alpha: min(max(alpha, 0), 1))
    }

    /// `color(srgb r g b)` and `color(srgb r g b / a)`: components are 0...1 already.
    private static func fromColorFunction(_ raw: String) -> UIColor? {
        guard let open = raw.firstIndex(of: "("), let close = raw.lastIndex(of: ")"), open < close else { return nil }
        let body = raw[raw.index(after: open)..<close]
            .replacingOccurrences(of: "/", with: " ")
        var parts = body.split(separator: " ").map(String.init).filter { !$0.isEmpty }
        guard let space = parts.first, space == "srgb" || space == "srgb-linear" else { return nil }
        parts.removeFirst()
        guard parts.count == 3 || parts.count == 4 else { return nil }
        guard let red = unit(parts[0]), let green = unit(parts[1]), let blue = unit(parts[2]) else { return nil }
        let alpha = parts.count == 4 ? CGFloat(Double(parts[3]) ?? 1) : 1
        return UIColor(red: red, green: green, blue: blue, alpha: min(max(alpha, 0), 1))
    }

    /// One channel of `rgb()`: a number, or a percentage of it.
    private static func channel(_ part: String) -> CGFloat? {
        guard let value = Double(part.hasSuffix("%") ? String(part.dropLast()) : part) else { return nil }
        let scaled = part.hasSuffix("%") ? value / 100 * 255 : value
        return min(max(CGFloat(scaled) / 255, 0), 1)
    }

    /// One component of `color(srgb ...)`: 0...1, or a percentage of it.
    private static func unit(_ part: String) -> CGFloat? {
        guard let value = Double(part.hasSuffix("%") ? String(part.dropLast()) : part) else { return nil }
        let scaled = part.hasSuffix("%") ? value / 100 : value
        return min(max(CGFloat(scaled), 0), 1)
    }
}
