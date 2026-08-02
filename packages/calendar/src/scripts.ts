/**
 * JXA builders for Apple Calendar. Kept separate from the tool definitions so
 * tests can assert what the scripts DO before anything touches the real app —
 * and so argument embedding is auditable in one place: every user-supplied
 * value enters a script through JSON.stringify, never string concatenation.
 *
 * Performance reality (NOTES Q20): Calendar.app Automation costs ~30s PER
 * CALENDAR regardless of query shape, so every event query here targets ONE
 * named calendar with a bounded date window. Nothing in this file scans all
 * calendars.
 */

export interface WindowParams {
  calendar: string;
  startAfter: string;
  startBefore: string;
  limit: number;
}

export function buildCalendarsScript(): string {
  return `
    const app = Application("Calendar");
    const rows = app.calendars().map(c => {
      let writable = null;
      try { writable = c.writable(); } catch (e) { /* name-only is fine */ }
      return { name: c.name(), writable };
    });
    JSON.stringify(rows);
  `;
}

export function buildEventsWindowScript(p: WindowParams): string {
  return `
    const app = Application("Calendar");
    const cal = app.calendars.byName(${JSON.stringify(p.calendar)});
    const after = new Date(${JSON.stringify(p.startAfter)});
    const before = new Date(${JSON.stringify(p.startBefore)});
    const events = cal.events.whose({
      _and: [
        { startDate: { _greaterThan: after } },
        { startDate: { _lessThan: before } }
      ]
    })();
    const rows = [];
    for (const e of events) {
      if (rows.length >= ${p.limit}) break;
      rows.push({
        uid: e.uid(),
        summary: e.summary(),
        start: e.startDate().toISOString(),
        end: e.endDate().toISOString(),
        location: e.location() || null,
        allDay: e.alldayEvent()
      });
    }
    JSON.stringify({ calendar: cal.name(), returned: rows.length, events: rows });
  `;
}

export function buildCreateScript(p: {
  calendar: string;
  summary: string;
  startIso: string;
  endIso: string;
  location?: string;
  description?: string;
  provenance: string;
}): string {
  const description = p.description
    ? `${p.description}\n\n${p.provenance}`
    : p.provenance;
  return `
    const app = Application("Calendar");
    const cal = app.calendars.byName(${JSON.stringify(p.calendar)});
    const event = app.Event({
      summary: ${JSON.stringify(p.summary)},
      startDate: new Date(${JSON.stringify(p.startIso)}),
      endDate: new Date(${JSON.stringify(p.endIso)}),
      description: ${JSON.stringify(description)}${p.location !== undefined ? `,
      location: ${JSON.stringify(p.location)}` : ""}
    });
    cal.events.push(event);
    JSON.stringify({ created: true, uid: event.uid(), calendar: cal.name() });
  `;
}

/**
 * Full pre-write snapshot of one event — the raw material for undo. The uid
 * lookup is a whose() over one calendar, the same bounded shape as the window
 * query (acceptable per Q20; never a cross-calendar scan).
 */
export function buildGetEventScript(calendar: string, uid: string): string {
  return `
    const app = Application("Calendar");
    const cal = app.calendars.byName(${JSON.stringify(calendar)});
    const e = cal.events.whose({ uid: ${JSON.stringify(uid)} })()[0];
    if (!e) throw new Error("No event with uid " + ${JSON.stringify(uid)} + " in calendar " + cal.name());
    JSON.stringify({
      calendar: cal.name(),
      summary: e.summary(),
      startIso: e.startDate().toISOString(),
      endIso: e.endDate().toISOString(),
      location: e.location() || undefined,
      description: e.description() || undefined
    });
  `;
}

export function buildDeleteScript(calendar: string, uid: string): string {
  return `
    const app = Application("Calendar");
    const cal = app.calendars.byName(${JSON.stringify(calendar)});
    const e = cal.events.whose({ uid: ${JSON.stringify(uid)} })()[0];
    if (!e) throw new Error("No event with uid " + ${JSON.stringify(uid)} + " in calendar " + cal.name());
    const snapshot = { summary: e.summary(), calendar: cal.name() };
    app.delete(e);
    JSON.stringify({ deleted: true, was: snapshot });
  `;
}
