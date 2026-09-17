import Foundation

/// The design tokens the notice banner draws with, mirrored from
/// `core/spec/tokens.json`.
///
/// The same spec is what the desktop banner's stylesheet resolves to, and this
/// mirror is what the SwiftUI banner draws, so the two clients cannot drift into
/// two looks: `NoticeTokensParityTests` asserts every value below against the
/// spec file, fixture for fixture. That test is the contract. Change a value in
/// the spec, and this file is what has to move with it.
///
/// The Swift does not read the spec at runtime, because a shipped app cannot read
/// a file that lives in the repo, and a bundled copy of the data would be a third
/// thing to keep in step. `Fixtures.spec` is what the test reads instead.
///
/// Foundation only, deliberately: the data and the name resolution are testable
/// without a window, and `NoticeBanner` is where a resolved value becomes a
/// colour. A value here is the Control UI's own, with the file it came from
/// recorded in the spec beside it, so a drift is findable rather than invisible.
enum NoticeTokens {
    /// The two colour modes, named as the spec names them.
    static let modes = ["dark", "light"]

    /// The four tones, worst first. The names come from
    /// `core/spec/notices.json`, and the tone to colour mapping below comes from
    /// `core/spec/tokens.json`.
    static let toneNames = [NoticeTone.error, NoticeTone.warn, NoticeTone.info, NoticeTone.ok]

    static let dark: [String: String] = [
        "--bg": "#0e1015",
        "--bg-elevated": "#191c24",
        "--bg-hover": "#1f2330",
        "--panel": "#0e1015",
        "--panel-strong": "#191c24",
        "--card": "#161920",
        "--text": "#bcbcc0",
        "--text-strong": "#f4f4f5",
        "--muted": "#8b8b94",
        "--border": "#1e2028",
        "--border-strong": "#2e3040",
        "--accent": "#ff5c5c",
        "--accent-hover": "#ff7070",
        "--accent-subtle": "rgba(255, 92, 92, 0.1)",
        "--accent-foreground": "#fafafa",
        "--ring": "#ff5c5c",
        "--ok": "#22c55e",
        "--ok-subtle": "rgba(34, 197, 94, 0.08)",
        "--warn": "#f59e0b",
        "--warn-subtle": "rgba(245, 158, 11, 0.08)",
        "--danger": "#f87171",
        "--danger-subtle": "rgba(248, 113, 113, 0.08)",
        "--info": "#60a5fa",
        "--info-subtle": "rgba(96, 165, 250, 0.08)",
    ]

    static let light: [String: String] = [
        "--bg": "#faf9f7",
        "--bg-elevated": "#ffffff",
        "--bg-hover": "#efebe4",
        "--panel": "#faf9f7",
        "--panel-strong": "#f4f1ec",
        "--card": "#ffffff",
        "--text": "#403c35",
        "--text-strong": "#211e1a",
        "--muted": "#6e6960",
        "--border": "#e8e4dc",
        "--border-strong": "#d6d0c5",
        "--accent": "#bd4531",
        "--accent-hover": "#a83c29",
        "--accent-subtle": "rgba(189, 69, 49, 0.08)",
        "--accent-foreground": "#ffffff",
        "--ring": "#bd4531",
        "--ok": "#166534",
        "--ok-subtle": "rgba(22, 101, 52, 0.08)",
        "--warn": "#92400e",
        "--warn-subtle": "rgba(146, 64, 14, 0.08)",
        "--danger": "#b91c1c",
        "--danger-subtle": "rgba(185, 28, 28, 0.08)",
        "--info": "#1d4ed8",
        "--info-subtle": "rgba(29, 78, 216, 0.08)",
    ]

    /// Radius, depth and motion. Mode-independent, because the Control UI keeps
    /// one geometry contract across its palettes.
    static let shape: [String: String] = [
        "--radius-sm": "6px",
        "--radius-md": "10px",
        "--radius-lg": "14px",
        "--radius-xl": "20px",
        "--radius-full": "9999px",
        "--shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.25)",
        "--shadow-lg": "0 12px 32px rgba(0, 0, 0, 0.4)",
        "--ease-out": "cubic-bezier(0.16, 1, 0.3, 1)",
        "--duration-fast": "100ms",
        "--duration-normal": "180ms",
    ]

    /// The type scale, at the Control UI's default text scale of 1.
    static let sizes: [String: String] = ["xs": "11px", "sm": "12px", "md": "14px", "lg": "16px"]

    static let weights: [String: Int] = ["headline": 650, "subject": 400, "action": 600]

