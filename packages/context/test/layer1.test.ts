import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractCommitments } from "../src/commitments.js";
import { parseBriefingCorrections, ingestCorrections } from "../src/corrections.js";
import { CommandProvider, extractJsonArray, makeProvider, ModelConfigSchema } from "../src/model.js";
import { answerStandingQuestions, parseStandingQuestions } from "../src/questions.js";
import { generateBriefing } from "../src/briefing.js";
import { ContextStore } from "../src/store.js";
import type { ModelProvider } from "../src/model.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "l1-"));

function fakeProvider(reply: string, network = false): ModelProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: "fake",
    network,
    description: "test double",
    prompts,
    async complete(prompt: string) {
      prompts.push(prompt);
      return reply;
    },
  };
}

describe("model config + providers", () => {
  it("command config defaults to network=true — egress assumed unless declared", () => {
    const parsed = ModelConfigSchema.parse({ type: "command", run: ["my-llm"] });
    expect(parsed.type === "command" && parsed.network).toBe(true);
  });

  it("no config → no provider → nothing is guessed", () => {
    expect(makeProvider(undefined)).toBeNull();
  });

  it("command provider round-trips through a real process", async () => {
    const provider = new CommandProvider(["cat"], false, "echo test");
    expect(await provider.complete("hello layer one")).toBe("hello layer one");
  });

  it("extractJsonArray tolerates fences and prose", () => {
    expect(extractJsonArray('Here you go:\n```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
    expect(() => extractJsonArray("no array here")).toThrow();
  });
});

describe("standing questions", () => {
  const yaml = `
questions:
  - id: invoices
    ask: "Any invoice activity this week?"
    keywords: ["invoice"]
`;

  it("parses valid yaml and rejects bad ids", () => {
    expect(parseStandingQuestions(yaml)[0].id).toBe("invoices");
    expect(() =>
      parseStandingQuestions('questions:\n  - id: "Bad Id!"\n    ask: "x?"')
    ).toThrow(/invalid standing-questions/);
  });

  it("deterministic candidates come from FTS; model answers over fenced data", async () => {
    const store = new ContextStore(tmp());
    store.upsertMessage({
      messageId: "m-inv",
      subject: "Invoice #42 due",
      sender: "Billing <billing@example.com>",
      date: new Date().toISOString(),
      read: false,
      mailbox: "inbox",
    });
    const questions = parseStandingQuestions(yaml);
    const noModel = await answerStandingQuestions(store, questions, null);
    expect(noModel[0].candidates.map((c) => c.messageId)).toContain("m-inv");
    expect(noModel[0].answer).toBeUndefined();

    const provider = fakeProvider("Yes — invoice #42 is due `m-inv`.");
    const withModel = await answerStandingQuestions(store, questions, provider);
    expect(withModel[0].answer).toContain("m-inv");
    expect(provider.prompts[0]).toContain("untrusted-content"); // data was fenced
  });
});

describe("commitments", () => {
  it("extracts, stores immutably, and refuses invented pointers", async () => {
    const store = new ContextStore(tmp());
    store.upsertMessage({
      messageId: "s1",
      subject: "Re: numbers",
      sender: "Me <me@example.com>",
      date: new Date().toISOString(),
      read: true,
      mailbox: "sent",
    });
    const provider = fakeProvider(
      JSON.stringify([
        { messageId: "s1", text: "Send the numbers by Friday", due: null },
        { messageId: "invented-id", text: "Fake", due: null },
      ])
    );
    const summary = await extractCommitments(store, {
      provider,
      log: () => {},
      fetchBody: async () => "I'll send the numbers by Friday.",
    });
    expect(summary.extracted).toBe(1); // invented pointer dropped
    expect(store.openCommitments()[0].text).toContain("numbers");
    expect(provider.prompts[0]).toContain("untrusted-content");

    // Immutable + idempotent: a second run extracts nothing new.
    const again = await extractCommitments(store, {
      provider,
      log: () => {},
      fetchBody: async () => "I'll send the numbers by Friday.",
    });
    expect(again.extracted).toBe(0);
  });
});

describe("corrections flywheel", () => {
  it("checked boxes and correction notes become judgments; mutes apply", async () => {
    const dir = tmp();
    const store = new ContextStore(dir);
    store.upsertMessage({
      messageId: "noisy1",
      subject: "SALE SALE SALE",
      sender: "Promo <promo@example.com>",
      date: new Date().toISOString(),
      read: false,
      mailbox: "inbox",
    });
    fs.writeFileSync(
      path.join(dir, "2026-07-29.md"),
      [
        "## New since yesterday",
        "- [x] Promo (3) — `noisy1` <!-- id:sender:promo@example.com -->",
        "- [ ] Keep Me (1) — `k1` <!-- id:sender:keep@example.com -->",
        "## Corrections",
        "- missed: the thread with the venue",
      ].join("\n")
    );
    const ingested = ingestCorrections(store, dir, () => {});
    expect(ingested).toBe(2); // one mute + one note; unchecked box ignored
    expect(store.mutedTargets().has("sender:promo@example.com")).toBe(true);

    const changes = store.changesSince("2000-01-01T00:00:00Z");
    expect(changes.topSenders.find((s) => s.address === "promo@example.com")).toBeUndefined();

    // Idempotent per (target, file).
    expect(ingestCorrections(store, dir, () => {})).toBe(0);
  });

  it("briefing items carry ids and the corrections section", async () => {
    const store = new ContextStore(tmp());
    store.upsertMessage({
      messageId: "m1",
      subject: "Hello",
      sender: "Alex <alex@example.com>",
      date: new Date().toISOString(),
      read: false,
      mailbox: "inbox",
    });
    const md = await generateBriefing(store, { version: "0.0.0-test" });
    expect(md).toContain("<!-- id:sender:alex@example.com -->");
    expect(md).toContain("## Corrections");
    expect(parseBriefingCorrections(md)).toEqual([]); // nothing checked yet
  });
});
