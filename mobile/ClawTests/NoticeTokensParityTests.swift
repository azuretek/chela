import SwiftUI
import XCTest

@testable import Claw

/// Parity with `core/spec/tokens.json`, the one owner of the values both banners
/// draw with.
///
/// The desktop resolves that file as CSS; this client mirrors it as constants,
/// because a shipped app cannot read a file that lives in the repo. A mirror is a
/// copy, and a copy drifts, so this test is the thing that keeps it honest: every
/// value below is asserted against the spec, and a value that moves in the spec
/// fails here until it moves here too. That is the whole reason the two clients
/// cannot end up looking different.
///
/// The provenance maps are asserted as well as the values. A colour added to the
/// spec without a note saying which Control UI file it came from is a value nobody
/// can re-derive, and the note is the part that makes a drift findable.
final class NoticeTokensParityTests: XCTestCase {
    private func spec() throws -> TokensSpec {
        try Fixtures.loadSpec("tokens")
    }

    func testThePaletteMirrorsTheSpecInBothModes() throws {
        let spec = try spec()
        XCTAssertEqual(Set(spec.css.keys), Set(NoticeTokens.modes), "the spec's modes are not the two we mirror")
        for mode in NoticeTokens.modes {
            let expected = try XCTUnwrap(spec.css[mode], "no \(mode) palette in the spec")
            XCTAssertFalse(expected.isEmpty, "the \(mode) palette is empty")
            let actual = mode == "light" ? NoticeTokens.light : NoticeTokens.dark
            XCTAssertEqual(actual, expected, "the \(mode) palette disagrees with the spec")
        }
    }

    func testTheShapeMirrorsTheSpec() throws {
        let spec = try spec()
        XCTAssertEqual(NoticeTokens.shape, spec.shape, "the shape tokens disagree with the spec")
    }

    func testTheTypeScaleMirrorsTheSpec() throws {
        let spec = try spec()
        XCTAssertEqual(NoticeTokens.sizes, spec.type.size, "the type sizes disagree with the spec")
        XCTAssertEqual(NoticeTokens.weights, spec.type.weight, "the type weights disagree with the spec")
        XCTAssertEqual(NoticeTokens.leadings, spec.type.leading, "the line heights disagree with the spec")
    }

    func testTheCardMirrorsTheSpecFlattened() throws {
        let spec = try spec()
        XCTAssertEqual(NoticeTokens.card, try spec.flattenedCard(), "the card's geometry disagrees with the spec")
        XCTAssertFalse(NoticeTokens.card.isEmpty, "an empty card would make the comparison above vacuous")
    }

    func testTheToneMapMirrorsTheSpec() throws {
        let spec = try spec()
        XCTAssertEqual(Set(spec.tone.keys), Set(NoticeTokens.toneNames), "the spec has a tone we do not mirror")
        for (name, expected) in spec.tone {
            let actual = try XCTUnwrap(NoticeTokens.tones[name], "no mirror for the \(name) tone")
            XCTAssertEqual(actual.edge, expected.edge, "\(name) reads the wrong edge token")
            XCTAssertEqual(actual.tint, expected.tint, "\(name) reads the wrong tint token")
            XCTAssertEqual(actual.glyph, expected.glyph, "\(name) draws the wrong glyph")
        }
    }

    func testEveryValueCarriesItsSource() throws {
        let spec = try spec()
        for name in spec.css["dark"]!.keys {
            XCTAssertNotNil(spec.provenance[name], "\(name) has no recorded source")
        }
        for name in spec.shape.keys {
            XCTAssertNotNil(spec.shapeProvenance[name], "\(name) has no recorded source")
        }
        for name in spec.card.keys where !spec.cardProvenance.keys.contains(name) {
            // A nested object is recorded per leaf, so the group itself is not
            // expected to have its own line.
            guard case .nested(let leaves) = spec.card[name] else {
                XCTFail("\(name) has no recorded source")
                continue
            }
            for leaf in leaves.keys {
                XCTAssertNotNil(spec.cardProvenance["\(name).\(leaf)"], "\(name).\(leaf) has no recorded source")
            }
        }
    }

    func testEveryToneResolvesToADifferentColourFromTheCardSurface() throws {
        // A tone that resolves to the card's own surface is a stripe nobody can
        // see, which is what an info tone pointed at a neutral grey used to be.
        for mode in NoticeTokens.modes {
            let surface = try XCTUnwrap(NoticeTokens.resolve("--bg-elevated", mode: mode), "\(mode): no card surface")
            var seen: [String: String] = [:]
            for tone in NoticeTokens.toneNames {
                let resolved = try XCTUnwrap(NoticeTokens.tone(tone, mode: mode), "\(mode): the \(tone) tone does not resolve")
                XCTAssertNotEqual(resolved.edgeColour, surface, "\(mode): the \(tone) edge is the card's own surface")
                if let other = seen[resolved.edgeColour] {
                    XCTFail("\(mode): \(tone) and \(other) share one colour, so they are one tone")
                }
                seen[resolved.edgeColour] = tone
                // And the colours have to be parseable, since the view builds a
                // Color from them and would silently fall back on a bad one.
                XCTAssertNotNil(Color(css: resolved.edgeColour), "\(mode): \(tone) is not a colour: \(resolved.edgeColour)")
                XCTAssertNotNil(Color(css: resolved.tintColour), "\(mode): \(tone) tint is not a colour: \(resolved.tintColour)")
            }
        }
    }

