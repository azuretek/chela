import Foundation

/// What a release of this app is called, read from `core/spec/release.json` at
/// runtime.
///
/// The same file is what the release pipeline reads and what the desktop reads,
/// so an install URL built here is built from the names the pipeline actually
/// attached to the release rather than from a second copy of them.
///
/// This is what makes the phone's update actionable without another app in the
/// chain: iOS cannot install a build of itself, but it can ask the system to, and
/// the system reads the OTA manifest on the release. `manifestAsset` and
/// `appAsset` are the names the pipeline gives that pair, which is why they
/// come from the spec and not from this file.
enum Release {
    /// `core/spec/release.json`, in the shape the file already has.
    private struct Spec: Decodable {
        struct Ota: Decodable {
            let urlScheme: String
            let appAsset: String
            let manifestAsset: String
        }

        let tagPrefix: String
        let ota: Ota
    }

    /// What this decodes, and what it does not: `children` is the required
    /// package set the pipeline's own check reads, which no client has a use for.
    static let decodedKeys: Set<String> = ["tagPrefix", "ota"]
    static let ignoredKeys: Set<String> = ["children"]

    private static let spec: Spec = loadSpec()

    private static func loadSpec() -> Spec {
        let empty = Spec(
            tagPrefix: "",
            ota: Spec.Ota(urlScheme: "", appAsset: "", manifestAsset: "")
        )
        guard let spec = try? BundledSpec.load("release", as: Spec.self), !spec.ota.urlScheme.isEmpty else {
            return empty
        }
        return spec
    }

    /// The app asset a release carries for this version.
    static func appAsset(_ version: String) -> String {
        spec.ota.appAsset.replacingOccurrences(of: "{version}", with: version)
    }

    /// The OTA manifest a release carries for this version.
    static func manifestAsset(_ version: String) -> String {
        spec.ota.manifestAsset.replacingOccurrences(of: "{version}", with: version)
    }

    /// The git tag a version is released under.
    static func tag(_ version: String) -> String {
        spec.tagPrefix + version
    }

    /// A release asset's download URL, built the way the pipeline's own
    /// `assetUrl` builds it: the same repo, the same tag, the same file name.
    static func assetUrl(_ version: String, asset: String) -> String {
        "https://github.com/" + Naming.repoOwner + "/" + Naming.repoName
            + "/releases/download/" + tag(version) + "/" + asset
    }

    /// The URL an update opens: the manifest, through the system's own OTA
    /// scheme, so iOS shows one prompt and replaces the app in place.
    static func installUrl(_ version: String) -> String {
        spec.ota.urlScheme + assetUrl(version, asset: manifestAsset(version))
    }
}
