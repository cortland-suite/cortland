import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditStore } from "@cortland/governed";
import { captureOnce } from "../src/capture.js";
import { buildCaptureScript } from "../src/scripts.js";
import { ContextStore } from "../src/store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ctxcap-"));

function fixtureExec(byMailbox: Record<string, unknown[]>) {
  const calls: string[] = [];
  const exec = async (script: string) => {
    calls.push(script);
    const mailbox = script.includes("Mail.inbox") ? "inbox" : "sent";
    const rows = byMailbox[mailbox] ?? [];
    return JSON.stringify({ total: rows.length, rows });
  };
  return { exec, calls };
}

describe("captureOnce", () => {
  it("ingests headers, builds the people graph, advances cursors, audits", async () => {
    const dir = tmp();
    const store = new ContextStore(dir);
    const audit = new AuditStore(dir);
    const { exec } = fixtureExec({
      inbox: [
        {
          messageId: "in1",
          subject: "Hello",
          sender: "Alex Example <alex@example.com>",
          date: "2026-07-30T10:00:00.000Z",
          read: false,
          mailbox: "inbox",
        },
      ],
      sent: [
        {
          messageId: "out1",
          subject: "Re: Hello",
          sender: "Me <me@example.com>",
          date: "2026-07-30T11:00:00.000Z",
          read: true,
          mailbox: "sent",
          recipients: ["alex@example.com"],
        },
      ],
    });
    const summary = await captureOnce(store, {
      audit,
      version: "0.0.0-test",
      log: () => {},
      runScript: exec,
    });
    expect(summary.inbox.new).toBe(1);
    expect(summary.sent.new).toBe(1);
    const [person] = store.findPeople("alex");
    expect(person.inboundCount).toBe(1);
    expect(person.outboundCount).toBe(1);
    expect(store.getCursor("mail:inbox")).toBe("2026-07-30T10:00:00.000Z");
    expect(store.getCursor("mail:sent")).toBe("2026-07-30T11:00:00.000Z");
    const row = audit.list()[0];
    expect(row.tool).toBe("context_capture");
    expect(row.args.inboxNew).toBe(1);
  });

  it("re-running with the same data ingests nothing new", async () => {
    const dir = tmp();
    const store = new ContextStore(dir);
    const audit = new AuditStore(dir);
    const data = {
      inbox: [
        {
          messageId: "in1",
          subject: "Hello",
          sender: "a@example.com",
          date: "2026-07-30T10:00:00.000Z",
          read: false,
          mailbox: "inbox",
        },
      ],
      sent: [],
    };
    const deps = {
      audit,
      version: "0.0.0-test",
      log: () => {},
      runScript: fixtureExec(data).exec,
    };
    await captureOnce(store, deps);
    const second = await captureOnce(store, deps);
    expect(second.inbox.new).toBe(0);
    expect(store.counts().messages).toBe(1);
  });

  it("capture scripts never fetch bodies and embed values safely", () => {
    const script = buildCaptureScript({
      mailbox: "inbox",
      sinceIso: '"; Mail.quit(); //',
      max: 100,
      withRecipients: false,
    });
    expect(script).not.toContain(".content(");
    expect(() => new Function(script)).not.toThrow();
    const sent = buildCaptureScript({
      mailbox: "sent",
      sinceIso: "2026-01-01T00:00:00Z",
      max: 100,
      withRecipients: true,
    });
    expect(sent).toContain("toRecipients");
    expect(sent).not.toContain(".content(");
  });
});
