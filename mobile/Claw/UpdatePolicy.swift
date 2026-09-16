import Foundation

/// What this build is allowed to do about a new version, ported from
/// `core/updates.js`.
///
/// The answer is not the same on every platform, and the reason is code signing
/// rather than anything we chose. Windows installs an update even unsigned,
/// because NSIS verification is skipped when there is no publisher name. macOS
/// can only install over a signed running bundle, so an unsigned build tells the
/// user and stops. Linux can replace an AppImage in place, but has no way to
/// answer at all when it is not running as one. iOS, which is the platform this
/// port exists for, cannot install its own update whatever we do, because
/// installation belongs to the operating system rather than to the app.
///
/// The policy is shared rather than reimplemented so the phone and the desktop
/// cannot disagree about what a release means for them. `UpdatePolicyParityTests`
/// proves this port reproduces the golden fixtures in
/// `core/fixtures/updates.json` that `core/test/updates.test.js` asserts on the
/// JS side. That test is the contract: change a rule, regenerate the fixtures,
/// and this file is what has to move with it.
///
/// The constants below mirror `core/spec/updates.json`. The Swift does not read
/// the spec at runtime, because a shipped app cannot read a file that lives in
/// the repo, and a bundled copy of the data would be a third thing to keep in
/// step.
///
/// Nothing here reads the environment or the clock, matching the JS: `platform`,
/// `packaged`, `macSigned` and `appImage` are all arguments. That is what makes
/// every platform testable from one run on one machine, and it is why the
/// AppImage fact in particular is the caller's to supply rather than something
/// this type goes looking for.
enum UpdatePolicy {
    /// What to do when a newer version exists.
    ///
    /// The raw values are the strings the fixtures and `spec/updates.json` use,
    /// so a port that renamed one would fail parity rather than silently answer
    /// a different question.
    enum Action: String {
        case install
        case manual
        case notify
        case none
    }

    /// What the *platform* allows, ignoring what the user has asked for.
    struct Capability: Equatable {
        let action: Action
        let check: Bool
        let autoDownload: Bool
        let reason: String
    }

    /// How this build should behave, given the platform and the preference.
    ///
    /// `canInstall` and `capabilityReason` describe the build rather than the
    /// current action, which is what lets Settings disable the automatic-updates
    /// switch on a build that could never install one and say why.
    struct Plan: Equatable {
        let action: Action
        let check: Bool
        let autoDownload: Bool
        let reason: String
        let canInstall: Bool
        let capabilityReason: String
    }

    /// Whether macOS builds are signed with a Developer ID.
    ///
    /// Compiled in rather than probed, for the same reason as the JS: the answer
    /// only changes when the build pipeline changes, which is a commit. iOS does
    /// not consult it, because signing does not turn iOS into a platform that can
    /// install its own update.
    static let macSigned = true

    /// How long a running app waits between scheduled checks.
    ///
    /// Nothing reads these yet, and the banner that will is the next phase. They
    /// are mirrored now so the spec has both clients on it from the start rather
    /// than acquiring a second copy later.
    static let stableIntervalMs = 21_600_000
    static let prereleaseIntervalMs = 300_000

    /// What the platform allows, ignoring what the user has asked for.
    ///
    /// - Parameters:
    ///   - platform: `process.platform` on desktop; `"ios"` here.
    ///   - packaged: whether this is a real installed build rather than a source
    ///     run, which has no update metadata and no version worth comparing.
    ///   - macSigned: defaults to `macSigned` above; macOS only.
    ///   - appImage: running from an AppImage; Linux only, and the caller's fact
    ///     to supply.
    static func capability(
        platform: String,
        packaged: Bool,
        macSigned: Bool? = nil,
        appImage: Bool = false
    ) -> Capability {
        // A source run has no update metadata and no version worth comparing.
        // Answered before any platform rule, so it beats all of them.
        if !packaged {
            return Capability(action: .none, check: false, autoDownload: false, reason: "running from source")
        }

        if platform == "win32" {
            return Capability(action: .install, check: true, autoDownload: true, reason: "NSIS updates do not require a signed build")
        }

        if platform == "darwin" {
            return (macSigned ?? UpdatePolicy.macSigned)
                ? Capability(action: .install, check: true, autoDownload: true, reason: "signed with a Developer ID")
                // Downloading something that cannot be installed wastes ~130MB of
                // someone's bandwidth to reach the same dialog.
                : Capability(
                    action: .notify,
                    check: true,
                    autoDownload: false,
                    reason: "unsigned: Squirrel.Mac cannot install an update over an unsigned bundle"
                )
        }

        if platform == "linux" {
            // Not merely useless but actively misleading when it is not an
            // AppImage: the updater is inactive without the file it would
            // replace, so a check resolves to nothing and emits no event at all.
            // `check: false` is how the app explains that instead of silently
            // answering nothing forever.
            return appImage
                ? Capability(action: .install, check: true, autoDownload: true, reason: "an AppImage replaces itself in place")
                : Capability(
                    action: .notify,
                    check: false,
                    autoDownload: false,
                    reason: "not running as an AppImage, so there is no file an update could replace"
                )
        }

        // iOS is a branch rather than a fallthrough: it is the one platform where
        // the limit is a rule instead of a signing accident, and the two answers
        // agree by coincidence today. A fact that is right by accident stops
        // being right the first time anything upstream moves.
        //
        // NOTIFY rather than MANUAL, because this build cannot install anything
        // even when asked, so there is no button to offer. `check` stays true
        // because noticing a release is the whole of what this platform can do.
        //
        // The reason names no distribution channel on purpose: which mechanism
        // delivers the next build is an open decision, and a sentence here would
        // settle it by accident.
        if platform == "ios" {
            return Capability(
                action: .notify,
                check: true,
                autoDownload: false,
                reason: "iOS does not let an app install its own update, so it can only say a release exists and offer an install link"
            )
        }

        return Capability(action: .notify, check: true, autoDownload: false, reason: "no tested install path on this platform")
    }

    /// How this build should behave about updates, given what the platform
    /// allows and what the user has asked for.
    ///
    /// The preference only ever *narrows* the platform's answer. Turning
    /// automatic updates off cannot make a build that could not install start
    /// installing, and it does not stop the app looking: knowing a release
    /// exists is what makes the manual install offer possible at all.
    ///
    /// MANUAL rather than NOTIFY when it is off, because the two are different
    /// offers and saying the wrong one is worse than saying nothing.
    static func policy(
        platform: String,
        packaged: Bool,
        macSigned: Bool? = nil,
        appImage: Bool = false,
        autoUpdate: Bool = true
    ) -> Plan {
        let base = capability(platform: platform, packaged: packaged, macSigned: macSigned, appImage: appImage)
        let canInstall = base.action == .install

        if !canInstall || autoUpdate {
            return Plan(
                action: base.action,
                check: base.check,
                autoDownload: base.autoDownload,
                reason: base.reason,
                canInstall: canInstall,
                capabilityReason: base.reason
            )
        }

        return Plan(
            action: .manual,
            check: true,
            autoDownload: false,
            reason: "automatic updates are turned off in Settings",
            canInstall: canInstall,
            capabilityReason: base.reason
        )
    }
}
