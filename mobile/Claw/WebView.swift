import SwiftUI
import WebKit

/// The Control UI, hosted in a `WKWebView`.
///
/// Deliberately thin: this phase loads a URL, relays the page's theme colour and
/// reports whether the load worked, which is the one condition this client can
/// observe on its own and therefore the one notice it raises by itself.
///
/// The navigation delegate the file used to say was absent for a reason is here
/// now for exactly that reason: it exists to answer "did the page load", and the
/// notice board is what consumes the answer. Phase 4's certificate pinning
/// attaches to the same two methods, so it joins a surface that already has a job
/// rather than inventing one.
struct WebView: UIViewRepresentable {
    /// The gateway to load. The address and the name travel together, because a
    /// failure has to name the gateway it was about.
    let gateway: Gateway

    /// Which appearance the app is in, so the page can be told.
    ///
    /// The relay is two-way: the page reports the colour it is actually painted
    /// with (see `themeScript`), and the app passes the appearance down in return.
    /// Down is the web view's own trait collection, which is what a page's
    /// `prefers-color-scheme` resolves against, so `system` keeps following the
    /// device live and an explicit light or dark pins the page to the same answer
    /// the native chrome is wearing. Nothing is written into the page: the hidden
    /// leg is the platform's own channel, and a page we do not own is not a place
    /// to inject state. See the note on `WebView.themeScript`.
    let appearance: AppearanceMode

    /// The page's own background, so the strips the safe area leaves above and
    /// below it are painted with the page's colour rather than the window's.
    ///
    /// Handed down from the view that owns it rather than read here, because
    /// the strips are outside this view: the web view cannot paint what it does
    /// not cover.
    @Binding var themeColour: Color

    /// Where a failed or recovered load is reported. Held rather than observed:
    /// this view raises, and the banner in ContentView draws.
    let notices: NoticeBoard

    /// What the settings page's gateway rows read for their badge.
    ///
    /// This view is the only thing that knows whether a load is in flight, so it
    /// is where the phase is set, and the settings host reads it rather than
    /// sniffing the web view for it.
    let connection: ConnectionState

    /// Whether the gateway is refusing this device until it is approved. Fed by
    /// the injected observer, which watches the page's own gateway socket: a
    /// pairing refusal closes that socket with the policy code, which is an event
    /// inside the page rather than a navigation failure, so it is the one
    /// connection state this view cannot learn from the navigation delegate. See
    /// `PairingBridge` and `Pairing`.
    let pairing: PairingState

    /// Raised when the App-settings affordance in the Control UI's footer is
    /// pressed. This view owns the gateway page the affordance is injected into,
    /// so it is where the bridge that answers it is registered; the ask is
    /// relayed up to the view that owns the settings sheet. See
    /// `AppSettingsAffordance` and `AppSettingsBridge`.
    let onOpenAppSettings: () -> Void

