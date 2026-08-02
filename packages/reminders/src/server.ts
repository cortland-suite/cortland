#!/usr/bin/env node
import { createGovernedServer } from "@honeycrisp/governed";
import { reminderTools, VERSION } from "./tools.js";

const { connectStdio } = createGovernedServer({
  name: "honeycrisp-reminders",
  version: VERSION,
  appName: "honeycrisp", // shared suite audit DB
  tools: reminderTools,
});

connectStdio().catch((err) => {
  console.error(err);
  process.exit(1);
});
