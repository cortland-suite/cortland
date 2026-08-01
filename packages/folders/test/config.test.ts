import { describe, expect, it } from "vitest";
import { parsePipelineYaml, substitutePlaceholders } from "../src/config.js";

describe("pipeline config", () => {
  it("parses a valid config with defaults applied", () => {
    const cfg = parsePipelineYaml(`
name: wordcount
description: count words
steps:
  - name: count
    run: ["wc", "-w", "{input}"]
`);
    expect(cfg.name).toBe("wordcount");
    expect(cfg.steps[0].network).toBe(false);
    expect(cfg.steps[0].timeoutSeconds).toBe(120);
  });

  it("rejects broken YAML with a friendly error", () => {
    expect(() => parsePipelineYaml("steps: [unclosed")).toThrow(/invalid YAML/);
  });

  it("rejects missing steps", () => {
    expect(() => parsePipelineYaml("name: x")).toThrow(/invalid pipeline config/);
  });

  it("rejects a shell-string run (argv array required)", () => {
    expect(() =>
      parsePipelineYaml(`
name: bad
steps:
  - name: oops
    run: "wc -w {input}"
`)
    ).toThrow(/invalid pipeline config at "steps.0.run"/);
  });

  it("rejects hostile pipeline names", () => {
    expect(() =>
      parsePipelineYaml(`
name: "../escape"
steps:
  - name: x
    run: ["true"]
`)
    ).toThrow(/invalid pipeline config at "name"/);
  });
});

describe("placeholder substitution", () => {
  it("replaces {input} and {dir} everywhere they appear", () => {
    expect(
      substitutePlaceholders(["cat", "{input}", "--out", "{dir}/x"], "/a/b.txt", "/a")
    ).toEqual(["cat", "/a/b.txt", "--out", "/a/x"]);
  });

  it("does not interpret file names as shell syntax", () => {
    const argv = substitutePlaceholders(["cat", "{input}"], "/a/$(rm -rf ~).txt", "/a");
    expect(argv[1]).toBe("/a/$(rm -rf ~).txt"); // stays one literal argv entry
  });
});
