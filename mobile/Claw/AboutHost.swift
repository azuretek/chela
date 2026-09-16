import Combine
import Foundation
import UIKit
import WebKit

/// The iOS half of the contract the shared About page talks to.
///
/// `core/ui/about.html` and `core/ui/about.js` are the same files the desktop
/// loads, so the page cannot call `ipcRenderer` or anything else that only
/// exists in an Electron window. It reads `window.clawDesktop`, and this is the
/// object that answers it here: the same door the desktop's preload builds over
/// IPC, built over a `WKScriptMessageHandler` instead. About was reachable only
/// from a native menu bar before, which this client has none of, so it now hangs
/// off Settings through the shared `openAbout` command, and this is what lets the
/// same page render on the phone rather than being reimplemented.
///
/// The page needs a small surface: `about()` for the state it draws, plus
/// `checkUpdates`, `openReleases` and `closeOverlay`, and it subscribes to one
/// event, `about-changed`. This host answers exactly those, the same shape
/// `SettingsHost` answers the settings page's, and `AboutHostTests` asserts the
/// page asks for nothing this does not implement.
///
/// What About shows about updating is the honest iOS answer, from the shared
/// `UpdatePolicy`: this build can say a release exists and no more, so the page's
/// update card reports that rather than offering an install this platform cannot
/// perform. The facts it lists (version, channel, what it runs on) are this
/// client's to describe, and it describes its own, the way the desktop describes
/// Electron and Chromium.
@MainActor
final class AboutHost: NSObject, ObservableObject, WKScriptMessageHandler {
    /// The name the page posts under, and the name the bootstrap registers. The
    /// same global the desktop exposes (`clawDesktop`), because the page reads
    /// that one and no other.
    static let messageName = "clawDesktop"

    private let notices: NoticeBoard
    /// Asked to take the sheet away, the phone's version of the desktop's
    /// `closeOverlay('about')`.
    private let onClose: () -> Void

    /// The page's own web view, for delivering a reply or the one event it
    /// listens for. Weak, because the view owns the message handler's
    /// registration and not the other way round.
    weak var webView: WKWebView?

    init(notices: NoticeBoard, onClose: @escaping () -> Void) {
        self.notices = notices
        self.onClose = onClose
        super.init()
    }

    // MARK: The page's bridge

    /// What the page needs installed before its own script runs.
    ///
    /// Injected at document start rather than at the end, because
    /// `core/ui/about.js` runs as the last element of the body and throws if the
    /// host is not there: a host installed afterwards would be a page that had
    /// already given up. A `WKUserScript` is not subject to the page's own CSP,
    /// which is what makes this possible on a page whose `default-src` is 'none'.
    ///
    /// The promise shim is on this side rather than in Swift because the page is
    /// written against promises: `about()` resolves with the state, and the reply
    /// arrives as a call back into `__clawAboutReply` with the id it was asked
    /// under. The three fire-and-forget calls (`checkUpdates`, `openReleases`,
    /// `closeOverlay`) return nothing the page waits on, so they need no id, and
    /// `onAboutChanged` registers a listener the host fires through
    /// `__clawAboutEmit`.
    func bootstrapScript() -> String {
        return """
        (function () {
          var pending = {};
          var changed = [];
          var seq = 0;

          window.__clawAboutReply = function (id, ok, value, error) {
            var entry = pending[id];
            if (!entry) { return; }
            delete pending[id];
            if (ok) { entry.resolve(value); } else { entry.reject(new Error(error || 'command failed')); }
          };

          window.__clawAboutEmit = function () {
            for (var i = 0; i < changed.length; i += 1) {
              try { changed[i](); } catch (e) { /* a listener that throws must not stop the others */ }
            }
          };

          function invoke(command, args) {
            return new Promise(function (resolve, reject) {
              seq += 1;
              var id = String(seq);
              pending[id] = { resolve: resolve, reject: reject };
              window.webkit.messageHandlers.\(Self.messageName).postMessage({
                id: id, command: command, args: args || []
              });
            });
          }

          function post(command, args) {
            window.webkit.messageHandlers.\(Self.messageName).postMessage({
              id: null, command: command, args: args || []
            });
          }

          window.clawDesktop = {
            about: function () { return invoke('about', []); },
            checkUpdates: function () { post('checkUpdates', []); return Promise.resolve(); },
            openReleases: function () { post('openReleases', []); },
            closeOverlay: function (name) { post('closeOverlay', [name]); },
            onAboutChanged: function (fn) { changed.push(fn); }
          };
        })();
        """
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName,
              let body = message.body as? [String: Any],
              let command = body["command"] as? String
        else { return }
        let id = body["id"] as? String
        let args = body["args"] as? [Any] ?? []
        Task { await self.run(id: id, command: command, args: args) }
    }

    /// Tells the page to re-read its state, the phone's version of the desktop's
    /// `app:about-changed` push. Fired after a check finishes, so the update line
    /// the page is sitting under is refreshed rather than left saying "checking".
    func emitChanged() {
        webView?.evaluateJavaScript("window.__clawAboutEmit && window.__clawAboutEmit()")
    }

    // MARK: The commands

