import SwiftUI
import WebKit

/// The shared loading screen, in a web view: `core/ui/loading.html`, the page the
/// desktop's loading cover draws, bundled rather than rebuilt.
///
/// Abi, 2026-09-25: the phone's loading screen is the desktop's, built once so a
/// change to it reaches every platform. So this client draws the same mark, ring,
/// progress bar, quip and, when a load fails, the same failed state with its Try
/// again, and `LoadingHost` answers the same `window.clawDesktop` calls the
/// desktop's preload answers for that page.
struct LoadingSurface: UIViewRepresentable {
    @ObservedObject var cover: PageCover
    let gateway: Gateway
    let tokens: [String: String]
    let colour: Color
    let reconnect: () -> Void

    func makeCoordinator() -> LoadingHost { LoadingHost() }

    func makeUIView(context: Context) -> WKWebView {
        let host = context.coordinator
        host.configure(cover: cover, gateway: gateway, reconnect: reconnect)
        let configuration = WKWebViewConfiguration()
        let scripts = WKUserContentController()
        scripts.add(WeakMessageHandler(host), name: LoadingHost.messageName)
        scripts.addUserScript(WKUserScript(source: LoadingHost.bootstrapScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        scripts.addUserScript(WKUserScript(source: ThemeTokens.applyScript(tokens), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController = scripts

        let webView = WKWebView(frame: .zero, configuration: configuration)
        // Painted the theme's own colour until the page has, so the cover never
        // shows a system-coloured frame before its first paint.
        let background = PaletteColour.uiColor(from: tokens["--bg"]) ?? UIColor(colour)
        webView.isOpaque = false
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = background
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.scrollView.isScrollEnabled = false
        webView.overrideUserInterfaceStyle = ThemeTokens.pageTrait(tokens: tokens, own: .unspecified)
        webView.accessibilityIdentifier = "loading-cover"
        host.webView = webView
        host.appliedTokens = tokens
        if let page = Self.page, let directory = Self.directory {
            webView.loadFileURL(page, allowingReadAccessTo: directory)
        }
        host.start()
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        let host = context.coordinator
        host.configure(cover: cover, gateway: gateway, reconnect: reconnect)
        host.stateChanged()
        if host.appliedTokens != tokens {
            host.appliedTokens = tokens
            webView.evaluateJavaScript(ThemeTokens.applyScript(tokens))
            webView.overrideUserInterfaceStyle = ThemeTokens.pageTrait(tokens: tokens, own: .unspecified)
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: LoadingHost) {
        coordinator.stop()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: LoadingHost.messageName)
    }

    static var page: URL? { Bundle.main.url(forResource: "loading", withExtension: "html") }
    static var directory: URL? { page?.deletingLastPathComponent() }
}

/// The loading page's other end: the phone's answer to the desktop preload's
/// `getState`, `progress`, `onProgress`, `onStateChanged` and `reconnect`.
///
/// Progress is computed here and pushed, as the desktop's main process does,
/// from the shared curve (`Progress`, `core/spec/progress.json`) over the
/// milestones the page's own navigation reports into `PageCover`, and the quip
/// from `Quips`. Four times a second and only on a change, the desktop's tick.
@MainActor
final class LoadingHost: NSObject, WKScriptMessageHandler {
    static let messageName = "clawLoading"
    static let tickMs = 250

    weak var webView: WKWebView?
    var appliedTokens: [String: String] = [:]
    private weak var cover: PageCover?
    private var gateway: Gateway?
    private var reconnect: () -> Void = {}
    private var timer: Timer?
    private var lastProgress: [String: AnyHashable]?
    private var lastState: [String: AnyHashable]?
    private let quipOffset = Quips.startAt()

    func configure(cover: PageCover, gateway: Gateway, reconnect: @escaping () -> Void) {
        self.cover = cover
        self.gateway = gateway
        self.reconnect = reconnect
    }

    func start() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: Double(Self.tickMs) / 1000, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pushProgress() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// The page's state, in the desktop's shape: the gateway being connected and
    /// whether the attempt has failed.
    func state() -> [String: AnyHashable] {
        let failed = cover?.failed ?? false
        var gw: [String: AnyHashable] = [:]
        if let gateway {
            gw = ["id": gateway.id, "label": gateway.label, "url": gateway.url.absoluteString]
        }
        return [
            "gateways": gateway == nil ? [AnyHashable]() : [gw as AnyHashable],
            "activeGatewayId": gateway?.id ?? "",
            "connection": ["phase": failed ? "failed" : "connecting"] as [String: AnyHashable],
        ]
    }

    func progress() -> [String: AnyHashable] {
        let cover = self.cover
        let percent = Progress.percent(
            milestone: cover?.milestone ?? Progress.start,
            sinceMs: Date().timeIntervalSince(cover?.milestoneAt ?? Date()) * 1000,
            failed: cover?.failed ?? false
        )
        var value: [String: AnyHashable] = ["percent": percent]
        if let quip = Quips.quipAt(Date().timeIntervalSince1970 * 1000 / Double(Quips.rotateMs), offset: quipOffset) {
            value["quip"] = quip
        }
        return value
    }

    /// Tell the page to re-read its state, once per real change.
    func stateChanged() {
        let next = state()
        guard next != lastState else { return }
        lastState = next
        webView?.evaluateJavaScript("window.__clawLoadingState && window.__clawLoadingState()")
    }

    private func pushProgress() {
        let next = progress()
        guard next != lastProgress else { return }
        lastProgress = next
        guard let json = Self.json(next) else { return }
        webView?.evaluateJavaScript("window.__clawLoadingProgress && window.__clawLoadingProgress(\(json))")
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName,
              let body = message.body as? [String: Any],
              let command = body["command"] as? String
        else { return }
        let id = body["id"] as? String ?? ""
        let value: Any
        switch command {
        case "getState": value = state()
        case "progress": value = progress()
        case "reconnect":
            reconnect()
            value = NSNull()
        default: value = NSNull()
        }
        let json = Self.json(value) ?? "null"
        webView?.evaluateJavaScript("window.__clawLoadingReply && window.__clawLoadingReply(\(Self.json(id) ?? "''"), \(json))")
    }

    private static func json(_ value: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Installed at document start, because `loading.js` reads the host the moment
    /// it runs. The same global the desktop exposes, `clawDesktop`, carrying only
    /// what the loading page calls.
    static let bootstrapScript = """
    (function () {
      var seq = 0, pending = {}, progressFns = [], stateFns = [];
      function invoke(command) {
        return new Promise(function (resolve) {
          var id = String(++seq);
          pending[id] = resolve;
          window.webkit.messageHandlers.\(messageName).postMessage({ id: id, command: command });
        });
      }
      window.__clawLoadingReply = function (id, value) {
        var resolve = pending[id];
        delete pending[id];
        if (resolve) resolve(value);
      };
      window.__clawLoadingProgress = function (value) {
        for (var i = 0; i < progressFns.length; i += 1) { try { progressFns[i](value); } catch (e) { /* one listener cannot stop the rest */ } }
      };
      window.__clawLoadingState = function () {
        for (var i = 0; i < stateFns.length; i += 1) { try { stateFns[i](); } catch (e) { /* the same */ } }
      };
      window.clawDesktop = {
        getState: function () { return invoke('getState'); },
        progress: function () { return invoke('progress'); },
        onProgress: function (fn) { progressFns.push(fn); },
        onStateChanged: function (fn) { stateFns.push(fn); },
        reconnect: function () { return invoke('reconnect'); }
      };
    })();
    """
}

/// A script message handler that does not keep its target alive: a
/// `WKUserContentController` holds its handlers strongly, and the target here
/// owns the web view that owns the controller.
@MainActor
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: (NSObject & WKScriptMessageHandler)?

    init(_ target: NSObject & WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
