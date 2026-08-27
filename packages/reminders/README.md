# @cortland/reminders

Apple Reminders over MCP, governed. Five tools, three trust tiers:

- **Reads are free and fenced** — `reminders_lists`, `reminders_search`
  (name/list/due-window filters). Content returns inside the injection fence:
  data, not instructions.
- **Creation is write-safe** — `reminder_create` makes a visible, local,
  provenance-stamped artifact you can delete on any device; same tier as a
  mail draft.
- **Mutation is gated, deletion is destructive — both with native undo.**
  `reminder_complete` captures the prior state before it writes;
  `reminder_delete` captures a full snapshot first, so its undo recipe is
  "recreate exactly what was deleted." With live mode off (the default) both
  preview instead of executing; live runs require per-action human approval.

Every action lands in the suite's shared audit DB. First use triggers the
macOS Automation prompt (your MCP host → Reminders).

Until `@cortland` is on npm, point Claude at this repo's build:

```
claude mcp add --scope user cortland-reminders -- node ./packages/reminders/dist/server.js
```
