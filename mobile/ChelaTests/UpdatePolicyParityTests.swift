import XCTest

@testable import Chela

/// Parity with `core/updates.js`, proven against the same golden fixtures the JS
/// side asserts in `core/test/updates.test.js`.
///
/// This is the mechanism the design leans on so the two clients cannot drift:
/// the fixtures are generated from the JS, both clients reproduce them, and so
/// "the phone and the desktop agree about what this build may do" is a thing
/// that is checked rather than hoped for. Changing a policy rule means
/// regenerating the fixtures, and this test is what makes the Swift move with
/// them.
///
/// Every case goes through `policy()` rather than `capability()`, because
/// `policy()` answers with the platform's verdict plus the four fields the
/// fixtures pin, including `canInstall`, which is what the iOS banner will read
/// to decide whether it may offer anything at all.
final class UpdatePolicyParityTests: XCTestCase {
    func testPolicyReproducesEveryFixture() throws {
        let fixture: UpdatesFixture = try Fixtures.load("updates")
        // An empty case list would make the loop below vacuously green, which is
        // the failure mode a parity test can least afford.
        XCTAssertFalse(fixture.cases.isEmpty, "expected cases in core/fixtures/updates.json")

        for testCase in fixture.cases {
            let input = testCase.input
            let plan = UpdatePolicy.policy(
                platform: input.platform,
                packaged: input.packaged,
                macSigned: input.macSigned,
                appImage: input.appImage ?? false,
                autoUpdate: input.autoUpdate ?? true
            )
            let actual = UpdatesFixture.Output(
                action: plan.action.rawValue,
                check: plan.check,
                autoDownload: plan.autoDownload,
                canInstall: plan.canInstall
            )
            XCTAssertEqual(actual, testCase.output, "\(testCase.name): \(input)")
        }
    }

    func testIOSAnnouncesAndNeverInstalls() throws {
        // The platform this port exists for, pinned separately from the fixtures
        // so that a fixture edit cannot quietly take iOS's answer with it.
        let plan = UpdatePolicy.policy(platform: "ios", packaged: true)
        XCTAssertEqual(plan.action, .notify)
        XCTAssertTrue(plan.check, "noticing a release is the whole of what iOS can do")
        XCTAssertFalse(plan.autoDownload, "there is nothing to download that the app could apply")
        XCTAssertFalse(plan.canInstall, "iOS cannot install its own update whatever we do")
        XCTAssertNotEqual(plan.reason, UpdatePolicy.capability(platform: "android", packaged: true).reason)
    }

    /// The cadence is a mirror too, and this is what holds it to its owner.
    ///
    /// `UpdatePolicy.stableIntervalMs` and `prereleaseIntervalMs` were mirrored
    /// from `core/spec/updates.json` with nothing reading them, which is how a
    /// mirror stops being one: a constant kept in step for a future that had not
    /// arrived. `UpdateSchedule` reads them now, so this asserts both halves -- the
    /// numbers are the spec's, and the reader the phone uses answers with them.
    func testTheCadenceMirrorsTheSharedSpec() throws {
        struct Spec: Decodable {
            struct Intervals: Decodable {
                let stableMs: Int
                let prereleaseMs: Int
            }
            let intervals: Intervals
        }

        let spec: Spec = try Fixtures.loadSpec("updates")
        XCTAssertEqual(UpdatePolicy.stableIntervalMs, spec.intervals.stableMs)
        XCTAssertEqual(UpdatePolicy.prereleaseIntervalMs, spec.intervals.prereleaseMs)

        // And the rule the desktop's `checkIntervalMs` follows, from the same two
        // numbers: a dev build on the fast interval, a stable build on the slow one.
        XCTAssertEqual(UpdateCadence.intervalMs(for: "1.0.1-dev.51.e8de8f92c2"), spec.intervals.prereleaseMs)
        XCTAssertEqual(UpdateCadence.intervalMs(for: "1.0.1"), spec.intervals.stableMs)
    }

