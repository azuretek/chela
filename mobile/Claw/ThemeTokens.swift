import Foundation

/// The tokens this client takes from a RUNNING Control UI, so the settings and
/// About surfaces wear the interface's own type and palette rather than the
/// fallback ui.css carries for the case where no gateway has answered.
///
/// The list is a mirror of `core/spec/tokens.json`'s `live` array, which is also
/// what the desktop reads as `THEME_TOKENS` (core/tokens.js) before inserting the
/// values into the same two pages. One list, two clients: before it moved into the
/// spec the list was the desktop's alone, and this client applied nothing, which
/// is exactly how its surfaces ended up the only ones wearing the system font and
/// a neutral grey palette while the interface beside them was Instrument Sans on
/// `#0e1015`. `ThemeTokensParityTests` asserts every name and kind below against
/// the spec, so the mirror cannot drift.
///
/// A value is read from the page and applied to our own page through CSSOM, with
/// no stylesheet text built in Swift. That is deliberate: a custom property set
/// with `setProperty` cannot escape its own declaration, so the desktop's need to
/// sanitize every value into a rule it concatenates does not arise here. The
/// reading side is the desktop's too, in shape: `getComputedStyle` on the root,
/// which is what flattens a palette authored in `color-mix()` or `oklch()` into
/// something both clients can carry.
enum ThemeTokens {
    /// `[name, kind]` in the spec's order. The kind is carried because the spec
    /// carries it and the parity test asserts it; nothing here branches on it,
    /// as CSSOM needs no grammar to apply a custom property.
    static let live: [(name: String, kind: String)] = [
        // Surfaces
        ("--bg", "color"), ("--bg-accent", "color"), ("--bg-hover", "color"),
        ("--bg-muted", "color"), ("--bg-content", "color"),
        ("--panel", "color"), ("--panel-hover", "color"), ("--panel-strong", "color"),
        ("--input", "color"), ("--chrome", "color"),
        // Text
        ("--text", "color"), ("--text-strong", "color"),
        ("--muted", "color"), ("--muted-strong", "color"),
        // Lines
        ("--border", "color"), ("--border-strong", "color"), ("--border-hover", "color"),
        // Accent
        ("--accent", "color"), ("--accent-hover", "color"), ("--accent-subtle", "color"),
        ("--primary", "color"), ("--primary-hover", "color"), ("--primary-foreground", "color"),
        ("--destructive", "color"), ("--ring", "color"),
        // Shape
        ("--radius", "length"), ("--radius-sm", "length"), ("--radius-md", "length"),
        ("--radius-lg", "length"), ("--radius-full", "length"),
        // Scrollbars, the reason our scrollbars can match rather than resemble.
        ("--scrollbar-size", "length"), ("--scrollbar-thumb-inset", "length"),
        ("--scrollbar-thumb", "color"), ("--scrollbar-thumb-hover", "color"),
        // Type and depth
        ("--font-body", "font"), ("--shadow-lg", "shadow"),
    ]

    static var names: [String] { live.map(\.name) }

    /// Read the live values out of the Control UI page, as a JSON object.
    ///
    /// Only the names above are read, and a name the page does not publish is
    /// simply absent: the Control UI is free to stop declaring one, and the
    /// honest answer then is our own fallback rather than an empty override.
    static var probeScript: String {
        let names = (try? String(data: JSONSerialization.data(withJSONObject: names), encoding: .utf8)) ?? "[]"
        return """
        (function () {
          try {
            var root = document.documentElement;
            if (!root) { return '{}'; }
            var computed = getComputedStyle(root);
            var out = {};
            var names = \(names);
            for (var i = 0; i < names.length; i += 1) {
              var value = computed.getPropertyValue(names[i]);
              if (value && value.trim()) { out[names[i]] = value.trim(); }
            }
            return JSON.stringify(out);
          } catch (e) { return '{}'; }
        })()
        """
    }

    /// Apply a token map to one of our pages.
    ///
    /// Every write is guarded by the `--` prefix, so a map that arrived with
    /// something else in it cannot reach the page, and the whole thing is wrapped
    /// because this runs in a document we would rather leave unstyled than break.
    ///
    /// Applied at DOMContentLoaded as well as immediately: at document start the
    /// root may not exist yet, and a token layer that silently skipped that case
    /// would leave the page on its fallback palette while looking like it had run.
    static func applyScript(_ tokens: [String: String]) -> String {
        let json = (try? String(data: JSONSerialization.data(withJSONObject: tokens), encoding: .utf8)) ?? "{}"
        return """
        (function () {
          var tokens = \(json);
          function apply() {
            try {
              var root = document.documentElement;
              if (!root || !root.style) { return false; }
              for (var name in tokens) {
                if (!Object.prototype.hasOwnProperty.call(tokens, name)) { continue; }
                if (name.indexOf('--') !== 0) { continue; }
                root.style.setProperty(name, String(tokens[name]));
              }
              return true;
            } catch (e) { return false; }
          }
          window.__clawApplyLiveTokens = apply;
          if (!apply()) { document.addEventListener('DOMContentLoaded', apply); }
        })()
        """
    }
}