    func testResolveFollowsATokenAndRefusesTheUnknown() throws {
        XCTAssertEqual(NoticeTokens.resolve("--danger", mode: "dark"), "#f87171")
        XCTAssertEqual(NoticeTokens.resolve("var(--danger)", mode: "dark"), "#f87171")
        XCTAssertEqual(NoticeTokens.resolve("--danger", mode: "light"), "#b91c1c")
        XCTAssertNil(NoticeTokens.resolve("--nowhere", mode: "dark"))
        // The card's radius is recorded as a token name, so a caller that reads it
        // through cardValue gets a length and not the name of one.
        XCTAssertEqual(NoticeTokens.cardValue("radius", mode: "dark"), "14px")
        XCTAssertNil(NoticeTokens.cardValue("nothing-here", mode: "dark"))
    }

    func testTheStylesheetParsersReadTheSpecFormat() throws {
        // The SwiftUI side converts CSS lengths, paddings, shadows and the easing
        // curve, so a spec written in a shape those cannot read has to fail here
        // rather than quietly falling back at the point of drawing.
        let spec = try spec()
        XCTAssertEqual(CSSLength("28px"), 28)
        XCTAssertEqual(CSSLength("1.5"), 1.5)
        XCTAssertNil(CSSLength("28rem"), "a unit we do not draw in should not parse as pixels")
        let padding = try CSSPadding(spec.paddingText)
        XCTAssertEqual(padding.top, 11)
        XCTAssertEqual(padding.leading, 14)
        let shadow = CSSShadow(spec.shape["--shadow-sm"])
        XCTAssertEqual(shadow.x, 0)
        XCTAssertEqual(shadow.y, 1)
        XCTAssertEqual(shadow.blur, 2)
        // The form a shadow's colour is written in, rather than the whole shadow:
        // the parser reads the colour off the end of it, and a channel it cannot
        // read would leave SwiftUI drawing its own default shadow instead.
        XCTAssertNotNil(Color(css: "rgba(0, 0, 0, 0.25)"), "the rgba form is not parseable")
        XCTAssertNotNil(Color(css: "#f87171"), "the hex form is not parseable")
        XCTAssertNil(Color(css: "0 1px 2px rgba(0, 0, 0, 0.25)"), "a whole shadow is not a colour")
        let bezier = CSSBezier(spec.shape["--ease-out"])
        XCTAssertEqual(bezier.a, 0.16, accuracy: 0.0001)
        XCTAssertEqual(bezier.d, 1, accuracy: 0.0001)
        XCTAssertEqual(CSSMilliseconds(spec.shape["--duration-normal"]), 0.18, accuracy: 0.0001)
    }
}

/// `core/spec/tokens.json`, as far as this client reads it.
struct TokensSpec: Decodable {
    let css: [String: [String: String]]
    let shape: [String: String]
    let provenance: [String: String]
    let shapeProvenance: [String: String]
    let type: TypeScale
    let card: [String: CardValue]
    let cardProvenance: [String: String]
    let tone: [String: Tone]

    struct TypeScale: Decodable {
        let font: [String: String]
        let size: [String: String]
        let weight: [String: Int]
        let leading: [String: Double]
    }

    struct Tone: Decodable {
        let edge: String
        let tint: String
        let glyph: String
    }

    /// A card value is either a literal, a token name, or one nested level of
    /// those, so it decodes as either.
    enum CardValue: Decodable {
        case text(String)
        case nested([String: String])

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let text = try? container.decode(String.self) {
                self = .text(text)
                return
            }
            self = .nested(try container.decode([String: String].self))
        }
    }

    /// Every leaf of the card section, with a nested group's leaves named
    /// `group.leaf`, matching how the desktop flattens the same object into custom
    /// properties.
    func flattenedCard() throws -> [String: String] {
        var flat: [String: String] = [:]
        for (name, value) in card {
            switch value {
            case .text(let text): flat[name] = text
            case .nested(let leaves):
                for (leaf, text) in leaves { flat["\(name).\(leaf)"] = text }
            }
        }
        return flat
    }

    /// The padding, for the parser test. A missing one is a spec this client
    /// cannot draw, so it throws rather than returning a default.
    var paddingText: String {
        get throws {
            guard case .text(let text)? = card["padding"] else {
                throw Fixtures.Failure.noSuchDirectory("card.padding")
            }
            return text
        }
    }
}
