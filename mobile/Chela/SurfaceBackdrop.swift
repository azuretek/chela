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
/// 2. **This layer starts below the top safe-area inset**, so the veil covers the
///    interface and leaves the band to the page.
///
/// With the platform's share gone, nothing outside this layer darkens the
/// interface, so the shared value is what this layer composites to on its own.
///
/// ## The blur has no tint of its own
///
/// The blur used to be the platform's ultra-thin material under the veil, and a
/// material is not only a blur: it mixes what is behind it toward a tint of its
/// own, which follows the appearance. With the shared veil over it the interface
/// read black at 0.488 in the light appearance and 0.684 in the dark one (#128).
/// Pinning the material to one appearance and solving the veil against it was
/// tried and measured: solved at the fixture's mid grey it read 0.598 there, but
/// 0.495 over a grey half as bright and 0.638 over one half again brighter, because
/// a mix toward a tint is not a scale, and no veil turns it into one.
///
/// So the blur is the interface's own: `ContentView` blurs the Control UI page by
/// `blurRadius` while a sheet is up, which adds no tint, and this layer is the
/// veil alone. A black veil scales whatever is behind it by `1 - scrimAlpha`, so
/// over a flat field the composite is the shared value whatever its brightness and
/// in either appearance: measured at 0.595 over #404040 (the 8-bit step).
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

    /// How far the interface behind a sheet is blurred, in points: the desktop's
    /// `backdrop-filter: blur(14px)` over the same interface (`desktop/src/main.js`),
    /// a CSS pixel being a point. `SurfaceBackdropParityTests` reads it from there.
    static let blurRadius: CGFloat = 14
}

/// The veil, as one view: what `ContentView` lays over the Control UI while a
/// surface is up, over the page it has blurred by `SurfaceBackdrop.blurRadius`.
///
/// It is laid over the whole presenter and the veil starts at the top safe-area
/// inset, so the band above the sheet is the page's own `--bg` (see above). The
/// inset is read from the window, by `BandClearingBackdrop`, because this layer
/// rides on a page laid out edge to edge (`ignoresSafeArea`), and a SwiftUI child
/// of that page sees no safe area to stop at: told to keep its top edge, it covered
/// the band anyway (measured on the simulator, #127).
///
/// ## A tap outside the sheet closes it
///
/// Reported 2026-10-02 (#141): a tap on what is visible around the sheet should
/// close it and return to the app, the way "Back to app" does, as a click on the
/// dim does on the desktop. With the platform's dim off (#127) a touch outside the
/// sheet comes to the presenter, which is this layer, so the layer takes it: the
/// veil itself is not a control and takes nothing, and a clear catcher over the
/// whole presenter, the band above the sheet included, answers `onTapOutside`.
/// The band was deliberately inert before this (#127, #128) and now closes the
/// sheet; it still draws exactly what it drew. The tap stops here either way, so
/// the interface behind the sheet still never receives it. `SheetBandUITests` taps
/// the band and the sheet and holds both halves.
struct SurfaceBackdropView: View {
    /// What a tap outside the sheet does: the same close the page's own way back
    /// takes, which `ContentView` decides.
    let onTapOutside: () -> Void

    var body: some View {
        ZStack {
            SurfaceBackdropLayer()
                .allowsHitTesting(false)
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture(perform: onTapOutside)
                .accessibilityHidden(true)
        }
        .ignoresSafeArea()
    }
}

/// `BandClearingBackdrop`, wrapped. See `SurfaceBackdropView` for why.
private struct SurfaceBackdropLayer: UIViewRepresentable {
    func makeUIView(context: Context) -> BandClearingBackdrop { BandClearingBackdrop() }
    func updateUIView(_ view: BandClearingBackdrop, context: Context) { view.setNeedsLayout() }
}

/// The shared veil, laid out from the window's top safe-area inset down.
final class BandClearingBackdrop: UIView {
    private let veil = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        veil.backgroundColor = UIColor.black.withAlphaComponent(SurfaceBackdrop.scrimAlpha)
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
        veil.frame = CGRect(x: 0, y: band, width: bounds.width, height: bounds.height - band)
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
