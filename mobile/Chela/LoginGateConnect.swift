import Foundation

/// Connect pressed on the Control UI's OWN login gate, read from
/// core/spec/login-gate-connect.json.
///
/// The desktop reads the same file through core/login-gate-connect.js. This
/// client has no Swift copy of the script: it bundles the spec and installs those
/// bytes, so the two clients watch for the press the same way. The reports arrive
/// on the pairing observer's channel (PairingBridge), and PageCover answers
/// them: the loading screen at once on the press, lifted once the interface has
/// rendered, and its failed state on a refusal or at the deadline.
enum LoginGateConnect {
    private struct Spec: Decodable {
        struct Reports: Decodable {
            let pressed: String
            let rendered: String
            let failed: String
        }
        let reports: Reports
        let deadlineMs: Int
        let hook: [String]
    }

    private static let spec: Spec? = try? BundledSpec.load("login-gate-connect", as: Spec.self)

    /// The injected script. Nil when the build did not bundle the spec, which
    /// LoginGateConnectParityTests fails on.
    static var script: String? {
        guard let lines = spec?.hook, !lines.isEmpty else { return nil }
        return lines.joined(separator: "\n")
    }

    /// How long a press may go unanswered before the cover lands on its failed
    /// state.
    static var deadlineMs: Int { spec?.deadlineMs ?? 15000 }

    /// The three kinds the script posts.
    enum Report: Equatable {
        case pressed
        case rendered
        case failed(title: String)
    }

    /// Read a posted body into a report, or nil. The payload is the page's, so
    /// only the three kinds the spec names are accepted and the title is narrowed.
    static func read(_ body: [String: Any]) -> Report? {
        guard let reports = spec?.reports, let kind = body["kind"] as? String else { return nil }
        switch kind {
        case reports.pressed: return .pressed
        case reports.rendered: return .rendered
        case reports.failed:
            let raw = (body["title"] as? String) ?? ""
            let squeezed = raw.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
            return .failed(title: String(squeezed.prefix(160)))
        default: return nil
        }
    }

    static let decodedKeys: Set<String> = ["reports", "deadlineMs", "hook"]
    static let ignoredKeys: Set<String> = ["description", "why", "selectors", "upstreamComponent"]
}
