import SwiftUI

/// Settings and About as ONE presented surface, with the handoff between them ours.
///
/// ## Why one surface, and not two sheets
///
/// `core/ui/surface.js` `cover()` slides the card of the surface underneath out
/// of the way and holds it there, and it answers `false` inside a native sheet on
/// purpose: there the card IS the platform's presentation, so moving it down means
/// dismissing it, and a dismissed sheet is the tab and the scroll position the
/// behaviour exists to preserve, gone.
///
/// Two native sheets are also this client's version of the fault that was
/// reported. SwiftUI presents the second sheet over the first, and iOS keeps the
/// first sheet's card on screen behind it, its top edge above the second sheet
/// under the platform's dim, so the two surfaces ARE on screen together: the
/// desktop's two cards in one window, reached a different way. The pair is
/// therefore ONE presentation, and the handoff happens inside it, where both cards
/// are ours to move. The settings card slides down and is HELD there with its view
/// still attached, and About slides up over it; closing About brings the settings
/// card back on the arrival path the stylesheet already declares, so the tab it
/// was on and its scroll position are still there, which is the behaviour the
/// desktop's `reveal()` preserves.
///
/// The dim deliberately does not move with either card. It belongs to the sheet,
/// and the sheet stays, so the interface never flashes undimmed between the two:
/// the same rule the shared `surface--stacked` mark enforces on the desktop by
/// keeping the lower surface's scrim clear.
///
/// ## The order, which is the report
///
/// Abi, 2026-10-01: *"the settings page should slide down and then the about page
/// should slide up"*. Two steps, so the settings card's departure is awaited
/// before About is let in, and the two are never in flight at once. About's view
/// joins the tree as the handoff starts rather than as it is revealed, so its page
/// loads while it is still below the bottom edge and arrives painted.
struct SurfacesHandoff: View {
    /// The settings surface. Never removed while this view is: it is what carries
    /// the tab and the scroll position back to the reader.
    let settings: SettingsSurface

    /// The About surface, built once by `ContentView` for the life of the app.
    let about: AboutSurface

    /// Whether About is up. Owned by `ContentView`, and set by the same commands
    /// the desktop answers: the settings page's `openAbout` opens it and About's
    /// `closeOverlay('about')` closes it.
    @Binding var showingAbout: Bool

    /// Whether the reader asked for no motion, which swaps every slide here for the
    /// shared short fade, exactly as the stylesheet does for the desktop.
    let reduceMotion: Bool

    /// Whether About's view is in the tree. It joins as the handoff starts and
    /// leaves once the settings card is back, so a page that is off screen is not
    /// loading for the whole life of the app.
    @State private var mounted = false
    /// The settings card has gone down.
    @State private var covered = false
    /// About has come up.
    @State private var aboutUp = false

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .top) {
                settings
                    .offset(y: covered ? proxy.size.height : 0)
                if mounted {
                    about
                        .offset(y: aboutUp ? 0 : proxy.size.height)
                }
            }
            // Neither card may draw outside the surface: a card parked below the
            // bottom edge is off screen, not over the home indicator.
            .clipped()
        }
        // The same two commands the desktop's `cover()` and `reveal()` answer.
        .onChange(of: showingAbout) { _, open in
            if open { cover() } else { reveal() }
        }
        // A surface that arrives with About already up (a screenshot run states
        // both facts in one launch) is covered before it is ever drawn, rather
        // than sliding in over a card that is still on screen.
        .onAppear {
            guard showingAbout else { return }
            mounted = true
            covered = true
            aboutUp = true
        }
    }

    /// The settings card down, and then About up.
    ///
    /// Two steps rather than one: see "The order" above. The completion is the
    /// animation's own, so the second step starts when the first has actually
    /// finished rather than after a duration guessed here.
    private func cover() {
        mounted = true
        let down = Motion.handoffAnimation(reduceMotion: reduceMotion, leaving: true)
        let up = Motion.handoffAnimation(reduceMotion: reduceMotion, leaving: false)
        withAnimation(down, completionCriteria: .logicallyComplete) {
            covered = true
        } completion: {
            withAnimation(up) { aboutUp = true }
        }
    }

    /// About down, and then the settings card back up on its arrival path.
    private func reveal() {
        let down = Motion.handoffAnimation(reduceMotion: reduceMotion, leaving: true)
        let up = Motion.handoffAnimation(reduceMotion: reduceMotion, leaving: false)
        withAnimation(down, completionCriteria: .logicallyComplete) {
            aboutUp = false
        } completion: {
            withAnimation(up) { covered = false }
            // Kept mounted one beat longer than the reveal: unmounting in the same
            // transaction as the last frame of the slide would take it away while
            // it is still travelling.
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(Motion.sheetEnterMs) / 1000) {
                mounted = false
            }
        }
    }
}

