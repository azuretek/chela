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

    #if DEBUG
    /// A releases feed naming one version, for a screenshot run.
    ///
    /// A real Atom document, in the shape `UpdateFeed.decode` actually reads: the
    /// tag lives in the entry's `<id>`, which is where the reader looks for it.
    /// This used to be a one-line JSON object, which looked equivalent and was
    /// not: `decode` parses Atom, so the JSON failed to parse and the check
    /// answered nothing, which is exactly the bug this whole change is about. The
    /// difference between a feed that parses and one that does not is invisible
    /// from a screenshot of an empty banner, so `UpdateCheckTests` asserts this
    /// document decodes and that the version in it is the one the check reports.
    ///
    /// DEBUG-only: a release build has no screenshot runs to seed.
    static func seededFeed(advertising version: String) -> Data {
        Data("""
        <?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <id>tag:github.com,2008:https://github.com/\(Naming.repoOwner)/\(Naming.repoName)/releases</id>
          <title>Release notes</title>
          <entry>
            <id>tag:github.com,2008:Repository/1/v\(version)</id>
            <title>v\(version)</title>
          </entry>
        </feed>
        """.utf8)
    }
    #endif

    /// The notice id, matching the desktop's id for the same condition so a log
    /// from either client reads the same way (`update-available` in
    /// `src/main.js`).
    static let noticeId = "update-available"

    /// The id every answer to a PRESSED check shares, matching the desktop's
    /// `update-answer` for the same reason `noticeId` matches its own: one id per
    /// question, so a second press replaces the first answer rather than stacking
    /// a second "up to date" underneath it.
    static let answerNoticeId = "update-answer"

    /// How long an answer to a pressed check stays up, matching the desktop's
    /// `ANSWER_TTL_MS`. An answer is a reply to a question, not a condition, and
    /// a reply nobody is still asking for should take itself away; a real problem
    /// has no timeout.
    static let answerTtlMs = 9000

    /// Where a new build waits, in this client's own words. The shared
    /// composition names no distribution channel (`core/updates.js` refuses to on
    /// purpose), so the sentence is passed in rather than written into the answer.
    /// The word is honest about what pressing the action does: it is `TestFlight`
    /// that opens, whatever it takes to get there.
    static let updatePointer = "Open TestFlight to update."

    /// Why this build does not read a feed at all: only the dev channel has
    /// published releases so far, and a stable build must not be offered a dev
    /// one. Said rather than silently skipped when someone presses the button.
    static let stableChannelReason = "only the dev channel is published so far, and this build follows stable"

    /// The command the banner's action carries. Answered by `ContentView`, which
    /// is the surface that can open a URL; the board only carries the name, the
    /// same shape the connection notice's `settings` command uses.
    static let openTestFlightCommand = "update-open-testflight"

    /// Where the reader is sent, and how, is `TestFlight`'s rather than this
    /// file's: it is the one place that knows TestFlight is an app to be opened and
    /// not a page to be read, and the one place that handles a phone without it.
    /// What stays here is the sentence and the label, because this is the notice
    /// that decides the reader is being offered an update at all.

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

    /// Look once, and answer the person who asked.
    ///
    /// `trigger` decides what a non-answer is. A background check (`startup`, and
    /// anything scheduled later) is silent unless there is news, which is the
    /// whole point of one: a network that could not be reached, a feed not yet
    /// published, a body that is not JSON, a version that is this build or older,
    /// all mean "nothing to say".
    ///
    /// A MANUAL check is the opposite, and this is the bug this file was rewritten
    /// for: pressing "Check for updates" reported nothing in either direction. The
    /// check ran, compared, and the release it found went onto a banner that the
    /// sheet it was pressed on drew over. So every outcome of a manual check is
    /// answered through the shared `UpdateAnswer`, which is the same composition
    /// the desktop raises from, and the two directions are named explicitly:
    ///
    ///   a newer build exists   the standing `update-available` notice, action
    ///                          "Open TestFlight", which is where the build is
    ///   nothing newer          an `update-answer` notice saying so, with the
    ///                          version you are on
    ///   the feed could not read or could not be reached   `update-answer`, as a
    ///                          warning, because a press is owed an answer even
    ///                          when the answer is that the check failed
    ///   this build has no feed to read at all   `update-answer`, saying why
    ///
    /// It does NOT clear the standing notice when the feed matches again, and that
    /// is deliberate: a newer build genuinely exists until this one is replaced,
    /// and on iOS replacing it is the user's action in another app, not something
    /// this check can observe. Clearing on the next poll would make the banner
    /// flicker away the moment the feed was briefly unreachable. The notice is
    /// keyed and idempotent, so a re-announcement of the same version changes
    /// nothing.
    func run(trigger: UpdateTrigger = .startup) async {
        // A stable build is not distributed yet (TestFlight is the one channel,
        // and every build on it is a dev build), so it has no releases to read
        // for itself. The releases feed carries both channels, but a stable build
        // reading it today would only ever find dev entries it must not be
        // offered, so the check stands down until stable is a real channel. The
        // reader itself is channel-correct (it would pick the newest stable
        // entry); this gate is about there being nothing stable to find. A press
        // is still answered, because "we cannot look" is an answer.
        let channel = UpdateFeed.channel(for: currentVersion)
        guard channel == UpdateFeed.devChannel, let url = UpdateFeed.feedURL() else {
            answer(UpdateAnswer.answer(
                outcome: .unavailable,
                trigger: trigger,
                current: currentVersion,
                reason: Self.stableChannelReason
            ))
            return
        }

        let data: Data
        do {
            data = try await fetch(url)
        } catch {
            // A check that could not run this time. Not a notice for a background
            // check: a "could not check for updates" banner on every flaky network
            // is the noise a background check must not make. A press is owed the
            // answer, which is the same reasoning the desktop's error handler uses.
            NSLog("[claw] update check could not reach the feed: %@", String(describing: error))
            answer(UpdateAnswer.answer(
                outcome: .error,
                trigger: trigger,
                current: currentVersion,
                error: Self.describe(error)
            ))
            return
        }

        guard let document = UpdateFeed.decode(data) else {
            // A body that is not a release feed. For a background check that is a
            // non-answer; for a press it is the reason there is nothing to report,
            // and saying so is the difference between a failed check and a button
            // that does nothing.
            NSLog("[claw] update feed did not read as a feed")
            answer(UpdateAnswer.answer(
                outcome: .error,
                trigger: trigger,
                current: currentVersion,
                error: "the release feed did not read as a feed"
            ))
            return
        }

        let newer: String?
        do {
            newer = try UpdateFeed.newerVersion(in: document, current: currentVersion)
        } catch {
            // A feed naming a version this build cannot parse: our problem with
            // the feed rather than the user's to act on, and reported as a failed
            // check when somebody asked for one.
            NSLog("[claw] update feed named an unreadable version: %@", String(describing: error))
            answer(UpdateAnswer.answer(
                outcome: .error,
                trigger: trigger,
                current: currentVersion,
                error: Self.describe(error)
            ))
            return
        }

        guard let version = newer else {
            // Both directions, and this is the half that used to be nothing at
            // all: a feed that names this build, or an older one, is an answer to
            // "is there an update" and the reader pressed the button to get it.
            answer(UpdateAnswer.answer(
                outcome: .current,
                trigger: trigger,
                current: currentVersion
            ))
            return
        }
        announce(version)
    }

    /// Raise an answer to a pressed check, if one is owed.
    ///
    /// `nil` is a legitimate answer and not a failure: the shared composition
    /// returns it for a background check that found nothing, which is the silence
    /// a scheduled check is supposed to keep.
    private func answer(_ answer: UpdateAnswer.Answer?) {
        guard let answer else { return }
        board.raise(Self.answerNoticeId, NoticeRaise(
            tone: answer.tone,
            message: answer.message,
            detail: answer.detail
        ), ttlMs: Self.answerTtlMs)
    }

    /// An error, as a sentence the notice can carry. `LocalizedError` reads far
    /// better than a reflected struct, and a `URLError` reaches the reader as
    /// "The Internet connection appears to be offline" rather than as its raw
    /// field dump.
    private static func describe(_ error: Error) -> String {
        let localized = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return localized.isEmpty ? String(describing: error) : localized
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
        // The wording comes from the same shared composition the desktop raises
        // from, with this client's own pointer at where the build is: the phone
        // cannot install an update itself, so the honest last sentence is TestFlight
        // rather than a download it cannot perform.
        let answer = UpdateAnswer.answer(
            outcome: .available,
            version: version,
            current: currentVersion,
            action: .notify,
            reason: UpdatePolicy.policy(platform: "ios", packaged: true).reason,
            pointer: Self.updatePointer
        )
        guard let answer else { return }
        board.raise(Self.noticeId, NoticeRaise(
            tone: answer.tone,
            message: answer.message,
            detail: answer.detail,
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
