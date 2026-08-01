import { describe, expect, it } from "vitest";
import {
  buildDraftScript,
  buildMoveScript,
  buildReadScript,
  buildSearchScript,
} from "../src/scripts.js";

/**
 * Values are embedded via JSON.stringify, so hostile input stays a string
 * literal. An unescaped interpolation of the payload below would change the
 * script's syntax tree (or break it outright): `new Function` must still parse
 * the script, and the JSON-escaped form must be what appears in it.
 */
describe("script injection safety", () => {
  const hostile = `"; Mail.quit(); const x = "`;

  function expectSafelyEmbedded(script: string) {
    expect(() => new Function(script)).not.toThrow(); // still syntactically whole
    expect(script).not.toContain(`"${hostile}"`); // raw, unescaped embedding absent
  }

  it("search terms cannot escape their string literal", () => {
    const script = buildSearchScript({ subject: hostile, limit: 5 });
    expect(script).toContain(JSON.stringify(hostile)); // escaped form present
    expectSafelyEmbedded(script);
  });

  it("draft fields cannot escape their string literals", () => {
    expectSafelyEmbedded(
      buildDraftScript({
        account: "Personal",
        to: [`a@example.com${hostile}`],
        subject: hostile,
        body: `line1\nline2 ${hostile}`,
      })
    );
  });

  it("reply message ids cannot escape", () => {
    expectSafelyEmbedded(
      buildDraftScript({
        account: "Personal",
        body: "hello",
        replyToMessageId: hostile,
      })
    );
  });

  it("message ids and mailbox names cannot escape", () => {
    expectSafelyEmbedded(buildReadScript({ messageId: hostile }));
    expectSafelyEmbedded(
      buildMoveScript({ messageId: "x", account: hostile, toMailbox: hostile })
    );
  });
});

describe("search script shape", () => {
  it("no filters → the collection is taken whole, no message filter", () => {
    const script = buildSearchScript({ limit: 10 });
    expect(script).toContain("const coll = box.messages;");
    expect(script).not.toContain("_contains");
  });

  it("single filter → plain whose, no _and wrapper", () => {
    const script = buildSearchScript({ subject: "invoice", limit: 10 });
    expect(script).toContain("_contains");
    expect(script).not.toContain("_and");
  });

  it("multiple filters combine under _and", () => {
    const script = buildSearchScript({
      subject: "invoice",
      from: "billing",
      since: "2026-01-01T00:00:00Z",
      limit: 10,
    });
    expect(script).toContain("_and");
    expect(script).toContain("_greaterThan");
  });

  it("limit is embedded as a number, not user text", () => {
    const script = buildSearchScript({ limit: 33 });
    expect(script).toContain("rows.slice(0, 33)");
  });
});
