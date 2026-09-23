import XCTest

@testable import Chela

/// The iOS half of the themed icon: the bundled spec is the repository's, and a
/// theme is recognised from the accent forms the probe reports. core/test/
/// app-icons.test.js holds the same rules for the desktop.
final class AppIconsTests: XCTestCase {
    func testTheBundledSpecIsTheRepositorysByteForByte() throws {
        let bundled = try XCTUnwrap(Bundle.main.url(forResource: "app-icons", withExtension: "json"), "app-icons.json is not in the bundle")
        let repo = try Fixtures.root().appendingPathComponent("core/spec/app-icons.json")
        XCTAssertEqual(try Data(contentsOf: bundled), try Data(contentsOf: repo))
    }

    func testThereIsOnePrimaryThemeAndItHasNoAlternateName() throws {
        XCTAssertEqual(AppIcons.themes.filter(\.isPrimary).count, 1)
        XCTAssertNil(try XCTUnwrap(AppIcons.primary).alternateIconName)
    }

    func testHexReadsEveryFormTheAccentArrivesIn() {
        XCTAssertEqual(AppIcons.hex("rgb(90, 182, 216)"), "#5ab6d8")
        XCTAssertEqual(AppIcons.hex("rgba(90, 182, 216, 0.5)"), "#5ab6d8")
        XCTAssertEqual(AppIcons.hex("rgb(90 182 216)"), "#5ab6d8")
        XCTAssertEqual(AppIcons.hex("#5AB6D8"), "#5ab6d8")
        XCTAssertEqual(AppIcons.hex("#fff"), "#ffffff")
        XCTAssertNil(AppIcons.hex("oklch(0.7 0.1 350)"))
        XCTAssertNil(AppIcons.hex(nil))
    }

    func testAThemeIsRecognisedInEitherModeAndItsIconIsBundled() throws {
        let tide = try XCTUnwrap(AppIcons.theme(forAccent: "#1f6f8f"))
        XCTAssertEqual(tide.id, "tide")
        XCTAssertEqual(tide.alternateIconName, "AppIcon-tide")
        XCTAssertNil(AppIcons.theme(forAccent: "rgb(1, 2, 3)"))
        // actool lists every icon set under CFBundleAlternateIcons; a theme missing
        // there could be offered and then refused.
        let icons = Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any]
        let alternates = (icons?["CFBundleAlternateIcons"] as? [String: Any]) ?? [:]
        for theme in AppIcons.themes where !theme.isPrimary {
            XCTAssertNotNil(alternates[theme.alternateIconName ?? ""], "\(theme.id) has no alternate icon in the built app")
        }
    }
}
