#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { AuditStore, assertCleanArgv, defaultDataDir } from "@cortland/governed";
import { watchRoot } from "./watcher.js";

const VERSION = "0.1.0";

assertCleanArgv(process.argv);

const root = process.argv[2];
if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error("usage: cortland-folders <rootDir>");
  console.error("Watches subfolders containing .pipeline.yaml; results land beside dropped files.");
  process.exit(2);
}

// Shared audit DB for the whole suite (NOTES Q4).
const audit = new AuditStore(defaultDataDir("cortland"));
const resolved = path.resolve(root);
watchRoot(resolved, { audit, version: VERSION, log: (m) => console.log(m) });
console.log(`cortland-folders v${VERSION} watching ${resolved}`);
