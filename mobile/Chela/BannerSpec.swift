import Foundation

/// The notice banner's shared facts, read from the app's own copy of
/// `core/spec/banner.json`.
///
/// The desktop reads the same file through `core/banner.js`, so the two banners
/// draw the same controls, say the same words and follow the same dismiss rule.
/// Nothing here restates a label: every string the banner shows about its own
/// controls comes out of the file, and `core/test/banner-spec.test.js` fails if
/// `NoticeBanner.swift` grows a literal of its own.
enum BannerSpec {
    struct Copy: Decodable, Equatable {
        let label: String
        let tooltip: String
    }

    struct Dismiss: Decodable {
        let shownWhen: String
        let clearsWhen: String
        let icon: String
        let read: Copy
        let clears: Copy
    }

    struct Sweep: Decodable {
        let shownWhen: String
        let label: String
        let tooltip: String
    }

    struct Card: Decodable {
        let controls: [String]
    }

    /// One of the Control UI's icons. The desktop draws its SVG; this client draws
    /// the named SF Symbol, because SwiftUI has no SVG path reader.
    struct Icon: Decodable {
        let sfSymbol: String
    }

    private struct Spec: Decodable {
        let card: Card
        let dismiss: Dismiss
        let sweep: Sweep
        let toneIcon: [String: String]
        let icons: [String: Icon]
    }

    /// The keys this reader decodes, and the ones it leaves to the desktop:
    /// `stroke` is how the desktop draws the SVG, and `iconSource` is prose.
    static let decodedKeys: Set<String> = ["card", "dismiss", "sweep", "toneIcon", "icons"]
    static let ignoredKeys: Set<String> = ["iconSource", "stroke"]

    private static let spec: Spec? = try? BundledSpec.load("banner", as: Spec.self)

    private static let missing = Copy(label: "", tooltip: "")

    /// The card's controls, in the order both clients draw them.
    static var controls: [String] { spec?.card.controls ?? [] }

    /// What a card's X says, or nil when the card offers none. The meaning is the
    /// store's (`NoticeStore.dismiss`); this is the words it is drawn with.
    static func dismissCopy(for notice: Notice) -> Copy? {
        guard notice.dismissible else { return nil }
        guard let dismiss = spec?.dismiss else { return missing }
        return notice.dismissClears ? dismiss.clears : dismiss.read
    }

    /// Whether the sweep is offered: whenever anything at all is unread, the same
    /// answer as the desktop's `sweepWanted()`.
    static func sweepWanted(_ unread: [Notice]) -> Bool {
        !unread.isEmpty
    }

    static var sweep: Copy {
        guard let sweep = spec?.sweep else { return missing }
        return Copy(label: sweep.label, tooltip: sweep.tooltip)
    }

    /// The symbol a tone's icon is drawn with, or nil for a tone with no icon.
    static func toneSymbol(_ tone: String) -> String? {
        guard let spec, let name = spec.toneIcon[tone] else { return nil }
        return spec.icons[name]?.sfSymbol
    }

    /// The symbol the dismiss control is drawn with: the Control UI's `x`.
    static var dismissSymbol: String {
        guard let spec else { return "xmark" }
        return spec.icons[spec.dismiss.icon]?.sfSymbol ?? "xmark"
    }
}
