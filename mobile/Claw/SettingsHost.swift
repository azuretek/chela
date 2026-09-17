import Combine
import Foundation
import UIKit
import WebKit

/// The iOS half of the contract the shared settings page talks to.
///
/// `core/ui/settings.js` is the same file the desktop loads, so it cannot call
/// `ipcRenderer` or anything else that only exists in an Electron window. It calls
/// `window.clawSettings.invoke(command, args)` and `.on(event, handler)`, and this
/// is the object that answers: one switch over the command names declared in
/// `core/spec/settings.json`, plus the two events the page listens for.
///
/// Command NAMES rather than callbacks, and one door rather than a method per
/// action, because the same page runs against a preload script on the desktop and
/// a message handler here. Named methods would have to be mirrored in JavaScript
/// on this side and in Swift on that one, which is two places for one contract.
///
/// The commands implemented here are exactly the ones `core/spec/settings.json`
/// gives the `ios` client and no others: a command the phone's surface never
/// shows is work nobody asked for, and a command the page can reach that is not
/// implemented is a button that does nothing. Both halves of that are asserted by
/// `SettingsSpecTests`, which reads the spec and this file.
///
/// Everything this client does NOT have is absent from the surface rather than
/// answered with a shrug: extra request headers, certificate pinning and the
/// notice log are all declared desktop-only, with their reasons, in that spec.
@MainActor
final class SettingsHost: NSObject, ObservableObject, WKScriptMessageHandler {
    /// The name the page posts under, and the name the bootstrap registers.
    static let messageName = "clawSettings"

    private let store: GatewayStore
    private let connection: ConnectionState
    private let notices: NoticeBoard
    /// Which appearance the app is in, so the page's own row can show it and the
    /// choice it sends back can be applied. The value lives on the client rather
    /// than in the shared config, and the reason is recorded as this setting's
    /// `absent` entry in core/spec/settings.json.
    private let appearance: AppearanceStore
    /// Asked to take the surface away, which only happens when there is a gateway
    /// behind it to reveal.
    private let onClose: () -> Void
    /// Asked to load a gateway. The surface closes itself first: a sheet covers
    /// the page it just switched to, and a failure would be raised behind it.
    private let onConnect: () -> Void
    /// Asked to open the About page over the settings surface. About was reachable
    /// only from a native menu bar before, which this client has none of, so it
    /// now hangs off Settings through the shared `openAbout` command. The view
    /// answers by presenting `AboutSurface`; this host only carries the request,
    /// the same way `onClose` and `onConnect` do.
    private let onOpenAbout: () -> Void
    /// Asked to take the reader to the CONTROL UI's own settings, which is where
    /// the gateway's agents, models and channels live. Two halves and therefore
    /// one closure: the view dismisses this sheet and then asks the gateway page
    /// to open its own settings (see `GatewayPage`), and the order between them is
    /// the whole action.
    private let onOpenControlUiSettings: () -> Void

    /// The page's own web view, for delivering a reply or an event. Weak, because
    /// the view owns the message handler's registration and not the other way
    /// round.
    weak var webView: WKWebView?

    init(
        store: GatewayStore,
        connection: ConnectionState,
        notices: NoticeBoard,
        appearance: AppearanceStore,
        onClose: @escaping () -> Void,
        onConnect: @escaping () -> Void,
        onOpenAbout: @escaping () -> Void,
        onOpenControlUiSettings: @escaping () -> Void
    ) {
        self.store = store
        self.connection = connection
        self.notices = notices
        self.appearance = appearance
        self.onClose = onClose
        self.onConnect = onConnect
        self.onOpenAbout = onOpenAbout
        self.onOpenControlUiSettings = onOpenControlUiSettings
        super.init()
    }

    // MARK: The page's bridge