    static let leadings: [String: Double] = ["body": 1.55, "card": 1.35]

    /// The card, flattened to the names the spec's `card` object uses, one level
    /// deep. A value that names a token stays a name here and is resolved before
    /// it is drawn, so the spec keeps one owner of the colour.
    static let card: [String: String] = [
        "radius": "--radius-lg",
        "border": "--border",
        "borderAlpha": "88%",
        "surface": "--panel",
        "surfaceAlpha": "92%",
        "shadow": "--shadow-sm",
        "blur": "10px",
        "padding": "11px 14px",
        "gap": "8px",
        "edgeWidth": "3px",
        "iconSize": "28px",
        "iconRadius": "--radius-sm",
        "glyphSize": "16px",
        "dismiss.size": "24px",
        "dismiss.radius": "--radius-sm",
        "dismiss.glyph": "14px",
        "dismiss.colour": "--muted",
        "dismiss.hoverSurface": "--bg-hover",
        "dismiss.hoverColour": "--text-strong",
        "action.minHeight": "28px",
        "action.padding": "4px 8px",
        "action.radius": "--radius-md",
        "action.border": "--border",
        "action.surface": "--bg-elevated",
        "action.colour": "--muted",
        "action.hoverSurface": "--bg-hover",
        "action.hoverColour": "--text",
    ]

    /// Which token each tone draws with, and the glyph that carries it.
    ///
    /// The glyph is the one part of this file the desktop ignores: its card shows
    /// the tone in the stripe on its leading edge, while a card that sits over
    /// someone else's page and has an icon slot shows it in both.
    struct Tone: Equatable {
        let edge: String
        let tint: String
        let glyph: String
    }

    static let tones: [String: Tone] = [
        NoticeTone.error: Tone(edge: "--danger", tint: "--danger-subtle", glyph: "exclamationmark.octagon.fill"),
        NoticeTone.warn: Tone(edge: "--warn", tint: "--warn-subtle", glyph: "exclamationmark.triangle.fill"),
        NoticeTone.info: Tone(edge: "--info", tint: "--info-subtle", glyph: "info.circle.fill"),
        NoticeTone.ok: Tone(edge: "--ok", tint: "--ok-subtle", glyph: "checkmark.circle.fill"),
    ]

    /// Every colour as a name/value pair for one mode, shape included, matching
    /// how the desktop merges the two halves before emitting a stylesheet.
    static func values(_ mode: String) -> [String: String] {
        var all = mode == "light" ? light : dark
        all.merge(shape) { _, shape_ in shape_ }
        return all
    }

    /// Resolve a token name to its value in one mode, following one level of
    /// `var(...)` so a token defined as another token still answers with a value.
    ///
    /// Nil for anything unknown, which is the honest answer: a caller that asked
    /// for a name this file does not own has a bug, and a silent fallback colour
    /// would hide it behind something that looks deliberate.
    static func resolve(_ name: String, mode: String) -> String? {
        let all = values(mode)
        var current = name
        var seen = Set<String>()
        while true {
            var key = current
            if current.hasPrefix("var(") {
                guard let open = current.firstIndex(of: "("), let close = current.lastIndex(of: ")") else { return nil }
                key = current[current.index(after: open)..<close].trimmingCharacters(in: .whitespaces)
            }
            // A value that is not a token name is not something this file can
            // answer for, matching the JS.
            guard key.hasPrefix("--") else { return nil }
            guard !seen.contains(key) else { return nil }
            seen.insert(key)
            guard let value = all[key] else { return nil }
            if !value.hasPrefix("var(") { return value }
            current = value
        }
    }

    /// The two colours one tone draws with, resolved for a mode, and the glyph.
    ///
    /// Here rather than in the view because "which token is the error tone" is
    /// the mapping, and a mapping copied into two places is a mapping that
    /// dissents.
    static func tone(_ name: String, mode: String) -> (edge: String, tint: String, glyph: String, edgeColour: String, tintColour: String)? {
        guard let tone = tones[name],
              let edge = resolve(tone.edge, mode: mode),
              let tint = resolve(tone.tint, mode: mode)
        else { return nil }
        return (tone.edge, tone.tint, tone.glyph, edge, tint)
    }

    /// One card value resolved, so a caller never has to know whether the spec
    /// recorded a token name or a literal for it.
    static func cardValue(_ name: String, mode: String) -> String? {
        guard let value = card[name] else { return nil }
        if value.hasPrefix("--") { return resolve(value, mode: mode) }
        return value
    }
}
