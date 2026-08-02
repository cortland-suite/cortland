# NOTES — open questions & decisions log

Noodle pad. Record decisions with dates; move settled items to the bottom.

## OPEN QUESTIONS

### Naming
SETTLED 2026-07-30: **Honeycrisp** — see DECISIONS.

### Framework contract (docs/01)
(all settled as of 2026-07-29 — see DECISIONS. Contract is locked; code has begun.)

### Framework v2 — the async approval queue
17a. v1.5 BUILT 2026-07-30 (overnight session): the **folder approval channel** —
    each gated action writes a `pending-*.md` checkbox file into a configured
    folder (default: iCloud `Agents/Approvals`, so it reaches every device);
    checking APPROVE in the Files app approves, everything else — DENY box,
    timeout, deletion, both boxes, unparseable mark — denies. Channel selection
    lives in config.json (`approval.channel: "dialog" | "folder"`), re-read per
    action so it can change without a restart; an unknown channel name denies
    outright rather than guessing. 18 tests prove every path fails closed, incl.
    end-to-end through the gate. Threat model documented in the README: the
    guarantee is only as strong as write access to the folder — keep it outside
    the agent's write scope. Setup wizard offers the channel as a step. The full
    v2 (menubar UI + push, true async execution) remains open; this is the
    bridge that works today.
17d. **v2 BUILT 2026-07-31: the elicitation channel.** User verdict after the
    file-move test: "we need easier functionality" — correct. Approvals now
    ride MCP elicitation when the client supports it: the server sends
    elicitation/create, the CLIENT's own UI poses a native Approve/Deny card
    (out-of-band from the model — the model never sees the prompt and cannot
    answer it), and the result returns over the protocol. Config: the
    unconfigured default is now the "auto" ladder (elicit if the client
    declares the capability, else dialog); explicit `"elicit"` honors a
    declared fallback ("dialog" | "none"=deny); "dialog"/"folder" unchanged.
    Approved requires accept AND confirm=true — decline, cancel, confirm
    false, timeout, incapable client all deny. 7 tests run the REAL protocol
    end-to-end over InMemoryTransport (client-side handler answers, gate
    executes/refuses accordingly; dry-run never prompts at all). The folder
    channel remains the no-capable-client, no-Mac-in-reach fallback; the user's
    config keeps "folder" until they opt into auto/elicit. Still open: which
    clients elicit TODAY (verify Claude Code, Desktop, mobile remote as they
    ship it); push notification for folder-channel discovery. Live mode on
    (human-confirmed in chat), gated mail_mark requested through the folder
    channel, pending file synced to the user's iPhone, user moved it into
    `Approve/` in the Files app — action executed 128 s after request, flag
    verified in Mail by an independent read, audit row: outcome ok, method
    folder, dryRun false. Same call dry-ran correctly minutes earlier with
    live off, and live was switched back off after the test. The remote gap
    the dialog channel opened (17) is CLOSED for the move-to-decide flow.
    Note for the permission story: the session's own permission layer blocked
    the agent from flipping live mode via shell — the human confirmed in chat
    and the flip was made openly. Defense in depth behaving as designed.
