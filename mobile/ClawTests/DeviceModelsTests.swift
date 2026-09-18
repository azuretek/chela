import XCTest

@testable import Claw

/// The device name, where the About sheet and the client-context block take it from
/// one table rather than two.
final class DeviceModelsTests: XCTestCase {
    /// The phone this was reported from, and the row a real device has proved: iOS
    /// itself reads "iPhone 16 Pro Max" for iPhone17,2 in Settings > General >
    /// About, which is the sheet the report compared ours against.
    func testTheReportedPhoneIsNamedRatherThanNumbered() {
        XCTAssertEqual(DeviceModels.marketingName(machine: "iPhone17,2"), "iPhone 16 Pro Max")
    }

    /// A phone newer than the table reports its identifier rather than a guess, and
    /// that is the intended answer rather than a gap: it is a fact about a model.
    func testAnUnknownIdentifierReportsItself() {
        XCTAssertEqual(DeviceModels.marketingName(machine: "iPhone99,9"), "iPhone99,9")
    }

    /// The composed form, which is what both readers actually show: the name and
    /// the identifier when the table has one, the identifier ALONE when it does
    /// not, so the fallback never says the same thing twice.
    func testTheIdentifierIsPrintedOnce() {
        XCTAssertEqual(DeviceModels.describe(machine: "iPhone17,2"), "iPhone 16 Pro Max (iPhone17,2)")
        XCTAssertEqual(DeviceModels.describe(machine: "iPhone99,9"), "iPhone99,9")
        XCTAssertEqual(DeviceModels.describe(machine: "  "), "iOS device")
    }

    /// A blank is not a model, so it says so rather than reading as a phone whose
    /// name the app failed to fetch.
    func testAnEmptyIdentifierIsNotAModel() {
        XCTAssertEqual(DeviceModels.marketingName(machine: "   "), "iOS device")
    }

    /// Every row has to be a real identifier with a real name: a stub or a doubled
    /// value here is a made-up model in the sheet a bug report is written from.
    func testEveryRowIsAnIdentifierAndAName() {
        XCTAssertFalse(DeviceModels.table.isEmpty)
        for (identifier, name) in DeviceModels.table {
            XCTAssertTrue(identifier.hasPrefix("iPhone"), identifier)
            let parts = identifier.split(separator: ",")
            XCTAssertEqual(parts.count, 2, identifier)
            XCTAssertNotNil(Int(parts[1]), identifier)
            XCTAssertFalse(name.isEmpty, identifier)
            XCTAssertFalse(name.contains("iPhone"), "a name repeats its own identifier: " + identifier)
        }
    }
}

