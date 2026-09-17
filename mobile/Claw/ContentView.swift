import SwiftUI
import UIKit

/// The whole app: the Control UI, full screen and nothing else.
///
/// No navigation bar and no tab bar, because the Control UI is the interface
/// and a second set of controls drawn around it would be a second owner of the
/// same job. What is native here is only what has to be: the web view's host, the
/// notice banner, the one control that opens the app's own settings, and the
/// settings page itself when there is no gateway to draw it over.
///
/// ## Where settings live
///
/// `SettingsSurface` is the same page the desktop loads, out of `core/ui`, so
/// there is one implementation of the settings UI rather than one per client. It
/// appears in one of two places, and which one is decided by the same question the
/// desktop asks: is there a gateway to draw it over?
///
/// - **A gateway is configured**, so settings is a sheet over the page, opened by
///   the button in the corner or by the connection notice's own action.
/// - **No gateway is configured**, so there is nothing behind it: the surface IS
///   the app, exactly as the desktop's settings page is the window on a first run.
///   Dismissing it is refused in that state, because behind it is emptiness.
///
/// ## The safe area, and why the page is laid out inside it
///
/// The Control UI declares `viewport-fit=cover` and has safe-area rules of its
/// own, so it expects the whole display and insets its content itself. Those
/// rules sit inside `@media (display-mode: standalone)`, which is the mode a
/// home-screen web app reports. A `WKWebView` inside a native app reports
/// `display-mode: browser`, so none of them applied: the page was drawn from
/// the very top of the screen, under the status bar and the Dynamic Island.
///
/// Measured on an iPhone simulator on 2026-09-15 against the live gateway. The
/// page's first row of content and the Dynamic Island occupied the same band of
/// the screen, with the page starting at y=0. At the other end the composer was
/// inset correctly, because `--safe-area-bottom` is used outside that media
/// query. So the page was half insetting itself, and only the half that showed
/// was the half that did not.
///
/// There is no API that makes a web view report `standalone`, so the app
/// supplies the inset instead: the web view is laid out INSIDE the safe area,
/// which makes the page's own `height: 100dvh` mean the safe height, exactly as
/// it does in the mode the page is written for. The content is where the page
/// intended it and nothing is injected into a page this client does not own.
///
/// What this deliberately is not, and why:
///
/// - **Not injected CSS.** Patching the page's layout from here would couple
///   this client to the gateway's class names, and a page is free to change its
///   own markup at any release. The one script this app does inject reports the
///   page's theme colour and changes nothing about the page.
/// - **Not a content inset on the web view's scroll view.** The page's shell
///   sizes itself with `100dvh`, so a body padding or a scroll inset would push
///   that shell past the bottom edge rather than shrink it, moving the composer
///   off screen to fix the top.
///
/// The strip above and below the page is painted with the page's own
/// background, which it publishes as its `theme-color`; WebView relays that back
/// and this view paints with it. Without that the strips would be the window's
/// colour, and the page would look like it stopped short of the bottom rather
/// than like it filled the screen and inset its own content.
///
/// ## The notice banner
///
/// The notices this client raises are drawn here, as a native SwiftUI overlay
/// above the page rather than as anything the page has to render: a notice is our
/// condition to report, and it has to be visible while the page is broken or
/// absent, which is exactly when the connection notice goes up. An overlay does
/// not change the page's layout, so the Control UI keeps every pixel of the safe
/// area it lays itself out in.
struct ContentView: View {
    /// The gateway list, owned here because this is the view that decides what the
    /// app shows: the page, or the settings surface that asks which gateway to
    /// load.
    @StateObject private var gateways = GatewayStore()

    /// How the one connection is going, for the settings page's gateway rows.
    @StateObject private var connection = ConnectionState()

