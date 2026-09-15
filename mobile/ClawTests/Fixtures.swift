import Foundation

/// The repo's shared golden fixtures, found rather than configured.
///
/// They live in `core/fixtures/` at the repo root, and the path cannot be
/// written down: an absolute path would pass on the machine that wrote it and
/// fail on every other checkout and in CI, and the failure would read as a
/// parity disagreement rather than as a missing file. So the directory is found
/// by walking up from this file, whose own path is known at compile time and
/// says nothing about the working directory the test runner was launched in.
enum Fixtures {
    enum Failure: Error, CustomStringConvertible {
        case notFound(startingAt: String)

        var description: String {
            switch self {
            case .notFound(let path):
                return "no core/fixtures directory above \(path): the parity tests need a repo checkout"
            }
        }
    }

    /// How far up to look. The repo root is two directories above `mobile/`, so
    /// this is slack for a deeper `ClawTests` group, not a guess.
    private static let maxDepth = 8

    static func directory(from file: String = #filePath) throws -> URL {
        var candidate = URL(fileURLWithPath: file).deletingLastPathComponent()
        for _ in 0..<maxDepth {
            let fixtures = candidate.appendingPathComponent("core/fixtures", isDirectory: true)
            if FileManager.default.fileExists(atPath: fixtures.path) { return fixtures }
            candidate.deleteLastPathComponent()
        }
        throw Failure.notFound(startingAt: file)
    }

    /// Decode one fixture. A fixture that is present but unreadable throws here
    /// rather than returning nothing, so a broken read cannot turn into a test
    /// that passes because it checked no cases.
    static func load<T: Decodable>(
        _ name: String,
        as type: T.Type = T.self,
        from file: String = #filePath
    ) throws -> T {
        let url = try directory(from: file).appendingPathComponent("\(name).json")
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }
}
