import Foundation

/// The keyed notice store, read from the same rules the desktop uses.
///
/// Ported from `core/notices.js`. A notice is a condition that is true until
/// something fixes it: credentials that cannot be stored, a gateway that will not
/// answer, an update that failed to download. None of them can be answered with a
/// button, so a dialog is the wrong shape, it interrupts, gets dismissed, and the
/// condition is still true afterwards with nothing on screen to say so.
///
/// So a notice is keyed and idempotent rather than a stream of events. Raising
/// the same id twice replaces it instead of stacking, and the raiser clears it
/// when the condition passes. That is what makes "stays until it resolves"
/// literally true rather than a timeout dressed up as one.
///
/// The four tones and their sort rank are data, mirrored from
/// `core/spec/notices.json`, and `NoticesParityTests` proves this port reproduces
/// the golden fixtures in `core/fixtures/notices.json` that `core/test/fixtures.test.js`
/// asserts on the JS side. That test is the contract: change the model, regenerate
/// the fixtures, and this file is what has to move with it. The Swift does not
/// read the spec at runtime, because a shipped app cannot read a file that lives
/// in the repo, and a bundled copy of the data would be a third thing to keep in
/// step.
///
/// Platform-free on purpose, like `Progress` and `UpdatePolicy`: no window, no
/// web view, no clock. What draws it is `NoticeBanner`, and what owns the live
/// instance is `NoticeBoard`.
enum NoticeTone {
    /// `core/spec/notices.json`, read from the app's own copy at runtime.
    private struct Spec: Decodable {
        let tones: [String: String]
        let rank: [String: Int]
    }

    static let decodedKeys: Set<String> = ["tones", "rank"]
    static let ignoredKeys: Set<String> = []

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(tones: [:], rank: [:])
        guard let spec = try? BundledSpec.load("notices", as: Spec.self), !spec.tones.isEmpty else {
            return empty
        }
        return spec
    }

    /// Severities, worst first. The banner is sorted by these.
    static var error: String { spec.tones["error"] ?? "" }
    static var warn: String { spec.tones["warn"] ?? "" }
    static var info: String { spec.tones["info"] ?? "" }
    /// Good news: connected, or an update finished downloading. A separate tone
    /// rather than `info` because this app's accent colour is red, so an
    /// informational notice is already indistinguishable from a failure at a
    /// glance, and these are the ones where reading "connected" as an alarm is
    /// worst.
    static var ok: String { spec.tones["ok"] ?? "" }

    /// The rank a tone sorts by, worst first, read from the spec's own `rank`
    /// map. A tone missing from it sorts last rather than crashing, matching how
    /// the JS reads the same map.
    static func rank(_ tone: String) -> Int {
        spec.rank[tone] ?? Int.max
    }
}

/// The one place a notice offers to do something.
///
/// A *command name* rather than a callback, matching the JS: the surface that
/// renders a notice is on the other side of a process boundary on desktop and
/// across a web view here, so anything it can invoke has to be a name the host
/// already knows how to run. It is deliberately singular, because a notice that
/// needs two buttons is a question, and a question is a dialog.
struct NoticeAction: Equatable {
    let label: String
    let command: String
}

/// One condition, as stored.
struct Notice: Equatable {
    let id: String
    var tone: String
    var message: String
    var detail: String?
    var dismissible: Bool
    /// The other half of `dismissible`, and it is about what the card's X MEANS
    /// rather than whether there is one. Most conditions here are true until
    /// something fixes them, so reading one is all a reader can honestly do to it
    /// and the notice stays in the store and under Settings. A download is the
    /// exception: "I have seen that it is at 4%" is not a thing anybody means, and
    /// the condition the card describes is one the reader can end by saying so, so
    /// a dismissClears notice is CLEARED by its own X rather than read.
    ///
    /// Not part of `saysTheSame`, like `dismissible`: neither is what the card
    /// says, both are what its one control does.
    var dismissClears: Bool
    /// A fraction, 0 to 1, or nil for a notice that is not about something
    /// arriving. Part of the notice rather than a separate channel to the banner,
    /// because the bar and the sentence above it describe one condition, and two
    /// channels could disagree about which phase it is in.
    var progress: Double?
    var action: NoticeAction?
    /// Seen, but still true. Distinct from the notice being absent, and the
    /// distinction is the point: clearing says the condition passed, reading says
    /// you know about it.
    var read: Bool
    /// Insertion order within a severity, so a new warning appears below an older
    /// one rather than shuffling what someone is reading.
    var order: Int
}

extension Notice {
    /// Whether this notice and another say the same thing, which is the question
    /// the store asks before deciding a raise changed anything. Not `Equatable`,
    /// which compares every field: the two ids are the same by construction (they
    /// are the key), and `read` and `order` are the store's bookkeeping rather
    /// than part of what is on screen.
    func saysTheSame(as other: Notice) -> Bool {
        tone == other.tone
            && message == other.message
            && detail == other.detail
            && progress == other.progress
            && action == other.action
    }
}

/// What a raiser hands the store. Every field but the message has a default, so a
/// one-line condition stays one line at the call site.
struct NoticeRaise {
    var tone: String
    var message: String
    var detail: String?
    var dismissible: Bool
    var dismissClears: Bool
    var action: NoticeAction?
    var progress: Double?

    init(
        tone: String = NoticeTone.error,
        message: String,
        detail: String? = nil,
        dismissible: Bool = true,
        dismissClears: Bool = false,
        action: NoticeAction? = nil,
        progress: Double? = nil
    ) {
        self.tone = tone
        self.message = message
        self.detail = detail
        self.dismissible = dismissible
        self.dismissClears = dismissClears
        self.action = action
        self.progress = progress
    }
}

