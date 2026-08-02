import { randomBytes, randomUUID } from "node:crypto";
import type {
  ApprovalChannel,
  ApprovalRequest,
  ApprovalResult,
} from "@honeycrisp/governed";
import type { ChatDb } from "./chatdb.js";
import type { OwnerSender } from "./send.js";

/**
 * Reply-to-approve (docs/06): the channel that retires the file-move.
 *
 * The bridge texts the owner what wants to run plus a per-request nonce;
 * the owner replies "yes <nonce>" or "no <nonce>". THIS CODE — never the
 * model — reads the reply from chat.db (already allowlist-filtered at the
 * SQL boundary) and matches the nonce. The nonce is generated here, sent
 * only to the owner's phone, and never enters any model context: pasted or
 * forwarded content can talk a model into ASKING, but it cannot forge a
 * reply it has never seen.
 *
 * Fail-closed inventory: timeout → deny; "no <nonce>" → deny; any reply
 * without the exact nonce → ignored (not a decision); send failure (incl.
 * the law-4 rate cap) → deny without waiting; a nonce is single-use and
 * dead after its deadline.
 */

export interface ImessageApprovalOptions {
  chatdb: ChatDb;
  sender: OwnerSender;
  ownerHandles: string[];
  assistantAccount?: string;
  timeoutSeconds?: number;
  pollSeconds?: number;
  /** Injectable clock/sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class ImessageApprovalChannel implements ApprovalChannel {
  private timeoutMs: number;
  private pollMs: number;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private opts: ImessageApprovalOptions) {
    this.timeoutMs =
      Math.min(3600, Math.max(10, opts.timeoutSeconds ?? 300)) * 1000;
    this.pollMs = Math.min(30, Math.max(1, opts.pollSeconds ?? 2)) * 1000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request(req: ApprovalRequest): Promise<ApprovalResult> {
    const id = randomUUID();
    const nonce = randomBytes(3).toString("hex"); // 6 chars, per-request
    let cursor = this.opts.chatdb.latestRowid();

    const minutes = Math.round(this.timeoutMs / 60_000);
    const sent = await this.opts.sender.send(
      `Approval needed: ${req.tool}\n${req.summary}\n` +
        `[scope: ${req.scope} | mode: ${req.mode}]\n\n` +
        `Reply "yes ${nonce}" to run it, "no ${nonce}" to refuse. ` +
        `No reply in ${minutes} min = refused.`
    );
    if (!sent.ok) {
      // Couldn't ask the human → nobody can approve → deny, don't hang.
      return { approved: false, id, method: "imessage", detail: "channel-error" };
    }

    const deadline = this.now() + this.timeoutMs;
    const yes = new RegExp(`^\\s*yes\\s+${nonce}\\s*$`, "i");
    const no = new RegExp(`^\\s*no\\s+${nonce}\\s*$`, "i");
    while (this.now() < deadline) {
      await this.sleep(Math.min(this.pollMs, Math.max(deadline - this.now(), 1)));
      const poll = this.opts.chatdb.poll(cursor, this.opts.ownerHandles, this.opts.assistantAccount);
      cursor = poll.cursor;
      for (const message of poll.messages) {
        if (yes.test(message.text)) {
          return { approved: true, id, method: "imessage" };
        }
        if (no.test(message.text)) {
          return { approved: false, id, method: "imessage", detail: "denied" };
        }
        // Any other reply — including a wrong or stale nonce — is not a
        // decision. The conversation continues; the gate keeps waiting.
      }
    }
    return { approved: false, id, method: "imessage", detail: "timeout" };
  }
}
