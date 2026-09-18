'use strict';

// The banner that slides down from the top and stays.
//
// The one thing this page owes the main process is an accurate height. Its view
// is resized to whatever it reports, and a view eats every mouse event inside
// its bounds whatever the page draws there, so reporting too much makes an
// invisible strip that swallows clicks on the Control UI underneath, and
// reporting too little clips the banner.
//
// ★ The page draws NOTICES AND NOTHING ELSE, and the sweep (Mark all read) is
// deliberately not here. Anything on this page shares the bar's rectangle, so a
// control on a line of its own would make the rest of that line a dead zone over
// the Control UI. The sweep is its own view, sized to the button, in
// core/ui/sweep.html; see refreshSweep in src/main.js for why.
//
// The height is measured from layout rather than after the animation, because
// the slide is a `transform` and a transform does not change layout height. So
// the number is correct on the first frame, and the view never resizes
// mid-animation.

const api = window.clawDesktop;
const stack = document.getElementById('stack');

// Deliberately no `frameless` class. The banner's view is already positioned
// below the title strip by main, so it has nothing to clear, and the rule that
// class used to carry was written for the error page, which no longer exists.

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function report() {
  // Synchronous on purpose. `getBoundingClientRect` forces layout, so the
  // number is right immediately -- and waiting for a frame would deadlock: the
  // view starts at a provisional height, requestAnimationFrame does not fire
  // for content that has not painted, and the height that would make it paint
  // is the one being reported.
  const height = stack.childElementCount ? stack.getBoundingClientRect().height : 0;
  void api.bannerHeight(height);
}

function card(notice) {
  // Marks it read: the condition carries on, the app just stops saying so. It
  // was a delete until notices could be read, which meant waving away a refused
  // shortcut destroyed the app's own record that it was refused.
  //
  // ★ Except for a card whose dismissal MEANS something, which is what
  // `dismissClears` says. The one that carries it is a download in flight, and a
  // tooltip promising the card stays listed would be wrong twice: the reader is
  // asking for the transfer to stop being reported rather than saying they have
  // seen it, and the store clears it rather than reading it. Same control, honest
  // label, and the meaning itself still lives in one place (the store) rather than
  // being decided here from what the card happens to look like.
  const dismiss = notice.dismissible === false ? null : el('button', {
    className: 'banner__close',
    type: 'button',
    title: notice.dismissClears
      ? 'Clear this. It stops reporting the download, and it does not come back.'
      : 'Mark read. It stays listed under Settings, Problems.',
    textContent: '✕',
    onclick: () => { void api.dismissNotice(notice.id); },
  });

  // A link rather than a button, and the only one: this is where a notice says
  // "the thing that fixes me is over there". It navigates; it does not act, so
  // the notice stays up until the condition it describes actually passes.
  const action = notice.action ? el('button', {
    className: 'banner__action',
    type: 'button',
    textContent: notice.action.label,
    onclick: () => { void api.noticeAction(notice.action.command); },
  }) : null;

  // How far a download has got. A native `<progress>` rather than a div with an
  // inline width, because this page runs under `style-src 'self'`: a style
  // attribute written through the DOM is refused, and the bar would sit at zero
  // forever while looking exactly like a download that had stalled.
  const percent = typeof notice.progress === 'number' ? Math.round(notice.progress * 100) : null;
  const progress = percent === null ? null : el('div', { className: 'banner__progress' }, [
    el('progress', { className: 'banner__bar', max: 100, value: percent }),
    el('span', { className: 'banner__percent', textContent: `${percent}%` }),
  ]);

  return el('div', { className: `banner banner--${notice.tone}`, id: `n-${notice.id}` }, [
    // The body is a COLUMN of blocks, and this page declares that shape itself in
    // banner.css as `.banner__body`. It carried `stack grow` until 2026-09-18,
    // when `.stack` turned out to be a rule the settings refactor had retired:
    // the body fell back to a plain block and its three spans laid out as one
    // paragraph. See the rule for what the reader saw.
    el('div', { className: 'banner__body grow' }, [
      el('span', { className: 'banner__message', textContent: notice.message }),
      notice.detail ? el('span', { className: 'banner__detail', textContent: notice.detail }) : null,
      progress,
    ]),
    action,
    dismiss,
  ]);
}

/**
 * Take a card off the bar, playing its departure.
 *
 * The slide belongs to a card leaving the same way it belongs to one arriving, and
 * the direction is the one it came from: it arrives from above the viewport and
 * leaves back through it.
 *
 * The removal has to wait for the animation, because a node taken out of the tree
 * on the same tick as the dismissal never paints a frame of its own departure. That
 * is the same shape as the arrival problem the `.banner--enter` comment records,
 * and it is why this is a class plus a deferred removal rather than a `remove()`.
 *
 * Reduced motion takes it off at once, which is the same sequence without the
 * movement. The preference and the duration are read through `clawSurface`, the one
 * page-side owner of both, rather than asked again here.
 */
function leaveCard(node) {
  const surface = window.clawSurface;
  if (!surface || surface.reducedMotion()) { node.remove(); return; }
  node.classList.remove('banner--enter');
  node.classList.add('banner--leave');
  // The animation's own end is the ideal moment, and the clock is the guarantee:
  // a card whose animation never runs (a stylesheet that did not load, a
  // backgrounded view whose animations are throttled) must not sit on the bar
  // forever as a notice the reader already dismissed.
  node.addEventListener('animationend', () => node.remove(), { once: true });
  setTimeout(() => node.remove(), surface.durationMs('--duration-fast') + 120);
}

/**
 * Sweep the cards that are gone, and rebuild the ones that changed.
 */
async function render() {
  const notices = await api.notices();
  // Rebuild only what changed, keyed by id. Replacing the whole list every time
  // would replay the slide-in on a banner that has been sitting there for an
  // hour, every time an unrelated one appears.
  const wanted = new Map(notices.map((n) => [n.id, n]));

  for (const node of [...stack.children]) {
    if (node.id && !wanted.has(node.id.slice(2))) leaveCard(node);
  }
  for (const notice of notices) {
    const existing = document.getElementById(`n-${notice.id}`);
    const next = card(notice);
    if (existing) {
      existing.replaceWith(next);
    } else {
      // The slide belongs to a card arriving, not to a card changing. A card is
      // rebuilt whenever its text, its offer or its progress moves, and
      // animating every one of those replayed the slide on each download
      // percent, which reads as the banner flickering rather than as something
      // arriving.
      next.classList.add('banner--enter');
      stack.append(next);
    }
  }

  // The height is the CARDS' height and only that: the sweep is a view of its
  // own below the bar (core/ui/sweep.html), so nothing here adds a strip the bar
  // has to cover.
  report();
}

api.onNoticesChanged(() => { void render(); });
window.addEventListener('resize', report);

void render();
