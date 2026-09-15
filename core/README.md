# Claw Core

The platform-agnostic rules every Claw client shares. No Electron, no SwiftUI,
no disk, no clock: pure functions and the data they read, so the desktop app and
the future iOS app behave identically where it counts and cannot drift apart.

## What lives here

| Module | What it owns |
|---|---|
| `quips.js` | The rotating line under the loading bar, and the rule that none of them reads as a real status. |
| `progress.js` | The loading-bar percentage: milestone floors eased by time, never claiming a stage the load has not reached. |
| `connection.js` | The connection state machine: phases, error-code to sentence mapping, certificate state, what the banner says. |
| `notices.js` | The keyed-by-condition notice store: raise, replace, read, clear, sorted worst-first. |
| `config-model.js` | The gateway config shape and the pure CRUD over its gateway list (no persistence, that is each client's disk). |
| `gateway-url.js` | The token handoff: build the Control UI URL with the token on the `#token=` fragment. |

## One source of truth

The data each module needs lives in `spec/*.json`, and the JS reads from it:

- `spec/quips.json`: the quips array and the rotation interval.
- `spec/progress.json`: the milestone order, floors, the easing time constant and creep.
- `spec/connection.json`: the phase names, `ERR_ABORTED`, and the error-code hints.
- `spec/notices.json`: the tones and their sort rank.

A Swift port reads the same JSON, so the data cannot say one thing on desktop
and another on the phone. Change a quip or a milestone floor once, in the spec,
and both clients move together.

## Parity is proven, not asserted

`fixtures/` holds golden input/output pairs for the behavioural logic that a
port is most likely to get subtly wrong:

- `fixtures/progress.json`: `percent()` across every milestone and a spread of
  elapsed times, including the failed-load freeze.
- `fixtures/connection.json`: `reason()` and `status()` across every error code
  and phase.

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
