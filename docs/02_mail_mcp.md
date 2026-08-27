# 02 — Mail MCP (first tool on the framework)

**Why Mail first:** highest-value surface (email is where life's decisions arrive),
highest-fear surface (nobody trusts a raw send_email tool) — so it's where governance
visibly matters. Apple Mail already aggregates multiple accounts locally: instant
multi-account access with zero cloud OAuth.

## Tool surface (v1)

| Tool | Mode | Notes |
|------|------|-------|
| `mail_list_accounts` | read | accounts + mailboxes |
| `mail_search` | read | query, account?, mailbox?, date range, from/to; returns headers + snippets |
| `mail_read` | read | full message by id; body returned inside injection fence |
| `mail_thread` | read | conversation view for a message |
| `mail_create_draft` | write-safe | to/cc/subject/body (+ reply-to-message id); lands in Drafts with provenance footer |
| `mail_send` | write-gated | account + to + subject + body; live mode plus per-action approval; body redacted from the audit log |
| `mail_move` / `mail_mark` | write-gated | archive, mark read/flag |

**Send is gated, not absent.** v1 deferred `mail_send` until the framework's
approval queue existed (docs/02, 2026-07-29). The queue shipped (folder channel,
elicitation, dialog). House doctrine: destructive or outward-facing actions
require explicit human confirmation per action. `mail_send` is that tool.

## Implementation notes

- **Actions:** AppleScript/JXA via osascript (create draft, send, move, mark, account/mailbox
  enumeration). Slow but correct; volume is low for actions.
- **Search/read (settled 2026-07-30, from real-mailbox benchmarks):** two tiers.
  AppleScript `whose` header search (subject/sender/date) is sub-second at ~2k
  messages — it is Tier 1, alongside all reads and actions, needing only the
  Automation permission. AppleScript full-text (`content contains`) timed out at
  170s on the same inbox — full-text is Tier 2: **Spotlight via mdfind** over
  ~/Library/Mail, which requires opt-in Full Disk Access. CRITICAL: without FDA,
  Spotlight silently returns zero mail results — the tool must probe FDA
  (readability of ~/Library/Mail) and report "full-text search requires Full Disk
  Access," never an empty result set. Envelope Index stays untouched unless mdfind
  proves insufficient. Re-verify header latency on a 10k+ mailbox and on macOS 27's
  rebuilt Spotlight.
- **Permissions:** first osascript call triggers macOS Automation prompt (this app →
  Mail). Tier 2 full-text additionally needs Full Disk Access, granted by the user
  to the server process. Document both in README; the two-tier story is also the
  least-privilege story.
- **Multi-account:** every tool takes optional `account`; default = all for reads,
  REQUIRED for drafts and send (never guess which identity writes).

## MVP milestone

Search + read + thread + create_draft + gated send on the framework, with audit
rows and fences, against a real multi-account Mail.app. Drafts stay write-safe;
send is live-plus-approval. That replaces copy-paste email relay workflows —
the daily-driver moment.
