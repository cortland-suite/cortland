#!/usr/bin/env node
/**
 * Demo governed-MCP server against Apple Reminders.
 *
 * Demonstrates the contract end to end:
 *   - reminders_list  (read)        — always runs, content returned inside the fence
 *   - reminder_create (write-gated) — dry-run by default; live runs require a human
 *                                     clicking Approve in a native macOS dialog
 *
 * First run triggers the macOS Automation prompt (this process → Reminders).
 */
import { z } from "zod";
import { createGovernedServer, defineTool, runJxa } from "@cortland/governed";

const VERSION = "0.1.0";

const remindersList = defineTool({
  name: "reminders_list",
  description: "List open reminders in the default list (name, due date, notes).",
  scope: "Reminders",
  mode: "read",
  undo: "none",
  inputSchema: {
    limit: z.number().int().min(1).max(100).default(20).describe("Max reminders"),
  },
  handler: async (args: { limit?: number }) => {
    const limit = args.limit ?? 20;
    const script = `
      const app = Application("Reminders");
      const list = app.defaultList();
      const open = list.reminders.whose({ completed: false })();
      const rows = open.slice(0, ${limit}).map(r => ({
        name: r.name(),
        due: r.dueDate() ? r.dueDate().toISOString() : null,
        notes: r.body() || null
      }));
      JSON.stringify(rows, null, 2);
    `;
    return { content: await runJxa(script) };
  },
});

const reminderCreate = defineTool({
  name: "reminder_create",
  description: "Create a reminder in the default list.",
  scope: "Reminders",
  mode: "write-gated",
  // A created reminder could be deleted again, but reliable deletion needs the id
  // of the created object, which does not exist before the write — so this tool
  // honestly declares "compensate" (the correction is: delete it by hand).
  undo: "compensate",
  redact: ["notes"],
  inputSchema: {
    name: z.string().min(1).describe("Reminder title"),
    notes: z.string().optional().describe("Optional notes"),
    dueDate: z
      .string()
      .datetime()
      .optional()
      .describe("Optional due date, ISO 8601"),
  },
  preview: (args: { name: string; dueDate?: string }) =>
    `Would create reminder "${args.name}"${args.dueDate ? ` due ${args.dueDate}` : ""} in the default list.`,
  handler: async (args: { name: string; notes?: string; dueDate?: string }, ctx) => {
    const notes = [args.notes, ctx.provenance].filter(Boolean).join("\n\n");
    const script = `
      const app = Application("Reminders");
      const reminder = app.Reminder({
        name: ${JSON.stringify(args.name)},
        body: ${JSON.stringify(notes)}
        ${args.dueDate ? `, dueDate: new Date(${JSON.stringify(args.dueDate)})` : ""}
      });
      app.defaultList().reminders.push(reminder);
      "created";
    `;
    await runJxa(script);
    return { content: `Created reminder "${args.name}" in the default list.` };
  },
});

const { connectStdio } = createGovernedServer({
  name: "governed-example-reminders",
  version: VERSION,
  appName: "cortland",
  tools: [remindersList, reminderCreate],
});

connectStdio().catch((err) => {
  console.error(err);
  process.exit(1);
});
