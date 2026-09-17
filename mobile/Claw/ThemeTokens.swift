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
        // Surfaces. --bg-elevated and --card are the two the borrowed settings
        // components draw on (their group surface IS --card, where ours used to be
        // --panel, which the live theme could reach and this one could not), so a
        // palette that publishes them -- every shipped one does -- must be able to
        // hand them over rather than leaving the surface on the default palette.
        ("--bg", "color"), ("--bg-accent", "color"), ("--bg-hover", "color"),
        ("--bg-muted", "color"), ("--bg-content", "color"), ("--bg-elevated", "color"),
        ("--panel", "color"), ("--panel-hover", "color"), ("--panel-strong", "color"),
        ("--card", "color"),
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

    /// The one thing the token layer carries that is NOT a token: the resolved
    /// appearance the palette belongs to.
    ///
    /// The Control UI resolves its own mode and publishes the answer on its own
    /// root, in `ui/src/app/bootstrap-theme.ts`:
    ///
    ///     root.dataset.themeMode = resolvedTheme.endsWith("light") ? "light" : "dark"
    ///     root.style.colorScheme = root.dataset.themeMode
    ///
    /// It has to, because the palette and the BROWSER's idea of light or dark are
    /// two different things: `color-scheme` is what the platform draws its own
    /// chrome from (`<select>` menus, checkboxes, scrollbars, the caret), and a
    /// page can paint a dark palette while the platform draws light native
    /// controls over it.
    ///
    /// Our own pages resolved it from `prefers-color-scheme`, which follows the
    /// web view's trait. On the desktop that is deliberate and always correct:
    /// `nativeTheme.themeSource` is set from the page's theme (`applyTheme` in
    /// desktop/src/chrome.js), so the trait and the palette cannot disagree. On
    /// this client nothing makes them agree: the trait is the APP's appearance
    /// (`AppearanceMode`), while the palette we inject is the CONTROL UI's theme,
    /// so in one of the two combinations the page painted one mode and the
    /// platform drew the other. That is the residual half of the report that
    /// started this: the settings and About surfaces taking the palette but not
    /// the appearance it belongs to.
    ///
    /// Carried under a `--` name so it goes through the same guard as every token
    /// and needs no second channel, and read back as a real property by
    /// `applyScript` rather than set as a custom one that nothing would read.
    static let schemeKey = "--color-scheme"

    /// Read the live values out of the Control UI page, as a JSON object.
    ///
    /// Only the names above are read, and a name the page does not publish is
    /// simply absent: the Control UI is free to stop declaring one, and the
    /// honest answer then is our own fallback rather than an empty override.
    ///
    /// The resolved appearance rides along under `schemeKey`, and it is read from
    /// the ATTRIBUTE the Control UI sets for itself before its stylesheets load
    /// (`data-theme-mode`), falling back to the computed `color-scheme`. Read this
    /// way round rather than from `prefers-color-scheme`, because the question is
    /// which appearance the PALETTE is in, not which one this device is in. A
    /// `color-scheme` that is not a single answer -- a browser with nothing pinned
    /// answers the two-word `light dark` -- is left out, so an ambiguous page
    /// leaves the page's own resolution alone rather than pinning it to a guess.
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
            var mode = root.getAttribute('data-theme-mode') || (root.style && root.style.colorScheme) || computed.colorScheme || '';
            mode = String(mode).trim().toLowerCase();
            if (mode === 'light' || mode === 'dark') { out['\(schemeKey)'] = mode; }
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
    /// `schemeKey` is the one entry that is not a custom property: it is written
    /// as `colorScheme`, which is the real property the platform reads. Set as a
    /// custom property it would sit in the page being read by nobody, which is the
    /// quiet shape of failure this area keeps producing.
    ///
    /// Applied at DOMContentLoaded as well as immediately: at document start the
    /// root may not exist yet, and a token layer that silently skipped that case
    /// would leave the page on its fallback palette while looking like it had run.
    static func applyScript(_ tokens: [String: String]) -> String {
        let json = (try? String(data: JSONSerialization.data(withJSONObject: tokens), encoding: .utf8)) ?? "{}"
        return """
        (function () {
          var tokens = \(json);
          var schemeKey = '\(schemeKey)';
          function apply() {
            try {
              var root = document.documentElement;
              if (!root || !root.style) { return false; }
              for (var name in tokens) {
                if (!Object.prototype.hasOwnProperty.call(tokens, name)) { continue; }
                if (name.indexOf('--') !== 0) { continue; }
                var value = String(tokens[name]);
                if (name === schemeKey) {
                  if (value !== 'light' && value !== 'dark') { continue; }
                  root.style.colorScheme = value;
                  continue;
                }
                root.style.setProperty(name, value);
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
