import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AuditStore, defineTool } from "@cortland/governed";
import { startGateway } from "../src/gateway.js";
import { TokenStore } from "../src/tokens.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "remote-"));

/** A miniature mount standing in for mail: one read tool, one gated tool. */
function testMount(onExecute?: () => void) {
  return {
    name: "mail",
    version: "0.0.0-test",
    tools: [
      defineTool({
        name: "demo_search",
        description: "read tool",
        scope: "Test",
        mode: "read" as const,
        undo: "none" as const,
        inputSchema: { q: z.string() },
        handler: async (args: { q: string }) => ({ content: `results for ${args.q}` }),
      }),
      defineTool({
        name: "demo_send",
        description: "gated tool",
        scope: "Test",
        mode: "write-gated" as const,
        undo: "none" as const,
        inputSchema: { body: z.string() },
        handler: async () => {
          onExecute?.();
          return { content: "sent" };
        },
      }),
    ],
  };
}

interface Rig {
  port: number;
  dataDir: string;
  close: () => Promise<void>;
}

const open: Rig[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const r of open.splice(0)) await r.close();
});

async function rig(onExecute?: () => void): Promise<Rig & { tokens: TokenStore }> {
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ live: false }));
  const gateway = await startGateway({
    dataDir,
    port: 0, // ephemeral
    mounts: [testMount(onExecute)],
  });
  const r = { port: gateway.port, dataDir, close: gateway.close, tokens: new TokenStore(dataDir) };
  open.push(r);
  return r;
}

async function connect(port: number, token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/mail`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  clients.push(client);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

describe("gateway auth", () => {
  it("no token → 401; garbage token → 401; nothing served", async () => {
    const r = await rig();
    for (const headers of [{}, { Authorization: "Bearer hc_wrong" }]) {
      const res = await fetch(`http://127.0.0.1:${r.port}/mcp/mail`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(res.status).toBe(401);
    }
  });

  it("a request with an Origin header is refused even with a valid token", async () => {
    const r = await rig();
    const { token } = r.tokens.mint("write", "test");
    const res = await fetch(`http://127.0.0.1:${r.port}/mcp/mail`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("a revoked token stops working immediately", async () => {
    const r = await rig();
    const { token, record } = r.tokens.mint("read", "test");
    const client = await connect(r.port, token);
    await client.callTool({ name: "demo_search", arguments: { q: "x" } });
    r.tokens.revoke(record.id);
    await expect(
      connect(r.port, token)
    ).rejects.toThrow();
  });
});

describe("scopes (M1 exit criteria)", () => {
  it("read token: read tool works end to end over HTTP", async () => {
    const r = await rig();
    const { token } = r.tokens.mint("read", "laptop");
    const client = await connect(r.port, token);
    const result = await client.callTool({ name: "demo_search", arguments: { q: "hello" } });
    expect(text(result)).toContain("results for hello");
  });

  it("read token on a gated tool: refused BEFORE the gate, with the audit row", async () => {
    let executed = false;
    const r = await rig(() => (executed = true));
    const { token, record } = r.tokens.mint("read", "laptop");
    const client = await connect(r.port, token);
    const result = await client.callTool({ name: "demo_send", arguments: { body: "hi" } });
    expect(text(result)).toContain("read scope");
    expect(executed).toBe(false);
    const audit = new AuditStore(r.dataDir);
    const row = audit.list(5).find((x) => x.tool === "demo_send");
    expect(row?.outcome).toBe("denied");
    expect(row?.detail).toContain("read-scope");
    expect(row?.principal).toContain(`token:${record.id}`);
    audit.close();
  });

  it("write token: gated tool reaches the normal gate (dry-run when live is off)", async () => {
    let executed = false;
    const r = await rig(() => (executed = true));
    const { token } = r.tokens.mint("write", "laptop");
    const client = await connect(r.port, token);
    const result = await client.callTool({ name: "demo_send", arguments: { body: "hi" } });
    expect(text(result)).toContain("[DRY-RUN]");
    expect(executed).toBe(false);
  });

  it("every remote audit row carries the principal", async () => {
    const r = await rig();
    const { token, record } = r.tokens.mint("read", "phone");
    const client = await connect(r.port, token);
    await client.callTool({ name: "demo_search", arguments: { q: "x" } });
    const audit = new AuditStore(r.dataDir);
    const row = audit.list(5).find((x) => x.tool === "demo_search");
    expect(row?.principal).toMatch(new RegExp(`^token:${record.id} session:[0-9a-f]{8}$`));
    audit.close();
  });
});

describe("tokens", () => {
  it("mint → verify → revoke lifecycle; hashes only on disk", async () => {
    const dir = tmp();
    const store = new TokenStore(dir);
    const { token, record } = store.mint("read", "life");
    expect(store.verify(token)?.id).toBe(record.id);
    expect(store.verify("hc_nope")).toBeNull();
    expect(store.verify(undefined)).toBeNull();
    const raw = fs.readFileSync(path.join(dir, "remote-tokens.json"), "utf8");
    expect(raw).not.toContain(token); // the secret is nowhere on disk
    const mode = fs.statSync(path.join(dir, "remote-tokens.json")).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(store.revoke(record.id)).toBe(true);
    expect(store.verify(token)).toBeNull();
  });
});
