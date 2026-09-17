import XCTest
@testable import Claw

/// What the phone's notice banner claims, and why it is a source rule here
/// rather than a click test.
///
/// This is the other client's half of the fault Abi reported on 2026-09-17, and
/// the two halves are NOT the same rule, because the clients are not the same
/// machinery.
///
/// On the desktop the banner is a page in a WebContentsView, and a view claims
/// every mouse event inside its own RECTANGLE whatever the page draws there. That
/// is why the sweep's own row now lives inside the last card: a bare row of its
/// own was a full-width strip the reader saw the page through and could not
/// click, measured by clicking it at a real screen point. See core/ui/banner.js,
/// core/ui/banner.css and desktop/scripts/test-banner-clicks.js, and
/// desktop/test/banner.test.js for the guard that keeps a strip from coming back.
///
/// Here there is no rectangle to speak of. The banner is SwiftUI in the same
/// hosting view as the page it covers, hit testing is per LEAF, and a `Spacer`,
/// a `padding` and a `.frame(maxWidth: .infinity, maxHeight: .infinity)` all
/// draw nothing and therefore claim nothing. What DOES claim a touch is a drawn
/// surface, a `contentShape` or a gesture, and that is what this file holds the
/// stack to, because the stack's frame is the whole screen: one `contentShape`
/// or one background on it takes every touch on the page, which is the same
/// fault with a wider blast radius.
///
/// ★ Why not a click. Two instruments were tried on 2026-09-17 and both were
/// thrown away, recorded here so the next reader does not rebuild them:
///
///   - `UIHostingController.view.hitTest`, asked directly, returns the hosting
///     view ITSELF for every point inside it, including the middle of an empty
///     screen. "The banner claims nothing" passed vacuously while "the card
///     claims the touch drawn under it" passed for the wrong reason.
///   - the same hosting view laid over a page view in a window, hit-tested at
///     the window, returned the PAGE for every point, including points on the
///     card. A SwiftUI hosting view is only hit-testable inside the composition
///     its own scene laid out, so a hand-built window is not the composition the
///     app runs.
///
/// There is no third option on this client: `UITouch` cannot be constructed, a
/// unit test cannot post one, and the simulator has no click-through harness
/// (the desktop's is a CGEvent at the HID tap). So the phone's half is asserted
/// where it can be asserted honestly, on the source, and the desktop's half
/// carries the click.
final class NoticeStackHitTests: XCTestCase {
    /// The client's own source, read from the checkout the test bundle runs
    /// beside. The same `#filePath` walk the parity fixtures use, because an
    /// absolute path would pass on one machine and fail everywhere else.
    private func source(_ name: String) throws -> String {
        let file = try Fixtures.root().appendingPathComponent("mobile").appendingPathComponent("Claw")
            .appendingPathComponent(name)
        return try String(contentsOf: file, encoding: .utf8)
    }

    /// One `struct`'s body, from its declaration to the next top-level type.
    /// Deliberately crude: what is being read is whether a modifier appears on
    /// the stack at all, and a nested type inside it would be the fault too.
    private func body(of name: String, in text: String) throws -> String {
        let marker = "struct \(name)"
        let start = try XCTUnwrap(text.range(of: marker)?.lowerBound, "\(name) is gone from the file this test reads")
        let rest = text[start...]
        let end = rest.dropFirst(marker.count).range(of: "\nstruct ")?.lowerBound ?? rest.endIndex
        return String(rest[..<end])
    }