    /// Remembers what has been asked for, so a SwiftUI update cannot reload the
    /// page under the user. `updateUIView` runs on every layout pass, and the
    /// web view's own `url` is not a usable guard for that: it stays nil until
    /// the navigation commits, so the pass that follows `load` would load it a
    /// second time.
    ///
    /// It is also where the page's theme colour arrives: the script this view
    /// injects posts it through a message handler, which is the only route from
    /// the page back into this app until Phase 4's certificate pinning gives
    /// the navigation delegate a reason to exist.
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var requested: URL?
        /// The last appearance pushed down to this web view, so `updateUIView`
        /// only touches the view and the page when it actually changed.
        var appliedAppearance: AppearanceMode?
        /// The last pairing retry beat this view acted on, so a bump of the
        /// state's `retryTick` reloads the page exactly once. Auto-recovery drives
        /// this: while the pairing screen is up the state ticks on a cadence, and
        /// each new tick reloads the page to make a fresh connect attempt that
        /// picks up an approval without a relaunch.
        var appliedRetryTick: Int = 0
        /// The App-settings affordance's host bridge, held here so the content
        /// controller's strong reference to it does not outlive this coordinator.
        /// It answers the one message the injected footer control posts.
        let appSettings: AppSettingsBridge
        /// The web view's content controller, held so the token handoff script can
        /// be replaced before each load. The token is read fresh every connect, so
        /// a rotated one self-heals; holding the controller rather than the token
        /// is what keeps a credential out of this object between loads.
        weak var contentController: WKUserContentController?
        /// The token handoff user script currently installed, so it can be removed
        /// before the next one is added rather than stacking a script per load.
        var nativeAuthScript: WKUserScript?
        /// The device-identity seed script currently installed, so it can be
        /// removed before the next one is added rather than stacking a script per
        /// load. Reinstalled on every load like the token handoff, because the
        /// persisted identity is read fresh from the Keychain each connect, so a
        /// value captured on a previous run is seeded into the page before it
        /// boots and the gateway recognises the already-paired device.
        var deviceIdentitySeedScript: WKUserScript?
        /// The pairing observer's host bridge, held here so the content
        /// controller's strong reference to it does not outlive this coordinator.
        /// It reads the observer's reports and drives the pairing state.
        let pairingBridge: PairingBridge
        private let themeColour: Binding<Color>
        private let notices: NoticeBoard
        private let connection: ConnectionState
        /// The gateway's name, for the notice a failed load raises. Carried
        /// rather than read from `Gateway`, which no longer has a default to
        /// read, and rather than re-derived from a URL that a provisional
        /// failure may not have delivered yet.
        private let gatewayName: String
        /// The same gateway's id, for the row that reports the phase. A name can
        /// be edited; the id cannot, and a row is looked up by id.
        private let gatewayId: String

        /// The pairing state the observer's bridge drives, held so the navigation
        /// legs can report `connecting` before a load and `failed` when a load
        /// itself fails, keeping those apart from the pairing state the socket
        /// close carries.
        private let pairing: PairingState

        init(
            themeColour: Binding<Color>,
            notices: NoticeBoard,
            connection: ConnectionState,
            pairing: PairingState,
            gatewayName: String,
            gatewayId: String,
            onOpenAppSettings: @escaping () -> Void
        ) {
            self.themeColour = themeColour
            self.notices = notices
            self.connection = connection
            self.pairing = pairing
            self.gatewayName = gatewayName
            self.gatewayId = gatewayId
            self.appSettings = AppSettingsBridge(onOpen: onOpenAppSettings)
            self.pairingBridge = PairingBridge(state: pairing)
        }

