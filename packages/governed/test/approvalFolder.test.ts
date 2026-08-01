import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FolderApprovalChannel } from "../src/approvalFolder.js";
import { ConfiguredApprovalChannel } from "../src/approvalSelect.js";
import { loadApprovalConfig } from "../src/config.js";
import { AuditStore } from "../src/audit.js";
import { executeGoverned } from "../src/execute.js";
import { gatedTool, tempDir } from "./helpers.js";

const REQ = {
  tool: "demo_write",
  scope: "Test",
  mode: "write-gated" as const,
  summary: "Send the demo message",
};

function pendingFile(dir: string): string {
  const f = fs.readdirSync(dir).find((n) => n.startsWith("pending-"));
  expect(f, "a pending approval file should exist").toBeDefined();
  return path.join(dir, f!);
}

function check(file: string, box: "APPROVE" | "DENY", mark = "x"): void {
  const text = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, text.replace(`- [ ] **${box}**`, `- [${mark}] **${box}**`));
}

function fastChannel(dir: string): FolderApprovalChannel {
  return new FolderApprovalChannel({ dir, timeoutSeconds: 10, pollSeconds: 1 });
}

describe("folder approval channel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("APPROVE checked → approved; file archived as approved-*", async () => {
    const dir = tempDir();
    const resultP = fastChannel(dir).request(REQ);
    check(pendingFile(dir), "APPROVE");
    const result = await resultP;
    expect(result.approved).toBe(true);
    expect(result.method).toBe("folder");
    const names = fs.readdirSync(dir);
    expect(names.some((n) => n.startsWith("approved-demo_write-"))).toBe(true);
    expect(names.some((n) => n.startsWith("pending-"))).toBe(false);
  });

  it("a ✓ mark approves too (phone editors don't all type x)", async () => {
    const dir = tempDir();
    const resultP = fastChannel(dir).request(REQ);
    check(pendingFile(dir), "APPROVE", "✓");
    const result = await resultP;
    expect(result.approved).toBe(true);
  });

  it("DENY checked → denied", async () => {
    const dir = tempDir();
    const resultP = fastChannel(dir).request(REQ);
    check(pendingFile(dir), "DENY");
    const result = await resultP;
    expect(result.approved).toBe(false);
    expect(result.detail).toBe("denied");
    expect(fs.readdirSync(dir).some((n) => n.startsWith("denied-"))).toBe(true);
  });

  it("both boxes checked → denied (ambiguity fails closed)", async () => {
    const dir = tempDir();
    const resultP = fastChannel(dir).request(REQ);
    const file = pendingFile(dir);
    check(file, "APPROVE");
    check(file, "DENY");
    const result = await resultP;
    expect(result.approved).toBe(false);
    expect(result.detail).toBe("ambiguous");
  });

  it("ANY mark in the DENY box denies, even a non-standard one", async () => {
    const dir = tempDir();
    const resultP = fastChannel(dir).request(REQ);
    check(pendingFile(dir), "DENY", "d");
    const result = await resultP;
    expect(result.approved).toBe(false);
  });

  it("a non-standard mark in the APPROVE box does NOT approve (asymmetric strictness)", async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const resultP = fastChannel(dir).request(REQ);
    check(pendingFile(dir), "APPROVE", "d");
    const settled = resultP.then((r) => r);
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await settled;
    expect(result.approved).toBe(false);
    expect(result.detail).toBe("timeout");
  });

  it("no decision by the deadline → denied timeout; file archived as expired-*", async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const resultP = fastChannel(dir).request(REQ);
    const settled = resultP.then((r) => r);
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await settled;
    expect(result.approved).toBe(false);
    expect(result.detail).toBe("timeout");
    const names = fs.readdirSync(dir);
    expect(names.some((n) => n.startsWith("expired-"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, names.find((n) => n.startsWith("expired-"))!), "utf8"))
      .toContain("EXPIRED");
  });

  it("file deleted while pending → denied (a vanished surface is not a pass)", async () => {
    const dir = tempDir();
    const resultP = fastChannel(dir).request(REQ);
    fs.rmSync(pendingFile(dir));
    const result = await resultP;
    expect(result.approved).toBe(false);
    expect(result.detail).toBe("file-missing");
  });

  it("unwritable folder → immediate deny, never a hang or a pass", async () => {
    const dir = path.join(tempDir(), "cannot", "create");
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o500 });
    const result = await fastChannel(dir).request(REQ);
    expect(result.approved).toBe(false);
    expect(result.detail).toBe("channel-error");
  });

  it("moving the file into Approve/ approves — no text editor required (iOS finding)", async () => {
    const dir = tempDir();
    const resultP = fastChannel(dir).request(REQ);
    const file = pendingFile(dir);
    expect(fs.existsSync(path.join(dir, "Approve"))).toBe(true); // drop targets ready
    expect(fs.existsSync(path.join(dir, "Deny"))).toBe(true);
    fs.renameSync(file, path.join(dir, "Approve", path.basename(file)));
    const result = await resultP;
    expect(result.approved).toBe(true);
    expect(result.method).toBe("folder");
    // archived back at the root; the drop target is empty and ready again
    expect(fs.readdirSync(dir).some((n) => n.startsWith("approved-"))).toBe(true);
    expect(fs.readdirSync(path.join(dir, "Approve"))).toEqual([]);
  });

  it("moving the file into Deny/ denies", async () => {
    const dir = tempDir();
    const resultP = fastChannel(dir).request(REQ);
    const file = pendingFile(dir);
    fs.renameSync(file, path.join(dir, "Deny", path.basename(file)));
    const result = await resultP;
    expect(result.approved).toBe(false);
    expect(result.detail).toBe("denied");
  });

  it("moved to Approve but DENY checked → denied (conflicting signals fail closed)", async () => {
    const dir = tempDir();
    const resultP = fastChannel(dir).request(REQ);
    const file = pendingFile(dir);
    check(file, "DENY");
    // the deny edit and the approve move race: deny must win
    fs.renameSync(file, path.join(dir, "Approve", path.basename(file)));
    const result = await resultP;
    expect(result.approved).toBe(false);
    expect(result.detail).toBe("ambiguous");
  });

  it("the request file carries the summary, scope, and mode the human is deciding on", async () => {
    const dir = tempDir();
    const resultP = fastChannel(dir).request({ ...REQ, mode: "destructive" });
    const text = fs.readFileSync(pendingFile(dir), "utf8");
    expect(text).toContain("Send the demo message");
    expect(text).toContain("Scope:** Test");
    expect(text).toContain("destructive");
    expect(text).toContain("DESTRUCTIVE");
    check(pendingFile(dir), "DENY");
    await resultP;
  });
});

