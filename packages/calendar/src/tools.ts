import { z } from "zod";
import { defineTool, runJxa } from "@honeycrisp/governed";
import {
  buildCalendarsScript,
  buildCreateScript,
  buildDeleteScript,
  buildEventsWindowScript,
  buildGetEventScript,
} from "./scripts.js";

const VERSION = "0.1.0";
const TIMEOUT_MS = 120_000; // Calendar Automation is ~30s/calendar (Q20); first call may also wait on the Automation prompt

const run = (script: string) => runJxa(script, TIMEOUT_MS);

/** Widest window one query may span (Q20: queries are slow; keep them bounded). */
export const MAX_WINDOW_DAYS = 62;

/** Throws unless startAfter < startBefore and the span is within MAX_WINDOW_DAYS. */
export function assertWindow(startAfter: string, startBefore: string): void {
  const spanMs = new Date(startBefore).getTime() - new Date(startAfter).getTime();
  if (!(spanMs > 0)) {
    throw new Error("startBefore must be after startAfter");
  }
  if (spanMs > MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    throw new Error(
      `Window too wide: max ${MAX_WINDOW_DAYS} days per query (Calendar queries cost ~30s each; keep them bounded)`
    );
  }
}

export const calendarsList = defineTool({
  name: "calendars_list",
  description: "List every calendar by name, with its writable flag when available.",
  scope: "Calendar",
  mode: "read",
  undo: "none",
  inputSchema: {},
  handler: async () => ({ content: await run(buildCalendarsScript()) }),
});

export const eventsWindow = defineTool({
  name: "events_window",
  description:
    "Events in ONE named calendar within a bounded start-date window (max 62 days). " +
    "The calendar is required by design: Calendar queries cost ~30s per calendar, " +
    "so this tool never scans all calendars — query them one at a time.",
  scope: "Calendar",
  mode: "read",
  undo: "none",
  inputSchema: {
    calendar: z.string().min(1).describe("Calendar name (from calendars_list) — required, one per query"),
    startAfter: z.string().datetime({ offset: true, local: true }).describe("Window start (ISO datetime)"),
    startBefore: z.string().datetime({ offset: true, local: true }).describe("Window end (ISO datetime, at most 62 days after startAfter)"),
    limit: z.number().int().min(1).max(200).default(50),
  },
  handler: async (args: {
    calendar: string;
    startAfter: string;
    startBefore: string;
    limit?: number;
  }) => {
    assertWindow(args.startAfter, args.startBefore);
    return {
      content: await run(
        buildEventsWindowScript({ ...args, limit: args.limit ?? 50 })
      ),
    };
  },
});

export const eventCreate = defineTool({
  name: "event_create",
  description:
    "Create a calendar event (local, provenance-stamped — visible and deletable " +
    "on any device). Deliberately takes NO attendees: v1 cannot send invitations, " +
    "so the outward path does not exist. Worst case is a stray event on your own " +
    "calendar, not an email in someone else's inbox.",
  scope: "Calendar",
  mode: "write-safe", // same tier as a mail draft: stays in the user's review loop
  undo: "compensate", // the correction is deleting it — its uid exists only after the write
  redact: ["description"],
  inputSchema: {
    calendar: z.string().min(1).describe("Calendar name (from calendars_list)"),
    summary: z.string().min(1).describe("Event title"),
    startIso: z.string().datetime({ offset: true, local: true }),
    endIso: z.string().datetime({ offset: true, local: true }),
    location: z.string().optional(),
    description: z.string().optional(),
  },
  handler: async (
    args: {
      calendar: string;
      summary: string;
      startIso: string;
      endIso: string;
      location?: string;
      description?: string;
    },
    ctx
  ) => ({
    content: await run(
      buildCreateScript({
        calendar: args.calendar,
        summary: args.summary,
        startIso: args.startIso,
        endIso: args.endIso,
        location: args.location,
        description: args.description,
        provenance: ctx.provenance,
      })
    ),
  }),
});

export const eventDelete = defineTool({
  name: "event_delete",
  description:
    "Delete an event by calendar + uid. Destructive; undo recipe captured first.",
  scope: "Calendar",
  mode: "destructive",
  undo: "native",
  inputSchema: {
    calendar: z.string().min(1).describe("Calendar name (from calendars_list)"),
    uid: z.string().min(1).describe("Event uid (from events_window)"),
  },
  planUndo: async (args: { calendar: string; uid: string }) => {
    // The full snapshot IS the undo recipe: recreate from it.
    const snapshot = JSON.parse(
      await run(buildGetEventScript(args.calendar, args.uid))
    );
    return { restore: "event_create", args: snapshot };
  },
  preview: (args: { calendar: string; uid: string }) =>
    `Would permanently delete event ${args.uid} from calendar "${args.calendar}".`,
  handler: async (args: { calendar: string; uid: string }) => ({
    content: await run(buildDeleteScript(args.calendar, args.uid)),
  }),
});

export const calendarTools = [
  calendarsList,
  eventsWindow,
  eventCreate,
  eventDelete,
];

export { VERSION };
