import XCTest
import UIKit

@testable import Claw

/// Parity with `core/prompt-metadata.js`, proven against the same golden fixtures
/// the JS asserts in `core/test/fixtures.test.js`.
///
/// Two halves, and the second is the one a fixture cannot express.
///
/// The block: the same header rule, the same field order, the same value rules
/// and the same identity composition as the desktop, reproduced here rather than
/// described. The marker is pinned as a literal too, because it is OpenClaw's
/// token rather than ours and a change to it has to be deliberate: it is the
/// only reason the gateway strips the block for us.
///
/// The script: this client has no Swift version of it at all, on purpose. It
/// reads `core/spec/prompt-metadata.json` out of its own bundle, so what is
/// asserted here is that what the app will actually install is the file the
/// desktop reads, line for line and byte for byte.
final class PromptMetadataParityTests: XCTestCase {
    // MARK: - Fixtures

    private struct PromptMetadataFixture: Decodable {
        let marker: String
        let global: String
        let clean: [CleanCase]
        let block: [BlockCase]
        let clientIdentity: [IdentityCase]
        let hook: HookClaim

        struct CleanCase: Decodable {
            let input: String?
            let output: String
        }

        struct BlockCase: Decodable {
            let name: String
            let metadata: [String: String]
            let client: String?
            let output: String
        }

        struct IdentityCase: Decodable {
            struct Input: Decodable {
                let label: String
                let version: String
            }

            let input: Input
            let output: String
        }

        struct HookClaim: Decodable {
            let owner: String
            let field: String
            let lines: Int
            let contains: [String]
        }
    }

    private func fixture() throws -> PromptMetadataFixture {
        try Fixtures.load("prompt-metadata")
    }

    /// The spec as it is on disk in the repo, which is the desktop's source too.
    private func repoSpec() throws -> Data {
        let url = try Fixtures.spec().appendingPathComponent("prompt-metadata.json")
        return try Data(contentsOf: url)
    }

    // MARK: - The block

    func testTheMarkerIsOpenClawsOwn() throws {
        XCTAssertEqual(PromptMetadata.marker, "\u{27E6}openclaw:ctx\u{27E7}")
        XCTAssertEqual(PromptMetadata.marker, try fixture().marker)
    }

