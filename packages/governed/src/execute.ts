import type { AuditStore } from "./audit.js";
import type {
  ApprovalChannel,
  GovernedConfig,
  GovernedToolDef,
  ToolContext,
} from "./types.js";
import { fence } from "./fence.js";
import { redactArgs } from "./redact.js";

export interface ExecutionDeps {
  audit: AuditStore;
  approval: ApprovalChannel;
  /** Re-read per call so live mode can change without a restart; errors → dry-run. */
  getConfig: () => GovernedConfig;
  version: string;
}

export interface ExecutionResult {
  text: string;
  isError?: boolean;
}

export async function executeGoverned<Args extends Record<string, unknown>>(
  def: Readonly<GovernedToolDef<Args>>,
  args: Args,
  deps: ExecutionDeps
): Promise<ExecutionResult> {
  const redacted = redactArgs(args, def.redact);
  const base = {
    tool: def.name,
    scope: def.scope,
    mode: def.mode,
    undo: def.undo,
    args: redacted,
    toolVersion: deps.version,
  };
  const ctx: ToolContext = {
    live: true,
    provenance: `created by ${def.name} v${deps.version}`,
  };
  const gated = def.mode === "write-gated" || def.mode === "destructive";

  if (!gated) {
    try {
      const result = await def.handler(args, ctx);
      deps.audit.record({ ...base, dryRun: false, outcome: "ok" });
      const text =
        def.mode === "read" && def.fence !== false
          ? fence(def.name, result.content)
          : result.content;
      return { text };
    } catch (err) {
      deps.audit.record({
        ...base,
        dryRun: false,
        outcome: "error",
        detail: String(err),
      });
      return { text: `${def.name} failed: ${String(err)}`, isError: true };
    }
  }

  // Gated path. Config errors have already resolved to { live: false }.
  const config = deps.getConfig();
  if (!config.live) {
    const preview = def.preview
      ? await def.preview(args)
      : `Would run ${def.name} (scope: ${def.scope}, mode: ${def.mode}) with args:\n` +
        JSON.stringify(redacted, null, 2);
    deps.audit.record({ ...base, dryRun: true, outcome: "dry-run" });
    return {
      text:
        `[DRY-RUN] ${def.name} did NOT execute — live mode is off (the default).\n` +
        `${preview}\n` +
        `To execute for real, the user must enable live mode; every live run still ` +
        `requires per-action human approval via a native dialog.`,
    };
  }

  // Live: the undo recipe must exist BEFORE the write (native undo contract).
  let undoRecipe: unknown;
  if (def.undo === "native") {
    try {
      undoRecipe = await def.planUndo!(args);
    } catch (err) {
      undoRecipe = undefined;
    }
    if (undoRecipe === undefined || undoRecipe === null) {
      deps.audit.record({
        ...base,
        dryRun: false,
        outcome: "refused-no-undo",
        detail: "planUndo produced no recipe; write refused",
      });
      return {
        text:
          `${def.name} refused: this tool promises native undo but could not ` +
          `produce an undo recipe for this call. Nothing was executed.`,
        isError: true,
      };
    }
  }

  const approval = await requestApprovalSafely(deps.approval, {
    tool: def.name,
    scope: def.scope,
    mode: def.mode,
    summary: def.preview
      ? String(await def.preview(args))
      : `Run ${def.name} with args: ${JSON.stringify(redacted)}`,
  });
  if (!approval.approved) {
    deps.audit.record({
      ...base,
      dryRun: false,
      outcome: "denied",
      approvalId: approval.id,
      approvalMethod: approval.method,
      detail: approval.detail,
    });
    return {
      text:
        `${def.name} was NOT executed: human approval was not granted ` +
        `(${approval.detail ?? "denied"}).`,
    };
  }

  try {
    const result = await def.handler(args, ctx);
    if (result.undoRecipe !== undefined) undoRecipe = result.undoRecipe;
    deps.audit.record({
      ...base,
      dryRun: false,
      outcome: "ok",
      approvalId: approval.id,
      approvalMethod: approval.method,
      undoRecipe,
    });
    return { text: result.content };
  } catch (err) {
    deps.audit.record({
      ...base,
      dryRun: false,
      outcome: "error",
      approvalId: approval.id,
      approvalMethod: approval.method,
      detail: String(err),
    });
    return { text: `${def.name} failed: ${String(err)}`, isError: true };
  }
}

/** A broken approval channel is a denial, never a pass-through. */
async function requestApprovalSafely(
  channel: ApprovalChannel,
  req: Parameters<ApprovalChannel["request"]>[0]
) {
  try {
    return await channel.request(req);
  } catch {
    return {
      approved: false,
      id: "channel-error",
      method: "unknown",
      detail: "channel-error",
    };
  }
}
