# 04 — The Context Layer (designed 2026-07-30)

**Thesis:** every AI tool fails the same way for busy people — the user must pay the
context tax at the moment of use, so the tool feels like extra work and gets abandoned.
Real quote from a senior analytics director describing why his self-built AI briefing
died: *"If I'm spending all this time giving it context, that feels like wasted time."*
The fix is architectural: **context is infrastructure.** Capture and curation are paid
by software, continuously; every AI session starts already-briefed.

## The prime directive: pointers, not copies

The context store holds **derived metadata and pointers into the sources — never
copies of message bodies.** People, threads, commitments, and timelines reference
Mail by messageId and Calendar by event id; when a consumer needs actual text, it is
fetched live through the governed Mail tools (fenced, audited, permissioned as
always). Consequences, all intentional:

- The store cannot become a second, less-protected copy of the inbox.
- Deleting a message in Mail effectively removes its content from the system —
  the store's pointer just dangles and is pruned.
- The serve layer inherits source permissions: no Mail access, no content.

## Three organs

### 1. Capture (daemon, launchd interval ~15 min)

- **v1 sources: Mail + Calendar only** (Q13 settled — the two most structured,
  least creepy sources; Messages/browsing raise the stakes enormously).
- Mail: incremental header sweep via cortland-mail's script layer
  (`dateReceived > cursor`), across accounts. Headers, recipients, thread
  linkage, flags — no bodies.
- Calendar: events in a sliding window (−1 day … +14 days). Access route needs a
  spike (NOTES Q20): EventKit via JXA's ObjC bridge is the candidate —
  Calendar.app AppleScript is notoriously slow.
- Every capture run writes an audit row (tool `context_capture`, counts only).
- Cursor state lives in the store; a missed interval just widens the next sweep.

### 2. Curate (two layers, strictly separated)

**Layer 0 — deterministic, always on, no model.** Pure code over captured
metadata: people (address ↔ display-name merging), thread graphs, meeting↔thread
correlation (shared people + time proximity), volume/recency stats, "what changed
since T" deltas. This alone powers a useful briefing.

**Layer 1 — model-assisted, opt-in, declared.** Commitment extraction ("I'll get
you X by Friday"), standing-question answering, digest prose. Runs on the user's
configured model endpoint: **local model by default** (runtime TBD — NOTES Q21);
a cloud model only if the user explicitly configures one, and the config must
declare what is sent (headers-only vs. fetched bodies). Every Layer-1 run is
audited with its egress declaration — the `network: true` pattern from
folder pipelines, generalized. Prompt-injection posture: mail-derived text
entering a Layer-1 prompt is fenced; extracted outputs are DATA (stored with
`source: model` provenance), never instructions to act on.

**Store shape (Q14 settled):** one SQLite DB (`context.db`, mode 600, beside the
audit DB) — tables: people, messages (headers+pointers), events, threads,
commitments (with source pointer, confidence, and extraction provenance),
judgments (human layer — see flywheel), cursors, digests. Retrieval: recency +
entity joins + **SQLite FTS5** over subjects/extracted facts. **No embeddings in
v1** — for briefing-shaped questions, entity+recency beats vectors; revisit only
if FTS demonstrably fails.

### 3. Serve

- **`cortland-context` MCP server** on the framework — read-mode tools, fenced:
  `context_brief(topic?)`, `context_person(name)`, `context_commitments(since?)`,
  `context_changes(since)`. Every answer cites its sources (messageIds, event
  ids) so any claim can be traced and fetched.
- **The morning briefing** — a markdown file delivered through the folder tree
  (tier 3): `Agents/Briefings/YYYY-MM-DD.md`, generated at a configured time.
  Readable on any device via iCloud; no app.

## The briefing spec (Q15 settled)

A briefing is **answers to standing questions the user wrote, plus deterministic
deltas** — never a generic summary. `standing-questions.yaml` lives IN the
Briefings folder: editable from any device, self-documenting, travels with the
output it shapes (the `.pipeline.yaml` pattern again). Example:

```yaml
questions:
  - id: commitments
    ask: "What did I commit to by email this week, and what's due?"
  - id: stakeholders
    ask: "Threads involving my key people that I haven't replied to"
    people: ["<name or address>", "..."]
  - id: changes
    ask: "What changed since yesterday in anything I'm active on?"
```

Sections: standing-question answers (each with citations) → today's meetings with
correlated threads → new-since-yesterday → commitments coming due. Anything the
system isn't confident about says so rather than guessing. The file opens with a
provenance header and a data-not-instructions notice (briefings will be read by
other AI sessions — they get the fence too).

## The flywheel (immutable AI layer / human layer)

Corrections tune the system without ever rewriting its inputs:

- AI-derived rows (commitments, answers, correlations) are **immutable** once
  written; human feedback lands in a separate `judgments` table joined at serve
  time — the split proven in production review tooling elsewhere.
- v1 correction surface: the briefing file itself. Each item carries a stable id;
  editing a line's checkbox (`- [x] not important` / `- [ ] missed: …`) from any
  device is parsed on the next capture cycle into a judgment row. The briefing is
  both output and feedback form — no extra UI.
- Judgments feed Layer 0 filters (mute this sender/thread) and Layer 1 prompts
  (few-shot examples of what mattered and what didn't).

## Milestones — ALL BUILT 2026-07-30 (packages/context)

- **M1** ✅ — store + Mail capture + `context_person` / `context_changes` served.
- **M2** ✅ — Calendar capture (allowlisted, daily cadence) + deterministic
  briefing with meeting↔thread correlation.
- **M3** ✅ — standing questions + Layer-1 commitments via a swappable
  ModelProvider (ollama / command / none) with per-run egress audit;
  model-invented pointers rejected; failures degrade to candidates.
- **M4** ✅ — flywheel: stable item ids, checkbox corrections → judgments →
  mutes at serve time; AI rows immutable.

Nothing depends on a model until M3, and M3 degrades gracefully to M2 if no
model is configured. Remaining opens: NOTES Q21 (Apple Foundation Models
bridge), Q22 (iOS round-trip verification), Q23 (retention defaults).

## Why this could be an actual company

It's the missing organ between platform pipes and AI brains — the thing platform
vendors keep announcing and not shipping (see NOTES watch item: WWDC26 Siri =
validation, closed/capped/cloud-tethered). The privacy-first, on-your-own-hardware
version is structurally hard for cloud-first vendors to copy, and "pointers, not
copies" is the one-sentence version of why this one can be trusted. 01 gives it
credibility, 02 gives it capture, 03 gives it delivery — all three now exist.
