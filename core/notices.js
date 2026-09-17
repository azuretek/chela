// The banner that slides down from the top and stays until the thing it is
// about is fixed.
//
// It exists for a class of problem the app had no way to report: an ongoing
// condition that is nobody's immediate question. Credentials that cannot be
// stored on this machine, a global shortcut the OS refused, an update that
// failed to download. None of them can be answered with a button, so a dialog
// is the wrong shape, it interrupts, gets dismissed, and the condition is still
// true afterwards with nothing on screen to say so.
//
// So a notice is keyed and idempotent rather than a stream of events. Raising
// the same id twice replaces it instead of stacking, and the raiser clears it
// when the condition passes. That is what makes "stays until it resolves"
// literally true rather than a timeout dressed up as one.
//
// Pure and platform-free: the store is a Map and the decisions are functions,
// so the ordering and the replace-don't-stack rule are testable without a
// window. On desktop, src/main.js owns the one live instance and renders it in
// ui/banner. The tones and their sort rank are data, read from
// spec/notices.json so a Swift port shares the exact same source of truth.

import spec from './spec/notices.json' with { type: 'json' };

/** Severities, worst first. The banner is sorted by these. */
export const ERROR = spec.tones.error;
export const WARN = spec.tones.warn;
export const INFO = spec.tones.info;
// Good news: connected, or an update finished downloading. A separate tone
// rather than INFO because this app's accent colour is red, so an informational
// notice is already indistinguishable from a failure at a glance, and these
// three are the ones where reading "connected" as an alarm is worst.
export const OK = spec.tones.ok;

// Sorted worst first, so a failure sits above a success rather than under it.
const RANK = { ...spec.rank };

/**
 * Whether two actions are the same offer.
 *
 * Part of the identity check rather than ignored, because the offer can change
 * while the message does not, and a banner whose button silently starts doing
 * something else is worse than one that re-renders.
 */
function sameAction(a, b) {
  if (!a || !b) return !a && !b;
  return a.label === b.label && a.command === b.command;
}

