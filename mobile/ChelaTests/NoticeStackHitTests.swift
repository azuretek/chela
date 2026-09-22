import XCTest
@testable@testable import Chela

/// What the phone's notice banner claims, and why it is a source rule here
/// rather than a click test.
///
/// This is the other client's half of the fault Abi reported on 2026-09-17, and
/// the two halves are NOT the same rule, because the clients are not the same
/// machinery.
///
/// On the desktop the banner is a page in a WebContentsView, and a view claims
/// every mouse event inside its own RECTANGLE whatever the page draws there. That
/// is why the desktop now sizes that view to the CARD CLUSTER rather than the
/// window (Abi, 2026-09-19: "floating cards no full width bar"): only the cards'
/// pixels claim a click, and the strip beside and below them passes through. See
/// core/ui/banner.js, core/ui/banner.css and desktop/scripts/prove-floating-
/// cards.mjs, and desktop/test/banner.test.js for the guard that keeps a
/// full-width strip from coming back.
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
        let file = try Fixtures.root().appendingPathComponent("mobile").appendingPathComponent("Chela")
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

    func testTheStackPaintsNoBandOfItsOwn() throws {
        // ★ Floating cards, not a bar. Abi, 2026-09-19: "floating cards no full
        // width bar that's pointless". The stack must paint NO surface of its own,
        // because a band is a full-width strip and this stack's frame is the whole
        // screen: a background that draws on it would cover (and, being a drawn
        // surface, claim) every pixel the cards do not, which is the dead zone the
        // desktop removed by sizing its view to the cards. Each CARD keeps its own
        // surface (testWhatTheBannerDrawsItAlsoKeeps), so the cluster is legible
        // while its empty area stays the page. This replaces
        // testTheBarPaintsItselfAndNotTheScreen, which asserted the opposite for
        // the old full-width bar.
        //
        // ★ The rule is about what a background DRAWS, not about the modifier
        // being present, and 2026-09-21 is why. The notice layer (see
        // `NoticeWindow`) claims a touch only inside the box the cards drew, and
        // the stack is what reports that box: a `Color.clear` probe read by a
        // `GeometryReader`. That background paints nothing, so it is a measurement
        // rather than the band this test forbids, but a scan for the modifier's
        // name reported it as the fault and took both iOS legs of run 35626768078
        // down with it. What is asserted now is the rule's own content: every
        // background the stack carries is that transparent probe, and a surface
        // that draws is still the failure.
        let text = try source("NoticeBanner.swift")
        let stack = code(try body(of: "NoticeStack", in: text))
        for argument in backgroundArguments(in: stack) {
            XCTAssertTrue(argument.contains("Color.clear"),
                "NoticeStack carries a background that is not the transparent box probe: " + argument + ". Its frame "
                + "is the screen, so a surface that draws there covers every touch on the page the cards do not: only "
                + "the cards may paint.")
            for paint in ["style.", ".fill(", "Gradient", "Rectangle", "Material", "Image("] {
                XCTAssertFalse(argument.contains(paint),
                    "NoticeStack's background paints with " + paint + ": " + argument + ". The only background the "
                    + "stack may carry is the transparent probe that reports the cluster box for the notice layer's "
                    + "touch rule, so a painted one is the band the cards' own surfaces replaced.")
            }
        }
    }

    /// Every `.background` a piece of source applies, as the text of its argument.
    ///
    /// Both spellings SwiftUI accepts are read, `.background(...)` and the trailing
    /// closure `.background { ... }`, and the argument is taken by balancing its own
    /// delimiters so that a nested call does not end it early. Deliberately crude,
    /// like `body(of:in:)` above: what is being read is the text an argument draws
    /// with, and that text is short enough to read whole.
    private func backgroundArguments(in text: String) -> [String] {
        let source = Array(text)
        let marker = Array(".background")
        var arguments: [String] = []
        var index = 0
        while index + marker.count <= source.count {
            guard source[index..<(index + marker.count)].elementsEqual(marker) else {
                index += 1
                continue
            }
            var at = index + marker.count
            while at < source.count, source[at] == " " || source[at] == "\n" {
                at += 1
            }
            guard at < source.count, source[at] == "(" || source[at] == "{" else {
                index += marker.count
                continue
            }
            let opener = source[at]
            let closing: Character = opener == "(" ? ")" : "}"
            var depth = 0
            var end = at
            while end < source.count {
                if source[end] == opener { depth += 1 }
                if source[end] == closing {
                    depth -= 1
                    if depth == 0 { break }
                }
                end += 1
            }
            arguments.append(String(source[at..<Swift.min(end + 1, source.count)]))
            index = end + 1
        }
        return arguments
    }

    func testTheCardsHugTheTopTrailingCorner() throws {
        // The cards float at the top-trailing corner, the edge the desktop cluster
        // hugs, so the two clients read alike. The frame still fills its container
        // (that is what keeps the empty area the page, below), but its alignment is
        // topTrailing rather than top, and the inner card VStack is no longer
        // stretched to full width.
        let text = try source("NoticeBanner.swift")
        let stack = code(try body(of: "NoticeStack", in: text))
        XCTAssertTrue(stack.contains(".frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)"),
            "NoticeStack no longer pins its cards to the top-trailing corner, so it does not match the desktop "
            + "cluster's placement")
        // The inner card cluster must NOT stretch to full width any more, or it is
        // a bar again in all but the background.
        XCTAssertFalse(stack.contains(".frame(maxWidth: .infinity, alignment: .trailing)"),
            "the inner card cluster still stretches to full width, so it is a full-width bar without the paint")
    }

    func testTheStackKeepsItsCardsAtTheTopAndItselfOutOfTheWay() throws {
        let text = try source("NoticeBanner.swift")
        let stack = try body(of: "NoticeStack", in: text)
        // The two things that make the transparent region real: the stack IS the
        // screen (so what it does not draw is the page), and its trailing filler
        // is a Spacer, which draws nothing. With the cards floating, the empty area
        // is even larger, so this matters more, not less.
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

    func testThePageKeepsItsLayoutBecauseTheStackIsNotDrawnInIt() throws {
        // The page is the gateway's and this client does not reflow it: the banner
        // floats above it, which is what makes "the region the banner does not draw
        // is the page" true in the first place. Since 2026-09-21 that floating
        // surface is the notice layer (a window above the app's own) rather than an
        // overlay applied per layer, which is what drew a copy on every screen and
        // is what Abi reported. See NoticeLayerTests.
        let text = try source("NoticeBanner.swift")
        let stack = code(try body(of: "NoticeStack", in: text))
        XCTAssertFalse(stack.contains("content.overlay"),
            "the stack is applied as an overlay again, which is the per-layer shape the notice layer replaced")
        XCTAssertTrue(text.contains("NoticeWindow.coordinateSpace"),
            "the stack no longer reports the box it drew, so the notice layer would have nothing to claim")
    }
}
