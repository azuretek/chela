import XCTest

@testable@testable import Chela

/// The app frame inset at the phone's half: what the spec gave this client, and the
/// statement the web view puts in the page.
///
/// The behaviour this exists for is a page whose fixed-position overlay covers the
/// status bar and the home indicator, which is asserted where the rule is actually
/// built, in the app-frame-inset test beside the desktop suite and in the desktop
/// guard. What is asserted here is the half this client owns: that the spec reached
/// the bundle, that the fields it publishes are the spec's own rather than restated,
/// and that the installation carries all three parts in the order the script reads
/// them.
@MainActor
final class AppFrameInsetTests: XCTestCase {
    func testTheSpecWasBundledAndRead() throws {
        XCTAssertFalse(AppFrameInset.global.isEmpty, "the global name did not reach the bundle")
        XCTAssertFalse(AppFrameInset.properties.isEmpty, "the published property names did not reach the bundle")
        XCTAssertFalse(AppFrameInset.clampSelectors.isEmpty, "the clamped selectors did not reach the bundle")
        XCTAssertEqual(
            Set(AppFrameInset.properties.keys),
            Set(["top", "right", "bottom", "left"]),
            "all four edges are published, even where a client takes no band"
        )
        XCTAssertTrue(
            AppFrameInset.clampSelectors.contains("openclaw-assistant-panel"),
            "the surface that was reported is the one the rule names"
        )
        XCTAssertTrue(
            AppFrameInset.boundSelectors.contains(".shell"),
            "the page's own viewport-height container is bounded too: it is sized in dvh, which is the display rather than the padded box the client insets"
        )
    }

    func testTheInstallationHandsOverTheSpecThenTheNumbersThenTheScript() throws {
        let source = AppFrameInset.installation(top: 59, bottom: 34)
        XCTAssertFalse(source.isEmpty, "a build without the spec installs nothing")

        let config = source.range(of: "__clawFrameInsetConfig =")
        XCTAssertNotNil(config, "the spec's own fields are set first, because the script reads them as it runs")

        let inset = source.range(of: "\"top\":59")
        XCTAssertNotNil(inset, "this client's numbers are published as numbers, not left to the page's own value")
        XCTAssertNotNil(source.range(of: "\"bottom\":34"))

        let script = source.range(of: "__clawFrameInset = { set: set")
        XCTAssertNotNil(script, "and the shared script runs last")
        XCTAssertLessThan(config!.lowerBound, inset!.lowerBound, "ordered: config, then the numbers, then the script")
        XCTAssertLessThan(inset!.lowerBound, script!.lowerBound)
    }

    func testZeroIsPublishedRatherThanOmitted() throws {
        let source = AppFrameInset.installation(top: 0, bottom: 0)
        XCTAssertNotNil(
            source.range(of: "\"top\":0"),
            "an edge a client takes nothing from is published as zero: an absent property would leave the page's own value in place"
        )
    }

    func testTheSetterStatementCallsTheSetterTheScriptLeft() throws {
        let source = AppFrameInset.setStatement(top: 12, bottom: 0)
        XCTAssertTrue(source.contains("window.\(AppFrameInset.global)"), "the page's setter is looked up on the global the script left")
        XCTAssertTrue(source.contains(".set("), "and called, rather than the page being re-installed")
        XCTAssertTrue(source.contains("\"top\":12"))
    }
}

