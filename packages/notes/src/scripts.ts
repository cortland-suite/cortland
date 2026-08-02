/**
 * JXA builders for Apple Notes. Kept separate from the tool definitions so
 * tests can assert what the scripts DO before anything touches the real app —
 * and so argument embedding is auditable in one place: every user-supplied
 * value enters a script through JSON.stringify, never string concatenation.
 *
 * Notes stores bodies as HTML. Read paths strip tags down to readable text
 * INSIDE the JXA, so raw markup never crosses the process boundary; the one
 * exception is the undo snapshot (buildGetBodyScript), which keeps the raw
 * HTML on purpose — a restore must be byte-exact, not "readable".
 */

export interface SearchParams {
  folder?: string;
  query?: string;
  limit: number;
}

/**
 * Inline HTML→text helper embedded in every read-path script. Tags out,
 * common entities decoded, whitespace collapsed. Lives here once so search
 * and read cannot drift apart.
 */
const STRIP_HTML = `
    const strip = (html) => html
      .replace(/<br[^>]*>/gi, "\\n")
      .replace(/<\\/(div|p|h[1-6]|li|tr)>/gi, "\\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \\t]+/g, " ")
      .replace(/\\n{3,}/g, "\\n\\n")
      .trim();
`;

export function buildFoldersScript(): string {
  return `
    const app = Application("Notes");
    const rows = app.folders().map(f => ({
      name: f.name(),
      notes: f.notes().length
    }));
    JSON.stringify(rows);
  `;
}

export function buildSearchScript(p: SearchParams): string {
  return `
    const app = Application("Notes");
    const folders = ${p.folder !== undefined ? `[app.folders.byName(${JSON.stringify(p.folder)})]` : "app.folders()"};
    const q = ${JSON.stringify(p.query?.toLowerCase() ?? "")};
    ${STRIP_HTML}
    const rows = [];
    for (const folder of folders) {
      const folderName = folder.name();
      for (const n of folder.notes()) {
        if (rows.length >= ${p.limit}) break;
        const name = n.name();
        if (q && !name.toLowerCase().includes(q)) continue;
        rows.push({
          id: n.id(), name, folder: folderName,
          modified: n.modificationDate().toISOString(),
          snippet: strip(n.body() || "").slice(0, 200)
        });
      }
      if (rows.length >= ${p.limit}) break;
    }
    JSON.stringify({ returned: rows.length, notes: rows });
  `;
}

export function buildReadScript(id: string): string {
  return `
    const app = Application("Notes");
    const n = app.notes.byId(${JSON.stringify(id)});
    ${STRIP_HTML}
    JSON.stringify({
      id: n.id(), name: n.name(), folder: n.container().name(),
      created: n.creationDate().toISOString(),
      modified: n.modificationDate().toISOString(),
      body: strip(n.body() || "")
    });
  `;
}

export function buildCreateScript(p: {
  folder?: string;
  name: string;
  body: string;
  provenance: string;
}): string {
  const body = `${p.body}\n\n${p.provenance}`;
  return `
    const app = Application("Notes");
    const folder = ${p.folder !== undefined ? `app.folders.byName(${JSON.stringify(p.folder)})` : "app.defaultAccount().defaultFolder()"};
    const note = app.Note({
      name: ${JSON.stringify(p.name)},
      body: ${JSON.stringify(body)}
    });
    folder.notes.push(note);
    JSON.stringify({ created: true, id: note.id(), folder: folder.name() });
  `;
}

/**
 * Raw pre-write snapshot of one note's body — the undo recipe's payload.
 * Deliberately NOT stripped: the restore must put back exactly what was there.
 */
export function buildGetBodyScript(id: string): string {
  return `
    const app = Application("Notes");
    const n = app.notes.byId(${JSON.stringify(id)});
    JSON.stringify({ id: n.id(), body: n.body() || "" });
  `;
}

export function buildAppendScript(id: string, text: string): string {
  return `
    const app = Application("Notes");
    const n = app.notes.byId(${JSON.stringify(id)});
    const text = ${JSON.stringify(text)};
    const esc = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const html = "<div>" + esc.split("\\n").join("</div><div>") + "</div>";
    n.body = n.body() + html;
    JSON.stringify({ appended: true, id: n.id(), characters: text.length });
  `;
}
