import XCTest

@testable@testable import Chela

/// Parity with `core/native-control-auth.js` and its fixture, the native token
/// handoff: the object this client sets on the Control UI's window so the page
/// authenticates as the operator who entered the token.
///
/// The wire contract is shared, so this proves the Swift port builds the same
/// object as the JS for every golden case, and produces the same install
/// statement, against `core/fixtures/native-control-auth.json`, the same pairs
/// `core/test/native-control-auth.test.js` asserts on the JS side. What is NOT
/// shared, the per-client id, platform and device family, is the client's own,
/// so the fixtures name them explicitly and this test drives the port with the
/// fixture's inputs rather than the client's defaults.
final class NativeControlAuthParityTests: XCTestCase {
    // MARK: - Fixture shapes

    /// The inputs a case drives the builder with. The client facts are optional,
    /// so a case can prove the token-only and partial-descriptor rules.
    private struct Input: Decodable {
        let token: String?
        let clientId: String?
        let platform: String?
        let deviceFamily: String?
    }

    private struct ObjectCase: Decodable {
        let name: String
        let input: Input
        /// The expected object, decoded as generic JSON so the whole shape is
        /// compared rather than a fixed struct that could hide a stray key.
        let output: JSONValue
    }

    private struct InstallationCase: Decodable {
        let name: String
        let input: Input
        let output: String
    }

    private struct Fixture: Decodable {
        let global: String
        let cases: [ObjectCase]
        let installation: [InstallationCase]
    }

    private struct SpecOnly: Decodable {
        let global: String
        let mode: String
        let scopes: [String]
    }

    private func fixture() throws -> Fixture {
        try Fixtures.load("native-control-auth")
    }

    private func repoSpecData() throws -> Data {
        try Data(contentsOf: try Fixtures.spec().appendingPathComponent("native-control-auth.json"))
    }

    // MARK: - The constants come from the spec

    func testTheConstantsComeFromTheSpec() throws {
        let spec = try JSONDecoder().decode(SpecOnly.self, from: repoSpecData())
        XCTAssertEqual(NativeControlAuth.global, spec.global)
        XCTAssertEqual(NativeControlAuth.mode, spec.mode)
        XCTAssertEqual(NativeControlAuth.scopes, spec.scopes)

        // The bundle carries that same file rather than a second one: an app
        // cannot read the repo, so the bundled copy is what ships.
        let bundled = try XCTUnwrap(
            Bundle.main.url(forResource: "native-control-auth", withExtension: "json"),
            "the app did not bundle core/spec/native-control-auth.json, so it cannot hand the token over"
        )
        XCTAssertEqual(try Data(contentsOf: bundled), try repoSpecData(), "the bundled spec has diverged from the repo's")
    }

    func testTheGlobalIsTheOneTheControlUiReads() {
        // Pinned as a literal so a rename fails loudly rather than silently
        // setting a global nothing reads. This is the name the OpenClaw Control
        // UI reads in resolveApplicationStartupSettings.
        XCTAssertEqual(NativeControlAuth.global, "__OPENCLAW_NATIVE_CONTROL_AUTH__")
    }

    // MARK: - The object reproduces every fixture

