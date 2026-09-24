import SwiftUI

/// The notice banner, drawn natively over the Control UI's web view.
///
/// This is the same card the desktop draws above its window: a tone stripe on the
/// leading edge, an icon carrying the tone, a headline, the subject line under it,
/// the one action a notice may offer, and the dismiss X. Every colour, radius,
/// size and the arrival animation below comes from `NoticeTokens`, which is a
/// mirror of `core/spec/tokens.json`, the same spec the desktop banner's
/// stylesheet resolves to. So the two clients cannot drift into two looks by
/// someone editing one of them.
///
/// Why native rather than injected into the page. The page belongs to the
/// gateway, and this client does not patch its markup or its styles: a page is
/// free to change its own class names at any release, and a notice is our
/// condition to report, not the gateway's to draw. It also has to work while the
/// page is broken or absent, which is exactly when a connection notice is raised.
///
/// Why an overlay rather than chrome. The Control UI lays itself out inside the
/// safe area (see `ContentView`) and has safe-area rules of its own. An overlay
/// does not change that layout, so the page keeps the whole safe area it was
/// written for, and the banner floats above it the way the Control UI's own
/// floating attention card does.
struct NoticeStack: View {
    @ObservedObject var board: NoticeBoard

    @Environment(\.colorScheme) private var colorScheme

    /// The palette's mode: the one the Control UI page says it is in when it has
    /// answered, the device's otherwise, so the banner and the page it floats over
    /// cannot disagree about which palette is in force.
    private var mode: String {
        board.themeTokens[ThemeTokens.schemeKey] ?? (colorScheme == .dark ? "dark" : "light")
    }

    var body: some View {
        let style = NoticeCardStyle.forMode(mode, live: board.themeTokens)
        VStack(alignment: .trailing, spacing: 0) {
            // ★ FLOATING CARDS, NOT A BAR. Abi, 2026-09-19: "floating cards no
            // full width bar that's pointless". This VStack hugs its cards rather
            // than stretching across the screen: no `maxWidth: .infinity` and no
            // band `.background` of its own, so it is only as wide as its widest
            // card, sits at the top-trailing corner, and every touch beside and
            // below it reaches the web view underneath. Each card carries its own
            // surface (NoticeCard's `.background(style.surface)`), so a floating
            // card is still legible over the page. This is the same shape the
            // desktop banner now has (see the rule at the top of core/ui/
            // banner.css and layoutViews in src/main.js, which sizes the view to
            // the card cluster).
            //
            // It is INSIDE the full-screen frame and not on it, and that
            // distinction is this client's whole safety: the frame is the screen so
            // that the cards can sit at its top-trailing corner, and a surface, a
            // contentShape or a gesture on the frame would claim every touch on the
            // page underneath. The cards hug their content precisely so the frame
            // stays touch-transparent everywhere they are not. See
            // NoticeStackHitTests.
            VStack(alignment: .trailing, spacing: style.stackGap) {
                ForEach(board.unread, id: \.id) { notice in
                    NoticeCard(
                        notice: notice,
                        style: style,
                        dismiss: { board.dismiss(notice.id) },
                        run: { board.run($0) }
                    )
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
                // Offered whenever anything is unread, the desktop's sweepWanted():
                // the sweep reads every card, the ones that refuse the X included.
                if BannerSpec.sweepWanted(board.unread) {
                    MarkAllReadRow(style: style) { board.markAllRead() }
                }
            }
            .padding(.horizontal, style.inset)
            .padding(.vertical, style.inset)
            // The cluster publishes the box it drew in, which is the only area the
            // notice layer claims for touch. On the cluster rather than on the stack,
            // so the box is the cards plus their inset and never the screen. See
            // \`NoticeWindow\`.
            .background(
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: NoticeClusterBox.self,
                        // In the WINDOW's coordinates, which is what hitTest is
                        // given. A space named on the layer's root sat inside the
                        // safe area, so the box was measured from below the status
                        // bar while touches were measured from the window's top.
                        value: proxy.frame(in: .global)
                    )
                }
            )
            // Trailing filler rather than a fixed height, so the cluster is only as
            // tall as what it holds and the web view underneath keeps every touch
            // outside it. A view that covered the page to draw nothing on it would
            // eat taps the way an over-tall desktop banner view does.
            Spacer(minLength: 0)
        }
        // The whole stack is pinned to the TOP-TRAILING corner and takes no width
        // it does not need: `alignment: .topTrailing` keeps the cards at the edge
        // the desktop cluster hugs, and with the inner VStack no longer stretched
        // the frame is transparent to touch everywhere the cards are not.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
        // And the cluster reports its own box, which is what the notice layer claims
        // for touch: the window above everything takes a point only inside this, so
        // the claimed area is the cards rather than the screen they float on. See
        // `NoticeWindow`.
        .animation(style.arrival, value: board.unread.map(\.id))
    }
}

