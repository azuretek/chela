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
/// With the platform's share gone, nothing outside this layer darkens the
/// interface, so the shared value is what this layer composites to on its own.
///
/// ## The material is pinned dark, and the veil is solved against it
///
/// The blur is the platform's ultra-thin material, and a material is not only a
/// blur: it carries a tint of its own, which follows the appearance. Under the
/// shared veil painted as it is, the interface behind a sheet read black at 0.488
/// in the light appearance and 0.684 in the dark one (#128), because the light
/// material LIFTS what is behind it (about 1.27 times) and the dark one dims it
/// (about 0.79 times).
///
/// So the material is pinned to its dark variant, in both appearances, and the veil
/// over it is solved against what that material passes, so the two together are
/// the shared dim. Dark rather than light because the dim is black: the dark
/// material darkens toward black the way the veil does, where the light one would
/// add a light tint the veil then has to undo, and over a dark palette, where
/// there is little light behind it to scale, that tint would be all that shows.
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

    /// What the dark ultra-thin material passes of the light behind it, as a
    /// fraction: measured, because iOS publishes no number for a material.
    ///
    /// Read by `SurfacesHandoffUITests.testTheBackdropBehindASheetIsTheSharedDim`
    /// on the iOS 27 simulator: the mean over whole stripe periods of a mid-grey
    /// fixture behind a sheet, against the same pixels with no sheet up, divided by
    /// what the veil alone lets through. That test is what fails when this drifts.
    static let materialTransmission: Double = 0.79

    /// The veil laid over the material: the black that, with the material under
    /// it, lets through `1 - scrimAlpha` of the interface.
    static var veilAlpha: Double { 1 - (1 - scrimAlpha) / materialTransmission }
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

/// The platform's thin material, pinned dark, and the veil solved against it, laid
/// out from the window's top safe-area inset down. Nothing picks the radius: iOS
/// publishes blur styles and no radius, so the desktop's `blur(14px)` has no iOS
/// counterpart and this is the platform's own material instead of a number
/// invented here. See `SurfaceBackdrop` for why the material is pinned.
final class BandClearingBackdrop: UIView {
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let veil = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        veil.backgroundColor = UIColor.black.withAlphaComponent(SurfaceBackdrop.veilAlpha)
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
