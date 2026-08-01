import { describe, expect, it } from "vitest";
import { mailTools, mailCreateDraft, mailMark, mailMove } from "../src/tools.js";

/** The doctrine of docs/02, encoded as tests so it cannot drift silently. */
describe("mail doctrine", () => {
  it("there is NO send tool — draft-first is structural, not policy", () => {
    const names = mailTools.map((t) => t.name);
    expect(names).not.toContain("mail_send");
    expect(names.some((n) => n.includes("send"))).toBe(false);
  });

  it("reads are read, drafts are write-safe, mutations are gated", () => {
    const modes = Object.fromEntries(mailTools.map((t) => [t.name, t.mode]));
    expect(modes).toEqual({
      mail_list_accounts: "read",
      mail_search: "read",
      mail_search_fulltext: "read",
      mail_read: "read",
      mail_thread: "read",
      mail_create_draft: "write-safe",
      mail_mark: "write-gated",
      mail_move: "write-gated",
    });
  });

  it("every tool touches exactly the Mail scope", () => {
    for (const tool of mailTools) expect(tool.scope).toBe("Mail");
  });

  it("draft body is redacted from the audit log", () => {
    expect(mailCreateDraft.redact).toContain("body");
  });

  it("draft requires an explicit account — identity is never guessed", () => {
    expect(mailCreateDraft.inputSchema.account.isOptional()).toBe(false);
  });

  it("gated mutations promise native undo and can plan it pre-write", () => {
    for (const tool of [mailMark, mailMove]) {
      expect(tool.undo).toBe("native");
      expect(typeof tool.planUndo).toBe("function");
    }
  });

  it("read tools keep the injection fence on", () => {
    for (const tool of mailTools.filter((t) => t.mode === "read")) {
      expect(tool.fence).not.toBe(false);
    }
  });
});
