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
    /// `core/spec/feed.json`, read from the app's own copy at runtime, which is
    /// the one pattern for every spec this app shares.
    private struct Spec: Decodable {
        let releasesPath: String
        let releaseNotesPath: String
        let iosMarker: String
        let channels: [String: String]
    }

    /// The keys this decodes, and the ones it deliberately does not.
    /// `BundledSpecTests` requires every key in the file to be one or the other.
    static let decodedKeys: Set<String> = ["releasesPath", "releaseNotesPath", "iosMarker", "channels"]
    static let ignoredKeys: Set<String> = []

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(releasesPath: "", releaseNotesPath: "", iosMarker: "", channels: [:])
        guard let spec = try? BundledSpec.load("feed", as: Spec.self), !spec.releasesPath.isEmpty else {
            return empty
        }
        return spec
    }

    /// The channel a build reads, as its spec name. `dev` today; `latest` later.
    static var devChannel: String { spec.channels["dev"] ?? "" }
    static var stableChannel: String { spec.channels["stable"] ?? "" }

    /// The path GitHub serves the releases Atom feed at.
    static var releasesPath: String { spec.releasesPath }

    /// The path a release's own notes live at. The version is appended to it.
    static var releaseNotesPath: String { spec.releaseNotesPath }

    /// The line a release carries in its body when, and only when, a TestFlight
    /// build of that version is installable.
    ///
    /// The phone's answer to a question the desktop never asks: a release exists
    /// per desktop-building commit, but a desktop-only or .github-only commit
    /// produces no mobile pipeline run and so no TestFlight build, and the phone
    /// reading that release would offer a build that does not exist. The marker
    /// rides in the release body because the phone reads releases.atom, whose
    /// entries carry the body as `<content>` but carry no assets. Mirrors
    /// `IOS_MARKER` in `core/feed.js`, asserted against `core/spec/feed.json` by
    /// `UpdateFeedParityTests`.
    static var iosMarker: String { spec.iosMarker }

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

    /// Whether one Atom entry's release carries the iOS availability marker.
    ///
    /// The marker rides in the release body, which GitHub emits as an entry's
    /// `<content>`, so this reads `entry.content` and asks whether the marker
    /// string appears in it. A missing content is `false`, the safe direction: a
    /// release with no body, or one that never carried the marker, is not one the
    /// phone may offer. A plain substring match rather than a line or a parse,
    /// because the body is HTML by the time it reaches `<content>` and the marker
    /// is deliberately plain ASCII so it survives HTML escaping unchanged.
    /// Mirrors `iosAvailable` in `core/feed.js`.
    static func iosAvailable(_ entry: Entry) -> Bool {
        guard let content = entry.content else { return false }
        return content.contains(iosMarker)
    }

    /// The newest release on a channel, from a releases document, or nil.
    ///
    /// Entries arrive newest first, which is how GitHub orders releases.atom, so
    /// the first entry whose tag belongs to the wanted channel is the newest
    /// release on it. The channel test is the tag's own prerelease body, the same
    /// signal `channelOf` reads, because Atom does not carry GitHub's
    /// `prerelease` boolean and the tag is the honest channel signal. An entry
    /// whose tag does not parse is skipped, matching the JS: a repository can
    /// carry a hand-made tag that is not one of ours.
    ///
    /// ★ `iosOnly` is the phantom-update fix: with it set, an entry whose release
    /// does not carry the iOS marker is skipped, so a desktop-only release is
    /// invisible to the phone even when it is the newest entry in the feed. The
    /// desktop reads every entry, because its own installers are on any release
    /// it published; the phone reads the narrower feed. The filter is on this one
    /// function so the two audiences cannot disagree about which entry is newest.
    /// Mirrors `newestOnChannel` in `core/feed.js`.
    static func newestOnChannel(in document: Document, channel: String, iosOnly: Bool = false) -> String? {
        let wantPrerelease = channel == devChannel
        for entry in document.entries {
            guard let version = tagVersion(entry), let parsed = Version.parse(version) else { continue }
            let isPrerelease = parsed.prerelease != nil
            if isPrerelease != wantPrerelease { continue }
            if iosOnly && !iosAvailable(entry) { continue }
            return version
        }
        return nil
    }

    /// Whether the build a feed named is newer than the build we are running.
    ///
    /// ★ THE SIGNAL IS THE FEED'S OWN ORDERING, NOT THE VERSION STRINGS.
    ///
    /// "Always pick the latest" has to be anchored in something that cannot
    /// invert, and the version strings can: the tail after the release is build
    /// and commit information whose basis has changed, so a build published this
    /// morning can carry a LOWER number than one published last week
    /// (`1.0.1-dev.195.6387043585` then `1.0.1-dev.12.1758000000`). Ranking that
    /// tail is what froze the updates: the check decided the installed build was
    /// AHEAD of the feed and offered nothing. The full statement of the rule is
    /// beside `compareRelease` in `Version.swift`.
    ///
    /// So the ordering signal is the FEED ITSELF: `newestOnChannel` returns the
    /// first entry belonging to this build's channel, and GitHub emits
    /// releases.atom newest-first by publish time, so that entry IS the newest
    /// published build on the channel, whatever its tail says. All this function
    /// then asks is whether that candidate is one the check should NOT offer, and
    /// there is exactly one such case: the feed's newest is a LOWER release than
    /// ours, which is a step backwards.
    ///
    /// Same release with a different tail IS offered, which is the reported bug
    /// rather than a widening of the rule: an installed build carrying an
    /// old-scheme tail looks numerically higher than every build published after
    /// it, and the feed has already said which one is newer.
    ///
    /// The exact build we are running is the one case where the tail still counts,
    /// for what it literally is: an identity, compared for equality. Mirrors
    /// `isNewerBuild` in `core/feed.js`.
    static func isNewerBuild(_ candidate: String, than current: String) throws -> Bool {
        guard Version.parse(current) != nil else { throw Version.Failure.notAVersion(current) }
        guard Version.parse(candidate) != nil else { throw Version.Failure.notAVersion(candidate) }

        // The feed's newest IS this build: nothing to announce.
        if candidate == current { return false }

        return try Version.compareRelease(candidate, current) >= 0
    }

    /// The newest release on this build's channel if it is newer than this build,
    /// otherwise nil.
    ///
    /// The whole question the update check asks, in one place so the client is a
    /// fetch and a branch rather than a second copy of the comparison. `nil` means
    /// "nothing to say", which covers both a document with no release on this
    /// channel and one whose newest is not newer than this build: the two cases
    /// the banner must stay absent for.
    ///
    /// The candidate is the feed's newest on this build's channel and the decision
    /// is `isNewerBuild`, the same one the desktop's updater path re-decides with,
    /// so a build the desktop offers an update to is one the phone offers one to
    /// as well. The channel is the build's own, so a dev build is only ever
    /// compared against dev releases. Mirrors `newerVersion` in `core/feed.js`.
    ///
    /// ★ `iosOnly` defaults to `true` here, because the caller of this method IS
    /// the phone (`UpdateCheck`): the phantom-update bug was the phone offering a
    /// desktop-only release, so the phone's own reader filters to releases that
    /// carry a TestFlight build by default. The default is on the client that
    /// only ever reads for itself; the shared rule in `core/feed.js` takes the
    /// audience as an argument because the desktop calls the same JS.
    static func newerVersion(in document: Document, current: String, iosOnly: Bool = true) throws -> String? {
        // A current version this build cannot even parse is our own bug, not the
        // feed's, and it must not silently suppress an update: let it throw.
        guard Version.parse(current) != nil else { throw Version.Failure.notAVersion(current) }
        guard let advertised = newestOnChannel(in: document, channel: channel(for: current), iosOnly: iosOnly) else { return nil }
        return try isNewerBuild(advertised, than: current) ? advertised : nil
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
        /// The release body, which GitHub emits as the entry's `<content>`. This
        /// is where the iOS availability marker rides, so `iosAvailable` reads it.
        /// Optional and defaulted, because a feed entry can carry no content and
        /// the golden fixture stores most cases without one.
        let content: String?

        init(id: String?, title: String?, content: String? = nil) {
            self.id = id
            self.title = title
            self.content = content
        }
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
        private var entryContent: String?

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                    qualifiedName: String?, attributes: [String: String]) {
            switch name {
            case "feed":
                sawFeed = true
            case "entry":
                inEntry = true
                entryId = nil
                entryTitle = nil
                entryContent = nil
            case "id", "title", "content" where inEntry:
                // `<content>` carries the release body, which is where the iOS
                // availability marker rides. GitHub emits it as escaped HTML, and
                // XMLParser unescapes it, so `text` accumulates the real body and
                // `iosAvailable` can substring-match the plain-ASCII marker in it.
                currentField = name
                text = ""
            default:
                break
            }
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) {
            if currentField != nil { text += string }
        }

        // `<content type="html">` is served as escaped text, but a feed can also
        // carry a CDATA body; this is what captures that form so the marker is
        // read either way.
        func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
            if currentField != nil, let chunk = String(data: CDATABlock, encoding: .utf8) {
                text += chunk
            }
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
            case "content" where inEntry:
                if currentField == "content" { entryContent = text }
                currentField = nil
            case "entry":
                entries.append(Entry(id: entryId, title: entryTitle, content: entryContent))
                inEntry = false
            default:
                break
            }
        }
    }
}
