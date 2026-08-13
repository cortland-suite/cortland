#!/usr/bin/env node
import { createGovernedServer } from "@cortland/governed";
import { mailTools } from "./tools.js";

const { connectStdio } = createGovernedServer({
  name: "cortland-mail",
  version: "0.1.0",
  // Shared audit DB for the whole suite (NOTES Q4).
  appName: "cortland",
  tools: mailTools,
});

connectStdio().catch((err) => {
  console.error(err);
  process.exit(1);
});
