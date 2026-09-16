import Foundation

/// What this product is called, mirrored from `core/spec/naming.json`.
///
/// The same spec is what the desktop reads at runtime (`core/naming.js`), so the
/// two clients cannot disagree about what the app is called or how it names
/// itself to the gateway: `NamingParityTests` asserts every value below against
/// the spec file, and also asserts the two names in `Info.plist` against it, since
/// those are the ones a person actually sees on the home screen. That test is the
/// contract. Change a value in the spec, and this file is what has to move.
///
/// The Swift does not read the spec at runtime, for the same reason the token
/// mirror does not: a shipped app cannot read a file that lives in the repo, and
/// a bundled second copy would be a third thing to keep in step.
///
/// Foundation only, and no logic: a name is a string, and a string that decides
/// what a home screen says is worth no cleverness at all.
enum Naming {
    /// What a person calls this app. Fifteen characters, which is longer than
    /// iOS draws under an icon, so Springboard shows it truncated and TestFlight
    /// shows it whole. `Info.plist` carries the same value for both plist keys.
    static let product = "Claw Control UI"

    /// The per-client shorthand, for anything that has to tell this client apart
    /// from the desktop in one string: a User-Agent token is the only such place
    /// here, and the desktop's equivalent is `claw-desktop`.
    static let mobileToken = "claw-mobile"

    /// The repo slug, mirrored from `spec/naming.json`'s `repo`. It is what the
    /// public update feed URL is built from (`UpdateFeed.feedURL`), the same way
    /// the desktop builds `releasesUrl` from `repo` in `core/naming.js`. A rename
    /// moves it here and in the spec together, and `NamingParityTests` is what
    /// fails if only one moves.
    static let repoOwner = "azuretek"
    static let repoName = "claw-control-ui"

    /// How this client names itself where a person and a machine both read it.
    ///
    /// The product makes it recognisable in a transcript and the shorthand tells
    /// it apart from the desktop in the same one, which is the pair the desktop
    /// composes too (`clientLabel` in `core/naming.js`). This is the value the
    /// prompt block carries in its `client:` field.
    static let clientLabel = "\(product) (\(mobileToken))"

    /// The app's own identity for this build, read from the bundle rather than
    /// written twice: the release workflow derives the value and `project.yml`
    /// names the setting it arrives in.
    ///
    /// The full identity rather than `CFBundleShortVersionString`, because that
    /// one is trimmed to the three integers App Store Connect accepts and so
    /// cannot name a dev build: every build of a patch cycle carries the same
    /// `1.0.1`. This is what lets a gateway's own logs tell one build of the app
    /// from the next, it is the token in the User-Agent, and it is the value the
    /// update check will compare against a feed. The fallback is for a build the
    /// workflow did not stamp.
    static var buildVersion: String {
        if let identity = Bundle.main.object(forInfoDictionaryKey: "ClawBuildVersion") as? String,
           !identity.isEmpty {
            return identity
        }
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }
}
