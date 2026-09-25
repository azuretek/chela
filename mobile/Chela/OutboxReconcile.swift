import Foundation

/// The outbox reconcile, read from `core/spec/outbox-reconcile.json`.
///
/// The Control UI rewrites every in-flight row of its outbox as if the page had
/// reloaded, on every pass through its codec. A message the gateway already
/// accepted is then shown as "Reconnected before delivery was confirmed" on a
/// connection that never dropped, and the messages behind it can wait on a
/// reconnect that never comes. The script checks such a row against the gateway's
/// own record over the page's own socket: a row the gateway holds is removed as
/// delivered, and a row it does not hold is sent once, under its own send id, so
/// the gateway's dedupe keeps it to one copy.
///
/// The script is not ported: it is read from the spec the app bundles, exactly as
/// `ReconnectResumeShim` reads its hook, so the bytes this client installs are the
/// bytes `core/outbox-reconcile.js` hands the desktop. It is installed at document
/// START because it wraps the page's `WebSocket` constructor, which has to happen
/// before the page opens its socket. The spec's own `why` list names the upstream
/// fixes that retire it.
enum OutboxReconcile {
    private struct Spec: Decodable {
        let global: String
        let hook: [String]
    }

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(global: "", hook: [])
        guard let url = Bundle.main.url(forResource: "outbox-reconcile", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let spec = try? JSONDecoder().decode(Spec.self, from: data),
              !spec.global.isEmpty,
              !spec.hook.isEmpty
        else {
            // A build that did not bundle the spec installs nothing rather than
            // something invented, and `OutboxReconcileParityTests` is what turns
            // that into a failing build rather than a quiet absence in the field.
            return empty
        }
        return spec
    }

    /// The install-guard global the script sets on the page, which also carries its log.
    static var global: String { spec.global }

    /// The script, exactly as `core/spec/outbox-reconcile.json` holds it.
    static var script: String { spec.hook.joined(separator: "\n") }
}
