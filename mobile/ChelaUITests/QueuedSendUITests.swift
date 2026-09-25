import XCTest

/// A message typed while a reply is running must reach the gateway exactly once
/// and must never sit stuck in the page's queue on a live connection. The phone's
/// half of the queued-send proof; the desktop's half is
/// desktop/scripts/test-queued-send.js, which also reads the gateway's record.
///
/// The stuck row is judged the way the reader sees it: the Control UI marks a
/// queued message it has lost track of as "Waiting for reconnect", "Delivery
/// uncertain" or "Reconnected before delivery was confirmed", and measured 2026-09-25 it showed that on a message the gateway
/// had already accepted, over a socket that never dropped, while the message
/// behind it was never attempted. On the phone the same fault also shows as a
/// send button that stays a spinner, so the next message cannot be sent: the
/// test measures how long the composer refuses each message. A notice or a
/// refusal that clears within a few seconds is the page settling; one that
/// stays is the fault. Exactly-once delivery is read
/// from the gateway's record by the runner once this test has finished, from the
/// session named by CLAW_QUEUE_SESSION.
///
/// Opt-in, because it needs a gateway and a credential: skipped unless the
/// runner is given CLAW_QUEUE_GATEWAY and OPENCLAW_SEED_TOKEN (xcodebuild
/// forwards them with the TEST_RUNNER_ prefix). The token goes to the app
/// through its debug seed, which is compiled out of a release build, and is
/// never logged.
@MainActor
final class QueuedSendUITests: XCTestCase {
    private var shots: URL?

    /// What the Control UI shows on a queued row it has lost track of: the queue
    /// row's state labels and the inline error on an attempted send.
    private static let stuckNotices = ["Waiting for reconnect", "Delivery uncertain", "Reconnected before delivery"]
    private static let stuckNotice = "Waiting for reconnect"
    /// How long that notice may stay before the row counts as stuck.
    private static let stuckLimit: TimeInterval = 8

    private func shot(_ app: XCUIApplication, _ name: String) {
        let png = app.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let shots { try? png.write(to: shots.appendingPathComponent(name + ".png")) }
    }

    private func composer(_ app: XCUIApplication) -> XCUIElement {
        app.webViews.textViews.firstMatch
    }

    /// The settings sheet's way back. Queried as a native button rather than any
    /// descendant: an any-descendant query snapshots the whole web view's
    /// accessibility tree, which on a full Control UI page kept the app's main
    /// thread busy past XCTest's 30s snapshot limit (measured 2026-09-25).
    private func backToApp(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Back to app")).firstMatch
    }

