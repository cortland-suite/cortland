# Bring your own model

Cortland is not a model. It is a set of governed tools for the Apple apps
already on your Mac. The brain is yours: Claude, a cloud Codex session, or a
4 GB file that never leaves the SSD.

There are **two ways** to hook a model up. Pick one. You can run both.

<p align="center">
  <img src="images/two-paths.svg" alt="Path A: an MCP client hosts the model and Cortland is a plugin. Path B: you text an iMessage bridge; Ollama is the brain; the Mac still acts as you." width="860">
</p>

| | Path A — MCP client | Path B — iMessage bridge |
|---|---|---|
| **Where you talk** | Cursor, Claude, Codex, LM Studio, Osaurus | Messages, from any of your devices |
| **Who hosts the model** | That app | Ollama on the Mac (today) |
| **Second Apple ID** | No | **Yes** — Messages.app only, a mouthpiece |
| **Approvals** | Dialog / Files / client UI | Reply `yes <code>` in the thread |
| **Good first try** | Cursor or LM Studio | Ollama + Gemma 4 E2B |

If you already chat with a local model in LM Studio or Osaurus, start at
**Path A**. If the whole point is texting it from your phone, skip to **Path B**.

## Requirements (local-model extras)

The Mac / Node / Xcode floor is on the [README](../README.md#requirements).
On top of that, a **local** model wants:

| | Minimum | Notes |
|---|---|---|
| **RAM** | 8 GB | Gemma 4 E2B (4.3 GB). 16 GB+ for E4B. |
| **Free disk** | ~6 GB | Weights + runtime. |
| **Chip** | Apple Silicon | Intel: use Path A with Cursor/Claude, not a local LLM. |
| **Tool calling** | Required | Gemma 3 in Ollama cannot. The schemas are ~2,400 tokens before you type. |

---

## 0. Build Cortland once

`@cortland` 0.2.0 is not on npm yet. Everything below assumes this clone:

```bash
git clone https://github.com/cortland-suite/cortland.git
cd cortland
npm install && npm run build
```

Note the absolute path of the clone. MCP clients need it. In the snippets,
replace `/ABS/cortland` with yours (`pwd` after `cd cortland`).

First `npm install` compiles `better-sqlite3`. If it dies on `node-gyp`,
you are missing Xcode Command Line Tools: `xcode-select --install`.

Then either:

```bash
npx cortland setup          # Path A helper: Claude Code + Claude Desktop
```

or jump to the client you actually use.

---

## Path A — the client hosts the model

Cortland starts as a child process (stdio) or, for apps that only speak HTTP
MCP, as a loopback gateway. The model never lives inside Cortland. Load a
**tool-capable** model in the client first or the tools will sit unused.

Tiny models drown: the default tool schemas are ~2,400 tokens before you type
a word. Gemma 4-class (E2B / E4B) is the floor we have field-tested. Gemma 3
in Ollama has **no tool template** — it will not call tools.

### Cursor

1. Cursor Settings → **MCP**.
2. Add a global server (or create `.cursor/mcp.json` in a project).
3. Paste:

```json
{
  "mcpServers": {
    "cortland-mail": {
      "command": "node",
      "args": ["/ABS/cortland/packages/mail/dist/server.js"]
    },
    "cortland-reminders": {
      "command": "node",
      "args": ["/ABS/cortland/packages/reminders/dist/server.js"]
    },
    "cortland-notes": {
      "command": "node",
      "args": ["/ABS/cortland/packages/notes/dist/server.js"]
    },
    "cortland-calendar": {
      "command": "node",
      "args": ["/ABS/cortland/packages/calendar/dist/server.js"]
    },
    "cortland-context": {
      "command": "node",
      "args": ["/ABS/cortland/packages/context/dist/cli.js", "serve"]
    }
  }
}
```

4. Restart Cursor (or toggle the server). Green means the process started.
5. Ask: *what can you do with my mail?* First call prompts **Automation**
   (this app → Mail). Click OK.

Cursor’s own model is the brain. A local model in Cursor works the same —
Cortland does not care.

### Claude Code / Claude Desktop

The wizard does this:

```bash
npx cortland setup
```

Say yes to MCP registration. It adds `cortland-mail` and `cortland-context`
via `claude mcp add` (Code) and a backup-then-merge of
`~/Library/Application Support/Claude/claude_desktop_config.json` (Desktop).

Add reminders / notes / calendar the same way as Cursor, pointing `command`
at `node` and `args` at those `dist/server.js` files.

Desktop does **not** render MCP elicitation. Approvals fall through to the
macOS dialog, or use the folder channel if you are not at the Mac. Claude
Code currently auto-declines legacy elicitation without showing a card —
dialog/folder/iMessage remain the real gates (NOTES, 2026-07-31).

### Codex

Codex reads **TOML**, not JSON. User config is `~/.codex/config.toml`:

```toml
[mcp_servers.cortland-mail]
command = "node"
args = ["/ABS/cortland/packages/mail/dist/server.js"]

[mcp_servers.cortland-reminders]
command = "node"
args = ["/ABS/cortland/packages/reminders/dist/server.js"]
```

Or: `codex mcp add cortland-mail -- node /ABS/cortland/packages/mail/dist/server.js`

Confirm with `codex mcp list`. Wrong table name (`mcp.servers` or `mcpServers`)
is silently ignored.

### LM Studio (from a clean install)

LM Studio is a local-model app that became an MCP **host** in 0.3.17. You
download a model, then attach Cortland as tools.

<p align="center">
  <img src="images/lmstudio-mcp.svg" alt="Illustrated LM Studio steps: Program tab, Install, Edit mcp.json, paste Cortland stdio servers, load a tool-capable model." width="720">
</p>

1. Install [LM Studio](https://lmstudio.ai) (Apple Silicon build).
2. **Discover** (or search) a tool-capable instruct model. On 8 GB, stay near
   4 GB weights. Prefer something that documents function/tool calling.
3. In **Chat**, load that model. If tools are greyed out, the model cannot
   call them — pick another.
4. Right sidebar → **Program** → **Install** → **Edit mcp.json**.
5. Use the Cursor-shaped JSON from the Cursor section above (LM Studio
   follows that notation). Save. LM Studio spawns each `node` process.
6. Start a new chat. Ask it to search your mail or list reminder lists.

`mcp.json` lives at `~/.lmstudio/mcp.json`. Prefer the in-app editor.

**Gotcha:** some MCP servers were written for huge cloud windows. Cortland’s
reads are fenced and bounded, but still: keep `mail_search` limits small on
a local model (task drift on large payloads was a real Gemma 4 finding).

LM Studio also runs an OpenAI-compatible server on `http://127.0.0.1:1234`.
That is **not** how the iMessage bridge talks to a model today (the bridge
speaks Ollama’s `/api/chat`). Use LM Studio as Path A, not as Path B’s brain.

### Osaurus (from a clean install)

[Osaurus](https://osaurus.ai) is a native macOS harness: local MLX models,
a `⌘;` overlay, and MCP **in both directions**. Its Connections UI speaks
**HTTP MCP**, not stdio — it will not launch `node …/server.js` for you.

So Cortland is reached through the loopback gateway (`@cortland/remote`),
which binds `127.0.0.1` only and currently mounts **mail** and **context**.

<p align="center">
  <img src="images/osaurus-mcp.svg" alt="Illustrated Osaurus steps: Management window, Tools, Connections, add http://127.0.0.1:7811/mcp/mail with a bearer token." width="720">
</p>

1. Install Osaurus (Apple Silicon, macOS 15.5+). Finish its onboarding —
   it will pick a local model that fits the Mac.
2. In a terminal, from the Cortland clone:

```bash
npx cortland-remote token mint --label osaurus
npx cortland-remote serve
```

   The token is shown **once**. Copy it. Only a hash is stored on disk.

3. In Osaurus: **⌘⇧M** (Management) → **Tools** → **Connections** →
   **Add Provider** → custom server (not the catalog).
4. URL: `http://127.0.0.1:7811/mcp/mail`  
   Header: `Authorization: Bearer <the token>`.
5. Optional second provider: `http://127.0.0.1:7811/mcp/context`.
6. Reminders / notes / calendar: add those as **stdio** in Cursor or LM
   Studio, or wait until the gateway grows those mounts.

Osaurus also exposes an Ollama-compatible local server (default port
**1337**). That is a Path B experiment: point the iMessage bridge’s
`imessage.model.host` at `http://127.0.0.1:1337` and set `model` to
whatever Osaurus has loaded. Field-tested brain remains Ollama on 11434.

---

## Path B — text it; Ollama is the brain

This is the README demo. It is also the only path that needs a **second
Apple ID**.

<p align="center">
  <img src="images/second-apple-id.svg" alt="Illustrated split: system Apple ID stays you; Messages.app signs into a throwaway assistant Apple ID that owns no data." width="720">
</p>

### B.1 Second Apple ID (mouthpiece)

1. In a browser, create a **new** Apple ID (any unused email). Strong
   password, turn on 2FA.
2. On the Mac: **Messages → Settings → iMessage** → sign **out** of your
   personal ID in Messages if it is the only slot, then sign **in** with
   the new ID.
3. Leave **System Settings → Apple ID** as you. Do not sign the assistant
   into iCloud on this Mac. It must not grow a copy of your photos, mail,
   or keychain.
4. On your phone, that new ID is just a contact. Text it like a person.

If someone hijacks the assistant ID they can read the thread and pretend
to be Cortland. They **cannot** issue commands or approvals — those are
pinned to *your* handle in `chat.db`.

Full narrative: [SETUP.md §5.1](../SETUP.md#51-create-the-assistants-apple-id).

### B.2 Ollama, from zero

You do not need to know what a “runtime” is. Three commands.

<p align="center">
  <img src="images/ollama-setup.svg" alt="Illustrated terminal: brew install ollama, start the service, pull gemma4:e2b-it-qat, curl the local API." width="720">
</p>

If you do not have Homebrew: [brew.sh](https://brew.sh), then:

```bash
brew install ollama
brew services start ollama          # survives reboot
ollama pull gemma4:e2b-it-qat       # 4.3 GB; 8 GB Mac default
```

Check it:

```bash
curl -s http://127.0.0.1:11434/api/tags
```

You want a JSON list that includes `gemma4:e2b-it-qat`. If `curl` hangs,
Ollama is not running (`brew services start ollama` or `ollama serve`).

| Model | Size | 8 GB Mac |
|---|---|---|
| `gemma4:e2b-it-qat` | 4.3 GB | **Use this.** Clean native tool calls. |
| `gemma4:e4b-it-qat` | 6.1 GB | Tight; fine on 16 GB. |
| `gemma4:e4b` | 9.6 GB | Swap thrash — skip. |
| `llama3.2:3b` | 2.0 GB | Fast, flaky tools with many schemas. |
| `gemma3:4b` | 3.3 GB | **No tools in Ollama.** Briefings only. |

RAM is the constraint, not the model card.

### B.3 Permissions the bridge actually needs

- **Full Disk Access** for the process that reads `~/Library/Messages/chat.db`
  (your terminal, or the `node` binary if launchd). Restart after granting.
- **Automation → Messages** (sending). First send will prompt.

```bash
node -e 'require("fs").accessSync(process.env.HOME+"/Library/Messages/chat.db"); console.log("readable")'
```

### B.4 Discover handles and run

From the clone:

```bash
npx cortland-imessage setup --discover \
  --model gemma4:e2b-it-qat \
  --name "Your Name" \
  --about "Central timezone. Prefer brief answers."
```

It waits up to three minutes. **Text the assistant Apple ID from your
phone.** Setup reads both handles out of that one row — the only
unfiltered look at `chat.db` — then allowlists *you*.

```bash
npx cortland-imessage status     # every line green
npx cortland-imessage run        # foreground; Ctrl-C stops
# later:
npx cortland-imessage install    # launchd: whenever the Mac is on
```

Writes stay dry-run until you set `"live": true` in
`~/Library/Application Support/cortland/config.json`. Even then, every
consequential action texts you `yes <code>` and waits.

Optional: if Ollama is not on 11434, set `imessage.model.host` in that
config (Osaurus’s 1337 is the experimental alternative).

---

## What “it worked” looks like

**Path A.** In Cursor / LM Studio / Claude: *Anything from school this
week?* You should see a tool call (`mail_search` or `context_changes`),
then a fenced summary. A gated write pops a dialog (or a file in
`Agents/Approvals`). If the model *describes* a search but never calls a
tool, it cannot see the servers — check MCP status / `mcp.json`.

**Path B.** You text *remind me to call the vet tomorrow 2pm*. You get
“Received — working on it…” within seconds, then a short confirmation
that names the reminder, the list, and the time. Delete asks you to
reply `yes a3f9c1`.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Tools never appear | Client JSON/TOML path is wrong; `npm run build` not run; using `npx @cortland/mail` while unpublished |
| Automation prompt never came | First call hasn’t happened, or you dismissed it. System Settings → Privacy & Security → Automation |
| Full-text mail search empty | Spotlight without Full Disk Access **silently returns 0**. The tool must refuse, not look empty — if you see empty, FDA is missing |
| LM Studio chats but never calls tools | Model has no tool template, or Program/MCP servers failed to spawn (open LM Studio logs) |
| Osaurus cannot add `node …/server.js` | Expected. Use `cortland-remote` HTTP, not stdio |
| Bridge silent | `npx cortland-imessage status`. Usually ollama down, model not pulled, or owner handle not E.164 |
| Dates land in 1904 | Old build; the system prompt must state today’s date |
| Gated action vanished, no prompt | Fail-closed. Read `audit.db` — `denied \| timeout` means nobody answered |

```bash
sqlite3 ~/Library/Application\ Support/cortland/audit.db \
  'SELECT ts,tool,outcome,approval_method FROM audit ORDER BY ts DESC LIMIT 10'
```

---

## What this is not

- Cortland does not download weights for you (except the Ollama `pull` you
  run).
- Cortland does not send your mail to a cloud model unless **you** chose
  a cloud MCP client. A local client + local model never has to leave.
- The iMessage assistant account is not a second “Siri user.” It cannot
  open Mail. The Mac opens Mail as you.
