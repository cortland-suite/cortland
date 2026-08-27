import { describe, expect, it } from "vitest";
import { mailTools, mailCreateDraft, mailMark, mailMove } from "../src/tools.js";

/** The doctrine of docs/02, encoded as tests so it cannot drift silently. */
describe("mail doctrine", () => {
  it("mail_send exists and is write-gated — house doctrine is send gated, not send absent", () => {
    const names = mailTools.map((t) => t.name);
    expect(names).toContain("mail_send");
    const send = mailTools.find((t) => t.name === "mail_send");
    expect(send?.mode).toBe("write-gated");
    expect(send?.undo).toBe("compensate");
    expect(send?.redact).toContain("body");
  });

  it("reads are read, drafts are write-safe, send and mutations are gated", () => {
    const modes = Object.fromEntries(mailTools.map((t) => [t.name, t.mode]));
    expect(modes).toEqual({
      mail_list_accounts: "read",
      mail_search: "read",
      mail_search_fulltext: "read",
      mail_read: "read",
      mail_thread: "read",
      mail_create_draft: "write-safe",
      mail_send: "write-gated",
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
