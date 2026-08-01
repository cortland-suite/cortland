#!/usr/bin/env node
import { createGovernedServer } from "@honeycrisp/governed";
import { mailTools } from "./tools.js";

const { connectStdio } = createGovernedServer({
  name: "honeycrisp-mail",
  version: "0.1.0",
  // Shared audit DB for the whole suite (NOTES Q4).
  appName: "honeycrisp",
  tools: mailTools,
});

connectStdio().catch((err) => {
  console.error(err);
  process.exit(1);
});