    /// Whether the gateway is refusing this device until an operator approves it.
    /// Fed by the pairing observer the web view installs, which watches the page's
    /// own gateway socket: a pairing refusal is a socket close inside the page,
    /// not a navigation failure, so it is the one connection state the web view's
    /// navigation delegate cannot see. When this says pairing, the pairing screen
    /// is shown over the page; the moment the socket opens (once approved) it
    /// moves to authenticated on its own and the page comes back. See `Pairing`.
    @StateObject private var pairing = PairingState()

    /// Starts as the system background, which is what shows for the first frame,
    /// before the page has a document to read a colour out of.
    @State private var themeColour = Color(uiColor: .systemBackground)

    /// The one live board. `NoticeBoard.live()` is a plain board in a release
    /// build and a seeded one under `-claw-seed-notices`, which is how the tones
    /// nobody can otherwise reach are rendered for a screenshot.
    @StateObject private var notices = NoticeBoard.live()

    /// The background update checks, on the cadence this build's own version names.
    /// Held rather than built per appearance, because it owns a repeating task: a
    /// second one would double every request for the life of the app. See
    /// `UpdateSchedule` and `UpdateCadence`.
    @State private var updateSchedule: UpdateSchedule?

    /// Whether the app is on screen. A phone app spends most of its life suspended,
    /// where none of our timers run, so the cadence is re-asked here when it comes
    /// back rather than left to a sleep that was frozen with the process.
    @Environment(\.scenePhase) private var scenePhase

    /// Which appearance the app is in, which is this client's to decide and not
    /// the Control UI's: the native chrome here is real (a status bar, a sheet,
    /// the strips the safe area leaves above and below the page) and the page's
    /// `prefers-color-scheme` resolves against the web view's own traits, so the
    /// choice has to live somewhere both halves can read it. See `Appearance`.
    @StateObject private var appearance = AppearanceStore()

    /// Whether the settings sheet is up over a gateway. Ignored while there is no
    /// gateway, where the surface is shown without a sheet: see the note above.
    @State private var showingSettings = false

    /// Whether the About sheet is up. About has no menu bar to open it from on
    /// this client, so it is reached from Settings through the shared `openAbout`
    /// command, and shown as its own sheet over whatever is on screen.
    @State private var showingAbout = false

    /// The page's other end. Built once, held, and handed to the settings web
    /// view: it is the object `core/ui/settings.js` talks to for the whole life of
    /// the surface, and a fresh one per layout pass would drop replies the page is
    /// waiting on.
    @State private var host: SettingsHost?

    /// The handle on the gateway page, held for the one thing our settings surface
    /// asks the page to do itself: open the Control UI's own settings, when the
    /// reader takes that offer. Weak inside, and this object owns only the ask;
    /// see `GatewayPage`.
    @StateObject private var gatewayPage = GatewayPage()

    /// The About page's other end, built once for the same reason `host` is: it is
    /// the object `core/ui/about.js` talks to for the life of the About sheet.
    @State private var aboutHost: AboutHost?

    /// The Control UI's live design tokens, read from the gateway page and handed
    /// to the settings and About surfaces so they wear the interface's own type
    /// and palette rather than the fallback ui.css carries for the case where no
    /// gateway has answered.
    ///
    /// Read rather than relayed. The read is a few milliseconds against a page
    /// that is already loaded, and it is always current, where a relay would carry
    /// a second copy of the palette's state through every launch and have to be
    /// invalidated on the same events anyway.
    @State private var liveTokens: [String: String] = [:]

    private func refreshLiveTokens() {
        gatewayPage.liveTokens { tokens in
            if tokens != liveTokens { liveTokens = tokens }
        }
    }

    /// The sheet-opening half of the refresh, as a method rather than a closure:
    /// see the note where it is attached.
    private func refreshLiveTokensWhenOpening(_ isOpen: Bool) {
        guard isOpen else { return }
        refreshLiveTokens()
    }

