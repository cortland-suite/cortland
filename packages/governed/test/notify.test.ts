import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { FolderApprovalChannel } from "../src/approvalFolder.js";
import { AuditStore } from "../src/audit.js";
import { ConfiguredApprovalChannel } from "../src/approvalSelect.js";
import { loadApprovalConfig } from "../src/config.js";
import { NOTIFY_BODY, notifyUrlAllowed } from "../src/notify.js";
import { tempDir } from "./helpers.js";

const REQ = {
  tool: "demo_write",
  scope: "Test",
  mode: "write-gated" as const,
  summary: "Send the demo message to someone@example.com",
};

/** Loopback relay that records what a real ntfy server would see. */
function relay(): Promise<{
  url: string;
  hits: Array<{ body: string; title?: string }>;
  close: () => void;
}> {
  return new Promise((resolve) => {
    const hits: Array<{ body: string; title?: string }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        hits.push({ body, title: req.headers.title as string | undefined });
        res.writeHead(200).end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/topic-abc123`,
        hits,
        close: () => server.close(),
      });
    });
  });
}

function approveByMove(dir: string): void {
  const pending = fs.readdirSync(dir).find((n) => n.startsWith("pending-"))!;
  fs.renameSync(path.join(dir, pending), path.join(dir, "Approve", pending));
}

const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((c) => c()));

describe("approval push notification (Q19)", () => {
  it("pings the relay when a request is written — with an information-free body", async () => {
    const r = await relay();
    open.push(r.close);
    const dir = tempDir();
    const resultP = new FolderApprovalChannel({
      dir, timeoutSeconds: 10, pollSeconds: 1, notifyUrl: r.url,
    }).request(REQ);
    approveByMove(dir);
    await resultP;
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].body).toBe(NOTIFY_BODY);
    // the relay must learn NOTHING: no tool, no summary, no id, no path
    expect(r.hits[0].body).not.toContain("demo_write");
    expect(r.hits[0].body).not.toContain("example.com");
    expect(r.hits[0].body.length).toBeLessThan(80);
  });

  it("a dead relay never delays or breaks the approval itself", async () => {
    const dir = tempDir();
    const outcomes: boolean[] = [];
    const t0 = Date.now();
    const resultP = new FolderApprovalChannel({
      dir, timeoutSeconds: 10, pollSeconds: 1,
      notifyUrl: "http://127.0.0.1:9/unreachable", // port 9: nothing listens
      onNotifyResult: (res) => outcomes.push(res.ok),
    }).request(REQ);
    approveByMove(dir);
    const result = await resultP;
    expect(result.approved).toBe(true);
    expect(Date.now() - t0).toBeLessThan(8000); // approval never waited on the relay
  });

  it("no notify config → zero network attempts", async () => {
    const r = await relay();
    open.push(r.close);
    const dir = tempDir();
    const resultP = new FolderApprovalChannel({
      dir, timeoutSeconds: 10, pollSeconds: 1,
    }).request(REQ);
    approveByMove(dir);
    await resultP;
    expect(r.hits).toHaveLength(0);
  });

  it("config: https required (loopback http allowed); bad urls disable the ping, not the channel", () => {
    expect(notifyUrlAllowed("https://ntfy.sh/some-topic")).toBe(true);
    expect(notifyUrlAllowed("http://127.0.0.1:8080/t")).toBe(true);
    expect(notifyUrlAllowed("http://ntfy.example.com/t")).toBe(false);
    expect(notifyUrlAllowed("not a url")).toBe(false);

    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        approval: {
          channel: "folder", dir: "/tmp/x",
          notify: { url: "http://plaintext.example.com/topic" },
        },
      })
    );
    const spec = loadApprovalConfig(dir);
    expect(spec.channel).toBe("folder"); // channel survives
    if (spec.channel === "folder") expect(spec.notifyUrl).toBeUndefined();
  });

  it("every ping attempt lands in the audit log as declared egress — host only, never the topic", async () => {
    const r = await relay();
    open.push(r.close);
    const dataDir = tempDir();
    const approvals = tempDir();
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({
        live: true,
        approval: {
          channel: "folder", dir: approvals,
          timeoutSeconds: 10, pollSeconds: 1,
          notify: { url: r.url },
        },
      })
    );
    const audit = new AuditStore(dataDir);
    const channel = new ConfiguredApprovalChannel(dataDir, undefined, audit, "0.0.0-test");
    const resultP = channel.request(REQ);
    await new Promise((res) => setTimeout(res, 300)); // let the ping land
    approveByMove(approvals);
    await resultP;
    const row = audit.list(5).find((x) => x.tool === "approval_notify");
    expect(row?.outcome).toBe("ok");
    expect(row?.args.host).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(JSON.stringify(row?.args)).not.toContain("topic-abc123"); // topic is a secret
  });
});
