import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hasServer,
  readDesktopConfig,
  withServer,
  writeDesktopConfig,
} from "../src/desktopConfig.js";
import { suitePaths } from "../src/detect.js";
import { renderPlist, renderTemplate } from "../src/launchd.js";
import { createAgentsFolder } from "../src/starter.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "setup-"));

describe("suite paths", () => {
  it("resolves sibling packages through the module resolver, not repo geometry", () => {
    const paths = suitePaths();
    // in the monorepo the workspace symlinks make these real files
    expect(fs.existsSync(paths.mailServer)).toBe(true);
    expect(fs.existsSync(paths.contextCli)).toBe(true);
    expect(fs.existsSync(paths.launchdTemplate)).toBe(true);
    expect(fs.existsSync(paths.contextBriefTemplate)).toBe(true);
    // and none of them depend on a packages/ directory layout
    for (const p of Object.values(paths)) {
      expect(p.includes("../")).toBe(false);
    }
  });
});

describe("desktop config merge", () => {
  it("preserves existing servers and unknown keys", () => {
    const existing = {
      theme: "dark",
      mcpServers: { other: { command: "x", args: ["y"] } },
    };
    const merged = withServer(existing, "honeycrisp-mail", "node", ["/srv.js"]);
    expect(merged.theme).toBe("dark");
    expect(merged.mcpServers?.other.command).toBe("x");
    expect(merged.mcpServers?.["honeycrisp-mail"].args).toEqual(["/srv.js"]);
    expect(hasServer(merged, "honeycrisp-mail")).toBe(true);
    expect(hasServer(existing, "honeycrisp-mail")).toBe(false); // pure merge
  });

  it("writes with a backup of the previous file", () => {
    const file = path.join(tmp(), "config.json");
    fs.writeFileSync(file, JSON.stringify({ old: true }));
    const backup = writeDesktopConfig(file, { new: true });
    expect(backup).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(backup!, "utf8")).old).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).new).toBe(true);
  });

  it("rejects a non-object config file", () => {
    const file = path.join(tmp(), "config.json");
    fs.writeFileSync(file, '"just a string"');
    expect(() => readDesktopConfig(file)).toThrow(/not a JSON object/);
  });
});

describe("launchd rendering", () => {
  const template = [
    "<string>REPLACE_NODE_PATH</string>",
    "<string>REPLACE_CLI_PATH</string>",
    "<string>REPLACE_WATCH_ROOT</string>",
  ].join("\n");

  it("substitutes all placeholders and escapes XML", () => {
    const out = renderPlist(template, "/usr/local/bin/node", "/x/cli.js", "/y/A & B");
    expect(out).toContain("/usr/local/bin/node");
    expect(out).toContain("/y/A &amp; B");
    expect(out).not.toContain("REPLACE_");
  });

  it("renderTemplate handles arbitrary placeholder maps", () => {
    const out = renderTemplate("<string>REPLACE_ARG</string>", {
      REPLACE_ARG: "/Briefings & More",
    });
    expect(out).toBe("<string>/Briefings &amp; More</string>");
  });

  it("throws if a placeholder survives", () => {
    expect(() => renderPlist("<string>REPLACE_NODE_PATH</string>", "/n", "/c", "/w")).not.toThrow();
    expect(() => renderPlist(template + "<string>REPLACE_EXTRA</string>", "/n", "/c", "/w")).toThrow(
      /placeholders/
    );
  });
});

describe("starter folder", () => {
  it("creates Agents tree with pipelines and README", () => {
    const root = tmp();
    const result = createAgentsFolder(root);
    expect(result.created).toContain("Agents/Shout/.pipeline.yaml");
    expect(result.created).toContain("Agents/Wordcount/.pipeline.yaml");
    expect(fs.readFileSync(path.join(root, "Agents/README.md"), "utf8")).toContain(
      "drop target"
    );
  });

  it("never overwrites existing files", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "Agents/Shout"), { recursive: true });
    fs.writeFileSync(path.join(root, "Agents/Shout/.pipeline.yaml"), "name: custom\n");
    const result = createAgentsFolder(root);
    expect(result.skipped).toContain("Agents/Shout/.pipeline.yaml");
    expect(
      fs.readFileSync(path.join(root, "Agents/Shout/.pipeline.yaml"), "utf8")
    ).toContain("custom");
  });
});
