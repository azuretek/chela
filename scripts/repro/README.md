# Reproduction harnesses

Scripts that recreate a fault we have hit, so it can be shown failing before a fix and passing after it. Each one is live and opt-in: it talks to a real gateway, costs real agent turns, and reads its credential from the environment without printing it.

| Script | What it reproduces | Runs with |
|---|---|---|
| `scripts/repro/control-ui-queued-send.mjs` | A message typed while a reply is running is marked "waiting for reconnect" on a live socket, in the stock Control UI in a plain browser (no Chela code). `--ui-dist` swaps in a locally built Control UI, in that browser only. | node, from an OpenClaw checkout (for playwright-core) |
| `scripts/repro/gateway-record.mjs` | Reads the gateway's own record of a queued-send session and checks each message arrived exactly once. | node, where the openclaw CLI reaches the gateway |
| `scripts/repro/approve-test-devices.mjs` | Approves pairing requests from one test address for a bounded time and logs them; `--remove` revokes every device it logged. | node, where the openclaw CLI reaches the gateway |
| `desktop/scripts/test-queued-send.js` | The queued-send fault inside the desktop app. | npx electron |
| `desktop/scripts/test-pairing-recovery.js` | A new device recovering from the pairing screen once approved, with the page's network throttled, and nothing reloading afterwards. | npx electron |
| `desktop/scripts/test-wake-reconnect.js` | Send, sleep, wake, send, with the power events emitted on Electron's own powerMonitor. | npx electron |
| `mobile/ChelaUITests/QueuedSendUITests.swift` | The queued-send fault on the phone. Skipped unless the gateway and token are provided. | xcodebuild test |
| `mobile/ChelaUITests/WakeReconnectUITests.swift` | Background, foreground, send on the phone. Skipped unless the gateway and token are provided. | xcodebuild test |

Every run uses a fresh profile, which is a new device, so run the approver alongside it and remove the devices it logged afterwards. Only the app under test may be affected: the harnesses throttle or take offline the app's own session, never the host's network.
