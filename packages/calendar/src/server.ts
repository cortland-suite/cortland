#!/usr/bin/env node
import { createGovernedServer } from "@honeycrisp/governed";
import { calendarTools, VERSION } from "./tools.js";

const { connectStdio } = createGovernedServer({
  name: "honeycrisp-calendar",
  version: VERSION,
  appName: "honeycrisp", // shared suite audit DB
  tools: calendarTools,
});

connectStdio().catch((err) => {
  console.error(err);
  process.exit(1);
});
