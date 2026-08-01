import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ContextStore, normalizeSubject, parseAddress } from "../src/store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ctx-"));

function msg(id: string, over: Partial<Parameters<ContextStore["upsertMessage"]>[0]> = {}) {
  return {
    messageId: id,
    subject: "Project update",
    sender: "Alex Example <alex@example.com>",
    date: "2026-07-30T12:00:00.000Z",
    read: false,
    mailbox: "inbox",
    ...over,
  };
}

describe("store", () => {
  it("context.db is created mode 600 — the index of a life is sensitive", () => {
    const dir = tmp();
    new ContextStore(dir);
    const mode = fs.statSync(path.join(dir, "context.db")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("upsert is idempotent on messageId", () => {
    const store = new ContextStore(tmp());
    expect(store.upsertMessage(msg("a"))).toBe(true);
    expect(store.upsertMessage(msg("a"))).toBe(false);
    expect(store.counts().messages).toBe(1);
  });

  it("stores headers and pointers ONLY — no body column exists anywhere", () => {
    const dir = tmp();
    new ContextStore(dir);
    const db = new Database(path.join(dir, "context.db"));
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'messages_fts%'`
      )
      .all() as Array<{ name: string }>;
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      const columns = db
        .prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`)
        .all() as Array<{ name: string }>;
      for (const col of columns) {
        expect(col.name.toLowerCase()).not.toMatch(/^(body|content|text)$/);
      }
    }
  });

  it("people counts accumulate by direction and keep best-known name", () => {
    const store = new ContextStore(tmp());
    store.notePerson("alex@example.com", null, "inbound", "2026-07-01T00:00:00Z");
    store.notePerson("Alex@Example.com", "Alex Example", "inbound", "2026-07-02T00:00:00Z");
    store.notePerson("alex@example.com", null, "outbound", "2026-07-03T00:00:00Z");
    const [person] = store.findPeople("alex");
    expect(person.inboundCount).toBe(2);
    expect(person.outboundCount).toBe(1);
    expect(person.name).toBe("Alex Example");
    expect(person.firstSeen).toBe("2026-07-01T00:00:00Z");
    expect(person.lastSeen).toBe("2026-07-03T00:00:00Z");
  });

  it("changesSince aggregates volume, senders, subjects with citations", () => {
    const store = new ContextStore(tmp());
    store.upsertMessage(msg("m1", { subject: "Re: Budget" }));
    store.upsertMessage(msg("m2", { subject: "Budget" }));
    store.upsertMessage(msg("m3", { subject: "Lunch", date: "2026-07-01T00:00:00.000Z" }));
    const changes = store.changesSince("2026-07-29T00:00:00.000Z");
    expect(changes.newMessageCount).toBe(2); // m3 is older
    expect(changes.activeSubjects[0].subject).toBe("budget");
    expect(changes.activeSubjects[0].citations).toContain("m1");
    expect(changes.topSenders[0].sender).toBe("Alex Example");
  });

  it("person profile links outbound mail via recipients", () => {
    const store = new ContextStore(tmp());
    store.upsertMessage(
      msg("out1", { mailbox: "sent", sender: "Me <me@example.com>", subject: "Ping" })
    );
    store.addRecipients("out1", ["alex@example.com"]);
    store.notePerson("alex@example.com", null, "outbound", "2026-07-30T12:00:00Z");
    const [person] = store.findPeople("alex@example.com");
    expect(person.recentMessages.map((m) => m.messageId)).toContain("out1");
  });
});

describe("address parsing", () => {
  it("handles the common shapes", () => {
    expect(parseAddress("Alex Example <alex@example.com>")).toEqual({
      name: "Alex Example",
      address: "alex@example.com",
    });
    expect(parseAddress('"Example, Alex" <ALEX@example.com>')).toEqual({
      name: "Example, Alex",
      address: "alex@example.com",
    });
    expect(parseAddress("alex@example.com")).toEqual({
      name: null,
      address: "alex@example.com",
    });
    expect(parseAddress("Just A Name")).toEqual({ name: "Just A Name", address: null });
    expect(parseAddress(null)).toEqual({ name: null, address: null });
  });
});

describe("subject normalization", () => {
  it("strips reply/forward prefixes recursively", () => {
    expect(normalizeSubject("Re: RE: Fwd: Budget")).toBe("budget");
  });
});
