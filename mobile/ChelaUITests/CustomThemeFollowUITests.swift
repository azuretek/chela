import XCTest

/// A theme imported from a palette exporter reaching the app, captured on a
/// simulator: the strips above and below the page and the mark on the home screen
/// follow a swap that changes no attribute on the page's root, in dark and in
/// light. The page is a static stand-in for the Control UI
/// (Fixtures/custom-theme.html) that rewrites its custom-theme style tag the way
/// upstream does, with palettes authored in oklch().
///
/// The assertions for the same claim are CustomThemeFollowTests (the shipped relay
/// and reader, no simulator UI); this is the capture a person can look at, and
/// the phone's half of desktop/scripts/test-custom-theme-follow.js.
///
/// Opt-in: skipped unless the runner is given CLAW_CUSTOM_THEME_FIXTURE, the
/// fixture's URL on a local server (xcodebuild forwards it with the TEST_RUNNER_
/// prefix). CLAW_CUSTOM_THEME_SHOTS names a directory the screenshots are also
/// written to. No gateway and no credential: the token seeded is a placeholder
/// the fixture never reads.
@MainActor
final class CustomThemeFollowUITests: XCTestCase {
    private var shots: URL?
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    private func shot(_ image: XCUIScreenshot, _ name: String) {
        let attachment = XCTAttachment(screenshot: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let shots { try? image.pngRepresentation.write(to: shots.appendingPathComponent(name + ".png")) }
    }

    /// iOS confirms every icon change with its own alert. Accept it if one comes,
    /// and say whether it did: an icon change is the mark following the accent.
    @discardableResult
    private func acceptIconAlert(_ app: XCUIApplication, timeout: TimeInterval = 8) -> Bool {
        for source in [app, springboard] {
            let alert = source.alerts.firstMatch
            if alert.waitForExistence(timeout: timeout) {
                alert.buttons.firstMatch.tap()
                return true
            }
        }
        return false
    }

    private func homeScreen(_ app: XCUIApplication, _ name: String, _ ready: XCUIElement) {
        sleep(1)
        XCUIDevice.shared.press(.home)
        sleep(2)
        shot(XCUIScreen.main.screenshot(), name)
        app.activate()
        XCTAssertTrue(ready.waitForExistence(timeout: 10))
    }

    private func press(_ app: XCUIApplication, _ label: String) {
        let button = app.webViews.buttons[label]
        XCTAssertTrue(button.waitForExistence(timeout: 10), "the fixture offers no \(label) button")
        button.tap()
    }

    func testTheStripsAndTheMarkFollowAStyleTagSwap() throws {
        let env = ProcessInfo.processInfo.environment
        guard let fixture = env["CLAW_CUSTOM_THEME_FIXTURE"] else {
            throw XCTSkip("custom theme capture: needs CLAW_CUSTOM_THEME_FIXTURE")
        }
        continueAfterFailure = true
        if let dir = env["CLAW_CUSTOM_THEME_SHOTS"] {
            shots = URL(fileURLWithPath: dir)
            try? FileManager.default.createDirectory(at: shots!, withIntermediateDirectories: true)
        }

        let app = XCUIApplication()
        app.launchArguments = ["-claw-gateway-url", fixture]
        app.launchEnvironment["OPENCLAW_SEED_TOKEN"] = "fixture-placeholder-not-a-credential"
        app.launch()

        let ready = app.webViews.staticTexts["Fixture ready"]
        XCTAssertTrue(ready.waitForExistence(timeout: 30), "the fixture never painted")
        sleep(2)
        acceptIconAlert(app, timeout: 4)

        // Dark: the first theme, then the second written over it.
        shot(app.screenshot(), "ios-dark-before")
        homeScreen(app, "ios-dark-before-home", ready)
        press(app, "Second theme")
        XCTAssertTrue(acceptIconAlert(app), "the mark did not change for a swap to a green accent (dark)")
        sleep(1)
        shot(app.screenshot(), "ios-dark-after")
        homeScreen(app, "ios-dark-after-home", ready)

        // Light: the first theme again, then the second written over it.
        press(app, "Light mode")
        acceptIconAlert(app, timeout: 4)
        press(app, "First theme")
        acceptIconAlert(app, timeout: 4)
        sleep(1)
        shot(app.screenshot(), "ios-light-before")
        homeScreen(app, "ios-light-before-home", ready)
        press(app, "Second theme")
        XCTAssertTrue(acceptIconAlert(app), "the mark did not change for a swap to a green accent (light)")
        sleep(1)
        shot(app.screenshot(), "ios-light-after")
        homeScreen(app, "ios-light-after-home", ready)
    }
}
