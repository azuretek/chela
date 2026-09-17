import Foundation

/// Comparing two version strings, ported from `core/version.js`.
///
/// TWO comparisons, answering different questions, exactly as the JS holds both
/// (see `compare()`, `release()` and `compareRelease()` there):
///
///   `compare`        semver precedence, tail and all. What a version IS, and
///                     NOT what decides an update.
///   `compareRelease` the release only, tail ignored. THE ONE AN UPDATE CHECK
///                     USES, because the tail's basis changes and ranking it
///                     inverted, freezing the check.
///
/// `isNewer()` is `compare() > 0` and `isNewerRelease()` is
/// `compareRelease() > 0`, kept for the same reason the JS keeps them: a call
/// site reads better than a comparison against zero.
///
/// This exists because the phone's update check has to ask the one question the
/// desktop's updater already answers: is the feed's newest build newer than the
/// build I am. The desktop delegates that to `semver`; iOS has no `semver`, so
/// the same rule is ported here rather than reinvented, and it is proven against
/// the exact golden fixture the JS side asserts (`core/fixtures/version.json`,
/// via `desktop/test/version.test.js`,
/// reproduced by `VersionParityTests`). One rule, two ports, one fixture: that is
/// what stops the two clients disagreeing about what a release means.
///
/// Semver Section 11 is the whole of it, and the two halves easy to get wrong are
/// the ones the dev-version scheme leans on:
///
///   - The numeric fields compare as NUMBERS. `1.0.10` is above `1.0.9`, which a
///     string compare gets backwards.
///   - A prerelease has LOWER precedence than its release: `1.0.1-dev.5` is below
///     `1.0.1`. That is what keeps a dev build sorting under the release it heads
///     towards, and a stable build never being offered a dev one.
///
/// An unparseable version throws rather than sorting arbitrarily, matching the JS:
/// a feed that handed the check a value this cannot read is a fault to surface,
/// not a silent "not newer" that would leave a real update unnoticed.
///
/// Foundation only, and no dependency: the parser is the same closed subset the
/// desktop's own module accepts (`MAJOR.MINOR.PATCH` with an optional
/// `-prerelease`, no build metadata), because the versions this compares are the
/// ones the build pipeline stamps and nothing else.
enum Version {
    /// A parsed version, or nil for a string that is not one this releases.
    ///
    /// The same shape and the same regex as `parse()` in
    /// `core/version.js`: three integers, an optional prerelease drawn
    /// from the same alphabet, and nothing else. Build metadata (`+sha`) is not
    /// accepted, because the desktop rejects it too for the same reason (it goes
    /// straight into filenames).
    struct Parsed: Equatable {
        let major: Int
        let minor: Int
        let patch: Int
        let prerelease: String?
    }

    enum Failure: Error, CustomStringConvertible {
        case notAVersion(String)

        var description: String {
            switch self {
            case .notAVersion(let value): return "not a version: \(value)"
            }
        }
    }

    /// `MAJOR.MINOR.PATCH`, optionally `-prerelease`, and nothing else. The same
    /// pattern the desktop uses, so the two ports accept and reject the same set.
    private static let pattern = try! NSRegularExpression(
        pattern: "^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?$"
    )

    /// Parse a version string, or nil if it is not one we would release.
    static func parse(_ version: String) -> Parsed? {
        let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(trimmed.startIndex..<trimmed.endIndex, in: trimmed)
        guard let match = pattern.firstMatch(in: trimmed, range: range) else { return nil }

        func group(_ index: Int) -> String? {
            let r = match.range(at: index)
            guard r.location != NSNotFound, let swiftRange = Range(r, in: trimmed) else { return nil }
            return String(trimmed[swiftRange])
        }

        guard let major = group(1).flatMap({ Int($0) }),
              let minor = group(2).flatMap({ Int($0) }),
              let patch = group(3).flatMap({ Int($0) }) else { return nil }

        let prerelease = group(4)
        return Parsed(major: major, minor: minor, patch: patch, prerelease: prerelease?.isEmpty == false ? prerelease : nil)
    }

    /// The RELEASE half of a version: `MAJOR.MINOR.PATCH`, tail dropped.
    /// `1.0.1` for `1.0.1-dev.195.6387043585`, or nil for a string that is not a
    /// version at all. Mirrors `release()` in `core/version.js`.
    static func release(_ version: String) -> String? {
        guard let parsed = parse(version) else { return nil }
        return "\(parsed.major).\(parsed.minor).\(parsed.patch)"
    }

