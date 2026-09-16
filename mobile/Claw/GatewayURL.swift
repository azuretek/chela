import Foundation

/// The Control UI URL that hands a stored token to the gateway, ported from
/// `core/gateway-url.js`.
///
/// The Control UI accepts a token on the URL fragment: it reads it during boot,
/// stores it for that gateway, and strips it from the address bar. The fragment is
/// the documented preference over `?token=`, because a fragment never reaches an
/// HTTP request log or a Referer header. So this is what lets the app supply the
/// credential instead of asking someone to paste one into a page, and because it is
/// reapplied on every connect it also self-heals a token the gateway has since
/// rotated.
///
/// `GatewayURLParityTests` proves this port reproduces the golden cases in
/// `core/fixtures/gateway-url.json`, which is the same file
/// `core/test/fixtures.test.js` asserts on the JS side. The two behaviours that
/// fixture is really for: an existing fragment is PRESERVED with the token merged
/// into it, and a token already in the fragment is replaced rather than duplicated.
///
/// One case cannot be represented here and is not: the JS hands an unparseable
/// address back untouched, and this port reproduces that by refusing an address
/// with no scheme and host, which is the same rule in a typed world. `Gateway.parse`
/// is where the refusal happens for anything a person types.
enum GatewayURL {
    /// `url` with `#token=<token>` merged into its fragment.
    ///
    /// A nil or empty token returns the address exactly as it was, INCLUDING when
    /// it already carries a fragment: an empty token is not a token, and treating
    /// it as one would rewrite an address to say nothing.
    static func withTokenHandoff(_ url: URL, _ token: String?) -> URL {
        guard let token, !token.isEmpty else { return url }
        // An address with no scheme and host is not one this client could ever
        // hold, and it is what `new URL(...)` throws on in the shared module. The
        // guard is that same refusal, expressed where the type allows a relative
        // URL through, so an address that will not parse is handed back untouched
        // on both sides rather than gaining a fragment here and not there.
        guard url.scheme != nil, url.host != nil else { return url }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }

        var pairs = fragmentPairs(components.percentEncodedFragment ?? "")
        if let index = pairs.firstIndex(where: { $0.key == "token" }) {
            // In place, which is what `URLSearchParams.set` does and what keeps a
            // re-connect from appending a second token to a long fragment.
            pairs[index].value = token
        } else {
            pairs.append((key: "token", value: token))
        }

        components.percentEncodedFragment = pairs
            .map { "\(formEncode($0.key))=\(formEncode($0.value))" }
            .joined(separator: "&")
        return components.url ?? url
    }

    /// The fragment as key/value pairs, decoded, in the order they appear.
    ///
    /// `URLComponents` splits the query into items but not the fragment, so this is
    /// done by hand. A pair with no `=` is a key with an empty value, which is what
    /// `URLSearchParams` makes of it too.
    private static func fragmentPairs(_ fragment: String) -> [(key: String, value: String)] {
        guard !fragment.isEmpty else { return [] }
        return fragment.split(separator: "&", omittingEmptySubsequences: true).map { pair in
            guard let separator = pair.firstIndex(of: "=") else {
                return (key: formDecode(String(pair)), value: "")
            }
            return (
                key: formDecode(String(pair[pair.startIndex..<separator])),
                value: formDecode(String(pair[pair.index(after: separator)...]))
            )
        }
    }

    /// `application/x-www-form-urlencoded`, which is what `URLSearchParams` writes:
    /// alphanumerics and `*-._` kept, a space as `+`, everything else percent
    /// encoded.
    private static func formEncode(_ text: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "*-._")
        let encoded = text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text
        return encoded.replacingOccurrences(of: "%20", with: "+")
    }

    /// The inverse, including `+` as a space.
    private static func formDecode(_ text: String) -> String {
        text.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? text
    }
}
