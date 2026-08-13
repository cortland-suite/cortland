import { z } from "zod";
import { defineTool, runJxa } from "@cortland/governed";
import {
  buildAppendScript,
  buildCreateScript,
  buildFoldersScript,
  buildGetBodyScript,
  buildReadScript,
  buildSearchScript,
} from "./scripts.js";

const VERSION = "0.1.0";
const TIMEOUT_MS = 120_000; // first call may wait on the Automation prompt

const run = (script: string) => runJxa(script, TIMEOUT_MS);

export const notesFolders = defineTool({
  name: "notes_folders",
  description: "List every Notes folder with its note count.",
  scope: "Notes",
  mode: "read",
  undo: "none",
  inputSchema: {},
  handler: async () => ({ content: await run(buildFoldersScript()) }),
});

export const notesSearch = defineTool({
  name: "notes_search",
  description:
    "Search notes by name, optionally within one folder. Returns a plain-text snippet of each body.",
  scope: "Notes",
  mode: "read",
  undo: "none",
  inputSchema: {
    folder: z.string().min(1).optional().describe("Limit to one folder by name"),
    query: z.string().optional().describe("Case-insensitive name match"),
    limit: z.number().int().min(1).max(100).default(25),
  },
  handler: async (args: { folder?: string; query?: string; limit?: number }) => ({
    content: await run(buildSearchScript({ ...args, limit: args.limit ?? 25 })),
  }),
});

export const noteRead = defineTool({
  name: "note_read",
  description:
    "Read a full note by id, HTML stripped to readable text; includes name, folder, and dates.",
  scope: "Notes",
  mode: "read",
  undo: "none",
  inputSchema: {
    id: z.string().min(1).describe("Note id (from notes_search)"),
  },
  handler: async (args: { id: string }) => ({
    content: await run(buildReadScript(args.id)),
  }),
});

export const noteCreate = defineTool({
  name: "note_create",
  description:
    "Create a note (default folder unless named). The note is a local, " +
    "provenance-stamped artifact you can see and delete on any device.",
  scope: "Notes",
  mode: "write-safe", // same tier as a mail draft: stays in the user's review loop
  undo: "compensate", // the correction is deleting it — its id exists only after the write
  redact: ["body"],
  inputSchema: {
    name: z.string().min(1),
    body: z.string().min(1),
    folder: z.string().min(1).optional(),
  },
  handler: async (
    args: { name: string; body: string; folder?: string },
    ctx
  ) => ({
    content: await run(
      buildCreateScript({
        folder: args.folder,
        name: args.name,
        body: args.body,
        provenance: ctx.provenance,
      })
    ),
  }),
});

export const noteAppend = defineTool({
  name: "note_append",
  description: "Append text to an existing note by id.",
  scope: "Notes",
  mode: "write-gated",
  undo: "native",
  redact: ["text"],
  inputSchema: {
    id: z.string().min(1).describe("Note id (from notes_search)"),
    text: z.string().min(1).describe("Plain text to append"),
  },
  planUndo: async (args: { id: string }) => {
    // The full pre-write body IS the undo recipe: put it back verbatim.
    const current = JSON.parse(await run(buildGetBodyScript(args.id)));
    return { restore: "note_set_body", args: { id: args.id, body: current.body } };
  },
  preview: (args: { id: string; text: string }) =>
    `Would append ${args.text.length} characters to note ${args.id}.`,
  handler: async (args: { id: string; text: string }) => ({
    content: await run(buildAppendScript(args.id, args.text)),
  }),
});

export const noteTools = [
  notesFolders,
  notesSearch,
  noteRead,
  noteCreate,
  noteAppend,
];

export { VERSION };
