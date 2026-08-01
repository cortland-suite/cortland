/**
 * Capture-oriented JXA builders. Same safety rule as honeycrisp-mail: every
 * dynamic value is embedded via JSON.stringify, so nothing user-controlled can
 * escape its string literal. HEADERS ONLY — bodies are never fetched here.
 */

export interface CaptureParams {
  mailbox: "inbox" | "sent";
  sinceIso: string;
  max: number;
  /** Fetch to-recipients per message (outbound people graph). Sent only —
   * costs one Apple Event per message, so it's capped by `max`. */
  withRecipients: boolean;
}

export function buildCaptureScript(p: CaptureParams): string {
  return `
const Mail = Application("Mail");
if (!Mail.running()) { Mail.launch(); }
const box = ${p.mailbox === "inbox" ? "Mail.inbox" : "Mail.sentMailbox"};
const coll = box.messages.whose({ dateReceived: { _greaterThan: new Date(${JSON.stringify(
    p.sinceIso
  )}) } });
const ids = coll.messageId();
const subjects = coll.subject();
const senders = coll.sender();
const dates = coll.dateReceived();
const reads = coll.readStatus();
const total = ids.length;
const rows = [];
const start = Math.max(0, total - ${p.max}); // newest window when over cap
for (let i = start; i < total; i++) {
  rows.push({
    messageId: ids[i],
    subject: subjects[i],
    sender: senders[i],
    date: dates[i] ? dates[i].toISOString() : null,
    read: reads[i],
    mailbox: ${JSON.stringify(p.mailbox)}
  });
}
${
  p.withRecipients
    ? `const msgs = coll();
for (let i = start; i < total; i++) {
  try {
    rows[i - start].recipients = msgs[i].toRecipients().map(r => r.address());
  } catch (e) { rows[i - start].recipients = []; }
}`
    : ""
}
JSON.stringify({ total: total, returned: rows.length, rows: rows });
`;
}