        func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == WebView.themeMessageName,
                  let parts = message.body as? [NSNumber],
                  parts.count == 3
            else { return }
            themeColour.wrappedValue = Color(uiColor: UIColor(
                red: CGFloat(parts[0].doubleValue) / 255,
                green: CGFloat(parts[1].doubleValue) / 255,
                blue: CGFloat(parts[2].doubleValue) / 255,
                alpha: 1
            ))
        }

        /// The page loaded. Whatever a previous failure said about this gateway is
        /// no longer true, so the notice the banner is showing comes down.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in
                notices.connectionRecovered()
                connection.connected(gatewayId)
                // The page's HTML loaded, which is NOT the same as the gateway
                // socket opening: a device the gateway has not approved still
                // gets the page, then has its socket closed for pairing. So this
                // leg does not move the pairing state to authenticated; the
                // observer does that on the socket's `open`. All this does is
                // leave the pairing state as it was, so a reload that succeeds
                // (the auto-recovery retry) does not itself clear a pairing screen
                // before the socket has actually opened.
            }
        }

        /// The page could not be fetched at all.
        ///
        /// A provisional failure is the one that means the host never answered, or
        /// answered with something that is not a page, which is the condition the
        /// desktop reports as "Cannot connect". A cancelled request is not a
        /// failure of the gateway and is ignored: it is what a superseded load
        /// reports, and raising a banner for it would announce a problem every
        /// time a navigation was replaced.
        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            report(error)
        }

        /// A load that got as far as a response and then failed, or a page that
        /// died after it was up. Both mean the Control UI is not on screen, which
        /// is the same sentence to the reader.
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            Task { @MainActor in
                notices.connectionFailed(
                    label: gatewayName,
                    description: "The page stopped responding and will be reloaded."
                )
                connection.failed(gatewayId)
                webView.reload()
            }
        }

        private func report(_ error: Error) {
            let urlError = error as? URLError
            if urlError?.code == .cancelled { return }
            let description = urlError?.localizedDescription ?? error.localizedDescription
            Task { @MainActor in
                notices.connectionFailed(label: gatewayName, description: description)
                connection.failed(gatewayId)
                // A load that never reached a page is a network/host failure, not
                // pairing: the gateway did not get far enough to refuse the
                // device. Kept distinct so the pairing screen does not show for a
                // dropped connection.
                pairing.failed()
            }
        }
    }

    /// The name the injected script posts under.
    static let themeMessageName = "clawTheme"

    /// The hook the app calls to make the page report again.
    ///
    /// The script installs it, and the app calls it whenever the appearance
    /// changes, so the strips are repainted at the moment of the choice rather
    /// than at the next trait propagation. Named with the same prefix as the
    /// message, because both are one relay's two ends.
    static let themeReportHook = "__clawThemeReport"

    /// Reports the page's own background as three channel values, and re-reports
    /// whenever the page's theme changes.
    ///
    /// Two things about this are deliberate, and both were arrived at by getting
    /// them wrong first.
    ///
    /// **It reads the page's background, not its `theme-color` meta.** The meta is
    /// declared per `prefers-color-scheme`, which is the *device's* appearance, and
    /// the Control UI's own theme picker is free to disagree with it: set the
    /// Control UI to light on a phone in dark mode and the page is cream while the
    /// media query still says dark. Reading the meta then reports a colour the page
    /// is not painted with, and the strips come out black on a light page. Assigning
    /// `var(--bg)` to a real property and reading the *computed* value makes the
    /// engine answer for the page as it is actually styled, whatever the palette was
    /// authored in, which is also how the desktop's relay reads the same page (see
    /// readTheme in desktop/src/preload.cjs). The meta stays as the fallback for a
    /// page that paints itself some other way.
    ///
    /// **It watches for changes rather than reading once.** The theme picker
    /// rewrites `data-theme` and `data-theme-mode` in place with no navigation, so
    /// there is no load event to hang this off; the attribute IS the event. The same
    /// observer catches the page repainting after a `prefers-color-scheme` change,
    /// which is the leg the app drives when the appearance is changed here.
    ///
    /// `WKWebView.themeColor` is the native route to the same value and was tried
    /// first, on the reasoning that a property beats an injected script. Observed
    /// through KVO it never delivered a value, and left the strips the window's
    /// colour while looking like it worked. A mechanism that silently does nothing
    /// is worse here than no mechanism, so it was replaced rather than kept
    /// alongside this.
    private static var themeScript: String {
        """
        (function () {
          // A colour as three channels, or null. Anything not fully opaque is a
          // failure rather than a colour: `rgba(0, 0, 0, 0)` is what a probe
          // resolves to when the token does not exist at all, and reading it as
          // black would paint the strips black on precisely the pages that have
          // no background of their own.
          function channels(colour) {
            if (typeof colour !== 'string') { return null; }
            var text = colour.trim().toLowerCase();
            var hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
            if (hex) {
              var digits = hex[1];
              if (digits.length === 3) {
                digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2];
              }
              return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
            }
            var rgb = /^rgba?\\(\\s*([\\d.]+)[\\s,]+([\\d.]+)[\\s,]+([\\d.]+)\\s*(?:[,/]\\s*([\\d.]+%?)\\s*)?\\)$/.exec(text);
            if (!rgb) { return null; }
            if (rgb[4] !== undefined) {
              var alpha = rgb[4].indexOf('%') >= 0 ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
              if (!(alpha > 0.5)) { return null; }
            }
            // Held to 0-255 so a page cannot hand the app a colour channel out of
            // range, the same way the desktop parses every value before it reaches
            // an API.
            var out = [];
            for (var i = 1; i <= 3; i += 1) {
              var n = Math.round(Number(rgb[i]));
              if (!isFinite(n)) { return null; }
              out.push(Math.min(255, Math.max(0, n)));
            }
            return out;
          }

          // The page's background, through a real property so the engine
          // flattens whatever notation the palette was authored in. The probe is
          // temporary and changes nothing about the page.
          function pageBackground() {
            var probe = document.createElement('span');
            probe.setAttribute('aria-hidden', 'true');
            probe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;height:0;pointer-events:none;background-color:var(--bg)';
            document.documentElement.appendChild(probe);
            var value = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return value;
          }

          // What the page declares for the appearance in force. Only reached when
          // the page paints its background some way the probe cannot see.
          function declaredColour() {
            var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            var meta = document.querySelector('meta[name="theme-color"][media*="' + (dark ? 'dark' : 'light') + '"]')
                    || document.querySelector('meta[name="theme-color"]');
            return meta ? (meta.getAttribute('content') || '') : '';
          }

          function report() {
            var rgb = channels(pageBackground()) || channels(declaredColour());
            if (!rgb) { return; }
            try { window.webkit.messageHandlers.\(themeMessageName).postMessage(rgb); } catch (e) {}
          }

          // The app calls this when the appearance changes, which is the one case
          // the observer cannot see: the trait collection moved before the page
          // re-resolved its own palette.
          window.\(themeReportHook) = report;

          report();
          try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', report); } catch (e) {}
          try {
            new MutationObserver(report).observe(document.documentElement, {
              attributes: true,
              attributeFilter: ['data-theme', 'data-theme-mode', 'data-theme-resolved', 'style', 'class']
            });
          } catch (e) {}
        })();
        """
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            themeColour: $themeColour,
            notices: notices,
            connection: connection,
            pairing: pairing,
            gatewayName: gateway.label,
            gatewayId: gateway.id,
            onOpenAppSettings: onOpenAppSettings
        )
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The Control UI plays audio and video in the page. Without this, iOS
        // hands playback to the system player, full screen and outside the page
        // it belongs to.
        configuration.allowsInlineMediaPlayback = true
        // The theme-colour relay, described above. Injected at document end so
        // the page's `theme-color` meta is in the document when it runs.
        let scripts = WKUserContentController()
        scripts.add(context.coordinator, name: Self.themeMessageName)
        scripts.addUserScript(WKUserScript(
            source: Self.themeScript,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        // The client-context hook, and the same bytes the desktop installs: the
        // script is read from core/spec/prompt-metadata.json rather than ported,
        // so the two clients cannot drift into two dialects.
        //
        // At document START, unlike the theme relay above, because it replaces
        // `WebSocket.prototype.send` before the page opens a socket. Installed
        // at the end of the document it would be racing a socket the page had
        // already opened, and the frames it missed would be silent.
        scripts.addUserScript(WKUserScript(
            source: PromptMetadata.installation(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        // The App-settings affordance, the same bytes the desktop installs, read
        // from core/spec/app-settings-affordance.json rather than ported. Its
        // host bridge posts to the handler registered above; open() is wired onto
        // the same global the config sits on. At document START so the bridge is
        // in place before the footer renders, and the script's own DOMContentLoaded
        // guard is what waits for the footer rather than a fixed delay.
        scripts.add(context.coordinator.appSettings, name: AppSettingsBridge.messageName)
        scripts.addUserScript(WKUserScript(
            source: AppSettingsAffordance.installation(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        // The device-identity capture, and the same bytes the desktop's owner
        // holds: the script is read from core/spec/device-identity.json rather
        // than ported, so there is one copy of it. It reads the page's device
        // keypair from localStorage and posts it to the handler registered here
        // whenever it changes, and `DeviceIdentityBridge` writes it to the
        // Keychain, which survives an app uninstall. The seed script that
        // restores it is (re)installed per load in `installNativeAuth`'s
        // neighbour below, at document start, before the page reads the storage
        // key. At document START, before the page constructs its own storage
        // reads, for the same reason the other hooks are.
        let deviceIdentityBridge = DeviceIdentityBridge()
        scripts.add(deviceIdentityBridge, name: DeviceIdentityBridge.messageName)
        scripts.addUserScript(WKUserScript(
            source: DeviceIdentity.captureScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        // The device-pairing observer, and the same bytes a later Android client
        // would run: the script is read from core/spec/pairing.json rather than
        // ported, so there is one copy of it. It wraps the page's `WebSocket` and
        // posts to the handler registered here when the gateway socket opens or
        // closes for a pairing reason, which is the one connection state the
        // navigation delegate cannot see: the page's HTML loaded, so the socket
        // close is an event inside the page. At document START, before the page
        // constructs its socket, for the same reason the client-context hook is;
        // installed later it would wrap a socket the page had already opened.
        scripts.add(context.coordinator.pairingBridge, name: PairingBridge.messageName)
        scripts.addUserScript(WKUserScript(
            source: Pairing.observerScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        // The gateway token, handed to the Control UI the way the page itself
        // expects it: `window.__OPENCLAW_NATIVE_CONTROL_AUTH__`, set at document
        // START, before the page reads it during boot and before it opens its
        // socket. Without this the page authenticates as nobody and the gateway
        // logs `auth=none reason=token_missing`. See `NativeControlAuth`, and
        // `installNativeAuth` below for why it is (re)installed here rather than
        // added once: the token is read fresh on every connect, so a rotated one
        // self-heals and none is ever held in this object.
        //
        // The content controller is kept on the coordinator so the token script
        // can be replaced before each load without rebuilding the web view.
        context.coordinator.contentController = scripts
        Self.installNativeAuth(
            scripts,
            gatewayId: gateway.id,
            previous: &context.coordinator.nativeAuthScript
        )
        Self.installDeviceIdentitySeed(
            scripts,
            previous: &context.coordinator.deviceIdentitySeedScript
        )
        configuration.userContentController = scripts
        // WebKit's default user agent stops at `Mobile/15E148`, which says
        // nothing about which client asked for the page. Naming ourselves is
        // what lets a gateway's own logs tell this app from Safari on the same
        // phone, and the Control UI only ever reads the user agent to detect a
        // legacy browser, so replacing the token is safe as well as useful.
        configuration.applicationNameForUserAgent = "\(Naming.mobileToken)/\(Naming.buildVersion)"

        let webView = WKWebView(frame: .zero, configuration: configuration)
        // Not opaque, and painted with the system background rather than left
        // transparent: a transparent web view shows the window behind it for the
        // frame before the page paints, which reads as a flash of the wrong
        // colour in whichever appearance the user is not in.
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground

        // The appearance the app is in, applied where the page can see it. A
        // WKWebView resolves a page's `prefers-color-scheme` from its own trait
        // collection, so this is the whole of the downward leg: no attribute is
        // written into a page we do not own, and an explicit light or dark here
        // is the same answer the native chrome and the settings surface are
        // wearing. `system` is `.unspecified`, which leaves the trait collection
        // driven by the device, so a live device change still reaches the page.
        webView.overrideUserInterfaceStyle = appearance.userInterfaceStyle

        // `allowsBackForwardNavigationGestures` is deliberately not set. The
        // Control UI is a single-page app, so there is no history worth
        // swiping through, and a swipe that moved the whole app off the page
        // with no visible back button would strand someone in it.
        webView.navigationDelegate = context.coordinator
        return webView
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        // A user content controller keeps its message handlers strongly, so
        // without this the coordinator outlives the view it was made for.
        webView.configuration.userContentController
            .removeScriptMessageHandler(forName: themeMessageName)
        webView.configuration.userContentController
            .removeScriptMessageHandler(forName: AppSettingsBridge.messageName)
        webView.configuration.userContentController
            .removeScriptMessageHandler(forName: PairingBridge.messageName)
        webView.configuration.userContentController
            .removeScriptMessageHandler(forName: DeviceIdentityBridge.messageName)
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // Before the load guard below, because the appearance has to reach a page
        // that is already on screen: changing it in settings must repaint what is
        // in front of you rather than wait for the next navigation. Applied only
        // when it differs from the last one, because this method runs on every
        // layout pass and a script call per pass would be work nobody asked for.
        if context.coordinator.appliedAppearance != appearance {
            context.coordinator.appliedAppearance = appearance
            webView.overrideUserInterfaceStyle = appearance.userInterfaceStyle
            // And told to report again, because the trait collection moved before
            // the page re-resolved its palette: the strips would otherwise keep
            // the previous appearance's colour until something else repainted
            // them. The hook is installed by `themeScript`, and the `&&` is what
            // makes this a no-op on a page that has not run it yet.
            webView.evaluateJavaScript("window.\(Self.themeReportHook) && window.\(Self.themeReportHook)()")
        }

        // The pairing reconnect beat. Before the load guard below, because a
        // reload has to happen even though the URL has not changed: the guard
        // exists to stop a SwiftUI layout pass reloading the page under someone,
        // and a retry is the one time a reload of the same URL is exactly what is
        // wanted. Each new tick reissues the load, which re-runs the page's own
        // connect; the token handoff is reinstalled on that load through the same
        // path a first connect uses, so an approval that also rotated nothing
        // still reconnects cleanly. Guarded on the tick value so a pass that did
        // not carry a new beat does nothing.
        if context.coordinator.appliedRetryTick != pairing.retryTick {
            context.coordinator.appliedRetryTick = pairing.retryTick
            if context.coordinator.requested == gateway.url {
                connection.connecting(gateway.id)
                pairing.connecting()
                if let controller = context.coordinator.contentController {
                    Self.installNativeAuth(
                        controller,
                        gatewayId: gateway.id,
                        previous: &context.coordinator.nativeAuthScript
                    )
                    Self.installDeviceIdentitySeed(
                        controller,
                        previous: &context.coordinator.deviceIdentitySeedScript
                    )
                }
                webView.reload()
            }
        }

        guard context.coordinator.requested != gateway.url else { return }
        context.coordinator.requested = gateway.url
        // Recorded before the load rather than after it, because the settings page
        // shows this row while the load is in flight: a phase set on completion
        // would only ever report the two ends of a connect and never the middle,
        // which is the state someone opening Settings to check is the one they
        // would find missing.
        connection.connecting(gateway.id)
        // The pairing state moves to connecting too, so a reload started by the
        // auto-recovery retry (see `ContentView`) clears any earlier refusal for
        // the duration of the attempt: the screen stays up because the phase is
        // driven by the socket, not by this, but a fresh attempt is honestly
        // "connecting" until the socket says otherwise.
        pairing.connecting()
        // The token handoff is reinstalled before the load, reading the stored
        // token fresh: a token the gateway has since rotated self-heals on the
        // next connect, and none is held between loads. The script runs at
        // document start on the navigation this `load` begins, before the page
        // reads the global and before it opens its socket.
        if let controller = context.coordinator.contentController {
            Self.installNativeAuth(
                controller,
                gatewayId: gateway.id,
                previous: &context.coordinator.nativeAuthScript
            )
            Self.installDeviceIdentitySeed(
                controller,
                previous: &context.coordinator.deviceIdentitySeedScript
            )
        }
        // The plain gateway URL: the credential travels in the injected global,
        // not on the address, so nothing about a real token reaches the
        // navigation URL, a request log or a Referer header.
        webView.load(URLRequest(url: gateway.url))
    }

    /// Read the stored token and (re)install the document-start script that sets
    /// `window.__OPENCLAW_NATIVE_CONTROL_AUTH__`, so the Control UI authenticates
    /// as the operator who entered it.
    ///
    /// The token is read here and used to build the script, then dropped: it is
    /// never held on the coordinator or anywhere else, for the same reason
    /// `SettingsCredentials` hands out no getter, the value exists for the length
    /// of this call. The previous script is removed first so a reconnect does not
    /// stack a second copy that would set the global twice; only the token script
    /// is rebuilt, and the theme, client-context and affordance scripts the
    /// controller also holds are left in place.
    ///
    /// A `WKUserScript` cannot be removed one at a time, so this clears the
    /// controller and re-adds the scripts it should carry. That is why the
    /// controller is asked for its current scripts rather than the caller
    /// tracking every one: the token script is the only one that changes, and the
    /// rest are replayed exactly as they were.
    @MainActor
    static func installNativeAuth(
        _ controller: WKUserContentController,
        gatewayId: String,
        previous: inout WKUserScript?
    ) {
        let token = SettingsCredentials.values(gatewayId).token
        let script = WKUserScript(
            // The device family is read live here, on the main actor, rather than
            // taken from the constant default: an iPad in desktop mode reports the
            // same idiom the browser would, so a paired device reads the same on
            // both. This build is iPhone-only today, so it resolves to iPhone.
            source: NativeControlAuth.installation(
                token: token,
                deviceFamily: NativeControlAuth.currentDeviceFamily()
            ),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        let kept = controller.userScripts.filter { $0 !== previous }
        controller.removeAllUserScripts()
        for existing in kept { controller.addUserScript(existing) }
        controller.addUserScript(script)
        previous = script
    }

    /// Read the persisted device identity from the Keychain and (re)install the
    /// document-start script that seeds it into the page's `localStorage` before
    /// the page boots and reads it.
    ///
    /// This is what makes an approved device STAY approved across a reinstall. The
    /// gateway recognises a paired device by the keypair the page presents, and
    /// the page keeps that keypair in `localStorage`, which a `WKWebView` wipes on
    /// uninstall. The capture handler wrote the page's identity to the Keychain on
    /// a previous run; this restores it, so the reinstalled page presents the same
    /// public key and the gateway does not raise a fresh pairing request. With
    /// nothing captured yet (the first-ever launch) the seed is `null` and does
    /// nothing, and the page mints its own, which the capture then persists.
    ///
    /// Reinstalled per load, the same way and for the same reason as the token
    /// handoff: the identity is read fresh each connect, so a value captured after
    /// the last load is seeded on the next one, and the previous seed script is
    /// removed first rather than stacking a second copy. The seed writes only into
    /// an empty slot (its own guard), so a load whose page already has the
    /// identity is left untouched.
    ///
    /// A `WKUserScript` cannot be removed one at a time, so this clears the
    /// controller and re-adds the scripts it should carry, the same dance
    /// `installNativeAuth` does; only the seed script changes and the rest are
    /// replayed as they were.
    @MainActor
    static func installDeviceIdentitySeed(
        _ controller: WKUserContentController,
        previous: inout WKUserScript?
    ) {
        let identity = DeviceIdentityStore.read()
        let script = WKUserScript(
            source: DeviceIdentity.seedInstallation(identity: identity),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        let kept = controller.userScripts.filter { $0 !== previous }
        controller.removeAllUserScripts()
        for existing in kept { controller.addUserScript(existing) }
        controller.addUserScript(script)
        previous = script
    }
}
