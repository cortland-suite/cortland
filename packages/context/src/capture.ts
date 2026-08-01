import type { AuditStore } from "@honeycrisp/governed";
import { runJxa } from "@honeycrisp/governed";
import { buildCaptureScript } from "./scripts.js";
import { parseAddress, type CapturedMessage, type ContextStore } from "./store.js";

const DEFAULT_BACKFILL_DAYS = 90;
const MAX_PER_MAILBOX = 1000;
const CAPTURE_TIMEOUT_MS = 300_000;

export interface CaptureDeps {
  audit: AuditStore;
  version: string;
  log: (message: string) => void;
  /** Injectable for tests. */
  runScript?: (script: string, timeoutMs: number) => Promise<string>;
  maxPerMailbox?: number;
}

export interface CaptureSummary {
  inbox: { seen: number; new: number };
  sent: { seen: number; new: number };
  people: number;
}

interface CapturedRow extends CapturedMessage {
  recipients?: string[];
}

/**
 * One incremental sweep: headers newer than the cursor from the unified inbox
 * and sent mailboxes. Bodies are never fetched — pointers, not copies. The
 * cursor overlaps 1s backward and dedupe happens on the messageId primary key.
 */
export async function captureOnce(
  store: ContextStore,
  deps: CaptureDeps
): Promise<CaptureSummary> {
  const exec = deps.runScript ?? runJxa;
  const max = deps.maxPerMailbox ?? MAX_PER_MAILBOX;
  const summary: CaptureSummary = {
    inbox: { seen: 0, new: 0 },
    sent: { seen: 0, new: 0 },
    people: 0,
  };

  for (const mailbox of ["inbox", "sent"] as const) {
    const cursorKey = `mail:${mailbox}`;
    const cursor = store.getCursor(cursorKey) ?? defaultBackfillIso();
    const sinceIso = new Date(new Date(cursor).getTime() - 1000).toISOString();
    const output = await exec(
      buildCaptureScript({
        mailbox,
        sinceIso,
        max,
        withRecipients: mailbox === "sent",
      }),
      CAPTURE_TIMEOUT_MS
    );
    const parsed = JSON.parse(output) as { total: number; rows: CapturedRow[] };
    let newest = cursor;
    for (const row of parsed.rows) {
      summary[mailbox].seen += 1;
      const isNew = store.upsertMessage(row);
      if (!isNew) continue;
      summary[mailbox].new += 1;
      if (row.date && row.date > newest) newest = row.date;
      if (mailbox === "inbox") {
        const { name, address } = parseAddress(row.sender);
        if (address) store.notePerson(address, name, "inbound", row.date);
      } else {
        const recipients = (row.recipients ?? []).filter(Boolean);
        store.addRecipients(row.messageId, recipients);
        for (const address of recipients) {
          store.notePerson(address, null, "outbound", row.date);
        }
      }
    }
    store.setCursor(cursorKey, newest);
  }

  summary.people = store.counts().people;
  deps.audit.record({
    tool: "context_capture",
    scope: "Mail→ContextStore",
    mode: "write-safe",
    undo: "none",
    args: {
      inboxSeen: summary.inbox.seen,
      inboxNew: summary.inbox.new,
      sentSeen: summary.sent.seen,
      sentNew: summary.sent.new,
    },
    dryRun: false,
    outcome: "ok",
    toolVersion: deps.version,
  });
  deps.log(
    `capture: inbox +${summary.inbox.new}/${summary.inbox.seen}, ` +
      `sent +${summary.sent.new}/${summary.sent.seen}, people ${summary.people}`
  );
  return summary;
}

function defaultBackfillIso(): string {
  return new Date(Date.now() - DEFAULT_BACKFILL_DAYS * 86_400_000).toISOString();
}
