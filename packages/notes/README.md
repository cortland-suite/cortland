# honeycrisp-notes

Apple Notes over MCP, built on the [governed framework](../governed/). Reads are
free (and fenced), creating a note is write-safe, appending to one is gated
behind a native macOS approval dialog with the undo captured first.

## Tools

| Tool | Mode | Notes |
|------|------|-------|
| `notes_folders` | read | folder names with note counts |
| `notes_search` | read | case-insensitive name match, optional folder; plain-text snippet of each body |
| `note_read` | read | full note by id; HTML stripped to readable text; name, folder, dates |
| `note_create` | write-safe | new note in the default folder unless named; provenance footer; body redacted from the audit log |
| `note_append` | write-gated | append text to a note by id; native undo — the full prior body is snapshotted **before** the write |

Everything inherits the framework contract: dry-run by default for gated tools,
per-action human approval out-of-band from the model, an audit row for every
execution path, injection fencing on note content, provenance on anything
created.

## Notes

- Note bodies are HTML inside Notes.app. Read paths strip markup down to text
  in the JXA itself, so raw markup never reaches the model; the undo snapshot
  keeps the raw HTML on purpose, because a restore must be byte-exact.
- Note content is data, never instructions — everything a read tool returns
  arrives inside the injection fence.
- Password-protected notes are opaque to scripting; touching one fails loudly
  rather than pretending it worked.
- The first call after a cold Notes.app launch can be slow while the
  Automation prompt is pending; subsequent calls are fast.
