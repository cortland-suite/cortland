# @honeycrisp/remote

The suite's governed MCP servers, reachable beyond the terminal they run in —
with the contract intact. One gateway process serves the mail and context
tools over MCP streamable HTTP on **loopback only**; going further than this
Mac is always an explicit, separate step you take with your own tunnel.

```
honeycrisp-remote token mint --label my-laptop     # shown once, hashed on disk
honeycrisp-remote serve                            # foreground
honeycrisp-remote on | off | status                # launchd lifecycle
```

Mounts appear at `http://127.0.0.1:7811/mcp/mail` and `/mcp/context`
(port configurable via `remote.port` in the suite's `config.json`; a
malformed config refuses to serve rather than guessing).

## Reaching it from your other devices

The gateway binds `127.0.0.1` and offers no way to bind wider. To reach it
from your own devices, share the port over your private network, e.g.:

```
tailscale serve --bg 7811
```

Public exposure (for cloud clients like claude.ai connectors) additionally
needs OAuth and is a separate design (`docs/05`, milestone M2) — a long
random path and a bearer token on a public URL is not that.

## Auth model

- **Bearer tokens, hashes only.** `token mint` shows the secret exactly once;
  this Mac stores its SHA-256 and metadata (`remote-tokens.json`, mode 0600).
  Verification is constant-time. Revocation takes effect on the next request
  — even mid-session.
- **Scopes.** `read` tokens can call only read tools; calls to anything else
  are refused *before* the approval gate and leave an audit row naming the
  token. `--write` tokens meet the same gate as local callers: dry-run unless
  live mode is on, and per-action human approval either way. **A stolen write
  token cannot send mail** — it can only ask, and the ask becomes an approval
  request on channels the token holder doesn't control.
- **Principals in the ledger.** Every audit row from a remote session carries
  `token:<id> session:<id>` — the audit DB answers who asked, not just what
  ran.
- **No browsers.** Requests carrying an Origin header are refused (403),
  which closes DNS-rebinding attacks without a host allowlist to
  misconfigure.

## Client configuration

Any MCP client that speaks streamable HTTP:

```json
{
  "url": "http://127.0.0.1:7811/mcp/mail",
  "headers": { "Authorization": "Bearer hc_…" }
}
```

Over a tailnet, replace the host with the Mac's tailnet name.
