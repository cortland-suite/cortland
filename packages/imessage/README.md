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
4. **Rate discipline.** A per-hour send cap, replies only, never initiates.
   The traffic pattern is a person texting one contact, by construction.

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
