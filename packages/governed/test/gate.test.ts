import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { executeGoverned } from "../src/execute.js";
import { loadConfig } from "../src/config.js";
import { gatedTool, makeRig, tempDir } from "./helpers.js";

describe("the gate", () => {
  it("gated tools do not execute when live mode is off (dry-run default)", async () => {
    const rig = makeRig({ live: false });
    let executed = false;
    const tool = gatedTool({
      handler: async () => {
        executed = true;
        return { content: "executed live" };
      },
    });
    const result = await executeGoverned(tool, { message: "hi" }, rig.deps);
    expect(executed).toBe(false);
    expect(result.text).toContain("[DRY-RUN]");
    expect(rig.approval.requests).toHaveLength(0); // no approval needed for a no-op
  });

  it("live + denial → handler never runs", async () => {
    const rig = makeRig({ live: true }, /* approve */ false);
    let executed = false;
    const tool = gatedTool({
      handler: async () => {
        executed = true;
        return { content: "executed live" };
      },
    });
    const result = await executeGoverned(tool, { message: "hi" }, rig.deps);
    expect(executed).toBe(false);
    expect(result.text).toContain("NOT executed");
    expect(rig.approval.requests).toHaveLength(1);
  });

  it("live + approval → handler runs exactly once", async () => {
    const rig = makeRig({ live: true }, true);
    let executions = 0;
    const tool = gatedTool({
      handler: async () => {
        executions += 1;
        return { content: "executed live" };
      },
    });
    const result = await executeGoverned(tool, { message: "hi" }, rig.deps);
    expect(executions).toBe(1);
    expect(result.text).toBe("executed live");
  });

  it("a throwing approval channel is a denial, not a pass-through", async () => {
    const rig = makeRig({ live: true });
    rig.deps.approval = {
      request: async () => {
        throw new Error("channel exploded");
      },
    };
    let executed = false;
    const tool = gatedTool({
      handler: async () => {
        executed = true;
        return { content: "executed live" };
      },
    });
    const result = await executeGoverned(tool, { message: "hi" }, rig.deps);
    expect(executed).toBe(false);
    expect(result.text).toContain("NOT executed");
  });

  it("read tools execute without any gate", async () => {
    const rig = makeRig({ live: false });
    const tool = gatedTool({
      name: "demo_read",
      mode: "read",
      handler: async () => ({ content: "data" }),
    });
    const result = await executeGoverned(tool, {}, rig.deps);
    expect(result.text).toContain("data");
  });
});

describe("config errors fail toward dry-run", () => {
  it("missing config file → dry-run", () => {
    expect(loadConfig(tempDir()).live).toBe(false);
  });

  it("corrupt JSON → dry-run", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.json"), "{live: tru");
    expect(loadConfig(dir).live).toBe(false);
  });

  it("non-boolean live value → dry-run", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ live: "yes" }));
    expect(loadConfig(dir).live).toBe(false);
  });

  it("undocumented env values → dry-run, even truthy-looking ones", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ live: true }));
    // env var present but not the documented opt-in: overrides file, fails closed
    expect(loadConfig(dir, { GOVERNED_LIVE: "TRUE" } as any).live).toBe(false);
    expect(loadConfig(dir, { GOVERNED_LIVE: "yes" } as any).live).toBe(false);
    expect(loadConfig(dir, { GOVERNED_LIVE: "0" } as any).live).toBe(false);
  });

  it("only the documented opt-ins enable live", () => {
    const dir = tempDir();
    expect(loadConfig(dir, { GOVERNED_LIVE: "1" } as any).live).toBe(true);
    expect(loadConfig(dir, { GOVERNED_LIVE: "true" } as any).live).toBe(true);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ live: true }));
    expect(loadConfig(dir, {} as any).live).toBe(true);
  });
});
