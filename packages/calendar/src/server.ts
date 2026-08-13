#!/usr/bin/env node
import { createGovernedServer } from "@cortland/governed";
import { calendarTools, VERSION } from "./tools.js";

const { connectStdio } = createGovernedServer({
  name: "cortland-calendar",
  version: VERSION,
  appName: "cortland", // shared suite audit DB
  tools: calendarTools,
});

connectStdio().catch((err) => {
  console.error(err);
  process.exit(1);
});
