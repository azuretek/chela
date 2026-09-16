import XCTest

@testable import Claw

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

    struct FixtureCase: Decodable {
        let name: String
        let input: Input
        let output: Output
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