    /// What the page needs installed before its own script runs.
    ///
    /// Injected at document start rather than at the end, because
    /// `core/ui/settings.js` runs as the last element of the body and throws if
    /// there is no host: a host installed afterwards would be a page that had
    /// already given up. A `WKUserScript` is not subject to the page's own CSP,
    /// which is what makes this possible on a page whose `default-src` is 'none'.
    ///
    /// Two facts ride on the host object rather than in the page's URL:
    ///
    /// - **`asPage`**, whether this page is the whole screen or a sheet over one.
    ///   The desktop passes it as `?page=1`, and it decides the scrim and whether
    ///   there is anything to close back to. Here it is true exactly when there is
    ///   no gateway, which is the phone's version of the desktop's first run: the
    ///   surface IS the app.
    /// - **`tab`**, which panel to open on. The desktop uses it to land a notice's
    ///   own "Review" on the tab that answers it.
    ///
    /// Both would be query parameters if the query worked. It does not: a file URL
    /// with a query renders a blank document in this web view, with no error
    /// anywhere (measured on a simulator, 2026-09-15). Stating them here lands at
    /// the same moment the desktop's do, before first paint, without a URL WebKit
    /// refuses.
    ///
    /// The promise shim is on this side rather than in Swift because the page is
    /// written against promises: `invoke` resolves or rejects, and the reply
    /// arrives as a call back into `__clawSettingsReply` with the id it was asked
    /// under. That id is what lets several commands be in flight at once, which the
    /// page does: loading the gateway list and the notice count together is two.
    func bootstrapScript() -> String {
        let asPage = store.hasGateway ? "false" : "true"
        let tab = SettingsSpec.screenshotTab.map { "'\($0)'" } ?? "null"
        return """
        (function () {
          var pending = {};
          var listeners = {};
          var seq = 0;

          window.__clawSettingsReply = function (id, ok, value, error) {
            var entry = pending[id];
            if (!entry) { return; }
            delete pending[id];
            if (ok) { entry.resolve(value); } else { entry.reject(new Error(error || 'command failed')); }
          };

          window.__clawSettingsEmit = function (event) {
            var list = listeners[event] || [];
            for (var i = 0; i < list.length; i += 1) {
              try { list[i](); } catch (e) { /* a listener that throws must not stop the others */ }
            }
          };

          window.clawSettings = {
            asPage: \(asPage),
            tab: \(tab),
            invoke: function (command, args) {
              return new Promise(function (resolve, reject) {
                seq += 1;
                var id = String(seq);
                pending[id] = { resolve: resolve, reject: reject };
                window.webkit.messageHandlers.\(Self.messageName).postMessage({
                  id: id, command: command, args: args || []
                });
              });
            },
            on: function (event, fn) {
              listeners[event] = listeners[event] || [];
              listeners[event].push(fn);
            }
          };
        })();
        """
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName,
              let body = message.body as? [String: Any],
              let id = body["id"] as? String,
              let command = body["command"] as? String
        else { return }
        let args = body["args"] as? [Any] ?? []
        Task { await self.run(id: id, command: command, args: args) }
    }

    /// Raises one of the two events the page listens for.
    ///
    /// The page re-reads its state on `state`, which is how a connection phase that
    /// changed after the page was drawn reaches the row that reports it, and re-reads
    /// its notice log on `notices`.
    func emit(_ event: String) {
        webView?.evaluateJavaScript("window.__clawSettingsEmit('\(event)')")
    }

    // MARK: The commands