    /// The code, with its line comments taken out.
    ///
    /// These assertions are about what the view DOES, and the stack's own comment
    /// says "a surface, a contentShape or a gesture on the frame would claim every
    /// touch on the page underneath" to explain why it has none of them. A scan
    /// that reads prose reports the explanation as the fault. Deliberately crude,
    /// and the same reasoning as the colour scan in desktop/test/tokens.test.js: a
    /// comment draws nothing and claims nothing.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                guard let at = line.range(of: "//") else { return String(line) }
                return String(line[..<at.lowerBound])
            }
            .joined(separator: "\n")
    }

    func testTheStackClaimsNothingOfItsOwn() throws {
        let text = try source("NoticeBanner.swift")
        let stack = code(try body(of: "NoticeStack", in: text))
        // A hit shape or a gesture anywhere in the stack claims the touch at
        // every pixel of the screen, because the stack's frame IS the screen so
        // the banner can sit at its top.
        for claim in ["contentShape", "onTapGesture", ".gesture(", ".overlay("] {
            XCTAssertFalse(
                stack.contains(claim),
                "NoticeStack uses " + claim + " on its own area. The stack fills the screen, so this claims "
                + "every touch on the page underneath it, including everywhere it draws nothing: the banner may "
                + "claim only what a card or a control draws."
            )
        }
    }

    func testTheBarPaintsItselfAndNotTheScreen() throws {
        // The one paint this view has, and where it may land. The desktop's bar
        // paints its whole rectangle because its view is sized to it and a view
        // claims every mouse event inside that rectangle whatever the page draws
        // there (see core/ui/banner.css), and this client now draws the same bar:
        // one surface behind the cards and the sweep row, which is what makes the
        // two clients one design.
        //
        // It may NOT be on the full-screen frame. The frame is the screen so the
        // bar can sit at its top, so a surface there would claim every touch on
        // the page underneath and the empty half of the screen would stop being
        // the page. Asserted by ORDER, because that is the difference and it is
        // not visible in a screenshot of a banner that happens to look right.
        let text = try source("NoticeBanner.swift")
        let stack = code(try body(of: "NoticeStack", in: text))
        XCTAssertTrue(stack.contains(".background("),
            "the bar paints nothing, so it no longer matches the desktop bar it is a copy of")
        let surface = try XCTUnwrap(stack.range(of: ".background(")?.lowerBound,
            "the bar's surface is gone")
        let filler = try XCTUnwrap(stack.range(of: "Spacer(minLength: 0)")?.lowerBound,
            "the trailing filler is gone, so this test can no longer tell where the surface is applied")
        XCTAssertLessThan(surface, filler, "the bar's surface is applied after the trailing filler")
        // No closing bracket in the search: the real line continues with the
        // alignment, and a search string that includes it matches nothing.
        let screen = try XCTUnwrap(stack.range(of: ".frame(maxWidth: .infinity, maxHeight: .infinity")?.lowerBound,
            "the full-screen frame is gone")
        XCTAssertLessThan(filler, screen,
            "the full-screen frame is applied before the trailing filler, so the surface may be on the screen "
            + "rather than on the bar it belongs to")
    }

    func testTheStackKeepsItsCardsAtTheTopAndItselfOutOfTheWay() throws {
        let text = try source("NoticeBanner.swift")
        let stack = try body(of: "NoticeStack", in: text)
        // The two things that make the transparent region real: the stack IS the
        // screen (so what it does not draw is the page), and its trailing filler
        // is a Spacer, which draws nothing.
        XCTAssertTrue(stack.contains(".frame(maxWidth: .infinity, maxHeight: .infinity"),
            "NoticeStack no longer fills its container, so \"everything outside the cards is the page\" is no "
            + "longer the reason its empty area is safe")
        XCTAssertTrue(stack.contains("Spacer(minLength: 0)"),
            "the trailing filler is no longer a Spacer, so the region under the cards may now be drawn")
        XCTAssertTrue(stack.contains(".transition("),
            "the card arrival animation is gone; this assertion exists only to keep the test reading the same "
            + "struct the app ships, and it should be replaced rather than deleted")
    }

    func testWhatTheBannerDrawsItAlsoKeeps() throws {
        // The other direction, so this file cannot be satisfied by a banner that
        // claims nothing anywhere and cannot be pressed: the card draws a
        // surface, and the sweep is a Button with a hit shape of its own.
        let text = try source("NoticeBanner.swift")
        let card = try body(of: "NoticeCard", in: text)
        XCTAssertTrue(card.contains(".background(style.surface)"),
            "the card no longer draws its own surface, so a touch on the bar would pass to the page behind it")
        let row = try body(of: "MarkAllReadRow", in: text)
        XCTAssertTrue(row.contains("Button"),
            "the sweep row is no longer a Button, so \"Mark all read\" cannot be pressed")
        XCTAssertTrue(row.contains("contentShape"),
            "the sweep row's label no longer carries a contentShape, so only its drawn glyphs would be tappable")
    }

    func testTheBannerIsAnOverlaySoThePageKeepsItsLayout() throws {
        // The page is the gateway's and this client does not reflow it: the
        // banner floats above it, which is what makes "the region the banner
        // does not draw is the page" true in the first place.
        let text = try source("ContentView.swift")
        XCTAssertTrue(text.contains("content.overlay(alignment: .top) { NoticeStack(board: board) }"),
            "the banner is no longer an overlay at the top of the surface, so it may now take layout from the "
            + "page it is drawn over")
    }
}
