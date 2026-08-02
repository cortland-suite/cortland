import { z } from "zod";
import { defineTool, runJxa } from "@honeycrisp/governed";
import {
  buildCreateScript,
  buildDeleteScript,
  buildGetScript,
  buildListsScript,
  buildSearchScript,
  buildSetCompletedScript,
} from "./scripts.js";

const VERSION = "0.1.0";
const TIMEOUT_MS = 120_000; // first call may wait on the Automation prompt

const run = (script: string) => runJxa(script, TIMEOUT_MS);

export const remindersLists = defineTool({
  name: "reminders_lists",
  description: "List every reminders list with its open-item count.",
  scope: "Reminders",
  mode: "read",
  undo: "none",
  inputSchema: {},
  handler: async () => ({ content: await run(buildListsScript()) }),
});

export const remindersSearch = defineTool({
  name: "reminders_search",
  description:
    "Search reminders by name/list/due window. Open items by default.",
  scope: "Reminders",
  mode: "read",
  undo: "none",
  inputSchema: {
    list: z.string().min(1).optional().describe("Limit to one list by name"),
    query: z.string().optional().describe("Case-insensitive name match"),
    includeCompleted: z.boolean().optional().describe("Include completed items"),
    dueBefore: z.string().datetime({ offset: true, local: true }).optional(),
    dueAfter: z.string().datetime({ offset: true, local: true }).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  },
  handler: async (args: {
    list?: string;
    query?: string;
    includeCompleted?: boolean;
    dueBefore?: string;
    dueAfter?: string;
    limit?: number;
  }) => ({
    content: await run(buildSearchScript({ ...args, limit: args.limit ?? 50 })),
  }),
});

export const reminderCreate = defineTool({
  name: "reminder_create",
  description:
    "Create a reminder (default list unless named). The reminder is a local, " +
    "provenance-stamped artifact you can see and delete on any device.",
  scope: "Reminders",
  mode: "write-safe", // same tier as a mail draft: stays in the user's review loop
  undo: "compensate", // the correction is deleting it — its id exists only after the write
  redact: ["notes"],
  inputSchema: {
    name: z.string().min(1),
    list: z.string().min(1).optional(),
    notes: z.string().optional(),
    due: z.string().datetime({ offset: true, local: true }).optional(),
  },
  handler: async (
    args: { name: string; list?: string; notes?: string; due?: string },
    ctx
  ) => ({
    content: await run(
      buildCreateScript({
        list: args.list,
        name: args.name,
        notes: args.notes,
        dueIso: args.due,
        provenance: ctx.provenance,
      })
    ),
  }),
});

export const reminderComplete = defineTool({
  name: "reminder_complete",
  description: "Set a reminder's completed state by id.",
  scope: "Reminders",
  mode: "write-gated",
  undo: "native",
  inputSchema: {
    id: z.string().min(1).describe("Reminder id (from reminders_search)"),
    completed: z.boolean().default(true),
  },
  planUndo: async (args: { id: string }) => {
    const current = JSON.parse(await run(buildGetScript(args.id)));
    return { restore: "reminder_complete", args: { id: args.id, completed: current.completed } };
  },
  preview: async (args: { id: string; completed?: boolean }) => {
    const state = args.completed === false ? "NOT completed" : "completed";
    try {
      const r = JSON.parse(await run(buildGetScript(args.id)));
      return `Would mark "${r.name}"${r.list ? ` (${r.list})` : ""} as ${state}.`;
    } catch {
      return `Would mark reminder ${args.id} as ${state}.`;
    }
  },
  handler: async (args: { id: string; completed?: boolean }) => ({
    content: await run(buildSetCompletedScript(args.id, args.completed !== false)),
  }),
});

export const reminderDelete = defineTool({
  name: "reminder_delete",
  description: "Delete a reminder by id. Destructive; undo recipe captured first.",
  scope: "Reminders",
  mode: "destructive",
  undo: "native",
  inputSchema: {
    id: z.string().min(1).describe("Reminder id (from reminders_search)"),
  },
  planUndo: async (args: { id: string }) => {
    // The full snapshot IS the undo recipe: recreate from it.
    const snapshot = JSON.parse(await run(buildGetScript(args.id)));
    return { restore: "reminder_create", args: snapshot };
  },
  // An approval you cannot evaluate is not consent: describe the actual
  // reminder, never just its opaque id (field-verified 2026-08-02 — a
  // deletion was approved blind because the prompt showed only a UUID).
  preview: async (args: { id: string }) => {
    try {
      const r = JSON.parse(await run(buildGetScript(args.id)));
      return (
        `Would permanently DELETE the reminder "${r.name}"` +
        (r.list ? ` from the "${r.list}" list` : "") +
        (r.due ? `, due ${new Date(r.due).toLocaleString()}` : ", with no due date") +
        (r.completed ? " (already completed)" : "") +
        "."
      );
    } catch {
      return `Would permanently delete reminder ${args.id} (details unreadable).`;
    }
  },
  handler: async (args: { id: string }) => ({
    content: await run(buildDeleteScript(args.id)),
  }),
});

export const reminderTools = [
  remindersLists,
  remindersSearch,
  reminderCreate,
  reminderComplete,
  reminderDelete,
];

export { VERSION };
