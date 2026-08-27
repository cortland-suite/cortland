# Setting up Cortland

From a clean Mac to a working governed assistant — including the optional
iMessage bridge, where you text a local AI and it works on your real data.

Everything below runs on your own machine. No accounts, no cloud service, no
API keys.

---

## Every command, in order

The whole path, if you'd rather not read prose. Each block is explained in the
section that follows.

```bash
# 1. the suite (@cortland is not on npm yet — build from this repo)
git clone https://github.com/cortland-suite/cortland.git
cd cortland
npm install && npm run build
npx cortland setup                  # wizard: MCP clients, permissions, folders

# 2. a local model (only for the iMessage bridge)
brew install ollama
brew services start ollama            # persistent — survives reboot
ollama pull gemma4:e2b-it-qat         # 4.3 GB, fits an 8 GB Mac

# 3. the iMessage bridge (from the same clone)
#    → first: create a second Apple ID and sign Messages.app into it (§5.1)
#    → then: grant Full Disk Access to your terminal AND `which node` (§2)
npx cortland-imessage setup --discover \
  --model gemma4:e2b-it-qat \
  --name "Your Name" \
  --about "Central timezone. Prefer brief answers."
#    → it waits; text the assistant from your phone; both handles are detected

npx cortland-imessage status        # every line should be green
npx cortland-imessage install       # launchd: runs whenever the Mac is on

# 4. allow writes (still asks per action)
#    edit ~/Library/Application Support/cortland/config.json → "live": true
```

To stop everything: `npx cortland-imessage uninstall`, or set `"live": false`
for an instant read-only mode that needs no restart.

---

## 0. What you need

Check this **before** you clone. Failures people hit are almost always here,
not in the TypeScript.

### Minimum — tools in Cursor / Claude / Codex / LM Studio

