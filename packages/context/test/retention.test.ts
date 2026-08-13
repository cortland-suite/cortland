import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { AuditStore } from "@cortland/governed";
import { DEFAULT_RETENTION_DAYS, loadContextConfig } from "../src/calendar.js";
import { pruneExpired } from "../src/retention.js";
import { ContextStore } from "../src/store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ctx-retention-"));

const DAY = 24 * 60 * 60 * 1000;
const OLD = new Date(Date.now() - 730 * DAY).toISOString();
const NEW = new Date(Date.now() - 1 * DAY).toISOString();
const CUTOFF = new Date(Date.now() - 30 * DAY).toISOString();

function seeded(dir: string): ContextStore {
  const store = new ContextStore(dir);
  store.upsertMessage({
    messageId: "old-msg",
    subject: "Ancient thread",
    sender: "Old Sender <old@example.com>",
    date: OLD,
    read: true,
    mailbox: "inbox",
  });
  store.upsertMessage({
    messageId: "new-msg",
    subject: "Current thread",
    sender: "New Sender <new@example.com>",
    date: NEW,
    read: false,
    mailbox: "inbox",
  });
  store.addRecipients("old-msg", ["a@example.com"]);
  store.addRecipients("new-msg", ["b@example.com"]);
  store.upsertEvent({
    uid: "old-evt", start: OLD, end: OLD, summary: "Ancient standup",
    location: null, calendar: "Work", allDay: false,
  });
  store.upsertEvent({
    uid: "new-evt", start: NEW, end: NEW, summary: "Current standup",
    location: null, calendar: "Work", allDay: false,
  });
  store.setEventAttendees("old-evt", OLD, [{ name: "A", email: "a@example.com" }]);
  store.notePerson("old@example.com", "Old Sender", "inbound", OLD);
  store.notePerson("new@example.com", "New Sender", "inbound", NEW);
  return store;
}

describe("retention (Q23)", () => {
  it("prunes messages, fts, recipients, events, attendees past the cutoff — keeps the rest", () => {
    const dir = tmp();
    const store = seeded(dir);
    const summary = store.pruneOlderThan(CUTOFF);
    expect(summary.messages).toBe(1);
    expect(summary.events).toBe(1);

    const db = new Database(path.join(dir, "context.db"));
    const ids = (db.prepare("SELECT message_id FROM messages").all() as Array<{ message_id: string }>)
      .map((r) => r.message_id);
    expect(ids).toEqual(["new-msg"]);
    expect(db.prepare("SELECT COUNT(*) c FROM messages_fts WHERE message_id = 'old-msg'").get())
      .toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM recipients WHERE message_id = 'old-msg'").get())
      .toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM recipients WHERE message_id = 'new-msg'").get())
      .toEqual({ c: 1 });
    expect(db.prepare("SELECT uid FROM events").all()).toEqual([{ uid: "new-evt" }]);
    expect(db.prepare("SELECT COUNT(*) c FROM event_attendees").get()).toEqual({ c: 0 });
  });

  it("NEVER touches people or judgments, at any age", () => {
    const dir = tmp();
    const store = seeded(dir);
    store.addJudgment({ target: "sender:old@example.com", verdict: "mute", sourceFile: "x.md" });
    store.pruneOlderThan(CUTOFF);
    const db = new Database(path.join(dir, "context.db"));
    // both senders' people rows survive even though old-msg is gone
    expect((db.prepare("SELECT COUNT(*) c FROM people").get() as { c: number }).c)
      .toBeGreaterThanOrEqual(2);
    expect(db.prepare("SELECT COUNT(*) c FROM judgments").get()).toEqual({ c: 1 });
  });

  it("prunes commitments by extraction age", () => {
    const dir = tmp();
    const store = seeded(dir);
    store.addCommitment({
      id: "c1", messageId: "old-msg", text: "send the deck", due: null, provider: "test",
    });
    // extracted_at is "now"; a cutoff after now prunes it, before now keeps it
    expect(store.pruneOlderThan("2020-01-01T00:00:00.000Z").commitments).toBe(0);
    expect(store.pruneOlderThan("2099-01-01T00:00:00.000Z").commitments).toBe(1);
  });

  it("pruneExpired: 0 disables entirely, and garbage never prunes", () => {
    const dir = tmp();
    const store = seeded(dir);
    const audit = new AuditStore(tmp());
    expect(pruneExpired(store, 0, audit, "test")).toBeNull();
    expect(pruneExpired(store, NaN, audit, "test")).toBeNull();
    expect(pruneExpired(store, -5, audit, "test")).toBeNull();
    const db = new Database(path.join(dir, "context.db"));
    expect(db.prepare("SELECT COUNT(*) c FROM messages").get()).toEqual({ c: 2 });
  });

  it("pruneExpired records an audit row with counts when it removes anything", () => {
    const dir = tmp();
    const store = seeded(dir);
    const audit = new AuditStore(tmp());
    const summary = pruneExpired(store, 30, audit, "test"); // OLD rows are years past 30d
    expect(summary!.messages).toBe(1);
    const row = audit.list(1)[0];
    expect(row.tool).toBe("context_prune");
    expect(row.args.messages).toBe(1);
    expect(row.args.retentionDays).toBe(30);
  });

  it("config: missing/invalid retentionDays → 365 default; explicit 0 honored", () => {
    const dir = tmp();
    expect(loadContextConfig(dir).retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    fs.writeFileSync(path.join(dir, "context.json"), JSON.stringify({ retentionDays: "forever" }));
    expect(loadContextConfig(dir).retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    fs.writeFileSync(path.join(dir, "context.json"), JSON.stringify({ retentionDays: 0 }));
    expect(loadContextConfig(dir).retentionDays).toBe(0);
    fs.writeFileSync(path.join(dir, "context.json"), JSON.stringify({ retentionDays: 90.9 }));
    expect(loadContextConfig(dir).retentionDays).toBe(90);
  });
});
