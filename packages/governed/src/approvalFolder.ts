import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalChannel, ApprovalRequest, ApprovalResult } from "./types.js";

/**
 * v1.5 approval channel: approval-by-file, for the human who is NOT at the Mac.
 *
 * The dialog channel (v1) requires eyes on the screen; the field note in NOTES
 * Q17 showed remote sessions deny every action by timeout. This channel writes
 * each approval request as a markdown file into a folder — put that folder in
 * iCloud Drive and the request appears on every device the human owns.
 *
 * TWO ways to decide, because of a second field note (Q22, 2026-07-31): stock
 * iOS has no plain-text editor, so checkbox editing needs a third-party app.
 *   1. MOVE the file into the `Approve` or `Deny` subfolder (works natively in
 *      the iOS Files app — long-press → Move);
 *   2. or check the APPROVE / DENY box in any text editor.
 * Checking DENY, editing nothing until the deadline, deleting the file,
 * checking both boxes, or moving to Approve while DENY is checked — all DENY.
 * Every ambiguity fails closed.
 *
 * THREAT MODEL — read before trusting this channel: the decision surface is a
 * file, so the guarantee is only as strong as write access to the approvals
 * folder. The dialog channel's guarantee ("a button the model cannot click")
 * becomes "a file the model must not be able to write". If the agent driving
 * this server can write arbitrary files as your user, it could approve its own
 * requests. Defenses, in order of value:
 *   1. Keep the approvals folder OUT of any directory the agent is sandboxed
 *      into or has blanket write permission for (it defaults to iCloud Drive,
 *      not the project tree).
 *   2. Deny your agent write access to the folder explicitly (e.g. Claude Code
 *      permission rules).
 *   3. The audit row records approvalMethod "folder" — a review can always ask
 *      "should this one have been a dialog?".
 * The v2 queue (menubar UI + push) moves the surface out of the filesystem
 * entirely; this channel is the bridge that works today.
 */

export interface FolderApprovalOptions {
  /** Directory approval files are written to. Created if missing. */
  dir: string;
  /** How long the human has to decide. Clamped to [10, 3600]. Default 300. */
  timeoutSeconds?: number;
  /** How often the file is re-read. Clamped to [1, 30]. Default 2. */
  pollSeconds?: number;
}

const APPROVE_CHECKED = /^\s*[-*]\s*\[\s*[xX✓✔]\s*\]\s*\*{0,2}APPROVE\b/m;
const DENY_CHECKED = /^\s*[-*]\s*\[\s*\S\s*\]\s*\*{0,2}DENY\b/m;

export class FolderApprovalChannel implements ApprovalChannel {
  private dir: string;
  private timeoutMs: number;
  private pollMs: number;

  constructor(opts: FolderApprovalOptions) {
    this.dir = opts.dir;
    this.timeoutMs = clamp(opts.timeoutSeconds ?? 300, 10, 3600) * 1000;
    this.pollMs = clamp(opts.pollSeconds ?? 2, 1, 30) * 1000;
  }

  async request(req: ApprovalRequest): Promise<ApprovalResult> {
    const id = randomUUID();
    const shortId = id.slice(0, 8);
    const name = `pending-${req.tool}-${shortId}.md`;
    const pendingFile = path.join(this.dir, name);
    const movedApprove = path.join(this.dir, "Approve", name);
    const movedDeny = path.join(this.dir, "Deny", name);

    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(pendingFile, renderRequest(req, id, this.timeoutMs), {
        flag: "wx", // refuse to overwrite; a colliding file is someone else's
      });
    } catch {
      // Can't write the request → nobody can approve it → deny, don't hang.
      return { approved: false, id, method: "folder", detail: "channel-error" };
    }
    // The drop targets are a convenience; their absence must not break the
    // checkbox path, so their creation is best-effort.
    try {
      fs.mkdirSync(path.join(this.dir, "Approve"), { recursive: true });
      fs.mkdirSync(path.join(this.dir, "Deny"), { recursive: true });
    } catch {
      /* checkbox editing still works */
    }

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await sleep(Math.min(this.pollMs, Math.max(deadline - Date.now(), 1)));

