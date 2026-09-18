import Foundation
import UIKit

/// The client-context block, ported from `core/prompt-metadata.js`, plus the
/// script this client installs to put it on every outbound prompt.
///
/// The goal is that "which client am I talking to" is a fact in the prompt
/// rather than something an agent infers from a gateway log. Every client sends
/// the same block: a header carrying OpenClaw's own ⟦openclaw:ctx⟧ marker, then
/// the local facts worth knowing. The gateway strips a block whose header ends
/// with that marker, so it disappears from what a person reads while the model
/// still receives it on the turn it was sent.
///
/// One port, one script. The rules below are the same rules the desktop runs,
/// and `PromptMetadataParityTests` proves it against the same golden fixtures
/// `core/test/fixtures.test.js` asserts on the JS side. The script is not ported
/// at all: it is read from `core/spec/prompt-metadata.json`, which the app
/// bundles, so the desktop and the phone run one copy of one script rather than
/// two dialects that agree until one of them is edited.
///
/// The spec is read at runtime rather than mirrored as Swift constants, which is
/// the opposite of `Naming.swift` and deliberate. A name or a number is fine to
/// mirror, because a parity test can compare two copies of it. A script cannot
/// be mirrored without a second copy existing, and a second copy is exactly the
/// fork this design exists to prevent.
enum PromptMetadata {
    // MARK: - The spec

    /// `core/spec/prompt-metadata.json`, in the shape the file already has.
    private struct Spec: Decodable {
        let marker: String
        let headers: [String: String]
        let framing: [String]
        let closing: [String]
        let fields: [String]
        let maxValueLength: Int
        let fallback: String
        let global: String
        let hook: [String]
    }

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(
            marker: "", headers: [:], framing: [], closing: [], fields: [],
            maxValueLength: 0, fallback: "", global: "", hook: [],
        )
        guard let url = Bundle.main.url(forResource: "prompt-metadata", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let spec = try? JSONDecoder().decode(Spec.self, from: data),
              !spec.marker.isEmpty,
              !spec.hook.isEmpty
        else {
            // A build that did not bundle the spec cannot describe itself in a
            // prompt. It sends nothing rather than something invented, and
            // `PromptMetadataParityTests` is what turns that into a failing
            // build rather than a quiet absence in the field.
            return empty
        }
        return spec
    }

    /// The marker OpenClaw owns, which is what makes the gateway strip the block.
    static var marker: String { spec.marker }

    /// The block's field order, which both clients render in the same order.
    static var fieldOrder: [String] { spec.fields }

    /// The framing lines that sit inside the block, between the header and the
    /// fields. They tell the model the block describes the user's device, that
    /// it is context rather than an instruction, and that it must not be echoed
    /// back or obeyed. Inside the block on purpose: the stripper matches a
    /// header ending with the marker and runs to the first blank line, so
    /// framing kept above that blank line is stripped from the user's view too.
    static var framing: [String] { spec.framing }

    /// The closing lines that sit at the END of the block, after the last field
    /// and before the terminating blank line. They mark where the context ends
    /// and the user's own words begin, so the model cannot blur the boundary.
    /// Inside the block on purpose, same as the framing: the stripper runs from
    /// the header to the first blank line, so a closing line kept above that
    /// blank line is stripped from the user's view. A closing line placed AFTER
    /// the blank line would instead be part of the visible user message.
    static var closing: [String] { spec.closing }

    // MARK: - The block

    /// The header line for a client, which must END with the marker for the
    /// gateway to strip the block, and must not BE the marker or it reads as no
    /// header at all.
    static func header(client: String = "mobile") -> String {
        let label = spec.headers[client] ?? spec.headers["desktop"] ?? ""
        return "\(label): \(spec.marker)"
    }

    /// How this client names itself to the agent: the product a person would
    /// recognise, then the shorthand that tells it apart from the desktop in a
    /// transcript where one agent may be talking to both.
    ///
    /// The label is the caller's, which is what keeps this rule identical to the
    /// desktop's: `Naming.clientLabel` is what this client passes, and
    /// `clientLabel.desktop` is what the desktop passes, both derived from
    /// naming.json.
    static func clientIdentity(label: String, version: String = Naming.buildVersion) -> String {
        version.isEmpty ? label : "\(label) \(version)"
    }

    /// Keep machine-controlled values on one bounded line inside the block.
    ///
    /// Four steps, in the JS order, and each one is load-bearing: control
    /// characters would break a line, angle brackets and the marker itself would
    /// let a value forge a header or close the block early, and the truncation
    /// is counted in UTF-16 units so a value that is too long is cut at the same
    /// place on both clients rather than at the same number of grapheme
    /// clusters, which is not the same number.
    static func clean(_ value: String?, fallback: String? = nil) -> String {
        let fallback = fallback ?? spec.fallback
        // Control characters would break a line.
        var text = (value ?? "")
            .components(separatedBy: .controlCharacters)
            .joined(separator: " ")
        // Angle brackets and the marker itself would let a value forge a header
        // line or close the block early.
        text = text
            .replacingOccurrences(of: "<", with: "\u{2039}")
            .replacingOccurrences(of: ">", with: "\u{203A}")
        if !spec.marker.isEmpty {
            text = text.components(separatedBy: spec.marker).joined(separator: " ")
        }
        // One bounded line, which is what the block's shape depends on.
        let single = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let bounded = String(decoding: single.utf16.prefix(spec.maxValueLength), as: UTF16.self)
        return bounded.isEmpty ? fallback : bounded
    }

