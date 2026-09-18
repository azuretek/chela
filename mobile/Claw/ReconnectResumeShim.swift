import Foundation

/// The reconnect-resume shim, read from `core/spec/reconnect-resume-shim.json`.
///
/// The Control UI marks the first `chat.send` after a reconnect with a reserved
/// property on the frame's params, and the gateway accepts that marker only from a
/// client it counts as an operator UI. This app's page connects with a NATIVE
/// descriptor (see `NativeControlAuth`), which is not one of those ids, so the
/// marker is never stripped for it, the field then fails `chat.send`'s own
/// parameter validation, and the whole send is refused: the reader gets a message
/// that will never send, over a connection that is otherwise healthy, and because
/// the page clears its resume record only after a send SUCCEEDS, every later
/// attempt carries the marker too until the app is relaunched.
///
/// The script is not ported: it is read from the spec the app bundles, exactly as
/// `Pairing` reads its observer and `PromptMetadata` reads its hook, so the bytes
/// this client installs are the bytes `core/reconnect-resume-shim.js` hands any
/// other client. It wraps `WebSocket.prototype.send` and deletes that one property
/// from a `chat.send` frame before it leaves the page; every other frame goes out
/// as the bytes it arrived as, and the wrapper never throws.
///
/// This is the prevention rather than the fix. The durable fix is upstream, where
/// the gateway should strip the reserved field for every client whatever connect
/// descriptor it used, and the spec's own `why` list names the trigger that
/// retires this file. It is installed at document START, before the page's own
/// script runs, for the same reason the client-context hook and the pairing
/// observer are: a wrapper added at document end would be racing a socket the page
/// had already opened, and the frames it missed would be silent.
enum ReconnectResumeShim {
    // MARK: - The spec

    /// `core/spec/reconnect-resume-shim.json`, in the shape the file already has.
    private struct Spec: Decodable {
        let reservedProperty: String
        let method: String
        let global: String
        let hook: [String]
    }

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(reservedProperty: "", method: "", global: "", hook: [])
        guard let url = Bundle.main.url(forResource: "reconnect-resume-shim", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let spec = try? JSONDecoder().decode(Spec.self, from: data),
              !spec.reservedProperty.isEmpty,
              !spec.method.isEmpty,
              !spec.hook.isEmpty
        else {
            // A build that did not bundle the spec cannot install the shim. It
            // installs nothing rather than something invented, and
            // `ReconnectResumeShimParityTests` is what turns that into a failing
            // build rather than a quiet absence in the field, where the symptom is
            // a send that fails for a reason nothing on screen explains.
            return empty
        }
        return spec
    }

    /// The property the Control UI puts on a resumed `chat.send`, and the one the
    /// shim deletes. Read from the spec so this client and the script cannot
    /// disagree about the name, which is the wire's rather than ours.
    static var reservedProperty: String { spec.reservedProperty }

    /// The method whose frames the shim rewrites, and the only one it touches.
    static var method: String { spec.method }

    /// The install-guard global the script sets on the page, so a second
    /// installation cannot stack a second wrapper on the same socket.
    static var global: String { spec.global }

    /// The shim, exactly as `core/spec/reconnect-resume-shim.json` holds it.
    ///
    /// The desktop needs none of it, because the gateway's own strip covers a
    /// browser Control UI connection; this client installs these bytes through a
    /// `WKUserScript`, and a later client that needs the same stand-in installs
    /// the same bytes its own way.
    static var script: String { spec.hook.joined(separator: "\n") }
}
