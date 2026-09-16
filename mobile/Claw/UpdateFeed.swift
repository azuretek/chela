import Foundation

/// Reading the public update feed, ported from `core/feed.js`.
///
/// This is the half of the update story that lives outside a signing accident:
/// `UpdatePolicy` answers what this build may DO about a newer version (on iOS,
/// only announce it), and this answers where the phone learns there is one and
/// how it reads the answer. The desktop needs only the first, because
/// electron-updater has its own provider that walks the releases feed; the phone
/// has no such dependency and cannot authenticate to a gateway yet, so it reads
/// the SAME public releases the desktop does, directly, and the shape of that
/// read is what `core/feed.js` owns and this mirrors.
///
/// The feed is the repository's GitHub Releases, read as the Atom document GitHub
/// serves at `github.com/<owner>/<repo>/releases.atom`. There is nothing to
/// publish: a release already exists per build, so this reads the record the
/// repository already has rather than a second copy hand-published beside it. It
/// is releases.atom rather than `api.github.com/.../releases` for the reason the
/// desktop's provider is too: the Atom feed is CDN-served with no 60-per-hour
/// unauthenticated rate limit, which a dev build's five-minute check would
/// otherwise share across every device behind one IP.
///
/// Pure and Foundation-only, like `Version` and `UpdatePolicy`: no `URLSession`,
/// no clock. The caller supplies the bytes it fetched and this reads them, so the
/// parsing is testable from one run and proven against the same golden fixture the
/// JS asserts (`core/fixtures/feed.json`, via `UpdateFeedParityTests`). Fetching
/// the URL is `UpdateCheck`'s job, because a network call is exactly the part that
/// is not portable and not pure.
///
/// The values mirrored from `core/spec/feed.json` (`releasesPath` and the channel
/// names) are asserted against the spec by `UpdateFeedParityTests`, the same
/// discipline `Naming` uses for a value that has to match a file it cannot import.
enum UpdateFeed {
    /// The channel a build reads, as its spec name. `dev` today; `latest` later.
    /// Mirrored from `spec/feed.json`.
    static let devChannel = "dev"
    static let stableChannel = "latest"

    /// The path GitHub serves the releases Atom feed at, mirrored from
    /// `spec/feed.json`'s `releasesPath`. The one string this and the spec share.
    static let releasesPath = "releases.atom"

    /// The path a release's own notes live at, mirrored from `spec/feed.json`'s
    /// `releaseNotesPath` and asserted against it by `UpdateFeedParityTests`. The
    /// version is appended to it.
    static let releaseNotesPath = "releases/tag/v"

    /// The public URL the phone reads for the repository's releases.
    ///
    /// Built from the repo slug (`Naming`) rather than written out, so a rename
    /// moves it with everything else. One URL for both channels: the document
    /// lists every release newest-first and the reader picks the newest that
    /// belongs to the channel. releases.atom rather than the JSON API on purpose,
    /// so no api.github.com rate limit applies to a five-minute dev check. The
    /// same URL the desktop's electron-updater provider reads.
    static func feedURL() -> URL? {
        URL(string: "https://github.com/\(Naming.repoOwner)/\(Naming.repoName)/\(releasesPath)")
    }

    /// The real release notes for a version, or for the channel when there is no
    /// version to name.
    ///
    /// The port of `releaseNotesUrl()` in `core/feed.js`. NOT the store page this
    /// client's Release notes button used to open: TestFlight is where a newer
    /// build WAITS, not where its notes are, so a button labelled "Release notes"
    /// that landed there spent a click without answering the question. The notes
    /// for a release are the release's own page; with no version to name it is the
    /// channel's list of releases, which is what a dev build has.
    static func releaseNotesURL(version: String?) -> URL? {
        let repo = "\(Naming.repoOwner)/\(Naming.repoName)"
        let trimmed = version?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let url = trimmed.isEmpty
            ? "https://github.com/\(repo)/releases"
            : "https://github.com/\(repo)/\(releaseNotesPath)\(trimmed)"
        return URL(string: url)
    }

    /// The channel a build reads its releases as, from the build's own version.
    ///
    /// Derived from the version rather than a setting, matching `channelFor` in
    /// `core/feed.js`: the version is stamped at build time and travels with the
    /// app, so a build cannot be wrong about which channel it is on. Only `dev`
    /// has releases with a prerelease body today, which is honest about the world:
    /// TestFlight is the one distribution channel and every build on it is a dev
    /// build.
    static func channel(for version: String) -> String {
        // A prerelease identifier means a dev build; its absence means stable.
        // The same read `channelOf` does in `core/updates.js`.
        Version.parse(version)?.prerelease == nil ? stableChannel : devChannel
    }

    /// The version tag of one Atom entry, as a version string, or nil.
    ///
    /// GitHub's releases.atom names the release in the entry `<id>`, which ends
    /// `.../releases/<tag>`, and also in `<title>`. The `<id>` is the reliable
    /// one: a title can be an arbitrary release name, but the id always carries
    /// the tag. The tag is `v<version>`, so the leading `v` is stripped and what
    /// remains is handed to the version parser unchanged. Matches `tagVersion`
    /// in `core/feed.js`.
    static func tagVersion(_ entry: Entry) -> String? {
        let source = entry.id?.isEmpty == false ? entry.id : entry.title
        guard let source, let tag = source.split(separator: "/").last else { return nil }
        let trimmed = tag.trimmingCharacters(in: .whitespacesAndNewlines)
        let stripped = trimmed.hasPrefix("v") ? String(trimmed.dropFirst()) : trimmed
        return stripped.isEmpty ? nil : stripped
    }

