import { describe, expect, it } from "vitest";
import {
  assertWindow,
  calendarTools,
  eventCreate,
  eventDelete,
  eventsWindow,
} from "../src/tools.js";
import {
  buildCreateScript,
  buildEventsWindowScript,
  buildGetEventScript,
} from "../src/scripts.js";

describe("doctrine", () => {
  it("every tool name is verb_noun snake_case and scoped to Calendar only", () => {
    for (const tool of calendarTools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/);
      expect(tool.scope).toBe("Calendar");
    }
  });

  it("read tools keep the injection fence on", () => {
    for (const tool of calendarTools.filter((t) => t.mode === "read")) {
      expect(tool.fence).not.toBe(false);
    }
  });

  it("creation is write-safe (review-loop artifact), deletion is destructive", () => {
    expect(eventCreate.mode).toBe("write-safe");
    expect(eventCreate.undo).toBe("compensate");
    expect(eventDelete.mode).toBe("destructive");
  });

  it("deletion promises native undo and can plan it pre-write", () => {
    expect(eventDelete.undo).toBe("native");
    expect(typeof eventDelete.planUndo).toBe("function");
  });

  it("no tool takes attendees — invitations are structurally impossible", () => {
    for (const tool of calendarTools) {
      expect(Object.keys(tool.inputSchema)).not.toContain("attendees");
    }
  });

  it("created events carry provenance in their description", () => {
    const script = buildCreateScript({
      calendar: "Home",
      summary: "x",
      startIso: "2026-08-02T10:00:00.000Z",
      endIso: "2026-08-02T11:00:00.000Z",
      description: "user description",
      provenance: "created by event_create v0.1.0",
    });
    expect(script).toContain("created by event_create v0.1.0");
    expect(script).toContain("user description");
  });
});

describe("query bounds (Q20: ~30s per calendar — keep every query narrow)", () => {
  it("events_window rejects a window wider than 62 days before any script runs", () => {
    expect(() =>
      assertWindow("2026-01-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z")
    ).toThrow(/62 days/);
  });

  it("the handler itself refuses the wide window (no osascript call happens)", async () => {
    await expect(
      eventsWindow.handler(
        {
          calendar: "Home",
          startAfter: "2026-01-01T00:00:00.000Z",
          startBefore: "2026-06-01T00:00:00.000Z",
        },
        { live: false, provenance: "test" }
      )
    ).rejects.toThrow(/62 days/);
  });

  it("accepts an in-bounds window and rejects an inverted one", () => {
    expect(() =>
      assertWindow("2026-08-01T00:00:00.000Z", "2026-09-15T00:00:00.000Z")
    ).not.toThrow();
    expect(() =>
      assertWindow("2026-09-15T00:00:00.000Z", "2026-08-01T00:00:00.000Z")
    ).toThrow(/after startAfter/);
  });
});

describe("script injection safety", () => {
  it("user values enter scripts only as JSON string literals", () => {
    const hostile = `"); app.delete(app.calendars()); ("`;
    for (const script of [
      buildEventsWindowScript({
        calendar: hostile,
        startAfter: "2026-08-01T00:00:00.000Z",
        startBefore: "2026-08-02T00:00:00.000Z",
        limit: 5,
      }),
      buildCreateScript({
        calendar: "Home",
        summary: hostile,
        startIso: "2026-08-02T10:00:00.000Z",
        endIso: "2026-08-02T11:00:00.000Z",
        provenance: "p",
      }),
      buildGetEventScript("Home", hostile),
    ]) {
      // the payload must appear EXACTLY as its JSON string literal — quotes
      // escaped, breakout impossible — and never with an unescaped quote
      expect(script).toContain(JSON.stringify(hostile));
      expect(script).not.toMatch(/[^\\]"\); app\.delete/);
    }
  });

  it("window bounds render as real JS values, not string mush", () => {
    const script = buildEventsWindowScript({
      calendar: "Home",
      startAfter: "2026-08-01T00:00:00.000Z",
      startBefore: "2026-08-02T00:00:00.000Z",
      limit: 10,
    });
    expect(script).toContain('new Date("2026-08-01T00:00:00.000Z")');
    expect(script).toContain('new Date("2026-08-02T00:00:00.000Z")');
    expect(script).toContain("rows.length >= 10");
  });
});
