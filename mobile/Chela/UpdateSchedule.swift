import Foundation

/// How often this build looks for a release, and whether the next look is due.
///
/// ★ This is the half of the update story this client was missing, and it is the
/// reason a phone that had a release published while it was OPEN only ever heard
/// about one when somebody pressed Check for updates. The launch check runs once,
/// at the moment `ContentView` appears, and a phone app is then resident for days:
/// nothing looked again, so nothing was announced again. The desktop has looked on
/// a timer since it could update at all -- `checkForUpdates('startup')` sixty
/// seconds in and a `setInterval` after that -- and these are the same numbers,
/// read from the same spec.
///
/// `UpdatePolicy.stableIntervalMs` and `prereleaseIntervalMs` mirror
/// `core/spec/updates.json` and were until now read by nothing at all. Reading
/// them here is what makes them load-bearing rather than a mirror kept in step for
/// a future that had not arrived, and `UpdatePolicyParityTests` asserts the
/// numbers against the spec file itself.
///
/// Pure and clock-free, like the rest of the update story: the caller supplies the
/// two times, so "is a check due" is a rule that is checked from one test run
/// rather than a behaviour that has to be watched for five minutes to be believed.
enum UpdateCadence {
    /// How long this build waits between background checks.
    ///
    /// Derived from the version rather than configured, for the same reason
    /// `UpdateFeed.channel(for:)` is: the version is stamped at build time and
    /// travels with the app, so a build cannot be wrong about which channel it is
    /// on. A dev build is installed to watch a change land, so it looks every few
    /// minutes; a stable build is meant to sit there for weeks and six hours of
    /// staleness costs nothing.
    static func intervalMs(for version: String) -> Int {
        UpdateFeed.channel(for: version) == UpdateFeed.devChannel
            ? UpdatePolicy.prereleaseIntervalMs
            : UpdatePolicy.stableIntervalMs
    }

    /// Whether this build should look again, given when it last looked.
    ///
    /// A build that has never looked IS due, which is the launch check. Otherwise
    /// the interval has to have elapsed. A clock that moved backwards reports "not
    /// due" rather than a negative elapsed time, the same defensiveness `ago()` in
    /// `core/updates.js` has, because a device whose clock was corrected must not
    /// turn that into a burst of checks.
    static func isDue(lastCheckMs: Int?, nowMs: Int, intervalMs: Int) -> Bool {
        guard let lastCheckMs else { return true }
        return nowMs - lastCheckMs >= intervalMs
    }
}

/// The background update checks, on a cadence, for the life of the app.
///
/// What this does NOT own: the check itself (`UpdateCheck` fetches the feed and
/// raises the notice), the notice model, and every policy. This is only the clock,
/// so when a client looks and what it does about the answer stay separate things.
///
/// Why a cadence at all when a launch check already exists: a launch check answers
/// "is there a newer build" once, at a moment nobody chose, and on a phone the app
/// then stays resident. A release published an hour later was invisible until
/// somebody pressed the button, which is the report this exists for. Both clients
/// now look the same way: once at startup, then on the interval their own
/// version's channel names.
@MainActor
final class UpdateSchedule {
    /// How a check is built. A closure rather than a check, because a screenshot
    /// run hands the same builder to the launch check and to every later one, so a
    /// scheduled raise is shown from the same feed the launch banner was (see
    /// `ContentView.updateCheck`).
    private let makeCheck: () -> UpdateCheck

    /// This build's own identity, read when it is needed rather than captured: the
    /// interval follows the version, and a value read once at launch is one more
    /// copy of an identity that has one owner (`Naming.buildVersion`).
    private let currentVersion: () -> String

    /// The clock, injectable so the due rule can be driven from a test rather than
    /// waited out.
    private let now: () -> Int

    /// How long to wait between looks, injectable for the same reason as the clock
    /// and defaulting to the shared rule: a test that proved the loop by waiting
    /// five minutes would be a test nobody runs.
    private let intervalMs: (String) -> Int

    private var lastCheckMs: Int?

    /// The repeating task. Held so the loop is owned by this object rather than by
    /// whatever created it, and cancelled with it.
    private var loop: Task<Void, Never>?

    /// Started once. A second `start()` would otherwise leave two loops running
    /// that know nothing about each other, each doubling the other's requests.
    private(set) var started = false

    init(
        makeCheck: @escaping () -> UpdateCheck,
        currentVersion: @escaping () -> String = { Naming.buildVersion },
        now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
        intervalMs: @escaping (String) -> Int = { UpdateCadence.intervalMs(for: $0) }
    ) {
        self.makeCheck = makeCheck
        self.currentVersion = currentVersion
        self.now = now
        self.intervalMs = intervalMs
    }

    /// Look now, then keep looking on this build's own cadence.
    func start() {
        guard !started else { return }
        started = true
        Task { await run(trigger: .startup) }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let interval = self.intervalMs(self.currentVersion())
                try? await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000)
                if Task.isCancelled { return }
                await self.run(trigger: .scheduled)
            }
        }
    }

    /// The app came back to the foreground.
    ///
    /// Not a second cadence: the same one, asked at the moment the app can act on
    /// the answer. iOS freezes a suspended process, so the loop above resumes
    /// wherever its sleep got to and can be hours behind, which is exactly the
    /// window a release lands in. A check is therefore run here precisely when the
    /// interval has elapsed since the last one.
    func becameActive() {
        guard started else { return }
        guard UpdateCadence.isDue(
            lastCheckMs: lastCheckMs,
            nowMs: now(),
            intervalMs: intervalMs(currentVersion())
        ) else { return }
        Task { await run(trigger: .scheduled) }
    }

    /// One background check, with the time it happened written down first.
    ///
    /// Recorded BEFORE the check rather than after it, so a feed that hangs cannot
    /// turn the cadence into a loop that fires again the instant the last one gives
    /// up. `trigger` is what decides how much a check may say about a non-answer:
    /// a background check keeps "nothing newer" and "the read failed" to its log,
    /// and announces a release it finds, which is `checkAnswer`'s rule and not
    /// this object's.
    func run(trigger: UpdateTrigger) async {
        lastCheckMs = now()
        await makeCheck().run(trigger: trigger)
    }
}
