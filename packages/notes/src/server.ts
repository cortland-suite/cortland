#!/usr/bin/env node
import { createGovernedServer } from "@honeycrisp/governed";
import { noteTools, VERSION } from "./tools.js";

const { connectStdio } = createGovernedServer({
  name: "honeycrisp-notes",
  version: VERSION,
  appName: "honeycrisp", // shared suite audit DB
  tools: noteTools,
});

connectStdio().catch((err) => {
  console.error(err);
  process.exit(1);
});
