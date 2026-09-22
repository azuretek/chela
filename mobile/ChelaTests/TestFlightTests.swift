import XCTest
import UIKit

@testable@testable import Chela

/// The one action that leaves this app.
///
/// The report was that pressing "Open TestFlight" landed on a web page rather than
/// in the app, so the assertions here are about the two halves that answer it: the
/// URL the platform is handed FIRST, and what happens when the platform refuses
/// it. Both are asserted because either alone passes while the button quietly
/// dead-ends: a scheme that opens on a phone with TestFlight and a fallback that
/// was never reached is a button that does nothing on a phone without it, and a
/// fallback with no scheme in front of it is a button that never opens the app at
/// all.
///
/// The opener is injected, matching how `UpdateCheck` takes its fetch: what is
/// asserted is what this app HANDS TO the system, in what order, and what it does
/// with the answer. Whether TestFlight is installed on a given phone is the
/// system's fact, not ours, and it is the one thing a simulator cannot supply.
@MainActor
final class TestFlightTests: XCTestCase {
    /// An opener that records what it was asked to open and answers from a script,
    /// so the order and the fallback are pinned rather than assumed.
    @MainActor
    private final class Recorder {
        private(set) var asked: [URL] = []
        private var answers: [Bool]

        init(answers: [Bool]) { self.answers = answers }

        func open(_ url: URL) async -> Bool {
            asked.append(url)
            return answers.isEmpty ? false : answers.removeFirst()
        }
    }

    /// The app is asked for first, and nothing else is tried once it opens.
    func testTheTestFlightAppIsAskedForFirst() async {
        let recorder = Recorder(answers: [true])

        let opened = await TestFlight.open { await recorder.open($0) }

        XCTAssertEqual(recorder.asked, [TestFlight.appURL], "the app is the first and only offer when it opens")
        XCTAssertEqual(opened, TestFlight.appURL)
        // The scheme is TestFlight's own, which is what makes the system route
        // this into an app rather than into a browser.
        XCTAssertEqual(TestFlight.appURL.scheme, "itms-beta")
    }

    /// A phone without TestFlight gets its App Store page, which is a page that
    /// person can act on: it installs TestFlight, and the build is waiting inside.
    func testAPhoneWithoutTestFlightIsOfferedTheAppStorePage() async {
        let recorder = Recorder(answers: [false, true])

        let opened = await TestFlight.open { await recorder.open($0) }

        XCTAssertEqual(recorder.asked, [TestFlight.appURL, TestFlight.installURL],
                       "the app is asked for first, then the store")
        XCTAssertEqual(opened, TestFlight.installURL)
        XCTAssertEqual(TestFlight.installURL.host, "apps.apple.com", "the fallback is an App Store page")
        XCTAssertEqual(TestFlight.installURL.scheme, "https")
    }

    /// The website this used to open is not offered at all.
    ///
    /// `https://testflight.apple.com/` is the public landing page: about TestFlight
    /// rather than the app the reader was told to update, with nothing on it to
    /// press for a phone that has TestFlight and nothing that installs it for one
    /// that does not. It was the whole bug, so it is pinned as absent rather than
    /// left to a future edit to reintroduce by accident.
    func testTheWebsiteThatDeadEndedIsGone() {
        for url in [TestFlight.appURL, TestFlight.installURL] {
            XCTAssertNotEqual(url.absoluteString, "https://testflight.apple.com/")
            XCTAssertNotEqual(url.host, "testflight.apple.com")
        }
    }

    /// Nothing pretends to have worked. A phone where neither can be opened is
    /// logged rather than swallowed, and the opener's own answer is what decides.
    func testNothingPretendsToHaveOpened() async {
        let recorder = Recorder(answers: [false, false])

        let opened = await TestFlight.open { await recorder.open($0) }

        XCTAssertNil(opened, "neither offer was accepted, so nothing was opened")
        XCTAssertEqual(recorder.asked.count, 2, "and both offers were still made rather than given up on after the first")
    }

    /// The two URLs are the ones the platform is expected to know, and they are
    /// different from each other: same-scheme or same-host would mean one of the
    /// two attempts is a duplicate of the other.
    func testTheTwoOffersAreDistinctAndWellFormed() {
        XCTAssertNotEqual(TestFlight.appURL, TestFlight.installURL)
        XCTAssertNotNil(TestFlight.appURL.scheme)
        XCTAssertNotNil(TestFlight.installURL.scheme)
        // `itms-beta://` with no authority is not a URL the opener accepts, so the
        // double slash is part of the scheme rather than decoration.
        XCTAssertEqual(TestFlight.appURL.absoluteString, "itms-beta://")
    }
}
