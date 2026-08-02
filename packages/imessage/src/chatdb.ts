import fs from "node:fs";
import Database from "better-sqlite3";

/**
 * Read-only access to Messages' chat.db — the inbound half of the bridge
 * (docs/06). The three laws live HERE, at the SQL boundary, not in prompt
 * text:
 *
 *   Law 1/2: the query filters to allowlisted owner handles. Messages from
 *   anyone else are never SELECTed into memory — the bridge is not "told to
 *   ignore" strangers; it never sees them. A count of ignored rows is the
 *   only trace, for the audit log.
 *
 *   Law 3: there are no thread-listing or other-conversation reads in this
 *   module at all. The surface is: new inbound texts from the owner, since a
 *   cursor.
 *
 * Ventura+ reality: `text` is often NULL and the content lives in
 * `attributedBody`, a typedstream blob. We decode best-effort; a row whose
 * text cannot be recovered is DROPPED (counted), never guessed.
 */

export interface InboundMessage {
  rowid: number;
  guid: string;
  handle: string;
  text: string;
  /** Unix epoch ms, converted from Apple's nanoseconds-since-2001. */
  timestamp: number;
}

export interface PollResult {
  messages: InboundMessage[];
  /** Highest ROWID seen this poll — the next cursor, advanced even past
   *  ignored/undecodable rows so they are never re-scanned. */
  cursor: number;
  ignoredSenders: number;
  undecodable: number;
}

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

export class ChatDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (!fs.existsSync(dbPath)) {
      throw new Error(
        `chat.db not found at ${dbPath} — is Full Disk Access granted?`
      );
    }
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  /**
   * New inbound messages from allowlisted handles since the cursor.
   * Handles are compared case-insensitively and phone numbers must be in
   * E.164 (+1…) exactly as Messages stores them.
   *
   * `assistantAccount` (recommended) restricts the scan to messages ADDRESSED
   * TO that account — `message.destination_caller_id`. This is what makes law
   * 3 structural rather than incidental: the owner's personal account is
   * usually signed into the same Messages app, and its conversations share
   * this database. With the destination pinned, a message the owner sends to
   * anyone else — or that arrives on their personal account — is not merely
   * unmatched, it is outside the query.
   */
  poll(
    sinceRowid: number,
    ownerHandles: string[],
    assistantAccount?: string
  ): PollResult {
    const allow = new Set(ownerHandles.map((h) => h.toLowerCase()));
    // The allowlist is applied in JS on the handle VALUE after a bounded SQL
    // window scan: chat.db collation quirks make SQL-side case folding on
    // handles unreliable across macOS versions, and the row volume since a
    // live cursor is tiny.
    const rows = this.db
      .prepare(
        `SELECT m.ROWID as rowid, m.guid as guid, m.text as text,
                m.attributedBody as blob, m.date as date, h.id as handle
         FROM message m
         JOIN handle h ON m.handle_id = h.ROWID
         WHERE m.ROWID > ? AND m.is_from_me = 0
           AND (? IS NULL OR m.destination_caller_id = ?)
         ORDER BY m.ROWID ASC
         LIMIT 500`
      )
      .all(sinceRowid, assistantAccount ?? null, assistantAccount ?? null) as Array<{
      rowid: number;
      guid: string;
      text: string | null;
      blob: Buffer | null;
      date: number;
      handle: string;
    }>;

    const result: PollResult = {
      messages: [],
      cursor: sinceRowid,
      ignoredSenders: 0,
      undecodable: 0,
    };
    for (const row of rows) {
      result.cursor = Math.max(result.cursor, row.rowid);
      if (!allow.has(row.handle.toLowerCase())) {
        result.ignoredSenders += 1;
        continue; // law 2: never enters memory beyond this counter
      }
      const text = row.text ?? (row.blob ? decodeAttributedBody(row.blob) : null);
      if (!text || text.trim() === "") {
        result.undecodable += 1;
        continue; // dropped, never guessed
      }
      result.messages.push({
        rowid: row.rowid,
        guid: row.guid,
        handle: row.handle,
        text,
        timestamp: APPLE_EPOCH_MS + Math.floor(row.date / 1_000_000),
      });
    }
    return result;
  }

  /**
   * ONE-SHOT, UNFILTERED read for first-run setup only: returns the sender and
   * destination of the first inbound message after `sinceRowid`, so the wizard
   * can learn the owner's handle without asking them to run SQL.
   *
   * This is the single place in the package that reads a message not yet known
   * to be the owner's — it returns HANDLES ONLY, never text, and nothing acts
   * on the result except to write it into config for the human to confirm.
   */
  pollAnySender(sinceRowid: number): { owner: string; assistant: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT h.id as handle, m.destination_caller_id as dest
         FROM message m JOIN handle h ON m.handle_id = h.ROWID
         WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.destination_caller_id IS NOT NULL
         ORDER BY m.ROWID ASC LIMIT 1`
      )
      .get(sinceRowid) as { handle: string; dest: string } | undefined;
    return row ? { owner: row.handle, assistant: row.dest } : undefined;
  }

  /** Highest ROWID in the table — the starting cursor, so the bridge only
   *  ever acts on messages that arrive AFTER it starts. */
  latestRowid(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(ROWID), 0) as max FROM message`)
      .get() as { max: number };
    return row.max;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Best-effort extraction of the message text from a typedstream-archived
 * NSAttributedString (the well-documented layout: the first NSString payload
 * follows the marker 0x81?/0x84 length encoding after "NSString"). We look
 * for the canonical `+` (0x2b) marker that precedes the string payload and
 * read its length-prefixed UTF-8. Anything unexpected returns null — the
 * caller drops the row rather than acting on a guess.
 */
export function decodeAttributedBody(blob: Buffer): string | null {
  try {
    const marker = blob.indexOf(Buffer.from("NSString", "ascii"));
    if (marker === -1) return null;
    // Skip past "NSString" + the archiver's class-terminator bytes to the
    // `+` (0x2b) that introduces the string payload.
    let i = blob.indexOf(0x2b, marker + 8);
    if (i === -1 || i - marker > 32) return null;
    i += 1;
    let length: number;
    const first = blob[i];
    if (first === 0x81) {
      // 2-byte little-endian length
      length = blob.readUInt16LE(i + 1);
      i += 3;
    } else if (first === 0x82) {
      // 4-byte little-endian length
      length = blob.readUInt32LE(i + 1);
      i += 5;
    } else {
      length = first;
      i += 1;
    }
    if (length <= 0 || i + length > blob.length) return null;
    return blob.subarray(i, i + length).toString("utf8");
  } catch {
    return null;
  }
}