      // Where is the file, and what does it say?
      let at: "pending" | "approve" | "deny";
      let file: string;
      if (fs.existsSync(pendingFile)) {
        at = "pending";
        file = pendingFile;
      } else if (fs.existsSync(movedApprove)) {
        at = "approve";
        file = movedApprove;
      } else if (fs.existsSync(movedDeny)) {
        at = "deny";
        file = movedDeny;
      } else {
        // Vanished entirely (deleted, or a sync conflict). Not a pass.
        return { approved: false, id, method: "folder", detail: "file-missing" };
      }
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        // Mid-move race: it will be readable at its destination next poll.
        continue;
      }
      const approveChecked = APPROVE_CHECKED.test(text);
      const denyChecked = DENY_CHECKED.test(text);

      // Any DENY signal wins, and conflicting signals are a denial.
      if (at === "deny") {
        this.resolve(file, "denied", "moved to Deny");
        return { approved: false, id, method: "folder", detail: "denied" };
      }
      if (denyChecked) {
        const conflicted = at === "approve" || approveChecked;
        this.resolve(
          file,
          "denied",
          conflicted ? "conflicting signals — denied" : "DENY checked"
        );
        return {
          approved: false,
          id,
          method: "folder",
          detail: conflicted ? "ambiguous" : "denied",
        };
      }
      if (at === "approve") {
        this.resolve(file, "approved", "moved to Approve");
        return { approved: true, id, method: "folder" };
      }
      if (approveChecked) {
        this.resolve(file, "approved", "APPROVE checked");
        return { approved: true, id, method: "folder" };
      }
    }

    this.resolve(pendingFile, "expired", "no decision by the deadline");
    return { approved: false, id, method: "folder", detail: "timeout" };
  }

  /** Stamp the outcome into the file and archive it at the folder root as
   *  `<outcome>-…` (so the Approve/Deny drop targets stay empty and ready).
   *  Best-effort: the decision is already made; a failed rename must not
   *  change it. */
  private resolve(
    file: string,
    outcome: "approved" | "denied" | "expired",
    note: string
  ): void {
    try {
      const text = fs.readFileSync(file, "utf8");
      const stamped =
        text +
        `\n## Outcome\n\n**${outcome.toUpperCase()}** — ${note} ` +
        `(${new Date().toISOString()})\n`;
      const resolved = path.join(
        this.dir,
        path.basename(file).replace(/^pending-/, `${outcome}-`)
      );
      fs.writeFileSync(file, stamped);
      fs.renameSync(file, resolved);
    } catch {
      /* file already gone or folder read-only — outcome stands regardless */
    }
  }
}

function renderRequest(req: ApprovalRequest, id: string, timeoutMs: number): string {
  const now = new Date();
  const expires = new Date(now.getTime() + timeoutMs);
  const window =
    timeoutMs < 90_000
      ? `${Math.round(timeoutMs / 1000)} seconds`
      : `${Math.round(timeoutMs / 60_000)} minutes`;
  const heading =
    req.mode === "destructive" ? "DESTRUCTIVE action needs approval" : "Approval needed";
  return `<!-- honeycrisp-approval v1 id=${id} -->
# ${heading}: ${req.tool}

- **Tool:** ${req.tool}
- **Scope:** ${req.scope}
- **Mode:** ${req.mode}
- **Requested:** ${now.toISOString()}
- **Expires:** ${expires.toISOString()} (about ${window})
- **Approval id:** ${id.slice(0, 8)}

## Action

${req.summary}

## Decide — two ways, use either

**On a phone (no text editor needed):** in the Files app, long-press this
file → Move → into the \`Approve\` folder to run it, or \`Deny\` to refuse.

**In any text editor:** check exactly ONE box, then save:

- [ ] **APPROVE** — run this action
- [ ] **DENY** — refuse this action

Anything else — no decision by the deadline, this file deleted, both boxes
checked, or conflicting signals — counts as DENY. The action waits and does
nothing until you decide.
`;
}

function clamp(n: number, lo: number, hi: number): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
