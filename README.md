# Honeycrisp 🍎

**MCP servers for your Mac's real data — Mail, Calendar, files — with safety
rails you can audit.** Every tool ships governed: dry-run by default, human
approval required for anything that sends, moves, or deletes, an audit log of
every action, and undo where the platform allows it. Local-first: no accounts,
no credentials, no cloud — your data stays on your Mac.

## Why this exists

Most MCP servers for personal data are thin wrappers around AppleScript:
`delete_email`, `send_message`, executed the moment a model calls them. That's
a hard thing to trust with an inbox. Honeycrisp inverts the default — a tool
call *previews* what it would do unless you've opted into live mode, and even
then every consequential action waits for your explicit approval through a
channel the model can't touch. The framework enforcing this is a small library
with a test suite proving each guarantee can't be bypassed, and every tool in
the suite is built on it.

## Install

From npm (recommended):

```
npm install -g @honeycrisp/mail @honeycrisp/context @honeycrisp/setup
honeycrisp setup
```

Or from a clone of this repo:

```
npm install && npm run build
node packages/setup/dist/cli.js setup
```

The setup wizard walks you through everything, one yes/no question at a time
(the default answer is always No — nothing proceeds unless you say so): it
registers the servers with Claude Code / Claude Desktop, triggers the macOS
permission prompts while you're watching (instead of mid-conversation later),
explains the optional Full Disk Access tier for full-text mail search, and can
set up the iCloud `Agents/` folder and capture schedules. Nothing happens
silently; every step it performs is written to the same audit DB the tools use.

## What's in the box

| Package | What it does |
|---|---|
| [`@honeycrisp/governed`](https://www.npmjs.com/package/@honeycrisp/governed) | The framework: dry-run defaults, approval gates, audit trail, provenance, undo, injection fencing. Build your own governed tools on it. |
| [`@honeycrisp/mail`](https://www.npmjs.com/package/@honeycrisp/mail) | Apple Mail over MCP: read, search (two tiers), thread view, drafts. Draft-first by design — **no send tool exists**; marking and moving messages are gated with native undo. |
| [`@honeycrisp/folders`](https://www.npmjs.com/package/@honeycrisp/folders) | Folder-as-API: drop a file into a watched iCloud folder from any device and a declared local pipeline runs; results land beside the drop. |
| [`@honeycrisp/context`](https://www.npmjs.com/package/@honeycrisp/context) | A local context layer: captures mail/calendar *metadata* (pointers, never message bodies), serves briefings and person lookups over MCP, learns from your corrections. |
| [`@honeycrisp/setup`](https://www.npmjs.com/package/@honeycrisp/setup) | The onboarding wizard above. |
| [`@honeycrisp/remote`](https://www.npmjs.com/package/@honeycrisp/remote) | Gateway serving the suite over MCP streamable HTTP — loopback-only, bearer tokens (read/write scopes), audit rows that name who asked. Share the port over your own private network (e.g. Tailscale) to reach it from your other devices. |

## How approvals work

Reads are free. Writes that leave your review loop (send, delete, move) are
gated: with live mode off (the default), they preview instead of executing;
with live mode on, each action individually asks a human through one of:

- **a native macOS dialog** (default — you're at the Mac),
- **a file in an iCloud folder** — the request appears on every device you
  own; move it into `Approve` or `Deny` in the Files app. Works from a stock
  iPhone, no extra apps;
- **an MCP elicitation card** in clients that support it (opt-in).

No decision, a deleted file, or any ambiguity = denied. Every outcome —
executed, denied, dry-run, errored — is a row in a local SQLite audit DB, so
you can always answer "what did my tools actually do?"

## Privacy model

- **No accounts, no credentials, no cloud.** Mail access goes through Mail.app,
  which already has your accounts. iCloud Drive is just a folder; Apple's own
  sync does the transport. Permissions are macOS's own TCC prompts.
- **Pointers, not copies.** The context layer stores headers and metadata that
  reference messages by ID — message bodies are never stored. Delete a message
  in Mail and the context layer's pointer dangles and gets pruned.
- **Content is data, not instructions.** Everything read from your mail or
  files is returned inside a tamper-resistant fence with a standing notice, so
  text inside an email can't steer the model into acting on it.
- **Model use is opt-in and declared.** The context layer works fully
  deterministically with no model configured. If you configure one, its
  network egress is declared in config and recorded in the audit log on every
  run.

## Design docs

The `docs/` directory has one design doc per component, including the framework
contract (`01`), and the remote-access design (`05`) for reaching these servers
from phone/web clients. `NOTES.md` is the running engineering log: decisions
with dates, open questions, and field-test findings.

## License

MIT. See [LICENSE](LICENSE).
