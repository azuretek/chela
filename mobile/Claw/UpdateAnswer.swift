import Foundation

/// How a check was started, which decides whether a non-answer is owed.
///
/// Mirrors the `trigger` strings `core/updates.js` gates on. `manual` means
/// somebody pressed "Check for updates" and is owed an answer either way; the
/// other two are the app looking on its own, where "nothing newer" is silence
/// rather than news.
enum UpdateTrigger: String {
    case manual
    case startup
    case scheduled
}

/// What a check owes the person who pressed the button, in both directions.
///
/// Ported from `checkAnswer` in `core/updates.js`, and proven against the same
/// golden fixtures (`core/fixtures/updates.json`, its `answers` section) that the
/// JS side asserts, so the phone and the desktop cannot answer the same question
/// with different words or, worse, answer one direction and stay silent on the
/// other.
///
/// This exists because of a bug rather than a design: the check ran, compared
/// against the running build, found a release, and no surface said so. So the
/// shape below answers BOTH outcomes, and the only thing it may return nil for is
/// a background check that found nothing, which is the silence a scheduled check
/// is supposed to keep.
///
/// It composes a notice and never raises one: which id it lands under, how long
/// it lives and what its action does are facts about a surface, and the surface
/// is `NoticeBoard` plus the banner. The tone names come from `NoticeTone`, the
/// same way the JS imports them from `core/notices.js` rather than spelling them.
enum UpdateAnswer {
    /// One answer, as the notice it is raised as.
    struct Answer: Equatable {
        let tone: String
        let message: String
        let detail: String
    }

    /// How a check ended, mirroring `outcomes` in `core/spec/updates.json`.
    enum Outcome: String {
        case available
        case current
        case unavailable
        case error
    }

    /// Whether a check should say anything when there is no update.
    ///
    /// The same rule as `shouldReportNoUpdate` in the JS: a scheduled or startup
    /// check that announces "you are up to date" is noise, and someone who just
    /// pressed the button is owed an answer.
    static func shouldReportNoUpdate(_ trigger: UpdateTrigger) -> Bool {
        trigger == .manual
    }

    /// The sentence that keeps an offer honest, or an empty string for an upgrade.
    ///
    /// Ported from `offeredCaveat` in `core/updates.js`, and it exists for the
    /// same fault on this client: the feed is read newest-first by PUBLISH TIME, so
    /// the release it hands over can carry a number below the one running once the
    /// version tail's basis has moved. A banner that says "is available" about such
    /// a build is presenting it as an upgrade it is not, and this client has no
    /// version-numbering fix of its own to lean on.
    ///
    /// ★ `Version.compare` (semver precedence, tail and all) rather than
    /// `compareRelease`, which is deliberately the opposite of what an update
    /// DECISION uses. The decision must never rank the tail, because its basis
    /// changes; what a banner PRESENTS is answered about the whole string, because
    /// the whole string is what the reader can see.
    ///
    /// Empty rather than a reassurance on the ordinary path: a caveat on every offer
    /// is a caveat nobody reads by the second one. An unparseable version is also
    /// empty rather than a caveat, which is the same non-answer `offeredStanding`
    /// gives: a version this build cannot read is a fault where it happened, not
    /// something to invent a sentence about here.
    static func offeredCaveat(offered: String?, current: String) -> String {
        guard let offered, let standing = try? Version.compare(offered, current) else { return "" }
        if standing < 0 {
            return "It is numbered below the build you are running, so it is not an upgrade; it is the newest release by publish time."
        }
        if standing == 0 {
            return "It carries the same number as the build you are running, so it is the same version released again rather than a newer one."
        }
        return ""
    }

    /// The answer for one outcome, or nil where nothing is owed.
    ///
    /// - Parameters:
    ///   - outcome: what the check found.
    ///   - trigger: how the check started; only a manual check is answered in both directions.
    ///   - version: the version found, for `available`.
    ///   - current: this build's own version, which every answer names.
    ///   - action: what this build may do about it, from `UpdatePolicy`.
    ///   - reason: why it cannot check, or cannot install.
    ///   - error: what a failed check said.
    ///   - pointer: where a new build is, in this client's own words. The shared
    ///     composition names no distribution channel, which is the same rule the
    ///     iOS branch of `UpdatePolicy.capability` follows, so the sentence comes
    ///     from the client that has a channel to name. The phone passes TestFlight.
    static func answer(
        outcome: Outcome,
        trigger: UpdateTrigger = .manual,
        version: String? = nil,
        current: String,
        action: UpdatePolicy.Action = .notify,
        reason: String? = nil,
        error: String? = nil,
        pointer: String? = nil
    ) -> Answer? {
        // An answer is owed only to someone who asked. Every outcome but one is
        // gated on that, and the exception is the point of the rule: a release that
        // exists is news whatever started the check, while "nothing newer", "this
        // build cannot ask" and "the check could not finish" are all things a
        // background check keeps to its log. A dev build checks on every launch, so
        // a warning per flaky network is the noise this rule exists to avoid, and a
        // press is owed an answer even when the answer is that it failed.
        if outcome != .available {
            guard shouldReportNoUpdate(trigger) else { return nil }
        }

        switch outcome {
        case .available:
            let headline = "\(Naming.product) \(version ?? "") is available."
            // The caveat rides on every branch, including the pointer's: a pointer
            // says where the build is, never whether it is above what you have, and
            // this client's pointer is a bare "Open TestFlight to update."
            let caveat = offeredCaveat(offered: version, current: current)
            let from = "You are on \(current).\(caveat.isEmpty ? "" : " \(caveat)")"
            if let pointer {
                return Answer(tone: NoticeTone.info, message: headline, detail: "\(from) \(pointer)")
            }
            switch action {
            case .install:
                return Answer(
                    tone: NoticeTone.info,
                    message: headline,
                    detail: "\(from) It will download in the background, and you can restart to apply it."
                )
            case .manual:
                return Answer(
                    tone: NoticeTone.info,
                    message: headline,
                    detail: "\(from) Automatic updates are off, so nothing has been downloaded yet, "
                        + "install it now, or turn them back on in Settings."
                )
            default:
                let because = reason.map { ", because \($0)" } ?? ""
                return Answer(
                    tone: NoticeTone.info,
                    message: headline,
                    detail: "\(from) This build cannot update itself\(because), "
                        + "download the new version and replace the app to upgrade."
                )
            }

        case .current:
            return Answer(
                tone: NoticeTone.ok,
                message: "\(Naming.product) is up to date.",
                detail: "You are on \(current)."
            )

        case .unavailable:
            return Answer(
                tone: NoticeTone.info,
                message: "Updates are not available in this build.",
                detail: noticeSentence(reason)
            )

        case .error:
            return Answer(
                tone: NoticeTone.warn,
                message: "Could not check for updates.",
                detail: noticeSentence(error)
            )
        }
    }
}