    /// What a check answers, reproduced from the same golden pairs the JS asserts.
    ///
    /// This is the contract for the bug the answer exists for: a control that
    /// appeared to work and reported nothing. One direction of the pair would not
    /// be enough, so the fixture set carries both and this test also asserts that
    /// it does, because a fixture file that lost a direction would leave this
    /// green while the phone went silent again.
    func testAnswerReproducesEveryFixture() throws {
        let fixture: UpdatesFixture = try Fixtures.load("updates")
        XCTAssertFalse(fixture.answers.isEmpty, "expected answers in core/fixtures/updates.json")

        for testCase in fixture.answers {
            let input = testCase.input
            guard let outcome = UpdateAnswer.Outcome(rawValue: input.outcome) else {
                XCTFail("\(testCase.name): unknown outcome \(input.outcome)")
                continue
            }
            let trigger = try input.trigger.map { raw in
                try XCTUnwrap(UpdateTrigger(rawValue: raw), "\(testCase.name): unknown trigger \(raw)")
            } ?? .manual
            let action = try input.action.map { raw in
                try XCTUnwrap(UpdatePolicy.Action(rawValue: raw), "\(testCase.name): unknown action \(raw)")
            } ?? .notify
            let answer = UpdateAnswer.answer(
                outcome: outcome,
                trigger: trigger,
                version: input.version,
                current: input.current,
                action: action,
                reason: input.reason,
                error: input.error,
                pointer: input.pointer
            )
            guard let expected = testCase.output else {
                XCTAssertNil(answer, "\(testCase.name): expected no answer")
                continue
            }
            let actual = try XCTUnwrap(answer, "\(testCase.name): expected an answer")
            XCTAssertEqual(actual.tone, expected.tone, testCase.name)
            XCTAssertEqual(actual.message, expected.message, testCase.name)
            XCTAssertEqual(actual.detail, expected.detail, testCase.name)
        }

        let outcomes = Set(fixture.answers.map(\.input.outcome))
        XCTAssertTrue(outcomes.contains("available") && outcomes.contains("current"),
                      "the fixtures must cover an available and a current answer; got \(outcomes)")
    }
}

/// `core/fixtures/updates.json`: the platform, whether it is a packaged build,
/// whether the mac build is signed, whether it is an AppImage, the user's
/// preference, and the tuple the policy must produce.
///
/// `platform` and `packaged` are required rather than optional on purpose: a
/// fixture that lost either one should fail to decode loudly, instead of
/// defaulting into the unknown-platform branch and passing for the wrong reason.
struct UpdatesFixture: Decodable {
    let cases: [FixtureCase]
    let answers: [AnswerCase]

    struct FixtureCase: Decodable {
        let name: String
        let input: Input
        let output: Output
    }

    /// One answer pair. `input.action`, `input.reason` and `input.pointer` are
    /// optional because a fixture only carries the fields its case turns on, and
    /// `output` is optional because one of them is the deliberate silence: a
    /// background check that found nothing answers null.
    ///
    /// The three enum-shaped fields arrive as the raw strings the fixtures and the
    /// JS use, and the test maps them, so an unknown name in a fixture fails loudly
    /// rather than defaulting into a branch that would pass for the wrong reason.
    /// That is the same discipline `Output.action` follows.
    struct AnswerCase: Decodable {
        let name: String
        let input: AnswerInput
        let output: AnswerOutput?
    }

    struct AnswerInput: Decodable {
        let outcome: String
        let trigger: String?
        let version: String?
        let current: String
        let action: String?
        let reason: String?
        let error: String?
        let pointer: String?
    }

    struct AnswerOutput: Decodable {
        let tone: String
        let message: String
        let detail: String
    }

    struct Input: Decodable, CustomStringConvertible {
        let platform: String
        let packaged: Bool
        let macSigned: Bool?
        let appImage: Bool?
        let autoUpdate: Bool?

        var description: String {
            var parts = ["platform: \(platform)", "packaged: \(packaged)"]
            if let macSigned { parts.append("macSigned: \(macSigned)") }
            if let appImage { parts.append("appImage: \(appImage)") }
            if let autoUpdate { parts.append("autoUpdate: \(autoUpdate)") }
            return parts.joined(separator: ", ")
        }
    }

    struct Output: Decodable, Equatable {
        let action: String
        let check: Bool
        let autoDownload: Bool
        let canInstall: Bool
    }
}