/// One notice, drawn as the Control UI's toast (components.css .app-toast): an
/// opaque popover card, one row of tone icon, words, action and X.
struct NoticeCard: View {
    let notice: Notice
    let style: NoticeCardStyle
    let dismiss: () -> Void
    let run: (String) -> Void

    var body: some View {
        HStack(alignment: .center, spacing: style.gap) {
            Icon(notice: notice, style: style)
            VStack(alignment: .leading, spacing: 2) {
                Text(notice.message)
                    .font(.system(size: style.headlineSize, weight: style.headlineWeight))
                    .foregroundStyle(style.headlineColour)
                if let detail = notice.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: style.subjectSize))
                        .foregroundStyle(style.subjectColour)
                }
                if let progress = notice.progress {
                    ProgressBar(progress: progress, style: style, colour: style.toneColour(notice.tone))
                }
            }
            Spacer(minLength: 0)
            if let action = notice.action {
                // The toast's filled accent button, at the phone's 44pt target.
                let shape = RoundedRectangle(cornerRadius: style.actionRadius, style: .continuous)
                Button { run(action.command) } label: {
                    Text(action.label)
                        .font(.system(size: style.actionSize, weight: style.actionWeight))
                        .foregroundStyle(style.actionColour)
                        .padding(.horizontal, style.actionPaddingHorizontal)
                        .padding(.vertical, style.actionPaddingVertical)
                        .frame(minWidth: style.target, minHeight: style.target)
                        .background(style.actionSurface)
                        .clipShape(shape)
                        .contentShape(shape)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(action.label)
            }
            // The X, and what it MEANS is the store's: a notice that says
            // dismissClears is cleared, anything else is read (NoticeStore.dismiss,
            // the same rule as dismiss() in core/notices.js). What it SAYS is
            // core/spec/banner.json's, the words the desktop's tooltip uses.
            if let copy = BannerSpec.dismissCopy(for: notice) {
                Button(action: dismiss) {
                    Image(systemName: BannerSpec.dismissSymbol)
                        .font(.system(size: style.dismissGlyph, weight: .medium))
                        .foregroundStyle(style.dismissColour)
                        .frame(width: style.target, height: style.target)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copy.label)
                .accessibilityHint(copy.tooltip)
                // A stable handle for UI tests, scoped to the banner: a label
                // like "Clear" can also belong to a control on the page.
                .accessibilityIdentifier("notice-dismiss-\(notice.id)")
            }
        }
        .padding(style.padding)
        .frame(maxWidth: style.maxWidth)
        // Opaque, like the toast: no blur and no tone stripe. The tone is the
        // icon's colour.
        .background(style.surface)
        .clipShape(RoundedRectangle(cornerRadius: style.radius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: style.radius, style: .continuous)
                .stroke(style.border, lineWidth: 1)
        )
        .shadow(color: style.shadowColour, radius: style.shadowRadius, x: style.shadowX, y: style.shadowY)
    }
}

/// The tone's icon, as .app-toast__icon: a 16pt icon with no box, coloured by
/// the tone. The icon is the one core/spec/banner.json names for the tone, the
/// same one the desktop draws as upstream's SVG.
private struct Icon: View {
    let notice: Notice
    let style: NoticeCardStyle

    var body: some View {
        if let symbol = BannerSpec.toneSymbol(notice.tone) {
            Image(systemName: symbol)
                .font(.system(size: style.glyphSize, weight: .medium))
                .foregroundStyle(style.toneColour(notice.tone))
                .frame(width: style.glyphSize, height: style.glyphSize)
                .accessibilityHidden(true)
        } else {
            EmptyView()
        }
    }
}

