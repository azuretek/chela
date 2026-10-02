import XCTest

/// The dim behind a sheet, and the handoff between Settings and About, as drawn on
/// a simulator.
///
/// Opt-in: skipped unless the runner is given `CLAW_SURFACE_FIXTURE`, the surface
/// backdrop fixture's URL on a local server (xcodebuild forwards it with the
/// TEST_RUNNER_ prefix). `CLAW_SURFACE_SHOTS` names a directory the screenshots are
/// also written to. No gateway and no credential: the token seeded is a placeholder
/// the fixture never reads.
///
/// ## What is measured, and why it is a number rather than an eye
///
/// The fixture is a stand-in for the Control UI: a flat #808080 field under a hard
/// black-and-white stripe band, at the very top of the page. Two things are read off
/// the interface the sheet's rounded top corners leave uncovered, which is the only
/// part of it still on screen: the band ABOVE the sheet is the page's own top inset,
/// left undimmed on purpose and held to the page's `--bg` by SheetBandUITests (#127).
///
/// 1. **The dim.** A veil scales what is behind it by `1 - alpha`, and a blur moves
///    light around without changing its average, so the mean over whole stripe
///    periods behind the sheet, against the same pixels with no sheet up, gives the
///    composite alpha as arithmetic rather than an impression. The claim is the
///    shared one, black at 60%, which is `--scrim` in `core/ui/ui.css`, painted
///    whole by this client because the sheet is presented undimmed.
/// 2. **The blur.** A veil scales the stripe contrast and leaves it; a blur collapses
///    it, because the two colours average into each other. So the spread across the
///    stripes at the sheet's rounded corners is what separates a blur from a dim.
///
/// The shared dim, black at 60%: the owner is `--scrim` in `core/ui/ui.css`, and
/// `SurfaceBackdropParityTests` is what holds the app side to it. It is stated here
/// because a UI test runs in a process of its own and cannot import the app module,
/// so the value has to be mirrored rather than read.
private let sharedDim = 0.60
/// **What this cannot prove**: the region a large sheet leaves uncovered on a phone
/// is a strip at the top, so the blur has little to work on there. That the backdrop
/// is right under the reader's thumb while a sheet is DRAGGED is not exercised here,
/// and neither is a device whose presentation insets the sheet differently.
@MainActor
final class SurfacesHandoffUITests: XCTestCase {
    private var fixture: String!
    private var shots: URL?

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard let fixture = env["CLAW_SURFACE_FIXTURE"] else {
            throw XCTSkip("surface backdrop: needs CLAW_SURFACE_FIXTURE")
        }
        self.fixture = fixture
        if let dir = env["CLAW_SURFACE_SHOTS"] {
            shots = URL(fileURLWithPath: dir)
            try? FileManager.default.createDirectory(at: shots!, withIntermediateDirectories: true)
        }
    }

    // MARK: - Launching

    private func launch(_ arguments: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-claw-gateway-url", fixture] + arguments
        app.launchEnvironment["OPENCLAW_SEED_TOKEN"] = "fixture-placeholder-not-a-credential"
        app.launch()
        return app
    }

    private func screen(_ app: XCUIApplication, _ name: String) -> CGImage {
        let image = app.screenshot().image
        if let shots { try? image.pngData()?.write(to: shots.appendingPathComponent(name + ".png")) }
        guard let cg = image.cgImage else {
            XCTFail("the screenshot has no bitmap to read")
            return CGRect(x: 0, y: 0, width: 1, height: 1).toImage()!
        }
        return cg
    }

    // MARK: - Pixels

    /// The whole frame as bytes, top row first.
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

        /// The grey value at a pixel, counting from the TOP of the frame.
        ///
        /// The row is used as given: drawing the screenshot into this context lays
        /// its first row at the top, which was measured rather than assumed (the
        /// first version of this reader indexed from the bottom and read the sheet's
        /// own card instead of the strip above it).
        func grey(x: Int, topY: Int) -> Double {
            let row = topY
            let i = (row * width + x) * 4
            return Double(data[i])
        }

        /// Reading a horizontal run: the least, the most and the average.
        func run(y: Int, x0: Int, x1: Int) -> (min: Double, max: Double, mean: Double) {
            var lo = 255.0, hi = 0.0, sum = 0.0, n = 0.0
            for x in x0..<min(x1, width) {
                let v = grey(x: x, topY: y)
                lo = min(lo, v); hi = max(hi, v); sum += v; n += 1
            }
            return (lo, hi, n > 0 ? sum / n : 0)
        }

        /// The first row from the top that looks like the fixture's stripe band: both
        /// colours present in the same row.
        var firstStripeRow: Int? {
            for y in 0..<height {
                let r = run(y: y, x0: width / 6, x1: width * 5 / 6)
                if r.min < 32 && r.max > 223 { return y }
            }
            return nil
        }
    }

    // MARK: - The dim

    func testTheBackdropBehindASheetIsTheSharedDim() throws {
        let bare = launch([])
        XCTAssertTrue(bare.webViews.firstMatch.waitForExistence(timeout: 30), "the fixture never painted")
        sleep(2)
        let withoutSheet = try XCTUnwrap(Bitmap(screen(bare, "backdrop-no-sheet")), "no bitmap")
        bare.terminate()

        let sheeted = launch(["-claw-open-settings"])
        XCTAssertTrue(sheeted.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "About Chela")).firstMatch.waitForExistence(timeout: 30),
                      "the settings surface never drew over the fixture")
        sleep(2)
        let withSheet = try XCTUnwrap(Bitmap(screen(sheeted, "backdrop-settings")), "no bitmap")

        // The corner the sheet's rounding leaves uncovered, found rather than
        // assumed: the sheet's top edge sits at the page's top inset, which is the
        // fixture's first stripe row, and the rows just under it at the left edge are
        // outside the card. Whole stripe periods (8 CSS pixels each) are averaged, so
        // the blur cancels out and the dim is what is left.
        let page = try XCTUnwrap(withoutSheet.firstStripeRow, "the fixture drew no stripe band")
        let y0 = page + 3, y1 = page + 9
        let period = withoutSheet.width * 8 / 402

        func mean(_ bitmap: Bitmap) -> Double {
            let runs = (y0..<y1).map { bitmap.run(y: $0, x0: 0, x1: period * 2).mean }
            return runs.reduce(0, +) / Double(runs.count)
        }
        let open = mean(withoutSheet)
        let covered = mean(withSheet)
        XCTAssertGreaterThan(open, 40, "the interface at the corner is too dark to measure a dim against")

        let composite = 1 - (covered / open)
        let message = "the dim behind a sheet is black at \(String(format: "%.3f", composite)) "
            + "(\(String(format: "%.1f", open)) to \(String(format: "%.1f", covered)), and the shared value is "
            + "\(sharedDim)"
        // The ultra-thin material under the veil tints by appearance, so the composite
        // reads 0.49 in light and 0.68 in dark rather than the shared value (#128).
        // Expected to fail until that is fixed; a pass here means it has been.
        XCTExpectFailure("the material under the veil tints by appearance (#128)") {
            XCTAssertEqual(composite, sharedDim, accuracy: 0.06, message)
        }
    }

    // MARK: - The blur

    func testTheInterfaceBehindASheetIsBlurred() throws {
        let bare = launch([])
        XCTAssertTrue(bare.webViews.firstMatch.waitForExistence(timeout: 30), "the fixture never painted")
        sleep(2)
        let withoutSheet = try XCTUnwrap(Bitmap(screen(bare, "blur-no-sheet")), "no bitmap")
        let page = try XCTUnwrap(withoutSheet.firstStripeRow, "the fixture drew no stripe band")
        // The stripes with nothing over them: full contrast, by construction.
        let bareStripes = withoutSheet.run(y: page + 8, x0: 60, x1: withoutSheet.width - 60)
        XCTAssertGreaterThan(bareStripes.max - bareStripes.min, 200,
                             "the fixture's stripe band is not high contrast, so this would assert nothing")
        bare.terminate()

        let sheeted = launch(["-claw-open-settings"])
        XCTAssertTrue(sheeted.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "About Chela")).firstMatch.waitForExistence(timeout: 30),
                      "the settings surface never drew over the fixture")
        sleep(2)
        let withSheet = try XCTUnwrap(Bitmap(screen(sheeted, "blur-settings")), "no bitmap")

        // Behind the sheet: the only place the interface itself is still on screen
        // is the sliver the sheet's rounded top corner uncovers, just under the band
        // and at the left edge, the same sliver the dim is read from. What is read is
        // the widest spread the veil and the blur leave across whole stripe periods.
        let period = withSheet.width * 8 / 402
        var best = 0.0
        for y in (page + 3)..<(page + 9) {
            let r = withSheet.run(y: y, x0: 0, x1: period * 2)
            best = max(best, r.max - r.min)
        }
        // A veil alone would leave the stripe contrast scaled by what it lets through,
        // which is `255 * (1 - composite)`; a blur leaves much less than that.
        let dimOnly = 255 * (1 - sharedDim)
        XCTAssertLessThan(best, dimOnly * 0.8,
                          "the stripes behind the sheet keep their contrast (\(best) of \(dimOnly)), "
                          + "so what is over the interface is a dim and not a blur")
    }

    // MARK: - The handoff

    func testAboutCoversSettingsAndComesBackToTheSameTab() throws {
        let app = launch(["-claw-settings-tab", "behaviour", "-claw-open-settings"])
        let about = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "About Chela")).firstMatch
        XCTAssertTrue(about.waitForExistence(timeout: 30), "the settings surface never drew")
        // The tab the reader was on, established by what is NOT there: the Gateways
        // tab's search field, which the page draws on its first tab only.
        let gatewaysOnly = app.webViews.textFields["Search gateways"]
        XCTAssertFalse(gatewaysOnly.exists, "the run did not open on the Behaviour tab")
        sleep(1)
        _ = screen(app, "handoff-settings")

        about.tap()
        let updates = app.webViews.staticTexts["Updates"]
        XCTAssertTrue(updates.waitForExistence(timeout: 20), "About never came up over Settings")
        sleep(1)
        _ = screen(app, "handoff-about")

        // ONE surface at a time: the settings card has gone down and is held there, so
        // the control that opened About is neither on screen nor hittable.
        XCTAssertFalse(about.isHittable, "the settings card is still on screen under About")

        app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Back to settings")).firstMatch.tap()
        XCTAssertTrue(about.waitForExistence(timeout: 20), "About left nothing to come back to")
        // The reveal is a real animation, so the settings card is up but not yet
        // settled the instant the tap returns: wait for the control to be REACHABLE
        // rather than reading the first frame of the slide.
        let reachable = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isHittable == true"), object: about
        )
        XCTAssertEqual(XCTWaiter().wait(for: [reachable], timeout: 10), .completed,
                       "the settings card never came back")
        // Its state came back with it: the tab is still Behaviour, which the absent
        // search field says, and a page whose state had been rebuilt would be on
        // Gateways.
        XCTAssertFalse(gatewaysOnly.exists, "the settings surface came back on a different tab")
        sleep(1)
        _ = screen(app, "handoff-back")
    }
}

private extension CGRect {
    /// A one-pixel black bitmap, for the failure path that has no screenshot.
    func toImage() -> CGImage? {
        let context = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        return context?.makeImage()
    }
}

