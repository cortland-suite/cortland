import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMdfindQuery,
  hasFullDiskAccess,
  parseEmlxHeaders,
} from "../src/fulltext.js";

describe("FDA probe", () => {
  it("readable dir → true", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fda-"));
    expect(hasFullDiskAccess(dir)).toBe(true);
  });

  it("missing/unreadable dir → false (never silently empty)", () => {
    expect(hasFullDiskAccess("/nonexistent/definitely/not/here")).toBe(false);
  });
});

describe("mdfind query escaping", () => {
  it("quotes and backslashes cannot terminate the literal", () => {
    const query = buildMdfindQuery(`say "hello" \\ world`);
    expect(query).toBe(`kMDItemTextContent == "*say \\"hello\\" \\\\ world*"cd`);
  });
});

describe("emlx header parsing", () => {
  const sample = [
    "2394", // emlx byte-count line
    "From: Sender Name <sender@example.com>",
    "To: someone@example.com",
    "Subject: A subject that is",
    "\tfolded across lines",
    "Message-ID: <abc-123@example.com>",
    "Date: Wed, 30 Jul 2026 09:00:00 -0500",
    "",
    "Body starts here and should not be parsed as a header",
    "Subject: fake header in body",
  ].join("\n");

  it("extracts and unfolds headers, strips Message-ID brackets", () => {
    const h = parseEmlxHeaders(sample, "/tmp/x.emlx");
    expect(h.messageId).toBe("abc-123@example.com");
    expect(h.subject).toBe("A subject that is folded across lines");
    expect(h.from).toBe("Sender Name <sender@example.com>");
    expect(h.date).toContain("2026");
  });

  it("stops at the blank line — body text is never a header", () => {
    const h = parseEmlxHeaders(sample, "/tmp/x.emlx");
    expect(h.subject).not.toContain("fake");
  });
});
