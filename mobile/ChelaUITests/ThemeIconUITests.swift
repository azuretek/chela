import XCTest

/// The icon following the theme and its light or dark mode, and the loading cover
/// holding until the page paints, captured on a simulator against a static
/// stand-in for the Control UI (Fixtures/theme-icon.html). No gateway and no
/// credential: the token seeded is a placeholder the fixture never reads.
///
/// Opt-in: skipped unless the runner is given CLAW_ICON_FIXTURE, the fixture's
/// URL on a local server (xcodebuild forwards it with the TEST_RUNNER_ prefix).
/// CLAW_ICON_SHOTS names a directory the screenshots are also written to.
@MainActor
final class ThemeIconUITests: XCTestCase {
    private var shots: URL?
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    private func shot(_ image: XCUIScreenshot, _ name: String) {
        let attachment = XCTAttachment(screenshot: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let shots { try? image.pngRepresentation.write(to: shots.appendingPathComponent(name + ".png")) }
    }

    /// iOS confirms every icon change with its own alert; accept it and say so.
    private func acceptIconAlert(_ app: XCUIApplication) -> Bool {
        for source in [app, springboard] {
            let alert = source.alerts.firstMatch
            if alert.waitForExistence(timeout: 8) {
                alert.buttons.firstMatch.tap()
                return true
            }
        }
        return false
    }

    /// Back in the app, where nothing should be waiting: a change the app only
    /// makes on returning to the foreground is the fault this test exists for.
    private func backInApp(_ app: XCUIApplication, _ ready: XCUIElement) {
        app.activate()
        XCTAssertTrue(ready.waitForExistence(timeout: 10))
        sleep(2)
        let late = app.alerts.firstMatch.exists || springboard.alerts.firstMatch.exists
        XCTAssertFalse(late, "an icon change arrived on returning to the app rather than on the theme change")
        if late { _ = acceptIconAlert(app) }
    }

    private func homeScreen(_ name: String) {
        sleep(1)
        XCUIDevice.shared.press(.home)
        sleep(2)
        shot(XCUIScreen.main.screenshot(), name)
    }

    func testTheIconFollowsTheThemeAndTheCoverHoldsUntilPaint() throws {
        let env = ProcessInfo.processInfo.environment
        guard let fixture = env["CLAW_ICON_FIXTURE"] else {
            throw XCTSkip("theme icon capture: needs CLAW_ICON_FIXTURE")
        }
        continueAfterFailure = true
        if let dir = env["CLAW_ICON_SHOTS"] {
            shots = URL(fileURLWithPath: dir)
            try? FileManager.default.createDirectory(at: shots!, withIntermediateDirectories: true)
        }

        let app = XCUIApplication()
        app.launchArguments = ["-claw-gateway-url", fixture]
        app.launchEnvironment["OPENCLAW_SEED_TOKEN"] = "fixture-placeholder-not-a-credential"
        app.launch()

        // The load finishes at once and the fixture paints 2 s later: the cover
        // must be up in between.
        let cover = app.descendants(matching: .any)["loading-cover"]
        XCTAssertTrue(cover.waitForExistence(timeout: 5), "no loading cover while the page had not painted")
        shot(app.screenshot(), "01-cover-before-first-paint")
        let ready = app.webViews.staticTexts["Fixture ready"]
        XCTAssertTrue(ready.waitForExistence(timeout: 20), "the fixture never painted")
        sleep(1)
        XCTAssertFalse(cover.exists, "the cover stayed up over a painted page")
        shot(app.screenshot(), "02-page-painted")

        XCTAssertTrue(acceptIconAlert(app), "no icon change for the first theme (blue, dark)")
        homeScreen("03-home-blue-dark")

        backInApp(app, ready)
        app.webViews.buttons["Light mode"].tap()
        XCTAssertTrue(acceptIconAlert(app), "no icon change for a light/dark change")
        homeScreen("04-home-blue-light")

        backInApp(app, ready)
        app.webViews.buttons["Green theme"].tap()
        XCTAssertTrue(acceptIconAlert(app), "no icon change for a theme change")
        homeScreen("05-home-green-light")

        // A reload is a new load: covered again until the new page paints.
        backInApp(app, ready)
        app.webViews.buttons["Reload"].tap()
        XCTAssertTrue(cover.waitForExistence(timeout: 5), "no cover over a reload")
        shot(app.screenshot(), "06-cover-during-reload")
        XCTAssertTrue(ready.waitForExistence(timeout: 20))
        sleep(1)
        XCTAssertFalse(cover.exists)
        shot(app.screenshot(), "07-reload-painted")
    }
}
