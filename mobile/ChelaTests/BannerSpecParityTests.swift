import UIKit
import XCTest

@testable import Chela

/// The iOS half of `core/test/banner-spec.test.js`, at runtime: the bundled
/// `banner.json` is the repository's, `BannerSpec` reads it whole, and the card's
/// X follows the store's dismiss rule.
@MainActor
final class BannerSpecParityTests: XCTestCase {
    private struct Spec: Decodable {
        struct Copy: Decodable { let label: String; let tooltip: String }
        struct Dismiss: Decodable { let icon: String; let read: Copy; let clears: Copy }
        struct Sweep: Decodable { let label: String; let tooltip: String }
        struct Card: Decodable { let controls: [String] }
        struct Icon: Decodable { let sfSymbol: String }
        let card: Card
        let dismiss: Dismiss
        let sweep: Sweep
        let toneIcon: [String: String]
        let icons: [String: Icon]
    }

    private func spec() throws -> Spec { try Fixtures.loadSpec("banner") }

    private func notice(dismissible: Bool = true, dismissClears: Bool = false) -> Notice {
        Notice(id: "n", tone: NoticeTone.info, message: "m", detail: nil, dismissible: dismissible,
               dismissClears: dismissClears, progress: nil, action: nil, read: false, order: 0)
    }

    func testTheBundledSpecIsTheRepositorys() throws {
        let url = try XCTUnwrap(Bundle(for: NoticeBoard.self).url(forResource: "banner", withExtension: "json")
            ?? Bundle.main.url(forResource: "banner", withExtension: "json"), "banner.json is not in the app bundle")
        let bundled = try Data(contentsOf: url)
        let repo = try Data(contentsOf: try Fixtures.spec().appendingPathComponent("banner.json"))
        XCTAssertEqual(bundled, repo, "the app ships a different banner.json from the repository's")
    }

    func testTheControlsAndTheirWordsAreTheSpecs() throws {
        let spec = try spec()
        XCTAssertEqual(BannerSpec.controls, spec.card.controls)
        XCTAssertEqual(BannerSpec.dismissCopy(for: notice())?.label, spec.dismiss.read.label)
        XCTAssertEqual(BannerSpec.dismissCopy(for: notice())?.tooltip, spec.dismiss.read.tooltip)
        XCTAssertEqual(BannerSpec.dismissCopy(for: notice(dismissClears: true))?.label, spec.dismiss.clears.label)
        XCTAssertEqual(BannerSpec.dismissCopy(for: notice(dismissClears: true))?.tooltip, spec.dismiss.clears.tooltip)
        XCTAssertNil(BannerSpec.dismissCopy(for: notice(dismissible: false)), "a card that refuses the X drew one")
        XCTAssertEqual(BannerSpec.sweep.label, spec.sweep.label)
        XCTAssertEqual(BannerSpec.sweep.tooltip, spec.sweep.tooltip)
        XCTAssertEqual(BannerSpec.dismissSymbol, spec.icons[spec.dismiss.icon]?.sfSymbol)
        for tone in NoticeTokens.toneNames {
            let name = try XCTUnwrap(spec.toneIcon[tone], "\(tone) has no icon in the spec")
            XCTAssertEqual(BannerSpec.toneSymbol(tone), spec.icons[name]?.sfSymbol, "\(tone) draws the wrong icon")
            XCTAssertNotNil(UIImage(systemName: BannerSpec.toneSymbol(tone) ?? ""), "\(tone)'s symbol does not exist")
        }
        XCTAssertNotNil(UIImage(systemName: BannerSpec.dismissSymbol), "the dismiss symbol does not exist")
    }

    func testTheXClearsADownloadAndReadsEverythingElse() {
        let board = NoticeBoard()
        board.raise("plain", NoticeRaise(message: "Refused"))
        board.raise("download", NoticeRaise(tone: NoticeTone.info, message: "Downloading", dismissClears: true, progress: 0.4))
        board.dismiss("plain")
        board.dismiss("download")
        XCTAssertEqual(board.all.map(\.id), ["plain"], "the download was read rather than cleared, or the plain one was cleared")
        XCTAssertTrue(board.all.first?.read ?? false, "the plain notice was not read")
        XCTAssertTrue(board.unread.isEmpty)
    }

    func testTheSweepIsOfferedWheneverAnythingIsUnread() {
        XCTAssertFalse(BannerSpec.sweepWanted([]))
        XCTAssertTrue(BannerSpec.sweepWanted([notice(dismissible: false)]), "the sweep refused a card that refuses its X")
    }
}
