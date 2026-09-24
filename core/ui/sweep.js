'use strict';

// The notice sweep: the one control that closes the whole bar, meaning read
// everything on it.
//
// ★ WHY ITS OWN VIEW, in one line: a WebContentsView claims every mouse event
// inside its rectangle whatever the page draws there, so anything sharing the
// bar's view shares the bar's rectangle, and a control on a band of its own makes
// the rest of that band a dead zone over the Control UI. Sized to the button
// alone, the sweep claims the pixels it draws and gives the rest back. See the
// note in sweep.html and refreshSweep in src/main.js.
//
// It reads no notices. Whether the sweep exists at all is the store's answer,
// which main asks for (see sweepWanted), and its one job here is its own size.

const api = window.clawDesktop;
const button = document.getElementById('sweep');

// Reading the bar is not clearing it, so this is the whole of what the control
// does: the store owns what marking all read means, as it does for the per-card
// X.
button.addEventListener('click', () => { void api.markNoticesRead(); });

function report() {
  // Synchronous on purpose, and the same shape as the bar's own height report:
  // `getBoundingClientRect` forces layout, so the number is right on the first
  // frame -- and waiting for a frame would deadlock, because requestAnimationFrame
  // does not fire for content that has not painted, and the size that would make
  // it paint is the one being reported.
  const box = button.getBoundingClientRect();
  void api.sweepBounds({ width: Math.ceil(box.width), height: Math.ceil(box.height) });
}

window.addEventListener('resize', report);
report();

// The label and tooltip are core/spec/banner.json's, the same words the iOS pill
// uses. sweep.html carries the same label so the first report is the right size;
// core/test/banner-spec.test.js holds the two to the spec.
void api.bannerSpec().then((spec) => {
  button.textContent = spec.sweep.label;
  button.title = spec.sweep.tooltip;
  report();
});
