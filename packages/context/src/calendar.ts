import fs from "node:fs";
import path from "node:path";
import type { AuditStore } from "@honeycrisp/governed";
import { runJxa } from "@honeycrisp/governed";
import type { ContextStore } from "./store.js";

/**
 * Calendar capture (Q20 settled): Calendar.app Automation, ~30s per calendar
 * no matter the query — so this is a low-cadence sweep (daily) over an explicit
 * calendar ALLOWLIST from config. No allowlist, no sweep: capturing 17
 * calendars blind would take minutes and mostly index subscribed noise.
 */

import { ModelConfigSchema, type ModelConfig } from "./model.js";

export interface ContextConfig {
  calendars: string[];
  model?: ModelConfig;
  /** Days derived rows live before the capture-time prune (NOTES Q23).
   *  0 = keep forever. Anything unusable resolves to the 365 default. */
  retentionDays: number;
}

export const DEFAULT_RETENTION_DAYS = 365;

/** dataDir/context.json — any error resolves to safe defaults (no calendars,
 * no model, default retention). A malformed model block means NO model, never
 * a guessed one. */
export function loadContextConfig(dataDir: string): ContextConfig {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(dataDir, "context.json"), "utf8")
    );
    const obj = parsed as { calendars?: unknown; model?: unknown; retentionDays?: unknown };
    const calendars =
      Array.isArray(obj.calendars) && obj.calendars.every((c) => typeof c === "string")
        ? (obj.calendars as string[])
        : [];
    let model: ModelConfig | undefined;
    if (obj.model !== undefined) {
      const result = ModelConfigSchema.safeParse(obj.model);
      model = result.success ? result.data : undefined;
    }
    const retentionDays =
      typeof obj.retentionDays === "number" &&
      Number.isFinite(obj.retentionDays) &&
      obj.retentionDays >= 0
        ? Math.floor(obj.retentionDays)
        : DEFAULT_RETENTION_DAYS;
    return { calendars, model, retentionDays };
  } catch {
    return { calendars: [], retentionDays: DEFAULT_RETENTION_DAYS };
  }
}

export interface CalendarCaptureParams {
  calendars: string[];
  startIso: string;
  endIso: string;
  /** Events starting before this get attendees fetched (per-event cost). */
  attendeeCutoffIso: string;
}

export function buildCalendarCaptureScript(p: CalendarCaptureParams): string {
  return `
const Cal = Application("Calendar");
if (!Cal.running()) { Cal.launch(); }
const names = ${JSON.stringify(p.calendars)};
const d1 = new Date(${JSON.stringify(p.startIso)});
const d2 = new Date(${JSON.stringify(p.endIso)});
const attendeeCutoff = new Date(${JSON.stringify(p.attendeeCutoffIso)});
const rows = [];
for (const name of names) {
  const cals = Cal.calendars.whose({ name: name })();
  if (cals.length === 0) continue;
  const coll = cals[0].events.whose({
    _and: [{ startDate: { _greaterThan: d1 } }, { startDate: { _lessThan: d2 } }]
  });
  const uids = coll.uid();
  const summaries = coll.summary();
  const starts = coll.startDate();
  const ends = coll.endDate();
  const locations = coll.location();
  const alldays = coll.alldayEvent();
  const evs = coll();
  for (let i = 0; i < uids.length; i++) {
    const row = {
      uid: uids[i],
      summary: summaries[i] || null,
      start: starts[i] ? starts[i].toISOString() : null,
      end: ends[i] ? ends[i].toISOString() : null,
      location: locations[i] || null,
      allDay: !!alldays[i],
      calendar: name,
      attendees: []
    };
    if (starts[i] && starts[i] < attendeeCutoff) {
      try {
        row.attendees = evs[i].attendees().map(a => ({
          name: a.displayName() || null,
          email: a.email() || null
        }));
      } catch (e) { /* attendees unavailable on some event types */ }
    }
    rows.push(row);
  }
}
JSON.stringify({ rows: rows });
`;
}

export interface CalendarCaptureDeps {
  audit: AuditStore;
  version: string;
  log: (message: string) => void;
  runScript?: (script: string, timeoutMs: number) => Promise<string>;
  config?: ContextConfig;
  now?: Date;
  /** Sweep even if one ran recently. */
  force?: boolean;
}

export interface CalendarCaptureSummary {
  skipped: boolean;
  reason?: string;
  calendars: number;
  events: number;
}

/** The sweep costs ~30s/calendar (Q20), so at most one per this many hours —
 * the 15-minute capture schedule must not pay it every cycle. */
const SWEEP_MIN_INTERVAL_HOURS = 20;

export async function captureCalendar(
  store: ContextStore,
  dataDir: string,
  deps: CalendarCaptureDeps
): Promise<CalendarCaptureSummary> {
  const config = deps.config ?? loadContextConfig(dataDir);
  if (config.calendars.length === 0) {
    deps.log(
      "calendar capture skipped: no allowlist. Add {\"calendars\": [\"Work\", ...]} " +
        `to ${path.join(dataDir, "context.json")} (names via: honeycrisp-context calendars)`
    );
    return { skipped: true, reason: "no-allowlist", calendars: 0, events: 0 };
  }
  const exec = deps.runScript ?? runJxa;
  const now = deps.now ?? new Date();
  const lastSweep = store.getCursor("calendar:last_sweep");
  if (
    !deps.force &&
    lastSweep &&
    now.getTime() - new Date(lastSweep).getTime() < SWEEP_MIN_INTERVAL_HOURS * 3_600_000
  ) {
    deps.log(`calendar capture skipped: last sweep ${lastSweep} (daily cadence)`);
    return { skipped: true, reason: "recent-sweep", calendars: 0, events: 0 };
  }
  const script = buildCalendarCaptureScript({
    calendars: config.calendars,
    startIso: new Date(now.getTime() - 86_400_000).toISOString(),
    endIso: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
    attendeeCutoffIso: new Date(now.getTime() + 2 * 86_400_000).toISOString(),
  });
  // ~30s per calendar is the platform cost; give each one 90s.
  const output = await exec(script, Math.max(120_000, config.calendars.length * 90_000));
  const parsed = JSON.parse(output) as {
    rows: Array<{
      uid: string;
      summary: string | null;
      start: string | null;
      end: string | null;
      location: string | null;
      allDay: boolean;
      calendar: string;
      attendees: Array<{ name: string | null; email: string | null }>;
    }>;
  };
  for (const row of parsed.rows) {
    if (!row.uid || !row.start) continue;
    store.upsertEvent(row);
    if (row.attendees.length > 0) {
      store.setEventAttendees(row.uid, row.start, row.attendees);
    }
  }
  store.setCursor("calendar:last_sweep", now.toISOString());
  deps.audit.record({
    tool: "context_capture_calendar",
    scope: "Calendar→ContextStore",
    mode: "write-safe",
    undo: "none",
    args: { calendars: config.calendars.length, events: parsed.rows.length },
    dryRun: false,
    outcome: "ok",
    toolVersion: deps.version,
  });
  deps.log(
    `calendar capture: ${parsed.rows.length} events from ${config.calendars.length} calendar(s)`
  );
  return { skipped: false, calendars: config.calendars.length, events: parsed.rows.length };
}
