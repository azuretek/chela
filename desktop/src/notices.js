// The keyed notice store lives in the shared core now, so desktop and the iOS
// client raise, sort and clear conditions identically from the same source of
// truth (core/spec/notices.json). This is a thin re-export so nothing in desktop
// has to know where it moved.
export {
  create, sentence, ERROR, WARN, INFO, OK,
} from '../../core/notices.js';