    /// The settings sheet's content, and About stacked over it.
    ///
    /// A named builder rather than inline in the modifier chain, because the
    /// type checker refused the whole expression once the token layer added its
    /// arguments: "unable to type-check this expression in reasonable time",
    /// measured on 2026-09-16. The chain is not wrong, it is simply more than the
    /// solver will take in one piece.
    @ViewBuilder
    private func settingsSheetContent(_ host: SettingsHost) -> some View {
        SettingsSurface(host: host, tokens: liveTokens, appearance: appearance.mode)
            // About is presented from the settings surface, so the second sheet
            // stacks over the first the way the desktop's About-over-Settings
            // overlay does, and lands back on settings when dismissed.
            .aboutSheet(
                isPresented: $showingAbout,
                host: aboutHost,
                appearance: appearance.mode,
                tokens: liveTokens,
                notices: notices
            )
    }

    /// The app itself when no gateway is configured: the settings page IS the
    /// surface, with About riding it and the notice stack over both.
    @ViewBuilder
    private func SettingsAsApp(host: SettingsHost) -> some View {
        SettingsSurface(host: host, tokens: liveTokens, appearance: appearance.mode)
            .ignoresSafeArea()
            .aboutSheet(
                isPresented: $showingAbout,
                host: aboutHost,
                appearance: appearance.mode,
                tokens: liveTokens,
                notices: notices
            )
            .noticeBanner(notices)
    }

