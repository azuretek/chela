import Foundation

/// Reading a spec out of the app's own bundle.
///
/// One pattern for every spec this app shares with the desktop: the file is
/// copied in by `project.yml` and read here at runtime, so the app carries the
/// one owner rather than a copy of it. The desktop reads the same file through
/// `core/`, which is why neither interface re-declares a value and neither can
/// drift from the other.
///
/// Why this rather than mirrored constants: a mirror is a second copy, kept in
/// step by a parity test. That is tolerable for a name or a number, because two
/// copies of a value can be compared, but it is wrong for a file that holds a
/// program, and it is unnecessary for everything else, because the app can carry
/// the file itself. One pattern for all of them means one loader, one failure
/// mode, and one thing to understand.
///
/// A missing resource is not silence. `core/test/specs.test.js` asserts that
/// every spec this app reads is a resource in `project.yml`, in the same commit
/// that starts reading it, so a spec that stopped being bundled fails a build
/// rather than leaving a client that quietly knows less.
enum BundledSpec {
    /// Decode one spec by resource name, without the extension.
    ///
    /// Throws rather than returning a default, so a caller cannot proceed on
    /// invented values by accident. Each reader decides what its own empty case
    /// is, in one place, and the parity tests turn the empty case into a failing
    /// build.
    static func load<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
        let data = try contents(name)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw SpecError.unreadable(name, underlying: error)
        }
    }

    /// The spec's own top-level keys.
    ///
    /// This is what makes a runtime read safe to rely on: a decoder that does not
    /// name a key drops it in silence, so the client would know less than the file
    /// says and nothing would fail. Each reader declares the keys it decodes and
    /// `BundledSpecTests` asserts the two sets are equal, in both directions.
    static func topLevelKeys(_ name: String) throws -> Set<String> {
        let data = try contents(name)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SpecError.notAnObject(name)
        }
        return Set(object.keys)
    }

    private static func contents(_ name: String) throws -> Data {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json") else {
            throw SpecError.missing(name)
        }
        return try Data(contentsOf: url)
    }

    enum SpecError: Error, CustomStringConvertible {
        case missing(String)
        case unreadable(String, underlying: Error)
        case notAnObject(String)

        var description: String {
            switch self {
            case .missing(let name):
                return "no bundled spec named \(name).json: project.yml has to copy it in"
            case .unreadable(let name, let underlying):
                return "the bundled \(name).json could not be decoded: \(underlying)"
            case .notAnObject(let name):
                return "the bundled \(name).json is not a JSON object"
            }
        }
    }
}