/// The download bar and its percentage, laid out as the desktop draws them: the
/// number beside the bar rather than inside it, since a figure over a filled
/// track is unreadable at the midpoint.
private struct ProgressBar: View {
    let progress: Double
    let style: NoticeCardStyle
    let colour: Color

    var body: some View {
        HStack(spacing: 8) {
            ProgressView(value: min(max(progress, 0), 1))
                .progressViewStyle(.linear)
                .tint(colour)
            Text("\(Int((min(max(progress, 0), 1) * 100).rounded()))%")
                .font(.system(size: style.subjectSize))
                .foregroundStyle(style.subjectColour)
                .monospacedDigit()
        }
        .padding(.top, 6)
    }
}

/// Closing the whole stack, which is reading everything, not clearing it: a
/// condition that is still true stays in the store either way.
///
/// A pill on the card's own surface, the desktop's `.banner__readall` shape for
/// shape: the opaque card surface, hairline, radius and shadow, muted type.
private struct MarkAllReadRow: View {
    let style: NoticeCardStyle
    let action: () -> Void

    var body: some View {
        let copy = BannerSpec.sweep
        let shape = RoundedRectangle(cornerRadius: style.radius, style: .continuous)
        Button(action: action) {
            Text(copy.label)
                .font(.system(size: style.subjectSize))
                .foregroundStyle(style.subjectColour)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, style.actionPaddingHorizontal)
                .padding(.vertical, style.actionPaddingVertical)
                .frame(minHeight: style.target)
                .background(style.surface)
                .clipShape(shape)
                .overlay(shape.stroke(style.border, lineWidth: 1))
                .shadow(color: style.shadowColour, radius: style.shadowRadius, x: style.shadowX, y: style.shadowY)
                .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copy.label)
        .accessibilityHint(copy.tooltip)
        .accessibilityIdentifier("notice-sweep")
    }
}

/// The card's measurements and colours for one mode, read from the tokens once
/// per render rather than at each use.
///
/// This exists so that the views above name a value and never a number, and so
/// that the one place the token layer meets SwiftUI is one place. That is also
/// why the few conversions the spec cannot carry live here: a CSS length becomes
/// a CGFloat, a weight lands on the nearest of SwiftUI's fixed weights, and a
/// colour string becomes a Color.
struct NoticeCardStyle {
    let mode: String
    let radius: CGFloat
    let gap: CGFloat
    let stackGap: CGFloat
    let inset: CGFloat
    let padding: EdgeInsets
    let maxWidth: CGFloat
    let target: CGFloat
    let glyphSize: CGFloat
    let headlineSize: CGFloat
    let subjectSize: CGFloat
    let actionSize: CGFloat
    let headlineWeight: Font.Weight
    let actionWeight: Font.Weight
    let dismissGlyph: CGFloat
    let actionPaddingHorizontal: CGFloat
    let actionPaddingVertical: CGFloat
    let actionRadius: CGFloat
    let surface: Color
    let border: Color
    let headlineColour: Color
    let subjectColour: Color
    let dismissColour: Color
    let actionColour: Color
    let actionSurface: Color
    let shadowColour: Color
    let shadowRadius: CGFloat
    let shadowX: CGFloat
    let shadowY: CGFloat
    let arrival: Animation

    /// A tone's edge colour. A tone the spec does not define draws with the
    /// subject colour, matching how the desktop's stylesheet falls back to a
    /// neutral colour rather than to nothing.
    func toneColour(_ tone: String) -> Color {
        colour(for: tone, keyPath: \.edgeColour) ?? subjectColour
    }

    private func colour(for tone: String, keyPath: KeyPath<(edge: String, tint: String, edgeColour: String, tintColour: String), String>) -> Color? {
        guard let entry = NoticeTokens.tone(tone, mode: mode) else { return nil }
        return Color(css: entry[keyPath: keyPath])
    }

