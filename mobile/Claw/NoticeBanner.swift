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

    private var mode: String { colorScheme == .dark ? "dark" : "light" }

    var body: some View {
        let style = NoticeCardStyle.forMode(mode)
        VStack(alignment: .trailing, spacing: 0) {
            // ★ THE BAR, painted behind what it holds and hugging it: the cards
            // above, the sweep row at the bottom, and one surface behind them all.
            // That is the same shape the desktop's banner has (see the rule at the
            // top of core/ui/banner.css), where the bar must paint every pixel of
            // the rectangle its view is sized to or the rest is a dead strip over
            // the Control UI.
            //
            // It is INSIDE the full-screen frame and not on it, and that
            // distinction is this client's whole safety: the frame is the screen so
            // that the bar can sit at its top, and a surface, a contentShape or a
            // gesture on the frame would claim every touch on the page underneath.
            // See NoticeStackHitTests.
            VStack(alignment: .trailing, spacing: style.stackGap) {
                ForEach(board.unread, id: \.id) { notice in
                    NoticeCard(
                        notice: notice,
                        style: style,
                        markRead: { board.markRead(notice.id) },
                        run: { board.run($0) }
                    )
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
                if board.unread.contains(where: { $0.dismissible }) {
                    MarkAllReadRow(style: style) { board.markAllRead() }
                }
            }
            .padding(.horizontal, style.inset)
            .padding(.vertical, style.inset)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .background(style.surface)
            // Trailing filler rather than a fixed height, so the bar is only as
            // tall as what it holds and the web view underneath keeps every touch
            // outside it. A view that covered the page to draw nothing on it would
            // eat taps the way an over-tall desktop banner view does.
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(style.arrival, value: board.unread.map(\.id))
    }
}

/// One notice, as the Control UI's attention card.
struct NoticeCard: View {
    let notice: Notice
    let style: NoticeCardStyle
    let markRead: () -> Void
    let run: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: style.gap) {
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
                Button { run(action.command) } label: {
                    Text(action.label)
                        .font(.system(size: style.actionSize, weight: style.actionWeight))
                        .foregroundStyle(style.actionColour)
                        .padding(.horizontal, style.actionPaddingHorizontal)
                        .padding(.vertical, style.actionPaddingVertical)
                        .frame(minHeight: style.actionMinHeight)
                        .background(style.actionSurface)
                        .contentShape(RoundedRectangle(cornerRadius: style.actionRadius, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: style.actionRadius, style: .continuous)
                                .stroke(style.actionBorder, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(action.label)
            }
            if notice.dismissible {
                Button(action: markRead) {
                    Image(systemName: "xmark")
                        .font(.system(size: style.dismissGlyph))
                        .foregroundStyle(style.dismissColour)
                        .frame(width: style.dismissSize, height: style.dismissSize)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Mark read")
            }
        }
        .padding(style.padding)
        .background(alignment: .leading) {
            // The tone stripe, the one part of the card that carries the tone on
            // both clients even though the icon does too: the desktop has no icon
            // column, and a bar over someone else's page has no list to sit in.
            Rectangle()
                .fill(style.toneColour(notice.tone))
                .frame(width: style.edgeWidth)
        }
        .background(style.surface)
        .clipShape(RoundedRectangle(cornerRadius: style.radius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: style.radius, style: .continuous)
                .stroke(style.border, lineWidth: 1)
        )
        .shadow(color: style.shadowColour, radius: style.shadowRadius, x: style.shadowX, y: style.shadowY)
    }
}

/// The tone's glyph, on its tinted chip. The tint is what the Control UI gives
/// `.sidebar-issues-panel__icon`; the glyph is the tone's own symbol, which is
/// the part the desktop card does not draw.
private struct Icon: View {
    let notice: Notice
    let style: NoticeCardStyle

    var body: some View {
        if let tone = NoticeTokens.tone(notice.tone, mode: style.mode) {
            Image(systemName: tone.glyph)
                .font(.system(size: style.glyphSize))
                .foregroundStyle(style.toneColour(notice.tone))
                .frame(width: style.iconSize, height: style.iconSize)
                .background(style.toneTint(notice.tone))
                .clipShape(RoundedRectangle(cornerRadius: style.iconRadius, style: .continuous))
                .accessibilityHidden(true)
        } else {
            EmptyView()
        }
    }
}

/// The download bar and its percentage, laid out as the desktop draws them: the
/// number beside the bar rather than inside it, since a figure over a filled
/// track is unreadable at the midpoint and this card is 11px of type.
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
/// condition that is still true stays in the store either way, and a notice that
/// cannot be dismissed refuses this too.
private struct MarkAllReadRow: View {
    let style: NoticeCardStyle
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text("Mark all read")
                .font(.system(size: style.subjectSize))
                .foregroundStyle(style.dismissColour)
                .padding(.horizontal, style.actionPaddingHorizontal)
                .padding(.vertical, style.actionPaddingVertical)
                .frame(minHeight: style.actionMinHeight)
                .contentShape(RoundedRectangle(cornerRadius: style.dismissRadius, style: .continuous))
        }
        .buttonStyle(.plain)
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
    let edgeWidth: CGFloat
    let gap: CGFloat
    let stackGap: CGFloat
    let inset: CGFloat
    let padding: EdgeInsets
    let iconSize: CGFloat
    let iconRadius: CGFloat
    let glyphSize: CGFloat
    let headlineSize: CGFloat
    let subjectSize: CGFloat
    let actionSize: CGFloat
    let headlineWeight: Font.Weight
    let actionWeight: Font.Weight
    let dismissSize: CGFloat
    let dismissRadius: CGFloat
    let dismissGlyph: CGFloat
    let actionMinHeight: CGFloat
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
    let actionBorder: Color
    let shadowColour: Color
    let shadowRadius: CGFloat
    let shadowX: CGFloat
    let shadowY: CGFloat
    let arrival: Animation

    /// A tone's edge colour. A tone the spec does not define draws with the
    /// subject colour, matching how the desktop's stylesheet falls back to a
    /// neutral stripe rather than to nothing.
    func toneColour(_ tone: String) -> Color {
        colour(for: tone, keyPath: \.edgeColour) ?? subjectColour
    }

    /// A tone's tint, for the icon chip.
    func toneTint(_ tone: String) -> Color {
        colour(for: tone, keyPath: \.tintColour) ?? .clear
    }

    private func colour(for tone: String, keyPath: KeyPath<(edge: String, tint: String, glyph: String, edgeColour: String, tintColour: String), String>) -> Color? {
        guard let entry = NoticeTokens.tone(tone, mode: mode) else { return nil }
        return Color(css: entry[keyPath: keyPath])
    }

    static func forMode(_ mode: String) -> NoticeCardStyle {
        /// A value from the card section, with a token name resolved if that is
        /// what the spec recorded.
        func card(_ name: String) -> String? { NoticeTokens.cardValue(name, mode: mode) }
        /// A token resolved straight from the palette.
        func token(_ name: String) -> String? { NoticeTokens.resolve(name, mode: mode) }
        func colour(_ text: String?, fallback: Color = .secondary) -> Color {
            guard let text, let parsed = Color(css: text) else { return fallback }
            return parsed
        }
        let shadow = CSSShadow(card("shadow"))
        let padding = CSSPadding(card("padding"))
        let bezier = CSSBezier(NoticeTokens.resolve("--ease-out", mode: mode))
        return NoticeCardStyle(
            mode: mode,
            radius: CSSLength(card("radius")) ?? 14,
            edgeWidth: CSSLength(card("edgeWidth")) ?? 3,
            gap: CSSLength(card("gap")) ?? 12,
            // The desktop banner's stack gap is its own, because a bar spanning a
            // window and a card over a phone screen are not the same rhythm, and
            // the screen inset here is the phone's own edge clearance.
            stackGap: 8,
            inset: 8,
            padding: padding,
            iconSize: CSSLength(card("iconSize")) ?? 28,
            iconRadius: CSSLength(card("iconRadius")) ?? 6,
            glyphSize: CSSLength(card("glyphSize")) ?? 16,
            headlineSize: CSSLength(NoticeTokens.sizes["sm"]) ?? 12,
            subjectSize: CSSLength(NoticeTokens.sizes["xs"]) ?? 11,
            actionSize: CSSLength(NoticeTokens.sizes["xs"]) ?? 11,
            headlineWeight: .css(NoticeTokens.weights["headline"] ?? 650),
            actionWeight: .css(NoticeTokens.weights["action"] ?? 600),
            dismissSize: CSSLength(card("dismiss.size")) ?? 24,
            dismissRadius: CSSLength(card("dismiss.radius")) ?? 6,
            dismissGlyph: CSSLength(card("dismiss.glyph")) ?? 14,
            actionMinHeight: CSSLength(card("action.minHeight")) ?? 28,
            actionPaddingHorizontal: CSSPadding(card("action.padding")).leading,
            actionPaddingVertical: CSSPadding(card("action.padding")).top,
            actionRadius: CSSLength(card("action.radius")) ?? 10,
            surface: colour(card("surface"), fallback: .clear),
            border: colour(card("border"), fallback: .clear),
            headlineColour: colour(token("--text-strong")),
            subjectColour: colour(token("--muted")),
            dismissColour: colour(card("dismiss.colour")),
            actionColour: colour(card("action.colour")),
            actionSurface: colour(card("action.surface"), fallback: .clear),
            actionBorder: colour(card("action.border"), fallback: .clear),
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

/// `11px 14px`, or one value for all four edges, which is what CSS padding
/// shorthand means. More than two values is not used in the spec and is refused
/// rather than half-honoured.
func CSSPadding(_ text: String?) -> EdgeInsets {
    guard let text else { return EdgeInsets() }
    let parts = text.split(separator: " ").map(String.init)
    let values = parts.compactMap { CSSLength($0) }
    guard values.count == parts.count, !values.isEmpty else { return EdgeInsets() }
    if values.count == 1 {
        return EdgeInsets(top: values[0], leading: values[0], bottom: values[0], trailing: values[0])
    }
    guard values.count == 2 else { return EdgeInsets() }
    return EdgeInsets(top: values[0], leading: values[1], bottom: values[0], trailing: values[1])
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
