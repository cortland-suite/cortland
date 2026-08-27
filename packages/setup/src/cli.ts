#!/usr/bin/env node
/**
 * `cortland setup` — interactive onboarding.
 *
 * House doctrine applies to the wizard itself: every action is proposed and
 * confirmed before it happens, nothing is silent, and everything performed is
 * recorded in the suite's shared audit DB.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { AuditStore, assertCleanArgv, defaultDataDir } from "@cortland/governed";
import {
  claudeDesktopConfigPath,
  commandExists,
  hasFullDiskAccess,
  icloudDrivePath,
  run,
  suitePaths,
} from "./detect.js";
import {
  hasServer,
  readDesktopConfig,
  withServer,
  writeDesktopConfig,
} from "./desktopConfig.js";
import { configureApprovalNotify, configureFolderApprovals } from "./approvals.js";
import { createAgentsFolder } from "./starter.js";
import { installPlist, renderPlist, renderTemplate } from "./launchd.js";

const VERSION = "0.1.0";
const SERVER_NAME = "cortland-mail";

assertCleanArgv(process.argv);

const command = process.argv[2];
if (command !== "setup") {
  console.log(`cortland v${VERSION}`);
  console.log("usage: cortland setup [--icloud-root <path>]");
  process.exit(command ? 2 : 0);
}
const rootFlagIndex = process.argv.indexOf("--icloud-root");
const icloudRootOverride =
  rootFlagIndex > -1 ? process.argv[rootFlagIndex + 1] : undefined;

const paths = suitePaths();
const audit = new AuditStore(defaultDataDir("cortland"));
const interactive = process.stdin.isTTY === true;
const rl = interactive
  ? readline.createInterface({ input: process.stdin, output: process.stdout })
  : null;
// Non-interactive (piped) mode: stdin is consumed upfront as a scripted answer
// queue, one y/n per line. Missing answers default to No.
const scriptedAnswers: string[] = interactive ? [] : await readAllStdinLines();
const performed: string[] = [];
const skipped: string[] = [];

function readAllStdinLines(): Promise<string[]> {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (text += d));
    process.stdin.on("end", () =>
      resolve(text.split("\n").map((l) => l.trim()).filter((l) => l !== ""))
    );
  });
}

function record(action: string, detail: string) {
  performed.push(`${action} — ${detail}`);
  audit.record({
    tool: `setup_${action}`,
    scope: "Setup",
    mode: "write-safe",
    undo: "none",
    args: { detail },
    dryRun: false,
    outcome: "ok",
    toolVersion: VERSION,
  });
}

async function confirm(question: string): Promise<boolean> {
  if (!interactive) {
    const answer = (scriptedAnswers.shift() ?? "n").toLowerCase();
    const yes = answer === "y" || answer === "yes";
    console.log(`${question} [y/N] ${yes ? "y" : "n"} (scripted)`);
    return yes;
  }
  try {
    const answer = (await rl!.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    // stdin closed mid-session: the default answer is always No.
    console.log(`${question} — no input, skipping.`);
    return false;
  }
}

console.log(`\ncortland setup v${VERSION}`);
console.log("Local-first, no accounts, no credentials. Every step below asks first.\n");

// ─── 1. Mail server sanity ────────────────────────────────────────────────
if (!fs.existsSync(paths.mailServer)) {
  console.log("The mail server isn't built yet. Run `npm install && npm run build` first.");
  process.exit(1);
}

// ─── 2. Register with MCP clients ─────────────────────────────────────────
console.log("── MCP clients");
const servers: Array<{ name: string; args: string[] }> = [
  { name: "cortland-mail", args: [paths.mailServer] },
];
if (fs.existsSync(paths.contextCli)) {
  servers.push({ name: "cortland-context", args: [paths.contextCli, "serve"] });
}

if (await commandExists("claude")) {
  const list = await run("claude", ["mcp", "list"]);
  for (const server of servers) {
    if (list.output.includes(`${server.name}:`)) {
      console.log(`Claude Code: ${server.name} already registered.`);
      skipped.push(`Claude Code ${server.name} (already registered)`);
    } else if (
      await confirm(`Register ${server.name} with Claude Code (user scope)?`)
    ) {
      const result = await run("claude", [
        "mcp",
        "add",
        "--scope",
        "user",
        server.name,
        process.execPath,
        ...server.args,
      ]);
      console.log(result.ok ? "  registered." : `  failed: ${result.output}`);
      if (result.ok) record(`register_claude_code_${server.name}`, server.args[0]);
    } else skipped.push(`Claude Code ${server.name}`);
  }
} else {
  console.log("Claude Code CLI not found — skipping.");
  skipped.push("Claude Code (not installed)");
}

const desktopFile = claudeDesktopConfigPath();
if (fs.existsSync(desktopFile)) {
  let config: ReturnType<typeof readDesktopConfig> | null = null;
  try {
    config = readDesktopConfig(desktopFile);
  } catch (err) {
    console.log(`Claude Desktop config unreadable (${String(err)}) — skipping.`);
    skipped.push("Claude Desktop (unreadable config)");
  }
  if (config) {
    const missing = servers.filter((s) => !hasServer(config!, s.name));
    if (missing.length === 0) {
      console.log("Claude Desktop: already configured.");
      skipped.push("Claude Desktop (already configured)");
    } else if (
      await confirm(
        `Add ${missing.map((s) => s.name).join(" + ")} to Claude Desktop config (backup kept)?`
      )
    ) {
      let next = config;
      for (const server of missing) {
        next = withServer(next, server.name, process.execPath, server.args);
      }
      const backup = writeDesktopConfig(desktopFile, next);
      console.log(`  written${backup ? `, backup at ${backup}` : ""}. Restart Claude Desktop to load it.`);
      record("configure_claude_desktop", desktopFile);
    } else skipped.push("Claude Desktop");
  }
} else {
  skipped.push("Claude Desktop (not installed)");
}

// ─── 3. Permission warm-up ────────────────────────────────────────────────
console.log("\n── macOS permissions");
if (
  await confirm(
    "Trigger the Mail permission prompt now (macOS will ask; click Allow)?"
  )
) {
  const probe = await run("osascript", ["-e", 'tell application "Mail" to count of accounts']);
  if (probe.ok) {
    console.log(`  Mail responded (${probe.output} account(s)) — Automation permission working.`);
    record("warmup_mail_permission", "granted");
  } else {
    console.log(`  Mail did not respond: ${probe.output}`);
    console.log("  If you denied the prompt: System Settings → Privacy & Security → Automation.");
  }
} else skipped.push("Mail permission warm-up");

if (hasFullDiskAccess()) {
  console.log("Full Disk Access: already granted — full-text mail search available.");
} else {
  console.log(
    "Full Disk Access: not granted. Only full-text mail search needs it; everything else works without."
  );
  if (await confirm("Open the Full Disk Access settings pane now?")) {
    await run("open", [
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    ]);
    console.log("  Add the app that hosts your MCP server (e.g. Claude), then restart it.");
    record("open_fda_settings", "pane opened");
  } else skipped.push("Full Disk Access");
}

// ─── 4. iCloud Agents folder ──────────────────────────────────────────────
console.log("\n── Folder-as-API");
const icloudRoot = icloudRootOverride ?? icloudDrivePath();
if (!fs.existsSync(icloudRoot)) {
  console.log(`iCloud Drive not found at ${icloudRoot} — skipping Agents folder.`);
  skipped.push("Agents folder (no iCloud Drive)");
} else if (
  await confirm(`Create an Agents folder with starter pipelines in ${icloudRoot}?`)
) {
  const result = createAgentsFolder(icloudRoot);
  for (const f of result.created) console.log(`  created ${f}`);
  for (const f of result.skipped) console.log(`  kept existing ${f}`);
  if (result.created.length > 0) record("create_agents_folder", icloudRoot);

  if (
    await confirm(
      "Install the launchd agent so pipelines run whenever your Mac is on?"
    )
  ) {
    const template = fs.readFileSync(paths.launchdTemplate, "utf8");
    const target = installPlist(
      renderPlist(template, process.execPath, paths.foldersCli, `${icloudRoot}/Agents`)
    );
    const load = await run("launchctl", ["load", "-w", target]);
    console.log(
      load.ok
        ? `  installed and loaded: ${target}`
        : `  installed ${target}; load failed: ${load.output}`
    );
    if (load.ok) record("install_launchd", target);
  } else {
    skipped.push("launchd agent");
    console.log(`  Run manually anytime: node ${paths.foldersCli} "${icloudRoot}/Agents"`);
  }
} else skipped.push("Agents folder");

// ─── 5. Context layer schedules ───────────────────────────────────────────
console.log("\n── Context layer");
if (fs.existsSync(paths.contextCli)) {
  if (
    await confirm(
      "Schedule mail+calendar capture every 15 minutes (launchd, headers only)?"
    )
  ) {
    const template = fs.readFileSync(paths.contextCaptureTemplate, "utf8");
    const target = installPlist(
      renderTemplate(template, {
        REPLACE_NODE_PATH: process.execPath,
        REPLACE_CLI_PATH: paths.contextCli,
      }),
      "com.cortland.context-capture"
    );
    const load = await run("launchctl", ["load", "-w", target]);
    console.log(load.ok ? `  installed and loaded: ${target}` : `  load failed: ${load.output}`);
    if (load.ok) record("install_context_capture_schedule", target);
  } else skipped.push("capture schedule");

  const briefDir = path.join(icloudRoot, "Agents", "Briefings");
  if (
    fs.existsSync(icloudRoot) &&
    (await confirm(`Generate a morning briefing at 7:00 into ${briefDir}?`))
  ) {
    const template = fs.readFileSync(paths.contextBriefTemplate, "utf8");
    const target = installPlist(
      renderTemplate(template, {
        REPLACE_NODE_PATH: process.execPath,
        REPLACE_CLI_PATH: paths.contextCli,
        REPLACE_ARG: briefDir,
      }),
      "com.cortland.context-brief"
    );
    const load = await run("launchctl", ["load", "-w", target]);
    console.log(load.ok ? `  installed and loaded: ${target}` : `  load failed: ${load.output}`);
    if (load.ok) record("install_context_brief_schedule", briefDir);
    console.log(
      "  Tip: allowlist calendars first — `cortland-context calendars` shows names; " +
        "add {\"calendars\": [...]} to the suite's context.json."
    );
  } else skipped.push("morning briefing schedule");
} else {
  skipped.push("context layer (not built)");
}

// ─── 6. Remote approvals ──────────────────────────────────────────────────
console.log("\n── Remote approvals");
if (!fs.existsSync(icloudRoot)) {
  console.log("iCloud Drive not found — approvals stay on the native dialog.");
  skipped.push("remote approvals (no iCloud Drive)");
} else if (
  await confirm(
    "Route write approvals through an iCloud folder, so you can approve from " +
      "any device (phone included) instead of a dialog on this Mac?"
  )
) {
  try {
    const result = configureFolderApprovals(icloudRoot, defaultDataDir("cortland"));
    console.log(`  approvals folder: ${result.approvalsDir}`);
    console.log(`  config updated: ${result.configFile}`);
    console.log(
      "  Gated actions now wait up to 5 minutes for you to check APPROVE in " +
        "the Files app. No decision means DENY."
    );
    record("configure_folder_approvals", result.approvalsDir);

    if (
      await confirm(
        "Also ping your phone when an approval is waiting (one POST to ntfy.sh " +
          "per request — the message carries no details, just 'go look')?"
      )
    ) {
      const notify = configureApprovalNotify(defaultDataDir("cortland"));
      console.log(`  push topic minted: ${notify.topic}`);
      console.log(
        "  On your phone: install the free ntfy app and subscribe to that " +
          "topic. The topic name is the secret — treat it like a password."
      );
      record("configure_approval_notify", "ntfy.sh (topic in config.json)");
    } else skipped.push("approval push ping");
  } catch (err) {
    console.log(`  could not configure: ${String(err)}`);
    skipped.push("remote approvals (config error)");
  }
} else {
  console.log("  Keeping the native dialog (approve at this Mac).");
  skipped.push("remote approvals");
}

// ─── 7. Summary ───────────────────────────────────────────────────────────
console.log("\n── Summary");
if (performed.length === 0) console.log("Nothing changed.");
for (const line of performed) console.log(`  ✓ ${line}`);
for (const line of skipped) console.log(`  · skipped: ${line}`);
console.log(
  "\nEvery action above was recorded in the audit DB " +
    "(~/Library/Application Support/cortland/audit.db).\n" +
    "Remember the doctrine: reads are free, send is gated, drafts stay in your review loop, " +
    "and live mode is off until you opt in.\n"
);
rl?.close();