    /// The newest release on a channel, from a releases document, or nil.
    ///
    /// Entries arrive newest first, which is how GitHub orders releases.atom, so
    /// the first entry whose tag belongs to the wanted channel is the newest
    /// release on it. The channel test is the tag's own prerelease body, the same
    /// signal `channelOf` reads, because Atom does not carry GitHub's
    /// `prerelease` boolean and the tag is the honest channel signal. An entry
    /// whose tag does not parse is skipped, matching the JS: a repository can
    /// carry a hand-made tag that is not one of ours. Mirrors `newestOnChannel`
    /// in `core/feed.js`.
    static func newestOnChannel(in document: Document, channel: String) -> String? {
        let wantPrerelease = channel == devChannel
        for entry in document.entries {
            guard let version = tagVersion(entry), let parsed = Version.parse(version) else { continue }
            let isPrerelease = parsed.prerelease != nil
            if isPrerelease == wantPrerelease { return version }
        }
        return nil
    }

    /// The newest release on this build's channel if it is strictly newer than
    /// this build, otherwise nil.
    ///
    /// The whole question the update check asks, in one place so the client is a
    /// fetch and a branch rather than a second copy of the comparison. `nil` means
    /// "nothing to say", which covers both a document with no release on this
    /// channel and one whose newest is this build or older: the two cases the
    /// banner must stay absent for.
    ///
    /// The comparison is `Version.isNewer`, the same one the desktop reaches
    /// through semver, so a build the desktop would offer an update to is one the
    /// phone offers one to as well. The channel is the build's own, so a dev build
    /// is only ever compared against dev releases. Mirrors `newerVersion` in
    /// `core/feed.js`.
    static func newerVersion(in document: Document, current: String) throws -> String? {
        // A current version this build cannot even parse is our own bug, not the
        // feed's, and it must not silently suppress an update: let it throw.
        guard Version.parse(current) != nil else { throw Version.Failure.notAVersion(current) }
        guard let advertised = newestOnChannel(in: document, channel: channel(for: current)) else { return nil }
        return try Version.isNewer(advertised, than: current) ? advertised : nil
    }

    /// One release, as the two fields the channel decision needs from an Atom
    /// `<entry>`: its `<id>` (which carries the tag) and its `<title>`. Every
    /// other field an entry holds is ignored, matching the JS reading only what
    /// the tag decision needs.
    ///
    /// `Decodable` so the golden fixture, which stores each entry as JSON, loads
    /// into the same type the Atom parser produces: the parity test reads the
    /// fixture, the real path reads releases.atom, and both hand this reader one
    /// `Document`.
    struct Entry: Decodable {
        let id: String?
        let title: String?
    }

    /// The releases document, its entries newest-first as GitHub orders them.
    struct Document: Decodable {
        let entries: [Entry]
    }

    /// Decode the bytes a client fetched into a `Document`, or nil if they are not
    /// the Atom feed at all. A body that is not the expected XML is the same class
    /// of non-answer as a document that names no release, so it becomes nil here
    /// rather than an error the check has to handle separately.
    ///
    /// Atom is XML, so this uses `XMLParser` rather than `JSONDecoder`: the JS
    /// side is handed already-parsed entries by its client, and this is the phone's
    /// equivalent parse step. It reads each `<entry>`'s `<id>` and `<title>` in
    /// document order, which is newest-first.
    static func decode(_ data: Data) -> Document? {
        let reader = AtomReader()
        let parser = XMLParser(data: data)
        parser.delegate = reader
        guard parser.parse(), reader.sawFeed else { return nil }
        return Document(entries: reader.entries)
    }

    /// Pulls `<id>` and `<title>` out of each `<entry>` of an Atom feed, in order.
    ///
    /// Deliberately small: it tracks only whether it is inside an `<entry>` and,
    /// within one, which of `<id>`/`<title>` is currently open, accumulating that
    /// element's text. The feed's own top-level `<id>` and `<title>` are ignored
    /// because they are not inside an `<entry>`. `sawFeed` guards against a body
    /// that parses as XML but is not an Atom feed at all.
    private final class AtomReader: NSObject, XMLParserDelegate {
        private(set) var entries: [Entry] = []
        private(set) var sawFeed = false

        private var inEntry = false
        private var currentField: String?
        private var text = ""
        private var entryId: String?
        private var entryTitle: String?

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                    qualifiedName: String?, attributes: [String: String]) {
            switch name {
            case "feed":
                sawFeed = true
            case "entry":
                inEntry = true
                entryId = nil
                entryTitle = nil
            case "id", "title" where inEntry:
                currentField = name
                text = ""
            default:
                break
            }
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) {
            if currentField != nil { text += string }
        }

        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?,
                    qualifiedName: String?) {
            switch name {
            case "id" where inEntry:
                if currentField == "id" { entryId = text }
                currentField = nil
            case "title" where inEntry:
                if currentField == "title" { entryTitle = text }
                currentField = nil
            case "entry":
                entries.append(Entry(id: entryId, title: entryTitle))
                inEntry = false
            default:
                break
            }
        }
    }
}
