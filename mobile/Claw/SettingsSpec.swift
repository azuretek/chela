import Foundation

/// The shared settings surface, as this client sees it.
///
/// The page itself is `core/ui/settings.html`, the same file the desktop loads,
/// bundled rather than reimplemented: the phone renders the desktop's settings
/// page, with the tabs and settings that apply to this client, instead of having
/// a native screen per tab. That is the whole design, and `SettingsView` is the
/// only thing that knows where the file is.
///
/// `core/spec/settings.json` travels with it, and is handed to the page as it
/// stands. It is not mirrored in Swift, the way the token spec and the notice
/// tones are, for the same reason `spec/prompt-metadata.json` is not: what it
/// describes is a surface the PAGE renders, so a Swift copy of it would be a
/// second copy of the split with nothing able to compare them. The app carries
/// the one file and reads it, and `SettingsSpecTests` asserts that what is in the
/// bundle is byte for byte what is in the repository.
///
/// What this file DOES own is which client the app is. That is a fact about this
/// binary and not about the app's configuration, so it is a constant here rather
/// than a value, and the page filters the spec by it.
enum SettingsSpec {
    /// The client name used in `core/spec/settings.json`. The page filters by it
    /// and never asks for it in any other form.
    static let clientId = "ios"

    /// The settings page as it ships, and the directory it may read from.
    ///
    /// The directory is what makes the page's own relative links work: its
    /// stylesheet and its script sit beside it in the bundle, exactly as they sit
    /// beside it in `core/ui`, and `allowingReadAccessTo` is what lets a file URL
    /// load them at all.
    static var page: URL? { Bundle.main.url(forResource: "settings", withExtension: "html") }
    static var directory: URL? { page?.deletingLastPathComponent() }

    // There is deliberately no `pageURL(tab:)` here, and it was tried. The page
    // takes its two presentation facts (`page`, `tab`) as query parameters on the
    // desktop, and the same URL with a query appended loads NOTHING in this web
    // view: `loadFileURL` answers with a blank document and no error anywhere.
    // Measured on a simulator on 2026-09-15, where the page rendered correctly
    // with no query and rendered white with one. So this client states both facts
    // on the host object instead, before the document starts, which lands at the
    // same moment the desktop's query does (before first paint) without a URL that
    // WebKit refuses. See `SettingsHost.bootstrapScript`.

    #if DEBUG
    /// The tab this run should open, from `-claw-settings-tab <id>`.
    ///
    /// Nothing but a screenshot run uses this: a simulator cannot be tapped by a
    /// script, and a tab nobody has looked at is a tab nobody has checked. Same
    /// reasoning as `-claw-seed-notices` in `NoticeBoard`, and compiled out of a
    /// release build.
    static var screenshotTab: String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-claw-settings-tab"), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    /// Whether this run should open the settings sheet at launch, from
    /// `-claw-open-settings`.
    ///
    /// The same reasoning as `screenshotTab` one line up, and it exists because
    /// the two facts are separate: the sheet is only reachable by pressing a
    /// button, and a simulator cannot be tapped by a script. Without this the one
    /// presentation the phone has of the settings surface, a sheet over the page,
    /// is the one no screenshot run can reach, so its size and its safe-area
    /// strips would be checked only by looking at it on a device.
    static var screenshotOpensSettings: Bool {
        ProcessInfo.processInfo.arguments.contains("-claw-open-settings")
    }

    /// Whether this run should drive the update check from a seeded feed rather
    /// than the network, from `-claw-seed-update-feed <version>`.
    ///
    /// The same reasoning as `screenshotOpensSettings`: the update banner is
    /// raised only when a public feed advertises a newer build, which a screenshot
    /// run cannot arrange against the real network without a live release. So the
    /// screenshot run hands the real `UpdateCheck` a feed body naming a version,
    /// through the real `UpdateFeed` reader and the real raiser, and what it draws
    /// is the banner rather than a mock of it. The presence of the flag says to
    /// seed rather than fetch; `screenshotUpdateFeedVersion` is what the seeded
    /// feed advertises, so the same mechanism produces both the "appears when
    /// newer" and the "absent when it matches" screenshots.
    static var screenshotSeedsUpdateFeed: Bool {
        screenshotUpdateFeedVersion != nil
    }

    /// The version the seeded feed advertises, from `-claw-seed-update-feed`.
    static var screenshotUpdateFeedVersion: String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-claw-seed-update-feed"), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    /// Whether this run should drive the pairing screen from a seeded refusal
    /// rather than a live gateway close, from `-claw-seed-pairing`.
    ///
    /// The same reasoning as `screenshotOpensSettings` and `-claw-seed-notices`:
    /// the pairing screen is shown only when a live gateway refuses this exact
    /// device with a 1008 pairing close, which a screenshot run cannot arrange
    /// without the gateway's own token (a real credential) and an unapproved
    /// device on a running gateway. So the screenshot run seeds a sample refusal
    /// through the REAL `PairingState.closed`, which arms the real retry timer and
    /// draws the real `PairingView`, so what a screenshot proves is the actual
    /// screen and its actual stability across retries rather than a mock. Compiled
    /// out of a release build, and inert without the argument.
    static var screenshotSeedsPairing: Bool {
        ProcessInfo.processInfo.arguments.contains("-claw-seed-pairing")
    }

    /// The sample refusal the seeded pairing screen shows: an example requestId of
    /// the shape the gateway emits, read through the same parser a live close is,
    /// so the command and the identity on screen are built the real way. The id is
    /// an example, like every id in the fixtures.
    static let screenshotPairingRefusal = Pairing.Refusal(reason: "not-paired", requestId: "req-7f3a2b")

    /// The build the seeded update check runs as, fixed to a dev version so the
    /// channel gate (dev-only feed) and the comparison are deterministic on a
    /// simulator, whose real `Naming.buildVersion` is only the marketing-version
    /// fallback. The two screenshots differ only in what the seeded feed
    /// advertises against this: an equal version draws no banner, a higher one
    /// draws it.
    static let screenshotCurrentVersion = "1.0.1-dev.148.abc1234567"
    #else
    static var screenshotTab: String? { nil }
    static var screenshotOpensSettings: Bool { false }
    static var screenshotSeedsUpdateFeed: Bool { false }
    static var screenshotUpdateFeedVersion: String? { nil }
    static var screenshotSeedsPairing: Bool { false }
    #endif

    /// The split of the settings surface, read from the bundled spec.
    ///
    /// An empty object rather than nil when the file is missing, because the page
    /// renders nothing rather than everything: a page that treated an absent spec
    /// as "no restrictions" would show a desktop-only setting on the phone, which
    /// is the failure this file exists to prevent. `SettingsSpecTests` fails
    /// loudly if the file is not in the bundle.
    static var surface: [String: Any] {
        guard let url = Bundle.main.url(forResource: "settings", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let spec = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return spec
    }
}