17b. Field notes from the FIRST REAL PHONE TEST, 2026-07-31 (user on iPhone,
    remote-controlling the session):
    (1) **Stock iOS has no plain-text editor.** Tapping the .md briefing tried
        to open NUMBERS (iWork claims text-ish types). Checkbox editing on a
        phone requires a third-party app — dead on arrival as the primary UX.
        FIX SHIPPED same morning: **move-to-decide.** The approvals folder now
        carries `Approve/` and `Deny/` drop targets; long-press → Move in the
        Files app decides, no editor involved. Checkbox editing stays as the
        power-user alternative. Conflicting signals (moved to Approve, DENY
        checked) deny. 21 channel tests.
    (2) **iCloud files are download-on-demand on iPhone** — folders looked
        stale until manually refreshed, files needed a tap to fetch. Sync
        latency is Apple's, not ours; documented ("pull to refresh") in the
        folder README, and it sharpens the case for v2's push notification
        (Q19's ntfy idea covers this cheaply before any UI exists).
    (3) User floated a **companion iOS app**. Parked deliberately: the $99/yr
        dev account + App Store review is heavy for v1.5; the cheap ladder is
        move-to-decide (shipped) → push notification on pending approvals
        (ntfy, Q19) → Shortcuts/App Intents integration → only then a real
        app, and by then the v2 queue's store exists for it to talk to.
17. Field note, 2026-07-30: first live test of the dialog gate surfaced its structural
    limit — the human must be AT the Mac. A user driving a session remotely (phone via
    remote control, SSH, cloud handoff) can never see or click the dialog; every
    action denies by timeout. Fail-closed held perfectly (no unapproved writes, all
    audited), but remote use is a real workflow TODAY, not an edge case. This is the
    concrete case for the v2 async queue: approvals that wait in a store, surfaced via
    menubar UI + push notification, approvable from any device. Second field note:
    dialogs presented from background/agent contexts can silently fail to reach the
    screen (fixed by presenting via Finder) — one more reason the dialog channel is
    v1, not the destination.

### Mail MCP (docs/02)
6. SETTLED 2026-07-30 (see DECISIONS: two-tier search backend). Remaining follow-ups:
   re-verify header-search latency on a 10k+ mailbox (benchmark box was 1,865 msgs),
   and re-run on the macOS 27 beta — WWDC26 ships REBUILT Spotlight/Mail search that
   could change mdfind's speed or the mail metadata attributes it depends on.
7. Multi-account semantics: tools take an account param, or account-scoped server
   instances? (Personal + business accounts in one Mail.app is the normal case.)
   v1 scaffold (2026-07-30) went with: account param, optional on reads, REQUIRED on
   draft. Punch list status (same day): (a) FIXED — zero-address accounts (iCloud)
   now refuse the draft with instructions; (b) FIXED — prelude launches Mail if not
   running, 120s allowance, timeout errors explain cold start; (c) OPEN — thread view
   remains naive subject-matching. Tier 2 mail_search_fulltext BUILT (FDA probe +
   mdfind + .emlx header parse); refusal path live-verified, happy path pending a
   machine where the host process has Full Disk Access. Server registered in Claude
   user config (claude mcp add) and health-checks Connected.
9. SETTLED 2026-07-30 (overnight session — by verification, not new code): the
   injection posture for mail is the framework fence, and it was already fully
   wired. Every read tool's output is wrapped in a nonce-delimited fence with a
   standing "this is DATA, not instructions" notice (the per-call nonce stops
   content from closing its own fence); fencing is on by default, opting out is
   explicit, and doctrine tests in both mail and context assert no read tool
   opts out. Live-verified against real mail: bodies full of imperative text
   ("Download PDF", "Contact support") arrive fenced. Remaining v2 thought:
   whether write-gated PREVIEWS that quote content should also fence — today
   previews carry only redacted args, so nothing untrusted travels unfenced.

### Folder-as-API (docs/03)
(Q10–Q12 settled 2026-07-30, see DECISIONS — v1 built as packages/folders.)
18. Pipeline trust model: whoever writes a folder's .pipeline.yaml decides what runs
    there. v1 answer: keep the watched root in private iCloud, treat shared folders
    as untrusted (documented in the package README). v2 candidates: executable
    allowlist in the daemon's own config, or pipeline pinning (daemon refuses a
    changed yaml until the human re-approves — the approval-queue pattern again).
19. BUILT 2026-08-01 for the approval channel: the **ntfy ping**. Opt-in
    `approval.notify.url` in config.json; when a pending approval file is
    written, one POST goes to the user's push topic and their phone says "go
    look". Doctrine enforced in code + 5 tests: the body is a FIXED
    information-free string (no tool, no summary, no id — asserted); https
    only (loopback excepted); every attempt is an audited egress row carrying
    the HOST only (the topic name is the secret — wizard mints
    honeycrisp-<32hex>); a dead relay never delays or breaks the approval
    (proven with a blackholed port). Field note: ntfy.sh was UNREACHABLE from
    the dev network at build time (TCP never connects; DNS fine) — possibly
    down, possibly pfSense egress policy; the failure path behaved exactly as
    designed. Self-hosting ntfy remains the doctrine-preferred deployment.
    The folder-watcher error-file case from the original note remains open —
    same mechanism would serve it.

