# 07 — Threat Model & Security Review Guide

**For an external reviewer (human or agent).** This maps where the sharp edges
are so a review spends its time on what matters. **It is a starting map, not a
scope limit** — the most dangerous bug is the one this document doesn't mention,
because its author didn't think of it. Treat every "handled" claim below as a
hypothesis to falsify, and look hardest where the map is silent.

## What this software is, in security terms

Node processes running on the user's own Mac with **Full Disk Access** and
**Automation** rights, driving Apple apps via osascript, exposing MCP tools to
an AI model. No App Store review, no OS sandbox around the node code. The code
IS the trust boundary. The design intent: even a fully prompt-injected model,
or a stolen remote token, cannot cause an unapproved consequential action.

## Trust boundaries (where untrusted meets trusted)

1. **Model ↔ tools.** The model is assumed hostile-when-injected. Its only
   power should be to *propose*; consequential actions must pass the gate.
2. **Content ↔ model.** Mail/message/file bodies are attacker-controllable.
   They enter model context and must be fenced as data.
3. **Remote client ↔ gateway.** A bearer token holder is authenticated but
   not trusted beyond its scope; a network peer is not trusted at all.
4. **iMessage sender ↔ bridge.** Only the owner handle is trusted; the owner's
   *forwarded content* is not (it may carry injection).
5. **Config/secrets ↔ disk.** Tokens, topics, keychain.

## The crown jewel: the approval gate (`packages/governed/src/execute.ts`)

Everything rests here. Review questions:
- Can any path reach `def.handler(...)` for a `write-gated`/`destructive` tool
  without a `true` from the approval channel? Trace every branch.
- `getConfig()` resolves live mode; every error path must yield `{live:false}`
  (`config.ts`). Verify no exception escapes to a default-open.
- Every approval channel must fail closed: dialog (cancel/timeout/throw),
  folder (missing/ambiguous/deleted), elicit (decline/incapable client),
  ntfy-reply (timeout/wrong-nonce/unsendable), misconfigured (deny). Confirm
  no channel returns `approved:true` on any error or ambiguity.
- `planUndo` for `undo:"native"` must run and produce a recipe BEFORE the
  write, or the write is refused. Verify it can't be skipped.

## Highest-risk surfaces, ranked

### 1. osascript / JXA injection (every tool package)
Every tool builds a JS script string run by osascript. The invariant: **user
values enter ONLY via `JSON.stringify`**, tested per package. Review beyond the
tests:
- **`U+2028`/`U+2029`.** `JSON.stringify` does NOT escape these; historically
  they are line terminators that break a JS string literal. Node's own parser
  accepts them (ES2019), but **does JavaScriptCore/JXA under osascript?** If
  not, a message body containing U+2028 could break out of the string literal.
  **This is an unverified open question — fuzz it.** If exploitable, escape
  them explicitly in a shared sanitizer.
- Backtick/`${}` — we build with template literals in TS but emit plain JS;
  confirm no user value lands in an emitted template-literal context.
- `runJxa` argument passing (`packages/governed/src/osascript.ts`): is the
  script passed via `-e`/stdin safely, or could argv contain a value?

### 2. The remote gateway (`packages/remote/`) — the only network-exposed part
- **Bind address:** must be `127.0.0.1` only, with no config path to widen it.
  Grep for any `0.0.0.0`/`::` or host-from-config. Public reach must require an
  external tunnel, never a flag.
- **Token verification** (`tokens.ts`): constant-time compare, hash-only at
  rest — confirm no early-return leaks timing, no plaintext persisted.
- **Scope before gate:** a `read` token calling a gated tool must be refused
  and audited *before* execution. Verify the withheld-tool wrapper can't be
  bypassed by a raw JSON-RPC `tools/call`.
- **Session↔token binding:** can session A's id be reused with token B?
- **Origin refusal / DNS-rebinding:** confirm the Origin-header rejection can't
  be spoofed away; consider a malicious localhost web page POSTing here.

### 3. The iMessage bridge (`packages/imessage/`) — parses attacker-adjacent data
- **`decodeAttributedBody`** reads untrusted binary from chat.db. Bounds:
  every offset/length is checked, but **fuzz it** — crafted blobs, truncated
  lengths, huge lengths, overlapping markers. A read past the buffer or a hang
  is the risk.
- **Allowlist** (`chatdb.ts`): handle comparison is lowercased-exact. Can a
  lookalike handle (unicode, `+1` vs no-country-code, email-vs-number for the
  same person) slip past or falsely match? Is the SQL `is_from_me=0` filter
  sufficient to exclude our own sends?
- **Nonce matching** (`approval.ts`): the reply regex is
  `^\s*yes\s+<nonce>\s*$`. Can a forwarded message accidentally or
  deliberately match? Nonce is 6 hex = 24 bits — adequate for a
  human-timescale single-use window, but confirm single-use (dead after first
  match / deadline) and that it never appears in model context.
- **Rate cap** (`send.ts`): law 4. Is the token bucket bypassable? Does it
  actually prevent the ban-triggering burst pattern?

### 4. Prompt injection & the fence (`packages/governed/src/fence.ts`)
- Nonce-delimited fence: can content close its own fence? The per-call nonce is
  the defense — confirm it's unpredictable and that content can't inject a
  matching `end` marker (it can't know the nonce, but verify the nonce is
  generated fresh per call and never leaked upstream).
- Do ALL read tools fence by default? Doctrine tests assert it per package —
  confirm no gap.

### 5. Secrets & egress
- **argv hygiene** (`hygiene.ts`): refuses credential-shaped argv. Bypassable?
- **No secret at rest** except hashes (tokens) — grep for any plaintext token,
  password, or topic written unhashed where it shouldn't be. (The ntfy topic
  IS a capability secret in `config.json` by necessity — is that acceptable,
  and is it kept out of audit rows? It should be host-only.)
- **Egress inventory:** every outbound network call must be declared+audited —
  model providers (`context/model.ts`), notify (`notify.ts`), any other
  `fetch`/`http`. Grep for undeclared egress.

### 6. Audit integrity (`packages/governed/src/audit.ts`)
- Local SQLite; an attacker with FS access can rewrite it — accepted (they own
  the machine). But within the process: can a tool suppress its own row, or
  can an exception skip the record? Every path (ok/error/dry-run/denied/
  refused) should write exactly one row.

## Known accepted risks (not bugs — design choices)
- The folder approval channel's guarantee is only as strong as write-access to
  the folder (documented in the governed README).
- The iMessage second account, if hijacked, lets a thief read what the
  assistant sends and impersonate it socially — but not command the bridge or
  approve actions (docs/06).
- A machine-owner-level attacker (root/FS) is out of scope; they own the Mac.

## Suggested review method
1. Adversarial read of `execute.ts` + all approval channels — try to find one
   path to an unapproved live handler call.
2. Fuzz `decodeAttributedBody` and the JXA builders (esp. U+2028/U+2029).
3. Grep sweep: bind addresses, `fetch(`, plaintext secrets, `child_process`.
4. Re-run the suite under an adversarial lens: do the tests assert
   *fail-closed*, or merely *happy-path*? Add the missing negative tests.
