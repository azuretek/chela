import CryptoKit
import Foundation

/// Whether a gateway answers AND whether it is one. The Gateways tab's Test
/// connection button asks both, and the two are different questions: answering is
/// not identifying, and a 200 from a captive portal used to pass both.
///
/// A port of `testGateway()` in `desktop/src/main.js`, reduced to what this client
/// can answer and kept to the same two-attempt shape, because the two attempts are
/// the point rather than a retry:
///
/// 1. Ask for the URL the way the app would load it, with a trusted chain
///    required. If that works, the answer is a status code and whatever the body
///    identifies.
/// 2. If it failed because the certificate could not be verified, ask again while
///    reading the certificate, and report the fingerprint alongside the fact that
///    it is not trusted.
///
/// The second attempt is why the fingerprint is available at all, and the step is
/// deliberately reported as a warning rather than a failure: a gateway on its own
/// `:18789` listener presents a self-signed certificate by design, so "reachable,
/// but not verifiable" is the honest answer and the one the page renders with the
/// fingerprint attached.
///
/// **What this client cannot do with that fingerprint is decide anything about
/// it.** The desktop pins it, in Settings, beside the two answers to a refused
/// certificate. iOS has no equivalent yet (the delegate that would refuse and
/// offer does not exist), so the message says so rather than promising a prompt
/// that would never appear: see the `queued` list in `core/spec/settings.json`.
///
/// The identity rule itself is `GatewayIdentity`, which reads the same spec the
/// desktop reads: this file only makes the requests and hands over what came back,
/// so the verdict a person sees at a press is the same verdict on both clients.
///
/// No credential is sent, and nothing is cached. The request is a fact-finding
/// GET of the address as typed, which is what makes it work before a token has
/// been stored.
enum GatewayProbe {
    /// How long one attempt may take. The same eight seconds the desktop uses.
    private static let timeout: TimeInterval = 8

    /// The test, in the shape the page reads: `ok`, `status`, `message` and
    /// `fingerprint` (null unless a certificate was read), plus the identity
    /// verdict so the weaker acceptance can be told apart from the required one.
    static func run(_ raw: String) async -> [String: Any] {
        guard let gateway = Gateway.parse(raw) else {
            return ["ok": false, "status": NSNull(), "message": "That is not an address this app can load.", "fingerprint": NSNull()]
        }
        guard let scheme = gateway.url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            return ["ok": false, "status": NSNull(), "message": "Use an http:// or https:// address.", "fingerprint": NSNull()]
        }

        let targets = GatewayIdentity.probeTargets(raw)
        guard let documentURL = targets.document else {
            return ["ok": false, "status": NSNull(), "message": "That is not an address this app can load.", "fingerprint": NSNull()]
        }

        var strict = await attempt(documentURL, trustingCertificate: true)
        var fingerprint: String?
        if strict.untrustedCertificate {
            let lenient = await attempt(documentURL, trustingCertificate: false)
            fingerprint = lenient.fingerprint
            strict = lenient
        }

        // The health marker is corroboration and is allowed to fail: it can raise
        // confidence and it must never be the reason an address is accepted.
        var health: GatewayIdentity.Observed.Response?
        for candidate in targets.health {
            // eslint-disable-next-line no-await-in-loop
            let answer = await attempt(candidate, trustingCertificate: true)
            if answer.status != nil { health = answer.observed; break }
        }

        let observed = GatewayIdentity.Observed(
            document: strict.status == nil ? nil : strict.observed,
            health: health,
            error: strict.status == nil ? strict.reason : nil
        )
        let verdict = GatewayIdentity.identify(observed)

        // The certificate note survives the identity check rather than being
        // replaced by it: a self-signed listener is still the routine state of a
        // gateway on its own port, and the reader still has to be told.
        var message = verdict.message
        if fingerprint != nil, verdict.ok {
            message += " The certificate is not one this app can verify, so this gateway cannot be loaded until it serves one the system already trusts."
        }

