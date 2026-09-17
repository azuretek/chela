import XCTest

@testable import Claw

/// Parity with `core/spec/gateway-identity.json` and
/// `core/fixtures/gateway-identity.json`, the ONE owner of what identifies an
/// OpenClaw payload.
///
/// The same shape as `NativeControlAuthParityTests`, and for the same reason: the
/// SIGNALS are the spec's and this client has no Swift copy of them, only a port
/// of the rule that reads them. What is asserted here is that the port reaches the
/// same verdict the JavaScript does on the same inputs, fixture for fixture, so
/// "is this an OpenClaw gateway" is one answer rather than one per platform.
///
/// Both directions are covered, because a check that only rejects is as broken as
/// one that accepts everything and the second is what this replaces: `Test
/// connection` used to accept any 200.
final class GatewayIdentityParityTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Response: Decodable {
            let status: Int?
            let contentType: String?
            let body: String?
        }

        struct Observed: Decodable {
            let document: Response?
            let health: Response?
            let headers: [String: String]?
            let error: String?
        }

        struct Output: Decodable {
            let ok: Bool
            let strength: String?
        }

        let name: String
        let why: String
        let observed: Observed
        let output: Output
    }

    private struct FixtureFile: Decodable {
        let cases: [Fixture]
    }

    private func repoFixture() throws -> FixtureFile {
        try Fixtures.load("gateway-identity")
    }

    private func observed(_ fixture: Fixture) -> GatewayIdentity.Observed {
        func response(_ value: Fixture.Response?) -> GatewayIdentity.Observed.Response? {
            guard let value else { return nil }
            var headers: [String: String] = [:]
            for (name, header) in (fixture.observed.headers ?? [:]) { headers[name.lowercased()] = header }
            return GatewayIdentity.Observed.Response(
                status: value.status,
                contentType: value.contentType,
                body: value.body,
                headers: headers
            )
        }
        return GatewayIdentity.Observed(
            document: response(fixture.observed.document),
            health: response(fixture.observed.health),
            error: fixture.observed.error
        )
    }

    // MARK: - The rule, on the same inputs the JavaScript is run against

    func testThePortReachesTheSameVerdictOnEveryFixture() throws {
        let file = try repoFixture()
        XCTAssertGreaterThanOrEqual(file.cases.count, 10, "too few fixtures to prove a rule")

        for fixture in file.cases {
            let verdict = GatewayIdentity.identify(observed(fixture))
            XCTAssertEqual(verdict.ok, fixture.output.ok, "\(fixture.name): ok disagrees: \(verdict.message)")
            XCTAssertEqual(
                verdict.strength?.rawValue,
                fixture.output.strength,
                "\(fixture.name): strength disagrees"
            )
        }
    }

    func testTheFixturesCoverBothDirectionsAndBothStrengths() throws {
        let file = try repoFixture()
        let outcomes = Set(file.cases.map(\.output.ok))
        XCTAssertTrue(outcomes.contains(true), "no fixture is accepted")
        XCTAssertTrue(outcomes.contains(false), "no fixture is rejected")
        let strengths = Set(file.cases.compactMap(\.output.strength))
        XCTAssertTrue(strengths.contains("payload"), "the required signal is not covered")
        XCTAssertTrue(strengths.contains("corroborated"), "the weaker path is not covered")
        for fixture in file.cases {
            XCTAssertGreaterThan(fixture.why.count, 40, "\(fixture.name) says nothing about why it is a case")
        }
    }

    // MARK: - The cases we rely on

    func testAThrowawayGatewayIsAccepted() throws {
        // A case we rely on for testing, asserted on its own rather than left
        // inside the loop: a rule that quietly started requiring a credential or a
        // configured gateway would break the testing lane, and the breakage would
        // read as a gateway problem.
        let file = try repoFixture()
        guard let fixture = file.cases.first(where: { $0.name.contains("throwaway") }) else {
            return XCTFail("the fixture set no longer covers the throwaway gateway")
        }
        XCTAssertTrue(GatewayIdentity.identify(observed(fixture)).ok)
    }

    func testAGatewayBehindAnUnusualHostIsAccepted() throws {
        let file = try repoFixture()
        guard let fixture = file.cases.first(where: { $0.name.contains("base path") }) else {
            return XCTFail("the fixture set no longer covers a gateway behind an unusual host")
        }
        XCTAssertTrue(GatewayIdentity.identify(observed(fixture)).ok)
    }

    // MARK: - The spec is the owner, and the bundle carries it

    func testTheBundledSpecIsTheRepositorys() throws {
        let repo = try Data(contentsOf: try Fixtures.spec().appendingPathComponent("gateway-identity.json"))
        let bundled = try XCTUnwrap(
            Bundle.main.url(forResource: "gateway-identity", withExtension: "json"),
            "the app did not bundle core/spec/gateway-identity.json, so it cannot identify a gateway"
        )
        XCTAssertEqual(try Data(contentsOf: bundled), repo, "the bundled spec has diverged from the repo's")
    }

    func testTheSignalsComeFromTheSpecRatherThanConstantsHere() throws {
        struct Spec: Decodable {
            let payloadAttributes: [String]
            let healthPath: String
            let headerNames: [String]
            let maxBytes: Int
        }
        let spec = try Fixtures.loadSpec("gateway-identity", as: Spec.self)
        XCTAssertEqual(GatewayIdentity.payloadAttributes, spec.payloadAttributes)
        XCTAssertEqual(GatewayIdentity.healthPath, spec.healthPath)
        XCTAssertEqual(GatewayIdentity.headerNames, spec.headerNames)
        XCTAssertEqual(GatewayIdentity.maxBytes, spec.maxBytes)
        XCTAssertFalse(spec.payloadAttributes.isEmpty, "no payload marker is recorded")
        XCTAssertTrue(
            spec.payloadAttributes.contains { $0.contains("openclaw") },
            "the required signal is not a product marker, so a stranger could carry it"
        )
    }

    func testTheMarkerIsAnAttributeSoProseCannotClaimIt() {
        // The distinction that makes the required signal worth requiring: a page
        // can say anything at all, and a page that says "OpenClaw" is not a
        // gateway.
        XCTAssertFalse(GatewayIdentity.carriesPayloadMarker("<h1>OpenClaw Control UI</h1>"))
        XCTAssertTrue(GatewayIdentity.carriesPayloadMarker(#"<html data-openclaw-control-ui-build-id="x">"#))
        XCTAssertTrue(GatewayIdentity.carriesPayloadMarker(#"<html data-openclaw-control-ui-base-path="">"#))
        // A dev build's unsubstituted placeholder is still the shell: presence is
        // read, never a version.
        XCTAssertTrue(GatewayIdentity.carriesPayloadMarker(#"<html data-openclaw-control-ui-build-id="__OPENCLAW_CONTROL_UI_BUILD_ID__">"#))
        XCTAssertFalse(GatewayIdentity.carriesPayloadMarker(nil))
        XCTAssertFalse(GatewayIdentity.carriesPayloadMarker(""))
    }

    func testTheProbeAsksTheConfiguredAddressAndItsHealthMarker() {
        let targets = GatewayIdentity.probeTargets("https://example-host:18789/")
        XCTAssertEqual(targets.document?.absoluteString, "https://example-host:18789/")
        XCTAssertTrue(targets.health.contains { $0.absoluteString == "https://example-host:18789/healthz" })

        // Behind a base path, the marker is asked for both ways: at the origin
        // root and under the mount, because the client cannot know which.
        let behindBase = GatewayIdentity.probeTargets("https://example-host/example-path/")
        XCTAssertEqual(behindBase.document?.absoluteString, "https://example-host/example-path/")
        XCTAssertTrue(behindBase.health.contains { $0.absoluteString == "https://example-host/healthz" })
        XCTAssertTrue(behindBase.health.contains { $0.absoluteString == "https://example-host/example-path/healthz" })

        // An address that will not parse asks nothing rather than throwing.
        XCTAssertNil(GatewayIdentity.probeTargets("not a url").document)
    }

    func testARejectionSaysWhatWasSeenAndThatNothingWasLoaded() {
        // The reader-facing half: a silent refusal would be indistinguishable from
        // a gateway that is merely down.
        let verdict = GatewayIdentity.identify(
            GatewayIdentity.Observed(
                document: .init(status: 200, contentType: "text/html", body: "<html><body>hello</body></html>"),
                health: nil,
                error: nil
            )
        )
        XCTAssertFalse(verdict.ok)
        XCTAssertTrue(verdict.message.contains("not an OpenClaw gateway"), verdict.message)
        XCTAssertTrue(verdict.message.contains("200"), "the reader is not told what answered")
        XCTAssertTrue(verdict.message.lowercased().contains("nothing was loaded"), verdict.message)
    }

    func testTheWeakerAcceptanceWordsItselfDifferently() {
        // The corroborated path needs all three header names as well as the health
        // marker: they are claimable, so none of them is allowed to carry the
        // decision on its own.
        let headers = [
            "x-frame-options": "DENY",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'self'",
        ]
        let weak = GatewayIdentity.identify(
            GatewayIdentity.Observed(
                document: .init(status: 401, contentType: "text/html", body: "<html><body>Sign in</body></html>", headers: headers),
                health: .init(status: 200, contentType: "application/json", body: #"{"ok":true,"status":"live"}"#),
                error: nil
            )
        )
        XCTAssertEqual(weak.strength, .corroborated)
        let strong = GatewayIdentity.identify(
            GatewayIdentity.Observed(
                document: .init(status: 200, contentType: "text/html", body: #"<html data-openclaw-control-ui-build-id="x">"#),
                health: nil,
                error: nil
            )
        )
        XCTAssertEqual(strong.strength, .payload)
        XCTAssertNotEqual(weak.message, strong.message,
                          "both accepted paths word themselves identically, so the weaker one is not surfaced")
    }
}