    private func run(id: String, command: String, args: [Any]) async {
        switch command {
        case "state":
            reply(id, value: state)

        case "testGateway":
            let url = string(args, 0)
            reply(id, value: await GatewayProbe.run(url))

        case "addGateway":
            let entry = dictionary(args, 0)
            let added = store.add(label: entry["label"] as? String ?? "", url: entry["url"] as? String ?? "")
            // A refusal leaves the list alone, and the page reports it, so the
            // answer carries whether anything was added rather than an error the
            // page would have to guess the meaning of.
            guard let added else {
                reply(id, value: refusedState())
                return
            }
            // The entry that was created, so the page can store the credential
            // typed into the SAME form against the id this client just assigned.
            // The credential is kept against a gateway's id, so without this the
            // token would have to wait for a second visit through Edit, which is
            // the trip the one-pass add form exists to remove.
            var answer = state
            answer["added"] = [
                "id": added.id,
                "label": added.label,
                "url": added.url.absoluteString,
            ] as [String: Any]
            reply(id, value: answer)

        case "updateGateway":
            let gatewayId = string(args, 0)
            let patch = dictionary(args, 1)
            store.update(
                id: gatewayId,
                label: patch["label"] as? String,
                url: patch["url"] as? String
            )
            reply(id, value: state)

        case "removeGateway":
            let gatewayId = string(args, 0)
            store.remove(id: gatewayId)
            // The credentials go with the gateway. Leaving a Keychain item for a
            // row that no longer exists is a secret kept for no one, and a
            // re-added gateway with the same id cannot happen (ids are UUIDs), so
            // there is nothing to preserve.
            SettingsCredentials.forget(gatewayId)
            reply(id, value: state)

        case "setCredentials":
            let gatewayId = string(args, 0)
            let patch = dictionary(args, 1)
            let saved = saveCredentials(gatewayId, patch)
            var answer = state
            answer["saved"] = saved
            reply(id, value: answer)

        case "connect":
            let gatewayId = string(args, 0)
            store.setActive(id: gatewayId)
            onConnect()
            reply(id, value: state)

        case "saveSettings":
            let patch = dictionary(args, 0)
            // Only what this client has. The page sends the keys its own surface
            // shows, so this is a defensive read rather than a filter, and it is
            // here because writing a preference nobody can see is worse than
            // ignoring one.
            if let promptMetadata = patch["promptMetadata"] as? Bool {
                store.setPromptMetadata(promptMetadata)
            }
            // The appearance arrives on this same command rather than through one
            // of its own, because the page can only reach what its host
            // implements and a second door for one value is a second thing to
            // keep in step. An unrecognised value is ignored rather than
            // defaulted: the page sends what it offers, so anything else is a bug
            // on one side of the contract, and guessing would hide it. See
            // `AppearanceMode.named`.
            if let named = AppearanceMode.named(patch["appearance"]) {
                appearance.choose(named)
            }
            // The desktop answers with what its two platform-bound preferences did
            // (`shortcut`, `login`). This client has neither, and the page reads
            // both as absent rather than as success.
            reply(id, value: state)

        case "closeSettings":
            onClose()
            reply(id, value: NSNull())

        case "openControlUiSettings":
            // Closes this surface and lets the page open its own settings. The
            // route stays the Control UI's: this client presses the Control UI's
            // own footer control with the shared script rather than building a
            // URL, so app settings and gateway settings cannot come to mean
            // different pages on the two clients. A failure is logged by the page
            // driver and leaves the reader on the page, which is where they were.
            onOpenControlUiSettings()
            reply(id, value: NSNull())

        case "openAbout":
            // Opens the shared About page over this surface, the phone's version
            // of the desktop's showAbout(). The view presents AboutSurface; this
            // only asks. About is reachable nowhere else on a client with no menu
            // bar, which is why it hangs off Settings.
            onOpenAbout()
            reply(id, value: NSNull())

        default:
            // The one answer that is not a state. The page only ever asks for a
            // command its own client's spec declares, so reaching here is a bug in
            // this switch or in the spec, and a silent success would hide it.
            fail(id, "clawSettings: no such command on this client: \(command)")
        }
    }

    /// Stores one credential and reports what happened, in the shape the page's
    /// own Save and Clear buttons read.
    private func saveCredentials(_ gatewayId: String, _ patch: [String: Any]) -> [String: Any] {
        for field in ["token", "password"] {
            guard let value = patch[field] as? String else { continue }
            guard SettingsCredentials.set(gatewayId, field: field, value: value) else {
                return ["ok": false, "error": "The Keychain refused to store that. Try again, or check the device's passcode settings."]
            }
        }
        return ["ok": true, "error": NSNull()]
    }

    // MARK: The state

