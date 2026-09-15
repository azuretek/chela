// The loading-bar percentage curve lives in the shared core now, so desktop and
// the iOS client ease the bar identically from the same source of truth
// (core/spec/progress.json). This is a thin re-export so nothing in desktop has
// to know where it moved.
export {
  percent, isAhead, ORDER, FLOOR, START, NAVIGATED, DOM, DONE,
} from '../../core/progress.js';
