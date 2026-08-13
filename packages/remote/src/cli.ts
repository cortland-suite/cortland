#!/usr/bin/env node
/**
 * cortland-remote — the gateway CLI.
 *
 *   serve                      run the gateway in the foreground (loopback only)
 *   on | off | status          install/remove/inspect the launchd agent
 *   token mint [--write] [--label <name>]
 *   token list
 *   token revoke <id>
 *
 * Reachability beyond this Mac is deliberately someone else's explicit job:
 *   tailscale serve --bg 7811        # your own devices (private tailnet)
 * Public exposure (Funnel/Cloudflare + OAuth) is the M2 design — not here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertCleanArgv, defaultDataDir } from "@cortland/governed";
import { startGateway } from "./gateway.js";
import { resolveMounts } from "./mounts.js";
import { TokenStore } from "./tokens.js";

const VERSION = "0.1.0";
const LABEL = "com.cortland.remote";
const DEFAULT_PORT = 7811;

assertCleanArgv(process.argv);
const dataDir = defaultDataDir("cortland");
const [, , command, sub, ...rest] = process.argv;

/** remote.port from the suite config.json. A malformed config REFUSES to
 *  serve (exposure ladder: errors resolve downward, toward not listening). */
function loadPort(): number {
  const file = path.join(dataDir, "config.json");
  if (!fs.existsSync(file)) return DEFAULT_PORT;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    remote?: { port?: unknown };
  };
  const port = parsed.remote?.port;
  if (port === undefined) return DEFAULT_PORT;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`config remote.port must be an integer in [1024, 65535], got ${JSON.stringify(port)}`);
  }
  return port;
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ ok: !error, output: (stdout + stderr).trim() })
    );
  });
}

const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

if (command === "serve") {
  const port = loadPort();
  const mounts = await resolveMounts(dataDir, (m) => console.error(m));
  if (mounts.length === 0) {
    console.error("nothing to serve: no suite packages found to mount");
    process.exit(1);
  }
  const tokens = new TokenStore(dataDir);
  if (tokens.list().length === 0) {
    console.error(
      "warning: no tokens minted — every request will be refused.\n" +
        "Mint one: cortland-remote token mint --label my-laptop"
    );
  }
  await startGateway({ dataDir, port, mounts, log: (m) => console.error(m) });
  // keeps running until killed; launchd owns the lifecycle in `on` mode
} else if (command === "token") {
  const tokens = new TokenStore(dataDir);
  if (sub === "mint") {
    const scope = rest.includes("--write") ? "write" : "read";
    const labelIdx = rest.indexOf("--label");
    const label = labelIdx > -1 ? rest[labelIdx + 1] : "unlabeled";
    const { token, record } = tokens.mint(scope, label ?? "unlabeled");
    console.log(`token id: ${record.id}   scope: ${record.scope}   label: ${record.label}`);
    console.log(`\n  ${token}\n`);
    console.log(
      "This is the only time this token is shown. Store it in the client that\n" +
        "will use it; this Mac keeps only a hash. Revoke anytime:\n" +
        `  cortland-remote token revoke ${record.id}`
    );
  } else if (sub === "list") {
    const all = tokens.list();
    if (all.length === 0) console.log("no tokens.");
    for (const t of all) {
      console.log(`${t.id}  ${t.scope.padEnd(5)}  ${t.createdAt}  ${t.label}`);
    }
  } else if (sub === "revoke") {
    const id = rest[0];
    if (!id) {
      console.error("usage: cortland-remote token revoke <id>");
      process.exit(2);
    }
    console.log(tokens.revoke(id) ? `revoked ${id}` : `no token with id ${id}`);
  } else {
    console.error("usage: cortland-remote token [mint|list|revoke]");
    process.exit(2);
  }
} else if (command === "on") {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const template = fs.readFileSync(
    path.join(here, "..", "launchd", `${LABEL}.plist.example`),
    "utf8"
  );
  const rendered = template
    .replaceAll("REPLACE_NODE_PATH", xml(process.execPath))
    .replaceAll("REPLACE_CLI_PATH", xml(path.join(here, "cli.js")));
  if (rendered.includes("REPLACE_")) throw new Error("template render incomplete");
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, rendered);
  const load = await run("launchctl", ["load", "-w", plistPath]);
  console.log(load.ok ? `gateway on: ${plistPath}` : `load failed: ${load.output}`);
} else if (command === "off") {
  const unload = await run("launchctl", ["unload", "-w", plistPath]);
  console.log(unload.ok ? "gateway off." : `unload: ${unload.output}`);
  if (fs.existsSync(plistPath)) fs.rmSync(plistPath);
} else if (command === "status") {
  const port = loadPort();
  const list = await run("launchctl", ["list", LABEL]);
  console.log(`launchd agent: ${list.ok ? "loaded" : "not loaded"}`);
  const probe = await run("curl", [
    "-s", "-o", "/dev/null", "-w", "%{http_code}",
    "-m", "2", `http://127.0.0.1:${port}/mcp/mail`,
  ]);
  console.log(
    probe.output === "401"
      ? `gateway: listening on 127.0.0.1:${port} (401 without a token — correct)`
      : probe.ok
        ? `gateway: unexpected response ${probe.output} on port ${port}`
        : `gateway: not listening on port ${port}`
  );
  const tokens = new TokenStore(dataDir).list();
  console.log(`tokens: ${tokens.length} active`);
} else {
  console.log(`cortland-remote v${VERSION}`);
  console.log(
    "usage: cortland-remote [serve|on|off|status|token mint|token list|token revoke <id>]"
  );
  process.exit(command ? 2 : 0);
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
