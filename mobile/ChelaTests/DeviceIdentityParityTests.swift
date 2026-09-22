import XCTest

@testable@testable import Chela

/// Parity with `core/device-identity.js` and its fixture, the bridge that makes
/// the Control UI's device keypair survive a reinstall.
///
/// The gateway recognises an already-paired device by the keypair the page
/// presents, and the page keeps that keypair in `localStorage`, which a
/// `WKWebView` wipes on uninstall. So this client seeds a persisted identity back
/// into `localStorage` before the page boots, and captures the page's current
/// identity out to the Keychain. The wire contract is shared: this proves the
/// Swift port builds the same seed statement as the JS for every golden case, and
/// reads the same storage key, seed global and message name the shared spec owns.
/// The two injected scripts are NOT ported (a mirror is a second copy), so the
/// bundled spec is asserted to be the repository's, the same as the other bridges.
final class DeviceIdentityParityTests: XCTestCase {
    // MARK: - Fixture shapes

    private struct Input: Decodable {
        let identity: String?
    }

    private struct SeedCase: Decodable {
        let name: String
        let input: Input
        let output: String
    }

    private struct Fixture: Decodable {
        let storageKey: String
        let seedGlobal: String
        let messageName: String
        let pollIntervalMs: Int
        let seed: [SeedCase]
    }

    private struct SpecShape: Decodable {
        let storageKey: String
        let seedGlobal: String
        let messageName: String
        let pollIntervalMs: Int
        let seed: [String]
        let capture: [String]
    }

    private func fixture() throws -> Fixture {
        try Fixtures.load("device-identity")
    }

    private func repoSpecData() throws -> Data {
        try Data(contentsOf: try Fixtures.spec().appendingPathComponent("device-identity.json"))
    }

    // MARK: - The constants and the scripts come from the spec

    func testTheConstantsAndScriptsComeFromTheSpec() throws {
        let spec = try JSONDecoder().decode(SpecShape.self, from: try repoSpecData())
        XCTAssertEqual(DeviceIdentity.messageName, spec.messageName)
        XCTAssertEqual(DeviceIdentityBridge.messageName, spec.messageName)

        // The bundle carries that same file rather than a second one: an app
        // cannot read the repo, so the bundled copy is what ships. Without it the
        // client cannot seed or capture, and every reinstall would re-pair.
        let bundled = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "device-identity", withExtension: "json")
                ?? Bundle.main.url(forResource: "device-identity", withExtension: "json"),
            "the app did not bundle core/spec/device-identity.json, so it cannot make pairing stick"
        )
        XCTAssertEqual(try Data(contentsOf: bundled), try repoSpecData(), "the bundled spec has diverged from the repo's")
    }

    func testTheStorageKeyIsTheOneTheControlUiUses() throws {
        // Pinned as a literal so a drift from the checkout's
        // DEVICE_IDENTITY_STORAGE_KEY fails loudly rather than silently seeding a
        // key the page never reads. This is the key the OpenClaw Control UI keeps
        // its device keypair under (ui/src/lib/nodes/index.ts).
        let spec = try JSONDecoder().decode(SpecShape.self, from: try repoSpecData())
        XCTAssertEqual(spec.storageKey, "openclaw-device-identity-v1")
    }

    // MARK: - The seed statement reproduces every fixture

    func testSeedInstallationReproducesEveryFixture() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.seed.isEmpty, "expected device-identity seed fixtures")
        for testCase in fixture.seed {
            XCTAssertEqual(
                DeviceIdentity.seedInstallation(identity: testCase.input.identity),
                testCase.output,
                testCase.name
            )
        }
    }

    // MARK: - The rules a port gets wrong

    func testNoPersistedIdentitySeedsNull() {
        // The first-ever launch: with nothing captured the seed assigns null and
        // the seed script does nothing, so the page mints its own key rather than
        // being handed an empty or invalid one.
        let statement = DeviceIdentity.seedInstallation(identity: nil)
        XCTAssertTrue(statement.hasPrefix("window.__clawDeviceIdentitySeed = null;"), "no identity must seed null")
        let empty = DeviceIdentity.seedInstallation(identity: "")
        XCTAssertTrue(empty.hasPrefix("window.__clawDeviceIdentitySeed = null;"), "an empty identity is treated as none")
    }

    func testAnIdentityWithQuotesSurvivesTheAssignment() throws {
        // The opaque identity is JSON, so it contains quotes; a naive splice would
        // break out of the assignment. The value must be a JSON string literal, so
        // decoding the assignment back yields the exact identity.
        let identity = "{\"version\":1,\"deviceId\":\"d\",\"publicKey\":\"p\\\"k\",\"privateKey\":\"s\"}"
        let statement = DeviceIdentity.seedInstallation(identity: identity)
        let prefix = "window.__clawDeviceIdentitySeed = "
        XCTAssertTrue(statement.hasPrefix(prefix), "the seed starts with the assignment")
        // The assignment is the first line, ending with a semicolon.
        let firstLine = statement.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
        let literal = String(firstLine.dropFirst(prefix.count).dropLast())
        let decoded = try JSONDecoder().decode(String.self, from: Data(literal.utf8))
        XCTAssertEqual(decoded, identity, "the identity must round-trip through the JSON string literal intact")
    }
}
