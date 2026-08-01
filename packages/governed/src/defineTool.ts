import type { GovernedToolDef } from "./types.js";

const NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const MODES = new Set(["read", "write-safe", "write-gated", "destructive"]);
const UNDO_KINDS = new Set(["native", "compensate", "none"]);

/**
 * Registration-time enforcement. The contract is checked when the tool is DEFINED,
 * not discovered when it misbehaves:
 *   - native undo without planUndo is refused outright — a tool that cannot produce
 *     an undo recipe before the write does not get to claim native undo;
 *   - unknown modes/undo kinds are refused (a typo must not fail open);
 *   - the returned definition is frozen so nothing can relax it after registration.
 */
export function defineTool<Args extends Record<string, unknown>>(
  def: GovernedToolDef<Args>
): Readonly<GovernedToolDef<Args>> {
  if (!NAME_PATTERN.test(def.name)) {
    throw new Error(
      `defineTool(${def.name}): name must be lowercase verb_noun snake_case`
    );
  }
  if (!MODES.has(def.mode)) {
    throw new Error(`defineTool(${def.name}): unknown mode "${def.mode}"`);
  }
  if (!UNDO_KINDS.has(def.undo)) {
    throw new Error(`defineTool(${def.name}): unknown undo kind "${def.undo}"`);
  }
  if (!def.scope || def.scope.trim() === "") {
    throw new Error(`defineTool(${def.name}): scope is required (least privilege)`);
  }
  if (def.undo === "native" && typeof def.planUndo !== "function") {
    throw new Error(
      `defineTool(${def.name}): undo "native" requires planUndo — the framework ` +
        `refuses a native-undo tool that cannot produce a recipe before the write`
    );
  }
  return Object.freeze({ ...def });
}
