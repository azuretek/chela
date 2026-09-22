import XCTest

@testable import Chela

/// Parity with `core/appearance.js` `pageColorScheme`, proven against the same
/// golden pairs the JS side asserts in `core/test/fixtures.test.js` from
/// `core/fixtures/appearance.json`.
///
/// Abi, 2026-09-20: "as long as we are abstracting so the logic is exactly the
/// same we are good", and "we should not diverge for the same features ever". The
/// appearance decision is one rule, and this is what holds the two clients to it:
/// the decision lives in core, both clients reproduce the same fixtures, and a
/// change to the rule fails here until the Swift moves with it. The client-specific
/// half (mapping the answer onto `overrideUserInterfaceStyle` vs
/// `nativeTheme.themeSource`) is a one-line adapter and is deliberately NOT shared,
/// because it is a different platform API; the DECISION is.
final class AppearanceParityTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Case: Decodable {
            struct Input: Decodable { let mode: String? }
            let name: String
            let input: Input
            let output: String
        }
        let cases: [Case]
    }

    func testPageColorSchemeReproducesEveryFixture() throws {
        let fixture: Fixture = try Fixtures.load("appearance")
        // An empty case list would make the loop vacuously green, the one thing a
        // parity test cannot afford.
        XCTAssertFalse(fixture.cases.isEmpty, "expected cases in core/fixtures/appearance.json")

        for testCase in fixture.cases {
            XCTAssertEqual(
                ThemeTokens.pageColorScheme(mode: testCase.input.mode),
                testCase.output,
                "\(testCase.name): pageColorScheme(\(String(describing: testCase.input.mode)))"
            )
        }
    }

    /// The adapter half, pinned separately so a fixture edit cannot quietly take
    /// the trait mapping with it: "system" must be `.unspecified`, which is what
    /// leaves the device driving the appearance the way the desktop's
    /// `themeSource = 'system'` does.
    func testTraitAdapterMapsSchemeToStyle() {
        XCTAssertEqual(ThemeTokens.pageTrait(tokens: ["--color-scheme": "light"], own: .unspecified), .light)
        XCTAssertEqual(ThemeTokens.pageTrait(tokens: ["--color-scheme": "dark"], own: .unspecified), .dark)
        // No scheme in the palette -> the client's own appearance, which is
        // `.unspecified` for the one AppearanceMode this client has, so the device
        // answers. This is the branch that keeps the Control UI's System mode
        // reading the real OS rather than a pin.
        XCTAssertEqual(ThemeTokens.pageTrait(tokens: [:], own: .unspecified), .unspecified)
    }
}