| | |
|---|---|
| **macOS 13 Ventura** or newer | Mail/Reminders/Notes/Calendar Automation. The iMessage bridge also needs 13+ (`chat.db`). |
| **Node 20+** | `node -v`. [nodejs.org](https://nodejs.org) or `brew install node`. |
| **Xcode Command Line Tools** | `xcode-select -p`. If that errors: `xcode-select --install`. Required to compile `better-sqlite3`. |
| **~500 MB disk** | Clone + `node_modules` + build. |
| **An MCP client** | Cursor, Claude Code, Claude Desktop, Codex, or LM Studio 0.3.17+. |
| **The Apple apps, signed in as you** | Cortland does not create iCloud accounts for Mail. |

Intel Macs can drive a cloud/Cursor model against these tools. They are a
poor place to run a local LLM.

### Extra — local model (LM Studio, Ollama, Osaurus)

| | |
|---|---|
| **RAM** | **8 GB minimum** (Gemma 4 E2B, 4.3 GB weights). 16 GB+ if you want E4B or several apps loaded. |
| **Disk** | **+6 GB** for Ollama + `gemma4:e2b-it-qat`. LM Studio/Osaurus models similar. |
| **Apple Silicon** | Strongly recommended. M1 or newer. |
| **Osaurus** | macOS 15.5+, Apple Silicon. |

### Extra — texting it (iMessage bridge)

| | |
|---|---|
| **Second Apple ID** | Signed into **Messages.app only**. Mouthpiece, not a worker. [§5.1](#51-create-the-assistants-apple-id). |
| **Full Disk Access** | Terminal (or your `node` binary, if launchd). Reads `chat.db`. |
| **Automation → Messages** | First send prompts. |

---

## 1. Install

`@cortland` 0.2.0 is not on npm yet. Clone and build:

```bash
git clone https://github.com/cortland-suite/cortland.git
cd cortland
npm install && npm run build
npx cortland setup
```

The wizard asks before every step (default is always **No**) and writes what it
did to the audit database. It offers to:

- register the servers with Claude Code and Claude Desktop,
- trigger the macOS permission prompts **while you're watching**, instead of
  mid-conversation later,
- create the iCloud `Agents/` folder for pipelines and briefings,
- schedule mail/calendar capture and the morning briefing,
- route approvals through a folder, with an optional phone ping.

Everything the wizard does can be done by hand; nothing is magic.

---

## 2. Permissions

macOS gates this properly, and you should let it.

**Automation** (required): the first time a tool touches Mail, Reminders,
Notes, Calendar, or Messages, macOS asks. Click OK. If you miss the prompt:
System Settings → Privacy & Security → **Automation**.

**Full Disk Access** (only for two features): full-text mail search, and the
iMessage bridge (which reads `~/Library/Messages/chat.db`). Grant it to the
process that actually runs the code — this trips everyone up:

- Running from a terminal? Add **your terminal app** (Terminal, iTerm, Ghostty…).
- Running the bridge as a launchd agent? Add your **node binary** — find it with
  `which node`; in the file picker press **⌘⇧G** and paste the path.
- Using Claude Desktop or Claude Code's app? Add **that app**.

> **Restart the app after granting.** macOS only re-reads the permission at
> process start, so a running terminal keeps its old (denied) state.

Check it worked:

```bash
node -e 'require("fs").accessSync(process.env.HOME+"/Library/Messages/chat.db"); console.log("readable")'
```

---

## 3. Live mode and approvals

**Nothing consequential executes until you opt in.** Out of the box, gated
tools (send, delete, move, mark) return a preview instead of acting.

Config lives at
`~/Library/Application Support/cortland/config.json`:

```json
{
  "live": true,
  "approval": { "channel": "dialog" }
}
```

`"live": true` allows execution; every gated action *still* asks a human,
per action. Channels:

| Channel | Prompt appears | Use when |
|---|---|---|
| `dialog` *(default)* | Native macOS dialog | You're at the Mac. Proven everywhere. |
| `folder` | A file in an iCloud folder — move it into `Approve/` or `Deny/` | You're away from the Mac; works from a stock iPhone with no extra apps. |
| `auto` | Client's own UI if it supports MCP elicitation, else dialog | Opt-in. See the caveat below. |
| `imessage` | A text asking you to reply `yes <code>` | Used automatically by the iMessage bridge. |

> **Elicitation caveat:** Claude Code *declares* the elicitation capability but
> currently auto-declines the request without showing anything (observed
> 2026-08-01) — likely a spec-version mismatch. That's why `dialog`, not
> `auto`, is the default. Claude Desktop and claude.ai connectors don't support
> elicitation at all yet.

**Optional phone ping** for the folder channel:

```json
{ "approval": { "channel": "folder", "dir": "~/…/Agents/Approvals",
                "notify": { "url": "https://ntfy.sh/<long-random-topic>" } } }
```

Install the free **ntfy** app and subscribe to that topic. The ping is a fixed,
information-free string — the relay learns that *something* needs approval,
never what. The topic name is the secret; the wizard mints an unguessable one.

---

## 4. Using it from an MCP client

Once registered, just talk to your assistant: *"what did I miss this week?"*,
*"draft a reply saying Thursday works"*, *"send that reply"* (asks first),
*"remind me to bring the contract."*
The tools are invisible; you'll only notice Cortland when it asks permission.

Verify from a terminal:

```bash
claude mcp list | grep cortland
```

---

## 5. The iMessage bridge (text your own AI)

This is the part that needs the most setup, and the payoff is the largest: you
text a contact and a local model works on your real data.

### 5.1 Create the assistant's Apple ID

Make a **second Apple ID** (any email works). This account is a *mouthpiece*,
not a worker — it owns no data and does nothing on its own. Your Mac still does
all the work as *you*.

On the Mac: **Messages → Settings → iMessage → sign in with that Apple ID.**
Your system iCloud account stays exactly as it is.

> Give the second account a strong password and 2FA. If someone hijacks it they
> can read what the assistant sends you and impersonate it socially — but they
> **cannot** command the bridge or approve anything, because both are pinned to
> your own handle (§5.3).

### 5.2 Install Ollama and a model

Never installed a local model? Illustrated, from zero, including LM Studio
and Osaurus as *clients* rather than the bridge brain:
**[docs/08_local_models.md](docs/08_local_models.md)**.

```bash
brew install ollama
ollama serve                       # or: brew services start ollama
ollama pull gemma4:e2b-it-qat      # 4.3 GB — good default for 8 GB Macs
```

### 5.3 Configure — with automatic handle discovery

From this repo, prefix every `cortland-imessage` / `cortland-remote` command
with `npx` (the binaries are workspace bins until `@cortland` is on npm).

The handle Messages stores is rarely the one you'd type (E.164 `+15551234567`,
or an Apple ID). So don't type it — let setup watch for your message:

```bash
cortland-imessage setup --discover --model gemma4:e2b-it-qat \
  --name "Your Name" --about "Central timezone. Prefer brief answers."
```

It waits up to three minutes. **Text the assistant's Apple ID from your phone**,
and it detects both your handle and the assistant account, then writes the
config. That one read is the only unfiltered look the package ever takes at
`chat.db`, it returns handles and never text, and from then on only the
detected handle is obeyed.

<details>
<summary>Doing it by hand instead</summary>

```bash
node -e '
const D=require("better-sqlite3");
const db=new D(process.env.HOME+"/Library/Messages/chat.db",{readonly:true});
for (const r of db.prepare(`SELECT h.id sender, m.destination_caller_id dest
  FROM message m JOIN handle h ON m.handle_id=h.ROWID
  WHERE m.is_from_me=0 ORDER BY m.ROWID DESC LIMIT 3`).all())
  console.log("from:",r.sender," to:",r.dest);'
```

The newest row shows your handle (`from`) and the assistant account (`to`).
Phone numbers must be **E.164** — `+15551234567`, exactly as printed. Then:

```bash
cortland-imessage setup --owner "+15551234567" \
  --assistant "assistant@example.com" --model gemma4:e2b-it-qat
```

</details>

### 5.4 Check and run

```bash
cortland-imessage status      # every line should be green
cortland-imessage run         # foreground; Ctrl-C to stop
cortland-imessage install     # launchd: starts it now and on every boot
```

`status` checks the five things that actually break: owner allowlist, assistant
account pinning, live mode, `chat.db` readability, model presence, and how many
tool packages are mounted.

### 5.5 What the bridge will and won't do

- **Only your handle is obeyed.** Other senders are filtered out *in the SQL
  query* — never read into memory, never summarized, never answered. The audit
  log records a count and nothing else.
- **Reads are pinned to the assistant account**, so your personal conversations
  (which live in the same `chat.db`) are outside the query entirely.
- **It only ever texts you.** There is no general "send a message" tool. Not
  gated — absent.
- **Gated actions ask by reply**: *"Approval needed: reminder_delete — Would
  permanently DELETE 'call the vet' from Reminders, due Sunday 2:00 PM. Reply
  yes a3f9c1."* The code matching that nonce runs in the framework; the model
  never sees it and cannot forge it. No reply in 5 minutes = refused.
- **Rate discipline**: replies only, never initiates, hard hourly cap. Apple
  has permanently banned iMessage automation that looked like spam.

### 5.6 Living with a local model

- **"Received — working on it…"** arrives within seconds so you know it's alive;
  a small model on a small Mac can take 30–60 seconds to answer.
- Past **75%** of the context window the ack tells you (`context 78% full`); at
  **95%** the bridge clears the thread itself and asks you to resend.
- Say **"clear context"** (or "new topic", "reset", "start over") any time.

---

## 6. Choosing a local model

The binding constraint is RAM, not the model's spec sheet. **Which app holds
the model** (Cursor vs LM Studio vs Ollama vs Osaurus) is
**[docs/08_local_models.md](docs/08_local_models.md)** — illustrated, from a
clean install.

| Model | Size | Verdict on 8 GB |
|---|---|---|
| `gemma4:e2b-it-qat` | 4.3 GB | **Recommended.** Clean native tool calls. |
| `gemma4:e4b-it-qat` | 6.1 GB | Tight; fine on 16 GB. |
| `gemma4:e4b` | 9.6 GB | Thrashes an 8 GB Mac into swap — avoid. |
| `llama3.2:3b` | 2.0 GB | Fast, but unreliable at tool calling with many tools. |
| `gemma3:4b` | 3.3 GB | **No tool support in Ollama** — usable for briefings only. |

Two knobs when memory is tight: `OLLAMA_KV_CACHE_TYPE=q8_0` roughly halves the
KV cache cost, and mounting fewer tool packages frees context (the 22 default
tools cost ~2,400 tokens of schema before you type a word).

---

## 7. Remote access (other devices)

```bash
npx cortland-remote token mint --label my-laptop   # shown once; only a hash is stored
npx cortland-remote serve
tailscale serve --bg 7811                          # reach it from your own devices
```

Loopback-only by design — there is no setting to bind wider; exposure is always
a tunnel's explicit job. `read` tokens can't invoke gated tools at all, and a
stolen `write` token still can't act: it can only *ask*, and the approval goes
to you.

---

## 8. Troubleshooting

**"chat.db not found — is Full Disk Access granted?"** — the *running* process
lacks FDA. See §2, and restart the app afterward.

**Bridge is silent.** `cortland-imessage status`. Usual causes: ollama not
running, model not pulled, or the owner handle isn't in E.164 form.

**The assistant answers, but never uses tools.** Your model can't tool-call (see
§6) or is drowning in schemas. Try `gemma4:e2b-it-qat`.

