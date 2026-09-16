import Foundation

/// The live notices this app is showing, and the only thing that raises them.
///
/// Holds one `NoticeStore` and republishes what the banner should draw, which is
/// `unread()` rather than everything still true: a condition that has been read is
/// still true and still in the store, and the banner has to come down anyway or
/// reading it would leave an empty strip over the page. Everywhere else that wants
/// the full list reads the store.
///
/// The raisers below are the honest part of this file. A notice exists for a
/// condition nothing can be asked about with a button, so it is raised where the
/// app genuinely learns the condition and cleared when it passes, never seeded to
/// make a screen look busy. Today that is one condition: the page failed to load,
/// which is the same thing the desktop reports through
/// `core/connection.js` and the only failure this client can observe on its own.
///
/// What is deliberately not here yet: the update notice. `UpdatePolicy` already
/// answers that iOS can only announce a release and never install one, and the
/// sentence it will be announced with belongs with the check that finds one,
/// which is the next phase rather than this one.
@MainActor
final class NoticeBoard: ObservableObject {
    /// What the banner draws, in the store's order: worst first, then oldest.
    @Published private(set) var unread: [Notice] = []

    private let store = NoticeStore()

    /// The id of the connection condition, matching the desktop's id for the same
    /// thing so a log from either client reads the same way.
    static let connectionId = "connection"

    /// The one notice command this client answers: bring the gateway setup
    /// surface up. The same name and label the desktop's `failureNotice()` uses,
    /// so the two clients offer the same way out of the same condition.
    static let settingsCommand = "settings"

    /// How a notice's action reaches the surface that can act on it. Set by
    /// `ContentView`, because the board holds no view of its own.
    var onCommand: ((String) -> Void)?

    var all: [Notice] { store.list() }

    // MARK: Raising

    /// The page could not be loaded at all.
    ///
    /// The headline mirrors `failureNotice()` in `core/connection.js`, so the two
    /// clients say the same sentence about the same condition. The reason is
    /// whatever the OS gave us, passed through `noticeSentence` so a fragment from
    /// WebKit reads as a sentence, which is what that function is for.
    func connectionFailed(label: String?, description: String) {
        raise(Self.connectionId, NoticeRaise(
            tone: NoticeTone.error,
            message: "Cannot connect to \(label ?? "the gateway")",
            detail: noticeSentence(description),
            action: NoticeAction(label: "Open Settings", command: Self.settingsCommand)
        ))
    }

    /// The page loaded, so the condition the notice described has passed.
    func connectionRecovered() {
        clear(Self.connectionId)
    }

    // MARK: Store, republished

    func raise(_ id: String, _ notice: NoticeRaise) {
        if store.set(id, notice) { refresh() }
    }

    func markRead(_ id: String) {
        if store.markRead(id) { refresh() }
    }

    func markAllRead() {
        if store.markAllRead() { refresh() }
    }

    func clear(_ id: String) {
        if store.clear(id) { refresh() }
    }

    /// Run a notice's action.
    ///
    /// A command name rather than a callback, matching the shared model: the
    /// surface that draws a notice is on the other side of a boundary, so
    /// anything it can invoke has to be a name the host already answers. One
    /// command exists today, the connection notice's, and `onCommand` is what
    /// answers it. A name nobody handles is logged rather than ignored, because
    /// a button that does nothing is the failure this shape exists to avoid.
    func run(_ command: String) {
        guard let onCommand else {
            NSLog("[claw] notice action with no handler on this client: %@", command)
            return
        }
        onCommand(command)
    }

    private func refresh() {
        unread = store.unread()
    }
}

#if DEBUG
extension NoticeBoard {
    /// The board the app starts with.
    ///
    /// In a debug build, `-claw-seed-notices` fills it with one notice per tone.
    /// That exists for one reason: this client has exactly one condition it can
    /// observe on its own, so three of the four tones cannot be seen in a
    /// simulator without it, and a banner whose tones nobody has looked at is a
    /// design nobody has checked. It is compiled out of a release build, and it
    /// seeds the real store through the real raisers, so what it draws is the
    /// banner and not a mock of it.
    static func live() -> NoticeBoard {
        let board = NoticeBoard()
        guard ProcessInfo.processInfo.arguments.contains("-claw-seed-notices") else { return board }
        board.raise("seed-error", NoticeRaise(
            tone: NoticeTone.error,
            message: "Cannot connect to example-host",
            detail: "The request timed out."
        ))
        board.raise("seed-warn", NoticeRaise(
            tone: NoticeTone.warn,
            message: "This build cannot install its own updates",
            detail: "iOS installs apps. \(Naming.product) can tell you a release exists and no more."
        ))
        board.raise("seed-info", NoticeRaise(
            tone: NoticeTone.info,
            message: "Downloading \(Naming.product) 1.0.2",
            dismissible: false,
            progress: 0.42
        ))
        board.raise("seed-ok", NoticeRaise(
            tone: NoticeTone.ok,
            message: "Connected to example-host",
            detail: "The Control UI is loaded and waiting behind this banner."
        ))
        return board
    }
}
#else
extension NoticeBoard {
    /// The board the app starts with. Nothing is seeded in a release build.
    static func live() -> NoticeBoard { NoticeBoard() }
}
#endif