describe("approval channel config", () => {
  it("no config file → dialog (the proven prompt; auto is opt-in after the Claude Code finding)", () => {
    expect(loadApprovalConfig(tempDir()).channel).toBe("dialog");
  });

  it("config without approval key → dialog", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ live: true }));
    expect(loadApprovalConfig(dir).channel).toBe("dialog");
  });

  it('explicit "auto" still parses as the elicit→dialog ladder', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ approval: { channel: "auto" } })
    );
    expect(loadApprovalConfig(dir).channel).toBe("auto");
  });

  it('explicit "dialog" stays exactly dialog', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ approval: { channel: "dialog" } })
    );
    expect(loadApprovalConfig(dir).channel).toBe("dialog");
  });

  it("folder channel parses, with ~ expanded", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        approval: { channel: "folder", dir: "~/Approvals", timeoutSeconds: 120 },
      })
    );
    const spec = loadApprovalConfig(dir);
    expect(spec.channel).toBe("folder");
    if (spec.channel === "folder") {
      expect(path.isAbsolute(spec.dir)).toBe(true);
      expect(spec.dir.endsWith("/Approvals")).toBe(true);
      expect(spec.dir.includes("~")).toBe(false);
      expect(spec.timeoutSeconds).toBe(120);
    }
  });

  it('"folder" without a dir → invalid, never a silent fallback', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ approval: { channel: "folder" } })
    );
    expect(loadApprovalConfig(dir).channel).toBe("invalid");
  });

  it("unknown channel name → invalid (a typo must not move the decision surface)", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ approval: { channel: "foldr", dir: "/tmp/x" } })
    );
    expect(loadApprovalConfig(dir).channel).toBe("invalid");
  });
});

describe("the gate with the folder channel (end to end)", () => {
  function folderRig(approvalsDir: string) {
    const dataDir = tempDir();
    const audit = new AuditStore(dataDir);
    return {
      audit,
      deps: {
        audit,
        approval: new FolderApprovalChannel({
          dir: approvalsDir,
          timeoutSeconds: 10,
          pollSeconds: 1,
        }),
        getConfig: () => ({ live: true }),
        version: "0.0.0-test",
      },
    };
  }

  it("live + APPROVE in the file → handler runs; audit row says folder", async () => {
    const approvals = tempDir();
    const rig = folderRig(approvals);
    let executed = false;
    const tool = gatedTool({
      handler: async () => {
        executed = true;
        return { content: "executed live" };
      },
    });
    const resultP = executeGoverned(tool, { message: "hi" }, rig.deps);
    // the approval file appears only after planUndo/preview; wait for it
    await vi.waitFor(() => pendingFile(approvals), { timeout: 5000, interval: 50 });
    check(pendingFile(approvals), "APPROVE");
    const result = await resultP;
    expect(executed).toBe(true);
    expect(result.text).toBe("executed live");
    const row = rig.audit.list(1)[0];
    expect(row.outcome).toBe("ok");
    expect(row.approvalMethod).toBe("folder");
  });

  it("live + no decision → handler NEVER runs (remote fail-closed, Q17)", async () => {
    vi.useFakeTimers();
    const approvals = tempDir();
    const rig = folderRig(approvals);
    let executed = false;
    const tool = gatedTool({
      handler: async () => {
        executed = true;
        return { content: "executed live" };
      },
    });
    const settled = executeGoverned(tool, { message: "hi" }, rig.deps).then((r) => r);
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await settled;
    vi.useRealTimers();
    expect(executed).toBe(false);
    expect(result.text).toContain("NOT executed");
    expect(rig.audit.list(1)[0].outcome).toBe("denied");
  });

  it("misconfigured channel (via ConfiguredApprovalChannel) denies and explains", async () => {
    const dataDir = tempDir();
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ live: true, approval: { channel: "carrier-pigeon" } })
    );
    const audit = new AuditStore(dataDir);
    let executed = false;
    const tool = gatedTool({
      handler: async () => {
        executed = true;
        return { content: "executed live" };
      },
    });
    const result = await executeGoverned(tool, { message: "hi" }, {
      audit,
      approval: new ConfiguredApprovalChannel(dataDir),
      getConfig: () => ({ live: true }),
      version: "0.0.0-test",
    });
    expect(executed).toBe(false);
    expect(result.text).toContain("NOT executed");
    const row = audit.list(1)[0];
    expect(row.approvalMethod).toBe("misconfigured");
    expect(row.detail).toContain("carrier-pigeon");
  });
});
