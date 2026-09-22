import Foundation
import XCTest

@testable import Chela

/// The gateway config model, against the golden cases both clients share.
///
/// `core/fixtures/config-model.json` is input and output pairs generated for the
/// model, `core/test/fixtures.test.js` asserts the JS reproduces them, and this
/// asserts the Swift does too. That is what turns "the phone and the desktop agree
/// about the gateway list" into something checked: a port that produced a different
/// list, or left a pointer on a gateway that is gone, fails here rather than on a
/// device.
///
/// The fixture is found by walking up from this file's own path, never from a
/// configured or absolute path, so a checkout that moved still runs the same cases
/// and a missing fixture fails rather than silently checking nothing.
final class ConfigModelParityTests: XCTestCase {
    // MARK: The fixture's shape

    private struct Fixture: Decodable {
        let blank: [BlankCase]
        let cases: [OpCase]
    }

    private struct Suggested: Decodable {
        let label: String
        let url: String
    }

    private struct BlankCase: Decodable {
        let name: String
        let suggested: [Suggested]
        let ids: [String]
        let expect: Expectation
        let flags: [String: Bool]
        /// Keys the spec's own blank() must NOT materialise here: a phone has no
        /// window bounds and no global shortcut, and a config that carried them
        /// would be holding values nothing could use.
        let absent: [String]
    }

    private struct Seed: Decodable {
        let gateways: [Gateway]
        let activeGatewayId: String?
        let trustedCerts: [String: String]?
    }

    private struct Expectation: Decodable {
        let gateways: [Gateway]
        let activeGatewayId: String?
        let trustedCerts: [String: String]?
    }

    private struct Patch: Decodable {
        let label: String?
        let url: String?
    }

    private struct Op: Decodable {
        let op: String
        let id: String?
        let label: String?
        let url: String?
        let patch: Patch?
        let host: String?
        let fingerprint: String?
    }

    private struct OpCase: Decodable {
        let name: String
        let seed: Seed
        let ops: [Op]
        let expect: Expectation
    }

    private func fixture() throws -> Fixture {
        try Fixtures.load("config-model", as: Fixture.self)
    }

    // MARK: blank()

    func testBlankReproducesEveryFixture() throws {
        let cases = try fixture().blank
        XCTAssertFalse(cases.isEmpty, "expected config-model blank fixtures")

        for fixture in cases {
            var index = 0
            let config = Config.blank(suggested: fixture.suggested.map { ($0.label, $0.url) }) {
                defer { index += 1 }
                return fixture.ids[index]
            }

            XCTAssertEqual(config.gateways, fixture.expect.gateways, "\(fixture.name): the fresh gateways disagree")
            XCTAssertNil(config.activeGatewayId, "\(fixture.name): a fresh config has nothing active")
            XCTAssertEqual(config.trustedCerts, fixture.expect.trustedCerts ?? [:], "\(fixture.name): the pins disagree")

            for (key, value) in fixture.flags {
                switch key {
                case "promptMetadata": XCTAssertEqual(config.promptMetadata, value, "\(fixture.name): promptMetadata disagrees")
                case "autoUpdate": XCTAssertEqual(config.autoUpdate, value, "\(fixture.name): autoUpdate disagrees")
                default: XCTFail("\(fixture.name): the fixture checks \(key), which this port does not model")
                }
            }

            // Absence, not emptiness, and asserted from the encoded form because
            // that is what gets stored: a field added to this struct would show up
            // here as a key the fixture says should not be there.
            let encoded = try JSONEncoder().encode(config)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
            for key in fixture.absent {
                XCTAssertNil(object[key], "\(fixture.name): \(key) should not be in a config that was not given one")
            }
        }
    }

    // MARK: The CRUD

    func testTheModelReproducesEveryFixture() throws {
        let cases = try fixture().cases
        XCTAssertFalse(cases.isEmpty, "expected config-model fixtures")

        for fixture in cases {
            var config = Config(
                gateways: fixture.seed.gateways,
                activeGatewayId: fixture.seed.activeGatewayId,
                trustedCerts: fixture.seed.trustedCerts ?? [:],
                promptMetadata: false,
                autoUpdate: true
            )
            for op in fixture.ops {
                config = try apply(op, to: config, in: fixture.name)
            }

            XCTAssertEqual(config.gateways, fixture.expect.gateways, "\(fixture.name): the gateways disagree")
            XCTAssertEqual(config.activeGatewayId, fixture.expect.activeGatewayId, "\(fixture.name): the active pointer disagrees")
            XCTAssertEqual(config.trustedCerts, fixture.expect.trustedCerts ?? [:], "\(fixture.name): the pins disagree")

            // The pointer and the lookup that reads it agree at the end of every
            // case: a pointer naming nothing is the state these rules exist to
            // prevent, and checking only the field would not notice one.
            if config.activeGatewayId == nil {
                XCTAssertNil(ConfigModel.active(config), "\(fixture.name): found an active gateway with no pointer")
            } else {
                XCTAssertEqual(ConfigModel.active(config)?.id, config.activeGatewayId, "\(fixture.name): the pointer names nothing")
            }
        }
    }

    /// One op, exactly as `core/test/fixtures.test.js` applies it.
    private func apply(_ op: Op, to config: Config, in name: String) throws -> Config {
        switch op.op {
        case "add":
            let url = try XCTUnwrap(URL(string: op.url ?? ""), "\(name): an add op carries an address")
            return ConfigModel.add(config, label: op.label ?? "", url: url, id: op.id ?? "").config
        case "update":
            let url = op.patch?.url.flatMap { URL(string: $0) }
            return ConfigModel.update(config, id: op.id ?? "", label: op.patch?.label, url: url)
        case "remove":
            return ConfigModel.remove(config, id: op.id ?? "")
        case "active":
            var next = config
            next.activeGatewayId = op.id
            return next
        case "trustCert":
            return ConfigModel.trustCert(config, host: op.host ?? "", fingerprint: op.fingerprint ?? "")
        default:
            throw XCTSkip("\(name): unknown op in the fixture: \(op.op)")
        }
    }
}
