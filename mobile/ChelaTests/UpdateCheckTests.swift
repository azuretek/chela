import XCTest

@testable import Chela

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
    ///
    /// The entry carries the iOS availability marker in its `<content>` by
    /// default, because a release that reaches the phone's banner is one with an
    /// installable TestFlight build: the phone's own reader filters to marked
    /// releases (`UpdateFeed.newerVersion`'s `iosOnly` defaults to true), so a
    /// feed with no marker is the desktop-only case rather than the ordinary one.
    /// `marked: false` builds that desktop-only case, used by the test that a
    /// release with no TestFlight build raises nothing on the phone.
    private func atom(_ tag: String, marked: Bool = true) -> Data {
        let body = marked ? "&lt;p&gt;notes&lt;/p&gt;\n\(UpdateFeed.iosMarker)" : "&lt;p&gt;desktop only&lt;/p&gt;"
        return Data("""
        <?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <id>tag:github.com,2008:https://github.com/o/r/releases</id>
          <title>Release notes from r</title>
          <entry>
            <id>tag:github.com,2008:Repository/1/v\(tag)</id>
            <title>v\(tag)</title>
            <content type="html">\(body)</content>
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

    /// ★ The reported bug at the flow layer: the feed's newest release has NO
    /// TestFlight build (no marker), so the phone raises nothing even though the
    /// version is newer. Without the fix this raised the banner and pointed the
    /// reader at a build that does not exist.
    func testAnUnmarkedNewerReleaseRaisesNothingOnThePhone() async throws {
        let board = board()
        let feed = atom("1.0.1-dev.279.9a58115cb1", marked: false)
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567", fetch: { _ in feed })

        await check.run()

        XCTAssertNil(
            board.all.first { $0.id == UpdateCheck.noticeId },
            "a release with no installable TestFlight build must not be offered on iOS"
        )
        XCTAssertTrue(board.unread.isEmpty, "the banner has nothing to draw")
    }

    /// The same, for a PRESS: a manual check whose only newer release has no
    /// TestFlight build answers "up to date" rather than offering a phantom
    /// build.
    func testAManualCheckOffersNoUnmarkedRelease() async throws {
        let board = board()
        let feed = atom("1.0.1-dev.279.9a58115cb1", marked: false)
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567", fetch: { _ in feed })

        await check.run(trigger: .manual)

        XCTAssertNil(board.all.first { $0.id == UpdateCheck.noticeId }, "no phantom offer")
        let notice = try XCTUnwrap(
            board.all.first { $0.id == UpdateCheck.answerNoticeId },
            "a press is still answered"
        )
        XCTAssertEqual(notice.tone, NoticeTone.ok)
        XCTAssertTrue(notice.message.contains("up to date"), notice.message)
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

    /// An older RELEASE is not newer, so again nothing is raised.
    ///
    /// The tag used to name an older BUILD of the same release
    /// (`1.0.1-dev.147` against `1.0.1-dev.148`), which the check could only
    /// refuse by ranking the build and commit tail. That tail's basis changes,
    /// so ranking it is what froze the updates (see the test below), and the one
    /// thing the comparison may still refuse is a genuinely older release. This
    /// case carries that instead, so the "not simply always-on" half of the rule
    /// is still asserted.
    func testAnOlderFeedRaisesNothing() async throws {
        let board = board()
        let feed = atom("1.0.0-dev.147.abc1234567")
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567", fetch: { _ in feed })

        await check.run()

        XCTAssertNil(board.all.first { $0.id == UpdateCheck.noticeId })
    }

    /// ★ The reported bug: a build whose number looks HIGHER than the feed's is
    /// still offered the newest release.
    ///
    /// The tail after the release is build and commit information, and its basis
    /// has changed, so an installed build from the old scheme carries a number
    /// every later build sits below. Ranking it decided the installed build was
    /// AHEAD of the feed and offered nothing, which is how builds stopped
    /// arriving on a phone whose number appeared to go backwards.
    ///
    /// The signal that cannot invert is the feed's own ordering, so the newest
    /// entry on the channel is offered whatever its tail says. This is the
    /// deliberate change of behaviour, not a widened rule: two builds of one
    /// release cannot be ordered against each other from the strings, and the
    /// feed has already said which of them is newer.
    func testAnOlderLookingTailIsStillOfferedTheNewestBuild() async throws {
        let board = board()
        let newest = "1.0.1-dev.12.1758000000"
        let feed = atom(newest)
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.195.6387043585", fetch: { _ in feed })

        await check.run()

        let notice = try XCTUnwrap(board.all.first { $0.id == UpdateCheck.noticeId },
                                   "a published build with a lower tail number is still newer")
        XCTAssertTrue(notice.message.contains(newest), "and the notice names it")
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

    /*
     * ★ A BACKGROUND CHECK IS NEWS; ONLY A NON-ANSWER IS NOT.
     *
     * The report this section exists for: on the phone the banner only ever
     * appeared when somebody pressed Check for updates. The raise was never the
     * cause -- it has been ungated since the banner existed, because a release that
     * EXISTS is news whatever started the check. The cause was the CADENCE: one
     * check at launch, and a phone app is then resident for days, so a release
     * published after that launch was nobody's news until a press asked for it.
     * `UpdateCadence` and `UpdateSchedule` are that half, and these assert what it
     * has to keep true: every BACKGROUND trigger announces a release it finds, and a
     * background non-answer stays silent.
     */

    /// A scheduled check that finds a newer build raises the standing banner with no
    /// press anywhere in this test.
    func testAScheduledCheckRaisesTheBannerWithNoPress() async throws {
        let board = board()
        let newer = "1.0.1-dev.150.abc1234567"
        let feed = atom(newer)
        let check = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567", fetch: { _ in feed })

        await check.run(trigger: .scheduled)

        let notice = try XCTUnwrap(board.all.first { $0.id == UpdateCheck.noticeId },
                                   "a background check that finds a release must raise the banner")
        XCTAssertTrue(notice.message.contains(newer), notice.message)
        XCTAssertNotNil(board.unread.first { $0.id == UpdateCheck.noticeId }, "and the banner draws it")
        XCTAssertEqual(notice.action?.command, UpdateCheck.openTestFlightCommand)
        // The standing notice, not a reply: nobody asked a question, so no answer
        // notice exists for the banner to be showing instead.
        XCTAssertNil(board.all.first { $0.id == UpdateCheck.answerNoticeId })
    }

    /// The other half of the same rule: a background check that finds nothing says
    /// nothing, in both of the ways it can find nothing.
    func testABackgroundCheckThatFindsNothingStaysSilent() async throws {
        let board = board()
        for trigger in [UpdateTrigger.startup, .scheduled] {
            let matching = atom("1.0.1-dev.148.abc1234567")
            let current = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567",
                                      fetch: { _ in matching })
            await current.run(trigger: trigger)
            XCTAssertTrue(board.all.isEmpty, "\(trigger.rawValue): nothing newer is not news")

            struct Offline: Error {}
            let offline = UpdateCheck(board: board, currentVersion: "1.0.1-dev.148.abc1234567",
                                      fetch: { _ in throw Offline() })
            await offline.run(trigger: trigger)
            XCTAssertTrue(board.all.isEmpty, "\(trigger.rawValue): a feed that could not be read is not news")
        }
    }

    /// The cadence follows this build's own channel, which is the rule the desktop's
    /// `checkIntervalMs` follows, read from the same spec.
    func testTheCadenceFollowsTheBuildsOwnChannel() {
        XCTAssertEqual(UpdateCadence.intervalMs(for: "1.0.1-dev.51.e8de8f92c2"), UpdatePolicy.prereleaseIntervalMs)
        XCTAssertEqual(UpdateCadence.intervalMs(for: "1.0.1"), UpdatePolicy.stableIntervalMs)
        // A version that cannot be read gets the SLOW interval: an unreadable
        // version must not become a reason to poll GitHub twelve times an hour.
        for version in ["", "not-a-version", "0"] {
            XCTAssertEqual(UpdateCadence.intervalMs(for: version), UpdatePolicy.stableIntervalMs, version)
        }
        // A cadence of zero would be a request loop rather than a cadence.
        XCTAssertGreaterThan(UpdatePolicy.prereleaseIntervalMs, 0)
        XCTAssertGreaterThanOrEqual(UpdatePolicy.stableIntervalMs, UpdatePolicy.prereleaseIntervalMs)
    }

    /// A check is due at launch, and after the interval, and NOT before it.
    func testACheckIsDueWithoutAHistoryAndAfterTheInterval() {
        let interval = 300_000
        XCTAssertTrue(UpdateCadence.isDue(lastCheckMs: nil, nowMs: 1_000_000, intervalMs: interval),
                      "a build that has never looked is due, which is the launch check")
        XCTAssertFalse(UpdateCadence.isDue(lastCheckMs: 1_000_000, nowMs: 1_000_000 + interval - 1, intervalMs: interval),
                       "a returning app inside the interval is not a second check")
        XCTAssertTrue(UpdateCadence.isDue(lastCheckMs: 1_000_000, nowMs: 1_000_000 + interval, intervalMs: interval),
                      "at the interval it is due, with no grace period to remember")
        XCTAssertFalse(UpdateCadence.isDue(lastCheckMs: 2_000_000, nowMs: 1_000_000, intervalMs: interval),
                       "a clock that moved backwards is not a reason to check")
    }

    /// ★ The schedule is what turns those two rules into a check that happens.
    ///
    /// The launch check runs once, and the ask is a second one: a started schedule
    /// looks immediately, and a foreground return inside the interval looks at
    /// nothing. That pair is the reported bug -- a phone resident for days that
    /// never looked again -- asserted as the behaviour rather than as the wiring.
    func testTheScheduleChecksAtLaunchAndAgainOnlyAfterTheInterval() async throws {
        let board = board()
        let version = "1.0.1-dev.148.abc1234567"
        let feed = atom("1.0.1-dev.150.abc1234567")
        let counter = FetchCounter()
        var clock = 1_000_000
        let schedule = UpdateSchedule(
            makeCheck: {
                UpdateCheck(board: board, currentVersion: version, fetch: { _ in
                    await counter.bump()
                    return feed
                })
            },
            currentVersion: { version },
            now: { clock }
        )

        // A schedule that was never started looks at nothing: this is the guard
        // that keeps a view appearing twice from doubling the cadence.
        schedule.becameActive()
        try await Task.sleep(nanoseconds: 50_000_000)
        let beforeStart = await counter.value
        XCTAssertEqual(beforeStart, 0, "an unstarted schedule does not check")

        schedule.start()
        try await eventually { await counter.value == 1 }
        XCTAssertNotNil(board.all.first { $0.id == UpdateCheck.noticeId },
                        "the schedule's own first check announced the release")

        // The same instant, so nothing has elapsed.
        schedule.becameActive()
        try await Task.sleep(nanoseconds: 100_000_000)
        let insideInterval = await counter.value
        XCTAssertEqual(insideInterval, 1, "coming back inside the interval is not a check")

        // Past the interval, coming back IS the check -- and it still announces the
        // same release rather than a second, different card.
        clock += UpdateCadence.intervalMs(for: version)
        schedule.becameActive()
        try await eventually { await counter.value == 2 }
        XCTAssertEqual(board.all.filter { $0.id == UpdateCheck.noticeId }.count, 1,
                       "a re-announcement is idempotent rather than a second card")
    }

    /// ★ The cadence itself runs: a started schedule looks again by itself, on the
    /// interval, with nobody touching the app.
    ///
    /// The interval is injected so this is a 40ms wait rather than five minutes: the
    /// rule being asserted is "the loop looks again with no press and no foreground
    /// return", and it is the loop that turns a cadence into an announcement on a
    /// phone left open. `becameActive` is asserted separately, and in production
    /// the two use the same `UpdateCadence` numbers, which
    /// `UpdatePolicyParityTests` holds to the shared spec.
    func testTheScheduleLooksAgainOnItsOwnCadence() async throws {
        let board = board()
        let version = "1.0.1-dev.148.abc1234567"
        let feed = atom("1.0.1-dev.150.abc1234567")
        let counter = FetchCounter()
        let schedule = UpdateSchedule(
            makeCheck: {
                UpdateCheck(board: board, currentVersion: version, fetch: { _ in
                    await counter.bump()
                    return feed
                })
            },
            currentVersion: { version },
            intervalMs: { _ in 40 }
        )

        schedule.start()
        try await eventually { await counter.value >= 3 }
        XCTAssertNotNil(board.all.first { $0.id == UpdateCheck.noticeId },
                        "the release the cadence keeps finding is announced, not only the first one")
        XCTAssertEqual(board.all.filter { $0.id == UpdateCheck.noticeId }.count, 1,
                       "and re-announcing it does not stack a card per cycle")
    }

    /// Whether `condition` becomes true within a second, letting the run loop turn
    /// while it waits: `UpdateSchedule` does its work in detached tasks, so a test
    /// cannot assert on the line after it starts one.
    private func eventually(_ condition: @escaping () async -> Bool, timeoutMs: Int = 2000) async throws {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while !(await condition()) {
            if Date() > deadline {
                XCTFail("condition did not hold within \(timeoutMs)ms")
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}

/// How many times a check actually reached the feed.
///
/// An actor rather than a captured `var`: the fetch closure is not main-actor
/// isolated, so a plain counter mutated inside it is the data race Swift 6 refuses
/// and a flaky count in practice.
private actor FetchCounter {
    private(set) var value = 0

    func bump() { value += 1 }
}
