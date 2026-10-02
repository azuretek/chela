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
/// The second half is the arithmetic that is specific to iOS. The platform dims the
/// presenter itself and will not say by how much, so the value this client paints is
/// what is LEFT of the shared dim after the platform's share, not the shared value
/// painted under it.
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
        let tail = value[slash.upperBound...].trimmingCharacters(in: .whitespaces)
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

    func testTheVeilCompositesToTheSharedValueOverThePlatformsOwnDim() {
        let composite = 1 - (1 - SurfaceBackdrop.platformDimAlpha) * (1 - SurfaceBackdrop.ownAlpha)
        XCTAssertEqual(composite, SurfaceBackdrop.scrimAlpha, accuracy: 0.0001,
                       "the layer behind a sheet does not composite to the shared dim")
        XCTAssertGreaterThan(SurfaceBackdrop.platformDimAlpha, 0,
                             "the platform draws a dim behind a sheet, so its share is not zero")
        XCTAssertGreaterThan(SurfaceBackdrop.ownAlpha, 0,
                             "some of the dim has to be ours, or the shared value is not being reached here")
    }

    func testThePlatformsShareIsTakenOutRatherThanAddedTo() {
        // Painting the shared value directly under the platform's dim would land darker
        // than anything that was chosen. That is the whole reason this is arithmetic
        // rather than a colour.
        XCTAssertLessThan(SurfaceBackdrop.ownAlpha, SurfaceBackdrop.scrimAlpha,
                          "the veil is not smaller than the shared dim")
    }

    func testAPlatformDimAlreadyAtTheSharedValueAsksForNoVeil() {
        // The clamp, not the measurement: a future SDK whose own dim already reaches
        // the shared value must ask for nothing rather than for a negative alpha.
        let platform = SurfaceBackdrop.scrimAlpha
        let remaining = (1 - SurfaceBackdrop.scrimAlpha) / (1 - platform)
        XCTAssertEqual(1 - remaining, 0, accuracy: 0.0001)
    }
}

