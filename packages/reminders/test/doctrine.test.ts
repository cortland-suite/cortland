import { describe, expect, it } from "vitest";
import {
  reminderComplete,
  reminderCreate,
  reminderDelete,
  reminderTools,
} from "../src/tools.js";
import {
  buildCreateScript,
  buildGetScript,
  buildSearchScript,
} from "../src/scripts.js";

describe("doctrine", () => {
  it("every tool name is verb_noun snake_case and scoped to Reminders only", () => {
    for (const tool of reminderTools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/);
      expect(tool.scope).toBe("Reminders");
    }
  });

  it("read tools keep the injection fence on", () => {
    for (const tool of reminderTools.filter((t) => t.mode === "read")) {
      expect(tool.fence).not.toBe(false);
    }
  });

  it("creation is write-safe (review-loop artifact), mutation is gated, deletion is destructive", () => {
    expect(reminderCreate.mode).toBe("write-safe");
    expect(reminderComplete.mode).toBe("write-gated");
    expect(reminderDelete.mode).toBe("destructive");
  });

  it("gated mutations promise native undo and can plan it pre-write", () => {
    for (const tool of [reminderComplete, reminderDelete]) {
      expect(tool.undo).toBe("native");
      expect(typeof tool.planUndo).toBe("function");
    }
  });

  it("created reminders carry provenance in their notes", () => {
    const script = buildCreateScript({
      name: "x",
      notes: "user notes",
      provenance: "created by reminder_create v0.1.0",
    });
    expect(script).toContain("created by reminder_create v0.1.0");
    expect(script).toContain("user notes");
  });
});

describe("script injection safety", () => {
  it("user values enter scripts only as JSON string literals", () => {
    const hostile = `"); app.delete(app.lists()); ("`;
    for (const script of [
      buildSearchScript({ list: hostile, limit: 5 }),
      buildCreateScript({ name: hostile, provenance: "p" }),
      buildGetScript(hostile),
    ]) {
      // the payload must appear EXACTLY as its JSON string literal — quotes
      // escaped, breakout impossible — and never with an unescaped quote
      expect(script).toContain(JSON.stringify(hostile));
      expect(script).not.toMatch(/[^\\]"\); app\.delete/);
    }
  });

  it("search filters render as real JS values, not string mush", () => {
    const script = buildSearchScript({
      dueBefore: "2026-08-02T00:00:00.000Z",
      includeCompleted: true,
      limit: 10,
    });
    expect(script).toContain('new Date("2026-08-02T00:00:00.000Z")');
    expect(script).toContain("const includeCompleted = true");
    expect(script).toContain("rows.length >= 10");
  });
});
