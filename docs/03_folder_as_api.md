# 03 — Folder-as-API (agents wearing a Finder costume)

**The idea:** watched folders on iCloud Drive are the API. Drop anything in from any
Apple device — a voice memo from the truck, a PDF from the phone, a CSV — and a daemon
on the Mac runs the right pipeline and files the result back beside the input. No app,
no UI, no login: the filesystem is the interface, and iCloud is the transport.

Proven ancestor: the same pattern running in production for external users elsewhere
(shared-folder upload → validate → process → deliver). This generalizes it to one
person's whole digital life.

## Shape

```
iCloud Drive/
└── Agents/
    ├── Transcribe/          ← drop audio → .txt + summary appear beside it
    │   └── .pipeline.yaml   ← the folder documents itself
    ├── Summarize/           ← drop any doc → one-page brief
    ├── Inbox/               ← drop anything → router picks the pipeline
    └── _results convention: <name>.result.md | <name>.error.md
```

- **Watcher (built 2026-07-30):** daemon on the Mac (launchd KeepAlive template
  shipped). chokidar/FSEvents with write-stability detection for sync bursts;
  dataless files forced local (brctl download) before processing.
- **Pipelines (built 2026-07-30):** defined per-folder in `.pipeline.yaml`,
  zod-validated. v1 steps are local argv arrays (no shell), chained stdout→stdin;
  network use is a declared field. Model-calling steps are the natural v2 — a step
  that calls a local model or an API is still just a command with `network: true`.
- **Governance inherited from the framework:** pipelines run under the same audit log;
  any step that would leave the machine (an API call) is declared in the yaml — the
  folder's contract is inspectable before you drop anything in it.
- **Failure UX:** `<name>.error.md` beside the drop, in plain English, plus optional
  ntfy/notification push. Silence is never the failure mode. (NOTES Q12.)

## Why it's lovable

Demos in 30 seconds. Works from a phone with zero software installed on the phone.
Every pipeline added compounds the value of the folder tree. And it's the natural
delivery surface for 04's briefings: the morning brief is just a file that appears.
