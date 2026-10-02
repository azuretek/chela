import XCTest

/// The band a Settings or About sheet leaves above itself, as drawn on a simulator:
/// it is the palette's `--bg`, the colour the app paints around the page, and it
/// follows a theme change made while the sheet is up. Reported 2026-10-02 from a
/// phone in the dark palette, where the band read black: it was the interface's
/// own top strip under the dim that belongs to the interface (`SurfaceBackdrop`).
///
/// Opt-in: skipped unless the runner is given `CLAW_SHEET_BAND_FIXTURE`, the URL of
/// Fixtures/sheet-band.html on a local server (xcodebuild forwards it with the
/// TEST_RUNNER_ prefix). `CLAW_SHEET_BAND_APPEARANCE` says which appearance the
/// simulator was put in (`xcrun simctl ui <device> appearance dark`), so a run in
/// each covers both palettes and the screenshots are named for it.
/// `CLAW_SHEET_BAND_SHOTS` names a directory the screenshots are also written to.
/// No gateway and no credential: the token seeded is a placeholder the fixture
/// never reads.
///
/// ## What is compared
///
/// The fixture paints one flat `--bg`, so the app's strip above the page is that
/// colour with no sheet up, and the strip is first held to the value the fixture
/// declares: in the dark palette iOS's scroll edge effect once faded it darker
/// than the page with no sheet anywhere. That strip, read off a launch with no
/// sheet, is then the reference: the band above a sheet must read the same,
/// channel by channel. It is
/// read either side of the status bar's centre, clear of the clock and the
/// indicators, and the median of the patch is what is compared, so a glyph edge
/// that strays into it does not decide the result.
///
/// **What this cannot prove**: a physical phone. The simulator draws the same
/// presentation on the same SDK.
@MainActor
final class SheetBandUITests: XCTestCase {
    private var fixture: String!
    private var appearance = "light"
    private var shots: URL?

    /// How far a channel may stray from the reference: the band and the strip are
    /// painted from one colour, so anything beyond rounding is a different colour.
    private let tolerance = 6

    override func setUpWithError() throws {
        continueAfterFailure = true
        let env = ProcessInfo.processInfo.environment
        guard let fixture = env["CLAW_SHEET_BAND_FIXTURE"] else {
            throw XCTSkip("sheet band: needs CLAW_SHEET_BAND_FIXTURE")
        }
        self.fixture = fixture
        appearance = env["CLAW_SHEET_BAND_APPEARANCE"] ?? "light"
        if let dir = env["CLAW_SHEET_BAND_SHOTS"] {
            shots = URL(fileURLWithPath: dir)
            try? FileManager.default.createDirectory(at: shots!, withIntermediateDirectories: true)
        }
    }

    // MARK: - Launching