        return [
            "ok": verdict.ok,
            "status": verdict.status ?? (strict.status as Any? ?? NSNull()),
            "message": message,
            "fingerprint": fingerprint ?? NSNull(),
            "identity": [
                "accepted": verdict.ok,
                "strength": verdict.strength?.rawValue ?? NSNull(),
            ],
        ]
    }

    /// One attempt, and what it learned.
    private struct Attempt {
        var status: Int?
        var reason: String?
        var fingerprint: String?
        /// The chain was refused, which is a different thing from the host not
        /// answering and is the only case worth asking again.
        var untrustedCertificate: Bool
        /// The response as the identity rule wants it, headers lowercased.
        var observed = GatewayIdentity.Observed.Response()
    }

    private static func attempt(_ url: URL, trustingCertificate: Bool) async -> Attempt {
        let delegate = Probe(trustingCertificate: trustingCertificate)
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        // A stale cached answer is worse than no answer here: the question is
        // whether the gateway is there now, and the button exists for the case
        // where the app has just been pointed at it.
        request.cachePolicy = .reloadIgnoringLocalCacheData

        do {
            let (data, response) = try await session.data(for: request)
            let http = response as? HTTPURLResponse
            var headers: [String: String] = [:]
            for (name, value) in http?.allHeaderFields ?? [:] {
                headers[String(describing: name).lowercased()] = String(describing: value)
            }
            // The marker lives on the opening tag and is inside the first
            // kilobyte of every build measured, so the read is bounded rather
            // than reading whatever the address streams at us.
            let body = String(data: data.prefix(GatewayIdentity.maxBytes), encoding: .utf8)
            return Attempt(
                status: http?.statusCode,
                reason: nil,
                fingerprint: delegate.fingerprint,
                untrustedCertificate: false,
                observed: GatewayIdentity.Observed.Response(
                    status: http?.statusCode,
                    contentType: headers["content-type"],
                    body: body,
                    headers: headers
                )
            )
        } catch {
            let urlError = error as? URLError
            return Attempt(
                status: nil,
                reason: sentence(urlError?.localizedDescription ?? error.localizedDescription),
                fingerprint: delegate.fingerprint,
                untrustedCertificate: urlError?.code == .serverCertificateUntrusted
                    || urlError?.code == .secureConnectionFailed
            )
        }
    }

    /// A reason turned into a sentence, matching `sentence()` in
    /// `core/notices.js` and `noticeSentence` here: these are appended to a
    /// sentence of ours or stand alone, and the OS's fragments do neither
    /// reliably.
    private static func sentence(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "" }
        let capitalised = String(first).uppercased() + trimmed.dropFirst()
        if let last = capitalised.last, ".!?:;".contains(last) { return capitalised }
        return capitalised + "."
    }

    /// Reads the leaf certificate's fingerprint, and decides whether to accept it.
    ///
    /// Its own delegate object rather than the host, because the answer belongs to
    /// one request: a session-scoped delegate cannot leak a decision about one
    /// gateway's certificate into another's connection.
    private final class Probe: NSObject, URLSessionDelegate {
        private let trustingCertificate: Bool
        /// `sha256/<base64 of the DER>`, which is the format the desktop pins and
        /// reports, so a fingerprint read on one client is comparable with one read
        /// on the other.
        private(set) var fingerprint: String?

        init(trustingCertificate: Bool) {
            self.trustingCertificate = trustingCertificate
        }

        func urlSession(
            _ session: URLSession,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                  let serverTrust = challenge.protectionSpace.serverTrust
            else {
                completionHandler(.performDefaultHandling, nil)
                return
            }
            if let chain = SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate], let leaf = chain.first {
                let der = SecCertificateCopyData(leaf) as Data
                fingerprint = "sha256/" + Data(SHA256.hash(data: der)).base64EncodedString()
            }
            // The strict attempt decides nothing: it is the system's answer that is
            // being asked for. The lenient one accepts, which is the only way to
            // read the certificate's status code, and it is only ever reached after
            // the strict attempt has already refused.
            completionHandler(
                trustingCertificate ? .performDefaultHandling : .useCredential,
                trustingCertificate ? nil : URLCredential(trust: serverTrust)
            )
        }
    }
}
