#!/usr/bin/env node
import { createGovernedServer } from "@cortland/governed";
import { noteTools, VERSION } from "./tools.js";

const { connectStdio } = createGovernedServer({
  name: "cortland-notes",
  version: VERSION,
  appName: "cortland", // shared suite audit DB
  tools: noteTools,
});

connectStdio().catch((err) => {
  console.error(err);
  process.exit(1);
});
