import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditStore } from "@honeycrisp/governed";
import { ContextStore } from "../src/store.js";
import { makeContextTools } from "../src/tools.js";

describe("context serve doctrine", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxdoc-"));
  const tools = makeContextTools(new ContextStore(dir), new AuditStore(dir), "0.0.0");

  it("serve tools read the STORE, not Mail — scope says so", () => {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.context_changes.scope).toBe("ContextStore");
    expect(byName.context_person.scope).toBe("ContextStore");
    expect(byName.context_changes.mode).toBe("read");
    expect(byName.context_person.mode).toBe("read");
  });

  it("capture is write-safe (local store artifact), never gated reads", () => {
    const capture = tools.find((t) => t.name === "context_capture_now")!;
    expect(capture.mode).toBe("write-safe");
    expect(capture.scope).toBe("Mail→ContextStore");
  });

  it("read tools keep the injection fence on", () => {
    for (const tool of tools.filter((t) => t.mode === "read")) {
      expect(tool.fence).not.toBe(false);
    }
  });
});