    private func launch(_ arguments: [String], query: String = "") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-claw-gateway-url", fixture + query] + arguments
        app.launchEnvironment["OPENCLAW_SEED_TOKEN"] = "fixture-placeholder-not-a-credential"
        app.launch()
        return app
    }

    private func band(_ app: XCUIApplication, _ shot: String) throws -> RGB {
        let image = app.screenshot()
        let name = "band-\(appearance)-\(shot)"
        let attachment = XCTAttachment(screenshot: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let shots { try? image.pngRepresentation.write(to: shots.appendingPathComponent(name + ".png")) }
        let cg = try XCTUnwrap(image.image.cgImage, "the screenshot has no bitmap to read")
        let points = image.image.size.width
        return try XCTUnwrap(Bitmap(cg)?.statusBand(pixelsPerPoint: Double(cg.width) / Double(points)), "no bitmap")
    }

    /// The `--bg` Fixtures/sheet-band.html declares for this run's appearance, first
    /// theme or second. Kept beside the fixture's own values on purpose: the band is
    /// held to the palette, not only to whatever the strip happens to read.
    private func declared(second: Bool) -> RGB {
        switch (appearance == "dark", second) {
        case (false, false): return RGB(r: 0xf2, g: 0xed, b: 0xe4)
        case (false, true): return RGB(r: 0xe3, g: 0xee, b: 0xf2)
        case (true, false): return RGB(r: 0x1d, g: 0x22, b: 0x30)
        case (true, true): return RGB(r: 0x30, g: 0x20, b: 0x24)
        }
    }

    /// The strip above the page with nothing over it: the colour the band must be.
    /// It is the palette's `--bg` itself, checked against what the fixture declares
    /// for the appearance the run was given, so a simulator left in the other
    /// appearance, or anything the system draws into the band, fails here.
    private func reference(query: String = "", _ shot: String) throws -> RGB {
        let app = launch([], query: query)
        XCTAssertTrue(app.webViews.staticTexts["Fixture ready"].waitForExistence(timeout: 30), "the fixture never painted")
        sleep(2)
        let colour = try band(app, shot)
        app.terminate()
        let palette = declared(second: query.contains("second"))
        XCTAssertLessThanOrEqual(
            colour.distance(to: palette), tolerance,
            "\(appearance), no sheet: the strip above the page is \(colour), and the palette's --bg is \(palette)"
        )
        return colour
    }

    private func assertBand(_ seen: RGB, is expected: RGB, _ what: String,
                            file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertLessThanOrEqual(
            seen.distance(to: expected), tolerance,
            "\(what), \(appearance): the band above the sheet is \(seen), and the strip around the page is \(expected)",
            file: file, line: line
        )
    }

    private var aboutButton: NSPredicate { NSPredicate(format: "label BEGINSWITH %@", "About Chela") }

    // MARK: - The band

    func testTheBandAboveSettingsIsThePageBackground() throws {
        let expected = try reference("no-sheet")
        let app = launch(["-claw-open-settings"])
        XCTAssertTrue(app.webViews.buttons.matching(aboutButton).firstMatch.waitForExistence(timeout: 30),
                      "the settings surface never drew over the fixture")
        sleep(2)
        assertBand(try band(app, "settings"), is: expected, "settings")
    }

    func testTheBandAboveAboutIsThePageBackground() throws {
        let expected = try reference("no-sheet")
        let app = launch(["-claw-open-about"])
        XCTAssertTrue(app.webViews.staticTexts["Updates"].waitForExistence(timeout: 30),
                      "About never came up over Settings")
        sleep(2)
        assertBand(try band(app, "about"), is: expected, "about")
    }

    /// With the platform's dim switched off the interface behind the sheet could
    /// take touches, which it never did. A tap on what is left of it on screen, the
    /// sliver the sheet's rounded top corner uncovers just below the band, and a tap
    /// on the band itself, reach nothing behind the sheet: the fixture counts every
    /// touch it receives.
    func testATapOutsideTheSheetReachesNothingBehindIt() throws {
        let app = launch(["-claw-open-settings"])
        let about = app.webViews.buttons.matching(aboutButton).firstMatch
        XCTAssertTrue(about.waitForExistence(timeout: 30), "the settings surface never drew over the fixture")
        XCTAssertTrue(app.webViews.staticTexts["Taps 0"].waitForExistence(timeout: 10), "the fixture is not counting")
        sleep(2)
        let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
        for (place, offset) in [("corner", CGVector(dx: 4, dy: 66)), ("band", CGVector(dx: 120, dy: 30))] {
            origin.withOffset(offset).tap()
            sleep(2)
            print("SHEETBAND tap \(place): sheet up = \(about.exists)")
            _ = try band(app, "tap-\(place)")
            XCTAssertTrue(app.webViews.staticTexts["Taps 0"].exists,
                          "a tap on the \(place) outside the sheet reached the interface behind it")
        }
    }

    /// The theme changing under an open sheet: the band follows it rather than
    /// keeping the colour it had when the sheet came up. The fixture moves to its
    /// second theme on a timer, which is the page's palette changing while the
    /// reader is in Settings.
    func testTheBandFollowsAThemeChangeWhileASheetIsUp() throws {
        let first = try reference("no-sheet")
        let second = try reference(query: "?theme=second", "no-sheet-second")
        XCTAssertGreaterThan(first.distance(to: second), 12, "the fixture's two themes are too close to tell apart")
        let app = launch(["-claw-open-settings"], query: "?flip=14")
        XCTAssertTrue(app.webViews.buttons.matching(aboutButton).firstMatch.waitForExistence(timeout: 30),
                      "the settings surface never drew over the fixture")
        sleep(2)
        assertBand(try band(app, "follow-before"), is: first, "settings, before the theme changed")
        // The flip lands 14 seconds after the page loaded: read until the band has
        // moved, bounded, so a band that never follows fails rather than hangs.
        var last = first
        for _ in 0..<25 {
            last = try band(app, "follow-after")
            if last.distance(to: second) <= tolerance { break }
            sleep(1)
        }
        assertBand(last, is: second, "settings, after the theme changed")
    }
}

/// One pixel's colour, 0 to 255 per channel.
private struct RGB: CustomStringConvertible {
    let r: Int, g: Int, b: Int
    var description: String { String(format: "#%02x%02x%02x", r, g, b) }
    var luma: Int { (r * 299 + g * 587 + b * 114) / 1000 }
    func distance(to other: RGB) -> Int { max(abs(r - other.r), abs(g - other.g), abs(b - other.b)) }
}

/// The whole frame as bytes, top row first. Drawing the screenshot into this
/// context lays its first row at the top (measured in SurfacesHandoffUITests).
private struct Bitmap {
    let data: [UInt8]
    let width: Int
    let height: Int

    init?(_ image: CGImage) {
        width = image.width
        height = image.height
        var buffer = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &buffer, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        data = buffer
    }

    /// The median colour of two patches at the top of the screen, either side of its
    /// centre: right of the clock and left of the indicators, 4 to 12 points down,
    /// which is inside the band a large sheet leaves uncovered.
    func statusBand(pixelsPerPoint: Double) -> RGB {
        var rs: [Int] = [], gs: [Int] = [], bs: [Int] = []
        let columns = Array(width * 27 / 100..<width * 33 / 100) + Array(width * 67 / 100..<width * 73 / 100)
        for y in Int(4 * pixelsPerPoint)..<Int(12 * pixelsPerPoint) {
            for x in columns {
                let i = (y * width + x) * 4
                rs.append(Int(data[i])); gs.append(Int(data[i + 1])); bs.append(Int(data[i + 2]))
            }
        }
        func median(_ v: [Int]) -> Int { v.sorted()[v.count / 2] }
        return RGB(r: median(rs), g: median(gs), b: median(bs))
    }
}
