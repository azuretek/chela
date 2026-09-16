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
/// The mirrored spec values (`releasesPath` and the channel names) are asserted
/// against `core/spec/feed.json` here too, the same discipline the naming parity
/// test uses for a value a client cannot import at runtime: the releases feed the
/// phone reads must be spelled the one way the spec spells it, and this is where
/// that is checked.
final class UpdateFeedParityTests: XCTestCase {
    private struct Fixture: Decodable {
        let cases: [Case]
        let releaseNotes: [ReleaseNotesCase]
    }

    private struct ReleaseNotesCase: Decodable {
        let name: String
        let version: String?
        let output: String
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

    /// The Release notes link, against the same cases the JS asserts.
    ///
    /// This is the one that shipped wrong: the phone's Release notes button
    /// opened TestFlight, which is where a build waits rather than where its notes
    /// are, so a person asking what changed got somewhere to install a build.
    func testReleaseNotesURLReproducesEveryFixture() throws {
        let fixture = try Fixtures.load("feed", as: Fixture.self)
        XCTAssertFalse(fixture.releaseNotes.isEmpty, "expected release-notes fixtures")
        for testCase in fixture.releaseNotes {
            XCTAssertEqual(
                UpdateFeed.releaseNotesURL(version: testCase.version)?.absoluteString,
                testCase.output,
                testCase.name
            )
        }
    }

    /// The URL is built from the repo slug and one path, and the path is the
    /// spec's rather than a literal here.
    func testTheReleaseNotesPathMirrorsTheSpec() throws {
        struct FeedSpec: Decodable {
            let releasesPath: String
            let releaseNotesPath: String
        }
        let spec: FeedSpec = try Fixtures.loadSpec("feed")
        XCTAssertEqual(UpdateFeed.releaseNotesPath, spec.releaseNotesPath)
        let url = try XCTUnwrap(UpdateFeed.releaseNotesURL(version: "1.0.1-dev.149.abc1234567"))
        XCTAssertEqual(url.absoluteString, "https://github.com/\(Naming.repoOwner)/\(Naming.repoName)/\(spec.releaseNotesPath)1.0.1-dev.149.abc1234567")
        XCTAssertFalse(url.absoluteString.contains("testflight"), "a release-notes link must not point at a distribution channel")
    }

    /// The values mirrored from `spec/feed.json`. The phone builds the releases
    /// URL from `releasesPath` and reads a build's channel by name, so a drift
    /// here points the check at the wrong URL or the wrong channel.
    func testTheFeedSpecValuesMirrorTheSpec() throws {
        struct FeedSpec: Decodable {
            struct Channels: Decodable {
                let dev: String
                let stable: String
            }
            let releasesPath: String
            let channels: Channels
        }
        let spec: FeedSpec = try Fixtures.loadSpec("feed")
        XCTAssertEqual(UpdateFeed.releasesPath, spec.releasesPath, "UpdateFeed.releasesPath disagrees with core/spec/feed.json")
        XCTAssertEqual(UpdateFeed.devChannel, spec.channels.dev, "UpdateFeed.devChannel disagrees with core/spec/feed.json")
        XCTAssertEqual(UpdateFeed.stableChannel, spec.channels.stable, "UpdateFeed.stableChannel disagrees with core/spec/feed.json")
    }

    /// A dev build reads the dev feed and a stable build the stable one, the same
    /// read `channelFor` does in `core/feed.js`.
    func testChannelIsReadFromTheVersion() {
        XCTAssertEqual(UpdateFeed.channel(for: "1.0.1-dev.148.abc1234567"), UpdateFeed.devChannel)
        XCTAssertEqual(UpdateFeed.channel(for: "1.0.1"), UpdateFeed.stableChannel)
    }

    /// The URL is the releases Atom feed built from the repo slug, on github.com
    /// rather than api.github.com (so no api rate limit applies to a five-minute
    /// dev check) and public (so the phone needs no gateway auth to read it),
    /// which is the whole reason the check can run before the phone can
    /// authenticate.
    func testTheFeedURLIsPublicAndBuiltFromTheSlug() throws {
        let url = try XCTUnwrap(UpdateFeed.feedURL())
        XCTAssertEqual(
            url.absoluteString,
            "https://github.com/\(Naming.repoOwner)/\(Naming.repoName)/\(UpdateFeed.releasesPath)"
        )
        XCTAssertEqual(url.scheme, "https", "a public https feed, needing no gateway auth")
        XCTAssertEqual(url.host, "github.com", "github.com, not api.github.com, so no api rate limit applies")
    }

    /// A body that is not the Atom feed, or a feed with no entries, is a
    /// non-answer rather than an error the check has to handle: the banner simply
    /// stays absent.
    func testAGarbageBodyDecodesToNoAnnouncement() throws {
        XCTAssertNil(UpdateFeed.decode(Data("not xml at all".utf8)), "a non-XML body is a non-answer")
        XCTAssertNil(UpdateFeed.decode(Data("<html><body>rate limited</body></html>".utf8)), "XML that is not an Atom feed is a non-answer")
        let empty = try XCTUnwrap(UpdateFeed.decode(Data("<feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>".utf8)))
        XCTAssertNil(try UpdateFeed.newerVersion(in: empty, current: "1.0.1"), "a feed with no entries announces nothing")
    }

    /// The Atom parser reads each entry's id and title in document order, which is
    /// newest-first, so the newest matching release is the first the reader meets.
    func testTheAtomParserReadsEntriesNewestFirst() throws {
        let atom = """
        <?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <id>tag:github.com,2008:https://github.com/o/r/releases</id>
          <title>Release notes from r</title>
          <entry>
            <id>tag:github.com,2008:Repository/1/v1.0.1-dev.150.aaaaaaaaaa</id>
            <title>v1.0.1-dev.150.aaaaaaaaaa</title>
          </entry>
          <entry>
            <id>tag:github.com,2008:Repository/1/v1.0.1-dev.149.bbbbbbbbbb</id>
            <title>v1.0.1-dev.149.bbbbbbbbbb</title>
          </entry>
        </feed>
        """
        let document = try XCTUnwrap(UpdateFeed.decode(Data(atom.utf8)))
        XCTAssertEqual(document.entries.count, 2, "both entries are read, and the feed's own id/title are not entries")
        let newer = try UpdateFeed.newerVersion(in: document, current: "1.0.1-dev.148.abc1234567")
        XCTAssertEqual(newer, "1.0.1-dev.150.aaaaaaaaaa", "the newest matching entry, first in document order, is the answer")
    }
}
