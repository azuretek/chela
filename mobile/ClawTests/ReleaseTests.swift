import XCTest

@testable import Claw

/// What the phone installs from, pinned against the repository's copy of the spec.
///
/// The install URL is the one place a wrong string stays invisible: a missing
/// asset name or a wrong tag builds a URL that 404s inside iOS's own installer,
/// where nothing is logged and nothing is shown to the person tapping it. So the
/// shape is asserted here, against `core/spec/release.json`, the same way the
/// other parity tests work.
final class ReleaseTests: XCTestCase {
    private struct ReleaseSpec: Decodable {
        struct Ota: Decodable {
            let urlScheme: String
            let appAsset: String
            let manifestAsset: String
        }

        let tagPrefix: String
        let ota: Ota
    }

    private let version = "1.0.1-dev.7.abc1234567"

    private func spec() throws -> ReleaseSpec {
        try Fixtures.loadSpec("release")
    }

    func testTheTagIsTheSpecsPrefixPlusTheVersion() throws {
        XCTAssertEqual(Release.tag(version), try spec().tagPrefix + version)
    }

    func testTheAssetNamesComeFromTheSpecWithTheVersionSubstituted() throws {
        let expected = try spec().ota.manifestAsset.replacingOccurrences(of: "{version}", with: version)
        XCTAssertEqual(Release.manifestAsset(version), expected)
        XCTAssertFalse(Release.manifestAsset(version).contains("{version}"), "the placeholder has to be substituted")
        XCTAssertEqual(
            Release.appAsset(version),
            try spec().ota.appAsset.replacingOccurrences(of: "{version}", with: version)
        )
    }

    /// A name with no placeholder would make every release offer the same file,
    /// which is the failure this test exists to make impossible to ship.
    func testBothAssetNamesCarryTheVersion() throws {
        let s = try spec()
        XCTAssertTrue(s.ota.manifestAsset.contains("{version}"), "the manifest name has to be versioned")
        XCTAssertTrue(s.ota.appAsset.contains("{version}"), "the app name has to be versioned")
    }

    func testTheInstallUrlIsThisVersionsManifestOverTheOtaScheme() throws {
        let s = try spec()
        let url = Release.installUrl(version)
        XCTAssertTrue(url.hasPrefix("itms-services://"), "iOS only installs through the system OTA scheme")
        XCTAssertTrue(url.hasPrefix(s.ota.urlScheme), "and the scheme and parameter come from the spec")
        XCTAssertTrue(url.hasSuffix(Release.manifestAsset(version)), "the manifest is what the installer reads")
        XCTAssertTrue(
            url.contains("/releases/download/" + Release.tag(version) + "/"),
            "the manifest is the one on this version's release, not another"
        )
    }

    func testTheAppAndTheManifestAreOnTheSameRelease() throws {
        let app = Release.assetUrl(version, asset: Release.appAsset(version))
        let manifest = Release.assetUrl(version, asset: Release.manifestAsset(version))
        let releasePrefix = app.split(separator: "/").dropLast().joined(separator: "/")
        XCTAssertTrue(manifest.hasPrefix(releasePrefix), "one release carries both, or the install cannot work")
        XCTAssertNotEqual(app, manifest)
    }
}
