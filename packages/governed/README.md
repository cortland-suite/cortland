# @honeycrisp/governed

**MCP tools you'd let touch your actual life.** A TypeScript framework that makes
"governed" a property enforced by construction, not a promise in a README.

Most MCP servers for personal data hand a language model loaded guns: `delete_email`,
`send_message` — no gates, no audit, no undo. This library is the contract around the
wrapper. Every tool built on it gets, automatically:

1. **Dry-run by default.** Gated tools execute as previews unless live mode is
   explicitly enabled. Every configuration error fails *toward* dry-run — a corrupt
   config file, a mistyped env var, a wrong type all resolve to "don't execute."
2. **The gate, out-of-band from the model.** Live writes require per-action human
   approval — via a native macOS dialog (default) or a checkbox file in a folder you
   choose (the remote channel; see below). Default is Deny, timeout denies, channel
   errors deny. **Approval is verified by the framework, never relayed by the model:**
   if the approval signal traveled through model text, the gate would be exactly as
   injection-resistant as the model. It doesn't, so it isn't.
3. **An audit row for every execution path.** Success, failure, dry-run, denial,
   refusal — one shared SQLite DB (`~/Library/Application Support/<name>/audit.db`).
   Fields a tool declares sensitive (`redact: ["body"]`) are stored as length + hash,
   never content.
4. **Undo, enforced at registration.** A tool claiming `undo: "native"` must produce
   an undo recipe *before* the write executes, or the framework refuses — first at
   `defineTool` time (no `planUndo`, no registration), then per call (no recipe, no
   write). `compensate` and `none` are honest labels in the audit trail.
5. **Injection fencing.** Content read from user data is wrapped in a nonce-delimited
   fence with a standing notice: this is data, not instructions. Fencing is the
   default for read tools; opting out is explicit.
6. **Provenance.** Everything a tool creates carries `created by <tool> v<version>`.
7. **Env hygiene.** The server refuses to start if argv contains credential-shaped
   values. Secrets live in the Keychain or env files outside the repo.

## Usage

```ts
import { z } from "zod";
import { createGovernedServer, defineTool } from "@honeycrisp/governed";

const noteCreate = defineTool({
  name: "note_create",          // verb_noun, enforced
  description: "Create a note",
  scope: "Notes",               // the ONE app this touches
  mode: "write-gated",          // read | write-safe | write-gated | destructive
  undo: "compensate",           // native | compensate | none (native ⇒ planUndo required)
  redact: ["body"],             // audit stores length + hash, not content
  inputSchema: { title: z.string(), body: z.string() },
  handler: async (args, ctx) => {
    // ctx.provenance === "created by note_create v0.1.0" — stamp it on the artifact
    // ...
    return { content: `Created "${args.title}"` };
  },
});

const { connectStdio } = createGovernedServer({
  name: "my-governed-server",
  version: "0.1.0",
  tools: [noteCreate],
});
await connectStdio();
```

## Enabling live mode

Dry-run is the default, always. To allow live execution (each action still needs
per-action approval in the dialog):

- `GOVERNED_LIVE=1` in the server's environment, or
- `{ "live": true }` in `~/Library/Application Support/<name>/config.json`.

Anything else — including plausible-looking values like `GOVERNED_LIVE=yes` — resolves
to dry-run. Errors fail closed.

## Approval channels

Four channels, one contract: the human decision never travels through model text.

**The default is the dialog** — the one channel proven to put a prompt in front
of a human on every Mac. The **"auto" ladder** is the opt-in upgrade: when the
connected MCP client declares the elicitation capability, gated actions surface
as a **native Approve/Deny card in the client's own UI**, falling back to the
dialog otherwise. Elicitation is a protocol request answered by the client
application, not by the model: the model never sees the prompt and cannot
answer it. Why opt-in rather than default: a client can *declare* the
capability yet auto-decline the request without rendering anything (observed
in the field, 2026-07-31) — fail-closed, but silently unusable as a default.

Explicit choices in `config.json`:

```json
{ "approval": { "channel": "elicit", "fallback": "dialog" } }
```

- `"auto"` — the elicit→dialog ladder above.
- `"elicit"` — elicitation only; `fallback` is `"dialog"` or `"none"` (deny when
  the client can't elicit — you named one surface, so exactly it is honored).
- `"dialog"` — always the native macOS dialog.
- `"folder"` — the file channel below (survives clients with no elicitation and
  humans with no Mac in reach).

## Approving from your phone (the folder channel)

The dialog requires eyes on the Mac's screen and elicitation requires a capable
client. When neither fits, route approvals through a folder:

```json
{
  "live": true,
  "approval": {
    "channel": "folder",
    "dir": "~/Library/Mobile Documents/com~apple~CloudDocs/Agents/Approvals",
    "timeoutSeconds": 300
  }
}
```

Each gated action writes a `pending-*.md` file into that folder describing exactly
what wants to run. Put the folder in iCloud Drive and it appears on every device
you own. Decide either way:

- **Move the file** into the `Approve` subfolder to run it, or `Deny` to refuse —
  fully native on iOS (long-press → Move), no text editor required (stock iOS
  cannot edit text files — a real phone-test finding);
- or check the **APPROVE** / **DENY** box in any text editor.

Check DENY, edit nothing until the deadline, delete the file, check both boxes,
or send conflicting signals (moved to Approve with DENY checked) — all deny. The
config is re-read per action, so you can switch dialog ↔ folder without
restarting anything. An unrecognized channel name denies every request rather than
guessing — a typo must not silently move the decision surface.

**Threat model, honestly:** the decision surface is a file, so the guarantee is
only as strong as write access to that folder. If the agent driving this server
can write arbitrary files as your user, it could check the box itself. Keep the
approvals folder outside any directory your agent is sandboxed into or has blanket
write permission for, and deny it explicitly in your agent's permission rules
(e.g. Claude Code permission deny rules). The audit row records
`approvalMethod: "folder"`, so a review can always ask whether a decision came
through the channel you expected. The v2 queue (menubar UI + push notification)
moves the surface out of the filesystem entirely; this channel is the bridge that
works today.

## Design notes

- The approval channel is pluggable (`ApprovalChannel`). v1 shipped the macOS
  dialog, v1.5 the folder channel, v2 the capability-detected elicitation ladder
  above; the async approval queue with push notifications remains the roadmap.
  All implementations must keep the human decision out-of-band from the model.
- One audit DB for the whole suite, by design: one place to inspect everything.
- See `examples/reminders` for a complete two-tool server.