    /// The style for one mode, wearing the Control UI's LIVE palette where the
    /// page published one (`live`, from ThemeTokens' probe) and the bundled
    /// palette otherwise. The desktop banner does the same through the theme it
    /// injects. A live value this file cannot read falls back to the bundled one.
    static func forMode(_ mode: String, live: [String: String] = [:]) -> NoticeCardStyle {
        func usable(_ value: String) -> Bool { Color(css: value) != nil || CSSLength(value) != nil }
        /// A token, live first.
        func token(_ name: String) -> String? {
            if let value = live[name], usable(value) { return value }
            return NoticeTokens.resolve(name, mode: mode)
        }
        /// A value from the card section, with a token name resolved (live first)
        /// if that is what the spec recorded.
        func card(_ name: String) -> String? {
            if let raw = NoticeTokens.card[name], raw.hasPrefix("--"), let value = live[raw], usable(value) {
                return value
            }
            return NoticeTokens.cardValue(name, mode: mode)
        }
        func colour(_ text: String?, fallback: Color = .secondary) -> Color {
            guard let text, let parsed = Color(css: text) else { return fallback }
            return parsed
        }
        let shadow = CSSShadow(card("shadow"))
        let action = CSSPadding(card("action.padding"))
        let bezier = CSSBezier(NoticeTokens.resolve("--ease-out", mode: mode))
        let message = CSSLength(card("messageSize")) ?? 13
        return NoticeCardStyle(
            mode: mode,
            radius: CSSLength(card("radius")) ?? 12,
            gap: CSSLength(card("gap")) ?? 8,
            stackGap: 8,
            // The toast on a phone sits 12pt in from the screen's edges.
            inset: CSSLength(card("phone.edge")) ?? 12,
            padding: CSSPadding(card("padding")),
            maxWidth: CSSLength(card("maxWidth")) ?? 370,
            // And its action and X grow to 44pt touch targets.
            target: CSSLength(card("phone.target")) ?? 44,
            glyphSize: CSSLength(card("glyphSize")) ?? 16,
            headlineSize: message,
            subjectSize: message,
            actionSize: CSSLength(NoticeTokens.sizes["sm"]) ?? 12,
            headlineWeight: .css(NoticeTokens.weights["headline"] ?? 650),
            actionWeight: .css(NoticeTokens.weights["action"] ?? 600),
            dismissGlyph: CSSLength(card("dismiss.glyph")) ?? 14,
            actionPaddingHorizontal: action.leading,
            actionPaddingVertical: action.top,
            actionRadius: CSSLength(card("action.radius")) ?? 8,
            surface: colour(card("surface"), fallback: .clear),
            border: colour(card("border"), fallback: .clear),
            headlineColour: colour(card("colour")),
            subjectColour: colour(token("--muted")),
            dismissColour: colour(card("dismiss.colour")),
            actionColour: colour(card("action.colour")),
            actionSurface: colour(card("action.surface"), fallback: .clear),
            shadowColour: shadow.colour,
            shadowRadius: shadow.blur,
            shadowX: shadow.x,
            shadowY: shadow.y,
            // SwiftUI takes the curve as a UnitCurve now, so the four control
            // points the spec records are handed over as one.
            arrival: .timingCurve(
                UnitCurve.bezier(
                    startControlPoint: UnitPoint(x: bezier.a, y: bezier.b),
                    endControlPoint: UnitPoint(x: bezier.c, y: bezier.d)
                ),
                duration: CSSMilliseconds(NoticeTokens.resolve("--duration-normal", mode: mode))
            )
        )
    }
}

/* ------------------------------------------------------------- CSS parsing */

/// A length in CSS pixels. Nil for anything that is not one, so a missing token
/// falls back at the call site rather than drawing at zero.
func CSSLength(_ text: String?) -> CGFloat? {
    guard let text else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    let digits = trimmed.hasSuffix("px") ? String(trimmed.dropLast(2)) : trimmed
    guard let value = Double(digits) else { return nil }
    return CGFloat(value)
}

