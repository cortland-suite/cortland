#!/usr/bin/env node
import { createGovernedServer } from "@cortland/governed";
import { imessageTools, VERSION } from "./tools.js";

const { connectStdio } = createGovernedServer({
  name: "cortland-imessage",
  version: VERSION,
  appName: "cortland", // shared suite audit DB
  tools: imessageTools,
});

connectStdio().catch((err) => {
  console.error(err);
  process.exit(1);
});