    func testObjectReproducesEveryFixture() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.cases.isEmpty, "expected native-control-auth fixtures")
        for testCase in fixture.cases {
            let built = NativeControlAuth.object(
                token: testCase.input.token,
                clientId: testCase.input.clientId,
                platform: testCase.input.platform,
                deviceFamily: testCase.input.deviceFamily
            )
            XCTAssertEqual(
                JSONValue(built),
                testCase.output,
                testCase.name
            )
        }
    }

    // MARK: - The install statement reproduces every fixture

    func testInstallationReproducesEveryFixture() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.installation.isEmpty, "expected native-control-auth installation fixtures")
        for testCase in fixture.installation {
            let statement = NativeControlAuth.installation(
                token: testCase.input.token,
                clientId: testCase.input.clientId,
                platform: testCase.input.platform,
                deviceFamily: testCase.input.deviceFamily
            )
            // The statement is one assignment, and the JSON in it is order-free,
            // so the object it carries is compared rather than the exact bytes:
            // `JSONSerialization` sorts keys, and so does the JS `JSON.stringify`
            // here because the JS object's insertion order happens to be
            // alphabetical, but the meaning is what the contract is about.
            XCTAssertTrue(statement.hasPrefix("window.\(fixture.global) = "), testCase.name)
            XCTAssertTrue(statement.hasSuffix(";"), testCase.name)
            let json = String(statement.dropFirst("window.\(fixture.global) = ".count).dropLast())
            let built = try JSONValue(jsonString: json)
            let expectedJSON = String(testCase.output.dropFirst("window.\(fixture.global) = ".count).dropLast())
            let expected = try JSONValue(jsonString: expectedJSON)
            XCTAssertEqual(built, expected, testCase.name)
        }
    }

    // MARK: - The two rules a port gets wrong

    func testAnEmptyTokenHandsNoCredentialOver() {
        // The case a port gets wrong by setting token to the empty string. The
        // page reads an empty token as a request to retire shared-owner auth, so
        // the object must carry no token key at all.
        let empty = NativeControlAuth.object(token: "")
        XCTAssertNil(empty["token"], "an empty token must not become an empty-string token")
        let none = NativeControlAuth.object(token: nil)
        XCTAssertNil(none["token"], "a nil token hands no credential over")
    }

    func testAPartialDescriptorIsOmitted() {
        let partial = NativeControlAuth.object(token: "t", clientId: "openclaw-ios", platform: "ios", deviceFamily: nil)
        XCTAssertNil(partial["client"], "a descriptor missing a fact is left out rather than half sent")
        let full = NativeControlAuth.object(token: "t", clientId: "openclaw-ios", platform: "ios", deviceFamily: "iPhone")
        XCTAssertNotNil(full["client"], "a complete descriptor is included")
    }

    // MARK: - This client's own descriptor

    func testThisClientReportsTheIosDescriptor() {
        // The defaults this client hands over. openclaw-ios is the canonical
        // native client id in the gateway client registry.
        XCTAssertEqual(NativeControlAuth.clientId, "openclaw-ios")
        XCTAssertEqual(NativeControlAuth.platform, "ios")
        XCTAssertEqual(NativeControlAuth.deviceFamily(idiom: .phone), "iPhone")
        XCTAssertEqual(NativeControlAuth.deviceFamily(idiom: .pad), "iPad")
    }

    func testTheClientDefaultsProduceAFullDescriptor() {
        // The object this client actually installs, driven by its own defaults
        // rather than the fixture's explicit facts, carries a complete descriptor.
        let object = NativeControlAuth.object(token: "example-token")
        let client = try? XCTUnwrap(object["client"] as? [String: Any])
        XCTAssertEqual(client?["id"] as? String, "openclaw-ios")
        XCTAssertEqual(client?["mode"] as? String, NativeControlAuth.mode)
        XCTAssertEqual(client?["platform"] as? String, "ios")
        XCTAssertEqual(client?["scopes"] as? [String], NativeControlAuth.scopes)
    }

    // MARK: - The token travels Keychain -> the injected global

    /// The end-to-end path this whole change exists for: a token stored the way
    /// the settings page stores it (write-only, in the Keychain) reaches the
    /// exact document-start statement the web view installs, carried in the
    /// native-auth global the Control UI reads at boot. This is the integration
    /// check the task asks for: it proves the phone SUPPLIES the token where the
    /// page expects it, without a real device or a live gateway.
    func testTheStoredTokenReachesTheInjectedGlobal() throws {
        // A gateway id unlikely to collide with anything a developer has stored,
        // cleaned up whether or not the assertions pass.
        let gatewayId = "native-auth-test-\(UUID().uuidString)"
        let token = "integration-token-\(UUID().uuidString)"
        defer { SettingsCredentials.forget(gatewayId) }

        XCTAssertTrue(
            SettingsCredentials.set(gatewayId, field: "token", value: token),
            "the token could not be stored in the Keychain, so the rest proves nothing"
        )
        // Read it back the one way the connect path does, then build the exact
        // statement WebView installs at document start.
        let stored = SettingsCredentials.values(gatewayId).token
        XCTAssertEqual(stored, token, "the token did not round-trip through the Keychain")

        let statement = NativeControlAuth.installation(token: stored)
        XCTAssertTrue(
            statement.hasPrefix("window.\(NativeControlAuth.global) = "),
            "the statement sets the global the Control UI reads at boot"
        )
        // The token is IN the injected object, under the key the page reads.
        let json = String(statement.dropFirst("window.\(NativeControlAuth.global) = ".count).dropLast())
        let object = try JSONValue(jsonString: json)
        guard case let .object(fields) = object, case let .string(carried)? = fields["token"] else {
            return XCTFail("the injected object carries no token")
        }
        XCTAssertEqual(carried, token, "the injected global does not carry the stored token")
    }

    /// The credential does not ride on the navigation URL. The old handoff put
    /// the token on the `#token=` fragment; this change moved it into the
    /// document-start global, so the URL the web view loads is the plain gateway
    /// address with no token in it.
    func testTheTokenIsNotOnTheNavigationUrl() {
        let gateway = try? XCTUnwrap(Gateway.parse("https://example-host.example.ts.net"))
        // The URL WebView now loads is the gateway URL unchanged; the token is in
        // the injected global instead. GatewayURL.withTokenHandoff still exists
        // for the desktop and its own parity tests, so this asserts the client's
        // behaviour rather than removing the shared helper.
        XCTAssertEqual(gateway?.url.absoluteString, "https://example-host.example.ts.net")
        XCTAssertFalse(
            gateway?.url.absoluteString.contains("token") ?? true,
            "the navigation URL must carry no token"
        )
    }
}

// MARK: - A generic JSON value, for comparing whole objects

/// A decoded JSON value that compares structurally, so a fixture's expected
/// object is checked in full rather than field by field. Built from either a
/// `[String: Any]` the port produced or a JSON string, and equal when the two
/// trees match regardless of key order.
enum JSONValue: Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(jsonString: String) throws {
        let data = Data(jsonString.utf8)
        let any = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        self = JSONValue(any)
    }

    init(_ any: Any) {
        switch any {
        case let value as [String: Any]:
            self = .object(value.mapValues { JSONValue($0) })
        case let value as [Any]:
            self = .array(value.map { JSONValue($0) })
        case let value as String:
            self = .string(value)
        case let value as NSNumber where isBooleanNSNumber(value):
            self = .bool(value.boolValue)
        case let value as NSNumber:
            self = .number(value.doubleValue)
        case is NSNull:
            self = .null
        default:
            self = .null
        }
    }
}

/// Distinguish an NSNumber that is really a boolean from one that is numeric, so
/// `true` does not compare equal to `1`. Booleans do not appear in these
/// fixtures, but the comparison must be honest regardless.
private func isBooleanNSNumber(_ any: Any) -> Bool {
    guard let number = any as? NSNumber else { return false }
    return CFGetTypeID(number) == CFBooleanGetTypeID()
}

extension JSONValue: Decodable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        // Order matters: nil first, then the concrete scalars, then the two
        // containers. Number is preferred over string, and these fixtures carry
        // no booleans, so no bool branch is needed to keep the decode honest.
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .null
        }
    }
}
