#!/usr/bin/env node
/**
 * honeycrisp-imessage — text your local AI.
 *
 *   setup --owner <handle> [--model <name>]   write the config block
 *   status                                     preflight: config, FDA, model, tools
 *   run                                        the bridge daemon (foreground)
 *
 * The bridge answers ONLY the configured owner handles, sends only to the
 * owner, and routes every gated action to a "reply yes <nonce>" text (docs/06).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  AuditStore,
  assertCleanArgv,
  defaultDataDir,
  loadConfig,
  type ExecutionDeps,
  type GovernedToolDef,
} from "@honeycrisp/governed";
import { ImessageApprovalChannel } from "./approval.js";
import { runBrain, type ChatMessage } from "./brain.js";
import { runBridge } from "./bridge.js";
import { ChatDb } from "./chatdb.js";
import { DEFAULT_CHAT_DB, loadBridgeConfig, saveBridgeConfig } from "./config.js";
import { OwnerSender } from "./send.js";

const VERSION = "0.1.0";
const require = createRequire(import.meta.url);

assertCleanArgv(process.argv);
const dataDir = defaultDataDir("honeycrisp");
const [, , command, ...rest] = process.argv;

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i > -1 ? rest[i + 1] : undefined;
}

/** Every governed tool package installed alongside us, resolved the same way
 *  the remote gateway does its mounts: present = mounted, absent = skipped. */
async function resolveTools(
  log: (m: string) => void
): Promise<Array<Readonly<GovernedToolDef<Record<string, unknown>>>>> {
  const wanted: Array<[string, string, string]> = [
    ["@honeycrisp/mail", "dist/tools.js", "mailTools"],
    ["@honeycrisp/reminders", "dist/tools.js", "reminderTools"],
    ["@honeycrisp/notes", "dist/tools.js", "noteTools"],
    ["@honeycrisp/calendar", "dist/tools.js", "calendarTools"],
  ];
  const tools: Array<Readonly<GovernedToolDef<Record<string, unknown>>>> = [];
  for (const [pkg, entry, exportName] of wanted) {
    try {
      const mod = (await import(`${pkg}/${entry}`)) as Record<string, unknown>;
      const set = mod[exportName] as Array<Readonly<GovernedToolDef<Record<string, unknown>>>>;
      if (Array.isArray(set)) {
        tools.push(...set);
        log(`  mounted ${pkg} (${set.length} tools)`);
      }
    } catch {
      log(`  skipped ${pkg} (not installed)`);
    }
  }
  return tools;
}

/** Ollama chat-with-tools, the shape the Q28 field test proved. */
function ollamaChat(host: string, model: string) {
  return async (messages: ChatMessage[], tools: unknown[]) => {
    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, tools, stream: false }),
    });
    const body = (await res.json()) as { message?: ChatMessage; error?: string };
    if (body.error) throw new Error(`model: ${body.error}`);
    return { message: body.message ?? { role: "assistant", content: "(empty)" } };
  };
}

