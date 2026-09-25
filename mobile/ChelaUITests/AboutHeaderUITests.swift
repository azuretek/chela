import XCTest

/// The About page as it draws on a simulator: the header mark on the card
/// headings' line and --space-3 from its name (#86). AboutLayoutTests asserts the
/// geometry; this is the capture a person can look at.
///
/// Opt-in: skipped unless the runner is given CLAW_ABOUT_SHOTS, a directory the
/// screenshot is also written to (xcodebuild forwards it with the TEST_RUNNER_
/// prefix).
@MainActor
final class AboutHeaderUITests: XCTestCase {
    func testTheAboutHeaderAsDrawn() throws {
        guard let dir = ProcessInfo.processInfo.environment["CLAW_ABOUT_SHOTS"] else {
            throw XCTSkip("About capture: needs CLAW_ABOUT_SHOTS")
        }
        let shots = URL(fileURLWithPath: dir)
        try? FileManager.default.createDirectory(at: shots, withIntermediateDirectories: true)
        let app = XCUIApplication()
        app.launchArguments = ["-claw-open-about"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Updates"].waitForExistence(timeout: 20) || app.webViews.staticTexts["Updates"].waitForExistence(timeout: 5),
                      "the About page never drew its Updates card")
        sleep(2)
        let image = app.screenshot()
        let attachment = XCTAttachment(screenshot: image)
        attachment.name = "ios-about"
        attachment.lifetime = .keepAlways
        add(attachment)
        try image.pngRepresentation.write(to: shots.appendingPathComponent("ios-about.png"))
    }
}
