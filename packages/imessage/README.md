# @honeycrisp/imessage

**Text your own AI.** A second Apple ID signs into Messages on your Mac; you
text it from your phone like any contact. A local model (Ollama — Gemma,
Llama, whatever you pull) answers, using the suite's governed tools against
your real mail, reminders, notes, and calendar. Nothing leaves the Mac, and
nothing consequential happens without your reply.

```
honeycrisp-imessage setup --owner "+15551234567" --model gemma4:e4b
honeycrisp-imessage status     # preflight: config, chat.db access, model, tools
honeycrisp-imessage run        # the bridge (or: install → launchd)
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
4. `ollama serve` with a tool-capable model pulled (Gemma 4 recommended).

Reads are free; writes stay dry-run until you enable live mode, and every
action — handled, replied, ignored, approved, refused — is a row in the
suite's audit DB.
