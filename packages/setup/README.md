# @honeycrisp/setup

Interactive onboarding for the Honeycrisp suite. One command, every step
proposed and confirmed before it happens, everything recorded in the suite's
shared audit DB:

```
honeycrisp setup
```

What it offers (each step is a y/N question, defaulting to No):

1. **MCP registration** — adds the mail and context servers to Claude Code
   (user scope) and Claude Desktop (with a backup of the previous config).
2. **Permission warm-up** — triggers the macOS Automation prompt for Mail on
   purpose, so the first real call doesn't die in a permission dialog; points
   at the Full Disk Access pane for the optional full-text search tier.
3. **Agents folder** — starter folder-as-API pipelines in iCloud Drive, plus
   the launchd agent that runs them while the Mac is on.
4. **Context schedules** — mail+calendar capture every 15 minutes, morning
   briefing at 7:00, both via launchd.
5. **Remote approvals** — routes gated-write approvals through an iCloud
   folder so you can approve from any device (see `@honeycrisp/governed` for
   the channel's threat model).

Non-interactive use: pipe y/n answers, one per line (`printf 'y\nn\ny\n' |
honeycrisp setup`); missing answers default to No.

House doctrine applies to the wizard itself: nothing is silent, nothing is
destructive, and live mode stays off until you opt in.
