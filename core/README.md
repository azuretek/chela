# Claw Core

The platform-agnostic rules every Claw client shares. No Electron, no SwiftUI,
no disk, no clock: pure functions and the data they read, so the desktop app and
the iOS app behave identically where it counts and cannot drift apart.

## What lives here

| Module | What it owns |
|---|---|
| `quips.js` | The rotating line under the loading bar, and the rule that none of them reads as a real status. |
| `progress.js` | The loading-bar percentage: milestone floors eased by time, never claiming a stage the load has not reached. |
| `connection.js` | The connection state machine: phases, error-code to sentence mapping, certificate state, what the banner says. |
| `notices.js` | The keyed-by-condition notice store: raise, replace, read, clear, sorted worst-first. |
| `config-model.js` | The gateway config shape and the pure CRUD over its gateway list (no persistence, that is each client's disk). |
| `gateway-url.js` | The token handoff: build the Control UI URL with the token on the `#token=` fragment. |
| `updates.js` | What this build may do about a new version: the action, whether to check, whether to download, and why. Takes `platform`, `packaged`, `macSigned` and `appImage` as arguments, so a stray environment variable cannot change the answer. |
| `prompt-metadata.js` | The client-context block every client puts on every outgoing prompt: the marker, the header, the field order, the value rules, and the script each client installs to put it on a `chat.send` frame. Platform-free, so only the gathered facts differ. |
| `ui/` | The web surface our own chrome is drawn from: the settings page, which every client renders, and the desktop's other pages. One copy, loaded by both clients, with one stylesheet and one set of design tokens. See below. |

## The shared web surface

`ui/` holds the pages our own chrome is made of, and it is here rather than beside
the desktop's source for two reasons, both load-bearing:

- **The settings surface is shared.** `ui/settings.html` with `ui/settings.js` and
  `ui/ui.css` is rendered by the desktop AND by the iOS app, out of its bundle. It is
  one page, not one per client, because both clients are web views and a native
  screen per client would be a second implementation of every tab.
- **A page in `desktop/src` cannot address a stylesheet here.** Packing flattens
  `desktop/` into the archive's root, so the same page sits one directory deeper in a
  checkout than in a build, and no single relative href is correct in both. Everything
  in one directory is the only arrangement where it is. `desktop/test/dialogs.test.js`
  asserts that every href in every page resolves.

What differs between the clients is which tabs and which settings apply, and that is
NOT in the page: it is data in `spec/settings.json`, handed to the page at runtime by
whichever host is running it (`window.clawSettings`). The page filters by it, hides
what its client does not have, and never asks which client it is. That last part is a
test, not a convention: see `desktop/test/settings-surface.test.js`.

## One source of truth

The data each module needs lives in `spec/*.json`, and the JS reads from it:

- `spec/quips.json`: the quips array and the rotation interval.
- `spec/progress.json`: the milestone order, floors, the easing time constant and creep.
- `spec/connection.json`: the phase names, `ERR_ABORTED`, and the error-code hints.
- `spec/notices.json`: the tones and their sort rank.
- `spec/updates.json`: the four action names and the two check intervals.
- `spec/prompt-metadata.json`: the marker, the per-client headers, the block's field order, the value rules, and the injected script itself.
- `spec/settings.json`: the settings surface's split by client: which tabs and which settings apply to each, the reason any of them is absent on a client, and the command vocabulary a client's host implements. Not a mirror: both clients hand this file to the one shared page at runtime.

A Swift port reads the same JSON, so the data cannot say one thing on desktop
and another on the phone. Change a quip or a milestone floor once, in the spec,
and both clients move together.

The one spec that is not mirrored is `prompt-metadata.json`, because it holds a
script rather than a value: the phone bundles that file and reads the script out
of it, so the two clients run one copy of one script instead of two dialects that
agree until somebody edits one. See `mobile/README.md`.

## Parity is proven, not asserted

`fixtures/` holds golden input/output pairs for the behavioural logic that a
port is most likely to get subtly wrong:

- `fixtures/progress.json`: `percent()` across every milestone and a spread of
  elapsed times, including the failed-load freeze.
- `fixtures/connection.json`: `reason()` and `status()` across every error code
  and phase.
- `fixtures/updates.json`: `policy()` across every platform's install
  capability, including the automatic-updates preference that may only ever
  narrow it.
- `fixtures/prompt-metadata.json`: `clean()`, `formatBlock()`, `shouldInject()`,
  `inject()`, `transformFrame()` and `clientIdentity()` across the block's value
  rules, the two reasons not to inject at all, and a phone block that has fewer
  fields than a desktop one. The injected script is deliberately not repeated
  here: its one owner is `spec/prompt-metadata.json`, and the fixture names that
owner and the shape of it.

`test/*.test.js` asserts the JS reproduces every fixture exactly. The iOS
client's Swift tests reproduce the same fixtures, which is what turns "these
should match" into "these do match".

## Using it from a client

Desktop imports the modules by relative path, for example:

```js
import { percent } from '../../core/progress.js';
import { withTokenHandoff } from '../../core/gateway-url.js';
```

No build step and no package install: `core/` is plain ESM that Node and
Electron load directly, and electron-builder packages it alongside `desktop/src`
(see the `files` mapping in `desktop/electron-builder.yml`). The iOS client does
not import the JS at all; it mirrors the rules in Swift and proves them against
`fixtures/`.

## Tests

```
cd core && npm test
```

Runs the fixture parity tests with `node --test`. No dependencies.
