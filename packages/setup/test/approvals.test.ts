import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureApprovalNotify, configureFolderApprovals } from "../src/approvals.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "setup-approvals-"));

describe("folder approvals setup", () => {
  it("creates Agents/Approvals with a README and points config.json at it", () => {
    const icloud = tmp();
    const data = tmp();
    const result = configureFolderApprovals(icloud, data);
    expect(fs.existsSync(result.approvalsDir)).toBe(true);
    expect(result.approvalsDir).toBe(path.join(icloud, "Agents", "Approvals"));
    expect(fs.readFileSync(path.join(result.approvalsDir, "README.md"), "utf8"))
      .toContain("DENY");
    const config = JSON.parse(fs.readFileSync(result.configFile, "utf8"));
    expect(config.approval).toEqual({
      channel: "folder",
      dir: result.approvalsDir,
      timeoutSeconds: 300,
    });
  });

  it("preserves every existing config key — live mode above all", () => {
    const icloud = tmp();
    const data = tmp();
    const configFile = path.join(data, "config.json");
    fs.writeFileSync(configFile, JSON.stringify({ live: true, custom: "kept" }));
    configureFolderApprovals(icloud, data);
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    expect(config.live).toBe(true);
    expect(config.custom).toBe("kept");
    expect(config.approval.channel).toBe("folder");
  });

  it("refuses to clobber an unparseable config", () => {
    const icloud = tmp();
    const data = tmp();
    const configFile = path.join(data, "config.json");
    fs.writeFileSync(configFile, "{not json");
    expect(() => configureFolderApprovals(icloud, data)).toThrow();
    expect(fs.readFileSync(configFile, "utf8")).toBe("{not json"); // untouched
  });

  it("never overwrites an existing README (the human may have edited it)", () => {
    const icloud = tmp();
    const data = tmp();
    const readme = path.join(icloud, "Agents", "Approvals", "README.md");
    fs.mkdirSync(path.dirname(readme), { recursive: true });
    fs.writeFileSync(readme, "my notes");
    const result = configureFolderApprovals(icloud, data);
    expect(result.createdReadme).toBe(false);
    expect(fs.readFileSync(readme, "utf8")).toBe("my notes");
  });
});

describe("approval notify setup", () => {
  it("mints an unguessable topic and attaches it to the folder channel", () => {
    const icloud = tmp();
    const data = tmp();
    configureFolderApprovals(icloud, data);
    const result = configureApprovalNotify(data);
    expect(result.topic).toMatch(/^honeycrisp-[0-9a-f]{32}$/);
    const config = JSON.parse(fs.readFileSync(result.configFile, "utf8"));
    expect(config.approval.notify.url).toBe(`https://ntfy.sh/${result.topic}`);
    expect(config.approval.channel).toBe("folder"); // untouched
  });

  it("refuses to attach a ping when the folder channel is not configured", () => {
    const data = tmp();
    fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ live: false }));
    expect(() => configureApprovalNotify(data)).toThrow(/folder approvals first/);
  });
});
