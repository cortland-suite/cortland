import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ApprovalChannel, ApprovalRequest, ApprovalResult } from "./types.js";

/**
 * v2 approval channel: MCP elicitation — the server asks the CLIENT to pose a
 * native Approve/Deny prompt to its human. This is the UX the folder channel
 * was bridging toward: a yes/no card in whatever app hosts the model (Claude
 * Desktop, Claude Code, any MCP client that declares the elicitation
 * capability), wherever the human happens to be.
 *
 * Why this is still out-of-band from the model: elicitation/create is a
 * protocol request answered by the CLIENT APPLICATION's own UI, not by the
 * model's text generation. The model never sees the prompt and cannot answer
 * it; the client returns the human's action directly to this server. A client
 * that lies about its human is already trusted with the tool calls themselves
 * — elicitation adds no new trust beyond what running inside that client
 * already implies.
 *
 * Fail-closed rules: approved ONLY when the human explicitly accepts AND the
 * confirm box is true. Decline, cancel, missing content, schema mismatch,
 * timeout, transport error, or a client without the capability — all deny.
 */

export class ElicitationApprovalChannel implements ApprovalChannel {
  constructor(
    private getServer: () => Server | undefined,
    private timeoutSeconds = 300
  ) {}

  /** True when a connected client has declared the elicitation capability. */
  supported(): boolean {
    try {
      return this.getServer()?.getClientCapabilities()?.elicitation !== undefined;
    } catch {
      return false;
    }
  }

  async request(req: ApprovalRequest): Promise<ApprovalResult> {
    const id = randomUUID();
    const server = this.getServer();
    if (!server || !this.supported()) {
      return { approved: false, id, method: "elicit", detail: "channel-error" };
    }
    const heading =
      req.mode === "destructive" ? "DESTRUCTIVE action" : "Gated action";
    try {
      const result = await server.elicitInput(
        {
          message:
            `${heading} awaiting approval\n\n` +
            `Tool: ${req.tool}\nScope: ${req.scope}\nMode: ${req.mode}\n\n` +
            `${req.summary}\n\nApproval id: ${id.slice(0, 8)}`,
          requestedSchema: {
            type: "object",
            properties: {
              confirm: {
                type: "boolean",
                title: `Approve ${req.tool}?`,
                description:
                  "true runs this action; false (or dismissing this prompt) refuses it",
              },
            },
            required: ["confirm"],
          },
        },
        { timeout: this.timeoutSeconds * 1000 }
      );
      const approved =
        result.action === "accept" &&
        (result.content as { confirm?: unknown } | undefined)?.confirm === true;
      return {
        approved,
        id,
        method: "elicit",
        detail: approved
          ? undefined
          : result.action === "accept"
            ? "denied" // accepted the form but confirm was not true
            : result.action, // "decline" | "cancel"
      };
    } catch {
      // Timeout, transport error, client bug — a prompt that never resolved
      // is a denial, never a pass.
      return { approved: false, id, method: "elicit", detail: "channel-error" };
    }
  }
}