    /// The composer, once the page underneath is really usable. A first launch
    /// of a new simulator waits on the gateway approving this device and the
    /// app raises its settings sheet while it does, so the sheet is closed the
    /// way a person closes it before the page is trusted.
    private func waitForComposer(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let back = backToApp(app)
            if back.exists && back.isHittable {
                back.tap()
            } else if composer(app).waitForExistence(timeout: 3) && composer(app).isHittable {
                return true
            }
            sleep(2)
        }
        return composer(app).exists
    }

    /// Whether the composer has keyboard focus. XCUIElement exposes it only as a
    /// key, and typing into an element without it fails with "Neither element nor
    /// any descendant has keyboard focus", which is what this harness hit on the
    /// web view's text area: a tap on a WKWebView element is delivered to the
    /// page, and the page takes a beat to move focus into the field.
    private func hasFocus(_ element: XCUIElement) -> Bool {
        (element.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
    }

    /// Focus the composer the way a person does and wait until it really has
    /// focus, re-querying it every time: the page can re-render under the run,
    /// and an element captured before that no longer resolves.
    private func focusedComposer(_ app: XCUIApplication, timeout: TimeInterval) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let back = backToApp(app)
            if back.exists && back.isHittable { back.tap(); sleep(1); continue }
            let box = composer(app)
            guard box.exists, box.isHittable else { sleep(1); continue }
            if !hasFocus(box) { box.tap() }
            // The keyboard's one-time slide-to-type tip covers the page on a fresh
            // simulator; it is dismissed the way a person dismisses it.
            let tip = app.buttons["Continue"]
            if tip.exists && tip.isHittable { tip.tap() }
            let focusDeadline = Date().addingTimeInterval(3)
            while Date() < focusDeadline {
                if hasFocus(composer(app)) { return composer(app) }
                usleep(200_000)
            }
        }
        return nil
    }

    /// Types the message and presses send until the composer takes it. While a
    /// send is in flight the phone's button shows a spinner and a press does
    /// nothing, so the press is repeated until the draft clears. Returns how long
    /// the composer refused the message: a person who has to wait that long to
    /// send the next message is looking at the stuck queue.
    @discardableResult
    private func send(_ app: XCUIApplication, _ text: String) -> TimeInterval {
        guard let box = focusedComposer(app, timeout: 90) else {
            XCTFail("the composer never took keyboard focus")
            return 0
        }
        // Typed through the application rather than the element: the element
        // query is re-resolved on every event, and the page re-rendering between
        // keystrokes is what made the element form fail to synthesize events.
        app.typeText(text)
        XCTAssertTrue(((box.value as? String) ?? "").contains(text.prefix(12)), "the text did not land in the composer")
        // Pressed rather than Return: the phone layout of the Control UI treats
        // Return as a new line, which leaves the message in the draft. While a
        // reply is running the same button reads "Steer into the active run",
        // which is what the desktop's Enter does at that moment too.
        let sendButton = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label BEGINSWITH %@", "send", "Steer into")).firstMatch
        guard sendButton.waitForExistence(timeout: 10) else {
            shot(app, "send-button-missing")
            let labels = app.webViews.buttons.allElementsBoundByIndex.prefix(40).map { $0.label }
            XCTFail("no send button; the page offers: \(labels)")
            return 0
        }
        let started = Date()
        let deadline = started.addingTimeInterval(120)
        while Date() < deadline {
            if sendButton.exists && sendButton.isHittable { sendButton.tap() }
            let cleared = Date().addingTimeInterval(2)
            while Date() < cleared {
                if !draft(app).contains(text.prefix(12)) { return Date().timeIntervalSince(started) }
                usleep(250_000)
            }
        }
        XCTFail("the composer never took the message: \(text)")
        return Date().timeIntervalSince(started)
    }

    private func stuckNoticeShown(_ app: XCUIApplication) -> Bool {
        Self.stuckNotices.contains { notice in
            app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", notice)).firstMatch.exists
        }
    }

    /// What the composer holds: a message left typed but never sent is exactly
    /// the failure this proof exists to catch, so an empty draft is asserted at
    /// the end rather than assumed.
    private func draft(_ app: XCUIApplication) -> String {
        let box = composer(app)
        let value = (box.value as? String) ?? ""
        // An empty text area reports its placeholder as its value.
        return value == (box.placeholderValue ?? "") ? "" : value
    }

    func testQueuedMessagesAreNeverStuck() throws {
        let env = ProcessInfo.processInfo.environment
        guard let gateway = env["CLAW_QUEUE_GATEWAY"], let token = env["OPENCLAW_SEED_TOKEN"], !token.isEmpty else {
            throw XCTSkip("queued-send proof: needs CLAW_QUEUE_GATEWAY and OPENCLAW_SEED_TOKEN")
        }
        continueAfterFailure = true
        let run = env["CLAW_QUEUE_RUN"] ?? String(Int(Date().timeIntervalSince1970), radix: 36)
        if let dir = env["CLAW_QUEUE_SHOTS"] {
            shots = URL(fileURLWithPath: dir)
            try? FileManager.default.createDirectory(at: shots!, withIntermediateDirectories: true)
        }

        let app = XCUIApplication()
        app.launchArguments = ["-claw-gateway-url", gateway]
        app.launchEnvironment["OPENCLAW_SEED_TOKEN"] = token
        app.launch()

        XCTAssertTrue(waitForComposer(app, timeout: 240), "the composer never appeared")
        shot(app, "01-connected")

        // A long reply the agent cannot be steered out of, so the two messages
        // below land mid-generation and the gateway holds them as pending inputs
        // for the rest of it, which is the window a stuck row shows in.
        send(app, "Write the whole numbers from 1 to 400 as English words, one per line, with nothing else, and then a final line that says exactly QLONGRUN\(run).")
        sleep(6)
        let refusedB = send(app, "Reply with exactly QB\(run) and nothing else.")
        sleep(3)
        shot(app, "02-one-queued")
        let refusedC = send(app, "Reply with exactly QC\(run) and nothing else.")
        shot(app, "03-two-queued")
        // The composer holding the next message back while an accepted one is
        // still marked in flight is the same stuck queue, seen from the phone.
        XCTAssertLessThanOrEqual(refusedB, Self.stuckLimit, "the composer refused the second message for \(Int(refusedB))s")
        XCTAssertLessThanOrEqual(refusedC, Self.stuckLimit, "the composer refused the third message for \(Int(refusedC))s")

        // Watch the queue for the rest of the reply and a while after it. The
        // notice may flash while the page settles a row; it must not stay.
        var shownSince: Date?
        var longest: TimeInterval = 0
        let deadline = Date().addingTimeInterval(TimeInterval(env["CLAW_QUEUE_WATCH_SECONDS"].flatMap(Double.init) ?? 150))
        var shotStuck = false
        while Date() < deadline {
            if stuckNoticeShown(app) {
                let since = shownSince ?? Date()
                shownSince = since
                longest = max(longest, Date().timeIntervalSince(since))
                if longest > Self.stuckLimit && !shotStuck { shot(app, "04-stuck"); shotStuck = true }
            } else {
                shownSince = nil
            }
            sleep(1)
        }
        shot(app, "05-after")
        XCTAssertLessThanOrEqual(longest, Self.stuckLimit, "a queued message showed \"\(Self.stuckNotice)\" for \(Int(longest))s on a live connection")
        XCTAssertFalse(stuckNoticeShown(app), "a queued message is still marked \"\(Self.stuckNotice)\" at the end")
        XCTAssertEqual(draft(app), "", "a message was left typed in the composer instead of being sent")
    }
}
