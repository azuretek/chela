# Design conventions: our own surfaces

How the pages in this directory (settings, about, pairing, loading, banner,
titlebar) look and behave when something changes. `spec/tokens.json` owns the
VALUES; this file owns the RULES that use them, so a new view does not have to
guess what "smooth" meant to the last one.

**It is also the design language for our own surfaces**, which is why the rules
below cover the space between two blocks, what a press does and where a colour
choice comes from as well as what moves: a fault that has been reported twice
belongs here rather than in the fix that answered it.

Applies to every client. The desktop draws these pages in child views over the
Control UI and the phone draws them in sheets, and the motion below is CSS in the
pages they share, so both clients move alike. Where a client's own chrome is
native (an iOS sheet's presentation), the platform's own animation stands in and
the same rules apply to choosing it.

## ★ The rule: a view change never shows a view the reader did not ask for

Smooth and intentional starts here and this part is not about motion at all.

**The destination must be READY before it is revealed**, and nothing in between
may be shown: not the previous view, not a half-painted destination, not a
placeholder. If a change would put the wrong thing on screen for a moment, that
is a SEQUENCING fault and it is fixed by making the right thing arrive first.
Animation is what makes the right thing arrive well. It is never a way to make
the wrong thing arriving acceptable, and a cross-fade over a view the reader did
not ask for is still that view.

The worked example, and the reason this file exists: "Go to the Control UI"
dismissed our settings surface and then asked the Control UI for its own
settings, so the reader was returned to whatever the Control UI had been showing
and watched it for the whole of the destination's load. Nothing was wrong with
the destination. The order was wrong, and no easing would have fixed it. See
`app-settings-affordance.js`'s readiness question and `main.js`'s
`openControlUiSettings`.

Corollary, for the case where the destination genuinely cannot be ready: hold the
surface the reader is on and reveal on a bounded deadline. A waiter that can only
succeed is a surface that never lets go, which is a worse fault than the one being
avoided.

## ★ The second rule: a disconnected or failing client never presents a gateway view

**A gateway's page on screen is a claim about the reader's state.** It says "you are
connected to this gateway, authenticated, and this is it". So it may be shown only
while both halves of that claim hold: **the document belongs to the gateway this
client is pointed at**, and **the connection it belongs to has not failed or ended**.
Either half false and the client shows ONE OF ITS OWN surfaces instead: the loading
cover in its stopped state, the pairing screen, or settings.

This is worse than a missing screen, which is why it is a rule rather than a
preference: a blank window or a failure notice tells the reader nothing, and a
previous gateway's working interface tells them something untrue, in the one place
they would go to find out whether they are connected. "Eventually" is not the claim
either. The hold must end when the connection does, because a hold that outlives
its connection has no bound of its own.

The rule is one function, `mayPresentGatewayView` in `core/connection.js`, so every
client reads the same answer rather than deciding case by case:

| On screen, and the client is... | May the gateway view be shown? |
|---|---|
| the ACTIVE gateway's document, connected or connecting | Yes. The reader's place, or the place being fetched. |
| the ACTIVE gateway's document, awaiting device approval (`pending`) | Yes. Our pairing screen is drawn OVER it; the gateway did answer. |
| a DIFFERENT gateway's document | Never. The reader asked to go somewhere else. |
| any document, connection `failed` | Never. Nothing is connected. |
| any document, no gateway configured (`idle`) | Never. |
| one of our own pages, or nothing | n/a, there is no gateway view to show. |

The two failures the rule was written from, both measured with
`desktop/scripts/test-held-gateway-view.js` rather than reasoned about, and both
screens that looked authenticated and working:

- **Connect to a gateway that fails, from a gateway that was working.** The attempt
to the second gateway was made *beside* the first gateway's document, and the
failure ended nothing: the reader was left looking at the gateway they were last
connected to, with only a notice over it, for as long as they kept looking.
- **A gateway that dropped.** Nothing on this side could see it: the page holds the
only socket either side has, so a close with no pairing reason reached no surface
this client owns and its Control UI stood there for as long as the window was open.

Both halves are therefore part of the rule, not implementation detail: an attempt
to a different gateway raises the cover BEFORE it is made, and a failed attempt, a
dead renderer, or a socket the gateway closed all END the hold. A failure is
reported over the app's own surface, never over a document that was being kept.

What this does NOT change, and the reason the two rules sit together: a fresh copy
of the destination may be fetched WITHOUT disturbing what is on screen (the attempt
happens off-screen and is promoted only once it has loaded), and a successful
attempt lands on the new document with nothing shown in between. The hold is
bounded, not the sequencing. `desktop/scripts/test-held-gateway-view.js --case
normal` is the measurement that the sequencing still holds.

Implemented by `mayPresentGatewayView` (`core/connection.js`), the hold itself and
the failure and drop handlers in `desktop/src/main.js` (search `payloadGateway`),
and the observer's `socketClosed` report in `core/spec/pairing.json`. Guarded by
`desktop/test/connection.test.js` (the truth table),
`desktop/test/payload-freshness.test.js` (the host's half) and
`desktop/scripts/test-held-gateway-view.js` (the frames).

## ★ The third rule: nothing takes focus unless by rule

Abi, 2026-09-17: *"can we also make these banners not change our focus? when they
pop up what I'm typing gets stopped. nothing should take focus unless its by
rule"*. This is the third fault in this one area, after click-swallowing and the
transparent overlay, and it is a rule rather than a fix because the first two were
each re-introduced by the next change that seemed reasonable on its own.

**What may take the keyboard is an action the reader took, and nothing else.**

| MAY take focus | MAY NOT take focus |
|---|---|
| A control the reader pressed, or a field they clicked into. | A surface that APPEARED on its own, meaning the notice bar or the loading cover. |
| A surface the reader OPENED: Settings, About, pairing, and anything a notice offers to open. | A card being dismissed, or the bar going away. |
| A key that moves focus by convention, such as the tab bar's own arrow keys. | A value, a status or a count changing where it sits. |
| The window itself, when the reader asks for it: the tray, the global shortcut, the Dock. | A list rebuilding, or a view being replaced under the reader. |

**A caret and a text buffer survive everything in the right-hand column.** That is
the test rather than a side effect: focus is the reader's, so a notice arriving
mid-sentence must leave their cursor exactly where it was and their half-typed text
in the field it was in.

**★ The mechanism, because it is not a `focus()` call and reading the code will not
find it.** Measured 2026-09-17 on Electron 44: a `WebContentsView` that is added to
the window and THEN loaded hands the window's keyboard to its own page the moment
its document commits, and it keeps it. `new WebContentsView(...)` does not do it,
`contentView.addChildView(...)` does not do it, `setVisible(false)` does not stop
it, and removing the view afterwards drops the keyboard to NOTHING rather than
handing it back. So the fix is the ORDER: **load a view while it is OFF the
window, then attach it**, which is `attachReadyView` in `desktop/src/main.js`.
Measured in the same run: loaded detached, the page underneath kept the keyboard
through the load, the attach, a DOM change and the view's removal.

So a surface that appears on its own, the notice bar and the loading cover, is
loaded off the window and attached once its document is ready, and a surface the
reader OPENED is attached first and explicitly focused. That second half is part of
the rule rather than an exception to it: a dialog the reader cannot type into is a
dialog that does not work, and the reader opening it is the action that licenses
the keyboard.

### Every place a surface of ours moves focus

Walked on 2026-09-17, one row per call site, so a new one can be added here or
named as deliberate rather than left to be discovered by a report.

| Where | What happens | Why it is right |
|---|---|---|
| `main.js` `showMainWindow()` | `mainWindow.focus()` | The tray, the global shortcut and the Dock are the reader asking for the window. |
| `main.js` `openOverlay()` | `wc.focus()` once the page has loaded, and again when an already-open overlay is re-opened | The reader opened Settings or About. A surface they are meant to type into must own the keyboard. |
| `main.js` `closeOverlay()` | Hands the keyboard to the overlay still under it, else to the gateway page | The reader closed a surface, and this is the keyboard going back where they were. |
| `main.js` `refreshBanner()` | **Nothing, and that is the change.** Its page is loaded off the window; a dismissal hands the keyboard back only if the reader had tabbed into the bar | The bar appearing, changing and going are all things nobody did. |
| `main.js` `showLoadingCover()` and `styleLoadingCover()` | The cover no longer takes the keyboard at all: loaded off the window, attached once styled | A cover appearing on its own is not an action, so the page underneath keeps the caret while it is up. |
| `main.js` `hideLoadingCover()` | Hands the keyboard to the top overlay, else to the page | The view the reader was typing in may have been REPLACED while the cover was up, so the keyboard has to be put somewhere rather than left with nothing. |
| `main.js` `createMainWindow()` and `beginGatewayConnect()` | The gateway page is attached and then loaded, so it takes the keyboard as it loads | The reader's own page, opened by their own action, and the Control UI's own composer must be typable the moment it arrives. |
| `settings.js`, the filter's clear control | `gatewayFilter.focus()` | The reader pressed it, and the cursor goes back to the field they were filtering by. |
| `settings.js`, the tab bar | `tab-<name>.focus()` on arrow, Home and End | The reader pressed the key, and moving focus within the tab list is the convention for a tab bar. |
| `banner.js`, `banner.html` | No `focus()` call and no `autofocus` anywhere. Its controls are focusable | The reader may tab into the bar, which is an action and is why the bar must stay reachable by keyboard; nothing is ever pressed on them. |
| `mobile/Claw/NoticeBanner.swift`, `ContentView.swift` | The banner is a plain SwiftUI overlay: no `@FocusState`, no `becomeFirstResponder`, no sheet for a notice | The phone's half of the same rule. A SwiftUI overlay appearing does not move focus, so nothing had to change; this client's fault was the desktop's view hierarchy, not a shared page. |

## ★ The fourth rule: one gap between two blocks, and it comes from the scale

**A gap is a value like any other**, so it comes from the spacing scale in
`ui.css`'s `:root` (`--space-1` at 4px through `--space-8` at 40px) and never from
a number typed at the call site.

**Between two blocks there is ONE gap, and it belongs to the block BELOW.** A top
margin on the lower block rather than a bottom margin on the upper one is what
keeps the value single when a block moves: the first block in a holder, the last
and one in the middle of a list all take the same gap without a boundary case, and
no two margins can add up into a distance nobody chose.

| Where | Gap |
|---|---|
| Between two blocks in a holder: two cards, a card and the block after it, two entries in a host | `--space-3`, 12px |
| A card's last row to the card's own edge | `--space-4`, 16px, because the card's corner rounds 14px and a control inside that curve reads as clipped |
| Inside a row: the text column against the control column | `--space-4` |
| Inside a row: two controls beside or under each other | `--space-2` |
| A heading above its block | the heading's own margin, and it is the larger one so collapsing gives it the win |

**A block that asks for spacing of its own keeps it.** Headings and the settings
footer carry their own larger top margin, and the shared gap is written so it
cannot displace one: the rule in `ui.css` sits at zero specificity, which is what
makes it a fallback rather than an assignment. Written with a specificity of its
own it silently flattens both.

**★ The reported case, because it is the shape of the trap.** The About page's
fact table follows the cached-code CARD, and it took no gap at all: the table sat
hard under the card's edge while the two cards above it were spaced 12px apart.
The rule that existed asked "is this a group with something above it?", and the
table is not a group, so the question never reached it. **Ask it in both
directions**, and ask it of the block that is there rather than of the kind of
block the last fault happened to involve.

## ★ The fifth rule: no Save buttons, and a press is answered where it was made

**Our surfaces have no Save button, on any client.** A value commits on the
reader's OWN commit gesture: Enter in a field, leaving a field after editing it,
or a control that is switched or chosen. The confirmation belongs to the row the
value is in and it STAYS there.

Both halves of that are the reason rather than a side effect:

- **A Save button makes the screen's state and the stored state two things that
  can disagree**, and it makes every field raise "have I saved this?" while the
  reader is still typing. A phone has no such control for its own settings, and
  neither do we.
- **A write that spans several fields becomes a sequence of commits rather than
  one press.** Empty means keep, per field: emptying a field writes nothing to
  it, and the control that REMOVES a stored value stays the only way to clear
  one.
  - **A section's fields commit on their own gestures, and leaving the section
    commits whatever was filled in it.** That second half is what keeps a value
    from being typed, left and silently dropped when the reader's own gesture was
    not the one the page expected. **A move WITHIN the section is never a commit**,
    because the re-render that follows a commit takes the field a reader who is
    still filling the form in was moving to.

**A control that cannot answer instantly is answered in place, and its RESULT goes
to the banner**, in that order:

| The control | When |
|---|---|
| Disables itself, so a second press cannot start a second job | on the press |
| Says what it is doing on ITSELF, its label in the progressive form: "Check for updates" becomes "Checking…" | on the press |
| Ends the busy state on the host's own push that the work finished, or on a bounded deadline, whichever comes first | when the job ends |

**★ A press never writes a line that appears and then disappears.** That is a view
the reader did not ask for, which the first rule already forbids, and it is what a
reader experiences as something flashing that they cannot read. Reported
2026-09-17 on the phone's About page: the only thing a press showed was a line
that appeared and vanished, and the answer it carried was never seen. The busy
state being on the CONTROL is also what makes it visible where the reader is
looking, and it is the phone platforms' own answer for the same job.

**A result that outlives the press belongs to the banner**, because the reader may
have looked away, and a result that expired with their attention is one they never
got. A line under a control is for a report that stays until the surface closes,
meaning what a clear actually cleared.

## ★ The sixth rule: colour is not ours to choose

**No client draws an appearance control.** The system's appearance flows down, and
the Control UI's own theme flows up: the page reports its theme and our chrome
repaints from it, which is what `adoptTheme` in `desktop/src/main.js` already does.
A control of our own is a second control for a choice the Control UI owns, and the
two disagree the first time only one of them is used. Reported 2026-09-17 as "it
does not work right anyway".

Where a client paints something the page cannot reach, meaning the phone's status
bar and the strips above and below the web view, it takes the same two answers in
that order and does not add a third.

## ★ The seventh rule: the colour flows into the strips, from ONE source

**The strips the safe area leaves above and below a page belong to the app, and they
are painted from ONE background, so the top of the screen and the bottom are the same
colour by construction.** Reported 2026-09-18: "the color on the top and bottom of my
screen being different, it should always flow".

- **The page is laid out INSIDE the safe area** (see `mobile/Claw/ContentView.swift`),
  so neither strip is the page's to draw: it cannot paint a band the reader sees above
  or below itself, and whatever appears there is the app's paint.
- **One painter, at the root, outside the safe area.** A `background` rather than an
  overlay, because a background takes no part in layout: the page's own frame must not
  move for a colour. It went on the web view first, where it was clipped to the web
  view's own inset frame, and that is the arrangement in which one end can disagree
  with the other.
- **The colour is the page's own reported background**, through the theme relay
  (`WebView.themeScript`): the value the interface is actually painted with, not a
  token of ours and not the window's colour.
- **A band that disagrees is a bug in the wrapper, not a style.** Same shape as the
  sixth rule: the reader must never see our chrome and the interface disagree.

## ★ The eighth rule: a transient state is held long enough to read

Abi, 2026-09-18: *"make the speed of the state changes visually take long enough
for someone to be able to understand what is happening, lets make that part of our
design language and apply it to everything in our ui."*

**A state the reader is meant to READ has a floor on how long it stays on screen,
and the floor is the same everywhere.** The floor is `motion.minVisibleMs` in
`spec/tokens.json` (900ms), and the primitive that applies it is
`core/ui/motion.js` (`remainingVisibleMs`, `heldLongEnough`). A transient state
shown at time T may be replaced no earlier than T + the floor: a caller with
something newer to show waits out the remainder and then shows it; a caller with
nothing newer ignores it.

**This is about how long a state STAYS, not how it MOVES.** The durations under
Durations and easing govern the animation of a change; this governs the dwell of
the state between two changes. The two are different questions and a fast animation
onto a state that is then replaced in the next tick is still a flash. So the floor
is far longer than `--duration-normal` (180ms): it is the span of a glance that
lands, finds a short sentence, reads it and confirms it.

**The fault it answers, and why it is a rule rather than a fix.** Reported on the
"Check for updates" button: the first press raised the banner, a second press "just
flashes and returns quickly". The check's answer settled in the time a cached
network reply takes, which is no time at all, so the card it raised was replaced
before it could be read. The same shape is the fifth rule's "a press never writes a
line that appears and then disappears" seen from the other side: there the answer
was on a control, here it is on the banner, and the floor is what both need.

**Where it applies, and where it deliberately does not:**

| Floor it | Do NOT floor it |
|---|---|
| The answer to a press: "up to date", "an update is available", a check that failed. It is transient (it has a TTL) and it is the reader's answer, so it must outlast the glance. | A STANDING condition. A notice that stays until it is fixed is not transient; it is already on screen for as long as the condition holds, so a floor is meaningless. |
| A transient state that REPLACES another transient state: "checking" giving way to its result. The result waits until "checking" has had its floor, so the reader sees that a check happened before they see what it found. | A value changing in place that the reader is watching (a count, a progress percent). The seventh-and-below rules already say these snap; a floor would freeze a live number. |
| The held "up to date" the manual check shows from cache, so it is a state and not a flash. | Anything the reader triggers repeatedly or at speed. A floor there stacks into lag, which is the at-speed case the motion rules already exempt. |

**The primitive is clock-free and takes `now`**, so the rule can be exercised for
every timing from one test run (`core/test/motion.test.js`) rather than by waiting
real seconds. A surface that owns a live timer (the desktop update lane) reads the
remainder and schedules its own replacement; a surface that cannot (a page) reads
the same constant through the token layer.

**Rollout is deliberate, not a sweep.** The primitive plus the update banner plus
the other clearly-transient states is the safe unit; applying it to every component
at once is the mass edit the reader did not ask for. The broader rollout is
proposed rather than done, so each application is a place someone decided a state
was transient rather than a global default that freezes something live.

## ★ What counts as a transition

**A transition is any change the reader can SEE, and it does not have to change the
view to be one.** The two rules above say what may be on screen while something
changes, and the motion below is how the change is made; both apply to a change
INSIDE a view exactly as they do to one BETWEEN views. That includes, and this list
is the point of the section rather than an example of it:

- **A surface arriving or leaving the window**, and a panel replacing another inside
  one.
- **A form, a panel or a row expanding or collapsing in place**, which is the
  gateway editor's own disclosure: the reader presses Edit and the fields take the
  space they need, and presses Done and gives it back.
- **A section appearing or disappearing** without anything having navigated.
- **A list reordering**, or an entry joining or leaving it.
- **One value replaced by another in place**, such as a status line or a count.

**An in-place change is NOT exempt merely because no view changed.** This is the
case that gets left as a pop, and the reason is exactly that nothing navigated: a
rule about view changes never fires, so the fields are simply there on the next
frame and nobody notices that a transition happened at all. Naming it here is what
stops the next one being left that way, since a rule whose scope is "view changes"
reads as satisfied by every screen that never changes view.

**Every transition runs in BOTH directions.** A change is not over when the thing
appears: it has to go away as well, and the reader is watching for that. So a
disclosure that opens smoothly and shuts in a single frame is half a transition, and
half is not a smaller version of the rule; it is a pop with a nicer entrance. The
departure is the arrival played backwards when it is the same path, and a movement of
its own when it is not.

**They are not all moved by the same thing.** This section says what COUNTS as a
transition; which of them moves, and how, is the tables below, and two kinds
deliberately snap there and say why: anything the reader triggers repeatedly or at
speed, where any movement lags the hand, and a value changing in place, which is one
number moving rather than a view arriving. Every one of them is nonetheless subject
to the sequencing rule above, to the reduced-motion form, and to the verification at
the end of this file.

## Durations and easing

Two durations, from the shared token layer, and nothing animates for longer:

| Token | Value | Use |
|---|---|---|
| `--duration-fast` | 100ms | A change WITHIN one surface, and every LEAVE. |
| `--duration-normal` | 180ms | A surface ENTERING the window. |

**Leaving is always quicker than arriving.** A surface arriving has to be read;
a surface leaving has already been read, and the reader is waiting to see what is
behind it. So arrival takes `--duration-normal` and departure takes
`--duration-fast`.

Easing:

| Token | Value | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entering. Fast off the mark, gentle into place. |
| `--motion-leave-ease` | `cubic-bezier(0.4, 0, 1, 1)` | Leaving, when the departure is a movement of its own. Accelerates away, so it does not linger at the end. |

The arriving curve decelerates so the thing lands rather than stops. The leaving
curve accelerates for the mirror reason: a decelerating exit spends its last
frames almost stationary, which reads as the surface being reluctant to go.

**A departure that is its arrival played backwards keeps the arrival's curve**, and
takes the shorter duration to say it is going. It is the same movement in reverse
rather than a movement of its own, so reversing the curve with it is what makes the
pair read as one object going back the way it came. Leaving by a different path (a
surface that rose in and drops out) is a movement of its own and takes
`--motion-leave-ease`.

There is a hard constraint behind that rule as well as a design one: `banner.css`
reads only tokens the layer emits, which `desktop/test/tokens.test.js` asserts, and
`--motion-leave-ease` is ours rather than borrowed so it is not one of them. The
notice card's departure is the mirrored kind anyway.

Both durations are the Control UI's own borrowed tokens. `--motion-leave-ease` is
OURS, because upstream publishes one curve and an exit needs the other shape. It
lives in `ui.css`'s `:root` with the other values we own, and not in
`spec/tokens.json`: every value in that spec is checked against the upstream
checkout, so a value of ours there would fail the day upstream has no such name.

## What moves, and what stays still

Only `opacity` and `transform` ever animate. Both are compositor properties, so a
view can move without the page relaying out, and no animation can resize the
window or shift the reader's content under them.

**Animates:**

| Change | Motion |
|---|---|
| A surface entering (overlay, cover, sheet) | Scrim fades in. Card fades in and RISES 8px into place (`--motion-rise`). |
| A surface leaving | Scrim fades out. Card fades out and drops 4px. No rise: it is going back the way it came. |
| A panel replacing another in the same surface (settings tabs) | The incoming panel fades in and enters from the side the reader moved TOWARD, 12px (`--motion-slide`). |
| A notice card appearing | Slides DOWN from above the viewport (already so, and it keeps that direction: it arrives from the edge it occupies). |
| A notice card being dismissed | Slides back UP by the same path, over `--duration-fast`. |
| **A disclosure opening or closing in place** (the gateway editor's Edit) | The panel's wrapper opens its track from `0fr` to `1fr`, and the panel underneath fades in and RISES 8px into place (`--motion-rise`), over `--duration-fast`. Closing shuts the same track by the same path, with the panel fading out in place: the arrival's rise has a direction the collapse does not, so only the opacity is mirrored. |

**Snaps, always, and an animation here is a fault:**

- **Layout.** Height, width and reflow. A view's height must be final on its first
  frame, or everything under it moves while it animates. The banner's own comment
  records this being learned the hard way.
  - **The one exception is a DISCLOSURE, and it is named rather than allowed in
    general: the gateway editor's opening and closing, and nothing else.** The space
    a disclosure takes IS the change, so there is no frame at which its height could
    already be final, and there is no compositor-only way to make room for it:
    opacity and transform cannot open a gap.
  - What animates is therefore **`grid-template-rows` on one wrapper**, `0fr` to
    `1fr` and back, with the wrapper a grid at rest as well as while it moves so the
    box it measures is the same before, during and after. The item that track is
    measured against is a **bare panel**, never the visible editor: a track will not
    shrink below the item's own margin, border and padding, and the editor has all
    three, so with the editor as the item the track floored at 29px and the closing
    press ended in a jump of exactly that height.
  - **Its content still arrives on opacity and transform** underneath the track, and
    it still takes `--duration-fast` in both directions. Clipping is part of the
    moving classes only, never of the resting rule, so an element at rest is not a
    clip container and no focus ring is cut.
  - **A VIEW's height is still final on its first frame.** This does not license
    animating the window, a surface, a panel, a list reorder, or a reflow of the page
    around anything else.
- **Anything the reader triggers repeatedly or at speed**: hover, focus,
  selection, disabled, checkbox flips, the tab bar's own underline, text and
  numbers changing in place.
- **The outgoing thing, whenever two things would overlap.** A tab change hides
  the old panel at once and animates only the new one. Cross-fading two panels
  means both are on screen for the duration, which is showing the reader a view
  they did not ask for, and it needs absolute positioning to stop them stacking.
- **The Control UI.** Its content, its scroll position, its theme.
- **Values that are not view changes.** A progress bar's width is one value
  moving, not a view arriving, and it keeps its existing linear transition.

**In-place changes that deliberately snap, and each one by name.** Because the rule
above covers a change INSIDE a view, these are answers rather than omissions: every
one was found by walking our own surfaces, and every one is a case where motion
would cost the reader something.

- **A count or a status line changing where it sits.** The Problems tab's count, the
  About page's update hint, the answer line under a gateway form. These are the
  "values, not view changes" case above, and they change while the reader is looking
  at them.
- **A CONTROL appearing as the surface's own state changes.** The loading cover's
  Retry button is the clearest: it appears at the moment the attempt fails, and that
  failure is the answer the reader has been waiting on, so a hundred milliseconds of
  it fading in is a hundred milliseconds of the one control they now need. The
  pairing page's docs link is the same shape.
- **A list the reader is filtering.** The gateway search rebuilds its list on every
  keystroke. This is the "at speed" case, and an entry animating under a typing hand
  is a list that lags the keyboard.
- **An entry arriving in, or leaving, a list the page draws from state.** The notice
  history, and the certificates waiting review. These ARE transitions the rule
  covers, and the reason they are left alone is not the one above: the space an entry
  takes comes from the state rather than from a press, so it is one of many rows a
  reader may be scanning, and animating each of them makes a list of two hundred
  entries the animation. Where such a change is the reader's own doing, it is the
  at-speed case instead.

**Direction follows the change.** Motion points the way the reader moved, or the
way the thing is going:

- Moving to a tab to the RIGHT brings its panel in from the RIGHT. The incoming
  panel starts offset toward the side it is arriving from and settles at zero.
- A surface arriving comes FORWARD, which is the rise; a surface leaving goes back
  the way it came, which is the drop.
- A notice arrives from the edge it lives on (above) and leaves back through it.

Motion that points the wrong way is worse than no motion: it tells the reader they
went somewhere they did not.

## Reduced motion

**Every rule above has a reduced-motion form, and it is part of the rule rather
than an exception to it.**

`@media (prefers-reduced-motion: reduce)` turns every view-change animation off
(`animation: none`), which leaves each element at its ordinary resting state, and
`clawSurface.leave()` resolves at once so a host removes the surface immediately
instead of waiting a duration it is not going to animate.

Two things this must NOT change:

- **The sequencing.** Reduced motion removes MOTION, not the readiness rule. The
  destination is still ready before it is revealed, nothing intermediate is still
  shown, and a reader with the preference set gets the same CORRECT transition,
  just without the movement.
- **The end state.** Nothing may depend on an animation having run. Every
  animated element must be at its correct resting state when no animation runs at
  all, which is also what makes a view that never painted behave.

The preference is read in the page (`matchMedia`) and never passed down from a
client, so one page cannot animate while its sibling respects the setting.

## Verifying a transition

A transition is a claim about what was on screen DURING it, so it is checked with
a recording or a burst of captures, never by its endpoints. `npm test` passing
says nothing about a view that appeared for four frames.

- Capture from the trigger to the destination being visible, at frame or
  near-frame resolution, and assert that **no frame shows a view the reader did
  not ask for**. Compare frames against BOTH ends of the journey, not just the
  destination: a frame close to where the reader came from and far from where they
  were going is the fault this file opens with.
- Report the measured duration. Compare it against the token above, since an
  animation that takes longer than `--duration-normal` is a delay.
- State the reduced-motion behaviour for the transition, and that it is the same
  sequence without movement.
- **An in-place transition is checked the same way, and in both directions.** A
  disclosure has an opening AND a closing to capture, and the closing is the half
  that gets skipped: it is the same claim about what was on screen, and a reader
  who watches a panel fold away deserves the same answer as one who watched it
  arrive. The duration is measured across the whole of each direction, from the
  press to the element being gone.
- `desktop/scripts/test-affordance-placement.js` is the worked example: it drives
  the real control, captures the composited window through the change with several
  concurrent capturers, samples the layers and the route alongside, and compares
  every frame against both ends.
