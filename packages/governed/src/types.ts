import type { ZodRawShape } from "zod";

/**
 * read        — no mutation anywhere. Always executes.
 * write-safe  — mutates only artifacts that stay inside the user's review loop
 *               (a draft, a local file). Always executes.
 * write-gated — outward-facing or state-changing. Dry-run unless live mode is on
 *               AND a human approves this specific action out-of-band.
 * destructive — removes user data. Same gate as write-gated; separate label so the
 *               audit trail and approval dialog can say so.
 */
export type ToolMode = "read" | "write-safe" | "write-gated" | "destructive";

/**
 * native     — the action can be mechanically reversed; the tool MUST be able to
 *              produce an undo recipe BEFORE the write happens (planUndo), or the
 *              framework refuses to register it.
 * compensate — not reversible, but a correcting action exists (draft a follow-up).
 * none       — irreversible. The audit row says so honestly.
 */
export type UndoKind = "native" | "compensate" | "none";

export interface ApprovalRequest {
  tool: string;
  scope: string;
  mode: ToolMode;
  /** Human-readable description of the action. Already redacted — safe to display. */
  summary: string;
}

export interface ApprovalResult {
  approved: boolean;
  /** Unique id linking this approval to its audit row. */
  id: string;
  /** Which channel produced the decision, e.g. "macos-dialog", "stub". */
  method: string;
  /** Why not approved: "denied", "timeout", "channel-error". */
  detail?: string;
}

/**
 * The gate. Implementations MUST be out-of-band from the model: the decision comes
 * from a human acting on a UI the model cannot write to. Model text is never an
 * approval signal.
 */
export interface ApprovalChannel {
  request(req: ApprovalRequest): Promise<ApprovalResult>;
}

export interface HandlerResult {
  /** Text returned to the MCP client. */
  content: string;
  /**
   * Optional refinement of the undo recipe with post-execution knowledge
   * (e.g. the id of a created object). The pre-write planUndo recipe is the
   * one that satisfies the native-undo contract.
   */
  undoRecipe?: unknown;
}

export interface ToolContext {
  /** True when this execution is live (not a dry-run preview). */
  live: boolean;
  /** Provenance stamp for anything the tool creates: "created by <tool> v<version>". */
  provenance: string;
}

export interface GovernedToolDef<Args = Record<string, unknown>> {
  /** verb_noun, lowercase snake_case, at least two words: "mail_search". */
  name: string;
  description: string;
  /** The ONE app/surface this tool touches (least privilege): "Mail", "Reminders". */
  scope: string;
  mode: ToolMode;
  undo: UndoKind;
  /**
   * Top-level argument keys whose values are personal content. Stored in the audit
   * log as { length, sha256 } instead of verbatim.
   */
  redact?: string[];
  /**
   * For read-mode tools: wrap returned content in the injection fence (default true).
   * Set false only for returns that contain no user-authored content.
   */
  fence?: boolean;
  /** Zod raw shape describing the arguments. */
  inputSchema: ZodRawShape;
  /**
   * REQUIRED when undo is "native": produce the undo recipe BEFORE the write
   * executes. Throwing or returning null/undefined refuses the write.
   */
  planUndo?: (args: Args) => Promise<unknown> | unknown;
  /**
   * Dry-run preview for gated tools. Defaults to a description of the call with
   * redacted args.
   */
  preview?: (args: Args) => Promise<string> | string;
  handler: (args: Args, ctx: ToolContext) => Promise<HandlerResult>;
}

export interface GovernedConfig {
  /** Live mode. Defaults to false; every config error resolves to false. */
  live: boolean;
}
