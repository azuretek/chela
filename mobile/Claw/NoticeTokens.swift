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
    /// `core/spec/tokens.json`, in the shape the file already has. The sections
    /// read here are optional so the empty case is one constructor rather than
    /// thirty empty strings, and a missing section fails the parity tests loudly
    /// instead of drawing a transparent card.
    private struct Spec: Decodable {
        struct Typography: Decodable {
            let size: [String: String]
            let weight: [String: Int]
            let leading: [String: Double]
        }

        struct Card: Decodable {
            struct Dismiss: Decodable {
                let size: String
                let radius: String
                let glyph: String
                let colour: String
                let hoverSurface: String
                let hoverColour: String
            }

            struct Action: Decodable {
                let minHeight: String
                let padding: String
                let radius: String
                let border: String
                let surface: String
                let colour: String
                let hoverSurface: String
                let hoverColour: String
            }

            let radius: String
            let border: String
            let borderAlpha: String
            let surface: String
            let surfaceAlpha: String
            let shadow: String
            let blur: String
            let padding: String
            let gap: String
            let edgeWidth: String
            let iconSize: String
            let iconRadius: String
            let glyphSize: String
            let dismiss: Dismiss
            let action: Action
        }

        struct ToneSpec: Decodable {
            let edge: String
            let tint: String
            let glyph: String
        }

        let css: [String: [String: String]]?
        let shape: [String: String]?
        let type: Typography?
        let card: Card?
        let tone: [String: ToneSpec]?
    }

    /// What the clients read: everything here, plus `live`, which `ThemeTokens`
    /// consumes. The rest of the file is provenance, kept beside the values it
    /// describes, and `BundledSpecTests` requires every key to be either decoded
    /// or named here.
    static let decodedKeys: Set<String> = ["css", "shape", "type", "card", "tone", "live"]
    static let ignoredKeys: Set<String> = [
        "source", "provenance", "shapeProvenance", "typeProvenance", "cardProvenance", "toneNote",
    ]

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(css: nil, shape: nil, type: nil, card: nil, tone: nil)
        guard let spec = try? BundledSpec.load("tokens", as: Spec.self), spec.css?["dark"] != nil else {
            return empty
        }
        return spec
    }

    /// The two colour modes, named as the spec names them.
    static var modes: [String] { (spec.css ?? [:]).keys.sorted() }

    /// The four tones, worst first. The names come from
    /// `core/spec/notices.json`, and the tone to colour mapping below comes from
    /// `core/spec/tokens.json`.
    static var toneNames: [String] { [NoticeTone.error, NoticeTone.warn, NoticeTone.info, NoticeTone.ok] }

    static var dark: [String: String] { spec.css?["dark"] ?? [:] }

    static var light: [String: String] { spec.css?["light"] ?? [:] }

    /// Radius, depth and motion. Mode-independent, because the Control UI keeps
    /// one geometry contract across its palettes.
    static var shape: [String: String] { spec.shape ?? [:] }

    /// The type scale, at the Control UI's default text scale of 1.
    static var sizes: [String: String] { spec.type?.size ?? [:] }

    static var weights: [String: Int] { spec.type?.weight ?? [:] }

    static var leadings: [String: Double] { spec.type?.leading ?? [:] }

    /// The card, flattened to the names the spec's `card` object uses, one level
    /// deep. A value that names a token stays a name here and is resolved before
    /// it is drawn, so the spec keeps one owner of the colour.
    static var card: [String: String] {
        guard let card = spec.card else { return [:] }
        var out: [String: String] = [
            "radius": card.radius,
            "border": card.border,
            "borderAlpha": card.borderAlpha,
            "surface": card.surface,
            "surfaceAlpha": card.surfaceAlpha,
            "shadow": card.shadow,
            "blur": card.blur,
            "padding": card.padding,
            "gap": card.gap,
            "edgeWidth": card.edgeWidth,
            "iconSize": card.iconSize,
            "iconRadius": card.iconRadius,
            "glyphSize": card.glyphSize,
            "dismiss.size": card.dismiss.size,
            "dismiss.radius": card.dismiss.radius,
            "dismiss.glyph": card.dismiss.glyph,
            "dismiss.colour": card.dismiss.colour,
            "dismiss.hoverSurface": card.dismiss.hoverSurface,
            "dismiss.hoverColour": card.dismiss.hoverColour,
            "action.minHeight": card.action.minHeight,
            "action.padding": card.action.padding,
            "action.radius": card.action.radius,
            "action.border": card.action.border,
            "action.surface": card.action.surface,
            "action.colour": card.action.colour,
            "action.hoverSurface": card.action.hoverSurface,
            "action.hoverColour": card.action.hoverColour,
        ]
        out["unused"] = nil
        return out
    }

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

    static var tones: [String: Tone] {
        var out: [String: Tone] = [:]
        for (name, tone) in spec.tone ?? [:] {
            out[name] = Tone(edge: tone.edge, tint: tone.tint, glyph: tone.glyph)
        }
        return out
    }

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
