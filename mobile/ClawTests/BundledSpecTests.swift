import XCTest

@testable import Claw

/// The guard a runtime read needs, one entry per converted spec.
///
/// Reading a spec out of the bundle removes a copy, and it adds one way to be
/// wrong: a decoder that does not name a key drops it in silence, so the client
/// knows less than the file says and nothing fails. Each entry here declares the
/// keys its reader decodes and the keys it deliberately leaves alone, and the two
/// together must account for every key the file carries.
///
/// A spec with no entry still mirrors its values in Swift; it moves here in the
/// same commit that starts reading it, and `core/test/specs.test.js` is the
/// inventory that tracks the list from the other side.
@MainActor
final class BundledSpecTests: XCTestCase {
    /// Keys every spec carries for a reader rather than for a machine, so no
    /// client has to name them.
    private static let documentationKeys: Set<String> = ["description", "why"]

    private struct Reader {
        let name: String
        let decoded: Set<String>
        let ignored: Set<String>
    }

    private let readers: [Reader] = [
        Reader(name: "naming", decoded: Naming.decodedKeys, ignored: Naming.ignoredKeys),
        Reader(name: "progress", decoded: Progress.decodedKeys, ignored: Progress.ignoredKeys),
        Reader(name: "feed", decoded: UpdateFeed.decodedKeys, ignored: UpdateFeed.ignoredKeys),
        Reader(name: "notices", decoded: NoticeTone.decodedKeys, ignored: NoticeTone.ignoredKeys),
        Reader(name: "updates", decoded: UpdatePolicy.decodedKeys, ignored: UpdatePolicy.ignoredKeys),
        Reader(name: "connection", decoded: ConnectionState.decodedKeys, ignored: ConnectionState.ignoredKeys),
        Reader(name: "release", decoded: Release.decodedKeys, ignored: Release.ignoredKeys),
        Reader(name: "tokens", decoded: NoticeTokens.decodedKeys, ignored: NoticeTokens.ignoredKeys),
    ]

    func testEachReaderAccountsForEveryKeyItsSpecCarries() throws {
        XCTAssertFalse(readers.isEmpty, "expected at least one converted spec")
        for reader in readers {
            XCTAssertFalse(reader.decoded.isEmpty, "\(reader.name): a reader that decodes nothing is not reading the spec")
            XCTAssertTrue(
                reader.decoded.isDisjoint(with: reader.ignored),
                "\(reader.name): a key cannot be both decoded and ignored"
            )
            let carried = try BundledSpec.topLevelKeys(reader.name)
                .subtracting(Self.documentationKeys)
            XCTAssertEqual(
                carried,
                reader.decoded.union(reader.ignored),
                "the bundled \(reader.name).json carries a key this client neither decodes nor declares as ignored, so a value the file holds is being dropped in silence"
            )
        }
    }

    func testEveryConvertedSpecIsActuallyBundled() throws {
        for reader in readers {
            XCTAssertNoThrow(
                try BundledSpec.topLevelKeys(reader.name),
                "\(reader.name).json is read at runtime but is not a resource in project.yml"
            )
        }
    }
}
