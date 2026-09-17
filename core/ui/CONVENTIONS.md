# Design conventions: our own surfaces

How the pages in this directory (settings, about, pairing, loading, banner,
titlebar) look and behave when something changes. `spec/tokens.json` owns the
VALUES; this file owns the RULES that use them, so a new view does not have to
guess what "smooth" meant to the last one.

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

**Snaps, always, and an animation here is a fault:**

- **Layout.** Height, width and reflow. A view's height must be final on its first
  frame, or everything under it moves while it animates. The banner's own comment
  records this being learned the hard way.
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
- `desktop/scripts/test-affordance-placement.js` is the worked example: it drives
  the real control, captures the composited window through the change with several
  concurrent capturers, samples the layers and the route alongside, and compares
  every frame against both ends.
