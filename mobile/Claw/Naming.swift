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
}
