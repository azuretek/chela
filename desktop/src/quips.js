// The loading-bar line lives in the shared core now, so desktop and the iOS
// client rotate the same list from the same source of truth (core/spec/quips.json).
// This is a thin re-export so nothing in desktop has to know where it moved.
export { QUIPS, ROTATE_MS, quipAt, startAt } from '../../core/quips.js';
