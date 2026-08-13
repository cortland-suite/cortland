#!/usr/bin/env node
import { createGovernedServer } from "@cortland/governed";
import { reminderTools, VERSION } from "./tools.js";

const { connectStdio } = createGovernedServer({
  name: "cortland-reminders",
  version: VERSION,
  appName: "cortland", // shared suite audit DB
  tools: reminderTools,
});

connectStdio().catch((err) => {
  console.error(err);
  process.exit(1);
});