/// The store itself. A class rather than a value, matching the JS object: callers
/// hold one instance and raise conditions into it over the life of the app.
final class NoticeStore {
    private var notices: [String: Notice] = [:]
    private var seq = 0

    /// Raise a notice, or update the one already under this id.
    ///
    /// - Returns: whether anything actually changed. Identical to what is already
    ///   on screen reports `false`, which matters: the caller uses it to avoid
    ///   re-rendering, and a banner that re-renders replays its slide-in
    ///   animation for no reason.
    @discardableResult
    func set(_ id: String, _ raise: NoticeRaise) -> Bool {
        if let previous = notices[id] {
            let next = Notice(
                id: id,
                tone: raise.tone,
                message: raise.message,
                detail: raise.detail,
                dismissible: raise.dismissible,
                dismissClears: raise.dismissClears,
                progress: raise.progress,
                action: raise.action,
                read: false,
                order: previous.order
            )
            if previous.saysTheSame(as: next) { return false }
            notices[id] = next
            return true
        }
        notices[id] = Notice(
            id: id,
            tone: raise.tone,
            message: raise.message,
            detail: raise.detail,
            dismissible: raise.dismissible,
            dismissClears: raise.dismissClears,
            progress: raise.progress,
            action: raise.action,
            // Unread, always, because reaching here means something changed. A
            // condition that has been read and then says something different is
            // new news, and leaving it read would let a failure change under a
            // banner that has already been waved away.
            read: false,
            order: seq
        )
        seq += 1
        return true
    }

    /// Seen, but still true. Returns whether that changed anything.
    @discardableResult
    func markRead(_ id: String) -> Bool {
        guard var notice = notices[id], !notice.read else { return false }
        notice.read = true
        notices[id] = notice
        return true
    }

    /// Read everything that can be read.
    ///
    /// A notice that is not dismissible is not markable either. The one that
    /// carries it is the finished update download, kept because losing it means
    /// waiting for the next check to find a version that is already on disk, and a
    /// bulk action is exactly how it would get lost.
    ///
    /// A dismissClears notice is skipped too, and for a sharper reason: its X ends
    /// it rather than reading it, and "end every condition on this bar" is not what
    /// anybody pressed. The card's own control is one deliberate act and stays the
    /// only one, matching `markAllRead` in `core/notices.js`.
    @discardableResult
    func markAllRead() -> Bool {
        var changed = false
        for (id, notice) in notices where notice.dismissible && !notice.dismissClears && !notice.read {
            var next = notice
            next.read = true
            notices[id] = next
            changed = true
        }
        return changed
    }

    /// Dismiss the notice under this id, the way its own X means it.
    ///
    /// The one entry point a surface should call when a card is closed, because
    /// the meaning of that act is a property of the condition rather than of the
    /// control: a transfer is over when the reader says so, and everything else is
    /// seen and still true. A caller choosing between `markRead` and `clear` by
    /// hand is how a card that cannot be dismissed comes back, which is the fault
    /// this exists for. Mirrors `dismiss` in `core/notices.js`.
    @discardableResult
    func dismiss(_ id: String) -> Bool {
        guard let notice = notices[id] else { return false }
        if notice.dismissClears { return clear(id) }
        return markRead(id)
    }

    /// The condition passed. Returns whether there was anything to clear.
    @discardableResult
    func clear(_ id: String) -> Bool {
        notices.removeValue(forKey: id) != nil
    }

    /// The notice under this id, as stored, or nil.
    ///
    /// As *stored*, which is the point: the defaults have been applied, so a
    /// caller that omitted a tone reads back the error it actually raised rather
    /// than an absent value. Anything mirroring a notice elsewhere should read it
    /// from here rather than from the argument it passed in.
    func notice(_ id: String) -> Notice? {
        notices[id]
    }

    /// Every condition that is still true, worst first, then oldest first.
    func list() -> [Notice] {
        notices.values.sorted {
            let left = NoticeTone.rank($0.tone)
            let right = NoticeTone.rank($1.tone)
            return left == right ? $0.order < $1.order : left < right
        }
    }

    /// What the banner draws: the conditions nobody has acknowledged yet.
    ///
    /// The banner is the only surface filtered this way. Everywhere else wants
    /// `list()`, because "is the gateway unreachable" and "have you been told the
    /// gateway is unreachable" are different questions and only the banner is
    /// asking the second one.
    func unread() -> [Notice] {
        list().filter { !$0.read }
    }

    var size: Int { notices.count }
}

/// Make a fragment into a sentence: capital at the front, full stop at the back.
///
/// Every detail line is one of our sentences with a string from the OS or a
/// library dropped into it, and those start and end however they start and end.
/// Without the full stop a notice reads "conversion failure from Frobnicate+Zz
/// Change it in Settings."; without the capital, a reason written to be appended
/// to a sentence, "running from source", stands alone looking truncated.
///
/// Only the first character is touched, so an all-caps error code arrives
/// unharmed. Ported from `sentence()` in `core/notices.js`, fixture for fixture.
func noticeSentence(_ text: String?) -> String {
    let trimmed = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "" }
    let capitalised = trimmed.prefix(1).uppercased() + trimmed.dropFirst()
    if let last = capitalised.last, ".!?:;".contains(last) { return capitalised }
    return capitalised + "."
}
