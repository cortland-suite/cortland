#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { AuditStore, assertCleanArgv, createGovernedServer, defaultDataDir, runJxa } from "@honeycrisp/governed";
import { generateBriefing } from "./briefing.js";
import { captureCalendar, loadContextConfig } from "./calendar.js";
import { captureOnce } from "./capture.js";
import { pruneExpired } from "./retention.js";
import { extractCommitments } from "./commitments.js";
import { ingestCorrections } from "./corrections.js";
import { makeProvider } from "./model.js";
import { parseStandingQuestions } from "./questions.js";
import { ContextStore } from "./store.js";
import { makeContextTools } from "./tools.js";

const VERSION = "0.1.0";

assertCleanArgv(process.argv);

const dataDir = defaultDataDir("honeycrisp"); // shared suite home (NOTES Q4)
const command = process.argv[2] ?? "serve";

if (command === "capture") {
  const store = new ContextStore(dataDir);
  const audit = new AuditStore(dataDir);
  const deps = { audit, version: VERSION, log: (m: string) => console.log(m) };
  const mail = await captureOnce(store, deps);
  const calendar = await captureCalendar(store, dataDir, {
    ...deps,
    force: process.argv.includes("--force-calendar"),
  });
  const pruned = pruneExpired(
    store,
    loadContextConfig(dataDir).retentionDays,
    audit,
    VERSION
  );
  console.log(JSON.stringify({ mail, calendar, pruned }));
  store.close();
} else if (command === "calendars") {
  const names = await runJxa(
    'const Cal = Application("Calendar"); JSON.stringify(Cal.calendars.name())',
    60_000
  );
  console.log("Available calendars:", names);
  console.log(
    `Allowlist them in ${path.join(dataDir, "context.json")} as {"calendars": ["...", "..."]}`
  );
} else if (command === "brief") {
  const store = new ContextStore(dataDir);
  const audit = new AuditStore(dataDir);
  const dir = process.argv[3];
  const log = (m: string) => console.error(m);

  // M4 intake first: yesterday's checked boxes become judgments before
  // today's briefing is generated.
  if (dir) ingestCorrections(store, dir, log);

  // Standing questions: the yaml travels with the briefings.
  const questions = ((): ReturnType<typeof parseStandingQuestions> | undefined => {
    for (const candidate of [dir, dataDir].filter(Boolean) as string[]) {
      const file = path.join(candidate, "standing-questions.yaml");
      if (fs.existsSync(file)) {
        try {
          return parseStandingQuestions(fs.readFileSync(file, "utf8"));
        } catch (err) {
          log(String(err));
          return undefined;
        }
      }
    }
    return undefined;
  })();

  const config = loadContextConfig(dataDir);
  const provider = makeProvider(config.model);
  if (provider) {
    try {
      const summary = await extractCommitments(store, { provider, log });
      audit.record({
        tool: "context_layer1",
        scope: "ContextStore+Mail→Model",
        mode: "write-safe",
        undo: "none",
        args: {
          provider: provider.name,
          network: provider.network,
          sendsBodies: true,
          ...summary,
        },
        dryRun: false,
        outcome: "ok",
        toolVersion: VERSION,
      });
    } catch (err) {
      log(`commitment extraction failed (briefing continues without): ${err}`);
      audit.record({
        tool: "context_layer1",
        scope: "ContextStore+Mail→Model",
        mode: "write-safe",
        undo: "none",
        args: { provider: provider.name, network: provider.network, sendsBodies: true },
        dryRun: false,
        outcome: "error",
        detail: String(err),
        toolVersion: VERSION,
      });
    }
  }

  const markdown = await generateBriefing(store, {
    version: VERSION,
    questions,
    provider,
  });
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(file, markdown);
    audit.record({
      tool: "context_brief_file",
      scope: "ContextStore→Briefings",
      mode: "write-safe",
      undo: "none",
      args: { file: path.basename(file), questions: questions?.length ?? 0 },
      dryRun: false,
      outcome: "ok",
      toolVersion: VERSION,
    });
    console.log(`briefing written: ${file}`);
  } else {
    console.log(markdown);
  }
  store.close();
} else if (command === "serve") {
  const store = new ContextStore(dataDir);
  const audit = new AuditStore(dataDir);
  const { connectStdio } = createGovernedServer({
    name: "honeycrisp-context",
    version: VERSION,
    appName: "honeycrisp",
    tools: makeContextTools(store, audit, VERSION),
  });
  await connectStdio();
} else {
  console.error("usage: honeycrisp-context [serve|capture|brief [dir]|calendars]");
  process.exit(2);
}
