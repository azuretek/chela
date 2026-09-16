import XCTest

@testable import Claw

/// The fetch-and-raise flow, from a feed body to the notice on the board.
///
/// The parity tests prove `UpdateFeed` reads a feed the same way the JS does;
/// this proves the one impure piece on top of it does the right thing with the
/// answer. The fetcher is injected, so the whole flow runs without a network, and
/// what is asserted is the board the banner draws: a notice present when the feed
/// names a newer build, and absent when it names this one. That is the "appears
/// when newer, absent when it matches" contract the screenshots show, checked
/// here so it is not only shown.
@MainActor
final class UpdateCheckTests: XCTestCase {
    private func board() -> NoticeBoard { NoticeBoard() }

    /// A releases.atom body naming a single release, the shape the real feed has.
    /// The tag lives in the entry id, exactly where the reader looks for it.
    private func atom(_ tag: String) -> Data {
        Data("""
        <?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <id>tag:github.com,2008:https://github.com/o/r/releases</id>
          <title>Release notes from r</title>
          <entry>
            <id>tag:github.com,2008:Repository/1/v\(tag)</id>
            <title>v\(tag)</title>
          </entry>
        </feed>
        """.utf8)
    }

    /// The feed names a newer build: the banner appears, as an INFO notice whose
    /// action opens TestFlight and whose text names neither a download nor a
    /// restart, because iOS can do neither.
    func testANewerFeedRaisesTheUpdateNotice() async throws {
        let board = board()
        let feed = atom("1.0.1-dev.150.abc1234567")
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567", fetch: { _ in feed })

        await check.run()

        let notice = try XCTUnwrap(board.all.first { $0.id == UpdateCheck.noticeId }, "the update notice was not raised")
        XCTAssertEqual(notice.tone, NoticeTone.info, "a waiting update is news, not a failure")
        XCTAssertTrue(notice.message.contains("1.0.1-dev.150.abc1234567"), "the notice names the version the feed advertised")
        XCTAssertEqual(notice.action?.command, UpdateCheck.openTestFlightCommand)
        XCTAssertNotNil(board.unread.first { $0.id == UpdateCheck.noticeId }, "a fresh notice is unread, so the banner draws it")
        // iOS installs nothing, so the offer is to open TestFlight and the words
        // say so: no "download", no "restart".
        let text = "\(notice.message) \(notice.detail ?? "")".lowercased()
        XCTAssertFalse(text.contains("download"))
        XCTAssertFalse(text.contains("restart"))
        XCTAssertEqual(notice.action?.label, "Open TestFlight")
    }

    /// The feed names this build: nothing is raised, so the banner stays absent.
    func testAMatchingFeedRaisesNothing() async throws {
        let board = board()
        let feed = atom("1.0.1-dev.148.abc1234567")
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567", fetch: { _ in feed })

        await check.run()

        XCTAssertNil(board.all.first { $0.id == UpdateCheck.noticeId }, "a feed that matches this build must raise nothing")
        XCTAssertTrue(board.unread.isEmpty, "the banner has nothing to draw")
    }

    /// An older feed build is not newer, so again nothing is raised.
    func testAnOlderFeedRaisesNothing() async throws {
        let board = board()
        let feed = atom("1.0.1-dev.147.abc1234567")
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567", fetch: { _ in feed })

        await check.run()

        XCTAssertNil(board.all.first { $0.id == UpdateCheck.noticeId })
    }

    /// A fetch that throws is a check that could not run, not a fault to show: the
    /// board is left untouched rather than carrying a "could not check" banner on
    /// every flaky network.
    func testAFailedFetchRaisesNothing() async throws {
        let board = board()
        struct Offline: Error {}
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567", fetch: { _ in throw Offline() })

        await check.run()

        XCTAssertTrue(board.all.isEmpty, "an unreachable feed puts nothing on screen")
    }

    /// A stable build has no feed yet (only dev is published), so the check does
    /// not even fetch: it returns before touching the network.
    func testAStableBuildDoesNotFetch() async throws {
        let board = board()
        var fetched = false
        let check = UpdateCheck(board: board, currentVersion: "1.0.1", fetch: { _ in
            fetched = true
            return self.atom("2.0.0")
        })

        await check.run()

        XCTAssertFalse(fetched, "a stable build has no feed to read, so nothing is fetched")
        XCTAssertTrue(board.all.isEmpty)
    }

    /// Re-announcing the same version changes nothing on screen, because the
    /// notice is keyed and idempotent: a second poll finding the same newer build
    /// does not replay the banner's arrival.
    func testReAnnouncingTheSameVersionIsIdempotent() async throws {
        let board = board()
        let feed = atom("1.0.1-dev.150.abc1234567")
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567", fetch: { _ in feed })

        await check.run()
        let first = board.all.count
        await check.run()

        XCTAssertEqual(board.all.count, first, "a re-announcement of the same version adds no second notice")
    }
}
