import SwiftUI
import UIKit

/// The interface behind a sheet: blurred, and dimmed to the one shared value.
///
/// ## Why this layer is native, and why it sits BEHIND the presentation
///
/// A `backdrop-filter` samples only the document it is in. The interface this
/// dims is a `WKWebView` in a layer of its own, so the page inside a native sheet
/// has no backdrop to sample at all, and `core/ui/ui.css` leaves that page's scrim
/// clear under `surface--native-sheet` for exactly that reason. The blur therefore cannot come from the sheet's page,
/// and the layer that does the work has to be native and has to belong to the
/// presenter. That is what this is: it is installed in the Control UI's own view,
/// and the sheet is presented over it.
///
/// ## The dim is ours alone, and it stops at the band above the sheet
///
/// iOS draws a dim of its own behind a sheet, over the whole presenter, and the
/// strip a large sheet leaves uncovered is where it showed: the band above the
/// sheet is the interface's own top inset, which the page paints with its `--bg`,
/// so under the platform's dim and this layer's veil a dark palette read as black
/// there. Reported 2026-10-02 (#127): the band must be the palette's `--bg`, the
/// same colour as the background behind the page.
///
/// Two things make it so, one per layer over that band:
///
/// 1. **The platform's dim is switched off.** `FullScreenSurfaceSheet` sets
///    `presentationBackgroundInteraction(.enabled(upThrough: .large))`, which is
///    the sheet's largest undimmed detent: at or below it iOS draws no dim behind
///    the sheet. An earlier reading of the SDK interface (#106) listed this
///    modifier among those that do not touch the dim; measured, it removes it, and
///    the band read the strip's own colour once it was set.
/// 2. **This layer starts below the top safe-area inset**, so the veil and the blur
///    cover the interface and leave the band to the page.
///
/// With the platform's share gone, the shared value is painted as it is, rather
/// than solved against a dim nobody chose.
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
}

/// The blur plus the veil, as one view: what `ContentView` lays over the Control
/// UI while a surface is up.
///
/// The blur is a `UIVisualEffectView` rather than a SwiftUI `Material` for one
/// reason: this has to blur a `UIView`-hosted web view that is a sibling in the
/// same window, and the effect view samples its window's backdrop directly, which
/// is the behaviour this depends on.
///
/// It is laid over the whole presenter and its veil and blur start at the top
/// safe-area inset, so the band above the sheet is the page's own `--bg` (see
/// above). The inset is read from the window, by `BandClearingBackdrop`, because
/// this layer rides on a page laid out edge to edge (`ignoresSafeArea`), and a
/// SwiftUI child of that page sees no safe area to stop at: told to keep its top
/// edge, it covered the band anyway (measured on the simulator, #127).
///
/// `allowsHitTesting(false)` because this is a veil and not a control. With the
/// platform's dim off, nothing outside the sheet reaches the interface either:
/// the sliver at the sheet's rounded corners is still inside the sheet's own
/// frame, and the band is the status bar's. `SheetBandUITests` taps both and
/// checks the page behind received nothing.
struct SurfaceBackdropView: View {
    var body: some View {
        SurfaceBackdropLayer()
            .ignoresSafeArea()
            .allowsHitTesting(false)
    }
}

/// `BandClearingBackdrop`, wrapped. See `SurfaceBackdropView` for why.
private struct SurfaceBackdropLayer: UIViewRepresentable {
    func makeUIView(context: Context) -> BandClearingBackdrop { BandClearingBackdrop() }
    func updateUIView(_ view: BandClearingBackdrop, context: Context) { view.setNeedsLayout() }
}

/// The platform's thin material and the shared veil over it, laid out from the
/// window's top safe-area inset down. Nothing picks the radius: iOS publishes blur
/// styles and no radius, so the desktop's `blur(14px)` has no iOS counterpart and
/// this is the platform's own material instead of a number invented here.
final class BandClearingBackdrop: UIView {
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
    private let veil = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        veil.backgroundColor = UIColor.black.withAlphaComponent(SurfaceBackdrop.scrimAlpha)
        addSubview(blur)
        addSubview(veil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    /// How far down this view the band reaches: the window's top inset, less
    /// however far below the window's top this view already starts.
    var bandHeight: CGFloat {
        let top = WebView.windowSafeAreaInsets(for: self).top
        let origin = window.map { convert(CGPoint.zero, to: $0).y } ?? 0
        return max(0, min(bounds.height, top - origin))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let band = bandHeight
        let covered = CGRect(x: 0, y: band, width: bounds.width, height: bounds.height - band)
        blur.frame = covered
        veil.frame = covered
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        setNeedsLayout()
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }
}
