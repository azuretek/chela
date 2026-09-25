import XCTest

@testable import Chela

/// The iOS half of the themed icon: the bundled spec is the repository's, and an
/// accent picks the same bucket the desktop's core/app-icons.js picks, checked
/// against the samples that module wrote into the spec.
final class AppIconsTests: XCTestCase {
    func testTheBundledSpecIsTheRepositorysByteForByte() throws {
        let bundled = try XCTUnwrap(Bundle.main.url(forResource: "app-icons", withExtension: "json"), "app-icons.json is not in the bundle")
        let repo = try Fixtures.root().appendingPathComponent("core/spec/app-icons.json")
        XCTAssertEqual(try Data(contentsOf: bundled), try Data(contentsOf: repo))
    }

    func testThereIsOnePrimaryBucketAndItHasNoAlternateName() throws {
        XCTAssertEqual(AppIcons.buckets.filter(\.primary).count, 1)
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

    func testEverySampleChoosesTheBucketTheDesktopChose() throws {
        let spec = try XCTUnwrap(AppIcons.spec)
        XCTAssertFalse(spec.samples.isEmpty)
        for sample in spec.samples {
            XCTAssertEqual(AppIcons.bucket(forAccent: sample.accent)?.id, sample.bucket, "\(sample.accent)")
        }
        XCTAssertEqual(AppIcons.bucket(forAccent: nil), AppIcons.primary)
    }

    // MARK: - Following the theme

    func testEveryBucketAndModeIsAnAlternateIconInTheBuiltApp() {
        // actool lists every icon set under CFBundleAlternateIcons; a name the
        // follower asks for that is missing there is refused by iOS.
        let icons = Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any]
        let alternates = (icons?["CFBundleAlternateIcons"] as? [String: Any]) ?? [:]
        for bucket in AppIcons.buckets {
            for mode in ["light", "dark"] {
                XCTAssertNotNil(alternates[bucket.alternateIconName(mode: mode)], "\(bucket.id) \(mode) has no alternate icon in the built app")
            }
        }
    }

    func testEveryAlternateIconCarriesItsOwnArt() throws {
        // A set that exists but holds a copy of another one's art switches to an
        // icon that looks unchanged, which is the fault this replaces.
        let sets = try Fixtures.root().appendingPathComponent("mobile/Chela/Assets.xcassets")
        var seen: [Data: String] = [:]
        for bucket in AppIcons.buckets {
            for mode in ["light", "dark"] {
                let name = bucket.alternateIconName(mode: mode)
                let png = sets.appendingPathComponent("\(name).appiconset/\(bucket.id)-\(mode).png")
                let data = try Data(contentsOf: png)
                XCTAssertNil(seen[data], "\(name) has the same art as \(seen[data] ?? "")")
                seen[data] = name
            }
        }
    }

    func testTheModeIsTheInterfacesAndTheDeviceOnlyWhenItResolvedNone() {
        XCTAssertEqual(AppIcons.mode(scheme: "light", deviceIsDark: true), "light")
        XCTAssertEqual(AppIcons.mode(scheme: "dark", deviceIsDark: false), "dark")
        XCTAssertEqual(AppIcons.mode(scheme: nil, deviceIsDark: true), "dark")
        XCTAssertEqual(AppIcons.mode(scheme: nil, deviceIsDark: false), "light")
    }

    @MainActor
    func testAThemeChangeSwitchesTheIcon() async throws {
        AppIconFollower.reset()
        let app = FakeIcons()
        let blue = try XCTUnwrap(AppIcons.spec?.samples.first { $0.bucket == "h232" })
        let green = try XCTUnwrap(AppIcons.spec?.samples.first { $0.bucket == "h142" })
        XCTAssertEqual(AppIconFollower.follow(tokens: ["--accent": blue.accent, ThemeTokens.schemeKey: "dark"], deviceIsDark: true, app: app), "AppIcon-h232-dark")
        await app.settled()
        XCTAssertEqual(AppIconFollower.follow(tokens: ["--accent": green.accent, ThemeTokens.schemeKey: "dark"], deviceIsDark: true, app: app), "AppIcon-h142-dark")
        await app.settled()
        XCTAssertEqual(app.requests, ["AppIcon-h232-dark", "AppIcon-h142-dark"])
    }

    @MainActor
    func testALightDarkChangeSwitchesTheIcon() async throws {
        AppIconFollower.reset()
        let app = FakeIcons()
        let accent = try XCTUnwrap(AppIcons.spec?.samples.first { $0.bucket == "h52" }).accent
        AppIconFollower.follow(tokens: ["--accent": accent, ThemeTokens.schemeKey: "light"], deviceIsDark: false, app: app)
        await app.settled()
        AppIconFollower.follow(tokens: ["--accent": accent, ThemeTokens.schemeKey: "dark"], deviceIsDark: false, app: app)
        await app.settled()
        XCTAssertEqual(app.requests, ["AppIcon-h52-light", "AppIcon-h52-dark"])
    }

    @MainActor
    func testNothingIsAskedWhenTheIconAlreadyMatchesOrTheresNothingToRead() async throws {
        AppIconFollower.reset()
        let app = FakeIcons()
        let accent = try XCTUnwrap(AppIcons.spec?.samples.first { $0.bucket == "h52" }).accent
        app.current = "AppIcon-h52-dark"
        XCTAssertNil(AppIconFollower.follow(tokens: ["--accent": accent, ThemeTokens.schemeKey: "dark"], deviceIsDark: true, app: app))
        XCTAssertNil(AppIconFollower.follow(tokens: [:], deviceIsDark: true, app: app), "no page yet must not move the icon")
        app.active = false
        XCTAssertNil(AppIconFollower.follow(tokens: ["--accent": accent, ThemeTokens.schemeKey: "light"], deviceIsDark: true, app: app), "iOS refuses a change from the background")
        await app.settled()
        XCTAssertEqual(app.requests, [])
    }
}

@MainActor
private final class FakeIcons: AlternateIconSetting {
    var supportsAlternateIcons = true
    var current: String?
    var active = true
    var requests: [String] = []
    var alternateIconName: String? { current }
    var isActive: Bool { active }
    func setAlternateIconName(_ name: String?) async throws {
        requests.append(name ?? "")
        current = name
    }
    /// Lets the follower's Task run.
    func settled() async { for _ in 0..<5 { await Task.yield() } }
}