    /// Compare two versions by RELEASE only: -1, 0 or 1 for a<b, a==b, a>b.
    ///
    /// ★ WHY THIS EXISTS AND WHY AN UPDATE CHECK MUST USE IT
    ///
    /// A dev version carries a tail after the release
    /// (`1.0.1-dev.195.6387043585`) that is build and commit information, and
    /// its BASIS is not fixed: it has changed under us, from
    /// `dev.<commit count>.<sha>` to `dev.<build count>.<timestamp>`, and the two
    /// do not order against each other. A build published this morning can carry
    /// a LOWER number than one published last week.
    ///
    /// Anything that ranks the tail therefore inverts, and it fails quietly: the
    /// check decides the installed build is AHEAD of the feed, offers nothing,
    /// and the client stops updating while its number appears to go backwards.
    ///
    /// So the tail is NEVER ranked. Two builds of the same release compare EQUAL
    /// here whatever their tails say, and which of those two is the newer BUILD
    /// is the feed's own ordering, which cannot invert (see `isNewerBuild` in
    /// `UpdateFeed.swift`). `compare` below still ranks the tail, because that
    /// is what semver precedence is; it is just not allowed to decide an update.
    static func compareRelease(_ a: String, _ b: String) throws -> Int {
        guard let left = parse(a) else { throw Failure.notAVersion(a) }
        guard let right = parse(b) else { throw Failure.notAVersion(b) }

        for pair in [(left.major, right.major), (left.minor, right.minor), (left.patch, right.patch)] {
            if pair.0 != pair.1 { return pair.0 < pair.1 ? -1 : 1 }
        }
        return 0
    }

    /// Whether `candidate` names a strictly newer RELEASE than `current`.
    static func isNewerRelease(_ candidate: String, than current: String) throws -> Bool {
        try compareRelease(candidate, current) > 0
    }

    /// Compare two versions by semver precedence: -1, 0 or 1 for a<b, a==b, a>b.
    ///
    /// Throws on a version it cannot read rather than sorting it arbitrarily,
    /// which is the JS behaviour and the reason the update check can trust a
    /// positive answer: a feed value it could not parse becomes a surfaced fault
    /// rather than a silent "no update".
    static func compare(_ a: String, _ b: String) throws -> Int {
        guard let left = parse(a) else { throw Failure.notAVersion(a) }
        guard let right = parse(b) else { throw Failure.notAVersion(b) }

        for pair in [(left.major, right.major), (left.minor, right.minor), (left.patch, right.patch)] {
            if pair.0 != pair.1 { return pair.0 < pair.1 ? -1 : 1 }
        }

        // Equal core versions. A version with no prerelease outranks one that has
        // it, and two without are equal.
        if left.prerelease == right.prerelease { return 0 }
        if left.prerelease == nil { return 1 }
        if right.prerelease == nil { return -1 }

        return comparePrerelease(left.prerelease!, right.prerelease!)
    }

    /// Whether `candidate` is strictly newer than `current`.
    ///
    /// The one question the update check actually asks. Throws on an unparseable
    /// version for the same reason `compare` does.
    static func isNewer(_ candidate: String, than current: String) throws -> Bool {
        try compare(candidate, current) > 0
    }

    // The dot-separated identifiers of two prerelease strings, compared per semver
    // Section 11.4. Split out only so `compare` reads as the core-then-prerelease
    // shape semver actually is.
    private static func comparePrerelease(_ a: String, _ b: String) -> Int {
        let left = a.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        let right = b.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        let shared = min(left.count, right.count)

        for i in 0..<shared {
            let result = compareIdentifier(left[i], right[i])
            if result != 0 { return result }
        }

        // Every shared identifier is equal, so the one with more identifiers is
        // the higher-precedence version (`dev.5.a` outranks `dev.5`).
        if left.count == right.count { return 0 }
        return left.count < right.count ? -1 : 1
    }

    // One prerelease identifier against another. All-digit identifiers compare
    // numerically and rank below any identifier that is not all digits; two
    // non-numeric ones compare ASCII-lexically.
    private static func compareIdentifier(_ a: String, _ b: String) -> Int {
        let aNumeric = isAllDigits(a)
        let bNumeric = isAllDigits(b)
        if aNumeric && bNumeric {
            let na = Int(a) ?? 0
            let nb = Int(b) ?? 0
            return na == nb ? 0 : (na < nb ? -1 : 1)
        }
        if aNumeric { return -1 }
        if bNumeric { return 1 }
        if a == b { return 0 }
        // ASCII-lexical, matching the JS `<` on strings, which compares by code
        // unit. The prerelease alphabet is ASCII, so a code-unit compare is an
        // ASCII compare.
        return compareASCII(a, b)
    }

    private static func isAllDigits(_ s: String) -> Bool {
        !s.isEmpty && s.allSatisfy { $0.isASCII && $0.isNumber }
    }

    private static func compareASCII(_ a: String, _ b: String) -> Int {
        let au = Array(a.unicodeScalars)
        let bu = Array(b.unicodeScalars)
        let shared = min(au.count, bu.count)
        for i in 0..<shared {
            if au[i].value != bu[i].value { return au[i].value < bu[i].value ? -1 : 1 }
        }
        if au.count == bu.count { return 0 }
        return au.count < bu.count ? -1 : 1
    }
}