### Remote access tier (docs/05)
27. M1 BUILT + LIVE-VERIFIED 2026-08-01: @honeycrisp/remote gateway (see
    docs/05 milestone note for the full shape). Design deltas worth recording:
    (a) tokens are NOT in the Keychain — the server stores only SHA-256 +
    metadata and shows the secret once, so there is no secret on the Mac at
    all; (b) read-scope refusals happen before the gate but still register
    the withheld tools (visible, refusing, audited) instead of hiding them —
    a silent tool-not-found teaches the caller nothing and records nothing;
    (c) requests with an Origin header are refused outright instead of
    allowlisting hosts — no browser has business here and there's nothing to
    misconfigure; (d) audit gained a `principal` column (migration included)
    so remote rows answer WHO asked. Wizard step deferred. Next: M2 (OAuth +
    public rung + claude.ai connector test) — see Q24/Q25.
24. OPEN 2026-07-31: OAuth shape for the public rung — in-process MCP auth spec
    vs fronting a maintained authorization-server library. Survey before code;
    hand-rolled OAuth is how products end up on incident blogs.
25. OPEN 2026-07-31: long-blocking gated calls over streamable HTTP — does
    session resumption survive vendor-side timeouts while a human deliberates,
    or must remote approvals go async at the protocol edge? Possibly the
    forcing function for the full Q17 v2 queue.
