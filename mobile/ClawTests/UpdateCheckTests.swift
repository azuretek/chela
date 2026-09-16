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
    /// not even fetch: it returns before touching the network. A BACKGROUND check,
    /// so the stand-down is silent; the manual direction is asserted separately.
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

    /*
     * The two directions of a PRESS.
     *
     * The bug behind these: the check ran, compared against the running build,
     * and found a release, while the surface it was pressed on drew the banner
     * underneath itself, so nothing was reported. And in the other direction a
     * background check's silence was carried into a manual one, so pressing the
     * button on a current build reported nothing at all. Both halves are asserted
     * here rather than one, because one direction of proof is what let the silent
     * half through.
     */

    /// A press on a build that is current is answered: it must never do nothing.
    func testAManualCheckThatFindsNothingSaysSo() async throws {
        let board = board()
        let feed = atom("1.0.1-dev.148.abc1234567")
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567", fetch: { _ in feed })

        await check.run(trigger: .manual)

        let notice = try XCTUnwrap(
            board.all.first { $0.id == UpdateCheck.answerNoticeId },
            "a press on a current build must be answered"
        )
        XCTAssertEqual(notice.tone, NoticeTone.ok)
        XCTAssertTrue(notice.message.contains("up to date"), notice.message)
        XCTAssertEqual(notice.detail, "You are on 1.0.1-dev.148.abc1234567.")
        XCTAssertNotNil(board.unread.first { $0.id == UpdateCheck.answerNoticeId }, "and it is drawn")
        // The standing "a release exists" notice is not what answers this: there
        // is no release, so it stays absent.
        XCTAssertNil(board.all.first { $0.id == UpdateCheck.noticeId })
    }

    /// The other direction on the same path, so the two cannot drift apart: a
    /// press that finds a newer build names it and points at TestFlight.
    func testAManualCheckThatFindsANewerBuildNamesIt() async throws {
        let board = board()
        let feed = atom("1.0.1-dev.150.abc1234567")
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567", fetch: { _ in feed })

        await check.run(trigger: .manual)

        let notice = try XCTUnwrap(board.all.first { $0.id == UpdateCheck.noticeId }, "the update notice was not raised")
        XCTAssertTrue(notice.message.contains("1.0.1-dev.150.abc1234567"), notice.message)
        XCTAssertEqual(notice.detail, "You are on 1.0.1-dev.148.abc1234567. Open TestFlight to update.")
        XCTAssertEqual(notice.action?.command, UpdateCheck.openTestFlightCommand)
        // Answered rather than duplicated: the standing notice IS the answer here,
        // so a separate "up to date" style reply must not sit beside it.
        XCTAssertNil(board.all.first { $0.id == UpdateCheck.answerNoticeId })
    }

    /// A press the feed could not be read for is still answered, as a warning.
    func testAManualCheckThatCouldNotFinishSaysSo() async throws {
        let board = board()
        struct Offline: Error {}
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567", fetch: { _ in throw Offline() })

        await check.run(trigger: .manual)

        let notice = try XCTUnwrap(board.all.first { $0.id == UpdateCheck.answerNoticeId })
        XCTAssertEqual(notice.tone, NoticeTone.warn, "a check that could not finish is not good news")
        XCTAssertTrue(notice.message.contains("Could not check for updates"), notice.message)
    }

    /// A build with no feed to read answers the press with why, rather than
    /// standing down silently as it does for its own background check.
    func testAStableBuildAnswersAPressWithWhy() async throws {
        let board = board()
        var fetched = false
        let check = UpdateCheck(board: board, currentVersion: "1.0.1", fetch: { _ in
            fetched = true
            return self.atom("2.0.0")
        })

        await check.run(trigger: .manual)

        XCTAssertFalse(fetched, "a stable build has no feed to read, so nothing is fetched")
        let notice = try XCTUnwrap(board.all.first { $0.id == UpdateCheck.answerNoticeId })
        XCTAssertEqual(notice.tone, NoticeTone.info)
        XCTAssertTrue(notice.message.contains("Updates are not available"), notice.message)
    }

    /// The answer is a reply rather than a standing condition, so it takes itself
    /// away. The standing update notice is the opposite and is never timed out:
    /// losing it would mean waiting for the next check to hear about a build that
    /// is already published.
    func testTheAnswerIsShortLivedAndTheStandingNoticeIsNot() async throws {
        let board = board()
        let feed = atom("1.0.1-dev.148.abc1234567")
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567", fetch: { _ in feed })

        await check.run(trigger: .manual)
        XCTAssertNotNil(board.all.first { $0.id == UpdateCheck.answerNoticeId })
        XCTAssertGreaterThan(UpdateCheck.answerTtlMs, 0)

        try await Task.sleep(nanoseconds: UInt64(UpdateCheck.answerTtlMs) * 1_000_000 + 400_000_000)
        XCTAssertNil(board.all.first { $0.id == UpdateCheck.answerNoticeId }, "the reply takes itself away")
    }

    #if DEBUG
    /// The feed a screenshot run hands the check has to be a document the reader
    /// actually reads.
    ///
    /// This is the bug that made the report what it was, one layer under the
    /// notice: the seeded body was a one-line JSON object and `UpdateFeed.decode`
    /// parses Atom, so the document failed to parse, the check answered nothing and
    /// the banner stayed empty. Nothing about that is visible in a screenshot of an
    /// empty banner, so it is asserted here: the seeded document decodes, the
    /// version inside it is the one the check reports, and a seeded feed naming this
    /// build is the no-update case which is what lets the two screenshots differ by
    /// the launch argument alone.
    func testTheSeededScreenshotFeedIsADocumentTheReaderReads() throws {
        let newer = "1.0.1-dev.150.abc1234567"
        let current = "1.0.1-dev.148.abc1234567"

        let document = try XCTUnwrap(UpdateFeed.decode(UpdateCheck.seededFeed(advertising: newer)),
                                     "the seeded feed must decode as the reader's own document")
        XCTAssertEqual(try UpdateFeed.newerVersion(in: document, current: current), newer,
                       "and a newer version in it must read as newer")

        let matching = try XCTUnwrap(UpdateFeed.decode(UpdateCheck.seededFeed(advertising: current)))
        XCTAssertNil(try UpdateFeed.newerVersion(in: matching, current: current),
                     "a seeded feed naming this build is the no-update case")
    }
    #endif
}
