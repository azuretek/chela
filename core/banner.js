// The notice banner's shared facts, for the desktop.
//
// core/spec/banner.json is the one owner of what a banner card draws, what its
// controls say and when the sweep is offered; the iOS app bundles the same file
// (mobile/Chela/BannerSpec.swift). The banner's pages are sandboxed and cannot
// import this, so the main process hands them forPages() over IPC
// ('app:banner-spec'), and the pages draw from what they are given rather than
// from literals of their own. core/test/banner-spec.test.js holds both clients to
// the file.

import spec from './spec/banner.json' with { type: 'json' };

/** The card's controls, in the order both clients draw them. */
export const CONTROLS = Object.freeze([...spec.card.controls]);

/**
 * What a card's X says, or null when the card offers no X.
 *
 * The meaning is the store's (dismiss() in core/notices.js); this is only the
 * label and tooltip that meaning is drawn with, so a card whose X clears does not
 * promise to be read.
 */
export function dismissCopy(notice) {
  if (!notice || notice.dismissible === false) return null;
  return { ...(notice.dismissClears ? spec.dismiss.clears : spec.dismiss.read) };
}

/** Whether the sweep is offered: whenever anything at all is unread. */
export function sweepWanted(unread) {
  return Array.isArray(unread) && unread.length > 0;
}

/** The icon a tone draws, by upstream name, or null for a tone with none. */
export function toneIcon(tone) {
  return spec.toneIcon[tone] ?? null;
}

/** The whole spec as plain data, for a page that cannot import it. */
export function forPages() {
  return JSON.parse(JSON.stringify({
    card: spec.card,
    dismiss: spec.dismiss,
    sweep: spec.sweep,
    toneIcon: spec.toneIcon,
    stroke: spec.stroke,
    icons: spec.icons,
  }));
}
