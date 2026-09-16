import XCTest

@testable import Claw

/// The one preference this client decides for itself.
///
/// Three things about it are worth holding still, and none of them is visible on
/// screen:
///
/// 1. **the three names are the three the page offers**, because the row sends
///    back one of its own option values and the host reads it as a mode. This test
///    reads the shared page's markup and asserts the two lists agree in both
///    directions, which is the same arrangement the settings spec has.
/// 2. **an install that has never been asked follows the device**, and a stored
///    value that is not one of the three does too, rather than crashing or
///    pinning an appearance nobody chose.
/// 3. **`system` is not a colour.** It has to leave the device in charge, or a
///    live change would stop reaching the app, which is the whole point of the
///    setting.
///
/// The page's own half of the contract (a change on the picker arriving as a
/// `saveSettings` patch) is a page behaviour and is asserted where the page is
/// read, in the desktop's settings-surface test.
final class AppearanceTests: XCTestCase {
    /// A store on its own defaults domain, so a test cannot read or leave the
    /// device's real value behind.
    @MainActor
    private func store(_ name: String) -> (AppearanceStore, UserDefaults) {
        let defaults = UserDefaults(suiteName: "claw.tests.appearance.\(name)")!
        defaults.removePersistentDomain(forName: "claw.tests.appearance.\(name)")
        return (AppearanceStore(defaults: defaults, key: "mode"), defaults)
    }

    @MainActor
    func testAnInstallThatHasNeverBeenAskedFollowsTheDevice() {
        let (appearance, _) = store(#function)
        XCTAssertEqual(appearance.mode, .system)
    }

    @MainActor
    func testAChoiceIsRememberedAcrossLaunches() {
        let (first, defaults) = store(#function)
        first.choose(.dark)
        // A second store on the same domain is what the next launch builds.
        let second = AppearanceStore(defaults: defaults, key: "mode")
        XCTAssertEqual(second.mode, .dark)
    }

    @MainActor
    func testAStoredValueThatIsNotAModeReadsAsSystemRatherThanCrashing() {
        let (appearance, defaults) = store(#function)
        defaults.set("neon", forKey: "mode")
        XCTAssertEqual(AppearanceStore(defaults: defaults, key: "mode").mode, .system)
        appearance.choose(.light)
        XCTAssertEqual(appearance.mode, .light)
    }

    @MainActor
    func testThePageReadsTheModeFromStateRatherThanFromAnywhereElse() {
        // `state.appearance.mode` is documented as the ONLY place the page reads
        // it from, so the shape here is the contract.
        let (appearance, _) = store(#function)
        XCTAssertEqual(appearance.state["mode"] as? String, "system")
        appearance.choose(.dark)
        XCTAssertEqual(appearance.state["mode"] as? String, "dark")
    }

    func testSystemLeavesTheDeviceInChargeAndTheOtherTwoPinIt() {
        XCTAssertNil(AppearanceMode.system.colorScheme, "system must not pin a scheme, or a live device change stops reaching the app")
        XCTAssertEqual(AppearanceMode.light.colorScheme, .light)
        XCTAssertEqual(AppearanceMode.dark.colorScheme, .dark)

        XCTAssertEqual(AppearanceMode.system.userInterfaceStyle, .unspecified, "unspecified is what leaves the trait collection to the device")
        XCTAssertEqual(AppearanceMode.light.userInterfaceStyle, .light)
        XCTAssertEqual(AppearanceMode.dark.userInterfaceStyle, .dark)
    }

    func testAnUnknownModeIsRefusedRatherThanDefaulted() {
        XCTAssertEqual(AppearanceMode.named("light"), .light)
        XCTAssertEqual(AppearanceMode.named("dark"), .dark)
        XCTAssertEqual(AppearanceMode.named("system"), .system)
        // The page sends what the page offers, so anything else is a bug on one
        // side of the contract, and reading it as `system` would hide it behind a
        // change nobody asked for.
        XCTAssertNil(AppearanceMode.named("neon"))
        XCTAssertNil(AppearanceMode.named(""))
        XCTAssertNil(AppearanceMode.named(nil))
        XCTAssertNil(AppearanceMode.named(3))
    }

    func testTheModesAreExactlyTheOptionsTheSharedPageOffers() throws {
        // Both directions: a mode with no option is one the page could never
        // choose, and an option with no mode is one that would be sent and
        // refused. Read from core/ui/settings.html rather than restated, for the
        // same reason the settings-surface test reads the spec.
        let html = try String(
            contentsOf: Fixtures.root().appendingPathComponent("core").appendingPathComponent("ui").appendingPathComponent("settings.html"),
            encoding: .utf8
        )
        let block = try XCTUnwrap(
            /<select id="appearance"[^>]*>([\s\S]*?)<\/select>/.firstMatch(in: html)?.output.1,
            "the appearance picker was not found in settings.html"
        )
        let offered = Set(block.matches(of: /<option value="([a-z]+)"/.self).map { String($0.output.1) })
        XCTAssertFalse(offered.isEmpty, "the picker offers nothing")

        let modes = Set(AppearanceMode.allCases.map(\.rawValue))
        XCTAssertEqual(offered, modes, "the picker and this client disagree about the appearance modes")
    }
}
