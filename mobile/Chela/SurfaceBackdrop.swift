import SwiftUI
import UIKit

/// The interface behind a sheet: blurred, and dimmed to the one shared value.
///
/// ## Why this layer is native, and why it sits BEHIND the presentation
///
/// A `backdrop-filter` samples only the document it is in. The interface this
/// dims is a `WKWebView` in a layer of its own, so the page inside a native sheet
/// has no backdrop to sample at all, and `core/ui/ui.css` leaves that page's scrim
/// clear under `surface--native-sheet` for exactly that reason: the platform
/// draws the dim instead. The blur therefore cannot come from the sheet's page,
/// and the layer that does the work has to be native and has to belong to the
/// presenter. That is what this is: it is installed in the Control UI's own view,
/// and the sheet is presented over it.
///
/// ## Why the veil is not simply the shared value
///
/// iOS dims the presenter itself and the SDK publishes no way to set, clear or
/// read that dim. Read on the iOS 27 SDK's SwiftUI interface:
/// `presentationBackground` sets the sheet's OWN background, and
/// `presentationBackgroundInteraction`, `presentationDetents`,
/// `presentationCornerRadius`, `presentationContentInteraction`,
/// `presentationSizing`, `presentationDragIndicator`,
/// `presentationCompactAdaptation` and `presentationPlacement` none of them
/// touch the dim behind the sheet. So the platform's dim is a fixed term that is
/// always under ours, and painting the shared value on top of it would land
/// somewhere nobody chose. Ours is solved against it, so the COMPOSITE over the
/// interface is the shared value.
enum SurfaceBackdrop {
    /// ★ The dim behind a sheet, over the interface: black at 60%.
    ///
    /// Owner: `--scrim` in `core/ui/ui.css`, which
    /// `core/test/backdrop.test.js` holds to being DARKER than the Control UI's
    /// mobile nav drawer backdrop it started as, and which the desktop's injected
    /// backdrop composites to over the same interface. Mirrored here rather than
    /// read, for the reason `NoticeTokens` mirrors `core/spec/tokens.json`: the
    /// layer that paints it on this client is native and outside the page it dims,
    /// so there is nothing at runtime to read it from. `SurfaceBackdropParityTests`
    /// reads that declaration out of ui.css and fails if this drifts from it.
    static let scrimAlpha: Double = 0.60

    /// The dim iOS already draws behind a sheet of its own, as a black veil's
    /// alpha, measured rather than assumed.
    ///
    /// Measured 2026-10-01 on an iPhone 17 simulator at iOS 27.0, by photographing
    /// a flat #808080 field behind a presented sheet and dividing: the field read
    /// 0.522 against the same pixels with no sheet up, so the platform contributes the
    /// other 0.478. Read from two places in one frame, which is why it is worth
    /// stating as a number: the app's own strip above the sheet (128 to 66) and the
    /// sliver of interface the sheet's rounded corners leave at the screen edges (255
    /// to 133), both at the same factor. The measurement is the METHOD rather than a
    /// constant worth trusting: it is a fact about this SDK's presentation, so a run
    /// that measures a different number is reporting a real change in the platform,
    /// which is what `SurfacesHandoffUITests` is for.
    static let platformDimAlpha: Double = 0.478

    /// The veil this layer paints, so the composite over the interface is
    /// `scrimAlpha` rather than that value stacked on the platform's.
    ///
    /// Two veils over one pixel multiply what they let through, so the composite
    /// is `1 - (1 - platformDimAlpha) * (1 - ownAlpha)` and this is that solved
    /// for `scrimAlpha`. Painting `scrimAlpha` directly would composite to
    /// `1 - (1 - platformDimAlpha) * (1 - scrimAlpha)`, which is darker than
    /// anything that was chosen. Clamped, because a platform dim strong enough to
    /// reach `scrimAlpha` on its own would otherwise ask for a negative veil.
    static var ownAlpha: Double {
        guard platformDimAlpha < scrimAlpha else { return 0 }
        let remaining = (1 - scrimAlpha) / (1 - platformDimAlpha)
        return min(1, max(0, 1 - remaining))
    }
}

/// The blur plus the veil, as one view: what `ContentView` lays over the Control
/// UI while a surface is up.
///
/// `allowsHitTesting(false)` because this is a veil and not a control: the reader
/// has nothing to touch here, and a layer that swallowed taps would make the
/// screen behind a sheet feel frozen in the one place it is still alive.
///
/// The blur is a `UIVisualEffectView` rather than a SwiftUI `Material` for one
/// reason: this has to blur a `UIView`-hosted web view that is a sibling in the
/// same window, and the effect view samples its window's backdrop directly, which
/// is the behaviour this depends on. Nothing picks the radius: iOS publishes blur
/// styles and no radius, so the desktop's `blur(14px)` has no iOS counterpart and
/// this is the platform's own thin material instead of a number invented here.
struct SurfaceBackdropView: View {
    var body: some View {
        SurfaceBackdropBlur()
            .overlay(Color.black.opacity(SurfaceBackdrop.ownAlpha))
            .allowsHitTesting(false)
    }
}

/// `UIVisualEffectView`, wrapped. See `SurfaceBackdropView` for why.
private struct SurfaceBackdropBlur: UIViewRepresentable {
    func makeUIView(context: Context) -> UIVisualEffectView {
        let view = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: UIVisualEffectView, context: Context) {}
}