/// CSS padding shorthand: one value for all four edges, two for vertical and
/// horizontal, three for top, horizontal and bottom, or four clockwise from the
/// top, as the toast's `7px 7px 7px 13px` is. Anything else is refused rather
/// than half-honoured.
func CSSPadding(_ text: String?) -> EdgeInsets {
    guard let text else { return EdgeInsets() }
    let parts = text.split(separator: " ").map(String.init)
    let values = parts.compactMap { CSSLength($0) }
    guard values.count == parts.count, !values.isEmpty else { return EdgeInsets() }
    if values.count == 1 {
        return EdgeInsets(top: values[0], leading: values[0], bottom: values[0], trailing: values[0])
    }
    switch values.count {
    case 2: return EdgeInsets(top: values[0], leading: values[1], bottom: values[0], trailing: values[1])
    case 3: return EdgeInsets(top: values[0], leading: values[1], bottom: values[2], trailing: values[1])
    case 4: return EdgeInsets(top: values[0], leading: values[3], bottom: values[2], trailing: values[1])
    default: return EdgeInsets()
    }
}

/// A box shadow, in the CSS order: x, y, blur, then the colour.
struct CSSShadow {
    let x: CGFloat
    let y: CGFloat
    let blur: CGFloat
    let colour: Color

    init(_ text: String?) {
        let parts = (text ?? "").split(separator: " ").map(String.init)
        let lengths = parts.prefix(3).compactMap { CSSLength($0) }
        let rest = parts.dropFirst(lengths.count).joined(separator: " ")
        x = lengths.count > 0 ? lengths[0] : 0
        y = lengths.count > 1 ? lengths[1] : 1
        blur = lengths.count > 2 ? lengths[2] : 2
        // A CSS shadow's colour is normally translucent, and SwiftUI's shadow is
        // too, so the alpha survives here rather than being flattened the way the
        // desktop's title strip has to flatten it.
        colour = Color(css: rest) ?? Color.black.opacity(0.25)
    }
}

/// The four control points of a `cubic-bezier(...)`, which SwiftUI's
/// `timingCurve` takes as plain numbers. Anything else becomes a plain ease.
struct CSSBezier {
    let a: Double
    let b: Double
    let c: Double
    let d: Double

    init(_ text: String?) {
        let numbers = (text ?? "")
            .replacingOccurrences(of: "cubic-bezier(", with: "")
            .replacingOccurrences(of: ")", with: "")
            .split(separator: ",")
            .compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        if numbers.count == 4 {
            a = numbers[0]; b = numbers[1]; c = numbers[2]; d = numbers[3]
        } else {
            a = 0.25; b = 0.1; c = 0.25; d = 1
        }
    }
}

/// A duration in seconds, from a token written in milliseconds.
func CSSMilliseconds(_ text: String?) -> Double {
    guard let text, text.hasSuffix("ms"), let value = Double(text.dropLast(2)) else { return 0.18 }
    return value / 1000
}

extension Font.Weight {
    /// SwiftUI's weights are a fixed set, so a token value lands on the nearest.
    /// 650, the Control UI's attention-card heading, is `.semibold` here.
    static func css(_ value: Int) -> Font.Weight {
        switch value {
        case ...350: return .light
        case 351...450: return .regular
        case 451...550: return .medium
        case 551...650: return .semibold
        default: return .bold
        }
    }
}

extension Color {
    /// A colour written the way the Control UI writes one: `#rrggbb`, or an
    /// `rgb()`/`rgba()` with comma separated channels. Nil for anything else, so
    /// an unparseable token falls back at the call site rather than drawing black
    /// and looking deliberate.
    init?(css: String) {
        let text = css.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("#"), text.count == 7, let value = UInt32(text.dropFirst(), radix: 16) {
            self = Color(
                .sRGB,
                red: Double((value >> 16) & 0xff) / 255,
                green: Double((value >> 8) & 0xff) / 255,
                blue: Double(value & 0xff) / 255,
                opacity: 1
            )
            return
        }
        guard text.hasPrefix("rgb") else { return nil }
        let inner = text
            .replacingOccurrences(of: "rgba(", with: "")
            .replacingOccurrences(of: "rgb(", with: "")
            .replacingOccurrences(of: ")", with: "")
        let parts = inner.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 3 || parts.count == 4,
              let red = Double(parts[0]), let green = Double(parts[1]), let blue = Double(parts[2])
        else { return nil }
        let alpha = parts.count == 4 ? (Double(parts[3]) ?? 1) : 1
        self = Color(.sRGB, red: red / 255, green: green / 255, blue: blue / 255, opacity: alpha)
    }
}
