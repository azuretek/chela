import XCTest

/// Send, background, foreground, send, against a live gateway: the phone's half
/// of the wake and reconnect proof (core/wake.js). The backgrounding is the real
/// scenePhase transition a person makes by leaving the app, so the rule hears
/// exactly what it hears in the field.
///
/// Opt-in, because it needs a gateway and a credential: skipped unless the runner
/// is given CLAW_WAKE_GATEWAY and OPENCLAW_SEED_TOKEN (xcodebuild forwards them
/// with the TEST_RUNNER_ prefix). The token goes to the app through its debug
/// seed, which is compiled out of a release build, and is never logged.
@MainActor
final class WakeReconnectUITests: XCTestCase {
    private var shots: URL?

    private func shot(_ app: XCUIApplication, _ name: String) {
        let png = app.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let shots { try? png.write(to: shots.appendingPathComponent(name + ".png")) }
    }

    private func send(_ app: XCUIApplication, _ text: String) {
        let composer = app.webViews.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 60), "no composer to send into")
        composer.tap()
        // The keyboard's one-time slide-to-type tip covers the page on a fresh
        // simulator; it is dismissed the way a person dismisses it.
        let tip = app.buttons["Continue"]
        if tip.exists && tip.isHittable { tip.tap(); composer.tap() }
        composer.typeText(text)
        // Pressed rather than Return: the phone layout of the Control UI treats
        // Return as a new line, which left the first run's message in the draft.
        let sendButton = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "send")).firstMatch
        XCTAssertTrue(sendButton.waitForExistence(timeout: 10), "no send button")
        sendButton.tap()
    }

    private func waitForReply(_ app: XCUIApplication, _ marker: String, timeout: TimeInterval) -> Bool {
        let reply = app.webViews.staticTexts.matching(NSPredicate(format: "label == %@", marker)).firstMatch
        return reply.waitForExistence(timeout: timeout)
    }

    private func waitForComposer(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let composer = app.webViews.textViews.firstMatch
        let back = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Back to app")).firstMatch
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if back.exists && back.isHittable {
                back.tap()
            } else if composer.waitForExistence(timeout: 3) {
                return true
            }
            sleep(2)
        }
        return composer.exists
    }

    func testSendBackgroundForegroundSend() throws {
        let env = ProcessInfo.processInfo.environment
        guard let gateway = env["CLAW_WAKE_GATEWAY"], let token = env["OPENCLAW_SEED_TOKEN"], !token.isEmpty else {
            throw XCTSkip("live wake proof: needs CLAW_WAKE_GATEWAY and OPENCLAW_SEED_TOKEN")
        }
        continueAfterFailure = true
        let run = env["CLAW_WAKE_RUN"] ?? String(Int(Date().timeIntervalSince1970), radix: 36)
        if let dir = env["CLAW_WAKE_SHOTS"] {
            shots = URL(fileURLWithPath: dir)
            try? FileManager.default.createDirectory(at: shots!, withIntermediateDirectories: true)
        }
        let background = TimeInterval(env["CLAW_WAKE_BACKGROUND_SECONDS"] ?? "") ?? 30

        let app = XCUIApplication()
        app.launchArguments = ["-claw-gateway-url", gateway]
        app.launchEnvironment["OPENCLAW_SEED_TOKEN"] = token
        app.launch()

        // Long, because a first launch of a new simulator waits on the gateway
        // approving this device, and the app raises its settings sheet while it
        // does. Once the row says connected the sheet is closed the way a person
        // closes it, and the page underneath is what the rest of the run drives.
        XCTAssertTrue(waitForComposer(app, timeout: 240), "the composer never appeared")
        shot(app, "01-connected")

        let first = "WAKEI\(run)A"
        send(app, "Reply with exactly \(first) and nothing else.")
        XCTAssertTrue(waitForReply(app, first, timeout: 120), "no reply on screen before backgrounding")
        shot(app, "02-first-send")

        // Leave the app, as a person does, and stay away long enough for iOS to
        // suspend it and take its socket.
        XCUIDevice.shared.press(.home)
        sleep(UInt32(background))
        app.activate()
        XCTAssertTrue(waitForComposer(app, timeout: 90), "no composer after returning")
        shot(app, "03-after-foreground")

        let second = "WAKEI\(run)C"
        send(app, "Reply with exactly \(second) and nothing else.")
        XCTAssertTrue(waitForReply(app, second, timeout: 120), "the message sent after returning was not answered on screen")
        shot(app, "04-after-foreground-send")
    }
}
