import XCTest

@testable import Chela

/// Where this client's appearance comes from, now that it does not choose one.
///
/// The rule is the sixth in core/ui/CONVENTIONS.md: the DEVICE flows down and the
/// Control UI's resolved theme flows up. Two things are worth holding still, and
/// neither is visible on screen:
///
/// 1. **`system` is not a colour.** It has to leave the device in charge, or a live
///    system change would stop reaching the app and the page.
/// 2. **there is exactly one value**, so nothing on this client can pin an
///    appearance: the selector, the store and the `saveSettings` field that
///    carried a choice all went together, and a mode that came back would be a
///    compiled-in second control for a choice the Control UI owns.
///
/// The page's own half of the contract (its row, and the patch it used to send) is a
/// page behaviour and is asserted where the page is read, in the desktop's
/// settings-surface test.
final class AppearanceTests: XCTestCase {
    func testSystemLeavesTheDeviceInCharge() {
        XCTAssertNil(
            AppearanceMode.system.colorScheme,
            "a pinned scheme stops a live device change reaching the native chrome"
        )
        XCTAssertEqual(
            AppearanceMode.system.userInterfaceStyle,
            .unspecified,
            "unspecified is what leaves the trait collection with the device"
        )
    }

    func testThereIsOneValueToCarry() {
        XCTAssertEqual(AppearanceMode.allCases, [.system], "an appearance a reader could choose is back")
        XCTAssertEqual(AppearanceMode(rawValue: "light"), nil, "a mode arrives from somewhere again")
        XCTAssertEqual(AppearanceMode(rawValue: "dark"), nil, "a mode arrives from somewhere again")
    }
}

