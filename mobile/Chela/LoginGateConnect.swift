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
            let gateShown: String
            let gateGone: String
            let pageReady: String
        }
        let reports: Reports
        let deadlineMs: Int
        let gateMs: Int
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

    /// How long the loading cover is held over a page that is on its OWN login
    /// gate before it lands on the failed state. Short, because a gate means the
    /// page has given up rather than an attempt still running.
    static var gateMs: Int { spec?.gateMs ?? 1200 }

    /// The kinds the script posts, and the one the pairing observer adds.
    enum Report: Equatable {
        case pressed
        case rendered
        case failed(title: String)
        /// The page has drawn its OWN login gate, or that gate has left again, and
        /// the document it is in has begun. A gate reported by one document says
        /// nothing about the next one, which is what pageReady is for.
        case gateShown(title: String)
        case gateGone
        case pageReady
        /// The gateway answered the press by refusing this device. Not a script
        /// report: PairingBridge raises it when a pairing close arrives, because
        /// the pairing screen is the answer and the press is over.
        case pairing
    }

    /// Read a posted body into a report, or nil. The payload is the page's, so
    /// only the kinds the spec names are accepted and the title is narrowed.
    static func read(_ body: [String: Any]) -> Report? {
        guard let reports = spec?.reports, let kind = body["kind"] as? String else { return nil }
        switch kind {
        case reports.pressed: return .pressed
        case reports.rendered: return .rendered
        case reports.failed: return .failed(title: narrowed(body["title"] as? String))
        case reports.gateShown: return .gateShown(title: narrowed(body["title"] as? String))
        case reports.gateGone: return .gateGone
        case reports.pageReady: return .pageReady
        default: return nil
        }
    }

    /// The one free-text field a report may carry crosses a page boundary, so it
    /// is squeezed to single spaces and cut to a length a notice can show.
    private static func narrowed(_ raw: String?) -> String {
        let squeezed = (raw ?? "").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return String(squeezed.prefix(160))
    }

    static let decodedKeys: Set<String> = ["reports", "deadlineMs", "gateMs", "hook"]
    static let ignoredKeys: Set<String> = ["description", "why", "selectors", "upstreamComponent"]
}