    var body: some View {
        Group {
            if let gateway = gateways.activeGateway {
                WebView(
                    gateway: gateway,
                    appearance: appearance.mode,
                    themeColour: $themeColour,
                    notices: notices,
                    connection: connection,
                    pairing: pairing,
                    // The App-settings affordance injected into the Control UI's
                    // footer posts here when pressed, and raises the settings
                    // sheet. It is this client's ONLY settings entry: there is no
                    // native control beside it, because the footer bar below is
                    // the interface's own and a second control floating over the
                    // page was reported as an unwanted duplicate.
                    // The App-settings affordance's bridge, plus the page itself:
                    // the handle is for the one action that asks the Control UI to
                    // do something the Control UI owns. See `GatewayPage`.
                    onOpenAppSettings: { showingSettings = true },
                    pageControl: gatewayPage
                )
                .background(themeColour)
                // The pairing screen sits over the page while the gateway is
                // refusing this device. Full cover rather than a banner, because
                // there is no Control UI behind it to reach: the gateway held the
                // socket, and the one thing to do is approve the device on the
                // gateway host. It is removed the instant the socket opens, which
                // the page's own reconnect drives once the device is approved, so
                // recovery needs no relaunch and no button here. The settings
                // button stays reachable above it, since a wrong gateway address
                // is fixed there and a refusal on the wrong host looks the same.
                .overlay {
                    if pairing.isPairing {
                        PairingView(state: pairing, deviceLabel: Self.deviceLabel)
                            .transition(.opacity)
                    }
                }
                .animation(.easeInOut(duration: 0.2), value: pairing.isPairing)
                // The notice stack is the last overlay this branch applies, so
                // no other overlay can be drawn over a card's own dismiss
                // control. Measured on an iPhone 17 simulator on 2026-09-16,
                // where an overlay applied after this one left the first card
                // with no X at all and no way to close a notice.
                .noticeBanner(notices)
                // Settings, and About over it. Both fill the screen, presented the
                // one way this client presents a shared web surface: the surface
                // carries its own safe area, and the sheet is pinned to the whole
                // screen so a page's own height never sizes it. See
                // `fullScreenSurfaceSheet`.
                .fullScreenSurfaceSheet(isPresented: $showingSettings, notices: notices) {
                    if let host { settingsSheetContent(host) }
                }
            } else if let host {
                // No gateway yet, so this IS the app: there is nothing behind it to
                // go back to, and nothing to draw the sheet over. About is still
                // reached from here, so the About sheet rides the surface itself.
                //
                // The notice stack is drawn here too, and that is not symmetry for
                // its own sake: the launch update check runs whether or not a
                // gateway is configured, so a build that finds a release with no
                // gateway set would raise a notice into a board nothing draws.
                SettingsAsApp(host: host)
            } else {
                // One frame, while the host is built in `onAppear`.
                Color(uiColor: .systemBackground)
            }
        }
        // About is presented from the settings surface in each branch above,
        // rather than off the Group here: it is reached from Settings and only
        // from Settings, and a second sheet stacks reliably over the first when it
        // is raised from the presented surface rather than from an ancestor of it.
        // Raised from the Group it was raised from outside the sheet that was on
        // screen, which resolved it to a content-height detent around About's short
        // card. See `aboutSheet` and `fullScreenSurfaceSheet`.
        //
        // The app's own appearance, and it is the whole app rather than the web
        // view: the status bar, the sheet's background and the strips around the
        // page are the native half, and a page passed light while they stayed dark
        // is the disagreement this setting exists to remove. `nil` is `system`,
        // which leaves every one of them following the device live.
        .preferredColorScheme(appearance.mode.colorScheme)
        .onAppear(perform: prepare)
        // The interface's live palette, read when the app appears and re-read
        // whenever the answer can have changed. One concrete modifier rather than
        // four more links on this chain: the chain is already the largest
        // expression in the file, and the type checker refused it once the token
        // layer arrived ("unable to type-check this expression in reasonable
        // time", measured 2026-09-16).
        .modifier(LiveTokenRefresh(
            appearance: appearance.mode,
            showingSettings: $showingSettings,
            showingAbout: $showingAbout,
            refresh: refreshLiveTokens
        ))
        // The page draws a badge per gateway and disables the button under the one
        // already connecting, so it has to be told when the phase moves. Passive
        // rather than polled: this is the view that observes it.
        .onChange(of: connection.phase) { _, _ in host?.emit("state") }
        // The cadence, asked again when the app comes back. A suspended process
        // runs no timers of ours, so this is where a phone that has been in a pocket
        // overnight catches up, and a check is run only when the interval has really
        // elapsed, so returning to the app repeatedly is not a burst of requests.
        // See `UpdateSchedule.becameActive`.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { updateSchedule?.becameActive() }
        }
        // The gateway row follows the pairing state, and this is where the two are
        // joined. An unapproved device is `pending` (the page loaded, the gateway
        // is holding the session), and only a socket that survived its settle
        // window is a genuine connect. Without this the row said "Connected" for a
        // device the gateway was refusing, and the retry cadence made it flicker
        // between the two every few seconds. The MOVES are the shared reducer's
        // (see `ConnectionState.nextPhase`), so this view only reports what
        // happened.
        .onChange(of: pairing.phase) { _, phase in
            switch phase {
            case .pairingRequired:
                if let id = gateways.activeGateway?.id { connection.pending(id) }
            case .authenticated:
                connection.confirm()
            default:
                break
            }
        }
        // A REVOKED session goes to the gateway list rather than stopping at the
        // pairing screen. A first connection is a setup problem and the pairing
        // screen is the whole answer; the SAME close arriving at a session that was
        // working means the device is still pointed at a gateway that no longer
        // accepts it, so the reader is taken to the surface that shows which
        // gateway that is, with the row now saying the device needs approval. The
        // rule and the route name come from the shared contract, and the pairing
        // screen is still there behind this sheet with the approve command.
        .onChange(of: pairing.route) { _, route in
            if route == Pairing.routeSettingsGateways { showingSettings = true }
        }
        // The notice log is the desktop's Problems tab, which this client does not
        // have. Raised anyway, because a host that never raises an event the spec
        // declares is a page left showing what it read at load.
        .onChange(of: notices.unread) { _, _ in host?.emit("notices") }
    }

    private func prepare() {
        if host == nil {
            host = SettingsHost(
                store: gateways,
                connection: connection,
                notices: notices,
                appearance: appearance,
                // Closing is only ever a way back to a gateway, so it is refused
                // while there is none: with an empty list the surface is the app.
                onClose: { if gateways.hasGateway { showingSettings = false } },
                // Connect is the one command that leaves the surface. On a phone
                // the sheet covers the page it just switched to, so a failure would
                // be raised behind it, and the point of pressing Connect is to see
                // the result.
                onConnect: { if gateways.hasGateway { showingSettings = false } },
                // Opens the About page over the settings surface, the phone's
                // showAbout(). A sheet over a sheet: SwiftUI presents it above the
                // settings one that asked for it, and dismissing it lands back on
                // settings, which is where the desktop's About-over-Settings
                // overlay lands too.
                onOpenAbout: { showingAbout = true },
                // "Go to the Control UI": ask the page for its OWN settings, and
                // dismiss this sheet only once the destination is on screen, which
                // is what the card promises. Both halves in one closure, because
                // the order is the action, and the order used to be the wrong way
                // round: dismissing first returned the reader to the gateway page
                // for the whole of the Control UI's load, so they watched a page
                // they had not asked for before the settings page arrived. The
                // dismissal is unconditional inside the completion, so the sheet
                // still goes away on every path that cannot reach the destination.
                onOpenControlUiSettings: {
                    gatewayPage.openControlUiSettings { showingSettings = false }
                }
            )
        }
        if aboutHost == nil {
            // Closing is the page's `closeOverlay('about')`: on the phone that is
            // dismissing the sheet, which lands back on whatever opened it.
            aboutHost = AboutHost(
                notices: notices,
                onClose: { showingAbout = false },
                // The same seeded-or-real check the launch uses, so a screenshot
                // run's press answers about the same feed its banner is under.
                makeCheck: { Self.updateCheck(board: notices) },
                // Clear this app's cached Control UI code and reload the session.
                // Wired here rather than inside the About host because the thing
                // that reloads is the GATEWAY page, which lives in the session
                // and not in the sheet: the host owns a page, not a web view, and
                // a host that reached across would be a second owner of it.
                clearCacheAndReload: { await gatewayPage.clearCacheAndReload() }
            )
        }
        // The notice model carries a command NAME rather than a callback, so this
        // is where the commands this client has are answered. "Open Settings" on a
        // failed connection lands on the surface that can fix the address, and the
        // update notice's action opens TestFlight, which is where a newer build
        // waits: iOS cannot install its own update, so the honest offer is to send
        // the user to where the build is rather than to download anything here.
        notices.onCommand = { command in
            switch command {
            case NoticeBoard.settingsCommand:
                showingSettings = true
            case UpdateCheck.openTestFlightCommand:
                // Into TestFlight, and on to its App Store page when TestFlight is
                // not on this phone: `TestFlight.open` is the platform's opener and
                // reads its answer rather than assuming either one worked. Detached
                // because the command handler is synchronous and the opener is not,
                // and nothing waits on the result: the notice stays up until the
                // build is actually installed.
                Task { await TestFlight.open() }
            default:
                break
            }
        }
        // A screenshot run on a simulator, which cannot press the button above.
        // Debug only, and inert without the argument. See `SettingsSpec`.
        if SettingsSpec.screenshotOpensSettings { showingSettings = true }
        // The About route, driven the way the Settings button drives it: open
        // Settings, then open About over it, which is the stack a tap produces.
        // A simulator cannot be tapped, so this proves the real route rather than
        // loading the page on its own. Debug only, inert without the argument.
        //
        // About is presented from the settings surface now, so it needs Settings
        // up first: showing both in one render pass lands the second empty, so
        // Settings is opened here and About on the next runloop tick, once the
        // first sheet is on screen. This is the real presenter and the real
        // `showingAbout` the About card sets, so a screenshot proves the actual
        // About-over-Settings stack rather than a page loaded on its own.
        if SettingsSpec.screenshotOpensAbout {
            showingSettings = true
            DispatchQueue.main.async { showingAbout = true }
        }
        // A screenshot run that presses the About page's Check for updates, which
        // a simulator cannot tap. The launch check is a background one and is
        // silent when it finds nothing, so the "this build is current" answer only
        // exists after a press: without this the direction the report was about
        // could not be shown at all. Drives the real command the page's button
        // posts, through the real check and the real notice, so what is drawn is
        // the answer rather than a seeded banner. Debug only, inert without the
        // argument. See `SettingsSpec`.
        // Wrapped, because the method it drives is DEBUG-only: `pressCheckForUpdates`
        // exists under `#if DEBUG` in AboutHost, where `SettingsSpec` compiles the
        // flag itself out to `false` in a release build rather than out of the
        // file. Unwrapped, the flag still resolves and the call does not, so this
        // line compiled in Debug and failed only in the Release archive with
        // "value of type 'AboutHost' has no member 'pressCheckForUpdates'", which
        // is a red iOS release that no simulator test can see. The other
        // screenshot blocks in this file that reach DEBUG-only API carry the same
        // guard.
        #if DEBUG
        if SettingsSpec.screenshotChecksUpdates {
            showingSettings = true
            DispatchQueue.main.async {
                showingAbout = true
                // After the About sheet is on screen: a press before the page has
                // laid out would have nothing to refresh and nothing to sit over.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    let host = aboutHost
                    Task { await host?.pressCheckForUpdates() }
                }
            }
        }
        #endif
        // A screenshot run that presses the update notice's own action. The card's
        // button reaches the command through `notices.run`, which is the call this
        // makes, so what the run exercises is the real route minus the tap: the
        // real opener, the real fallback and the app's own log of both. Debug only,
        // inert without the argument. See `SettingsSpec`.
        if SettingsSpec.screenshotOpensTestFlight {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                notices.run(UpdateCheck.openTestFlightCommand)
            }
        }
        // A screenshot run for the pairing screen, which a simulator cannot reach
        // without the gateway's own token and an unapproved device on a running
        // gateway. Drives the REAL pairing state into pairing-required with a
        // sample refusal, which arms the real retry timer and draws the real
        // `PairingView`, so what a screenshot proves is the actual screen holding
        // steady across retries. Debug only, inert without the argument, and it
        // needs a gateway to draw over, which a screenshot run supplies with
        // `-claw-gateway-url`. See `SettingsSpec`.
        #if DEBUG
        if SettingsSpec.screenshotSeedsPairing {
            pairing.closed(SettingsSpec.screenshotPairingRefusal)
        }
        // A DEVICE THAT WAS WORKING AND HAD ITS APPROVAL REVOKED, which is the
        // same 1008 close entered from an established session rather than from a
        // first connect, and the one state a screenshot run cannot otherwise
        // reach. Drives the real `PairingState` through the real moves (an
        // authenticated session, then the refusal), so the route it produces and
        // the surface it opens are the ones the app would take. Debug only, inert
        // without the argument. See `SettingsSpec`.
        if SettingsSpec.screenshotSeedsRevocation {
            pairing.opened()
            pairing.closed(SettingsSpec.screenshotPairingRefusal)
        }
        #endif
        // Look for a newer build now, and keep looking on this build's own
        // cadence. Every background non-answer is silent (see `UpdateCheck.run`),
        // so a slow or unreachable feed neither blocks the first frame nor puts
        // anything on screen; only a genuinely newer version raises the banner.
        //
        // ★ Once per launch was the whole of this until now, and that is the report
        // it answers: a phone app is resident for days, so a release published after
        // the launch check was invisible until somebody pressed Check for updates.
        // Both halves come from the same builder (see `updateCheck`), so a
        // screenshot run's scheduled raise is drawn from the same feed its launch
        // banner was.
        if updateSchedule == nil {
            let schedule = UpdateSchedule(makeCheck: { Self.updateCheck(board: notices) })
            updateSchedule = schedule
            schedule.start()
        }
    }

    /// Kick off the once-per-launch update check.
    ///
    /// The real check fetches the public feed; a screenshot run hands it a seeded
    /// feed body instead, through the same `UpdateFeed` reader and the same raiser,
    /// so what a screenshot exercises is the real notice rather than a mock. That
    /// is what lets the two banner screenshots (a newer version, and one that
    /// matches this build) be produced without a live release or a real network.
    /// The device this build reports, for the pairing screen to show beside the
    /// request id. The same hardware identifier the client-context block uses,
    /// which names a model rather than a person and is what the kernel reports, so
    /// an operator reading `openclaw devices list` on the host can line the two up.
    /// Built once: it cannot change while the app runs.
    static let deviceLabel: String = PromptMetadata.machineIdentifier()

    /// The update check this run should use, real or seeded.
    ///
    /// One builder rather than two, because the launch check and a press on the
    /// About page have to read the SAME feed: a screenshot run that seeded one and
    /// not the other would show a press answering about a different world than the
    /// banner it is sitting under.
    ///
    /// The real check fetches the public feed; a screenshot run hands it
    /// `UpdateCheck.seededFeed` instead, through the same `UpdateFeed` reader and
    /// the same raiser, so what a screenshot exercises is the real notice rather
    /// than a mock. That is what lets both banner screenshots (a newer version, and
    /// this build being current) be produced without a live release or a real
    /// network. Static and board-passed rather than a method on the view, so the
    /// closure `AboutHost` holds captures the board and not a copy of a value-type
    /// view.
    static func updateCheck(board: NoticeBoard) -> UpdateCheck {
        #if DEBUG
        if let advertised = SettingsSpec.screenshotUpdateFeedVersion {
            // A document naming the version the launch argument gave, handed to the
            // real check as if fetched, against a fixed dev build so the channel
            // gate and the comparison are deterministic. A version equal to
            // `screenshotCurrentVersion` is the "nothing newer" case and a higher
            // one is the "a release exists" case.
            return UpdateCheck(
                board: board,
                currentVersion: SettingsSpec.screenshotCurrentVersion,
                fetch: { _ in UpdateCheck.seededFeed(advertising: advertised) }
            )
        }
        #endif
        return UpdateCheck(board: board)
    }


}