    func testCleanReproducesEveryFixture() throws {
        let cases = try fixture().clean
        XCTAssertFalse(cases.isEmpty, "expected cases in core/fixtures/prompt-metadata.json")

        for testCase in cases {
            XCTAssertEqual(
                PromptMetadata.clean(testCase.input),
                testCase.output,
                "clean(\(testCase.input.map { "\"\($0)\"" } ?? "nil")) should be \(testCase.output)"
            )
        }
    }

    func testFormatBlockReproducesEveryFixture() throws {
        let cases = try fixture().block
        XCTAssertFalse(cases.isEmpty, "expected block cases in core/fixtures/prompt-metadata.json")

        for testCase in cases {
            // The cases without a client use the desktop default on the JS side,
            // which is the call the desktop itself makes.
            let client = testCase.client ?? "desktop"
            XCTAssertEqual(
                PromptMetadata.formatBlock(testCase.metadata, client: client),
                testCase.output,
                "\(testCase.name): the block disagrees"
            )
        }
    }

    func testClientIdentityReproducesEveryFixture() throws {
        let cases = try fixture().clientIdentity
        XCTAssertFalse(cases.isEmpty, "expected identity cases in core/fixtures/prompt-metadata.json")

        for testCase in cases {
            XCTAssertEqual(
                PromptMetadata.clientIdentity(label: testCase.input.label, version: testCase.input.version),
                testCase.output,
                "clientIdentity(\(testCase.input)) should be \(testCase.output)"
            )
        }
    }

    func testTheHeaderEndsWithTheMarkerOnBothClients() {
        // The stripper matches a header line that ENDS with the marker, and a
        // line that is only the marker is not a header at all. Both halves are
        // what keeps the block out of what a person reads.
        for client in ["desktop", "mobile"] {
            let header = PromptMetadata.header(client: client)
            XCTAssertTrue(header.hasSuffix(PromptMetadata.marker), "\(client) header: \(header)")
            XCTAssertGreaterThan(header.count, PromptMetadata.marker.count)
        }
        XCTAssertEqual(PromptMetadata.header(client: "mobile"), "Mobile client context: \u{27E6}openclaw:ctx\u{27E7}")
        XCTAssertEqual(PromptMetadata.header(client: "nowhere"), PromptMetadata.header(client: "desktop"))
    }

    // MARK: - What the phone knows, and what it does not

    @MainActor
    func testThePhoneGathersOnlyWhatItGenuinelyKnows() {
        let facts = PromptMetadata.collect(
            appVersion: "9.9.9",
            machine: "iPhone99,9",
            locale: Locale(identifier: "en_US"),
            timezone: TimeZone(identifier: "Europe/London")!
        )

        XCTAssertEqual(
            Set(facts.keys),
            ["host", "os", "locale", "timezone", "client"],
            "the phone's fields are the ones it can answer for"
        )
        // Not oversights: a phone has no OS account and no home directory that
        // means anything, and the only values available would be a constant and
        // an app sandbox path. Sending either would be reporting something
        // nobody asked for.
        XCTAssertNil(facts["user"])
        XCTAssertNil(facts["home"])
        XCTAssertTrue(facts["os"]!.hasPrefix("iOS "), facts["os"]!)
        // The identifier, ONCE, because this table has no name for it: a fallback
        // that printed the name and the identifier would say the same thing twice on
        // exactly the phones nobody has checked.
        XCTAssertTrue(facts["os"]!.hasSuffix("on iPhone99,9"), facts["os"]!)
        XCTAssertFalse(facts["os"]!.contains("iPhone99,9, iPhone99,9"), facts["os"]!)
        XCTAssertEqual(facts["locale"], "en-US", "the separator matches the desktop's locale tag")
        XCTAssertEqual(facts["timezone"], "Europe/London")
        XCTAssertEqual(facts["client"], "\(Naming.clientLabel) 9.9.9")
        XCTAssertFalse(facts["host"]!.isEmpty)
    }

    @MainActor
    func testTheBlockItBuildsIsTheSameShapeAsTheDesktops() {
        let block = PromptMetadata.formatBlock(PromptMetadata.collect(appVersion: "9.9.9"))
        let lines = block.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)

        XCTAssertEqual(lines.first, "Mobile client context: \u{27E6}openclaw:ctx\u{27E7}")
        // Header, then the framing lines, then the fields, then the closing.
        let framing = PromptMetadata.framing
        let closing = PromptMetadata.closing
        XCTAssertGreaterThanOrEqual(framing.count, 1, "expected framing that tells the model what the block is")
        XCTAssertGreaterThanOrEqual(closing.count, 1, "expected a closing line that marks the end of the context")
        XCTAssertEqual(Array(lines[1..<(1 + framing.count)]), framing, "framing sits between the header and the fields")
        let fieldLines = Array(lines.dropFirst(1 + framing.count).dropLast(closing.count))
        XCTAssertEqual(
            fieldLines.map { $0.split(separator: ":")[0] },
            ["host", "os", "locale", "timezone", "client"],
            "the fields follow the spec's order, and the ones it cannot answer are absent"
        )
        XCTAssertEqual(Array(lines.suffix(closing.count)), closing, "the closing lines are the last lines in the block")
        XCTAssertEqual(lines.filter { $0.contains(PromptMetadata.marker) }.count, 1, "one header, always")
        for line in framing {
            XCTAssertFalse(line.hasSuffix(PromptMetadata.marker), "a framing line must not read as a header")
            XCTAssertFalse(line.trimmingCharacters(in: .whitespaces).isEmpty, "a blank framing line would end the block early")
        }
        for line in closing {
            XCTAssertFalse(line.hasSuffix(PromptMetadata.marker), "a closing line must not read as a header")
            XCTAssertFalse(line.trimmingCharacters(in: .whitespaces).isEmpty, "a blank closing line would end the block early")
        }
    }

    // MARK: - The one copy of the script

    func testTheInstalledScriptIsTheFileTheDesktopReads() throws {
        let onDisk = try repoSpec()
        let spec = try JSONDecoder().decode(HookOnly.self, from: onDisk)
        let expected = spec.hook.joined(separator: "\n")

        XCTAssertFalse(expected.isEmpty, "the spec's hook is empty, so this test would prove nothing")
        XCTAssertEqual(
            PromptMetadata.script,
            expected,
            "the script this app installs is not the script core/spec/prompt-metadata.json owns"
        )

        // And the bundle carries that same file rather than a second one: an app
        // cannot read the repo, so the bundled copy is what ships, and a stale or
        // edited copy of it would be a second owner.
        let bundled = try XCTUnwrap(
            Bundle.main.url(forResource: "prompt-metadata", withExtension: "json"),
            "the app did not bundle core/spec/prompt-metadata.json, so it cannot install the shared script"
        )
        XCTAssertEqual(try Data(contentsOf: bundled), onDisk, "the bundled spec has diverged from the repo's")
    }

    func testTheScriptCarriesNothingPlatformSpecific() throws {
        let script = PromptMetadata.script
        let claim = try fixture().hook

        XCTAssertEqual(script.split(separator: "\n").count, claim.lines)
        for part in claim.contains {
            XCTAssertTrue(script.contains(part), "the script should still mention \(part)")
        }
        // If either client's own name were in the script, the two clients could
        // not run the same bytes and this whole arrangement would be a fiction.
        for platform in [Naming.mobileToken, "chela-desktop", "UIKit", "Node"] {
            XCTAssertFalse(script.contains(platform), "\(platform) does not belong in the shared script")
        }
    }

    @MainActor
    func testTheInstallationIsTheConfigurationThenThatScript() throws {
        let installation = PromptMetadata.installation(enabled: true, appVersion: "9.9.9")

        XCTAssertEqual(try fixture().hook.owner, "core/spec/prompt-metadata.json")
        XCTAssertTrue(installation.hasSuffix(PromptMetadata.script), "the shared script is installed unchanged")
        XCTAssertTrue(installation.hasPrefix("window.__clawPromptMetadata = {"), installation)
        XCTAssertTrue(installation.contains("Mobile client context"), "the facts are this client's own")
        XCTAssertTrue(installation.contains("Chela (chela-mobile) 9.9.9"))
        XCTAssertTrue(installation.contains("WebSocket.prototype.send"))
    }

    /// Off until something turns it on, which is the desktop's default too: the
    /// facts include a device name, so the honest default is opt-in. Flipping
    /// `PromptMetadata.contextInPrompts` is what moves this, and it is the one
    /// line to change when a settings surface exists.
    @MainActor
    func testTheContextIsOffUntilSomethingTurnsItOn() {
        let installation = PromptMetadata.installation()

        XCTAssertFalse(PromptMetadata.contextInPrompts)
        XCTAssertTrue(installation.contains("\"enabled\":false"), installation)
        XCTAssertTrue(installation.contains("\"block\":\""), "the block is still composed, ready to send")
    }

    private struct HookOnly: Decodable {
        let hook: [String]
    }
}