    /// Everything the page renders from.
    ///
    /// The desktop's `currentState()` in `src/main.js` is the other half of this
    /// shape, and the two carry the same keys for the same reasons: the page is one
    /// file, so a key it reads has to be there whichever client is running it. A
    /// key a client has no answer for is null rather than missing, because the
    /// page's own checks are for what the SURFACE says, not for what happens to be
    /// in the state.
    var state: [String: Any] {
        let activeId = store.config.activeGatewayId
        return [
            "client": SettingsSpec.clientId,
            "surface": SettingsSpec.surface,
            "gateways": store.gateways.map { gateway in
                let status = connection.status(for: gateway, active: gateway.id == activeId)
                let credentials = SettingsCredentials.summary(gateway.id)
                return [
                    "id": gateway.id,
                    "label": gateway.label,
                    "url": gateway.url.absoluteString,
                    "credentials": [
                        "hasToken": credentials.hasToken,
                        "hasPassword": credentials.hasPassword,
                        "headers": credentials.headers,
                    ] as [String: Any],
                    "status": [
                        "tone": status.tone,
                        "label": status.label,
                        "detail": status.detail ?? NSNull(),
                    ] as [String: Any],
                ] as [String: Any]
            },
            "activeGatewayId": activeId ?? NSNull(),
            "connection": [
                "gatewayId": connection.gatewayId ?? NSNull(),
                "phase": connection.phase.rawValue,
                "error": NSNull(),
            ] as [String: Any],
            "settings": ["promptMetadata": store.config.promptMetadata] as [String: Any],
            // The appearance the app is actually wearing, which is the only place
            // the page reads it from. Sent as an object rather than as a bare
            // string so the page reads a field of the state it already renders
            // from, matching how the desktop's state carries its own settings.
            "appearance": appearance.state,
            // Read only by the Certificates tab, which this client does not have.
            // Sent because the page reads `state.trustedCerts` unconditionally
            // while drawing that panel, and a missing key would be a crash rather
            // than a hidden tab.
            "trustedCerts": store.config.trustedCerts,
            "certOffers": [],
            // The Keychain is always there, so credentials are always storable and
            // there is no reason string to give.
            "secretsAvailable": true,
            "secretsError": NSNull(),
            // The page prints the app, the build and what it is running on, all
            // pre-formatted for the same reason the desktop formats them: a
            // sandboxed page cannot require the module that knows the rules, and
            // what a client runs on is that client's to describe.
            "appName": Naming.product,
            "build": Naming.buildVersion,
            "runtime": Self.runtime,
            // No path to show: the config is user defaults, and a phone has no
            // file worth naming. The page leaves an absent part out of its line.
            "configPath": NSNull(),
            "versions": NSNull(),
            // What this build may do about a release, from the shared policy: iOS
            // can say one exists and no more. The page shows this only where it
            // has the automatic-updates switch, which is the desktop.
            "updates": [
                "canInstall": UpdatePolicy.policy(platform: "ios", packaged: true).canInstall,
                "reason": UpdatePolicy.policy(platform: "ios", packaged: true).capabilityReason,
            ] as [String: Any],
            "platform": "ios",
        ]
    }

    /// What this build is running on, for the line under the page.
    private static var runtime: String {
        let device = UIDevice.current
        return "\(device.systemName) \(device.systemVersion)"
    }

    /// A state whose gateway list did not change, with the refusal the page reports.
    ///
    /// The page's Add button has no other way to learn that an address was
    /// refused, and the alternative it had on the desktop (it accepted any string)
    /// is not available here: the URL has to parse before it can be loaded.
    private func refusedState() -> [String: Any] {
        var answer = state
        answer["saved"] = [
            "ok": false,
            "error": "That is not an address this app can load. Use a host name, or a full http or https URL.",
        ] as [String: Any]
        return answer
    }

    // MARK: Replying

    private func reply(_ id: String, value: Any) {
        guard let json = Self.json(value, fallback: "null") else { return }
        webView?.evaluateJavaScript("window.__clawSettingsReply('\(id)', true, \(json), null)")
    }

    private func fail(_ id: String, _ message: String) {
        webView?.evaluateJavaScript(
            "window.__clawSettingsReply('\(id)', false, null, \(Self.jsonLiteral(message)))"
        )
    }

    /// One value as JSON text, or nil when it cannot be represented.
    private static func json(_ value: Any, fallback: String) -> String? {
        guard JSONSerialization.isValidJSONObject(value) || value is NSNull || value is String || value is NSNumber else {
            return fallback
        }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else {
            return fallback
        }
        return String(data: data, encoding: .utf8)
    }

    /// A string as a JavaScript literal. Used for the one place a value reaches
    /// the page outside the reply's JSON, so it is escaped rather than trusted.
    private static func jsonLiteral(_ text: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [text], options: []),
              let array = String(data: data, encoding: .utf8),
              array.count >= 2
        else { return "\"\"" }
        return String(array.dropFirst().dropLast())
    }

    // MARK: Reading arguments

    private func string(_ args: [Any], _ index: Int) -> String {
        guard index < args.count, let value = args[index] as? String else { return "" }
        return value
    }

    private func dictionary(_ args: [Any], _ index: Int) -> [String: Any] {
        guard index < args.count, let value = args[index] as? [String: Any] else { return [:] }
        return value
    }
}
