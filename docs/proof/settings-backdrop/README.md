# Settings backdrop: before and after

Desktop captures are from `desktop/scripts/test-settings-backdrop.js` on a hosted macOS 26 runner (arm64, Electron 44.4.1), against a stub Control UI page that paints a red column down its left edge. The runner's own appearance is light, so a page's fallback palette is the light one.

- `macos-before-*-arrival.png`, `macos-after-*-arrival.png`: six frames from just before the first visible change after Settings is opened, left to right. Before, the whole window goes to the light fallback page colour and then to the theme's page colour: the Control UI is gone. After, the Control UI stays on screen and darkens under the drawer dim.
- `macos-*-settings.png`: Settings at rest. `macos-*-about-over-settings.png`: About opened from Settings; after, one dim.
- `ios-*`: the phone on an iOS 27 simulator, Settings and About at rest, before and after, which are the same by design: the native sheet dims what is behind it and the page inside it keeps its own background. `ios-after-settings-launch-strip.png` is the launch with Settings opened, sampled at 6 frames a second. The stub page is not a gateway the phone connects to, so what is behind its sheet is the app's unconnected state rather than a Control UI.

On the after dark frames the card itself arrives in the light fallback palette and changes to the theme once it has landed. That is the card's own first paint, not the backdrop, and it is named in the PR as a separate finding.
