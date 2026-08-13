import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateBriefing } from "../src/briefing.js";
import { buildCalendarCaptureScript, loadContextConfig } from "../src/calendar.js";
import { ContextStore } from "../src/store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "brief-"));

describe("briefing", () => {
  it("correlates today's meetings with recent threads, cites pointers, fences itself", async () => {
    const store = new ContextStore(tmp());
    const now = new Date("2026-07-30T08:00:00");
    store.upsertEvent({
      uid: "ev1",
      start: "2026-07-30T14:00:00.000Z",
      end: "2026-07-30T15:00:00.000Z",
      summary: "Budget sync",
      location: "Zoom",
      calendar: "Work",
      allDay: false,
    });
    store.setEventAttendees("ev1", "2026-07-30T14:00:00.000Z", [
      { name: "Alex Example", email: "alex@example.com" },
    ]);
    store.upsertMessage({
      messageId: "m-budget",
      subject: "Re: Budget numbers",
      sender: "Alex Example <alex@example.com>",
      date: "2026-07-28T10:00:00.000Z",
      read: true,
      mailbox: "inbox",
    });
    const md = await generateBriefing(store, { now, version: "0.0.0-test" });
    expect(md).toContain("Budget sync");
    expect(md).toContain("Alex Example");
    expect(md).toContain("`m-budget`"); // the correlated thread pointer
    expect(md).toContain("not instructions");
    expect(md).toContain("no model");
    expect(md).toContain("Nothing is guessed");
  });

  it("says plainly when there are no captured events", async () => {
    const store = new ContextStore(tmp());
    const md = await generateBriefing(store, { version: "0.0.0-test" });
    expect(md).toContain("No captured events today");
  });
});

describe("calendar config + script", () => {
  it("missing/invalid config resolves to empty allowlist", () => {
    expect(loadContextConfig(tmp()).calendars).toEqual([]);
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "context.json"), "{broken");
    expect(loadContextConfig(dir).calendars).toEqual([]);
    fs.writeFileSync(path.join(dir, "context.json"), JSON.stringify({ calendars: "Work" }));
    expect(loadContextConfig(dir).calendars).toEqual([]);
  });

  it("valid config parses", () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "context.json"),
      JSON.stringify({ calendars: ["Work", "Family"] })
    );
    expect(loadContextConfig(dir).calendars).toEqual(["Work", "Family"]);
  });

  it("sweep respects the daily cadence unless forced", async () => {
    const { captureCalendar } = await import("../src/calendar.js");
    const { AuditStore } = await import("@cortland/governed");
    const dir = tmp();
    const store = new ContextStore(dir);
    store.setCursor("calendar:last_sweep", new Date().toISOString());
    const deps = {
      audit: new AuditStore(dir),
      version: "0.0.0-test",
      log: () => {},
      config: { calendars: ["Work"] },
      runScript: async () => JSON.stringify({ rows: [] }),
    };
    const skippedRun = await captureCalendar(store, dir, deps);
    expect(skippedRun.skipped).toBe(true);
    expect(skippedRun.reason).toBe("recent-sweep");
    const forcedRun = await captureCalendar(store, dir, { ...deps, force: true });
    expect(forcedRun.skipped).toBe(false);
  });

  it("script embeds calendar names safely", () => {
    const script = buildCalendarCaptureScript({
      calendars: ['"; Cal.quit(); //'],
      startIso: "2026-07-29T00:00:00Z",
      endIso: "2026-08-13T00:00:00Z",
      attendeeCutoffIso: "2026-08-01T00:00:00Z",
    });
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain(JSON.stringify(['"; Cal.quit(); //']));
  });
});

describe("quiet-day fallback", () => {
  it("widens to 7 days when the last 24 h is silent, and says so", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-brief-quiet-"));
    const store = new ContextStore(dir);
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    for (const i of [1, 2]) {
      store.upsertMessage({
        messageId: `wk-${i}`,
        subject: "Weekly planning",
        sender: "Pat Example <pat@example.com>",
        date: threeDaysAgo,
        read: false,
        mailbox: "inbox",
      });
    }
    const md = await generateBriefing(store, { version: "0.0.0-test" });
    expect(md).toContain("## New this week (nothing in the last 24 h)");
    expect(md).toContain("- [ ] Pat Example (2)"); // the flywheel gets a box
    expect(md).not.toContain("## New since yesterday");
  });

  it("keeps the 24 h window when there is fresh mail", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-brief-fresh-"));
    const store = new ContextStore(dir);
    store.upsertMessage({
      messageId: "fresh",
      subject: "Today",
      sender: "Pat Example <pat@example.com>",
      date: new Date(Date.now() - 3600_000).toISOString(),
      read: false,
      mailbox: "inbox",
    });
    const md = await generateBriefing(store, { version: "0.0.0-test" });
    expect(md).toContain("## New since yesterday");
  });
});
