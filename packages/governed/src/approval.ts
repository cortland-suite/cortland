import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ApprovalChannel, ApprovalRequest, ApprovalResult } from "./types.js";

/**
 * v1 approval channel: a native macOS dialog via osascript. The decision is made by
 * a human clicking a button the model cannot reach — approval never travels through
 * model text. Default button is Deny; timeout and every error path deny.
 */
export class MacDialogApprovalChannel implements ApprovalChannel {
  constructor(private timeoutSeconds = 60) {}

  async request(req: ApprovalRequest): Promise<ApprovalResult> {
    const id = randomUUID();
    const title = sanitize(
      `${req.mode === "destructive" ? "DESTRUCTIVE action" : "Approve action"}: ${req.tool}`
    );
    const message = sanitize(
      `Scope: ${req.scope}\n\n${req.summary}\n\nApproval id: ${id.slice(0, 8)}`
    );
    // The alert is presented BY Finder (always running, always UI-capable): a bare
    // `display alert` from a background/agent process context can silently never
    // reach the screen — it waits invisibly and times out. Presenting through
    // Finder requires a one-time Automation permission (this process → Finder).
    // The AppleEvent timeout must exceed the dialog's give-up window or the event
    // aborts with -1712 before the dialog resolves.
    const script =
      `tell application "Finder"\n` +
      `activate\n` +
      `with timeout of ${this.timeoutSeconds + 15} seconds\n` +
      `display alert "${title}" message "${message}" as critical ` +
      `buttons {"Deny", "Approve"} default button "Deny" cancel button "Deny" ` +
      `giving up after ${this.timeoutSeconds}\n` +
      `end timeout\n` +
      `end tell`;
    try {
      const stdout = await runOsascript(script, (this.timeoutSeconds + 10) * 1000);
      const gaveUp = /gave up:true/.test(stdout);
      const approved = /button returned:Approve/.test(stdout) && !gaveUp;
      return {
        approved,
        id,
        method: "macos-dialog",
        detail: approved ? undefined : gaveUp ? "timeout" : "denied",
      };
    } catch {
      // osascript exits non-zero when the user cancels (Deny is the cancel button)
      // and on any scripting failure. Both deny.
      return { approved: false, id, method: "macos-dialog", detail: "denied" };
    }
  }
}

/** Fixed-outcome channel for tests and non-interactive environments. */
export class StaticApprovalChannel implements ApprovalChannel {
  public requests: ApprovalRequest[] = [];
  constructor(private outcome: boolean) {}

  async request(req: ApprovalRequest): Promise<ApprovalResult> {
    this.requests.push(req);
    return {
      approved: this.outcome,
      id: randomUUID(),
      method: "stub",
      detail: this.outcome ? undefined : "denied",
    };
  }
}

function sanitize(text: string): string {
  // AppleScript string literal: escape backslashes and quotes, drop control chars
  // except newline (which display alert renders fine as a literal).
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[^\S\n ]/g, " ")
    .replace(/\n/g, '" & return & "');
}

function runOsascript(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", script],
      { timeout: timeoutMs },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}
