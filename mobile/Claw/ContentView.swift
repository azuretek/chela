import SwiftUI

/// The whole app: the Control UI, full screen and nothing else.
///
/// No navigation bar and no tab bar, because the Control UI is the interface
/// and a second set of controls drawn around it would be a second owner of the
/// same job. What is native here is only what has to be: the web view's host,
/// and later the loading and failure surfaces, which are overlays *over* the
/// page rather than chrome beside it.
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
    /// Where this device's gateway comes from, owned here because this is the
    /// view that decides what the app shows: the page, or the question of which
    /// gateway to load.
    @StateObject private var gateways = GatewayStore()

    /// Starts as the system background, which is what shows for the first frame,
    /// before the page has a document to read a colour out of.
    @State private var themeColour = Color(uiColor: .systemBackground)

    /// The one live board. `NoticeBoard.live()` is a plain board in a release
    /// build and a seeded one under `-claw-seed-notices`, which is how the tones
    /// nobody can otherwise reach are rendered for a screenshot.
    @StateObject private var notices = NoticeBoard.live()

    /// Whether someone has asked for the gateway setup surface over a gateway
    /// that is already configured. The connection notice's own action is what
    /// turns it on, so an address that stopped working is correctable in the app
    /// rather than by reinstalling it.
    @State private var editingGateway = false

    var body: some View {
        Group {
            if let gateway = gateways.gateway, !editingGateway {
                WebView(gateway: gateway, themeColour: $themeColour, notices: notices)
                    .background(themeColour)
                    .overlay(alignment: .top) { NoticeStack(board: notices) }
            } else {
                GatewaySetupView(store: gateways) { editingGateway = false }
            }
        }
        .onAppear {
            // The notice model carries a command NAME rather than a callback, so
            // this is where the one command this client has is answered.
            notices.onCommand = { command in
                if command == NoticeBoard.settingsCommand { editingGateway = true }
            }
        }
    }
}

#Preview {
    ContentView()
}
