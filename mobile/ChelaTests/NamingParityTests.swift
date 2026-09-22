import XCTest

@testable import Claw

/// Parity with `core/spec/naming.json`, which is the ONE owner of the product
/// name and of each client's shorthand.
///
/// This is the mobile half of the contract. The desktop reads the same file at
/// runtime, so nothing has to agree by convention: if a name changes in the spec
/// and `Naming.swift` does not move with it, this fails, and if the spec and
/// `Info.plist` disagree, this fails too. The plist is the part a person
/// actually sees, and it is the part that cannot import anything.
///
/// The plist is read from the source tree rather than from the built bundle,
/// because the source is what drifts. A generated plist that disagreed with its
/// own source would be a second owner, and the tests would be reading the wrong
/// one.
final class NamingParityTests: XCTestCase {
    private struct NamingSpec: Decodable {
        struct Repo: Decodable {
            let owner: String
            let name: String
        }

        struct Client: Decodable {
            let shorthand: String
            let bundleId: String
        }

        struct Clients: Decodable {
            let desktop: Client
            let mobile: Client
        }

        let product: String
        let repo: Repo
        let clients: Clients
    }

    private func spec() throws -> NamingSpec {
        try Fixtures.loadSpec("naming")
    }

    func testTheProductNameMirrorsTheSpec() throws {
        XCTAssertEqual(
            Naming.product,
            try spec().product,
            "Naming.product disagrees with core/spec/naming.json; move both together"
        )
    }

    func testTheRepoSlugMirrorsTheSpec() throws {
        // The update feed URL is built from this, so a rename that moved the repo
        // in the spec without moving it here would point the phone's update
        // check at a feed that no longer exists.
        let repo = try spec().repo
        XCTAssertEqual(Naming.repoOwner, repo.owner, "Naming.repoOwner disagrees with core/spec/naming.json")
        XCTAssertEqual(Naming.repoName, repo.name, "Naming.repoName disagrees with core/spec/naming.json")
    }

    func testTheClientTokenMirrorsTheSpec() throws {
        XCTAssertEqual(
            Naming.mobileToken,
            try spec().clients.mobile.shorthand,
            "Naming.mobileToken disagrees with core/spec/naming.json"
        )
        // The two clients have to be tellable apart in one string, which is the
        // whole reason the shorthand exists rather than the product name.
        XCTAssertNotEqual(try spec().clients.desktop.shorthand, Naming.mobileToken)
    }

    /// The two keys a home screen, TestFlight and the App Store read.
    func testThePlistNamesMirrorTheSpec() throws {
        let plist = try Fixtures.root()
            .appendingPathComponent("mobile/Chela/Info.plist")
        let data = try Data(contentsOf: plist)
        let raw = try PropertyListSerialization.propertyList(from: data, format: nil)
        guard let entries = raw as? [String: Any] else {
            return XCTFail("mobile/Chela/Info.plist is not a dictionary")
        }

        let expected = try spec().product
        XCTAssertEqual(entries["CFBundleDisplayName"] as? String, expected)
        XCTAssertEqual(entries["CFBundleName"] as? String, expected)
    }

    /// The bundle id is identity rather than naming: it does not follow the
    /// product name, and a rename that moved it would orphan the App Store
    /// Connect record and every install that updates in place.
    func testTheBundleIdComesFromTheSpecAndIsNotTheProductName() throws {
        let expected = try spec().clients.mobile.bundleId
        XCTAssertEqual(Bundle.main.bundleIdentifier, expected)
        XCTAssertNotEqual(expected, try spec().product)
    }

    /// How this client names itself where the desktop's own label is built the
    /// same way from the same two values (`clientLabel` in `core/naming.js`).
    /// The prompt block carries this string, so a rename that moved the product
    /// name without moving it would misname the client to the agent.
    func testTheClientLabelIsTheProductAndTheShorthand() throws {
        let spec = try spec()
        XCTAssertEqual(Naming.clientLabel, "\(spec.product) (\(spec.clients.mobile.shorthand))")
        XCTAssertTrue(Naming.clientLabel.hasSuffix("(chela-mobile)"))
    }

    /// The app's own version, which is the plist the release workflow stamps
    /// rather than a second place to keep the number in step.
    func testTheBuildVersionComesFromTheBundle() throws {
        let plist = try Fixtures.root().appendingPathComponent("mobile/Chela/Info.plist")
        let data = try Data(contentsOf: plist)
        let raw = try PropertyListSerialization.propertyList(from: data, format: nil)
        let entries = try XCTUnwrap(raw as? [String: Any], "mobile/Chela/Info.plist is not a dictionary")

        // The source plist names the build setting rather than a literal, so the
        // built bundle is the only place a value exists.
        XCTAssertEqual(entries["ChelaBuildVersion"] as? String, "$(CLAW_BUILD_VERSION)")
        let stamped = Bundle.main.object(forInfoDictionaryKey: "ChelaBuildVersion") as? String
        XCTAssertFalse(Naming.buildVersion.isEmpty)
        XCTAssertNotEqual(Naming.buildVersion, "0", "the build was not stamped with a version")
        XCTAssertEqual(Naming.buildVersion, stamped ?? "", "the reader and the bundle disagree")
    }
}
