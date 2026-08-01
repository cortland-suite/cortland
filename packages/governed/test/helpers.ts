import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AuditStore } from "../src/audit.js";
import { StaticApprovalChannel } from "../src/approval.js";
import { defineTool } from "../src/defineTool.js";
import type { ExecutionDeps } from "../src/execute.js";
import type { GovernedConfig, GovernedToolDef } from "../src/types.js";

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "governed-test-"));
}

export interface TestRig {
  dir: string;
  audit: AuditStore;
  approval: StaticApprovalChannel;
  deps: ExecutionDeps;
}

export function makeRig(config: GovernedConfig, approve = true): TestRig {
  const dir = tempDir();
  const audit = new AuditStore(dir);
  const approval = new StaticApprovalChannel(approve);
  return {
    dir,
    audit,
    approval,
    deps: { audit, approval, getConfig: () => config, version: "0.0.0-test" },
  };
}

export function gatedTool(
  overrides: Partial<GovernedToolDef<Record<string, unknown>>> = {}
) {
  return defineTool({
    name: "demo_write",
    description: "test gated write",
    scope: "Test",
    mode: "write-gated",
    undo: "none",
    inputSchema: { message: z.string() },
    handler: async () => ({ content: "executed live" }),
    ...overrides,
  });
}
