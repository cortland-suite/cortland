# honeycrisp-context

The context layer, milestone 1. A local store of **derived metadata and
pointers** over Apple Mail — never copies. See `docs/04_context_layer.md` for
the full design.

## Pointers, not copies

`context.db` (created mode 600) holds headers, a people graph, and Message-ID
pointers. There is no body column in any table — a test enforces this. Content
is fetched live through `honeycrisp-mail` by consumers who hold that permission;
the serve layer itself needs no Mail access at all.

## Usage

```
honeycrisp-context capture   # one incremental sweep (headers only, ~seconds)
honeycrisp-context serve     # MCP server: context_changes, context_person,
                           # context_capture_now
```

- `context_changes` — what's new since a point in time: volume, senders, newly
  seen people, active subjects. Deterministic; every claim cites Message-IDs.
- `context_person` — interaction profile: counts, first/last seen, recent
  message pointers.
- `context_capture_now` — on-demand sweep (write-safe: it writes only the
  local store).

Capture keeps per-mailbox cursors, backfills 90 days on first run, and audits
every sweep (counts only) to the suite's shared audit DB. Schedule it with
launchd (or any timer) for continuous capture; a missed run just widens the
next sweep.

## The briefing pipeline (M2–M4)

`honeycrisp-context brief <dir>` runs the full cycle: ingest corrections from
prior briefing files → extract commitments from recent sent mail (Layer 1) →
answer standing questions → write today's briefing.

- **Standing questions** — `standing-questions.yaml` in the Briefings folder
  (phone-editable). Deterministic candidates always; a configured model writes
  cited answers over fenced header data.
- **Layer 1 is opt-in and declared** — `context.json`:
  `{"model": {"type": "ollama", "model": "..."}}` (local) or
  `{"type": "command", "run": ["...your llm cli..."], "network": true}`.
  `network` defaults to true — egress is assumed unless declared otherwise —
  and every Layer-1 run writes an audit row carrying the declaration. No
  config → deterministic only; nothing is guessed. Model-invented pointers
  are rejected; a failing model degrades to candidates, never a crash.
- **The flywheel** — briefing items carry stable ids; tick a checkbox from any
  device (or add lines under `## Corrections`) and the next run ingests them
  as judgments: muted senders/subjects/items disappear from future briefings
  while the AI-layer rows stay immutable.

## Retention

Derived rows age out on capture: messages, events, and extracted commitments
older than `retentionDays` (default 365) are pruned; set
`{"retentionDays": 0}` in `context.json` to keep everything forever. People
aggregates and human judgments are never pruned at any age — deleting a
human's recorded judgment is not the machine's call. Every prune writes an
audit row with counts.
