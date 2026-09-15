# Widget sandbox origin

Hosted widget previews (the `show_widget` / canvas surface in the Control UI)
render inside a sandboxed iframe. For browser isolation that iframe must load
from an origin **different** from the Control UI, and it must not serve
authenticated content. The gateway provides this on a dedicated HTTPS listener,
by default on the gateway port **plus one**.

For a gateway on `18789`, the sandbox listener is `https://127.0.0.1:18790`
(self-signed). If a widget preview fails with **"Widget sandbox host is
unavailable"**, the client cannot reach that sandbox origin.

## Why it fails over a tunnel

Claw Desktop reaches the gateway over Tailscale, which by default exposes only
the main gateway port through its `:443` serve. The sandbox port is not routed,
and the raw tailnet IP to `18790` is usually firewalled. So the iframe has no
reachable origin. This is the `mcp.apps.sandboxOrigin` case the gateway's own
config hint describes.

## The fix on this machine (example-host)

Two pieces, both required:

**1. Route the sandbox port over Tailscale** as a second HTTPS origin. Same
hostname, different port, is a distinct origin and satisfies the isolation
requirement:

```sh
tailscale serve --bg --https=8443 https+insecure://127.0.0.1:18790
```

- `--bg` makes it a persistent background handler, so it survives a gateway
  restart and does not disturb the gateway's own foreground `:443` serve.
- `https+insecure://` is required because the sandbox listener uses a
  self-signed cert.
- Verify: `curl -sk https://<host>:8443/` returns HTTP 404 (the listener's
  root), and the main `:443` still returns 200.

**2. Point the gateway at that origin:**

```sh
openclaw config set mcp.apps.sandboxOrigin "https://<host>:8443"
```

This is a hot-applied field (no restart). Confirm it went live in the running
gateway, not just on disk.

## Dependencies to keep in mind

- The `:8443` serve is **separate** from the gateway config. If the Tailscale
  serve config is rebuilt, or the gateway moves host or port, this handler and
  the `sandboxOrigin` value both need re-pointing.
- The routing is **tailnet-only**. It works for devices on the tailnet and does
  not expose widgets publicly, which is correct: the sandbox must never serve
  authenticated content.
- If the sandbox port default changes (`mcp.apps.sandboxPort`), the serve
  upstream target must change with it.