/// How this client presents a shared web surface as a sheet, in one place so
/// every sheet is presented the same way.
///
/// Settings and About are the two, and they are the same kind of thing: a shared
/// `core/ui` page in a web view that lays itself out edge to edge and insets its
/// own content from the safe area. So each wants the whole screen, the way the
/// desktop gives each of them the whole window, rather than a sheet sized to the
/// height of whatever the page happens to draw.
///
/// A plain `.sheet` gives the whole screen at the top level, which is why Settings
/// filled it. About did not, because it was raised while Settings was already a
/// sheet, and a sheet presented from within a sheet resolves to a content-height
/// detent unless it is told otherwise: About's card is short, so the sheet came
/// out mid-height around it. `.presentationDetents([.large])` is what says "the
/// whole screen" regardless of the content or of what is already presented, so
/// pinning it here makes About fill the screen the same way Settings does and
/// keeps the two from ever drifting apart again.
///
/// `.ignoresSafeArea()` is part of the same one way: the page carries the safe
/// area itself (see `SettingsSurface`), so the sheet must not inset it a second
/// time.
///
/// The notice stack rides HERE rather than only on the page, and this is the
/// second half of the stacking fix. A sheet is its own presentation layer: it is
/// presented over the view that asked for it, so an overlay on that view is
/// behind the sheet no matter what order the overlays were applied in. That is
/// how a notice could be raised and drawn while the surface it was raised from was
/// the only thing on screen. Drawing the stack inside the sheet puts it above the
/// surface, and `aboutSheet` routes through this same modifier, so About over
/// Settings is covered without a third copy. One modifier, applied at each layer
/// boundary, rather than a height or a z-index nudged on the card.
/// Read the interface's live palette at the moments it can have changed.
///
/// A modifier rather than links on `ContentView`'s chain, for the reason the chain
/// notes: the appearance moves the Control UI's own palette, so a map read in one
/// mode is the wrong map in the other, and either surface opening is the moment it
/// is about to be used, but four more `onChange` links on that expression is more
/// than the solver will take.
private struct LiveTokenRefresh: ViewModifier {
    let appearance: AppearanceMode
    @Binding var showingSettings: Bool
    @Binding var showingAbout: Bool
    let refresh: () -> Void

