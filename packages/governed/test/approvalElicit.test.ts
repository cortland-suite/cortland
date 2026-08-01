import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ElicitationApprovalChannel } from "../src/approvalElicit.js";
import { createGovernedServer } from "../src/server.js";
import { loadApprovalConfig } from "../src/config.js";
import { gatedTool, tempDir } from "./helpers.js";

/**
 * The real protocol, end to end: a governed server and an MCP client joined
 * by an in-memory transport. The client declares the elicitation capability
 * and answers the Approve/Deny prompt from ITS side — exactly what Claude
 * Desktop or any capable client does with a human. The model's only role is
 * calling the tool; the decision arrives out-of-band.
 */

type ElicitAnswer =
  | { action: "accept"; content: { confirm: boolean } }
  | { action: "decline" }
  | { action: "cancel" };

async function rig(opts: {
  live: boolean;
  approvalConfig?: unknown;
  clientElicits: boolean;
  answer?: ElicitAnswer;
}) {
  const dataDir = tempDir();
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      live: opts.live,
      // auto is opt-in since the Claude Code auto-decline finding; these
      // tests exercise the ladder, so they opt in explicitly
      approval: opts.approvalConfig ?? { channel: "auto" },
    })
  );
  let executed = 0;
  const prompts: string[] = [];
  const tool = gatedTool({
    handler: async () => {
      executed += 1;
      return { content: "executed live" };
    },
  });
  const governed = createGovernedServer({
    name: "elicit-test",
    version: "0.0.0-test",
    dataDir,
    tools: [tool],
  });
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: opts.clientElicits ? { elicitation: {} } : {} }
  );
  if (opts.clientElicits) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return opts.answer ?? { action: "decline" };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    governed.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const call = () =>
    client.callTool({ name: "demo_write", arguments: { message: "hi" } });
  return {
    call,
    audit: governed.audit,
    executedCount: () => executed,
    prompts,
  };
}

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

describe("elicitation approval (end to end over the real protocol)", () => {
  it("human accepts in the client UI → handler runs; audit says elicit", async () => {
    const r = await rig({
      live: true,
      clientElicits: true,
      answer: { action: "accept", content: { confirm: true } },
    });
    const result = await r.call();
    expect(firstText(result)).toBe("executed live");
    expect(r.executedCount()).toBe(1);
    expect(r.prompts[0]).toContain("demo_write");
    expect(r.prompts[0]).toContain("Scope: Test");
    const row = r.audit.list(1)[0];
    expect(row.outcome).toBe("ok");
    expect(row.approvalMethod).toBe("elicit");
  });

  it("human declines → handler never runs", async () => {
    const r = await rig({
      live: true,
      clientElicits: true,
      answer: { action: "decline" },
    });
    const result = await r.call();
    expect(firstText(result)).toContain("NOT executed");
    expect(r.executedCount()).toBe(0);
    expect(r.audit.list(1)[0].outcome).toBe("denied");
  });

  it("accepted form but confirm is false → denied (no accidental yes)", async () => {
    const r = await rig({
      live: true,
      clientElicits: true,
      answer: { action: "accept", content: { confirm: false } },
    });
    const result = await r.call();
    expect(firstText(result)).toContain("NOT executed");
    expect(r.executedCount()).toBe(0);
  });

  it("dry-run still wins over everything: live=false never even prompts", async () => {
    const r = await rig({
      live: false,
      clientElicits: true,
      answer: { action: "accept", content: { confirm: true } },
    });
    const result = await r.call();
    expect(firstText(result)).toContain("[DRY-RUN]");
    expect(r.executedCount()).toBe(0);
    expect(r.prompts).toHaveLength(0); // no approval consulted for a no-op
  });

  it('explicit elicit with fallback "none": incapable client → denied, not dialog', async () => {
    const r = await rig({
      live: true,
      approvalConfig: { channel: "elicit" }, // fallback defaults to none
      clientElicits: false,
    });
    const result = await r.call();
    expect(firstText(result)).toContain("NOT executed");
    expect(r.executedCount()).toBe(0);
    const row = r.audit.list(1)[0];
    expect(row.detail).toContain("does not support elicitation");
  });
});

describe("elicitation channel unit behavior", () => {
  it("no server / no client → unsupported and denies", async () => {
    const channel = new ElicitationApprovalChannel(() => undefined);
    expect(channel.supported()).toBe(false);
    const result = await channel.request({
      tool: "demo_write",
      scope: "Test",
      mode: "write-gated",
      summary: "x",
    });
    expect(result.approved).toBe(false);
    expect(result.detail).toBe("channel-error");
  });

  it('config: "elicit" parses with fallback none by default, dialog when named', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ approval: { channel: "elicit" } })
    );
    expect(loadApprovalConfig(dir)).toEqual({
      channel: "elicit",
      fallback: "none",
      timeoutSeconds: undefined,
    });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ approval: { channel: "elicit", fallback: "dialog" } })
    );
    expect(loadApprovalConfig(dir).channel).toBe("elicit");
  });
});
