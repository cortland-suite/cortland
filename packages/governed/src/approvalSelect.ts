import { randomUUID } from "node:crypto";
import { MacDialogApprovalChannel } from "./approval.js";
import { ElicitationApprovalChannel } from "./approvalElicit.js";
import { FolderApprovalChannel } from "./approvalFolder.js";
import { loadApprovalConfig } from "./config.js";
import type { ApprovalChannel, ApprovalRequest, ApprovalResult } from "./types.js";

/**
 * The channel servers actually use: re-reads config.json on EVERY request, so
 * the human can switch channels (say, before leaving the house) without
 * restarting anything — the same no-restart property live mode already has.
 *
 * The unconfigured default is "dialog" (see loadApprovalConfig): a client can
 * declare the elicitation capability yet auto-decline the request without
 * rendering anything (Claude Code, observed 2026-07-31), so the elicit-first
 * "auto" ladder is an explicit opt-in, not the default. Explicit configs are
 * honored exactly; an invalid spec (unknown channel name, folder without a
 * dir) denies outright with a detail naming the problem. It never falls back
 * to a channel the human didn't pick: silently moving the decision surface
 * would be a bypass — and a decline on the chosen channel is a denial, never
 * a cue to re-ask somewhere else.
 */
export class ConfiguredApprovalChannel implements ApprovalChannel {
  constructor(
    private dataDir: string,
    private elicit?: ElicitationApprovalChannel
  ) {}

  async request(req: ApprovalRequest): Promise<ApprovalResult> {
    const spec = loadApprovalConfig(this.dataDir);
    switch (spec.channel) {
      case "auto":
        if (this.elicit?.supported()) return this.elicit.request(req);
        return new MacDialogApprovalChannel().request(req);
      case "elicit":
        if (this.elicit?.supported()) return this.elicit.request(req);
        if (spec.fallback === "dialog") {
          return new MacDialogApprovalChannel().request(req);
        }
        return {
          approved: false,
          id: randomUUID(),
          method: "elicit",
          detail: "channel-error: client does not support elicitation and fallback is none",
        };
      case "dialog":
        return new MacDialogApprovalChannel().request(req);
      case "folder":
        return new FolderApprovalChannel({
          dir: spec.dir,
          timeoutSeconds: spec.timeoutSeconds,
          pollSeconds: spec.pollSeconds,
        }).request(req);
      case "invalid":
        return {
          approved: false,
          id: randomUUID(),
          method: "misconfigured",
          detail: `channel-error: ${spec.reason}`,
        };
    }
  }
}
