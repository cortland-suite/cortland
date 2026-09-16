import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AuditStore, StaticApprovalChannel, executeGoverned } from "@cortland/governed";
import type { ExecutionDeps } from "@cortland/governed";
import { composeMessage, createNotifyOwnerTool, imessageTools } from "../src/tools.js";
import type { BridgeConfig } from "../src/config.js";

const OWNER = "+15551230000";

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    ownerHandles: [OWNER],
    model: { type: "ollama", model: "gemma4:e2b-it-qat", host: "http://127.0.0.1:11434" },
    maxPerHour: 3,
    pollSeconds: 3,
    approvalTimeoutSeconds: 300,
    ...overrides,
  };
}

/** A tool wired to a recording fake sender, plus the sends it made. */
function harness(opts: { sends?: number; ok?: boolean; cfg?: BridgeConfig } = {}) {
  const sent: string[] = [];
  const tool = createNotifyOwnerTool({
    loadConfig: () => opts.cfg ?? config(),
    sender: () => ({
      send: async (text: string) => {
        sent.push(text);
        return opts.ok === false
          ? { ok: false, detail: "rate-cap reached; staying quiet (law 4)" }
          : { ok: true };
      },
    }),
    recentSends: () => opts.sends ?? 0,
    now: () => Date.parse("2026-09-16T12:00:00Z"),
  });
  return { tool, sent };
}

function deps(dir: string): ExecutionDeps {
  return {
    audit: new AuditStore(dir),
    approval: new StaticApprovalChannel(false),
    getConfig: () => ({ live: false }),
    version: "0.2.0",
  };
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "notify-"));
}

describe("notify_owner contract", () => {
  it("has no recipient argument — the owner is unaddressable from outside", () => {
    const { tool } = harness();
    expect(Object.keys(tool.inputSchema).sort()).toEqual(["source", "text"]);
    // The tier argument only holds if nothing can redirect the message.
    for (const key of ["to", "recipient", "handle", "phone", "address"]) {
      expect(tool.inputSchema).not.toHaveProperty(key);
    }
  });

  it("is write-safe with honest undo, and redacts the message body", () => {
    const { tool } = harness();
    expect(tool.mode).toBe("write-safe");
    expect(tool.undo).toBe("none"); // a sent text cannot be unsent
    expect(tool.redact).toContain("text");
    expect(tool.scope).toBe("Messages");
  });

  it("sends the text to the configured owner and reports the hour's budget", async () => {
    const { tool, sent } = harness({ sends: 1 });
    const result = await tool.handler(
      { text: "Back in stock" },
      { live: true, provenance: "created by notify_owner v0.2.0" }
    );
    expect(sent).toEqual(["Back in stock"]);
    expect(result.content).toContain("2/3 this hour");
    expect(result.content).toContain("created by notify_owner v0.2.0");
  });

  it("refuses at the cap instead of going quiet", async () => {
    const { tool, sent } = harness({ sends: 3 });
    await expect(
      tool.handler({ text: "x" }, { live: true, provenance: "p" })
    ).rejects.toThrow(/rate cap reached: 3\/3/);
    expect(sent).toEqual([]);
  });

  it("surfaces a send failure as an error rather than a silent success", async () => {
    const { tool } = harness({ ok: false });
    await expect(
      tool.handler({ text: "x" }, { live: true, provenance: "p" })
    ).rejects.toThrow(/law 4/);
  });

  it("treats source as a label, never as text the caller can compose", () => {
    const shape = z.object(imessageTools[0].inputSchema as { source: z.ZodTypeAny });
    expect(shape.safeParse({ text: "hi", source: "zelda-stock-monitor" }).success).toBe(true);
    for (const bad of ["Not A Slug", "a".repeat(41), "hi there", "x\ny"]) {
      expect(shape.safeParse({ text: "hi", source: bad }).success).toBe(false);
    }
    expect(composeMessage("Back in stock", "zelda-stock-monitor")).toBe(
      "[zelda-stock-monitor] Back in stock"
    );
    expect(composeMessage("Back in stock")).toBe("Back in stock");
  });
});

describe("notify_owner through the governed path", () => {
  it("executes without an approval and leaves an ok row with the body redacted", async () => {
    const dir = tmp();
    const d = deps(dir);
    const { tool, sent } = harness();
    const result = await executeGoverned(tool, { text: "secret restock news" }, d);

    expect(result.isError).toBeUndefined();
    expect(sent).toEqual(["secret restock news"]);
    const [row] = d.audit.list(1);
    expect(row.tool).toBe("notify_owner");
    expect(row.mode).toBe("write-safe");
    expect(row.outcome).toBe("ok");
    expect(row.dryRun).toBe(false);
    // write-safe runs in dry-run config without being downgraded to a preview
    expect(JSON.stringify(row.args)).not.toContain("secret restock news");
    expect(row.args.text).toMatchObject({ length: "secret restock news".length });
    expect((d.approval as StaticApprovalChannel).requests).toEqual([]);
    d.audit.close();
  });

  it("records the refusal when the cap is hit, so a silent hour is visible", async () => {
    const dir = tmp();
    const d = deps(dir);
    const { tool, sent } = harness({ sends: 99 });
    const result = await executeGoverned(tool, { text: "x" }, d);

    expect(result.isError).toBe(true);
    expect(sent).toEqual([]);
    const [row] = d.audit.list(1);
    expect(row.outcome).toBe("error");
    expect(row.detail).toMatch(/rate cap reached/);
    d.audit.close();
  });
});

describe("the cap counts audit rows, not heap state", () => {
  it("survives a process restart: a fresh store still sees the hour's sends", () => {
    const dir = tmp();
    const first = new AuditStore(dir);
    const base = {
      scope: "Messages",
      mode: "write-safe" as const,
      undo: "none" as const,
      args: {},
      dryRun: false,
      outcome: "ok" as const,
      toolVersion: "0.2.0",
    };
    for (let i = 0; i < 4; i++) first.record({ ...base, tool: "notify_owner" });
    first.record({ ...base, tool: "notify_owner", outcome: "error" });
    first.record({ ...base, tool: "mail_search", mode: "read" });
    first.close();

    // A new process. Nothing carried over but the rows on disk.
    const second = new AuditStore(dir);
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    expect(second.countSince("notify_owner", hourAgo)).toBe(4);
    // A window that opens after the rows were written counts none of them.
    expect(second.countSince("notify_owner", new Date(Date.now() + 1000).toISOString())).toBe(0);
    second.close();
  });
});