26. LIVE-TESTED 2026-07-31 for Claude Code, verdict AUTO-DECLINE: two gated
    mail_mark attempts produced `denied | elicit | decline` with NO card shown
    (user confirmed) — Claude Code declares the elicitation capability but
    auto-declines legacy elicitation/create without rendering. Root-cause
    hypothesis: Claude Code's elicitation rides the 2026-07-28 MRTR pattern;
    SDK 1.30.0 (latest, published one day pre-spec) still speaks the old form.
    CONSEQUENCES SHIPPED same day: (a) unconfigured default reverted to
    "dialog" — a declared-but-unrendered capability would make the auto
    default silently unusable; auto stays as explicit opt-in; (b) WATCH the
    TS SDK for MRTR support, then re-verify and reconsider the default.
    Note the failure was still fail-closed: two denials, two audit rows, zero
    unapproved writes. Original research matrix:
    **Claude Code CLI: YES** since 2.1.76 (terminal form UI, form+URL modes).
    **Claude Desktop: NO** (feature request closed as not planned).
    **claude.ai web/mobile connectors: NO** (request open) — so the remote
    tier's approval story stays folder channel + push until vendors ship it;
    the auto ladder degrades correctly everywhere (Desktop → dialog).
    ChatGPT/Gemini still untested. WATCH: MCP spec 2026-07-28 redesigns
    elicitation as stateless MRTR (per-request _meta capabilities, servers
    must not elicit without the declared capability — our channel already
    checks, but the mechanism changes); migration rides a future SDK upgrade.
    M0 of docs/05 BUILT same day: 4 tests prove the gate behaves identically
    over streamable HTTP (loopback) and stdio.
    Context for all three: field verdict 2026-07-31 — users will come from
    Claude/ChatGPT/Gemini phone apps, desktop apps, and web, not remote-control
    sessions. Desktop is already served (stdio + elicitation). Phone/web needs
    the remote tier: docs/05 drafted same day (exposure ladder 0→3, @honeycrisp/
    remote gateway, bearer→OAuth, stolen-token-still-can't-send-mail property).

### Local models (the Siri-class experiment)
28. FIELD TEST 2026-08-01: full local stack on the 8 GB M2 (Ollama 0.32,
    Gemma 3 4B, Llama 3.2 3B) — the deliberate simulation of "what if the
    driving model were Siri-class and on-device?" Findings:
    (1) **Gemma 3 has no tool template in Ollama** — cannot drive tools
        natively. It slots into the context layer's ollama provider fine:
        briefing ran end-to-end with `Layer 1: ollama:gemma3:4b,
        egress=local` in the provenance and network:false in the audit row.
        Fully-local briefings: WORKING (extraction quality untested — the
        candidate window was empty).
    (2) **A 3B model CAN drive the governed tools over the M1 gateway — with
        a host-side adapter.** Raw, it picks wrong tools, sends empty-string
        optionals and quoted numbers, and gives up or "retries" in prose.
        With a ~10-line arg-normalization shim (drop empty optionals, coerce
        numeric strings) + arg-hygiene system prompt, it searched real mail,
        summarized a receipt email dense with imperative text as DATA (no action
        attempts; single probe, not a red-team), and — the good ending — hit
        the read-scope refusal on mail_mark, reported it honestly, and
        stopped. Ledger attributed every attempt including the denial.
    (3) Architectural conclusion: the harness carries the safety, the shim
        is the bridge. Strict validation stays in the governed layer;
        forgiveness lives in the host adapter. That adapter IS the design
        sketch for the Apple Foundation Models bridge (Q21) — AFM speaks
        structured tool calling, so "swap in Apple's model" is the same shim
        pointed at a different runtime.
    Follow-ups: boolean coercion in the shim; a real red-team of the fence
    with small models; promote the harness from scratchpad to an example
    package (`examples/local-agent`) once it stabilizes.
    CODA, same day: **Gemma 4 exists** (April 2026, post-knowledge-cutoff;
    the earlier "no Gemma 4" was a wrong registry tag — sizes are E2B/E4B/
    12B/26B-A4B/31B, not "4b"). gemma4:e4b (9.6 GB, runs on the 8 GB M2,
    ~30 s cold load) **speaks tools natively and cleanly** — no empty-string
    args, no type junk, shim unnecessary; understood and honestly relayed
    BOTH refusal types (FDA-gated fulltext, read-scope mail_mark) on the
    first attempt. Its failure mode is task drift on large payloads (wandered
    off a 6 KB result set; fixed by small limits + explicit steer). Verdict
    upgrade: with Gemma 4-class on-device models, the host adapter shrinks
    from "arg normalizer" to "payload budgeter" — the Siri-class thesis got
    stronger. Briefing provider switched to gemma4:e4b.

### Context layer (docs/04)
(Q13–Q15 settled 2026-07-30 in the design session — docs/04 is now the full design.
M1 BUILT same day: packages/context — store with
no-body-column enforced by test, incremental Mail capture with cursors, three serve
tools registered in Claude user config. First real capture: 90-day backfill in 2.1s.
M2 BUILT 2026-07-30: calendar capture (allowlisted, daily cadence — the sweep costs
~30s/calendar so the 15-min schedule skips it unless >20h stale), events+attendees
tables, meeting↔thread correlation, deterministic briefing (context_brief tool +
`brief [dir]` CLI + 7am launchd template), capture+brief schedules added to the
setup wizard.
M3+M4 BUILT same day: swappable ModelProvider (see Q21) with per-run egress
audit rows; standing-questions.yaml parsed from the Briefings folder, answered
Layer-0 (FTS/people candidates) + optional Layer-1 (model over FENCED headers,
citations required); commitment extraction from transiently-fetched sent bodies
(pointers-not-copies holds — bodies discarded, only commitment text + pointer
stored, model-invented pointers REJECTED — the guard caught a bad pointer in
live testing); corrections flywheel: briefing items carry stable ids, checked
boxes and "## Corrections" notes become judgments (idempotent per file), mutes
filter senders/subjects/items at serve time, AI rows immutable. All four
milestones live-verified end to end. Serve tool context_brief stays
deterministic — a read tool must not quietly spend model calls.)
20. SETTLED 2026-07-30 by spike: EventKit-via-JXA is DEAD for daemon use — TCC
    auto-denies calendar access for processes without a bundled usage-description
    (the completion block never fires; 60s of silence). Calendar.app Automation
    works but costs ~30s PER CALENDAR regardless of query shape (whose and bulk
    both; 3.4 min across 17 calendars). Decision: calendar capture is a slow,
    LOW-CADENCE sweep — daily via launchd, calendar ALLOWLIST in config (most of
    the 17 are subscribed noise). Future upgrade path: Calendar's sqlite cache
    behind FDA, the mdfind pattern again. (Third data point for the pattern:
    Apple's index is fast but permission-gated; Apple's scripting is slow but
    universally permitted. Two-tier everything.)
21. SETTLED 2026-07-30 (interface level): ModelProvider is a two-method contract
    with a mandatory egress declaration; shipped providers: ollama (local),
    command (any argv reading stdin→stdout; network defaults TRUE — egress is
    assumed unless declared otherwise), none (default — nothing is guessed).
    Config in context.json. Providers degrade gracefully: a failing model falls
    back to deterministic candidates, never crashes a briefing. STILL OPEN: the
    Apple Foundation Models bridge (most on-thesis runtime) — revisit when the
    macOS 26/27 API surface allows unbundled access. Note: neither Ollama nor a
    logged-in claude CLI existed on the dev machine — full pipeline was
    integration-tested against a real-subprocess stub provider.
22. Briefing correction syntax: programmatic round-trip PROVEN (checkbox → judgment
    → item muted from regenerated briefing, AI row untouched). Still open: verify
    the checkbox edit survives real iOS Files/Notes editing from a phone.
    STAGED 2026-07-30 (overnight session): a real briefing with tickable sender/
    subject boxes sits in iCloud `Agents/Briefings/2026-07-31.md`, instructions
    in `Agents/PHONE-TEST.md`. Also relevant: the folder approval channel (17a)
    doubles as a second, sharper checkbox-survival test. Side product of the
    staging: briefings now have a quiet-day fallback — when the last 24 h is
    silent the window widens to 7 days, labeled honestly, so the flywheel
    always has something to grab (2 tests).
23. SETTLED 2026-07-30 (overnight session): retention defaults. Messages, events,
    and extracted commitments older than `retentionDays` (default 365, `0` = keep
    forever, config in context.json) are pruned at capture time in one
    transaction; every prune writes an audit row with counts. People aggregates
    and judgments are NEVER pruned at any age — people stay useful past their
    messages, and deleting a human's recorded judgment is not the machine's
    call. Dangling pointers remain a capture-time concern as before. 6 tests;
    live-verified in a real capture run.

## DIRECTION (settled 2026-08-01, evening session)

- **Identity: the AI layer for the Apple apps Siri forgot — bring your own
  model, local models first-class.** Coverage beats plumbing: next builds are
  app packages (Reminders, Calendar writes, Notes), then the iMessage bridge
  (docs/06). Approval-channel iteration is FROZEN at dialog/folder/elicit/
  ping until reply-to-approve over iMessage supersedes them.
- **The iMessage bridge is the killer interface**: a second iCloud account
  signs into Messages.app ONLY — it is a mouthpiece, not a worker; the Mac
  does everything as the user's own account. Bridge = chat.db watcher (FDA)
  + AppleScript send + agent loop (local model per the Q28 harness) +
  APPROVALS BY REPLY: the framework (never the model) reads the reply from
  chat.db, verifies allowlisted sender handle + single-use nonce. Send-to-
  owner is write-safe (talking TO the human is always allowed); messaging
  anyone else is gated. All inbound content fenced; only the owner's handle
  is ever instructions.
- **Vs OpenClaw** (the obvious comparison, 247k stars): it reached the same
  interface first and validated demand — with a high-severity CVE (Jan
  2026), rampant prompt injection in the wild, malicious-skill supply chain,
  and permission gates still on its roadmap. Honeycrisp's pitch in one line:
  what OpenClaw promises to bolt on someday is what this suite was born as.

## DISCOVERABILITY (how people find this)

- 2026-08-01 — **Listed in the official MCP Registry**: io.github.
  honeycrisp-suite/mail and /context, verified against the npm packages via
  their mcpName fields. Publishing gotchas for next time, hard-won: (a)
  server.json descriptions max 100 chars; (b) `mcp-publisher login github`
  (device flow) CANNOT grant org namespaces — known bug since registry
  v1.8.0 (issue #1468): the GitHub App token can't read org roles. The
  working path is `login github --token <PAT with read:org>`; org membership
  must be public and role must be Owner. Four device codes died teaching us
  this; (c) the org-namespace grant is computed at login, so every
  permission change needs a fresh login. Also live: GitHub topics on the
  repo (mcp, apple-mail, ai-agents, local-first…), npm keywords on all six
  packages, README leads with the npm install path. Still open: community
  directory submissions (PulseMCP, mcp.so, awesome-mcp-servers PR) — most
  aggregators crawl the official registry, so those should partly
  self-populate; check in a week. Claude's curated connector directory
  stays out of reach until M2's public rung.

## WATCH ITEMS (landscape)

- 2026-07-29 — **WWDC26 Siri AI overlaps the context layer's territory.** Apple
  announced "personal context understanding across Messages, emails, photos,
  and apps" (macOS/iOS 27); fine print: beta "later in 2026," English-only at
  launch, regional limits, daily usage limits with more via iCloud+, Siri
  history synced through iCloud. Relevant differences to keep true here:
  local-first, user's own model endpoint, no meter, context store on the
  user's own disk, inspectable governance. (Source: apple.com/newsroom,
  2026-06.)
- 2026-07-29 — **App Intents in the macOS 27 SDK.** Siri's "systemwide app actions"
  presumably ride on App Intents; the newsroom page gave no developer detail. Check
  WWDC26 session docs / SDK diffs. Cuts two ways: (a) our tools could ship App Intents
  ALONGSIDE MCP — same governed handler, two front doors (Siri users and MCP clients);
  (b) App Intents might offer cleaner primitives than AppleScript for some Mail
  actions. No decision needed yet — just watch.

## DECISIONS

- 2026-08-01 — **PUBLISHED.** All five packages public on npm under
  @honeycrisp (governed 0.1.0+0.1.1; mail/folders/context/setup 0.1.0), repo
  public at github.com/honeycrisp-suite/honeycrisp, org profile README up.
  Cold `npx @honeycrisp/setup` verified working from the registry. Publishing
  lessons for next time: (a) npm quarantines new packages for a while before
  they're publicly visible — a 404 right after publish is NORMAL, wait before
  re-diagnosing; (b) a published version number is burned forever, even while
  invisible (hence governed's 0.1.1); (c) the registry exposes the publishing
  ACCOUNT's email in maintainer metadata — set a non-personal address (iCloud
  Hide My Email alias) and VERIFY it before publishing, because GitHub-noreply
  addresses can't receive npm's verification mail; (d) npm 2FA auth-and-writes
  means each publish needs the human in the browser — the publish commands
  belong in the user's terminal, not the agent's shell.
- 2026-07-31 — **Trademark knockout search DONE (USPTO, live via tmsearch).
  No software conflict found; publish gate cleared from our side.** Exact
  wordmark "honeycrisp": 13 US filings, every one in apples/apple trees (31),
  cider/alcohol (33), one dead perfume (3/4), one dead marketing mark (35) —
  ZERO in classes 9/42 (software), and the bare word itself is dead twice
  (U Minnesota 1991, Rainier 2013 — the failed-to-trademark story holds).
  Fuzzy "honey crisp": 7k+ loose matches, top relevance all food/beverage,
  nothing software. One common-law datapoint to know about: **Honeycrisp
  Technologies, Inc.**, an active consumer app developer (nutrition apps,
  iOS/Android, since ~2019) with NO federal filing in the search — different
  goods (consumer health apps vs developer tooling), different branding
  (their product is "Aspire"), coexistence is the norm at this distance, but
  it's the one name to remember if expansion ever heads toward consumer
  apps. honeycrisp.com is held by a marketing firm — irrelevant to scoped
  npm. Caveats recorded honestly: knockout search by a non-lawyer, US only
  (EUIPO unchecked), and common-law scan limited to the obvious surfaces.
  Remaining publish steps are purely mechanical: npm login, GitHub remote +
  repository fields, publish --access public.
- 2026-07-30 — **@honeycrisp npm org CLAIMED** (free plan, unlimited public
  packages). The scope is ours; nobody else can publish under @honeycrisp/*.
  Publishing itself still waits on the trademark search below and CLI login
  (`npm login`) on the dev machine.
- 2026-07-30 (overnight session) — **npm packaging prepped, publish-ready
  minus the gates.** All five packages: publishConfig access=public (scoped
  packages fail to publish without it), engines node>=20, keywords, per-package
  LICENSE, prepublishOnly build+test guard, launchd templates shipped in files
  for folders/context, intra-suite deps pinned ^0.1.0, setup README written.
  `npm pack --dry-run` verified on all five. Also fixed the known
  monorepo-layout landmine: setup's suitePaths now resolves sibling packages
  through the module resolver (works in both workspace and npm-installed
  trees), not repo geometry. Remaining before `npm publish`: (a) trademark
  search, (b) `npm login`, (c) add `repository` fields once the GitHub repo
  exists — no remote yet, refused to guess a URL, (d) decide the published
  install story for setup's MCP registration (absolute node paths are right
  for the monorepo; a published setup should probably register `npx -y
  @honeycrisp/mail` style commands instead).
- 2026-07-30 — **The name is Honeycrisp.** An actual common apple variety —
  tangentially Apple, legally not. Bare npm name is squatted, so packages ship
  scoped: @honeycrisp/governed, /mail, /folders, /context, /setup (zero packages
  existed under the scope at decision time). The word reads as two software
  virtues (sweet to use, crisp to run) and is effectively generic for the fruit
  (U. Minnesota famously failed to trademark it — hence SweeTango et al.);
  software is a different class regardless. Do a proper trademark search before
  npm publish. Kill list from the search, so nobody relitigates: apple-mcp
  (3.1k-star archived repo), Macintosh/Pippin/Newton/Braeburn (Apple Inc.
  entities), Jazz/Envy/Pink Lady/Cosmic Crisp/Ambrosia/SweeTango (club-apple
  trademarks), Fuji (Fujifilm/Fujitsu), Gala (Gala Games), Orchard (CMS),
  Stile/Croft (vetoed), Pomarium (one vowel from Pomerium, a security proxy),
  Cider (Apple Music client), Sentry/Turnstile/Cosign/Wicket/Homestead
  (established projects). Runners-up if it ever must change: Crispin (bare npm
  free), Orchardist, Macoun, Cortland, Winesap, Steading.
- 2026-07-30 — iWork stays a SEPARATE repo. Interop is already seamless: MCP
  servers coexist in any client; folder pipelines can drive iWork via osascript
  steps today; and once `governed` publishes to npm, iwork_mcp can adopt the
  contract as an ordinary dependency (tool-by-tool, no repo merge) — the Q5
  library decision paying off. DECIDED same day: iwork_mcp gets its OWN audit
  DB (its own app-support dir), not the suite's shared one — separate product,
  separate ledger; the Q4 one-DB rule applies within a suite, not across them.
- 2026-07-30 — Context layer designed (docs/04 rewritten as the design). Headlines:
  **pointers, not copies** — the store holds derived metadata + messageId/event-id
  pointers, never body copies; Mail stays the source of truth and the serve layer
  inherits source permissions. (was Q13) v1 capture = Mail + Calendar only.
  (was Q14) SQLite (mode 600) + FTS5 + recency/entity retrieval; NO embeddings in
  v1. (was Q15) briefing = standing questions (standing-questions.yaml lives IN the
  iCloud Briefings folder, phone-editable) + deterministic deltas, every answer
  cited; the briefing file doubles as the correction surface (checkbox edits →
  judgments). Curation split: Layer 0 deterministic always-on; Layer 1
  model-assisted opt-in with declared egress, local model default. Flywheel:
  immutable AI rows + separate human judgments table. Milestones M1–M4, nothing
  needs a model until M3.
- 2026-07-30 — Onboarding: NO iCloud/cloud authentication, ever — local-first IS the
  auth story (iCloud Drive is a folder; Mail.app holds the accounts; TCC prompts are
  the permission layer). The gap was a guided path, now built: packages/setup, an
  interactive `governed-mcp setup` wizard — registers MCP clients (Claude Code via
  CLI, Claude Desktop via config merge with backup), triggers permission prompts
  proactively AT SETUP TIME (not mid-conversation days later), explains the FDA
  opt-in and opens the Settings pane on request, creates a starter iCloud Agents
  folder, optionally installs launchd. Wizard follows house doctrine: every step
  confirmed, every action audited, non-interactive input defaults to No. FDA remains
  the one permission Apple requires the human to flip manually — by design.
- 2026-07-30 — (was Q10–Q12) Folder-as-API v1 built and live-verified as
  packages/folders. Q10 watcher: chokidar (FSEvents-backed) with awaitWriteFinish
  stability for sync bursts; dataless iCloud placeholders trigger brctl download.
  Q11 format: .pipeline.yaml IN the folder, zod-validated, argv arrays only (no
  shell — a filename can never become shell syntax), {input}/{dir} placeholders,
  steps chain stdout→stdin, network use is a declared field that lands in the audit
  row. Q12 failure UX: <name>.result.md / <name>.error.md beside the drop, errors in
  plain English with the fix path; every run audits to the shared DB. Daemon
  hot-loads new/changed pipeline files. launchd template shipped, not installed.
- 2026-07-30 — (was Q6) **Two-tier Mail search backend**, from real-mailbox benchmarks
  (1,865-msg inbox, 2 accounts): AppleScript `whose` header search is FAST — count
  0.34s, subject search 0.46s, bulk subject fetch of matches 0.54s, single body 0.77s,
  mailbox enumeration 0.15s. AppleScript full-text (`content contains`) is UNUSABLE —
  timed out at 170s on the same inbox. Spotlight/mdfind needs Full Disk Access, and
  WITHOUT it Spotlight SILENTLY returns 0 mail results (no error!). Therefore:
  - Tier 1 (Automation permission only): AppleScript for header search
    (subject/sender/date/mailbox), reads, and all actions. Full base functionality,
    least privilege.
  - Tier 2 (opt-in FDA): mdfind full-text search over ~/Library/Mail. The tool MUST
    probe FDA (is ~/Library/Mail readable?) and report "full-text search requires
    Full Disk Access" — never silently return empty results.
  - Envelope Index: not needed; stays untouched unless mdfind proves insufficient.
- 2026-07-30 — Landscape: **supermemoryai/apple-mcp** (3.1k stars — the most popular
  Apple MCP) exposes direct send-message/send-email/etc. across 7 apps with ZERO
  governance (no confirmation, no dry-run, no audit, no undo) — and was ARCHIVED
  read-only 2026-01-01. The thesis validated twice over: huge demand for the surface,
  loaded-guns implementation, now abandoned. Also confirms the name "apple-mcp" is
  taken and well-known → our placeholder MUST be renamed before publication (see
  Naming).
- 2026-07-29 — (was Q1, channel) v1 approval channel is the **native macOS dialog**:
  the server pops `display alert` via osascript — default button Deny, timeout →
  auto-deny, any osascript error → deny. Works with every MCP client, zero client
  dependencies. MCP elicitation becomes a capability-detected upgrade later; the
  menubar approval queue stays v2.
- 2026-07-29 — (was Q4) **One shared audit DB** for the whole suite, at
  `~/Library/Application Support/<name>/audit.db` (dir name follows the working
  package name until naming is settled). One DB = one place to inspect everything the
  suite ever did; per-tool DBs fragment the story.
- 2026-07-29 — Framework contract SETTLED; code begins. Repo is written public-first:
  no personal data, no real names/emails/employers in any file — examples use
  example.com. Verify git author identity before first push.
- 2026-07-29 — (was Q1, principle only) **Approval is verified by the framework, never
  relayed by the model.** If the approval signal travels through model text ("user said
  yes"), the gate is exactly as injection-resistant as the model — i.e., not a
  guarantee. The confirmation channel must be out-of-band from the model (native
  dialog, MCP elicitation, approval queue — channel choice still open, see Q1).
- 2026-07-29 — (was Q2) Undo taxonomy locked: `native | compensate | none`. Rule: a
  tool declaring `native` must return an undo recipe from its handler or the framework
  REFUSES the write; the recipe is stored in the audit row. `compensate` and `none`
  are honesty labels in the audit, nothing more.
- 2026-07-29 — (was Q3) Redaction is declared per-tool in defineTool
  (`redact: ["body", ...]`); the framework stores redacted fields as length + hash,
  all other args verbatim. Audit stays useful ("draft to 2 recipients, 1.2KB body")
  without becoming a second copy of the inbox. Sensitivity is part of the contract,
  not a global policy.
- 2026-07-29 — (was Q5) The framework is a **LIBRARY**, not a proxy. These are
  different products, not two sizes of one: a proxy wrapping third-party MCPs can
  gate/log/allowlist (a firewall) but cannot dry-run or undo tools whose semantics it
  doesn't know. The full contract — dry-run, undo recipes, provenance — exists only by
  construction. Proxy remains a legit v2-adjacent product with honestly-reduced
  guarantees ("audit + gates for any MCP").
- 2026-07-29 — (was Q8) Draft-first confirmed: Mail v1 ships with NO send tool. The
  outward path is create_draft → human opens Mail.app → human hits send. Worst case
  becomes embarrassment (bad draft), not damage — changes the risk class of the whole
  server. Revisit only after the v2 approval queue exists.
- 2026-07-29 — Stack: TypeScript + MCP SDK + osascript(JXA) + better-sqlite3, matching
  iwork_mcp. Public-ready hygiene from the first commit.
- 2026-07-29 — Build order: framework → Mail → folder-as-API → context layer. No tool
  code before the framework contract is settled.
- 2026-07-29 — House doctrine fixed (see CLAUDE.md): dry-run default, gated writes,
  audit rows, provenance, least privilege, injection posture.
