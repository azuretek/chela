import XCTest

@testable import Claw

/// The guard that a runtime read needs, one entry per converted spec.
///
/// Reading a spec out of the bundle removes a copy, and it adds one new way to be
/// wrong: a decoder that does not name a key drops it in silence, so the client
/// knows less than the file says and nothing fails. Each entry is the set of
/// top-level keys its reader decodes, asserted equal to the keys the bundled file
/// carries in both directions, so a value added to the spec cannot be ignored.
///
/// A spec with no entry here still mirrors its values in Swift; it moves here in
/// the same commit that starts reading it, and `core/test/specs.test.js` is the
/// inventory that tracks the list from the other side.
final class BundledSpecTests: XCTestCase {
    private let readers: [String: Set<String>] = [
        "naming": Naming.decodedKeys,
        "progress": Progress.decodedKeys,
    ]

    func testEachReaderDecodesEveryKeyItsSpecCarries() throws {
        XCTAssertFalse(readers.isEmpty, "expected at least one converted spec")
        for (name, decoded) in readers {
            let carried = try BundledSpec.topLevelKeys(name)
            XCTAssertEqual(
                carried,
                decoded,
                "the bundled \(name).json and the client that reads it disagree about the keys, so a value the file carries is being dropped"
            )
        }
    }

    /// A spec that is not bundled is a mistake this test can catch from the app
    /// side rather than only from `core/test/specs.test.js`.
    func testEveryConvertedSpecIsActuallyBundled() throws {
        for name in readers.keys {
            XCTAssertNoThrow(
                try BundledSpec.topLevelKeys(name),
                "\(name).json is read at runtime but is not a resource in project.yml"
            )
        }
    }
}
