# Settings backdrop: before and after

Captured by `desktop/scripts/test-settings-backdrop.js` on a hosted macOS 26 runner (arm64, Electron 44.4.1), against a stub Control UI page that paints a red column down its left edge. The runner's own appearance is light, so a page's fallback palette is the light one.

- `macos-before-*-arrival.png`, `macos-after-*-arrival.png`: six frames from the first visible change after Settings is opened, left to right, about 900ms in all. Before, the whole window goes to the light fallback page colour and then to the page colour of the theme: the Control UI is gone. After, the Control UI stays on screen and darkens under the drawer dim.
- `*-settings.png`: Settings at rest. `*-about-over-settings.png`: About opened from Settings, one dim.

On the after dark frames the card itself arrives in the light fallback palette and changes to the theme once it has landed. That is the card's own first paint, not the backdrop, and it is named in the PR as a separate finding.
