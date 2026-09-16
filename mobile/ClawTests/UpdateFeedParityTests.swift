import XCTest

@testable import Claw

/// Parity with `core/feed.js`, proven against the same golden fixture the JS side
/// asserts in `core/test/feed.test.js` (`core/fixtures/feed.json`).
///
/// This is the contract that lets the phone read one feed the same way the JS
/// does: both reproduce these document/current/result triples, so a build the JS
/// would announce an update to is one the phone announces one to as well. Change
/// the reading rule, regenerate the fixture, and this is what makes the Swift move
/// with it.
///
/// The two mirrored spec values (`pagesPath` and the channel names) are asserted
/// against `core/spec/feed.json` here too, the same discipline the naming parity
/// test uses for a value a client cannot import at runtime: the feed URL the phone
/// reads and the path the workflow publishes to must be one string, and this is
/// where they are checked to be.
final class UpdateFeedParityTests: XCTestCase {
    private struct Fixture: Decodable {
        let cases: [Case]
    }

    private struct Case: Decodable {
        let name: String
        let document: UpdateFeed.Document
        let current: String
        let newer: String?
        let `throws`: Bool?
    }

    func testNewerVersionReproducesEveryFixture() throws {
        let fixture = try Fixtures.load("feed", as: Fixture.self)
        XCTAssertFalse(fixture.cases.isEmpty, "expected feed fixtures")

        for testCase in fixture.cases {
            if testCase.throws == true {
                XCTAssertThrowsError(
                    try UpdateFeed.newerVersion(in: testCase.document, current: testCase.current),
                    testCase.name
                )
                continue
            }
            let result = try UpdateFeed.newerVersion(in: testCase.document, current: testCase.current)
            XCTAssertEqual(result, testCase.newer, testCase.name)
        }
    }

    /// The two values mirrored from `spec/feed.json`. The phone builds the feed
    /// URL from `pagesPath` and the channel name, and the mobile release workflow
    /// publishes to the same `pagesPath`, so a drift here points the check at a
    /// file that does not exist.
    func testTheFeedSpecValuesMirrorTheSpec() throws {
        struct FeedSpec: Decodable {
            struct Channels: Decodable {
                let dev: String
                let stable: String
            }
            let pagesPath: String
            let channels: Channels
        }
        let spec: FeedSpec = try Fixtures.loadSpec("feed")
        XCTAssertEqual(UpdateFeed.pagesPath, spec.pagesPath, "UpdateFeed.pagesPath disagrees with core/spec/feed.json")
        XCTAssertEqual(UpdateFeed.devChannel, spec.channels.dev, "UpdateFeed.devChannel disagrees with core/spec/feed.json")
        XCTAssertEqual(UpdateFeed.stableChannel, spec.channels.stable, "UpdateFeed.stableChannel disagrees with core/spec/feed.json")
    }

    /// A dev build reads the dev feed and a stable build the stable one, the same
    /// read `channelFor` does in `core/feed.js`.
    func testChannelIsReadFromTheVersion() {
        XCTAssertEqual(UpdateFeed.channel(for: "1.0.1-dev.148.abc1234567"), UpdateFeed.devChannel)
        XCTAssertEqual(UpdateFeed.channel(for: "1.0.1"), UpdateFeed.stableChannel)
    }

    /// The URL is the repo slug, the shared path and the channel, and it is public
    /// so the check needs no gateway auth, which is the whole reason the phone can
    /// run it before it can authenticate.
    func testTheFeedURLIsPublicAndBuiltFromTheSlug() throws {
        let url = try XCTUnwrap(UpdateFeed.feedURL(channel: UpdateFeed.devChannel))
        XCTAssertEqual(
            url.absoluteString,
            "https://\(Naming.repoOwner).github.io/\(Naming.repoName)/\(UpdateFeed.pagesPath)/\(UpdateFeed.devChannel).json"
        )
        XCTAssertEqual(url.scheme, "https", "a public https feed, needing no gateway auth")
    }

    /// A body that is not JSON, or one naming no version, is a non-answer rather
    /// than an error the check has to handle: the banner simply stays absent.
    func testAGarbageBodyDecodesToNoAnnouncement() throws {
        XCTAssertNil(UpdateFeed.decode(Data("not json at all".utf8)))
        let empty = try XCTUnwrap(UpdateFeed.decode(Data("{}".utf8)))
        XCTAssertNil(try UpdateFeed.newerVersion(in: empty, current: "1.0.1"))
    }
}