**Reminders land on absurd dates (1904, or years in the past).** You're on an
old build: a model has no clock, so the system prompt must state today's date.
Upgrade `@cortland/imessage`.

**"Tried setting that reminder, but I keep getting an error with the date
format."** Old build — schemas demanded UTC while Apple's apps are local-time.
Upgrade `@cortland/reminders` / `/calendar`.

**Approval prompts show a UUID instead of a name.** Old build; previews now
describe the object. An approval you can't evaluate isn't consent — upgrade.

**Everything is slow and the Mac is thrashing.** The model is too big
(`sysctl vm.swapusage`). See §6.

**A gated action did nothing and you got no prompt.** That's fail-closed
working. Read the audit log:

```bash
sqlite3 ~/Library/Application\ Support/cortland/audit.db \
  'SELECT ts,tool,outcome,approval_method,detail FROM audit ORDER BY ts DESC LIMIT 10'
```

`denied | timeout` means nobody answered; `channel-error` means the prompt
couldn't be delivered. Both refuse rather than proceed.

---

## 9. Where things live

| Path | What |
|---|---|
| `~/Library/Application Support/cortland/config.json` | Live mode, approvals, model, bridge settings |
| `~/Library/Application Support/cortland/audit.db` | Every action, approval, denial, dry-run |
| `~/Library/Application Support/cortland/context.db` | Context store (metadata + pointers, never message bodies) |
| `~/Library/Mobile Documents/…/Agents/` | Pipelines, `Briefings/`, `Approvals/` |
| `~/Library/LaunchAgents/com.cortland.*.plist` | Scheduled capture, briefing, bridge |

**Turning it off:** set `"live": false` for instant read-only, `launchctl
unload -w` any agent to stop it, and delete the config to stop everything. The
audit database is yours to keep or delete.