    func body(content: Content) -> some View {
        content
            .onAppear(perform: refresh)
            .onChange(of: appearance) { _, _ in refresh() }
            .onChange(of: showingSettings) { _, isOpen in if isOpen { refresh() } }
            .onChange(of: showingAbout) { _, isOpen in if isOpen { refresh() } }
    }
}

private struct FullScreenSurfaceSheet<Surface: View>: ViewModifier {
    @Binding var isPresented: Bool
    let notices: NoticeBoard
    @ViewBuilder let surface: () -> Surface

    func body(content: Content) -> some View {
        content.sheet(isPresented: $isPresented) {
            surface()
                .ignoresSafeArea()
                .presentationDetents([.large])
                .noticeBanner(notices)
        }
    }
}

extension View {
    /// Present `surface` as a sheet that fills the screen. The one way this client
    /// presents a shared web surface; see `FullScreenSurfaceSheet`.
    func fullScreenSurfaceSheet<Surface: View>(
        isPresented: Binding<Bool>,
        notices: NoticeBoard,
        @ViewBuilder surface: @escaping () -> Surface
    ) -> some View {
        modifier(FullScreenSurfaceSheet(isPresented: isPresented, notices: notices, surface: surface))
    }

    /// Present the About surface as a full-screen sheet over the settings surface.
    ///
    /// Attached to the settings surface rather than to an ancestor, so About is the
    /// second sheet over the first the way the desktop stacks About over Settings,
    /// and fills the screen the same way. A nil host draws nothing, which is the one
    /// frame before `onAppear` builds it.
    ///
    /// A concrete modifier rather than the generic `fullScreenSurfaceSheet` it is
    /// modelled on, because this one carries five things into the sheet and the
    /// type checker gave up on the generic form once the token layer arrived:
    /// "unable to type-check this expression in reasonable time", measured on
    /// 2026-09-16. One owner for the stacking, and a shape the solver accepts.
    func aboutSheet(
        isPresented: Binding<Bool>,
        host: AboutHost?,
        appearance: AppearanceMode,
        tokens: [String: String],
        notices: NoticeBoard
    ) -> some View {
        modifier(AboutSheetModifier(
            isPresented: isPresented,
            host: host,
            appearance: appearance,
            tokens: tokens,
            notices: notices
        ))
    }
}

