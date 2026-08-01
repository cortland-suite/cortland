import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * The context store. PRIME DIRECTIVE (docs/04): derived metadata and POINTERS
 * only — message bodies are never stored here. Rows reference Mail by
 * messageId; content is fetched live through the governed Mail tools by
 * whoever holds that permission.
 */

export interface CapturedMessage {
  messageId: string;
  subject: string | null;
  sender: string | null; // raw "Name <addr>" as Mail reports it
  date: string | null; // ISO
  read: boolean | null;
  mailbox: string;
}

export interface PersonRow {
  address: string;
  name: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  inboundCount: number;
  outboundCount: number;
}

/** Parse "Display Name <addr@host>" | "addr@host" into parts. */
export function parseAddress(raw: string | null): {
  name: string | null;
  address: string | null;
} {
  if (!raw) return { name: null, address: null };
  const angled = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (angled) {
    return {
      name: angled[1].trim() || null,
      address: angled[2].trim().toLowerCase() || null,
    };
  }
  const bare = raw.trim();
  return bare.includes("@")
    ? { name: null, address: bare.toLowerCase() }
    : { name: bare || null, address: null };
}

export class ContextStore {
  private db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "context.db");
    this.db = new Database(file);
    fs.chmodSync(file, 0o600); // the index of a life is itself sensitive
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        subject TEXT, sender_name TEXT, sender_address TEXT,
        date_received TEXT, mailbox TEXT NOT NULL, read INTEGER,
        captured_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date_received);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        message_id UNINDEXED, subject, sender
      );
      CREATE TABLE IF NOT EXISTS recipients (
        message_id TEXT NOT NULL,
        address TEXT NOT NULL,
        PRIMARY KEY (message_id, address)
      );
      CREATE TABLE IF NOT EXISTS people (
        address TEXT PRIMARY KEY,
        name TEXT, first_seen TEXT, last_seen TEXT,
        inbound_count INTEGER NOT NULL DEFAULT 0,
        outbound_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS cursors (
        source TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        uid TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT, summary TEXT, location TEXT,
        calendar TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0,
        captured_at TEXT NOT NULL,
        PRIMARY KEY (uid, start_date)
      );
      CREATE TABLE IF NOT EXISTS event_attendees (
        uid TEXT NOT NULL, start_date TEXT NOT NULL,
        address TEXT, name TEXT,
        PRIMARY KEY (uid, start_date, address)
      );
      /* AI layer: immutable once written (M3). */
      CREATE TABLE IF NOT EXISTS commitments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        commitment TEXT NOT NULL,
        due TEXT,
        provider TEXT NOT NULL,
        extracted_at TEXT NOT NULL
      );
      /* Human layer: joined at serve time, never rewrites AI rows (M4). */
      CREATE TABLE IF NOT EXISTS judgments (
        target TEXT NOT NULL,
        verdict TEXT NOT NULL,
        detail TEXT,
        source_file TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        PRIMARY KEY (target, source_file)
      );
    `);
  }

  /** Insert if unseen. Returns true when the message is new. */
  upsertMessage(m: CapturedMessage): boolean {
    const { name, address } = parseAddress(m.sender);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
         (message_id, subject, sender_name, sender_address, date_received, mailbox, read, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.messageId,
        m.subject,
        name,
        address,
        m.date,
        m.mailbox,
        m.read === null ? null : m.read ? 1 : 0,
        new Date().toISOString()
      );
    const isNew = result.changes > 0;
    if (isNew) {
      this.db
        .prepare(`INSERT INTO messages_fts (message_id, subject, sender) VALUES (?, ?, ?)`)
        .run(m.messageId, m.subject ?? "", m.sender ?? "");
    }
    return isNew;
  }

  notePerson(
    rawAddress: string,
    name: string | null,
    direction: "inbound" | "outbound",
    dateIso: string | null
  ): void {
    const address = rawAddress.trim().toLowerCase();
    if (!address.includes("@")) return;
    const column = direction === "inbound" ? "inbound_count" : "outbound_count";
    this.db
      .prepare(
        `INSERT INTO people (address, name, first_seen, last_seen, ${column})
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(address) DO UPDATE SET
           ${column} = ${column} + 1,
           name = COALESCE(excluded.name, people.name),
           first_seen = MIN(COALESCE(people.first_seen, excluded.first_seen), excluded.first_seen),
           last_seen = MAX(COALESCE(people.last_seen, excluded.last_seen), excluded.last_seen)`
      )
      .run(address, name, dateIso, dateIso);
  }

  addRecipients(messageId: string, addresses: string[]): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO recipients (message_id, address) VALUES (?, ?)`
    );
    for (const a of addresses) stmt.run(messageId, a.trim().toLowerCase());
  }

  getCursor(source: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM cursors WHERE source = ?`)
      .get(source) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setCursor(source: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO cursors (source, value) VALUES (?, ?)
         ON CONFLICT(source) DO UPDATE SET value = excluded.value`
      )
      .run(source, value);
  }

  changesSince(sinceIso: string): {
    since: string;
    newMessageCount: number;
    byMailbox: Array<{ mailbox: string; count: number }>;
    topSenders: Array<{
      sender: string;
      address: string | null;
      count: number;
      citations: string[];
    }>;
    newPeople: Array<{ address: string; name: string | null; firstSeen: string | null }>;
    activeSubjects: Array<{ subject: string; count: number; citations: string[] }>;
  } {
    const muted = this.mutedTargets();
    const messages = (
      this.db
        .prepare(`SELECT * FROM messages WHERE date_received >= ? ORDER BY date_received DESC`)
        .all(sinceIso) as Array<Record<string, unknown>>
    ).filter(
      (m) =>
        !muted.has(`sender:${(m.sender_address as string) ?? ""}`) &&
        !muted.has(`subject:${normalizeSubject((m.subject as string) ?? "")}`)
    );
    const byMailbox = new Map<string, number>();
    const bySender = new Map<
      string,
      { count: number; citations: string[]; address: string | null }
    >();
    const bySubject = new Map<string, { count: number; citations: string[] }>();
    for (const m of messages) {
      const mailbox = m.mailbox as string;
      byMailbox.set(mailbox, (byMailbox.get(mailbox) ?? 0) + 1);
      const sender = (m.sender_name as string) || (m.sender_address as string) || "(unknown)";
      const s = bySender.get(sender) ?? {
        count: 0,
        citations: [],
        address: (m.sender_address as string) ?? null,
      };
      s.count += 1;
      if (s.citations.length < 5) s.citations.push(m.message_id as string);
      bySender.set(sender, s);
      const subject = normalizeSubject((m.subject as string) ?? "");
      if (subject) {
        const t = bySubject.get(subject) ?? { count: 0, citations: [] };
        t.count += 1;
        if (t.citations.length < 5) t.citations.push(m.message_id as string);
        bySubject.set(subject, t);
      }
    }
    const newPeople = this.db
      .prepare(
        `SELECT address, name, first_seen FROM people
         WHERE first_seen >= ? ORDER BY first_seen DESC LIMIT 20`
      )
      .all(sinceIso) as Array<{ address: string; name: string | null; first_seen: string | null }>;
    return {
      since: sinceIso,
      newMessageCount: messages.length,
      byMailbox: [...byMailbox.entries()].map(([mailbox, count]) => ({ mailbox, count })),
      topSenders: [...bySender.entries()]
        .map(([sender, v]) => ({ sender, ...v }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      newPeople: newPeople.map((p) => ({
        address: p.address,
        name: p.name,
        firstSeen: p.first_seen,
      })),
      activeSubjects: [...bySubject.entries()]
        .map(([subject, v]) => ({ subject, ...v }))
        .filter((t) => t.count > 1)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    };
  }

  findPeople(query: string): Array<
    PersonRow & { recentMessages: Array<{ messageId: string; subject: string | null; date: string | null }> }
  > {
    const like = `%${query.toLowerCase()}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM people
         WHERE address LIKE ? OR LOWER(COALESCE(name,'')) LIKE ?
         ORDER BY inbound_count + outbound_count DESC LIMIT 10`
      )
      .all(like, like) as Array<Record<string, unknown>>;
    return rows.map((p) => {
      const address = p.address as string;
      const recent = this.db
        .prepare(
          `SELECT message_id, subject, date_received FROM messages
           WHERE sender_address = ?
              OR message_id IN (SELECT message_id FROM recipients WHERE address = ?)
           ORDER BY date_received DESC LIMIT 10`
        )
        .all(address, address) as Array<Record<string, unknown>>;
      return {
        address,
        name: (p.name as string) ?? null,
        firstSeen: (p.first_seen as string) ?? null,
        lastSeen: (p.last_seen as string) ?? null,
        inboundCount: p.inbound_count as number,
        outboundCount: p.outbound_count as number,
        recentMessages: recent.map((m) => ({
          messageId: m.message_id as string,
          subject: (m.subject as string) ?? null,
          date: (m.date_received as string) ?? null,
        })),
      };
    });
  }

  upsertEvent(e: {
    uid: string;
    start: string | null;
    end: string | null;
    summary: string | null;
    location: string | null;
    calendar: string;
    allDay: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO events
         (uid, start_date, end_date, summary, location, calendar, all_day, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.uid,
        e.start,
        e.end,
        e.summary,
        e.location,
        e.calendar,
        e.allDay ? 1 : 0,
        new Date().toISOString()
      );
  }

  setEventAttendees(
    uid: string,
    start: string,
    attendees: Array<{ name: string | null; email: string | null }>
  ): void {
    this.db
      .prepare(`DELETE FROM event_attendees WHERE uid = ? AND start_date = ?`)
      .run(uid, start);
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO event_attendees (uid, start_date, address, name) VALUES (?, ?, ?, ?)`
    );
    for (const a of attendees) {
      stmt.run(uid, start, a.email?.toLowerCase() ?? null, a.name);
    }
  }

  eventsBetween(startIso: string, endIso: string): Array<{
    uid: string;
    start: string;
    end: string | null;
    summary: string | null;
    location: string | null;
    calendar: string;
    allDay: boolean;
    attendees: Array<{ address: string | null; name: string | null }>;
  }> {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE start_date >= ? AND start_date < ? ORDER BY start_date`
      )
      .all(startIso, endIso) as Array<Record<string, unknown>>;
    return rows.map((e) => ({
      uid: e.uid as string,
      start: e.start_date as string,
      end: (e.end_date as string) ?? null,
      summary: (e.summary as string) ?? null,
      location: (e.location as string) ?? null,
      calendar: e.calendar as string,
      allDay: (e.all_day as number) === 1,
      attendees: (
        this.db
          .prepare(`SELECT address, name FROM event_attendees WHERE uid = ? AND start_date = ?`)
          .all(e.uid, e.start_date) as Array<{ address: string | null; name: string | null }>
      ),
    }));
  }

  /** Recent message pointers involving any of these addresses (inbound or outbound). */
  recentMessagesFromAddresses(
    addresses: string[],
    sinceIso: string,
    limit: number
  ): Array<{ messageId: string; subject: string | null; date: string | null; sender: string | null }> {
    if (addresses.length === 0) return [];
    const placeholders = addresses.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT m.message_id, m.subject, m.date_received, m.sender_name, m.sender_address
         FROM messages m
         LEFT JOIN recipients r ON r.message_id = m.message_id
         WHERE m.date_received >= ?
           AND (m.sender_address IN (${placeholders}) OR r.address IN (${placeholders}))
         ORDER BY m.date_received DESC LIMIT ?`
      )
      .all(sinceIso, ...addresses, ...addresses, limit) as Array<Record<string, unknown>>;
    return rows.map((m) => ({
      messageId: m.message_id as string,
      subject: (m.subject as string) ?? null,
      date: (m.date_received as string) ?? null,
      sender: (m.sender_name as string) ?? (m.sender_address as string) ?? null,
    }));
  }

  /** FTS over captured subjects/senders. */
  searchMessages(
    text: string,
    sinceIso: string,
    limit: number
  ): Array<{ messageId: string; subject: string | null; date: string | null }> {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = this.db
        .prepare(
          `SELECT m.message_id, m.subject, m.date_received
           FROM messages_fts f JOIN messages m ON m.message_id = f.message_id
           WHERE messages_fts MATCH ? AND m.date_received >= ?
           ORDER BY m.date_received DESC LIMIT ?`
        )
        .all(ftsQuote(text), sinceIso, limit) as Array<Record<string, unknown>>;
    } catch {
      rows = []; // an unparsable query is an empty result, not a crash
    }
    return rows.map((m) => ({
      messageId: m.message_id as string,
      subject: (m.subject as string) ?? null,
      date: (m.date_received as string) ?? null,
    }));
  }

  sentMessagesSince(
    sinceIso: string,
    limit: number
  ): Array<{ messageId: string; subject: string | null; date: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT message_id, subject, date_received FROM messages
         WHERE mailbox = 'sent' AND date_received >= ?
         ORDER BY date_received DESC LIMIT ?`
      )
      .all(sinceIso, limit) as Array<Record<string, unknown>>;
    return rows.map((m) => ({
      messageId: m.message_id as string,
      subject: (m.subject as string) ?? null,
      date: (m.date_received as string) ?? null,
    }));
  }

  /** Insert-or-ignore: the AI layer is immutable (re-extraction never rewrites). */
  addCommitment(c: {
    id: string;
    messageId: string;
    text: string;
    due: string | null;
    provider: string;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO commitments (id, message_id, commitment, due, provider, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(c.id, c.messageId, c.text, c.due, c.provider, new Date().toISOString());
    return result.changes > 0;
  }

  hasCommitmentsFor(messageId: string): boolean {
    return Boolean(
      this.db.prepare(`SELECT 1 FROM commitments WHERE message_id = ? LIMIT 1`).get(messageId)
    );
  }

  openCommitments(): Array<{
    id: string;
    messageId: string;
    text: string;
    due: string | null;
    provider: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT * FROM commitments ORDER BY due IS NULL, due, extracted_at DESC LIMIT 25`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((c) => ({
      id: c.id as string,
      messageId: c.message_id as string,
      text: c.commitment as string,
      due: (c.due as string) ?? null,
      provider: c.provider as string,
    }));
  }

  addJudgment(j: {
    target: string;
    verdict: string;
    detail?: string;
    sourceFile: string;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO judgments (target, verdict, detail, source_file, ingested_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(j.target, j.verdict, j.detail ?? null, j.sourceFile, new Date().toISOString());
    return result.changes > 0;
  }

  mutedTargets(): Set<string> {
    const rows = this.db
      .prepare(`SELECT DISTINCT target FROM judgments WHERE verdict = 'mute'`)
      .all() as Array<{ target: string }>;
    return new Set(rows.map((r) => r.target));
  }

  /**
   * Retention pass (NOTES Q23): remove derived rows older than the cutoff.
   * Touches messages (+ fts + recipients), events (+ attendees), commitments.
   * NEVER touches people, judgments, or cursors — see retention.ts for why.
   */
  pruneOlderThan(cutoffIso: string): {
    messages: number;
    events: number;
    commitments: number;
  } {
    const run = this.db.transaction(() => {
      const oldIds = (
        this.db
          .prepare(
            `SELECT message_id FROM messages
             WHERE date_received IS NOT NULL AND date_received < ?`
          )
          .all(cutoffIso) as Array<{ message_id: string }>
      ).map((r) => r.message_id);
      const del = this.db.prepare(`DELETE FROM messages WHERE message_id = ?`);
      const delFts = this.db.prepare(`DELETE FROM messages_fts WHERE message_id = ?`);
      const delRcpt = this.db.prepare(`DELETE FROM recipients WHERE message_id = ?`);
      for (const id of oldIds) {
        del.run(id);
        delFts.run(id);
        delRcpt.run(id);
      }
      this.db
        .prepare(`DELETE FROM event_attendees WHERE start_date < ?`)
        .run(cutoffIso);
      const events = this.db
        .prepare(`DELETE FROM events WHERE start_date < ?`)
        .run(cutoffIso).changes;
      const commitments = this.db
        .prepare(`DELETE FROM commitments WHERE extracted_at < ?`)
        .run(cutoffIso).changes;
      return { messages: oldIds.length, events, commitments };
    });
    return run();
  }

  counts(): { messages: number; people: number } {
    const m = this.db.prepare(`SELECT COUNT(*) c FROM messages`).get() as { c: number };
    const p = this.db.prepare(`SELECT COUNT(*) c FROM people`).get() as { c: number };
    return { messages: m.c, people: p.c };
  }

  close(): void {
    this.db.close();
  }
}

export function normalizeSubject(subject: string): string {
  let s = subject;
  while (/^\s*(re|fw|fwd)\s*:/i.test(s)) s = s.replace(/^\s*(re|fw|fwd)\s*:/i, "");
  return s.trim().toLowerCase();
}

/** Quote user text as a single FTS5 phrase so operators can't inject syntax. */
function ftsQuote(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}
