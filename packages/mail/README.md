# cortland-mail

Apple Mail over MCP, built on the [governed framework](../governed/). Reads are
free, drafts are write-safe, send and other mutations are gated behind a native
macOS approval (or the folder / elicitation channel) — **send is write-gated,
not absent**.

## The send doctrine

`mail_create_draft` is write-safe (a draft stays in your review loop).
`mail_send` is write-gated: live mode plus per-action human approval. Account
and recipient are required; the body is redacted from the audit log. Undo is
compensate (you cannot unsend; a follow-up is the correction).

v1 deferred send until the approval queue existed. It does now (folder channel,
elicitation, dialog). House doctrine in the project CLAUDE.md was always
"send gated."

## Tools

| Tool | Mode | Notes |
|------|------|-------|
| `mail_list_accounts` | read | accounts, addresses, mailboxes |
| `mail_search` | read | header search (subject/sender/date) — fast, index-backed |
| `mail_search_fulltext` | read | body text via Spotlight — requires Full Disk Access (see below) |
| `mail_read` | read | full message by Message-ID; body arrives inside the injection fence |
| `mail_thread` | read | conversation by normalized subject across inbox + sent |
| `mail_create_draft` | write-safe | new draft or reply (`replyToMessageId`); account required; provenance footer; body redacted from the audit log |
| `mail_send` | write-gated | new outgoing message; account + to + subject required; provenance footer; body redacted; live + per-action approval |
| `mail_mark` | write-gated | read/flagged status; native undo (previous state captured before the write) |
| `mail_move` | write-gated | move between mailboxes; native undo (source mailbox captured first) |

Everything inherits the framework contract: dry-run by default for gated tools,
per-action human approval out-of-band from the model, an audit row for every
execution path, injection fencing on message content, provenance on drafts.

## Permissions (two tiers, least privilege)

1. **Automation** (prompted on first use): everything except full-text search.
2. **Full Disk Access** (optional, opt-in via System Settings): unlocks
   `mail_search_fulltext`. Without it the tool refuses with instructions —
   deliberately, because Spotlight silently returns zero mail results for
   processes without this permission, and a silent empty is worse than an
   honest refusal.

## Notes

- `account` is required for drafts — the writing identity is never guessed.
- Some iCloud accounts expose no email addresses to scripting; drafting from
  one fails with instructions rather than producing a sender-less draft.
- The first call after a cold Mail.app launch can be slow; subsequent calls are
  ~1s. Timeouts say so instead of failing cryptically.
