import { createRequire } from "node:module";
import { AuditStore } from "@cortland/governed";
import type { Mount } from "./gateway.js";

const require = createRequire(import.meta.url);

/**
 * Resolve the suite's tool sets through the module resolver — same pattern as
 * the setup wizard: works identically in the monorepo (workspace symlinks)
 * and an npm-installed tree. A package that isn't installed just isn't
 * mounted; the gateway serves what exists and says what it skipped.
 */
export async function resolveMounts(
  dataDir: string,
  log: (message: string) => void
): Promise<Mount[]> {
  const mounts: Mount[] = [];

  try {
    const pkg = require("@cortland/mail/package.json") as { version: string };
    const { mailTools } = (await import("@cortland/mail/dist/tools.js")) as {
      mailTools: Mount["tools"];
    };
    mounts.push({ name: "mail", version: pkg.version, tools: mailTools });
  } catch {
    log("mount skipped: @cortland/mail not installed");
  }

  try {
    const pkg = require("@cortland/context/package.json") as { version: string };
    const { ContextStore } = await import("@cortland/context/dist/store.js");
    const { makeContextTools } = await import("@cortland/context/dist/tools.js");
    const store = new ContextStore(dataDir);
    const audit = new AuditStore(dataDir);
    mounts.push({
      name: "context",
      version: pkg.version,
      tools: makeContextTools(store, audit, pkg.version) as Mount["tools"],
    });
  } catch {
    log("mount skipped: @cortland/context not installed");
  }

  return mounts;
}
