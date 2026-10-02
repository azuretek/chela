import XCTest

@testable import Chela

/// Parity with the dim's one owner, `--scrim` in `core/ui/ui.css`.
///
/// The value is MIRRORED here rather than read, because the layer that paints it on
/// this client is native and sits outside the page it dims, so there is nothing at
/// runtime to read it from. A mirror drifts, so this reads the declaration out of the
/// stylesheet, the way `core/test/backdrop.test.js` does, and fails when the two
/// disagree. What is asserted there and not here is the upstream reference: that
/// test also reads the Control UI's own drawer backdrop out of an OpenClaw checkout
/// when one is present, which a simulator test has no business reaching for.
///
/// There is no iOS arithmetic left to hold: the sheet is presented undimmed (#127),
/// so the veil is the shared value as it is. That the band above the sheet stays the
/// page's own colour is SheetBandUITests, on a simulator.
final class SurfaceBackdropParityTests: XCTestCase {
    private func stylesheet() throws -> String {
        let url = try Fixtures.root().appendingPathComponent("core/ui/ui.css")
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(text.isEmpty, "ui.css is empty, so this parity check would assert nothing")
        return text
    }

    /// CSS comments removed, so a value quoted in a comment is not read as a
    /// declaration. ui.css documents this token at length right above it.
    private func withoutComments(_ css: String) -> String {
        var out = ""
        var rest = Substring(css)
        while let open = rest.range(of: "/*") {
            out += rest[rest.startIndex..<open.lowerBound]
            guard let close = rest.range(of: "*/", range: open.upperBound..<rest.endIndex) else { return out }
            rest = rest[close.upperBound...]
        }
        return out + rest
    }

    /// Every `--scrim` declaration in source order, as its value text.
    private func scrimDeclarations(_ css: String) -> [String] {
        withoutComments(css).split(separator: "\n").compactMap { line in
            guard let colon = line.range(of: "--scrim:") else { return nil }
            let value = line[colon.upperBound...].trimmingCharacters(in: .whitespaces)
            return value.hasSuffix(";") ? String(value.dropLast()) : value
        }
    }

    /// The alpha of a `rgb(0 0 0 / NN%)` value.
    private func alpha(_ value: String) -> Double? {
        guard let slash = value.range(of: "/") else { return nil }
        var tail = value[slash.upperBound...].trimmingCharacters(in: .whitespaces)
        // The declaration is written `rgb(0 0 0 / 60%)`, so the alpha is inside the
        // function's closing paren: dropping only the percent left "60%)" and every
        // value failed to parse, which read as the mirror disagreeing with ui.css.
        if tail.hasSuffix(")") {
            tail = String(tail.dropLast()).trimmingCharacters(in: .whitespaces)
        }
        guard tail.hasSuffix("%") else { return nil }
        return Double(tail.dropLast()).map { $0 / 100 }
    }

    func testTheMirrorIsTheStylesheetsOwnValue() throws {
        let values = scrimDeclarations(try stylesheet())
        XCTAssertEqual(values.count, 2,
                       "the dim is declared once per appearance block, and ui.css reads " + String(describing: values))
        for value in values {
            let declared = try XCTUnwrap(alpha(value), "the dim is not a black veil with an alpha: \(value)")
            XCTAssertEqual(SurfaceBackdrop.scrimAlpha, declared, accuracy: 0.0001,
                           "the mirror disagrees with ui.css: \(SurfaceBackdrop.scrimAlpha) against \(value)")
        }
    }

    func testTheDimDoesNotFollowTheAppearance() throws {
        let values = scrimDeclarations(try stylesheet())
        XCTAssertEqual(Set(values).count, 1,
                       "the dim is one value in both appearance blocks, and ui.css reads " + String(describing: values))
    }

    func testTheDimIsDarkEnoughToReadAsADim() throws {
        // The same floor core/test/backdrop.test.js asserts, so the two clients cannot
        // drift into a dim that only just registers.
        XCTAssertGreaterThanOrEqual(SurfaceBackdrop.scrimAlpha, 0.55,
                                    "the dim is too light to read as one")
    }
}
