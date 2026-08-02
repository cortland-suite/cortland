/**
 * JXA builders for Apple Reminders. Kept separate from the tool definitions so
 * tests can assert what the scripts DO before anything touches the real app —
 * and so argument embedding is auditable in one place: every user-supplied
 * value enters a script through JSON.stringify, never string concatenation.
 */

export interface SearchParams {
  list?: string;
  query?: string;
  includeCompleted?: boolean;
  dueBefore?: string;
  dueAfter?: string;
  limit: number;
}

export function buildListsScript(): string {
  return `
    const app = Application("Reminders");
    const rows = app.lists().map(l => ({
      name: l.name(),
      open: l.reminders.whose({ completed: false })().length
    }));
    JSON.stringify(rows);
  `;
}

export function buildSearchScript(p: SearchParams): string {
  return `
    const app = Application("Reminders");
    const lists = ${p.list !== undefined ? `[app.lists.byName(${JSON.stringify(p.list)})]` : "app.lists()"};
    const q = ${JSON.stringify(p.query?.toLowerCase() ?? "")};
    const includeCompleted = ${p.includeCompleted === true};
    const dueBefore = ${p.dueBefore ? `new Date(${JSON.stringify(p.dueBefore)})` : "null"};
    const dueAfter = ${p.dueAfter ? `new Date(${JSON.stringify(p.dueAfter)})` : "null"};
    const rows = [];
    for (const list of lists) {
      const items = includeCompleted ? list.reminders() : list.reminders.whose({ completed: false })();
      for (const r of items) {
        if (rows.length >= ${p.limit}) break;
        const name = r.name();
        if (q && !name.toLowerCase().includes(q)) continue;
        const due = r.dueDate();
        if (dueBefore && (!due || due > dueBefore)) continue;
        if (dueAfter && (!due || due < dueAfter)) continue;
        rows.push({
          id: r.id(), list: list.name(), name,
          due: due ? due.toISOString() : null,
          completed: r.completed(),
          notes: r.body() || null
        });
      }
      if (rows.length >= ${p.limit}) break;
    }
    JSON.stringify({ returned: rows.length, reminders: rows });
  `;
}

export function buildCreateScript(p: {
  list?: string;
  name: string;
  notes?: string;
  dueIso?: string;
  provenance: string;
}): string {
  const notes = p.notes ? `${p.notes}\n\n${p.provenance}` : p.provenance;
  return `
    const app = Application("Reminders");
    const list = ${p.list !== undefined ? `app.lists.byName(${JSON.stringify(p.list)})` : "app.defaultList()"};
    const reminder = app.Reminder({
      name: ${JSON.stringify(p.name)},
      body: ${JSON.stringify(notes)}${p.dueIso ? `,
      dueDate: new Date(${JSON.stringify(p.dueIso)})` : ""}
    });
    list.reminders.push(reminder);
    JSON.stringify({ created: true, id: reminder.id(), list: list.name() });
  `;
}

/** Full pre-write snapshot of one reminder — the raw material for undo. */
export function buildGetScript(id: string): string {
  return `
    const app = Application("Reminders");
    const r = app.reminders.byId(${JSON.stringify(id)});
    JSON.stringify({
      id: r.id(), name: r.name(), notes: r.body() || null,
      completed: r.completed(),
      due: r.dueDate() ? r.dueDate().toISOString() : null,
      list: r.container().name()
    });
  `;
}

export function buildSetCompletedScript(id: string, completed: boolean): string {
  return `
    const app = Application("Reminders");
    const r = app.reminders.byId(${JSON.stringify(id)});
    r.completed = ${completed};
    JSON.stringify({ done: true, id: r.id(), completed: r.completed() });
  `;
}

export function buildDeleteScript(id: string): string {
  return `
    const app = Application("Reminders");
    const r = app.reminders.byId(${JSON.stringify(id)});
    const snapshot = { name: r.name(), list: r.container().name() };
    app.delete(r);
    JSON.stringify({ deleted: true, was: snapshot });
  `;
}
