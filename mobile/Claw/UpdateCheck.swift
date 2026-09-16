import Foundation

/// The update check: fetch the public feed, ask whether it names a newer build,
/// and if so raise a notice through the shared model so the banner shows it.
///
/// This is the one impure part of the update story, and it is deliberately thin.
/// The two decisions it rests on live elsewhere and are shared with the desktop:
/// `UpdatePolicy` says iOS may only announce a release (never install one), and
/// `UpdateFeed` reads the feed and answers "is this newer" with the same
/// comparator the desktop reaches. So this type does no comparing and no policy
/// of its own; it fetches bytes, hands them to `UpdateFeed`, and turns a positive
/// answer into a raise on the `NoticeBoard` that already draws every other notice.
///
/// Why it exists as its own type rather than a method on the board: the board is
/// pure of the network on purpose (it is what makes it testable and what keeps a
/// notice raised where the app genuinely learns a condition), and a `URLSession`
/// call is exactly what does not belong in it. The fetcher is injected, so this
/// whole flow, from a feed body to the notice on screen, is exercised in a test
/// without a network, which is how the "appears when newer, absent when it
/// matches" contract is proven.
@MainActor
final class UpdateCheck {
    /// How the check reaches the network. Injected so a test can hand it a feed
    /// body without a `URLSession`, and so the real one is the only thing that
    /// touches the network. Returns the raw bytes of the feed document, or throws
    /// the way a fetch throws: a network the check cannot reach is not a fault to
    /// surface, it is a check that could not run this time, and the caller treats
    /// a throw as exactly that.
    typealias Fetch = (URL) async throws -> Data

    /// The notice id, matching the desktop's id for the same condition so a log
    /// from either client reads the same way (`update-available` in
    /// `src/main.js`).
    static let noticeId = "update-available"

    /// The command the banner's action carries. Answered by `ContentView`, which
    /// is the surface that can open a URL; the board only carries the name, the
    /// same shape the connection notice's `settings` command uses.
    static let openTestFlightCommand = "update-open-testflight"

    /// Where the tap sends someone. TestFlight is the one distribution channel
    /// today (the mobile pipeline uploads every build to it), so the newer build
    /// the feed announced is the one already waiting there for this tester. The
    /// itms-beta scheme opens the TestFlight app straight to this app if it is
    /// installed; the https URL is the fallback the OS uses when it is not, which
    /// lands on the TestFlight page and offers to install it.
    ///
    /// Not a channel baked into the shared policy: `core/updates.js` names none on
    /// purpose, because which mechanism delivers the next build is an open
    /// decision. It is named here, in the one client that has an install link to
    /// offer, rather than in the rule both clients share.
    static let testFlightURL = URL(string: "https://testflight.apple.com/")!

    /// The last version this app told the reader about, for the one other place
    /// that needs it: the About page's Release notes button, which should open
    /// the notes for the build that was actually announced rather than the list.
    /// A last-known value rather than state the About page queries through the
    /// board, because the board holds a rendered message and re-reading a version
    /// out of it would be parsing our own copy back.
    @MainActor private(set) static var announcedVersion: String?

    private let board: NoticeBoard
    private let currentVersion: String
    private let fetch: Fetch

    /// - Parameters:
    ///   - board: the live notice board the banner draws.
    ///   - currentVersion: this build's own identity, `Naming.buildVersion`.
    ///   - fetch: how to read the feed URL; defaults to a plain `URLSession` GET.
    init(board: NoticeBoard, currentVersion: String = Naming.buildVersion, fetch: @escaping Fetch = UpdateCheck.urlSessionFetch) {
        self.board = board
        self.currentVersion = currentVersion
        self.fetch = fetch
    }

    /// Look once. Fetch the feed for this build's channel, and if it names a newer
    /// version, raise the notice; if it does not, leave the board alone.
    ///
    /// Every non-answer is silent, and that is the point of a background check: a
    /// network that could not be reached, a feed not yet published, a body that is
    /// not JSON, a version that is this build or older, all mean "nothing to say"
    /// and none of them puts anything on screen. The one loud case is a feed
    /// actively lying, a version present but unparseable, which `UpdateFeed`
    /// throws on and which is logged here rather than shown, because it is our
    /// problem with the feed rather than the user's to act on.
    ///
    /// It does NOT clear the notice when the feed matches again, and that is
    /// deliberate: a newer build genuinely exists until this one is replaced, and
    /// on iOS replacing it is the user's action in another app, not something this
    /// check can observe. Clearing on the next poll would make the banner flicker
    /// away the moment the feed was briefly unreachable. The notice is keyed and
    /// idempotent, so a re-announcement of the same version changes nothing.
    func run() async {
        // A stable build is not distributed yet (TestFlight is the one channel,
        // and every build on it is a dev build), so it has no releases to read
        // for itself. The releases feed carries both channels, but a stable build
        // reading it today would only ever find dev entries it must not be
        // offered, so the check stands down until stable is a real channel. The
        // reader itself is channel-correct (it would pick the newest stable
        // entry); this gate is about there being nothing stable to find.
        let channel = UpdateFeed.channel(for: currentVersion)
        guard channel == UpdateFeed.devChannel, let url = UpdateFeed.feedURL() else { return }

        let data: Data
        do {
            data = try await fetch(url)
        } catch {
            // A check that could not run this time. Not a notice: the user did
            // not ask, and a "could not check for updates" banner on every flaky
            // network is the noise a background check must not make.
            NSLog("[claw] update check could not reach the feed: %@", String(describing: error))
            return
        }

        guard let document = UpdateFeed.decode(data) else { return }

        let newer: String?
        do {
            newer = try UpdateFeed.newerVersion(in: document, current: currentVersion)
        } catch {
            // A feed naming a version this build cannot parse: our problem with
            // the feed, logged rather than shown.
            NSLog("[claw] update feed named an unreadable version: %@", String(describing: error))
            return
        }

        guard let version = newer else { return }
        announce(version)
    }

    /// Raise the "a newer build exists" notice.
    ///
    /// INFO rather than a failure tone: a waiting update is good news, and the
    /// notice model's `ok` is reserved for a resolved condition. The action opens
    /// TestFlight rather than downloading anything, because iOS cannot install its
    /// own update (`UpdatePolicy` says as much) and the honest offer is to send
    /// the user to where the build is. The message names no download and no
    /// restart, which is what keeps it true on the one platform that can do
    /// neither.
    private func announce(_ version: String) {
        Self.announcedVersion = version
        board.raise(Self.noticeId, NoticeRaise(
            tone: NoticeTone.info,
            message: "\(Naming.product) \(version) is available",
            detail: "You are on \(currentVersion). iOS installs apps, so open TestFlight to update.",
            action: NoticeAction(label: "Open TestFlight", command: Self.openTestFlightCommand)
        ))
    }

    /// The real fetch: a plain GET with a short cache policy so a check reads what
    /// is published now rather than a body the OS cached from the last poll. Not
    /// on the main actor: the network work runs off it, and only the raise, which
    /// is the caller's, touches the board.
    nonisolated static func urlSessionFetch(_ url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        // A non-200 (a 404 for a feed not yet published, say) is a non-answer, not
        // a body to parse. Throwing here routes it to run()'s silent catch, which
        // is the correct handling: nothing to say.
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw URLError(.badServerResponse)
        }
        return data
    }
}
