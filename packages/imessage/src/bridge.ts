import type { AuditStore } from "@honeycrisp/governed";
import type { ChatMessage } from "./brain.js";
import type { ChatDb, InboundMessage } from "./chatdb.js";
import type { OwnerSender } from "./send.js";

/**
 * The daemon: poll inbound (owner-only, enforced in chatdb) → brain → reply.
 *
 * Everything the loop does lands in the audit log: each handled command, each
 * reply, the count of ignored senders, and every failure. The bridge never
 * initiates a conversation — it only answers, which is both law 4's traffic
 * discipline and the reason its pattern looks like a person texting a contact.
 *
 * Structured as a pure-ish step function (`tick`) so the whole loop is
 * testable with fakes; `runBridge` is the thin scheduler around it.
 */

export interface BridgeDeps {
  chatdb: ChatDb;
  sender: OwnerSender;
  ownerHandles: string[];
  assistantAccount?: string;
  audit: AuditStore;
  version: string;
  /** Answer one user message, given the recent conversation. Errors are
   *  caught by the loop. */
  think: (text: string, history: ChatMessage[]) => Promise<string>;
  /** Rolling conversation memory, owned by the caller so it survives ticks.
   *  Trimmed to `historyTurns` (default 6) entries — a small local model's
   *  context is scarce. */
  history?: ChatMessage[];
  historyTurns?: number;
  log?: (message: string) => void;
  /** Guard against a runaway thread: max messages handled per tick. */
  maxPerTick?: number;
  /** One-line-per-app summary of what is mounted, for "what can you do". */
  capabilities?: () => string;
  /** Last known prompt size and the model's window, for the ack's warning. */
  contextStatus?: () => { used: number; limit: number };
  /** Text an immediate ack before thinking (default true). A local model can
   *  take tens of seconds; without an ack, "working" and "broken" look
   *  identical from the phone. Costs one extra send against the law-4 cap. */
  ackFirst?: boolean;
}

export const ACK_TEXT = "Received — working on it…";

/** Warn from 75% of the window; shout past 90%. Below that, say nothing —
 *  a status readout on every message is noise, not information. */
export function ackText(used?: number, limit?: number): string {
  if (!used || !limit || used <= 0) return ACK_TEXT;
  const pct = Math.round((used / limit) * 100);
  if (pct >= 90) {
    return `${ACK_TEXT} (context ${pct}% full — say "new topic" to clear it)`;
  }
  if (pct >= 75) return `${ACK_TEXT} (context ${pct}% full)`;
  return ACK_TEXT;
}

export interface TickResult {
  cursor: number;
  handled: number;
  ignored: number;
  errors: number;
}

/** Replies to approval prompts are consumed by the approval channel, not the
 *  brain: a bare "yes 4f2a1c" is a decision, never a question. */
/** Phrases that reset the thread. Kept generous — a human under a full
 *  context should not have to guess the magic words. */
export const RESET_RE =
  /^\s*(new topic|start over|reset|clear|clear (the )?(context|history|chat))\s*[.!]?\s*$/i;

/** "What can you do?" — answered from the tools actually mounted, so the
 *  reply can never drift from reality or be hallucinated. */
export const HELP_RE =
  /^\s*(what can you do|what can i ask|what do you do|capabilities|commands|help|\?)\s*[.?!]*\s*$/i;

/** At or above this share of the window, the bridge clears the thread itself
 *  rather than letting answers quietly degrade. */
export const AUTO_CLEAR_AT = 0.95;

const DECISION_RE = /^\s*(yes|no)\s+[0-9a-f]{6}\s*$/i;

export async function tick(cursor: number, deps: BridgeDeps): Promise<TickResult> {
  const log = deps.log ?? (() => {});
  const poll = deps.chatdb.poll(cursor, deps.ownerHandles, deps.assistantAccount);
  const result: TickResult = {
    cursor: poll.cursor,
    handled: 0,
    ignored: poll.ignoredSenders,
    errors: 0,
  };

  if (poll.ignoredSenders > 0) {
    // Law 2 leaves exactly this trace: a count, never content.
    deps.audit.record({
      tool: "imessage_ignored",
      scope: "Messages",
      mode: "read",
      undo: "none",
      args: { senders: poll.ignoredSenders },
      dryRun: false,
      outcome: "ok",
      toolVersion: deps.version,
    });
  }

  const max = deps.maxPerTick ?? 5;
  const queue = poll.messages.slice(0, max);
  for (const message of queue) {
    if (DECISION_RE.test(message.text)) continue; // belongs to the gate
    result.handled += 1;
    await handleOne(message, deps, result, log);
  }
  return result;
}

