import Foundation

/// Whether an address is an OpenClaw gateway, asked BEFORE a web view is pointed
/// at it.
///
/// The port of `core/gateway-identity.js`, driven by the same
/// `core/spec/gateway-identity.json` the desktop reads, so "is this an OpenClaw
/// gateway" has one answer rather than one per platform. Answering is not
/// identifying: `Test connection` used to ask whether the address responded, and
/// any 200 passed, so a typo that landed on a captive portal or a different
/// service on the same host was put behind this client's chrome.
///
/// WHAT IT IS NOT, said here as well as in the spec because the shape of a check
/// like this invites the opposite reading: it is a correctness boundary, not a
/// security one. It authenticates nothing, checks no credential, does not defend
/// against a host that deliberately impersonates OpenClaw, and says nothing about
/// whether the gateway that answered is the one the reader meant.
///
/// The signals and every sentence the reader sees come from the spec. This file
/// holds the rule and nothing else, and `GatewayIdentityParityTests` proves it
/// reaches the same verdict the JavaScript does on the same inputs.
enum GatewayIdentity {
    /// How strong an acceptance was, so a caller can say which rule ran rather
    /// than only that one did. The same two names `core/gateway-identity.js`
    /// exports.
    enum Strength: String {
        /// The required signal: the response IS OpenClaw's Control UI.
        case payload
        /// The weaker path: a health marker plus the recorded security headers,
        /// which are claimable and therefore corroboration rather than proof.
        case corroborated
    }

    /// What was observed about one address, gathered by the caller.
    struct Observed {
        /// The configured address: status, content type and body, or nil when
        /// nothing answered.
        struct Response {
            var status: Int?
            var contentType: String?
            var body: String?
            /// The response's headers, lowercased by the caller.
            var headers: [String: String] = [:]
        }

        var document: Response?
        var health: Response?
        var error: String?
    }

    struct Verdict {
        var ok: Bool
        var strength: Strength?
        var status: Int?
        var message: String
        /// What the rule saw, so a caller can report rather than guess. The same
        /// keys the JavaScript evidence carries.
        var evidence: [String: Any]
    }

    // MARK: The spec

    private struct Spec: Decodable {
        struct Messages: Decodable {
            let notOpenClaw: String
            let notOpenClawNoDocument: String
            let unreachableNoDocument: String
            let reached: String
            let reachedCorroborated: String
            let unreachable: String
        }

        let payloadAttributes: [String]
        let healthPath: String
        let healthOkKey: String
        let headerNames: [String]
        let maxBytes: Int
        let messages: Messages
    }

    /// The spec, or a build that cannot identify anything.
    ///
    /// A bundle without it answers nothing rather than guessing, and
    /// `GatewayIdentityParityTests` is what turns that into a failing build
    /// instead of a client that silently accepts every address.
    private static let bundledSpec: Spec? = {
        guard let url = Bundle.main.url(forResource: "gateway-identity", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let spec = try? JSONDecoder().decode(Spec.self, from: data),
              !spec.payloadAttributes.isEmpty
        else { return nil }
        return spec
    }()

    /// The one signal that PROVES the payload, so the desktop and the phone
    /// cannot disagree about what identifies OpenClaw.
    static var payloadAttributes: [String] { bundledSpec?.payloadAttributes ?? [] }

    /// The health marker's path, which SUGGESTS a gateway and proves nothing.
    static var healthPath: String { bundledSpec?.healthPath ?? "/healthz" }

    /// The security headers, which SUGGEST a deployment's shape and are never
    /// required.
    static var headerNames: [String] { bundledSpec?.headerNames ?? [] }

    /// How much of a response is read while looking for the marker.
    static var maxBytes: Int { bundledSpec?.maxBytes ?? 262_144 }

    // MARK: The rule

    /// True when `body` carries any of OpenClaw's own payload markers.
    ///
    /// Presence, never a value: a dev build wearing the unsubstituted placeholder
    /// is still the Control UI, and a check that read the version would fail a
    /// gateway for having moved on.
    static func carriesPayloadMarker(_ body: String?) -> Bool {
        guard let body, !body.isEmpty else { return false }
        let window = String(body.prefix(maxBytes))
        return payloadAttributes.contains { window.contains($0) }
    }

    /// The two addresses to ask: the configured address itself, and the health
    /// marker at the origin root and under the configured path.
    ///
    /// Pure string work, the same as `probeTargets()` in the shared module, so
    /// both clients ask the same two questions of the same address.
    ///
    /// The path comes from `URLComponents` rather than from `URL.path`, and that
    /// is a measured port detail rather than a preference: Foundation's
    /// `URL.path` DROPS a trailing slash (`/example-path/` reads back as
    /// `/example-path`), where JavaScript's `pathname` keeps it. Reading the
    /// shorter form would make a gateway mounted under a path look like a file at
    /// the root, so the second health candidate would be `/healthz` for the
    /// second time instead of `/example-path/healthz`, and a gateway that only
    /// answers under its mount would be reported as not identifying itself.
    /// `URLComponents.path` preserves it, so the two clients ask the same thing.
    static func probeTargets(_ raw: String) -> (document: URL?, health: [URL]) {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return (nil, [])
        }
        let origin = "\(url.scheme ?? "http")://\(url.host ?? "")\(url.port.map { ":\($0)" } ?? "")"
        var health: [URL] = []
        if let root = URL(string: "\(origin)\(healthPath)") {
            health.append(root)
        }
        let path = URLComponents(string: raw)?.path ?? ""
        let directory = path.hasSuffix("/") ? path : (path as NSString).deletingLastPathComponent + "/"
        if !directory.isEmpty, directory != "/" {
            let underBase = directory + healthPath.drop(while: { $0 == "/" })
            if let base = URL(string: "\(origin)\(underBase)"), !health.contains(base) {
                health.append(base)
            }
        }
        return (url, health)
    }

