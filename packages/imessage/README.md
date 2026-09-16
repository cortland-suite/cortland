# @cortland/imessage

**Text your own AI.** A second Apple ID signs into Messages on your Mac; you
text it from your phone like any contact. A local model (Ollama — Gemma,
Llama, whatever you pull) answers, using the suite's governed tools against
your real mail, reminders, notes, and calendar. Nothing leaves the Mac, and
nothing consequential happens without your reply.

```
cortland-imessage setup \
  --owner "+15551234567" \
  --assistant "assistant@example.com" \
  --model gemma4:e2b-it-qat \
  --name "Your Name" \
  --about "Central timezone. Prefer brief answers."

cortland-imessage status     # preflight: config, chat.db access, model, tools
cortland-imessage run        # foreground
cortland-imessage install    # launchd: runs whenever the Mac is on

cortland-imessage notify --text "Backup finished" --source nightly-backup
```

## The four laws (enforced in code, not prompts — see docs/06)

1. **Only the owner commands.** Allowlisted handles are filtered at the SQL
   boundary; an unconfigured bridge refuses to start — there is no
   "answer everyone" mode to misconfigure.
2. **Everyone else is silence.** Other senders are never read into memory,
   never summarized, never answered. A count in the audit log is their only
   trace.
3. **No other conversations exist.** There are no general Messages-reading
   tools here. The bridge sees one thread and sends to one handle, fixed at
   startup — no model output can redirect a message.
4. **Rate discipline.** A per-hour send cap, counted from the audit log so it
   holds across restarts. The traffic pattern is a person texting one contact,
   by construction — one recipient, hard cap, no exceptions.

## Living with it

- **"Received — working on it…"** lands in seconds; a small local model can
  take 30–60 to answer. Past 75% of the context window the ack says so, and at
  95% the bridge clears the thread itself and asks you to resend.
- **"what can you do"** is answered from the tools actually mounted — no model
  call, so it cannot overclaim or hallucinate.
- **"clear context"** (or "new topic", "reset") starts fresh, instantly.
- Only the tools a message plausibly needs are sent to the model: a reminder
  request ships ~410 tokens of schema instead of ~2,400, leaving the window
  for the conversation.

## notify_owner — letting an agent reach you first

Everything above is reactive: you text the bridge, the bridge answers. But an
agent working while you are asleep — a watcher, an overnight job, a pipeline —
needs to start the conversation. That is `notify_owner`:

```
notify_owner(text: string, source?: slug)
```

There is **no recipient argument**. The handle comes from your config, so no
model output and no injected content can point a message at someone else. That
is the whole reason it can be write-safe rather than gated: a message to you is
not an outward action, it is the review loop, and gating it behind an approval
you would receive by the same channel it is asking to use is a circle, not a
safeguard.

It is honest about what it cannot do: `undo: "none"`, because a sent text
cannot be unsent. At the hourly cap it **fails loudly** rather than going
quiet — a notification tool that silently stops is indistinguishable from one
with nothing to say. The message body is redacted in the audit log
(`{length, sha256}`), so the row proves a text was sent without storing it.

Callers that are not MCP clients use the CLI, which runs the same governed
tool through the same path:

```bash
cortland-imessage notify --text "Restock: Best Buy" --source stock-monitor
```

## Approvals by reply

A gated action texts you what wants to run plus a one-time nonce:

> Approval needed: mail_mark — Would flag "Your Tuesday trip…"
> Reply "yes 4f2a1c" to run it, "no 4f2a1c" to refuse.

The **framework** reads that reply from chat.db and matches the nonce — the
model never sees it, so injected content can at most make the assistant *ask*.
Wrong nonce, stranger, or silence: refused. This is the same trust class as
the folder channel with the UX of texting back.

## Setup on the Mac

1. A second Apple ID, signed into **Messages.app only** (your system iCloud
   stays yours). This account is a mouthpiece — it owns no data.
2. **Full Disk Access** for the host process (reads `chat.db`).
3. **Automation → Messages** (sending).
4. `ollama serve` with a tool-capable model pulled. `gemma4:e2b-it-qat`
   (4.3 GB) is the recommended default and fits an 8 GB Mac; the 9.6 GB
   `gemma4:e4b` will thrash it. Gemma 3 has no tool support in Ollama.

Reads are free; writes stay dry-run until you enable live mode, and every
action — handled, replied, ignored, approved, refused — is a row in the
suite's audit DB.

Illustrated walkthrough (second Apple ID, Ollama from zero, LM Studio /
Osaurus as MCP hosts): [docs/08_local_models.md](../../docs/08_local_models.md).
