'use strict';

// The banner that slides down from the top and stays.
//
// The one thing this page owes the main process is an accurate height. Its view
// is resized to whatever it reports, and a view eats every mouse event inside
// its bounds whatever the page draws there, so reporting too much makes an
// invisible strip that swallows clicks on the Control UI underneath, and
// reporting too little clips the banner.
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

// The one node in the bar that is not a notice. It is rebuilt outright on every
// render rather than kept, which is the opposite of how the cards are handled
// and fine here: there is no slide to replay and nothing to preserve.
const ACTIONS_ID = 'banner-actions';

function card(notice) {
  // Marks it read: the condition carries on, the app just stops saying so. It
  // was a delete until notices could be read, which meant waving away a refused
  // shortcut destroyed the app's own record that it was refused.
  const dismiss = notice.dismissible === false ? null : el('button', {
    className: 'banner__close',
    type: 'button',
    title: 'Mark read. It stays listed under Settings, Problems.',
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
    el('div', { className: 'stack grow' }, [
      el('span', { className: 'banner__message', textContent: notice.message }),
      notice.detail ? el('span', { className: 'banner__detail', textContent: notice.detail }) : null,
      progress,
    ]),
    action,
    dismiss,
  ]);
}

/**
 * Close the bar, meaning read everything on it.
 *
 * One control for the whole stack rather than only per-card, because the thing
 * you want after a bad morning is the bar gone, and doing that a card at a time
 * is a chore that ends with one left over.
 *
 * Nothing here can lose a condition: reading is not clearing, and a notice that
 * refuses to be dismissed refuses this too, so the finished update download
 * survives the sweep.
 */
function actions() {
  return el('div', { className: 'banner-actions', id: ACTIONS_ID }, [
    el('button', {
      className: 'banner__readall',
      type: 'button',
      title: 'Close the bar. Anything still true stays listed under Settings, Problems.',
      textContent: 'Mark all read',
      onclick: () => { void api.markNoticesRead(); },
    }),
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

  // Rebuilt last every time, so it lands on whichever card is last as cards come
  // and go, and absent when the only thing left is a notice it would not act on.
  //
  // It hangs INSIDE that card rather than under the stack, which is a hit-testing
  // fact rather than a layout preference. The bar is drawn in a view sized to the
  // stack, and a view claims every mouse event inside its own rectangle whatever
  // the page draws there, so a row of its own would be a full-width strip that
  // the reader can see the page through and cannot click. That is exactly the
  // strip Abi reported, measured 2026-09-17: a click under the cards was
  // delivered into the banner's own document at a pixel with nothing drawn on it
  // and reached neither the bar nor the page. Inside a card it costs no pixel of
  // its own, because the card it joins is drawn there anyway.
  //
  // The host is the last card that is staying, not the last node in the stack: a
  // card on its way out is still a child while it plays its departure, and the
  // way out of the bar must not disappear with it.
  const previous = document.getElementById(ACTIONS_ID);
  if (previous) previous.remove();
  const staying = [...stack.children].filter((node) => node.id && wanted.has(node.id.slice(2)));
  const host = staying[staying.length - 1];
  if (host && notices.some((n) => n.dismissible !== false)) {
    const row = actions();
    const dismiss = typeof host.querySelector === 'function' ? host.querySelector('.banner__close') : null;
    if (dismiss) host.insertBefore(row, dismiss); else host.append(row);
  }

  report();
}

api.onNoticesChanged(() => { void render(); });
window.addEventListener('resize', report);

void render();