async function handleOne(
  message: InboundMessage,
  deps: BridgeDeps,
  result: TickResult,
  log: (m: string) => void
): Promise<void> {
  const base = {
    scope: "Messages",
    mode: "write-safe" as const,
    undo: "none" as const,
    // The owner's text is content, not a summary field: log only its length,
    // never the words (the audit DB is not a message archive).
    args: { chars: message.text.length },
    dryRun: false,
    toolVersion: deps.version,
  };
  const instant = RESET_RE.test(message.text) || (deps.capabilities && HELP_RE.test(message.text));
  if (deps.ackFirst !== false && !instant) {
    const status = deps.contextStatus?.();
    const ack = await deps.sender.send(ackText(status?.used, status?.limit));
    deps.audit.record({
      ...base,
      tool: "imessage_ack",
      outcome: ack.ok ? "ok" : "error",
      detail: ack.detail,
    });
  }

  // Answered without the model: it is faster, always accurate, and costs
  // nothing — the tools themselves are the source of truth.
  if (deps.capabilities && HELP_RE.test(message.text)) {
    await deps.sender.send(deps.capabilities());
    deps.audit.record({ ...base, tool: "imessage_help", outcome: "ok" });
    return;
  }

  const history = deps.history ?? [];
  // An explicit reset the human can type when the window fills.
  if (RESET_RE.test(message.text)) {
    history.splice(0, history.length);
    if (deps.history === undefined) deps.history = history;
    await deps.sender.send("Cleared — starting fresh.");
    deps.audit.record({ ...base, tool: "imessage_reset", outcome: "ok" });
    return;
  }
  // Full window: clear it and say so, rather than thinking with a context
  // that has no room left and producing a degraded answer.
  const status = deps.contextStatus?.();
  if (status && status.limit > 0 && status.used / status.limit >= AUTO_CLEAR_AT && history.length > 0) {
    history.splice(0, history.length);
    if (deps.history === undefined) deps.history = history;
    await deps.sender.send(
      "My context was full, so I cleared our earlier conversation. " +
        "Send that again and I'll have room to work."
    );
    deps.audit.record({
      ...base,
      tool: "imessage_reset",
      outcome: "ok",
      detail: `auto-cleared at ${Math.round((status.used / status.limit) * 100)}% of window`,
    });
    return;
  }

  let reply: string;
  try {
    reply = await deps.think(message.text, [...history]);
  } catch (err) {
    result.errors += 1;
    deps.audit.record({
      ...base,
      tool: "imessage_handle",
      outcome: "error",
      detail: String(err).slice(0, 200),
    });
    reply =
      "Something went wrong handling that — nothing was changed. " +
      "(The failure is in the audit log.)";
  }

  // Remember this exchange so a follow-up like "10am central" makes sense.
  history.push({ role: "user", content: message.text });
  history.push({ role: "assistant", content: reply });
  const keep = (deps.historyTurns ?? 6) * 2;
  if (history.length > keep) history.splice(0, history.length - keep);
  if (deps.history === undefined) deps.history = history;

  const sent = await deps.sender.send(reply);
  deps.audit.record({
    ...base,
    tool: "imessage_reply",
    outcome: sent.ok ? "ok" : "error",
    detail: sent.detail,
  });
  if (!sent.ok) {
    result.errors += 1;
    log(`reply not sent: ${sent.detail}`);
  }
}

export interface RunOptions extends BridgeDeps {
  pollSeconds?: number;
  /** Test seam: stop after N ticks. Runs forever when undefined. */
  maxTicks?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runBridge(opts: RunOptions): Promise<number> {
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = Math.min(60, Math.max(1, opts.pollSeconds ?? 3)) * 1000;
  // Start from the present: messages that arrived before the bridge did are
  // history, not a backlog of commands to execute.
  let cursor = opts.chatdb.latestRowid();
  log(`bridge listening from rowid ${cursor} for ${opts.ownerHandles.join(", ")}`);

  for (let ticks = 0; opts.maxTicks === undefined || ticks < opts.maxTicks; ticks++) {
    try {
      const result = await tick(cursor, opts);
      cursor = result.cursor;
    } catch (err) {
      // A poll failure (db locked mid-write, etc.) must not kill the daemon.
      log(`tick error: ${String(err).slice(0, 200)}`);
    }
    await sleep(pollMs);
  }
  return cursor;
}
