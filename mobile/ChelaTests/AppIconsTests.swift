import XCTest

@testable import Chela

/// The iOS half of the themed icon: the bundled spec is the repository's, and an
/// accent picks the same bucket the desktop's core/app-icons.js picks, checked
/// against the samples that module wrote into the spec.
final class AppIconsTests: XCTestCase {
    func testTheBundledSpecIsTheRepositorysByteForByte() throws {
        let bundled = try XCTUnwrap(Bundle.main.url(forResource: "app-icons", withExtension: "json"), "app-icons.json is not in the bundle")
        let repo = try Fixtures.root().appendingPathComponent("core/spec/app-icons.json")
        XCTAssertEqual(try Data(contentsOf: bundled), try Data(contentsOf: repo))
    }

    func testThereIsOnePrimaryBucketAndItHasNoAlternateName() throws {
        XCTAssertEqual(AppIcons.buckets.filter(\.primary).count, 1)
        XCTAssertNil(try XCTUnwrap(AppIcons.primary).alternateIconName)
    }

    func testHexReadsEveryFormTheAccentArrivesIn() {
        XCTAssertEqual(AppIcons.hex("rgb(90, 182, 216)"), "#5ab6d8")
        XCTAssertEqual(AppIcons.hex("rgba(90, 182, 216, 0.5)"), "#5ab6d8")
        XCTAssertEqual(AppIcons.hex("rgb(90 182 216)"), "#5ab6d8")
        XCTAssertEqual(AppIcons.hex("#5AB6D8"), "#5ab6d8")
        XCTAssertEqual(AppIcons.hex("#fff"), "#ffffff")
        XCTAssertNil(AppIcons.hex("oklch(0.7 0.1 350)"))
        XCTAssertNil(AppIcons.hex(nil))
    }

    func testEverySampleChoosesTheBucketTheDesktopChose() throws {
        let spec = try XCTUnwrap(AppIcons.spec)
        XCTAssertFalse(spec.samples.isEmpty)
        for sample in spec.samples {
            XCTAssertEqual(AppIcons.bucket(forAccent: sample.accent)?.id, sample.bucket, "\(sample.accent)")
        }
        XCTAssertEqual(AppIcons.bucket(forAccent: nil), AppIcons.primary)
    }

    func testEveryBucketIsAnAlternateIconInTheBuiltApp() {
        // actool lists every icon set under CFBundleAlternateIcons; a bucket missing
        // there could be offered and then refused.
        let icons = Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any]
        let alternates = (icons?["CFBundleAlternateIcons"] as? [String: Any]) ?? [:]
        for bucket in AppIcons.buckets where !bucket.primary {
            XCTAssertNotNil(alternates[bucket.alternateIconName ?? ""], "\(bucket.id) has no alternate icon in the built app")
        }
    }
}
