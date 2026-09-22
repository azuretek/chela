import Foundation
// UIKit for the one thing here that is not a token's VALUE: the trait a page is
// given, which is what its own `prefers-color-scheme` resolves against.
import UIKit

/// The tokens this client takes from a RUNNING Control UI, so the settings and
/// About surfaces wear the interface's own type and palette rather than the
/// fallback ui.css carries for the case where no gateway has answered.
///
/// The list is read from `core/spec/tokens.json` at runtime: `live.tokens` is the
/// same list the desktop reads as `THEME_TOKENS` (core/tokens.js) before inserting
/// the values into the same two pages. One list, two clients, no copy: before it
/// moved into the spec the list was the desktop's alone, and this client applied
/// nothing, which is exactly how its surfaces ended up the only ones wearing the
/// system font and a neutral grey palette while the interface beside them was
/// Instrument Sans on `#0e1015`. `ThemeTokensParityTests` asserts what is read
/// against the repository's copy, so the two cannot drift.
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
    /// `core/spec/tokens.json`'s `live.tokens`, in the spec's order. The kind is
    /// carried because the spec carries it and the parity test asserts it;
    /// nothing here branches on it, as CSSOM needs no grammar to apply a custom
    /// property.
    static var live: [(name: String, kind: String)] {
        spec.live.tokens.compactMap { pair in
            guard pair.count >= 2 else { return nil }
            return (name: pair[0], kind: pair[1])
        }
    }

    /// `core/spec/tokens.json`, read from the app's own copy. Only `live` is decoded
    /// here: `NoticeTokens` reads the rest of the file, and `BundledSpecTests`
    /// accounts for every key across both readers.
    private struct LiveSpec: Decodable {
        struct Live: Decodable {
            let tokens: [[String]]
        }

        let live: Live
    }

    private static let spec: LiveSpec = loadSpec()

    private static func loadSpec() -> LiveSpec {
        let empty = LiveSpec(live: LiveSpec.Live(tokens: []))
        guard let spec = try? BundledSpec.load("tokens", as: LiveSpec.self), !spec.live.tokens.isEmpty else {
            return empty
        }
        return spec
    }

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

    /// The appearance our own pages are given, as a trait.
    ///
    /// The pages have to be TOLD which appearance they are in, because `ui.css`
    /// selects its palette blocks on `prefers-color-scheme`, and that follows the
    /// web view's trait, which follows the DEVICE unless something says otherwise.
    ///
    /// Measured in Chromium, 2026-09-17: `root.style.colorScheme = 'light'` reads
    /// back as `light` from `getComputedStyle` while the media query still matches
    /// dark. So the palette's mode reaching the page under `schemeKey` alone is not
    /// enough, and a page handed a light palette kept every mode-keyed declaration
    /// it owns in the dark block: the colours arrived by name and the appearance
    /// did not.
    ///
    /// So the trait comes from the PALETTE the probe just read, and this client's
    /// own appearance setting is only the fallback for a page that resolved
    /// nothing, where ui.css's own palette is what is on screen and the device is
    /// the only answer available. It never decides over a resolved one, which is
    /// what keeps a page's colours and its appearance from being read off two
    /// different chains.
    static func pageTrait(tokens: [String: String], own: UIUserInterfaceStyle) -> UIUserInterfaceStyle {
        switch pageColorScheme(mode: tokens[schemeKey]) {
        case "light": return .light
        case "dark": return .dark
        default: return own
        }
    }

    /// The one appearance decision, mirrored from `core/appearance.js`
    /// `pageColorScheme`, and proven against the same golden pairs by
    /// `mobile/ChelaTests/AppearanceParityTests.swift`. It answers the abstract
    /// scheme ("light", "dark", or "system") for a page that resolved the given
    /// mode; `pageTrait` above is the iOS adapter that maps that answer onto a
    /// `UIUserInterfaceStyle` ("system" is `.unspecified`, which leaves the
    /// device to drive it), and desktop maps the same answer onto
    /// `nativeTheme.themeSource`. Keeping the decision here as its own function,
    /// rather than folding it into the switch above, is what lets the parity test
    /// run the identical inputs the JS test runs.
    static func pageColorScheme(mode: String?) -> String {
        switch mode {
        case "light": return "light"
        case "dark": return "dark"
        default: return "system"
        }
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
