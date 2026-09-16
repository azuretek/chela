import Foundation

/// Reading the public update feed, ported from `core/feed.js`.
///
/// This is the half of the update story that lives outside a signing accident:
/// `UpdatePolicy` answers what this build may DO about a newer version (on iOS,
/// only announce it), and this answers where the phone learns there is one and
/// how it reads the answer. The desktop never needs this, because electron-updater
/// has its own provider that walks the releases feed; the phone has no such
/// dependency and cannot authenticate to a gateway yet, so it reads a PUBLIC feed
/// directly, and the shape of that feed is what `core/feed.js` owns and this
/// mirrors.
///
/// The feed is a tiny static JSON document naming the newest build on a channel.
/// It is not electron-updater's `.yml` metadata, which carries a download URL, a
/// size and a checksum for a file an updater is about to apply; iOS applies
/// nothing, so all it needs is the version, and a marker that named an installer
/// would promise something no iOS build can honour.
///
/// Pure and Foundation-only, like `Version` and `UpdatePolicy`: no `URLSession`,
/// no clock. The caller supplies the bytes it fetched and this reads them, so the
/// parsing is testable from one run and proven against the same golden fixture the
/// JS asserts (`core/fixtures/feed.json`, via `UpdateFeedParityTests`). Fetching
/// the URL is `UpdateCheck`'s job, because a network call is exactly the part that
/// is not portable and not pure.
///
/// The two values mirrored from `core/spec/feed.json` (`pagesPath` and the channel
/// names) are asserted against the spec by `UpdateFeedParityTests`, the same
/// discipline `Naming` uses for a value that has to match a file it cannot import.
enum UpdateFeed {
    /// The channel a feed serves, as its filename stem. `dev` today; `latest`
    /// later. Mirrored from `spec/feed.json`.
    static let devChannel = "dev"
    static let stableChannel = "latest"

    /// Where the mobile release workflow publishes the marker and where the URL
    /// below reads it. The one string that workflow and `feedURL` share, mirrored
    /// from `spec/feed.json`'s `pagesPath`.
    static let pagesPath = "appcast"

    /// The public URL the phone reads for a channel's newest build.
    ///
    /// Built from the repo slug (`Naming`) rather than written out, so a rename
    /// moves it with everything else, and derived from the channel so the two
    /// feeds cannot be spelled two ways. A raw static document on GitHub Pages:
    /// public, unauthenticated, CDN-served, which is what lets the check run
    /// before the phone can authenticate to a gateway.
    static func feedURL(channel: String) -> URL? {
        URL(string: "https://\(Naming.repoOwner).github.io/\(Naming.repoName)/\(pagesPath)/\(channel).json")
    }

    /// The channel a build reads its feed from, from the build's own version.
    ///
    /// Derived from the version rather than a setting, matching `channelFor` in
    /// `core/feed.js`: the version is stamped at build time and travels with the
    /// app, so a build cannot be wrong about which channel it is on. Only `dev`
    /// has a feed today, which is honest about the world: TestFlight is the one
    /// distribution channel and every build on it is a dev build.
    static func channel(for version: String) -> String {
        // A prerelease identifier means a dev build; its absence means stable.
        // The same read `channelOf` does in `core/updates.js`.
        Version.parse(version)?.prerelease == nil ? stableChannel : devChannel
    }

    /// The version a feed document advertises, or nil if it names none.
    ///
    /// Returns nil rather than throwing on a shape it does not recognise, because
    /// a feed is a remote document the client did not write: a page half-deployed,
    /// an error page served with a 200, or a future field this build predates all
    /// arrive here, and none is a reason to crash a background check. A version
    /// that is PRESENT but unparseable is the one thing that throws, in
    /// `newerVersion`, because that is a feed lying about a release rather than one
    /// that has not published yet.
    static func version(in document: Document) -> String? {
        guard let raw = document.version else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The feed's version if it is strictly newer than this build, otherwise nil.
    ///
    /// The whole question the update check asks, in one place so the client is a
    /// fetch and a branch rather than a second copy of the comparison. `nil` means
    /// "nothing to say", which covers both a feed that names no version and a feed
    /// whose version is this build or older: the two cases the banner must stay
    /// absent for.
    ///
    /// The comparison is `Version.isNewer`, the same one the desktop reaches
    /// through semver, so a build the desktop would offer an update to is one the
    /// phone offers one to as well. An unparseable feed version throws rather than
    /// sorting arbitrarily, matching the JS: a feed that handed the check a value
    /// it cannot read is a fault to surface, not a silent "not newer".
    static func newerVersion(in document: Document, current: String) throws -> String? {
        guard let advertised = version(in: document) else { return nil }
        // A current version this build cannot even parse is our own bug, not the
        // feed's, and it must not silently suppress an update: let it throw.
        guard Version.parse(current) != nil else { throw Version.Failure.notAVersion(current) }
        return try Version.isNewer(advertised, than: current) ? advertised : nil
    }

    /// The static feed document, decoded. Only `version` is read; every other
    /// field a future feed carries is ignored, matching the JS reading exactly one
    /// key out of an object that may hold more.
    struct Document: Decodable {
        let version: String?
    }

    /// Decode the bytes a client fetched into a `Document`, or nil if they are not
    /// JSON at all. A body that is not JSON is the same class of non-answer as a
    /// document that names no version, so it becomes nil here rather than an error
    /// the check has to handle separately.
    static func decode(_ data: Data) -> Document? {
        try? JSONDecoder().decode(Document.self, from: data)
    }
}
