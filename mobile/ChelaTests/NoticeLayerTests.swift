import XCTest

@testable import Chela

/// Where the notice banner is drawn, which is what Abi reported on 2026-09-21: the
/// same up-to-date notice appeared on the Settings surface and on the About
/// surface, and it should "only show up once for the whole app and be pinned over
/// everything not to one specific page".
///
/// The claim is about LAYERS, and a layer cannot be photographed from a unit test,
/// so what is asserted here is the two halves that make the claim true and that a
/// refactor would break in silence: ONE installation, at the root of the client's
/// only view, with no per-layer application left anywhere; and the surface it
/// installs is a window above the app's own, whose touch rule claims the cards and
/// nothing else.
final class NoticeLayerTests: XCTestCase {
    /// The client's own source, read from the checkout the test bundle runs beside.
    /// The same `#filePath` walk the parity fixtures use, because an absolute path
    /// would pass on one machine and fail everywhere else.
    private func source(_ name: String) throws -> String {
        let file = try Fixtures.root().appendingPathComponent("mobile").appendingPathComponent("Chela")
            .appendingPathComponent(name)
        return try String(contentsOf: file, encoding: .utf8)
    }

    /// The code, with its line comments taken out: these assertions are about what
    /// the view does, and the doc comments in these files name the very modifiers
    /// being counted. A scan that reads prose reports the explanation as the fault.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                guard let at = line.range(of: "//") else { return String(line) }
                return String(line[..<at.lowerBound])
            }
            .joined(separator: "\n")
    }

    func testTheNoticeSurfaceIsInstalledOnceForTheWholeApp() throws {
        let text = code(try source("ContentView.swift"))
        let installations = text.components(separatedBy: ".noticeLayer(").count - 1
        XCTAssertEqual(installations, 1,
            "the notice surface is installed \(installations) times: it is ONE surface for the whole app, and one "
            + "application is the only count that keeps it one")
        XCTAssertFalse(text.contains(".noticeBanner("),
            "a per-layer application of the notice stack is back. A sheet is presented above the view that raises "
            + "it, so a copy per layer was how a banner reached whichever layer was in front; that is exactly the "
            + "per-page banner Abi reported, and the notice layer replaces it")
        XCTAssertFalse(text.contains("notices: NoticeBoard"),
            "a sheet is taking the notice board again, which is what let it draw its own copy")
    }

    func testTheNoticeSurfaceIsAWindowAboveTheAppsOwn() throws {
        let text = try source("NoticeLayer.swift")
        XCTAssertTrue(text.contains("final class NoticeWindow: UIWindow"),
            "the notice surface is no longer a window, so it cannot be above the layer a sheet is presented on")
        XCTAssertTrue(text.contains("windowLevel = UIWindow.Level.normal + 1"),
            "the notice window is not above the app's own window, which is where the sheets are; pinned over "
            + "everything is the whole of the report")
        XCTAssertTrue(text.contains("override var canBecomeKey: Bool { false }"),
            "the notice window can take focus, which would move the first responder and the keyboard for an "
            + "overlay that owns neither")
    }

    func testTheNoticeWindowClaimsTheCardsAndNothingElse() throws {
        // The one hard rule a window over everything has to keep: everywhere the
        // cards are not, the touch belongs to the app underneath. The rule is a
        // function of the cluster box, so it is asserted as geometry rather than as
        // a condition inlined in a hit test.
        let cards = CGRect(x: 120, y: 59, width: 250, height: 96)
        XCTAssertTrue(NoticeWindow.claims(CGPoint(x: 130, y: 70), cluster: cards),
            "a point inside the cards is not claimed, so a notice could not be dismissed or followed")
        XCTAssertTrue(NoticeWindow.claims(CGPoint(x: 369, y: 154), cluster: cards),
            "the trailing and bottom edges of the cards are outside the claim, which would leave the sweep row dead")
        XCTAssertFalse(NoticeWindow.claims(CGPoint(x: 119, y: 70), cluster: cards),
            "a point beside the cards is claimed, so the page under the banner would stop taking touches")
        XCTAssertFalse(NoticeWindow.claims(CGPoint(x: 200, y: 156), cluster: cards),
            "a point below the cards is claimed, which is the failure the desktop banner's own view had")
        XCTAssertFalse(NoticeWindow.claims(CGPoint(x: 200, y: 400), cluster: .zero),
            "an unreported cluster claims the screen: before the stack reports, nothing may be claimed")
    }

    func testTheStackReportsTheBoxItDrew() throws {
        let text = try source("NoticeBanner.swift")
        XCTAssertTrue(text.contains("NoticeClusterBox.self"),
            "the stack no longer publishes the box it drew, which is the only area the notice layer may claim")
        XCTAssertTrue(text.contains("NoticeWindow.coordinateSpace"),
            "the stack's box is reported in a space the notice window does not share, so the claim would be "
            + "measured against the wrong origin")
    }
}