    /// What an address is, from what a client observed.
    ///
    /// The same two accepted paths the JavaScript names, and the same order: the
    /// required signal first, then the weaker corroborated path, which still
    /// requires the document to be HTML because the thing being identified is a
    /// Control UI page and a JSON API that happened to carry three common headers
    /// and a health marker is not one.
    static func identify(_ observed: Observed) -> Verdict {
        guard let spec = bundledSpec else {
            return Verdict(
                ok: false,
                strength: nil,
                status: nil,
                message: "This build cannot identify a gateway: it did not bundle core/spec/gateway-identity.json.",
                evidence: ["bundled": false]
            )
        }

        let document = observed.document
        let health = observed.health
        let status = document?.status
        let headers = document?.headers ?? [:]

        let marker = carriesPayloadMarker(document?.body)
        let headerCount = spec.headerNames.filter { (headers[$0]?.isEmpty == false) }.count
        let healthOk = isHealthMarker(health, key: spec.healthOkKey)
        let isHtml = (document?.contentType ?? "").lowercased().contains("html")

        let evidence: [String: Any] = [
            "status": status ?? NSNull(),
            "sawDocument": document != nil && status != nil,
            "payloadMarker": marker,
            "healthOk": healthOk,
            "headersPresent": headerCount,
            "headersExpected": spec.headerNames.count,
        ]

        if marker {
            return Verdict(
                ok: true,
                strength: .payload,
                status: status,
                message: fill(spec.messages.reached, ["status": status.map(String.init) ?? "?"]),
                evidence: evidence
            )
        }

        if observed.document != nil, status != nil, isHtml, headerCount == spec.headerNames.count, healthOk {
            return Verdict(
                ok: true,
                strength: .corroborated,
                status: status,
                message: fill(spec.messages.reachedCorroborated, ["status": status.map(String.init) ?? "?"]),
                evidence: evidence
            )
        }

        guard observed.document != nil, let status else {
            // Two different sentences, mirroring the shared spec: an address that
            // errored or never answered is not narrated as having answered, and
            // the no-error case does not claim a reply it did not get.
            let message = observed.error.map { fill(spec.messages.unreachableNoDocument, ["reason": $0]) }
                ?? spec.messages.notOpenClawNoDocument
            return Verdict(
                ok: false,
                strength: nil,
                status: nil,
                message: message,
                evidence: evidence
            )
        }

        return Verdict(
            ok: false,
            strength: nil,
            status: status,
            message: fill(spec.messages.notOpenClaw, ["status": String(status)]),
            evidence: evidence
        )
    }

    /// Whether a health response is the marker rather than merely JSON.
    private static func isHealthMarker(_ health: Observed.Response?, key: String) -> Bool {
        guard let health, health.status == 200,
              (health.contentType ?? "").lowercased().contains("json"),
              let body = health.body, !body.isEmpty,
              let data = body.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return (parsed[key] as? Bool) == true
    }

    /// Substitute `{name}` placeholders, leaving an unknown one in place rather
    /// than printing "undefined". The same rule the shared module uses, so a
    /// sentence with a placeholder neither client can fill reads alike on both.
    private static func fill(_ template: String, _ values: [String: String]) -> String {
        var out = template
        for (key, value) in values {
            out = out.replacingOccurrences(of: "{\(key)}", with: value)
        }
        return out
    }
}