if (command === "setup") {
  const owner = flag("owner");
  if (!owner) {
    console.error(
      "usage: honeycrisp-imessage setup --owner <your phone/Apple ID> [--model <name>]\n" +
        "  The owner handle is the ONLY sender the bridge will ever obey.\n" +
        '  Phone numbers must be E.164, exactly as Messages stores them: "+15551234567".'
    );
    process.exit(2);
  }
  const config = saveBridgeConfig(dataDir, {
    ownerHandles: owner.split(",").map((h) => h.trim()),
    model: flag("model"),
  });
  console.log(`owner allowlist: ${config.ownerHandles.join(", ")}`);
  console.log(`model: ${config.model.model} @ ${config.model.host}`);
  console.log(`config: ${path.join(dataDir, "config.json")}`);
  console.log(
    "\nNext: sign Messages.app into the assistant's Apple ID, grant this\n" +
      "process Full Disk Access (chat.db) and Automation → Messages, then run:\n" +
      "  honeycrisp-imessage status"
  );
} else if (command === "status" || command === "run") {
  // Config problems are the common case for a human at a terminal: report
  // them as one plain line, not a stack trace.
  let config: ReturnType<typeof loadBridgeConfig>;
  try {
    config = loadBridgeConfig(dataDir);
  } catch (err) {
    console.error(`${(err as Error).message}`);
    process.exit(2);
  }
  if (command === "status") {
    await status(config);
  } else {
    await run(config);
  }
} else if (command === "install" || command === "uninstall") {
  const label = "com.honeycrisp.imessage";
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  if (command === "uninstall") {
    if (fs.existsSync(plistPath)) fs.rmSync(plistPath);
    console.log(`removed ${plistPath} (run: launchctl unload -w ${plistPath})`);
  } else {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const template = fs.readFileSync(
      path.join(here, "..", "launchd", `${label}.plist.example`),
      "utf8"
    );
    const rendered = template
      .replaceAll("REPLACE_NODE_PATH", process.execPath)
      .replaceAll("REPLACE_CLI_PATH", path.join(here, "cli.js"));
    if (rendered.includes("REPLACE_")) throw new Error("template render incomplete");
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, rendered);
    console.log(`wrote ${plistPath}\nload it with: launchctl load -w ${plistPath}`);
  }
} else {
  console.log(`honeycrisp-imessage v${VERSION}`);
  console.log("usage: honeycrisp-imessage [setup --owner <handle> | status | run | install | uninstall]");
  process.exit(command ? 2 : 0);
}

async function status(config: ReturnType<typeof loadBridgeConfig>): Promise<void> {
  console.log(`owner allowlist: ${config.ownerHandles.join(", ")}`);
  console.log(`live mode: ${loadConfig(dataDir).live ? "ON (writes can execute)" : "off (dry-run)"}`);
  let db: ChatDb | undefined;
  try {
    db = new ChatDb(DEFAULT_CHAT_DB);
    console.log(`chat.db: readable (latest rowid ${db.latestRowid()}) — Full Disk Access OK`);
  } catch (err) {
    console.log(`chat.db: NOT readable — ${String(err).slice(0, 120)}`);
  } finally {
    db?.close();
  }
  try {
    const res = await fetch(`${config.model.host}/api/tags`);
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    const names = (body.models ?? []).map((m) => m.name);
    console.log(
      `model host: up — ${config.model.model}${names.includes(config.model.model) ? " (present)" : " (NOT pulled)"}`
    );
  } catch {
    console.log(`model host: unreachable at ${config.model.host} — is ollama running?`);
  }
  const tools = await resolveTools((m) => console.log(m));
  console.log(`tools available: ${tools.length}`);
}

async function run(config: ReturnType<typeof loadBridgeConfig>): Promise<void> {
  const log = (m: string) => console.error(m);
  const chatdb = new ChatDb(DEFAULT_CHAT_DB);
  const sender = new OwnerSender(config.ownerHandles[0], config.maxPerHour);
  const audit = new AuditStore(dataDir);
  const tools = await resolveTools(log);
  if (tools.length === 0) {
    console.error("no tool packages installed — nothing to do");
    process.exit(1);
  }
  // The gate for everything the brain proposes: approval by reply, in the
  // same thread, verified here and never by the model.
  const deps: ExecutionDeps = {
    audit,
    approval: new ImessageApprovalChannel({
      chatdb,
      sender,
      ownerHandles: config.ownerHandles,
      timeoutSeconds: config.approvalTimeoutSeconds,
    }),
    getConfig: () => loadConfig(dataDir),
    version: VERSION,
    principal: "imessage:owner",
  };
  const chat = ollamaChat(config.model.host, config.model.model);
  await runBridge({
    chatdb,
    sender,
    ownerHandles: config.ownerHandles,
    audit,
    version: VERSION,
    pollSeconds: config.pollSeconds,
    log,
    think: (text) => runBrain(text, { tools, deps, chat }),
  });
}
