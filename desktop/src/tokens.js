// Our design tokens live in the shared core now, so desktop and the iOS client
// draw the notice card from one set of values (core/spec/tokens.json) rather
// than each keeping their own. This is a thin re-export so nothing in desktop
// has to know where it moved, exactly like src/notices.js.
export {
  MODES, TONES, CARD, TONE,
  values, resolve, toneColours, rootCss, stylesheet,
} from '../../core/tokens.js';
