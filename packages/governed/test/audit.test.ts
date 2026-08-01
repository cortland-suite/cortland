import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { executeGoverned } from "../src/execute.js";
import { gatedTool, makeRig } from "./helpers.js";

describe("audit: every execution path leaves a row", () => {
  it("dry-run leaves a row", async () => {
    const rig = makeRig({ live: false });
    await executeGoverned(gatedTool(), { message: "hi" }, rig.deps);
    const rows = rig.audit.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("dry-run");
    expect(rows[0].dryRun).toBe(true);
  });

  it("denial leaves a row with the approval id and method", async () => {
    const rig = makeRig({ live: true }, false);
    await executeGoverned(gatedTool(), { message: "hi" }, rig.deps);
    const rows = rig.audit.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("denied");
    expect(rows[0].approvalId).toBeTruthy();
    expect(rows[0].approvalMethod).toBe("stub");
  });

  it("approved success leaves a row linked to the approval", async () => {
    const rig = makeRig({ live: true }, true);
    await executeGoverned(gatedTool(), { message: "hi" }, rig.deps);
    const rows = rig.audit.list();
    expect(rows[0].outcome).toBe("ok");
    expect(rows[0].approvalId).toBeTruthy();
  });

  it("a throwing handler leaves an error row", async () => {
    const rig = makeRig({ live: true }, true);
    const tool = gatedTool({
      handler: async () => {
        throw new Error("boom");
      },
    });
    const result = await executeGoverned(tool, { message: "hi" }, rig.deps);
    expect(result.isError).toBe(true);
    const rows = rig.audit.list();
    expect(rows[0].outcome).toBe("error");
    expect(rows[0].detail).toContain("boom");
  });

  it("read success and read failure both leave rows", async () => {
    const rig = makeRig({ live: false });
    const ok = gatedTool({
      name: "demo_read",
      mode: "read",
      handler: async () => ({ content: "data" }),
    });
    const bad = gatedTool({
      name: "demo_read_bad",
      mode: "read",
      handler: async () => {
        throw new Error("nope");
      },
    });
    await executeGoverned(ok, {}, rig.deps);
    await executeGoverned(bad, {}, rig.deps);
    const outcomes = rig.audit.list().map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["error", "ok"]);
  });
});

describe("audit: redaction", () => {
  it("redacted fields are stored as length + hash, not content", async () => {
    const rig = makeRig({ live: false });
    const secretBody = "extremely personal message body";
    const tool = gatedTool({ redact: ["body"] });
    await executeGoverned(tool, { to: "a@example.com", body: secretBody }, rig.deps);

    const row = rig.audit.list()[0];
    const body = row.args.body as { redacted: boolean; length: number; sha256: string };
    expect(body.redacted).toBe(true);
    expect(body.length).toBe(Buffer.byteLength(secretBody));
    expect(body.sha256).toHaveLength(16);
    expect(row.args.to).toBe("a@example.com"); // undeclared fields stay verbatim

    // The raw content must not exist anywhere in the DB file.
    const dbBytes = fs.readFileSync(path.join(rig.dir, "audit.db")).toString("latin1");
    expect(dbBytes).not.toContain(secretBody);
  });

  it("redaction also applies to the dry-run preview and approval summary", async () => {
    const rig = makeRig({ live: true }, true);
    const tool = gatedTool({ redact: ["body"] });
    await executeGoverned(tool, { body: "the secret text" }, rig.deps);
    expect(rig.approval.requests[0].summary).not.toContain("the secret text");
  });
});
