import Foundation

/// The repo's shared golden fixtures and specs, found rather than configured.
///
/// They live in `core/fixtures/` and `core/spec/` at the repo root, and the path
/// cannot be written down: an absolute path would pass on the machine that wrote
/// it and fail on every other checkout and in CI, and the failure would read as a
/// parity disagreement rather than as a missing file. So the repo root is found
/// by walking up from this file, whose own path is known at compile time and says
/// nothing about the working directory the test runner was launched in.
enum Fixtures {
    enum Failure: Error, CustomStringConvertible {
        case notFound(startingAt: String)
        case noSuchDirectory(String)

        var description: String {
            switch self {
            case .notFound(let path):
                return "no core/ directory above \(path): the parity tests need a repo checkout"
            case .noSuchDirectory(let name):
                return "the repo has no core/\(name) directory, so a parity test is reading nothing"
            }
        }
    }

    /// How far up to look. The repo root is two directories above `mobile/`, so
    /// this is slack for a deeper `ChelaTests` group, not a guess.
    private static let maxDepth = 8

    /// The directory holding `core/`, which is the repo root.
    static func root(from file: String = #filePath) throws -> URL {
        var candidate = URL(fileURLWithPath: file).deletingLastPathComponent()
        for _ in 0..<maxDepth {
            let core = candidate.appendingPathComponent("core", isDirectory: true)
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: core.path, isDirectory: &isDirectory), isDirectory.boolValue {
                return candidate
            }
            candidate.deleteLastPathComponent()
        }
        throw Failure.notFound(startingAt: file)
    }

    /// One of `core/`'s subdirectories, which is where the fixture and spec files
    /// live. A missing one throws rather than returning nothing, so a test cannot
    /// pass because it checked no cases.
    static func directory(_ name: String, from file: String = #filePath) throws -> URL {
        let directory = try root(from: file).appendingPathComponent("core").appendingPathComponent(name, isDirectory: true)
        guard FileManager.default.fileExists(atPath: directory.path) else {
            throw Failure.noSuchDirectory(name)
        }
        return directory
    }

    /// The golden fixtures, in `core/fixtures/`.
    static func fixtures(from file: String = #filePath) throws -> URL {
        try directory("fixtures", from: file)
    }

    /// The shared specs, in `core/spec/`. A spec is what a client mirrors as
    /// constants, and the parity test is what proves the mirror still matches it.
    static func spec(from file: String = #filePath) throws -> URL {
        try directory("spec", from: file)
    }

    /// Decode one fixture. A fixture that is present but unreadable throws here
    /// rather than returning nothing, so a broken read cannot turn into a test
    /// that passes because it checked no cases.
    static func load<T: Decodable>(
        _ name: String,
        as type: T.Type = T.self,
        from file: String = #filePath
    ) throws -> T {
        try decode(name, in: try fixtures(from: file))
    }

    /// Decode one spec, the same way.
    static func loadSpec<T: Decodable>(
        _ name: String,
        as type: T.Type = T.self,
        from file: String = #filePath
    ) throws -> T {
        try decode(name, in: try spec(from: file))
    }

    private static func decode<T: Decodable>(_ name: String, in directory: URL) throws -> T {
        let url = directory.appendingPathComponent("\(name).json")
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }
}
