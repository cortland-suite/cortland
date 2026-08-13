# cortland-mail

Apple Mail over MCP, built on the [governed framework](../governed/). Reads are
free, drafts are write-safe, mutations are gated behind a native macOS approval
dialog — and **there is no send tool at all**.

## The draft-first doctrine

The outward path is `mail_create_draft` → you open Mail.app → you hit send. The
gate that was never built cannot be bypassed: this server is structurally unable
to send email, and a test in `test/doctrine.test.ts` fails if a tool with "send"
in its name ever appears. Worst case is a bad draft, not a bad send.

## Tools

| Tool | Mode | Notes |
|------|------|-------|
| `mail_list_accounts` | read | accounts, addresses, mailboxes |
| `mail_search` | read | header search (subject/sender/date) — fast, index-backed |
| `mail_search_fulltext` | read | body text via Spotlight — requires Full Disk Access (see below) |
| `mail_read` | read | full message by Message-ID; body arrives inside the injection fence |
| `mail_thread` | read | conversation by normalized subject across inbox + sent |
| `mail_create_draft` | write-safe | new draft or reply (`replyToMessageId`); account required; provenance footer; body redacted from the audit log |
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
