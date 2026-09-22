import XCTest

@testable import Chela

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
        let iosCases: [Case]
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

        // The desktop audience: the filter OFF, so every release is read. The
        // phone would answer some of these differently, which is exactly why the
        // iOS cases are a separate array; here iosOnly is set false so this proves
        // the shared reader still reads the whole feed for the desktop.
        for testCase in fixture.cases {
            if testCase.throws == true {
                XCTAssertThrowsError(
                    try UpdateFeed.newerVersion(in: testCase.document, current: testCase.current, iosOnly: false),
                    testCase.name
                )
                continue
            }
            let result = try UpdateFeed.newerVersion(in: testCase.document, current: testCase.current, iosOnly: false)
            XCTAssertEqual(result, testCase.newer, testCase.name)
        }
    }

    /// ★ THE PHANTOM-UPDATE FIX, proven against the same golden iOS cases the JS
    /// asserts (`newerVersion(document, current, { iosOnly: true })` in
    /// `core/test/feed.test.js`).
    ///
    /// The phone offers a release only when it carries the iOS availability
    /// marker in its body, meaning a TestFlight build of that version is
    /// installable. So a desktop-only release, the newest entry in the feed, is
    /// invisible to the phone. `UpdateFeed.newerVersion`'s `iosOnly` defaults to
    /// true because its only caller is the phone, so these call it plainly, the
    /// way `UpdateCheck` does.
    func testIOSNewerVersionOffersOnlyReleasesWithATestFlightBuild() throws {
        let fixture = try Fixtures.load("feed", as: Fixture.self)
        XCTAssertFalse(fixture.iosCases.isEmpty, "expected iOS feed fixtures")
        for testCase in fixture.iosCases {
            let result = try UpdateFeed.newerVersion(in: testCase.document, current: testCase.current)
            XCTAssertEqual(result, testCase.newer, testCase.name)
        }
    }

    /// A desktop-only release, the newest in the feed, is offered to the desktop
    /// (iosOnly false) but not to the phone (the default), which is the exact bug
    /// this whole change fixes.
    func testADesktopOnlyReleaseIsInvisibleToThePhone() throws {
        let document = UpdateFeed.Document(entries: [
            UpdateFeed.Entry(
                id: ".../releases/v1.0.1-dev.279.9a58115cb1",
                title: "v1.0.1-dev.279.9a58115cb1",
                content: "<p>a .github-only change, no mobile run</p>"
            ),
        ])
        XCTAssertEqual(
            try UpdateFeed.newerVersion(in: document, current: "1.0.1-dev.148.abc1234567", iosOnly: false),
            "1.0.1-dev.279.9a58115cb1",
            "the desktop reads every release"
        )
        XCTAssertNil(
            try UpdateFeed.newerVersion(in: document, current: "1.0.1-dev.148.abc1234567"),
            "the phone is offered nothing without the marker"
        )
    }

    /// `iosAvailable` reads the marker out of an entry body, or false for a body
    /// that does not carry it and for an entry with no body at all.
    func testIOSAvailableReadsTheMarker() {
        XCTAssertTrue(UpdateFeed.iosAvailable(UpdateFeed.Entry(id: nil, title: nil, content: "notes\n\(UpdateFeed.iosMarker)")))
        XCTAssertTrue(UpdateFeed.iosAvailable(UpdateFeed.Entry(id: nil, title: nil, content: UpdateFeed.iosMarker)), "the marker alone is enough")
        XCTAssertFalse(UpdateFeed.iosAvailable(UpdateFeed.Entry(id: nil, title: nil, content: "<p>desktop only</p>")))
        XCTAssertFalse(UpdateFeed.iosAvailable(UpdateFeed.Entry(id: nil, title: nil, content: nil)), "no body is not available, the safe direction")
    }

    /// The marker survives a real Atom `<content>` round trip: the escaped HTML
    /// GitHub serves unescapes to the real body, and the plain-ASCII marker in it
    /// is read. This is the end-to-end proof that the phone can see the marker in
    /// the one document it actually reads.
    func testTheMarkerIsReadFromARealAtomBody() throws {
        let atom = """
        <?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <id>tag:github.com,2008:https://github.com/o/r/releases</id>
          <title>Release notes from r</title>
          <entry>
            <id>tag:github.com,2008:Repository/1/v1.0.1-dev.150.aaaaaaaaaa</id>
            <title>v1.0.1-dev.150.aaaaaaaaaa</title>
            <content type="html">&lt;p&gt;notes&lt;/p&gt;\n\(UpdateFeed.iosMarker)</content>
          </entry>
          <entry>
            <id>tag:github.com,2008:Repository/1/v1.0.1-dev.149.bbbbbbbbbb</id>
            <title>v1.0.1-dev.149.bbbbbbbbbb</title>
            <content type="html">&lt;p&gt;desktop only&lt;/p&gt;</content>
          </entry>
        </feed>
        """
        let document = try XCTUnwrap(UpdateFeed.decode(Data(atom.utf8)))
        XCTAssertEqual(document.entries.count, 2)
        XCTAssertTrue(UpdateFeed.iosAvailable(document.entries[0]), "the marker in the first entry's body is read")
        XCTAssertFalse(UpdateFeed.iosAvailable(document.entries[1]), "the second entry carries no marker")
        let newer = try UpdateFeed.newerVersion(in: document, current: "1.0.1-dev.148.abc1234567")
        XCTAssertEqual(newer, "1.0.1-dev.150.aaaaaaaaaa", "the phone offers the newest MARKED release")
    }

    /// ★ The rule the whole check turns on, in both directions.
    ///
    /// The reported bug was an installed build carrying an OLD-SCHEME tail whose
    /// number looks HIGHER than every build published since, so a check that
    /// ranked the tail decided the installed build was ahead and offered nothing.
    /// The signal that cannot invert is the feed's own ordering, which is why
    /// `newerVersion` takes the newest entry on the channel and asks
    /// `isNewerBuild` about it.
    func testTheReleaseOnlyRuleHoldsInBothDirections() throws {
        // 1. An old-scheme tail that looks higher is still offered the newest.
        XCTAssertTrue(try UpdateFeed.isNewerBuild("1.0.1-dev.12.1758000000", than: "1.0.1-dev.195.6387043585"))
        // ...and the comparison that shipped says the opposite, which is the bug.
        XCTAssertFalse(try Version.compare("1.0.1-dev.12.1758000000", "1.0.1-dev.195.6387043585") > 0)

        // 2. Tails running backwards: the newest by feed order still wins.
        let backwards = UpdateFeed.Document(entries: [
            UpdateFeed.Entry(id: ".../releases/v1.0.1-dev.3.1759000000", title: nil),
            UpdateFeed.Entry(id: ".../releases/v1.0.1-dev.2.1758000000", title: nil),
        ])
        // iosOnly false: this asserts the release-only ORDERING rule, which is
        // audience-independent, and the fixture carries no marker because the
        // marker is not what this case is about. The iOS filter is proven by the
        // iosCases fixture and the dedicated tests above.
        XCTAssertEqual(
            try UpdateFeed.newerVersion(in: backwards, current: "1.0.1-dev.20.1758500000", iosOnly: false),
            "1.0.1-dev.3.1759000000"
        )

        // 3. A genuinely older release is still refused, so this has not simply
        //    become an always-update.
        XCTAssertFalse(try UpdateFeed.isNewerBuild("1.0.0-dev.900.1700000000", than: "1.0.1-dev.195.6387043585"))
        // 4. And the build we are running is never offered back to us.
        XCTAssertFalse(try UpdateFeed.isNewerBuild("1.0.1-dev.12.1758000000", than: "1.0.1-dev.12.1758000000"))
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
            let iosMarker: String
            let channels: Channels
        }
        let spec: FeedSpec = try Fixtures.loadSpec("feed")
        XCTAssertEqual(UpdateFeed.releasesPath, spec.releasesPath, "UpdateFeed.releasesPath disagrees with core/spec/feed.json")
        XCTAssertEqual(UpdateFeed.iosMarker, spec.iosMarker, "UpdateFeed.iosMarker disagrees with core/spec/feed.json")
        XCTAssertFalse(UpdateFeed.iosMarker.isEmpty, "the iOS marker must be a real string, or every release reads as unavailable")
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
        // iosOnly false: this asserts DOCUMENT ORDER, which is audience-independent,
        // so the entries carry no marker and the reader is asked to read all of
        // them. The iOS marker filter has its own fixture and tests above.
        let newer = try UpdateFeed.newerVersion(in: document, current: "1.0.1-dev.148.abc1234567", iosOnly: false)
        XCTAssertEqual(newer, "1.0.1-dev.150.aaaaaaaaaa", "the newest matching entry, first in document order, is the answer")
    }
}
