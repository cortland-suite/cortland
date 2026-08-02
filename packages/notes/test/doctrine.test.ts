import { describe, expect, it } from "vitest";
import { noteAppend, noteCreate, noteTools } from "../src/tools.js";
import {
  buildAppendScript,
  buildCreateScript,
  buildGetBodyScript,
  buildReadScript,
  buildSearchScript,
} from "../src/scripts.js";

describe("doctrine", () => {
  it("every tool name is verb_noun snake_case and scoped to Notes only", () => {
    for (const tool of noteTools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/);
      expect(tool.scope).toBe("Notes");
    }
  });

  it("read tools keep the injection fence on", () => {
    for (const tool of noteTools.filter((t) => t.mode === "read")) {
      expect(tool.fence).not.toBe(false);
    }
  });

  it("creation is write-safe (review-loop artifact), appending is gated", () => {
    expect(noteCreate.mode).toBe("write-safe");
    expect(noteAppend.mode).toBe("write-gated");
  });

  it("the gated mutation promises native undo and can plan it pre-write", () => {
    expect(noteAppend.undo).toBe("native");
    expect(typeof noteAppend.planUndo).toBe("function");
  });

  it("created notes carry provenance as the final line of their body", () => {
    const script = buildCreateScript({
      name: "x",
      body: "user body",
      provenance: "created by note_create v0.1.0",
    });
    expect(script).toContain("created by note_create v0.1.0");
    expect(script).toContain("user body");
    // provenance comes AFTER the user's text inside the one body literal
    expect(script.indexOf("user body")).toBeLessThan(
      script.indexOf("created by note_create v0.1.0")
    );
  });

  it("read paths strip HTML down to text inside the JXA", () => {
    for (const script of [
      buildSearchScript({ limit: 5 }),
      buildReadScript("x-coredata://note-1"),
    ]) {
      expect(script).toContain("replace(/<[^>]*>/g");
      expect(script).toContain("&amp;");
    }
    // the undo snapshot stays raw on purpose — restores must be byte-exact
    expect(buildGetBodyScript("x")).not.toContain("replace(/<[^>]*>/g");
  });
});

describe("script injection safety", () => {
  it("user values enter scripts only as JSON string literals", () => {
    const hostile = `"); app.delete(app.lists()); ("`;
    for (const script of [
      buildSearchScript({ folder: hostile, query: hostile, limit: 5 }),
      buildCreateScript({ name: hostile, body: hostile, provenance: "p" }),
      buildReadScript(hostile),
      buildGetBodyScript(hostile),
      buildAppendScript(hostile, hostile),
    ]) {
      // the payload must appear EXACTLY as its JSON string literal — quotes
      // escaped, breakout impossible — and never with an unescaped quote
      expect(script).toContain(JSON.stringify(hostile));
      expect(script).not.toMatch(/[^\\]"\); app\.delete/);
    }
  });

  it("search filters render as real JS values, not string mush", () => {
    const script = buildSearchScript({ query: "Groceries", limit: 10 });
    expect(script).toContain('const q = "groceries"');
    expect(script).toContain("rows.length >= 10");
  });
});
