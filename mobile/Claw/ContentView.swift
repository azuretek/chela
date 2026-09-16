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

    /// Starts as the system background, which is what shows for the first frame,
    /// before the page has a document to read a colour out of.
    @State private var themeColour = Color(uiColor: .systemBackground)

    /// The one live board. `NoticeBoard.live()` is a plain board in a release
    /// build and a seeded one under `-claw-seed-notices`, which is how the tones
    /// nobody can otherwise reach are rendered for a screenshot.
    @StateObject private var notices = NoticeBoard.live()

    /// Which appearance the app is in, which is this client's to decide and not
    /// the Control UI's: the native chrome here is real (a status bar, a sheet,
    /// the strips the safe area leaves above and below the page) and the page's
    /// `prefers-color-scheme` resolves against the web view's own traits, so the
    /// choice has to live somewhere both halves can read it. See `Appearance`.
    @StateObject private var appearance = AppearanceStore()

    /// Whether the settings sheet is up over a gateway. Ignored while there is no
    /// gateway, where the surface is shown without a sheet: see the note above.
    @State private var showingSettings = false

    /// The page's other end. Built once, held, and handed to the settings web
    /// view: it is the object `core/ui/settings.js` talks to for the whole life of
    /// the surface, and a fresh one per layout pass would drop replies the page is
    /// waiting on.
    @State private var host: SettingsHost?

    var body: some View {
        Group {
            if let gateway = gateways.activeGateway {
                WebView(
                    gateway: gateway,
                    appearance: appearance.mode,
                    themeColour: $themeColour,
                    notices: notices,
                    connection: connection,
                    // The App-settings affordance injected into the Control UI's
                    // footer posts here when pressed, and raises the same sheet the
                    // corner button does. The corner button stays as the fallback
                    // route that does not depend on the injected node existing.
                    onOpenAppSettings: { showingSettings = true }
                )
                .background(themeColour)
                .overlay(alignment: .top) { NoticeStack(board: notices) }
                .overlay(alignment: .topTrailing) { SettingsButton { showingSettings = true } }
                .sheet(isPresented: $showingSettings) {
                    if let host {
                        SettingsSurface(host: host, appearance: appearance.mode)
                            // The page is a settings form inside a sheet, so it is
                            // the surface that carries the safe area rather than the
                            // sheet's own inset: the card's padding is measured from
                            // the page edge, and insetting twice would pull it in
                            // from both.
                            .ignoresSafeArea()
                    }
                }
            } else if let host {
                // No gateway yet, so this IS the app: there is nothing behind it to
                // go back to, and nothing to draw the sheet over.
                SettingsSurface(host: host, appearance: appearance.mode)
                    .ignoresSafeArea()
            } else {
                // One frame, while the host is built in `onAppear`.
                Color(uiColor: .systemBackground)
            }
        }
        // The app's own appearance, and it is the whole app rather than the web
        // view: the status bar, the sheet's background and the strips around the
        // page are the native half, and a page passed light while they stayed dark
        // is the disagreement this setting exists to remove. `nil` is `system`,
        // which leaves every one of them following the device live.
        .preferredColorScheme(appearance.mode.colorScheme)
        .onAppear(perform: prepare)
        // The page draws a badge per gateway and disables the button under the one
        // already connecting, so it has to be told when the phase moves. Passive
        // rather than polled: this is the view that observes it.
        .onChange(of: connection.phase) { _, _ in host?.emit("state") }
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
                onConnect: { if gateways.hasGateway { showingSettings = false } }
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
                UIApplication.shared.open(UpdateCheck.testFlightURL)
            default:
                break
            }
        }
        // A screenshot run on a simulator, which cannot press the button above.
        // Debug only, and inert without the argument. See `SettingsSpec`.
        if SettingsSpec.screenshotOpensSettings { showingSettings = true }
        // Look for a newer build once per launch, against the public feed. It is
        // detached and every non-answer is silent (see `UpdateCheck.run`), so a
        // slow or unreachable feed neither blocks the first frame nor puts
        // anything on screen; only a genuinely newer version raises the banner.
        startUpdateCheck()
    }

    /// Kick off the once-per-launch update check.
    ///
    /// The real check fetches the public feed; a screenshot run hands it a seeded
    /// feed body instead, through the same `UpdateFeed` reader and the same raiser,
    /// so what a screenshot exercises is the real notice rather than a mock. That
    /// is what lets the two banner screenshots (a newer version, and one that
    /// matches this build) be produced without a live release or a real network.
    private func startUpdateCheck() {
        let check: UpdateCheck
        #if DEBUG
        if let advertised = SettingsSpec.screenshotUpdateFeedVersion {
            // The seeded feed: a document naming the version the launch argument
            // gave, handed to the real check as if fetched, against a fixed dev
            // build so the channel gate and the comparison are deterministic. A
            // version equal to `screenshotCurrentVersion` produces no banner (the
            // "absent when it matches" case); a newer one produces it (the
            // "appears when newer" case). Both go through the real `UpdateFeed`
            // reader and the real raiser, so what a screenshot draws is the notice
            // and not a mock of it.
            let body = Data(#"{"version":"\#(advertised)"}"#.utf8)
            check = UpdateCheck(
                board: notices,
                currentVersion: SettingsSpec.screenshotCurrentVersion,
                fetch: { _ in body }
            )
        } else {
            check = UpdateCheck(board: notices)
        }
        #else
        check = UpdateCheck(board: notices)
        #endif
        Task { await check.run() }
    }
}

#Preview {
    ContentView()
}
