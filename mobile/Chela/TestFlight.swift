import UIKit

/// The one action that leaves this app: send someone into TestFlight, which is
/// where a newer build of this app is actually installed.
///
/// Why a web page was the wrong answer. `https://testflight.apple.com/` is the
/// public landing page: on a phone that already has TestFlight it is a page ABOUT
/// TestFlight rather than the app the reader was just told to update, and on a
/// phone that does not have it there is nothing on that page to press either. So
/// the journey dead-ended on the web, twice over.
///
/// Two halves to using the platform's own mechanism here, and both matter:
///
/// - **The URL the platform routes.** `itms-beta://` is TestFlight's own scheme,
///   and `UIApplication.open` is the router that hands a URL to whichever app
///   claims it. This file does NOT ask whether TestFlight is installed first:
///   that would mean a `canOpenURL` probe, which needs the scheme declared in
///   `LSApplicationQueriesSchemes`, and a permission question about a scheme we
///   do not own. It opens, and reads the answer.
/// - **The answer.** `open`'s completion reports whether anything claimed the
///   URL, so a phone without TestFlight is a case the system tells us about
///   rather than one we guess at. That is what the fallback is built on: when the
///   app will not open, the next offer is TestFlight's own App Store page, which
///   is the one page a person with no TestFlight can act from. Install it, and the
///   build they were told about is waiting inside it.
///
/// What is deliberately not here: a TestFlight public invite link
/// (`https://testflight.apple.com/join/<code>`). That is the best URL of the
/// three when an app has one, because it routes into TestFlight by universal link
/// and still lands on a useful page when it cannot. This app is distributed to
/// internal testers and App Store Connect has published no such code, so there is
/// no link to name yet; when one exists it belongs ahead of `appURL` below.
@MainActor
enum TestFlight {
    /// TestFlight's own scheme. The trailing `//` is part of it: a scheme with no
    /// authority is not a URL the opener will accept.
    static let appURL = URL(string: "itms-beta://")!

    /// TestFlight's App Store page: the fallback, and the reason it is this page
    /// rather than any web page is that a person with no TestFlight can act on it.
    /// The id is Apple's for the app, not ours, so it is a constant rather than
    /// anything derived from `Naming`.
    static let installURL = URL(string: "https://apps.apple.com/app/testflight/id899247664")!

    /// How a URL reaches the system. Injected so the order of the two attempts and
    /// what happens when the first one is refused are testable without a device,
    /// and so the real one is the only thing that touches UIKit.
    typealias Open = @MainActor (URL) async -> Bool

    /// The real opener: the platform's own router, which knows which app claims
    /// which URL and answers whether it found one.
    static func systemOpen(_ url: URL) async -> Bool {
        await UIApplication.shared.open(url)
    }

    /// Send the reader where the build is. Returns the URL that was accepted, or
    /// nil when none was, which is logged rather than swallowed: a button that
    /// does nothing is the failure this whole change is about, so the one case
    /// where nothing can be done says so in the log.
    @discardableResult
    static func open(_ opener: Open = systemOpen) async -> URL? {
        if await opener(appURL) { return appURL }
        NSLog("[claw] TestFlight did not open, so offering its App Store page")
        if await opener(installURL) { return installURL }
        NSLog("[claw] neither TestFlight nor its App Store page could be opened")
        return nil
    }
}
