import SwiftUI
import UIKit

/// The box the notice cards actually occupy, in the layer's own coordinate space.
///
/// The notice layer claims a touch only inside this box, so the value is the whole
/// of what makes a window above everything safe to have: see `NoticeWindow`. The
/// probe that publishes it is attached to the cluster rather than to the stack, so
/// the box is the cards plus their own inset and nothing else.
struct NoticeClusterBox: PreferenceKey {
    static let defaultValue: CGRect = .zero

    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        value = nextValue()
    }
}

/// The one surface this client draws its notices on: a window of its own, above
/// whichever layer happens to be on top.
///
/// WHAT THIS REPLACES, AND WHY IT WAS WRONG. Abi, 2026-09-21, sent a composite of
/// the Settings surface and the About surface, each carrying the same up-to-date
/// notice: "Banner shows up on settings and about us page, should only show up once
/// for the whole app and be pinned over everything not to one specific page". The
/// banner used to be an overlay applied at each layer boundary, so one board was
/// drawn four times, once per layer: the page, the Settings sheet, the About sheet
/// and the settings-as-app surface. That shape was deliberate when it landed (see
/// commit 4d83749, "draw the banner above every layer") because a sheet is presented
/// ABOVE the view that raises it: an overlay on that view cannot be above the sheet,
/// so a copy per layer was the only way to have a banner on whichever layer was in
/// front. Its cost is what Abi photographed: every screen draws its own copy inside
/// its own frame, so the notice reads as belonging to the page rather than to the
/// app, sits wherever that page's frame starts, and travels with the sheet it was
/// drawn on.
///
/// WHAT THIS IS. One surface, above every layer, and a window is what that takes: the
/// app's own window holds the sheets, so anything drawn inside it is below them by
/// construction. This window is a sibling at a level above the app's, so the banner
/// is above the page, above both sheets and above any modal drawn in this app, and
/// there is exactly one of them because exactly one place installs it. The desktop
/// client already has this shape for this reason: its banner is a child VIEW of the
/// window, restacked above the modals by `layoutViews` in desktop/src/main.js, and
/// never something a page draws.
///
/// TOUCH. A window over everything has to be invisible to everything it is not
/// drawing, so this one claims a point only inside the cards' own box: `hitTest`
/// answers nil anywhere else, and UIKit then delivers the touch to the app's window
/// below. The box comes from the stack itself (`NoticeClusterBox`) rather than from
/// the screen, so the claimed area is the cards and their inset and not one pixel
/// more, and the page, the settings field and every control underneath keep working.
@MainActor
final class NoticeWindow: UIWindow {
    /// The name the layer's coordinate space is registered under, so the probe and
    /// this window agree on what a point means.
    static let coordinateSpace = "claw-notice-layer"

    /// The box the cards occupy, in this window's coordinates: the only area that
    /// takes a touch. Starts empty, which claims nothing until the stack has
    /// reported where it drew.
    private(set) var cluster: CGRect = .zero

    private let host: UIHostingController<NoticeLayerContent>

    init(scene: UIWindowScene, board: NoticeBoard) {
        host = UIHostingController(rootView: NoticeLayerContent(board: board, report: { _ in }))
        super.init(windowScene: scene)
        // Above the window the app's own content lives in, which is exactly where a
        // sheet is presented, and below the system's own UI: the keyboard and a
        // system alert still belong over a notice.
        windowLevel = UIWindow.Level.normal + 1
        // One overlay, no focus: taking key would move the first responder and the
        // keyboard for a surface that owns neither.
        rootViewController = host
        frame = scene.coordinateSpace.bounds
        host.view.backgroundColor = .clear
        host.view.isOpaque = false
        host.rootView = NoticeLayerContent(board: board, report: { [weak self] box in
            self?.cluster = box
        })
        isHidden = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("NoticeWindow is created in code, from the scene")
    }

    override var canBecomeKey: Bool { false }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard NoticeWindow.claims(point, cluster: cluster) else { return nil }
        return super.hitTest(point, with: event)
    }

    /// Whether the cards own a point, which is the whole of this window's touch rule.
    ///
    /// A static function rather than a condition inlined in `hitTest`, so the rule
    /// can be asserted without a window server: see `NoticeLayerTests`.
    nonisolated static func claims(_ point: CGPoint, cluster: CGRect) -> Bool {
        cluster.contains(point)
    }
}

/// The stack, in the layer's own coordinate space, reporting the box it drew in.
struct NoticeLayerContent: View {
    @ObservedObject var board: NoticeBoard
    let report: (CGRect) -> Void

    var body: some View {
        NoticeStack(board: board)
            .onPreferenceChange(NoticeClusterBox.self) { report($0) }
            .coordinateSpace(name: NoticeWindow.coordinateSpace)
    }
}

/// Installs the one notice surface in the scene this view ends up in.
///
/// A zero-sized, non-interactive anchor rather than a surface of its own: the anchor
/// exists to find the scene, and everything visible is drawn by the window it
/// installs. The coordinator owns that window, because a window nothing retains is
/// gone the moment it is created.
private struct NoticeLayerInstaller: UIViewRepresentable {
    let board: NoticeBoard

    func makeUIView(context: Context) -> UIView {
        let anchor = UIView(frame: .zero)
        anchor.isUserInteractionEnabled = false
        anchor.backgroundColor = .clear
        return anchor
    }

    func updateUIView(_ anchor: UIView, context: Context) {
        // The scene exists only once this view is in one, which is one pass after
        // the first update.
        guard let scene = anchor.window?.windowScene else { return }
        context.coordinator.attach(to: scene, board: board)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator {
        private var window: NoticeWindow?

        /// Idempotent: a later pass with the same scene keeps the window it already
        /// has, so the notice surface is created once for the life of a scene.
        func attach(to scene: UIWindowScene, board: NoticeBoard) {
            if let window, window.windowScene === scene { return }
            window?.isHidden = true
            window = NoticeWindow(scene: scene, board: board)
        }
    }
}

extension View {
    /// Draw this client's notices on their one surface, above every layer.
    ///
    /// Applied ONCE, at the root of the client's only view: a second application
    /// would be the second banner this modifier exists to remove. See
    /// `NoticeWindow` for why that surface is a window rather than an overlay.
    func noticeLayer(_ board: NoticeBoard) -> some View {
        background {
            NoticeLayerInstaller(board: board)
                .frame(width: 0, height: 0)
        }
    }
}
