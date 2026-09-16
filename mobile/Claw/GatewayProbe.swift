import CryptoKit
import Foundation

/// Whether a gateway answers, which is what the Gateways tab's Test connection
/// button asks and nothing more.
///
/// A port of `testGateway()` in `desktop/src/main.js`, reduced to what this client
/// can answer and kept to the same two-attempt shape, because the two attempts are
/// the point rather than a retry:
///
/// 1. Ask for the URL the way the app would load it, with a trusted chain
///    required. If that works, the answer is a status code and nothing else.
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
/// No credential is sent, and nothing is cached. The request is a fact-finding
/// GET of the address as typed, which is what makes it work before a token has
/// been stored.
enum GatewayProbe {
    /// How long one attempt may take. The same eight seconds the desktop uses.
    private static let timeout: TimeInterval = 8

    /// The test, in the shape the page reads: `ok`, `status`, `message` and
    /// `fingerprint` (null unless a certificate was read).
    static func run(_ raw: String) async -> [String: Any] {
        guard let gateway = Gateway.parse(raw) else {
            return ["ok": false, "status": NSNull(), "message": "That is not an address this app can load.", "fingerprint": NSNull()]
        }
        guard let scheme = gateway.url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            return ["ok": false, "status": NSNull(), "message": "Use an http:// or https:// address.", "fingerprint": NSNull()]
        }

        let strict = await attempt(gateway.url, trustingCertificate: true)
        if let status = strict.status {
            return [
                "ok": status > 0 && status < 500,
                "status": status,
                "message": "Reachable. HTTP \(status).",
                "fingerprint": NSNull(),
            ]
        }

        // A refused chain is the one failure worth a second look, because it is
        // the expected state of a gateway's own listener rather than a fault.
        guard scheme == "https", strict.untrustedCertificate else {
            return [
                "ok": false,
                "status": NSNull(),
                "message": strict.reason ?? "That address did not answer.",
                "fingerprint": NSNull(),
            ]
        }

        let lenient = await attempt(gateway.url, trustingCertificate: false)
        guard let status = lenient.status else {
            return [
                "ok": false,
                "status": NSNull(),
                "message": lenient.reason ?? "That address did not answer.",
                "fingerprint": NSNull(),
            ]
        }
        return [
            "ok": true,
            "status": status,
            "message": "Reachable. HTTP \(status), but the certificate is not one this app can verify. "
                + "Trusting a fingerprint is not built on this client yet, so this gateway cannot be loaded until it serves a certificate the system already trusts.",
            "fingerprint": lenient.fingerprint ?? NSNull(),
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
            let (_, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode
            return Attempt(
                status: status,
                reason: nil,
                fingerprint: delegate.fingerprint,
                untrustedCertificate: false
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