    private func run(id: String?, command: String, args: [Any]) async {
        switch command {
        case "about":
            if let id { reply(id, value: state) }

        case "checkUpdates":
            // The phone cannot install its own update, so a check is only ever a
            // fresh look at the feed: it may raise the "a release exists" banner,
            // which is the whole of what this platform does about one. Run the
            // real check (the same one the launch runs), then tell the page to
            // re-read so its status line stops saying "checking".
            await UpdateCheck(board: notices).run()
            emitChanged()

        case "openReleases":
            // Where the newer build waits. TestFlight is the one channel today, so
            // this is the same destination the update banner's action opens, the
            // honest offer for a platform that installs its apps through the store
            // rather than through this app. In this async command handler the
            // open resolves to the awaitable variant; its Bool result is not
            // acted on, because the OS chooses whether TestFlight or its store
            // page answers and either is the right destination.
            _ = await UIApplication.shared.open(UpdateCheck.testFlightURL)

        case "closeOverlay":
            // The name is `about` and there is only one overlay to close, so the
            // argument is not read: the sheet is dismissed whatever is passed,
            // matching the desktop, where `closeOverlay('about')` closes the About
            // overlay and nothing else this page could name.
            onClose()

        default:
            // The page only ever asks for a command its own host declares, so
            // reaching here is a bug in this switch. A reply is owed only to a
            // command that carried an id; the fire-and-forget ones cannot be
            // failed back, so this logs instead of answering into the void.
            if let id { fail(id, "clawDesktop: no such command on this client: \(command)") }
            else { NSLog("[claw] about host reached an unknown command: %@", command) }
        }
    }

    // MARK: The state

    /// Everything the About page draws.
    ///
    /// The desktop's `aboutState()` in `src/main.js` is the other half of this
    /// shape, and the two carry the same keys the page reads: `build` and the
    /// update fields it renders, plus `facts`, the list of `{ label, value }`
    /// rows. The facts are this client's own, because what a build runs on is the
    /// client's to describe and a desktop fact (Electron, Chromium) has no meaning
    /// here; the page reads whatever the host lists rather than hardcoding either
    /// client's.
    var state: [String: Any] {
        let plan = UpdatePolicy.policy(platform: "ios", packaged: true)
        return [
            "build": Naming.buildVersion,
            // What this build does about a new version, in one line. iOS can only
            // announce one, so the status says so rather than offering to install
            // or download, which the shared policy already forbids here.
            "updateStatus": Self.updateStatus,
            // No build waits installed on the phone: iOS installs apps itself, so
            // there is never one downloaded and ready to restart into. The page
            // hides its "downloaded, install it" hint when this is absent.
            "updateReady": NSNull(),
            // The page's hint reads both of these; on iOS neither offer applies
            // (nothing to install, no automatic-updates switch), so both are the
            // values that leave the hint empty.
            "canInstall": plan.canInstall,
            "autoUpdate": true,
            // The facts a bug report asks for, this client's own. Version and
            // channel come from the same identity the update check compares, and
            // the runtime and device are what a rendering bug is blamed on here,
            // as Electron and Chromium are on the desktop.
            "facts": Self.facts,
        ]
    }

    /// The one-line update status for the page's card. Fixed rather than computed,
    /// because on iOS the answer never changes: this build can announce a release
    /// and cannot install one, and the banner is where a specific waiting version
    /// is reported. Kept plain so it stays true whether or not a check has run.
    private static let updateStatus =
        "\(Naming.product) updates through the App Store. When a newer build is available it is offered in TestFlight; this app cannot install one itself."

    /// The rows under the update card: which build this is, what it runs on.
    private static var facts: [[String: String]] {
        let version = Naming.buildVersion
        let channel = UpdateFeed.channel(for: version)
        let device = UIDevice.current
        return [
            ["label": "Version", "value": version],
            ["label": "Channel", "value": channel],
            ["label": "System", "value": "\(device.systemName) \(device.systemVersion)"],
            ["label": "Device", "value": PromptMetadata.machineIdentifier()],
        ]
    }

    // MARK: Replying

    private func reply(_ id: String, value: Any) {
        guard let json = Self.json(value, fallback: "null") else { return }
        webView?.evaluateJavaScript("window.__clawAboutReply('\(id)', true, \(json), null)")
    }

    private func fail(_ id: String, _ message: String) {
        webView?.evaluateJavaScript(
            "window.__clawAboutReply('\(id)', false, null, \(Self.jsonLiteral(message)))"
        )
    }

    /// One value as JSON text, or nil when it cannot be represented. The same
    /// helper `SettingsHost` uses, for the same reason: the reply reaches the page
    /// as a literal in an `evaluateJavaScript` string, so it is serialised rather
    /// than interpolated.
    private static func json(_ value: Any, fallback: String) -> String? {
        guard JSONSerialization.isValidJSONObject(value) || value is NSNull || value is String || value is NSNumber else {
            return fallback
        }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else {
            return fallback
        }
        return String(data: data, encoding: .utf8)
    }

    /// A string as a JavaScript literal, for the one place a value reaches the
    /// page outside the reply's JSON.
    private static func jsonLiteral(_ text: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [text], options: []),
              let array = String(data: data, encoding: .utf8),
              array.count >= 2
        else { return "\"\"" }
        return String(array.dropFirst().dropLast())
    }
}