/// About over Settings, as one modifier: see `aboutSheet`.
private struct AboutSheetModifier: ViewModifier {
    @Binding var isPresented: Bool
    let host: AboutHost?
    let appearance: AppearanceMode
    let tokens: [String: String]
    let notices: NoticeBoard

    func body(content: Content) -> some View {
        content.sheet(isPresented: $isPresented) {
            if let host {
                AboutSurface(host: host, appearance: appearance, tokens: tokens)
                    .ignoresSafeArea()
                    .presentationDetents([.large])
                    .noticeBanner(notices)
            }
        }
    }
}

/// Draw the notice banner over whatever this view is.
///
/// ONE modifier, applied at each layer boundary where the banner has to be on top,
/// rather than a copy of `NoticeStack` per surface: the page, the settings sheet
/// and the About sheet each own a layer, and a banner is only above everything if
/// it is drawn in the topmost layer that is actually on screen.
///
/// It stays an overlay rather than becoming part of any page's layout: a notice is
/// this client's condition to report, it has to be visible while the page behind
/// it is broken or absent, and an overlay changes no layout underneath it. The
/// stack itself is as tall as its cards and no taller, so every touch outside them
/// still reaches the surface below. See `NoticeStack`.
private struct NoticeBanner: ViewModifier {
    let board: NoticeBoard

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) { NoticeStack(board: board) }
    }
}

extension View {
    /// Draw `board`'s unread notices over this view, at the top.
    func noticeBanner(_ board: NoticeBoard) -> some View {
        modifier(NoticeBanner(board: board))
    }
}

#Preview {
    ContentView()
}