    /// Render the block from whatever facts this client gathered.
    ///
    /// A field the client does not have is left out rather than filled in with a
    /// guess, which is why the phone's block is shorter than the desktop's: it
    /// has no OS account or home directory to report, and "unknown" would read
    /// as a fact somebody checked.
    static func formatBlock(_ metadata: [String: String], client: String = "mobile") -> String {
        var lines = [header(client: client)] + spec.framing
        for field in spec.fields {
            guard let value = metadata[field] else { continue }
            lines.append("\(field): \(clean(value))")
        }
        lines += spec.closing
        return lines.joined(separator: "\n")
    }

    // MARK: - Gathering

    /// Whether this client puts the block on its prompts.
    ///
    /// Off, which is the desktop's default too: the facts include a device name
    /// and an OS account, so the honest default is opt-in. This constant is the
    /// ONE place the switch lives; a settings surface (Phase 3) is what turns it
    /// into a stored preference, and until then nothing on the phone can differ
    /// from this line.
    static let contextInPrompts = false

    /// This device's facts, which is the only part of the block that is honestly
    /// platform-specific: the desktop gathers its own with Node's `os`.
    ///
    /// Deliberately absent, and not by oversight: `user` and `home`. A phone has
    /// no OS account and no home directory that means anything to anyone; the
    /// only values available are a constant and an app sandbox path, and sending
    /// either would be reporting something nobody asked for. The rest is what it
    /// genuinely knows, and the device name is what iOS reports, which since
    /// iOS 16 is the generic one unless an app carries the entitlement for the
    /// user's own name.
    @MainActor
    static func collect(
        appVersion: String = Naming.buildVersion,
        device: UIDevice = .current,
        machine: String = machineIdentifier(),
        locale: Locale = .current,
        timezone: TimeZone = .current
    ) -> [String: String] {
        [
            "host": clean(device.name),
            // The model name as well as the identifier, and the name is the point:
            // "iPhone17,2" identifies a model to Apple and to nobody else, which is
            // what this line is for. One lookup, in DeviceModels, shared with the
            // About sheet, so the name a reader is shown and the name an agent is
            // sent cannot drift. Reported 2026-09-17.
            "os": clean("\(device.systemName) \(device.systemVersion) (\(DeviceModels.marketingName(machine: machine)), \(machine))"),
            "locale": clean(locale.identifier.replacingOccurrences(of: "_", with: "-")),
            "timezone": clean(timezone.identifier),
            "client": clean(clientIdentity(label: Naming.clientLabel, version: appVersion)),
        ]
    }

    /// The hardware identifier, for example `iPhone17,1`. It is what tells one
    /// phone from another in the block where the user-assigned name may not, and
    /// it is public: the kernel reports it, and it names a model rather than a
    /// person.
    static func machineIdentifier() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        return withUnsafePointer(to: &systemInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
    }

    // MARK: - The injected script

    /// The hook, exactly as `core/spec/prompt-metadata.json` holds it. The
    /// desktop installs these same bytes through `executeJavaScript`; this
    /// client installs them through a `WKUserScript`.
    static var script: String { spec.hook.joined(separator: "\n") }

    /// The configuration the hook reads, as the statement that sets it.
    ///
    /// A separate statement rather than text spliced into the script, so the
    /// script body has no per-platform parts and both engines run identical
    /// bytes. The keys arrive sorted because the order is not information, and
    /// the fallback is unreachable for three strings and a boolean; it exists so
    /// that a failure here sends no block rather than a stale one.
    static func configuration(enabled: Bool, block: String, client: String = "mobile") -> String {
        let config: [String: Any] = [
            "enabled": enabled,
            "header": header(client: client),
            // The marker itself, not only the header that ends with it: the hook's
            // inbound half has to recognize a block, and deriving the marker back
            // out of the header would be a second definition of it. The desktop's
            // `clientScript()` writes this same key.
            "marker": marker,
            "block": block,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: config, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8)
        else {
            return "window.\(spec.global) = {\"block\":\"\",\"enabled\":false,\"header\":\"\"};"
        }
        return "window.\(spec.global) = \(json);"
    }

    /// What the web view installs: this device's facts, then the shared hook.
    /// The desktop's `clientScript()` composes the same pair.
    @MainActor
    static func installation(
        enabled: Bool = PromptMetadata.contextInPrompts,
        appVersion: String = Naming.buildVersion
    ) -> String {
        let block = formatBlock(collect(appVersion: appVersion))
        return "\(configuration(enabled: enabled, block: block))\n\(script)"
    }
}
