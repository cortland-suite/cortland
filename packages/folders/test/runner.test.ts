import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditStore } from "@honeycrisp/governed";
import { parsePipelineYaml } from "../src/config.js";
import { runPipeline } from "../src/runner.js";
import {
  errorPath,
  icloudPlaceholderTarget,
  resultPath,
  shouldIgnore,
} from "../src/results.js";

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folders-"));
  const audit = new AuditStore(dir);
  return { dir, audit, deps: { audit, version: "0.0.0-test", log: () => {} } };
}

describe("runner", () => {
  it("runs steps, chains stdout→stdin, writes result with provenance, audits ok", async () => {
    const { dir, audit, deps } = rig();
    const input = path.join(dir, "note.txt");
    fs.writeFileSync(input, "hello folder pipelines");
    const cfg = parsePipelineYaml(`
name: upper
steps:
  - name: read
    run: ["cat", "{input}"]
  - name: shout
    run: ["tr", "a-z", "A-Z"]
`);
    const outcome = await runPipeline(cfg, dir, input, deps);
    expect(outcome.ok).toBe(true);
    const result = fs.readFileSync(resultPath(input), "utf8");
    expect(result).toContain("HELLO FOLDER PIPELINES");
    expect(result).toContain('created by honeycrisp-folders v0.0.0-test, pipeline "upper"');
    const row = audit.list()[0];
    expect(row.tool).toBe("pipeline_upper");
    expect(row.outcome).toBe("ok");
    expect(row.args.input).toBe("note.txt");
  });

  it("a failing step writes a plain-English error file and audits the failure", async () => {
    const { dir, audit, deps } = rig();
    const input = path.join(dir, "bad.txt");
    fs.writeFileSync(input, "x");
    const cfg = parsePipelineYaml(`
name: doomed
steps:
  - name: nope
    run: ["/nonexistent/binary", "{input}"]
`);
    const outcome = await runPipeline(cfg, dir, input, deps);
    expect(outcome.ok).toBe(false);
    const error = fs.readFileSync(errorPath(input), "utf8");
    expect(error).toContain('failed at step "nope"');
    expect(error).toContain("drop the file again");
    const row = audit.list()[0];
    expect(row.outcome).toBe("error");
    expect(row.detail).toContain("nope");
  });

  it("network declarations land in the audit row", async () => {
    const { dir, audit, deps } = rig();
    const input = path.join(dir, "n.txt");
    fs.writeFileSync(input, "x");
    const cfg = parsePipelineYaml(`
name: netty
steps:
  - name: local-but-declared
    run: ["true"]
    network: true
`);
    await runPipeline(cfg, dir, input, deps);
    expect(audit.list()[0].args.network).toBe(true);
  });
});

describe("watcher hygiene rules", () => {
  it("ignores dotfiles, config, and its own outputs", () => {
    expect(shouldIgnore(".DS_Store")).toBe(true);
    expect(shouldIgnore(".pipeline.yaml")).toBe(true);
    expect(shouldIgnore("x.txt.result.md")).toBe(true);
    expect(shouldIgnore("x.txt.error.md")).toBe(true);
    expect(shouldIgnore("x.txt")).toBe(false);
  });

  it("recognizes iCloud dataless placeholders", () => {
    expect(icloudPlaceholderTarget(".note.txt.icloud")).toBe("note.txt");
    expect(icloudPlaceholderTarget("note.txt")).toBeNull();
  });
});
