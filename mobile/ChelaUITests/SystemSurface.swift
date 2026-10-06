import XCTest

/// The screen a pixel test judges (issue #174). A capture cannot say whether the frame
/// it holds is the app or a system surface drawn over it, so the surface really on
/// screen is asked for first: the app must be frontmost, and no SpringBoard alert may be
/// up. When it is not ours, the failure names the covering surface rather than reporting
/// a screenshot timeout or a pixel mismatch, which is the difference between an
/// environment fault and a broken page.
///
/// This is the iOS half of the guard the Android lane owns in
/// `android/scripts/boot-proof.sh`: that script waits for our window to hold input focus
/// and clears another app's dialog, and this asks the same question through the only API
/// a UI test has. The shape is this client's own (issue #149), shared rather than
/// reinvented.
@MainActor
enum SystemSurface {
    /// SpringBoard owns the system alerts on the simulator, so its own application proxy
    /// is how a test sees an alert that would cover the app.
    private static var springboard: XCUIApplication {
        XCUIApplication(bundleIdentifier: "com.apple.springboard")
    }

    /// A description of the system surface covering the app, or nil when the screen is
    /// ours. The app not being frontmost, or a SpringBoard alert being up, is a cover.
    /// The status bar and the soft keyboard share the screen with us and are not one.
    static func obscuring(_ app: XCUIApplication) -> String? {
        if springboard.state == .runningForeground {
            let alert = springboard.alerts.firstMatch
            if alert.exists {
                return "a system alert is up: " + (alert.label.isEmpty ? "an unlabelled alert" : alert.label)
            }
        }
        if app.state != .runningForeground {
            return "the app is not frontmost (state \(app.state.rawValue))"
        }
        return nil
    }

    /// Waits, bounded, for the screen to be ours, then fails naming the covering surface
    /// if it never was. Called before a test reads a pixel, so a covered screen stops the
    /// lane with the reason rather than arriving later as a screenshot timeout.
    static func requireOurs(_ app: XCUIApplication, timeout: TimeInterval = 20,
                            file: StaticString = #filePath, line: UInt = #line) {
        _ = app.wait(for: .runningForeground, timeout: timeout)
        if let covering = obscuring(app) {
            XCTFail("a system surface is covering the app, so the screen is not ours to judge: \(covering)",
                    file: file, line: line)
        }
    }

    /// Appended to a capture comparison failure so it reads as the environment fault when
    /// it is one: the screen was not ours when the pixels were read.
    static func failureSuffix(_ app: XCUIApplication) -> String {
        obscuring(app).map { "; a system surface is covering the app: \($0)" } ?? ""
    }
}
