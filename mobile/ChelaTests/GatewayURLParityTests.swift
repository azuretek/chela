import Foundation
import XCTest

@testable import Chela

/// The token handoff, against the golden cases both clients share.
///
/// `core/fixtures/gateway-url.json` is input and output pairs for the address a
/// stored credential is handed over on, `core/test/fixtures.test.js` asserts the JS
/// reproduces them, and this asserts the Swift does. A client that handed a token
/// over differently would be a client whose stored credential silently did not
/// work, which reads as a wrong token rather than as a wrong address.
final class GatewayURLParityTests: XCTestCase {
    private struct Fixture: Decodable {
        let cases: [Case]
    }

    private struct Case: Decodable {
        let name: String
        let url: String
        let token: String?
        let output: String
    }

    func testWithTokenHandoffReproducesEveryFixture() throws {
        let fixture = try Fixtures.load("gateway-url", as: Fixture.self)
        XCTAssertFalse(fixture.cases.isEmpty, "expected gateway-url fixtures")
        var compared = 0
        var unrepresentable = 0

        for testCase in fixture.cases {
            guard let url = URL(string: testCase.url), url.scheme != nil, url.host != nil else {
                // The one case a Swift port cannot compare, and it is a difference in
                // how the address is WRITTEN rather than in what the port does. The
                // JS hands an address that will not parse back as the raw text it
                // was given; this client never holds one, because `Gateway.parse`
                // refuses it, and the `URL` Swift builds from that same text
                // normalises the space to %20. So the port's own guard for it (no
                // scheme and host, which is what `new URL` throws on) is covered by
                // the test below instead, and this case is COUNTED rather than
                // dropped: a fixture that lost its parseable cases would otherwise
                // read as a pass.
                unrepresentable += 1
                continue
            }
            compared += 1
            XCTAssertEqual(
                GatewayURL.withTokenHandoff(url, testCase.token).absoluteString,
                testCase.output,
                "\(testCase.name): the handoff disagrees"
            )
        }

        XCTAssertEqual(unrepresentable, 1, "expected exactly one fixture case that cannot be represented as a URL")
        XCTAssertGreaterThanOrEqual(compared, 6, "only \(compared) cases were actually compared")
    }

    func testAnAddressWithNoSchemeAndHostIsHandedBackUntouched() {
        // The rule above, on its own rather than through the fixture: this is what
        // `new URL(...)` throwing means in a typed world, and it is what keeps an
        // address that cannot be parsed from gaining a fragment here and not there.
        let relative = URL(string: "//example-host.example.ts.net")!
        XCTAssertEqual(GatewayURL.withTokenHandoff(relative, "abc123").absoluteString, relative.absoluteString)
    }

    func testAnEmptyTokenLeavesAnAddressThatAlreadyHasAFragmentAlone() {
        // The case a port gets wrong by treating "no token" as "set the key to
        // nothing", which would rewrite the address rather than skip it.
        let url = URL(string: "https://example-host.example.ts.net/#tab=chat")!
        XCTAssertEqual(GatewayURL.withTokenHandoff(url, "").absoluteString, "https://example-host.example.ts.net/#tab=chat")
        XCTAssertEqual(GatewayURL.withTokenHandoff(url, nil).absoluteString, "https://example-host.example.ts.net/#tab=chat")
    }

    // MARK: - The bootstrap (setup-code) handoff

    // The setup-code credential rides the SAME fragment mechanism as the token,
    // but under a DIFFERENT key: the Control UI reads `bootstrapToken` from the
    // fragment and exchanges it in the pairing handshake, where `token` is the
    // shared connect secret. Mixing them up is exactly the bug this handoff fixes
    // (a setup code fed as `token` is refused "This Gateway expects its token"),
    // so these pin that the two keys stay distinct and never clobber each other.

    func testBootstrapTokenLandsOnTheFragmentUnderItsOwnKey() {
        let url = URL(string: "https://example-host.example.ts.net/")!
        let out = GatewayURL.withBootstrapHandoff(url, "setup123")
        XCTAssertEqual(out.absoluteString, "https://example-host.example.ts.net/#bootstrapToken=setup123")
        XCTAssertNil(URLComponents(url: out, resolvingAgainstBaseURL: false)?.query,
                     "a bootstrap token must not reach the query string")
    }

    func testAnEmptyBootstrapTokenLeavesTheAddressAlone() {
        let url = URL(string: "https://example-host.example.ts.net/#tab=chat")!
        XCTAssertEqual(GatewayURL.withBootstrapHandoff(url, "").absoluteString, "https://example-host.example.ts.net/#tab=chat")
        XCTAssertEqual(GatewayURL.withBootstrapHandoff(url, nil).absoluteString, "https://example-host.example.ts.net/#tab=chat")
    }

    func testAnExistingFragmentIsPreservedAndOnlyBootstrapTokenIsSet() {
        let url = URL(string: "https://example-host.example.ts.net/#tab=chat")!
        XCTAssertEqual(
            GatewayURL.withBootstrapHandoff(url, "boot").absoluteString,
            "https://example-host.example.ts.net/#tab=chat&bootstrapToken=boot"
        )
    }

    func testTokenAndBootstrapHandoffsCoexistWithoutClobbering() {
        let url = URL(string: "https://example-host.example.ts.net/")!
        let withToken = GatewayURL.withTokenHandoff(url, "shared")
        let both = GatewayURL.withBootstrapHandoff(withToken, "setup")
        let frag = URLComponents(url: both, resolvingAgainstBaseURL: false)?.fragment ?? ""
        XCTAssertTrue(frag.contains("token=shared"), "the shared token must survive")
        XCTAssertTrue(frag.contains("bootstrapToken=setup"), "the bootstrap token must be added beside it")
    }

    func testAnAddressWithNoSchemeAndHostIsHandedBackByTheBootstrapHandoff() {
        let relative = URL(string: "//example-host.example.ts.net")!
        XCTAssertEqual(GatewayURL.withBootstrapHandoff(relative, "boot").absoluteString, relative.absoluteString)
    }
}
