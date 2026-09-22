// The app frame inset: the CSS custom properties a host client publishes on the
// Control UI's root, and the rule that clamps the page's viewport-anchored
// overlays to them.
//
// ONE script, TWO clients, the same shape as the App-settings affordance and the
// client-context hook: the script itself lives in spec/app-frame-inset.json so the
// bytes the desktop runs and the bytes the phone runs are one copy rather than
// two that agree by convention. The desktop installs it from its preload at
// document start; the iOS client bundles the spec and installs it through a
// WKUserScript at the same moment. The rule the page receives is built by that
// script from the spec's fields, so neither client holds a copy of it.
//
// The two halves this exists between. A client already OWNS its chrome
// geometrically: the desktop's title strip is a child view and the gateway page
// view is inset below it by layoutViews(), so the page cannot paint over it. What
// the page does not know is where that region is, so its own overlays, which
// anchor to the display edges and size themselves from window.innerHeight, are
// drawn across the band the client's chrome occupies. This publishes the region
// and binds the page's overlays to it.
//
// Consumers: desktop/src/preload.cjs installs installation() into the gateway page
// at document start (the bytes come from main over a synchronous channel, the same
// mechanism the pairing observer uses) and desktop/src/main.js pushes setStatement()
// from the layout pass, so a notice banner appearing moves the frame with it. The
// iOS client reads the same fields through its bundled copy of the spec.
//
// Read the spec's \`why\` for the marker's gating, the 100vh stragglers and the
// removal trigger.

import spec from './spec/app-frame-inset.json' with { type: 'json' };

/** The writable global the page's setter is installed on. */
export const FRAME_INSET_GLOBAL = spec.global;

/** The global a client sets BEFORE the script runs, carrying the spec's own fields. */
export const FRAME_INSET_CONFIG_GLOBAL = spec.configGlobal;

/** The global a client sets BEFORE the script runs, carrying its own numbers. */
export const FRAME_INSET_INITIAL_GLOBAL = spec.initialGlobal;

/** The root attribute that turns the clamp on. Set only while the frame takes space. */
export const FRAME_INSET_MARKER = spec.marker;

/** The four published property names, by edge. The spec is their one owner. */
export const FRAME_INSET_PROPERTIES = spec.properties;

/**
 * The page's viewport-anchored overlays the clamp names, plus the page's own
 * viewport-height container, which the same height cap bounds on its own: an
 * in-flow box ignores the rule's top and bottom, so max-height is what puts the
 * page's shell inside the frame rather than past its bottom edge. Read the
 * spec's why for the shell and the measurement behind it.
 */
export const FRAME_INSET_SELECTORS = spec.clampSelectors;

/**
 * The page's own viewport-height containers, which the frame's height bounds.
 *
 * They are in flow, so the frame is met by the cap alone: they already sit at the
 * frame's leading edge because the client padded the content box they are in, and
 * an offset here would apply that padding a second time.
 */
export const FRAME_INSET_BOUND_SELECTORS = spec.boundSelectors;

/** The four edges, in the order the script publishes them. */
export const FRAME_INSET_EDGES = ['top', 'right', 'bottom', 'left'];

/**
 * The injected script, exactly as the spec holds it. One copy, two engines.
 *
 * The desktop runs these bytes through the preload's document-start injection and
 * the phone through a WKUserScript; neither ports it, because a port is a second
 * copy and a second copy is the fork this file exists to prevent.
 */
export function frameInsetSource() {
  return spec.script.join('\n');
}

/**
 * The spec's own fields, as the statement that hands them to the script.
 *
 * A client passes these through rather than restating them, so the selectors, the
 * property names and the marker have exactly one owner and a change to any of them
 * is one edit in the spec. The Swift client builds this same object from the same
 * file.
 */
export function configStatement() {
  return (
    'window.' + spec.configGlobal + ' = ' +
    JSON.stringify({
      marker: spec.marker,
      properties: spec.properties,
      selectors: spec.clampSelectors,
      boundSelectors: spec.boundSelectors,
      boundCapEdges: spec.boundCapEdges,
    }) + ';'
  );
}

/** One inset, normalised to the four edges the script publishes. */
function normaliseInsets(insets = {}) {
  const out = {};
  for (const edge of FRAME_INSET_EDGES) {
    const value = insets[edge];
    const n = typeof value === 'number' ? value : parseFloat(value);
    out[edge] = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }
  return out;
}

/**
 * The client's half, as one statement: the spec's fields, then the client's
 * numbers, then the script.
 *
 * Numbers rather than spliced text, the same shape as the affordance's config, so
 * the script body has no per-platform part and both engines run identical bytes.
 * Values of zero are written as zero rather than omitted, because a client that
 * takes no band on an edge has to SAY so: an absent property would leave the
 * page's own value in place.
 */
export function installation(insets = {}) {
  return (
    configStatement() + '\n' +
    'window.' + spec.initialGlobal + ' = ' + JSON.stringify(normaliseInsets(insets)) + ';\n' +
    frameInsetSource()
  );
}

/**
 * The statement that moves the published frame while the page is open.
 *
 * A client's chrome changes under it: a notice banner appears and takes a band at
 * the top, and goes away again. Nothing has to be re-installed for that, because
 * the setter is on the global the script left, so this only has to look it up and
 * call it. It answers whether the frame takes any space now, which the caller logs
 * rather than hides: a frame silently zero on a client that meant to take space is
 * a clamp silently off.
 */
export function setStatement(insets = {}) {
  return (
    '(function () {\n' +
    '  try {\n' +
    '    var frame = window.' + FRAME_INSET_GLOBAL + ';\n' +
    '    if (!frame || typeof frame.set !== "function") return null;\n' +
    '    return frame.set(' + JSON.stringify(normaliseInsets(insets)) + ');\n' +
    '  } catch (e) { return null; }\n' +
    '})()'
  );
}

