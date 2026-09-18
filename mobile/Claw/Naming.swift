import Foundation

/// What this product is called, read from `core/spec/naming.json` at runtime.
///
/// The same file is what the desktop reads (`core/naming.js`), so the two
/// interfaces cannot disagree about what the app is called or how it names itself
/// to a gateway. `project.yml` copies the spec in as a resource and this reads
/// it, which is the one pattern for every spec the app shares: no value below is
/// written down twice, so there is no copy to drift.
///
/// `NamingParityTests` asserts every value here against the repository's copy,
/// and also asserts the two names in `Info.plist` against it, since those are
/// the ones a person actually sees on a home screen and a plist cannot import
/// anything.
///
/// Foundation only, and no logic: a name is a string, and a string that decides
/// what a home screen says is worth no cleverness at all.
enum Naming {
    /// `core/spec/naming.json`, in the shape the file already has.
    private struct Spec: Decodable {
        struct Repo: Decodable {
            let owner: String
            let name: String
        }

        struct Client: Decodable {
            let shorthand: String
        }

        struct Clients: Decodable {
            let desktop: Client
            let mobile: Client
        }

        let product: String
        let repo: Repo
        let clients: Clients
    }

    /// The top-level keys this decodes. `BundledSpecTests` asserts they are the
    /// keys the file carries: a key the file gains and this does not name is a
    /// value the app silently does not have.
    static let decodedKeys: Set<String> = ["product", "repo", "clients"]

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(
            product: "",
            repo: Spec.Repo(owner: "", name: ""),
            clients: Spec.Clients(
                desktop: Spec.Client(shorthand: ""),
                mobile: Spec.Client(shorthand: "")
            )
        )
        guard let spec = try? BundledSpec.load("naming", as: Spec.self), !spec.product.isEmpty else {
            return empty
        }
        return spec
    }

    /// What a person calls this app. Longer than iOS draws under an icon, so
    /// Springboard shows it truncated and TestFlight shows it whole.
    /// `Info.plist` carries the same value for both plist keys.
    static var product: String { spec.product }

    /// The per-client shorthand, for anything that has to tell this client apart
    /// from the desktop in one string: a User-Agent token is the only such place
    /// here, and the desktop's equivalent is `claw-desktop`.
    static var mobileToken: String { spec.clients.mobile.shorthand }

    /// The repo slug, which is what the public update feed URL is built from
    /// (`UpdateFeed.feedURL`), the same way the desktop builds `releasesUrl`
    /// from `repo` in `core/naming.js`.
    static var repoOwner: String { spec.repo.owner }
    static var repoName: String { spec.repo.name }

    /// How this client names itself where a person and a machine both read it.
    ///
    /// The product makes it recognisable in a transcript and the shorthand tells
    /// it apart from the desktop in the same one, which is the pair the desktop
    /// composes too (`clientLabel` in `core/naming.js`). This is the value
    /// the prompt block carries in its `client:` field.
    static var clientLabel: String { product + " (" + mobileToken + ")" }

    /// The app's own identity for this build, read from the bundle rather than
    /// written twice: the release workflow derives the value and `project.yml`
    /// names the setting it arrives in.
    ///
    /// The full identity rather than `CFBundleShortVersionString`, because that
    /// one is trimmed to the three integers App Store Connect accepts and so
    /// cannot name a dev build: every build of a patch cycle carries the same
    /// `1.0.1`. This is what lets a gateway's own logs tell one build of the app
    /// from the next, it is the token in the User-Agent, and it is the value the
    /// update check compares against a feed. The fallback is for a build the
    /// workflow did not stamp.
    static var buildVersion: String {
        if let identity = Bundle.main.object(forInfoDictionaryKey: "ClawBuildVersion") as? String,
           !identity.isEmpty {
            return identity
        }
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }
}
