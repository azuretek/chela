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

    /// Clear this client's cached Control UI code and reload it from the server.
    ///
    /// Injected rather than implemented here for the same reason `makeCheck` is:
    /// the About host owns a page, not a gateway web view, and the thing that has
    /// to reload is the session behind the sheet. The default is the honest
    /// refusal, so a host built without this does not offer a button that appears
    /// to work: the page hides the section when the command is absent, and this
    /// makes the command absent rather than broken.
    private let clearCacheAndReload: () async -> (ok: Bool, detail: String)

    /// How a press on the page's Check for updates button builds its check.
    ///
    /// A closure rather than a check built here, because a screenshot run has to
    /// hand the check a seeded feed and only the layer that knows whether this is
    /// one can say so (see `SettingsSpec`). The default is the real check, which
    /// is what a shipped build always gets.
    private let makeCheck: () -> UpdateCheck

    /// The page's own web view, for delivering a reply or the one event it
    /// listens for. Weak, because the view owns the message handler's
    /// registration and not the other way round.
    weak var webView: WKWebView?

    init(
        notices: NoticeBoard,
        onClose: @escaping () -> Void,
        makeCheck: (() -> UpdateCheck)? = nil,
        clearCacheAndReload: (() async -> (ok: Bool, detail: String))? = nil
    ) {
        self.notices = notices
        self.onClose = onClose
        self.makeCheck = makeCheck ?? { UpdateCheck(board: notices) }
        self.clearCacheAndReload = clearCacheAndReload ?? {
            (false, "This build cannot clear its own cache.")
        }
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

          // Always a sheet over Settings: the native sheet's slide is the motion,
          // so the page draws none of its own inside it (see surface--native-sheet
          // in core/ui/ui.css).
          try { document.documentElement.classList.add('surface--native-sheet'); } catch (e) { /* no root yet */ }

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
            clearCacheAndReload: function () { return invoke('clearCacheAndReload', []); },
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

    /// The kinds of cache a clear drops, named for the reader rather than for the
    /// API. The list is the point: it is the same boundary the desktop's
    /// `src/cache.js` keeps, and it deliberately EXCLUDES the stores that hold this
    /// device's paired identity. A button that signed the reader out would be a far
    /// worse fault than the staleness it fixes.
    static let cacheKinds = ["cached code", "service worker"]

    #if DEBUG
    /// Press the page's Check for updates, for a screenshot run.
    ///
    /// A simulator cannot be tapped by a script, and without this the phone's
    /// answer to a press cannot be seen at all: the launch check is a background
    /// one, which stays silent when it finds nothing, so "this build is current"
    /// is only ever drawn after a press. It runs the same command the page's own
    /// button posts (`checkUpdates`), which is the route a tap takes, so what a
    /// screenshot shows is the real answer rather than a seeded banner.
    ///
    /// DEBUG only, and inert without `-claw-check-updates`. See `SettingsSpec`.
    func pressCheckForUpdates() async {
        await run(id: nil, command: "checkUpdates", args: [])
    }
    #endif

    #if DEBUG
    /// Click one of the page's own buttons, for a screenshot run. See
    /// `SettingsSpec.screenshotPress`, which only ever hands this a plain id.
    func pressButton(_ id: String) {
        webView?.evaluateJavaScript(Self.pressScript(id))
    }

    /// Waits for the button to exist and be enabled (the page may still be
    /// loading), then brings it on screen, lets that frame paint, and clicks it.
    static func pressScript(_ id: String) -> String {
        "(function(){var n=0;(function t(){var b=document.getElementById('\(id)');if(b&&!b.disabled&&b.offsetParent){b.scrollIntoView({block:'center'});setTimeout(function(){b.click();},600);}else if(n++<100){setTimeout(t,100);}})();})()"
    }
    #endif

    // MARK: The commands

    private func run(id: String?, command: String, args: [Any]) async {
        switch command {
        case "about":
            if let id { reply(id, value: state) }

        case "checkUpdates":
            // The phone cannot install its own update, so a check is only ever a
            // fresh look at the feed. A MANUAL trigger, like the desktop's
            // `checkForUpdates('manual')`: this is a button somebody pressed, so
            // an answer is owed in BOTH directions. It raises the standing "a
            // release exists" banner when the feed names a newer build, and an
            // "up to date" (or "could not check") notice when it does not, which
            // is what stops the button from appearing to work and reporting
            // nothing. Then the page is told to re-read so its status line stops
            // saying "checking".
            await makeCheck().run(trigger: .manual)
            emitChanged()

        case "clearCacheAndReload":
            // The same command the desktop's About page calls, with the same
            // answer: the cache is cleared and the Control UI restarts the way a
            // fresh launch does, with this sheet and Settings going away as part of
            // it (see ContentView's wiring). The reply says whether that restart
            // STARTED; when it did not (no gateway page to reload), this sheet is
            // staying and the page shows the reason under the button.
            let report = await clearCacheAndReload()
            if let id {
                reply(id, value: [
                    "ok": report.ok,
                    "started": report.ok,
                    "detail": report.detail,
                    "origins": ["this device's Control UI"],
                    "cleared": report.ok ? ["this device's Control UI"] : [],
                    "failed": report.ok ? [] : [["origin": "this device's Control UI", "error": report.detail]],
                    "kinds": Self.cacheKinds,
                    "gateway": NSNull(),
                ])
            }

        case "openReleases":
            // The REAL release notes, which is what the button says. It used to
            // open TestFlight, which is where a newer build waits rather than
            // where its notes are, so the button's whole promise was broken: a
            // person asking what changed got a build. With a version we have
            // announced, this is that release's own page; without one it is the
            // channel's list of releases, which is the honest answer for a build
            // whose own notes are what a reader most often wants to check.
            //
            // In this async command handler the open resolves to the awaitable
            // variant; its Bool result is not acted on, because the OS decides
            // whether Safari or an in-app browser answers and either is right.
            if let url = UpdateFeed.releaseNotesURL(version: UpdateCheck.announcedVersion) {
                _ = await UIApplication.shared.open(url)
            }

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
    /// rows, and `controlUI`, the Control UI this build targets. The facts are
    /// this client's own, because what a build runs on is the client's to
    /// describe and a desktop fact (Electron, Chromium) has no meaning here; the
    /// page reads whatever the host lists rather than hardcoding either client's.
    /// The reference is the one key that is NOT a client's own: it comes from the
    /// pin both clients read, so it says the same thing on both.
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
            // The one row here that is not this client's own: the Control UI this
            // build targets, read from the pin that records it. The page composes
            // the line, and this only hands over the pin's two fields.
            "controlUI": Self.controlUI,
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
        let machine = PromptMetadata.machineIdentifier()
        return [
            ["label": "Version", "value": version],
            ["label": "Channel", "value": channel],
            ["label": "System", "value": "\(device.systemName) \(device.systemVersion)"],
            // The name a person recognises, then the identifier a bug report is
            // matched on. It was the identifier alone, which names a model to Apple
            // and to nobody else: reported 2026-09-17 against the iOS Settings sheet,
            // where this same phone reads "iPhone 16 Pro Max". No other client has an
            // iPhone identifier to name, so the lookup is this client's own.
            ["label": "Device", "value": DeviceModels.describe(machine: machine)],
        ]
    }

    /// The pin that records which Control UI this build targets, as it is read.
    ///
    /// Chela wraps the Control UI and our own pages borrow ITS components, so the
    /// revision those came out of is a fact about a reference rather than about
    /// this client, which is why it lives in one file both clients read
    /// (`core/spec/upstream-reference.json`) instead of a constant here. Bundled
    /// rather than mirrored, the same way the App-settings affordance is: a Swift
    /// constant beside the pin would be a second copy of it, and the pin is what
    /// the class guard keeps true against the checkout.
    private struct Pin: Decodable {
        struct Upstream: Decodable {
            let version: String
            let commit: String
        }

        let upstream: Upstream
    }

    /// The two fields the shared page composes its line from, or nil.
    ///
    /// The page does the composing rather than this client, because both clients
    /// draw that row and two sentences about one revision is how one of them ends
    /// up stale. See `controlUILine` in core/ui/about.js.
    private static let reference: [String: String]? = {
        guard let url = Bundle.main.url(forResource: "upstream-reference", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let pin = try? JSONDecoder().decode(Pin.self, from: data)
        else {
            // A build that did not bundle the pin draws no reference row at all,
            // rather than one invented here. `AboutHostTests` is what turns that
            // into a failing build instead of a quietly missing line in the field.
            return nil
        }
        return ["version": pin.upstream.version, "commit": pin.upstream.commit]
    }()

    /// The reference as the state carries it, and `NSNull` when there is none: the
    /// page skips the row for a host that has nothing to say, which is what keeps
    /// an About page with no pin behind it from reading "undefined".
    private static var controlUI: Any {
        reference ?? NSNull()
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