export function create() {
  const notices = new Map();
  let seq = 0;

  /**
   * Raise a notice, or update the one already under this id.
   *
   * `action` is the one place a notice offers to do something, and it is a
   * *command name* rather than a callback: the banner is a sandboxed page on
   * the other side of IPC, so anything it can invoke has to be a string main
   * already knows how to run. It is deliberately singular, a notice that needs
   * two buttons is a question, and a question is a dialog.
   *
   * `progress` is a fraction, 0 to 1, or null for a notice that is not about
   * something arriving. It is part of the notice rather than a separate channel
   * to the banner because the bar and the sentence above it describe one
   * condition, and two channels could disagree about which phase it is in.
   *
   * `dismissClears` is the other half of `dismissible`, and it is about what the
   * card's X MEANS rather than whether there is one. Most conditions here are true
   * until something fixes them, so reading one is all a reader can honestly do to
   * it, and the notice stays in the store and under Settings. A download is the
   * exception: "I have seen that it is at 4%" is not a thing anybody means, and the
   * condition the card describes is one the reader can end by saying so. So a
   * dismissClears notice is CLEARED by its own X rather than read, which is what
   * makes `dismiss()` below the right entry point for a surface.
   *
   * @param {string} id  stable per condition, not per occurrence
   * @param {{tone?: string, message: string, detail?: string, dismissible?: boolean,
   *          dismissClears?: boolean, progress?: number|null,
   *          action?: {label: string, command: string}}} notice
   * @returns {boolean} whether anything actually changed
   */
  function set(id, {
    tone = ERROR, message, detail = null, dismissible = true, dismissClears = false,
    action = null, progress = null,
  }) {
    const previous = notices.get(id);
    if (previous && previous.tone === tone && previous.message === message && previous.detail === detail
      && previous.progress === progress
      && sameAction(previous.action, action)) {
      // Identical to what is already on screen. Reporting no change matters:
      // the caller uses it to avoid re-rendering, and a banner that re-renders
      // replays its slide-in animation for no reason.
      return false;
    }
    notices.set(id, {
      id,
      tone,
      message,
      detail,
      dismissible,
      // Part of the notice rather than of the store, because it is a fact about
      // this condition: a card whose X means "stop" says so, and one that does not
      // say so is read.
      dismissClears,
      progress,
      action: action ? { label: action.label, command: action.command } : null,
      // Unread, always, because reaching here means something changed. A
      // condition that has been read and then says something different is new
      // news, and leaving it read would let a failure change under a banner
      // that has already been waved away.
      read: false,
      // Insertion order within a severity, so a new warning appears below an
      // older one rather than shuffling what someone is reading.
      order: previous ? previous.order : seq++,
    });
    return true;
  }

  /**
   * Seen, but still true.
   *
   * Distinct from clear(), and the distinction is the point: clearing says the
   * condition passed, reading says you know about it. A read notice leaves the
   * banner and stays in the store, so the app still knows the shortcut is
   * refused and can still say so where being told twice is not an interruption.
   */
  function markRead(id) {
    const notice = notices.get(id);
    if (!notice || notice.read) return false;
    notice.read = true;
    return true;
  }

  /**
   * Read everything that can be read.
   *
   * A notice that is not dismissible is not markable either. The one that
   * carries it is the finished update download, kept because losing it means
   * waiting for the next check to find a version that is already on disk, and a
   * bulk action is exactly how it would get lost.
   *
   * ★ A dismissClears notice is skipped for the same reason and a sharper one. Its
   * X does not read it, it ends it, and "end every condition on this bar" is not
   * what anybody pressed: a sweep over the banner must never decide the fate of a
   * transfer, which is a decision about network work rather than about reading.
   * The card's own control is one deliberate act and stays the only one.
   */
  function markAllRead() {
    let changed = false;
    for (const notice of notices.values()) {
      if (notice.dismissible === false || notice.dismissClears || notice.read) continue;
      notice.read = true;
      changed = true;
    }
    return changed;
  }

  /**
   * Dismiss the notice under this id, the way its own X means it.
   *
   * The one entry point a surface should call when a card is closed, because the
   * meaning of that act is a property of the condition rather than of the control:
   * a transfer is over when the reader says so, and everything else is seen and
   * still true. A caller choosing between markRead() and clear() by hand is how a
   * card that cannot be dismissed comes back, which is the fault this exists for.
   *
   * @returns {boolean} whether that changed anything
   */
  function dismiss(id) {
    const notice = notices.get(id);
    if (!notice) return false;
    if (notice.dismissClears) return clear(id);
    return markRead(id);
  }

  /** The condition passed. Returns whether there was anything to clear. */
  function clear(id) {
    return notices.delete(id);
  }

  /**
   * The notice under this id, as stored, or null.
   *
   * As *stored*, which is the point: the defaults in set() have been applied,
   * so a caller that omitted a tone reads back the error it actually raised
   * rather than undefined. Anything mirroring a notice elsewhere should read it
   * from here rather than from the argument it passed in.
   */
  function get(id) {
    return notices.get(id) || null;
  }

  /** Every condition that is still true, worst first, then oldest first. */
  function list() {
    return [...notices.values()].sort((a, b) => (RANK[a.tone] - RANK[b.tone]) || (a.order - b.order));
  }

  /**
   * What the banner draws: the conditions nobody has acknowledged yet.
   *
   * The banner is the only surface filtered this way. Everywhere else wants
   * list(), because "is the shortcut still refused" and "have you been told the
   * shortcut is refused" are different questions and only the banner is asking
   * the second one.
   */
  function unread() {
    return list().filter((n) => !n.read);
  }

  function size() {
    return notices.size;
  }

  return { set, get, markRead, markAllRead, dismiss, clear, list, unread, size };
}

/**
 * Make a fragment into a sentence: capital at the front, full stop at the back.
 *
 * Every detail line here is one of our sentences with a string from the OS or a
 * library dropped into it, and those start and end however they start and end.
 * Without the full stop the banner reads "conversion failure from Frobnicate+Zz
 * Change it in Settings."; without the capital, a reason written to be appended
 * to a sentence, "running from source", stands alone looking truncated.
 *
 * Only the first character is touched, so an all-caps error code arrives
 * unharmed.
 */
export function sentence(text) {
  const trimmed = String(text == null ? '' : text).trim();
  if (!trimmed) return '';
  const capitalised = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?:;]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}
