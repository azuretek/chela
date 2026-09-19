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

    /// Notices that take themselves down again, by id.
    ///
    /// The timer lives here rather than in `NoticeStore` for the same reason it
    /// lives in `main.js` and not in `core/notices.js` on the desktop: the store is
    /// a pure data structure with no clock in it, which is what makes the
    /// ordering and the replace-don't-stack rule testable without waiting. Held per
    /// id, so re-raising one cancels the countdown it was carrying rather than
    /// leaving two timers racing to clear the same notice.
    private var timers: [String: Task<Void, Never>] = [:]

    /// When the transient answer under an id went on screen, so a fresher answer is
    /// held off until it has been up the minimum-visible duration (`Motion`). This
    /// is the phone's half of the desktop's `answerShownAt`: the same fix for "a
    /// second press just flashes", where a manual re-check re-presents the cached
    /// answer at once and the live re-check settles a moment later. Only a floored
    /// (transient) raise records or reads it; a standing condition is not held.
    /// nil when no floored answer is up under that id.
    private var floorShownAt: [String: Date] = [:]

    /// A held replacement waiting out the remainder of the floor, by id, so two
    /// presses in quick succession do not stack timers on one card.
    private var floorHolds: [String: Task<Void, Never>] = [:]

    /// A clock the tests inject, so the floor is exercised without waiting real
    /// seconds. Production reads the wall clock; `Motion` takes `now` for the same
    /// reason `core/ui/motion.js` does.
    var now: () -> Date = { Date() }

    /// Raise a notice, optionally for a fixed time.
    ///
    /// Almost every notice is a standing condition and stays until whatever
    /// raised it says otherwise; that is the shape of the thing. `ttlMs` is for
    /// the handful that are not: the answer to a manual "check for updates", which
    /// is a reply to a question rather than a condition, and would otherwise sit
    /// there permanently announcing that nothing is wrong.
    ///
    /// ★ A TTL'd raise is a TRANSIENT state, so it honours the minimum-visible
    /// floor: if the transient answer already on screen under this id has not been
    /// up long enough, a genuinely different answer waits out the remainder
    /// (`Motion.remainingVisibleMs`) before it replaces it, so the reader sees the
    /// first answer rather than a flash of it. A same-content re-raise the store
    /// swallows changes nothing on screen, so it does not restart the clock; only a
    /// genuinely different answer is held. A standing condition (ttlMs == 0) is
    /// never floored: it is on screen until it is fixed, so a floor is meaningless,
    /// which is the same split the desktop and the eighth rule draw.
    func raise(_ id: String, _ notice: NoticeRaise, ttlMs: Int = 0) {
        // A standing condition: no floor, and it clears any transient bookkeeping
        // that an earlier answer under this id left behind.
        guard ttlMs > 0 else {
            floorHolds[id]?.cancel(); floorHolds[id] = nil
            floorShownAt[id] = nil
            timers[id]?.cancel(); timers[id] = nil
            if store.set(id, notice) { refresh() }
            return
        }

        // A transient answer. Hold it off if the one on screen has not had its floor.
        let wouldChange = !(store.get(id)?.saysTheSame(as: notice) ?? false)
        let shownAt = floorShownAt[id]
        let remaining = shownAt.map { Motion.remainingVisibleMs(shownAt: $0, now: now()) } ?? 0
        if wouldChange && remaining > 0 {
            floorHolds[id]?.cancel()
            floorHolds[id] = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(remaining) * 1_000_000)
                guard !Task.isCancelled else { return }
                self?.floorHolds[id] = nil
                self?.raise(id, notice, ttlMs: ttlMs)
            }
            return
        }
        floorHolds[id]?.cancel(); floorHolds[id] = nil

        timers[id]?.cancel()
        timers[id] = nil
        let changed = store.set(id, notice)
        // Only a raise that actually put something new on screen resets the visible
        // clock; a re-raise of the identical card leaves the reader looking at the
        // same thing, so its floor keeps counting from when it first appeared.
        if changed || floorShownAt[id] == nil { floorShownAt[id] = now() }
        if changed { refresh() }
        timers[id] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(ttlMs) * 1_000_000)
            guard !Task.isCancelled else { return }
            self?.clear(id)
        }
    }

    func markRead(_ id: String) {
        if store.markRead(id) { refresh() }
    }

    func markAllRead() {
        if store.markAllRead() { refresh() }
    }

    func clear(_ id: String) {
        timers[id]?.cancel()
        timers[id] = nil
        // A floored answer leaving the bar (its TTL fired, or a better answer
        // superseded it) resets its visible clock and any held replacement, so a
        // fresh press re-presents at once rather than being held against a card that
        // is no longer there. Mirrors the desktop's clearNotice for UPDATE_ANSWER.
        floorHolds[id]?.cancel(); floorHolds[id] = nil
        floorShownAt[id] = nil
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
    /// design nobody has checked. It is compiled out of a release build, it is
    /// inert without the launch argument, and it seeds the real store through the
    /// real raisers, so what it draws is the banner and not a mock of it.
    ///
    /// Every seed carries an action, and that is the notice rule rather than a
    /// coincidence of this fixture: a notice must be actionable, so sample notices
    /// for the four tones are built the way a real one has to be. The `ok` seed is
    /// the tone's one raiser gone: it used to announce that the app had connected
    /// again, which reported a condition nobody had to do anything about, and that
    /// notice was removed from both clients.
    static func live() -> NoticeBoard {
        let board = NoticeBoard()
        guard ProcessInfo.processInfo.arguments.contains("-claw-seed-notices") else { return board }
        board.raise("seed-error", NoticeRaise(
            tone: NoticeTone.error,
            message: "Cannot connect to example-host",
            detail: "The request timed out.",
            action: NoticeAction(label: "Open Settings", command: NoticeBoard.settingsCommand)
        ))
        board.raise("seed-warn", NoticeRaise(
            tone: NoticeTone.warn,
            message: "This build cannot install its own updates",
            detail: "iOS installs apps. \(Naming.product) can tell you a release exists and no more.",
            action: NoticeAction(label: "Open Settings", command: NoticeBoard.settingsCommand)
        ))
        board.raise("seed-info", NoticeRaise(
            tone: NoticeTone.info,
            message: "Downloading \(Naming.product) 1.0.2",
            dismissible: false,
            progress: 0.42
        ))
        board.raise("seed-ok", NoticeRaise(
            tone: NoticeTone.ok,
            message: "Settings saved",
            detail: "Sample good news for the ok tone, which has no live raiser on this client since the reconnection notice was removed.",
            action: NoticeAction(label: "Open Settings", command: NoticeBoard.settingsCommand)
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
