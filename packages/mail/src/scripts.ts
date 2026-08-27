/**
 * Pure JXA script builders. All user-supplied values are embedded via
 * JSON.stringify — JSON is valid JXA source, so there is no way for a crafted
 * subject or mailbox name to escape its string literal and become code.
 *
 * Search strategy (NOTES Q6, settled 2026-07-30): AppleScript-engine `whose`
 * header queries are sub-second; full-text is NOT attempted here (Tier 2 is
 * Spotlight behind Full Disk Access, separate module when built).
 */

const PRELUDE = `
const Mail = Application("Mail");
if (!Mail.running()) { Mail.launch(); }
function resolveMailboxes(accountName, mailboxName) {
  if (accountName) {
    const matches = Mail.accounts.whose({ name: accountName })();
    if (matches.length === 0) throw new Error("No account named: " + accountName);
    const acct = matches[0];
    if (!mailboxName || mailboxName.toLowerCase() === "inbox") {
      const inbox = acct.mailboxes().find(b => /^inbox$/i.test(b.name()));
      if (!inbox) throw new Error("No inbox mailbox in account: " + accountName);
      return [inbox];
    }
    const boxes = acct.mailboxes.whose({ name: mailboxName })();
    if (boxes.length === 0) throw new Error("No mailbox '" + mailboxName + "' in account: " + accountName);
    return [boxes[0]];
  }
  if (!mailboxName || mailboxName.toLowerCase() === "inbox") return [Mail.inbox];
  if (mailboxName.toLowerCase() === "sent") return [Mail.sentMailbox];
  if (mailboxName.toLowerCase() === "drafts") return [Mail.draftsMailbox];
  const out = [];
  Mail.accounts().forEach(a => {
    a.mailboxes.whose({ name: mailboxName })().forEach(b => out.push(b));
  });
  if (out.length === 0) throw new Error("No mailbox named: " + mailboxName);
  return out;
}
function boxLabel(box) {
  try { return box.name(); } catch (e) { return "inbox"; }
}
function collectHeaders(coll, label) {
  const ids = coll.messageId();
  const subjects = coll.subject();
  const senders = coll.sender();
  const dates = coll.dateReceived();
  const reads = coll.readStatus();
  const rows = [];
  for (let i = 0; i < ids.length; i++) {
    rows.push({
      messageId: ids[i],
      subject: subjects[i],
      from: senders[i],
      date: dates[i] ? dates[i].toISOString() : null,
      read: reads[i],
      mailbox: label
    });
  }
  return rows;
}
function findMessage(messageId, accountName, mailboxName) {
  const candidates = [];
  if (accountName || mailboxName) {
    resolveMailboxes(accountName, mailboxName).forEach(b => candidates.push(b));
  } else {
    candidates.push(Mail.inbox, Mail.sentMailbox, Mail.draftsMailbox);
    Mail.accounts().forEach(a => a.mailboxes().forEach(b => candidates.push(b)));
  }
  for (const box of candidates) {
    const hits = box.messages.whose({ messageId: messageId })();
    if (hits.length > 0) return { msg: hits[0], box: box };
  }
  throw new Error("No message found with messageId: " + messageId);
}
`;

export interface SearchParams {
  subject?: string;
  from?: string;
  account?: string;
  mailbox?: string;
  since?: string;
  before?: string;
  limit: number;
}

export function buildSearchScript(p: SearchParams): string {
  const conds: string[] = [];
  if (p.subject) conds.push(`{ subject: { _contains: ${JSON.stringify(p.subject)} } }`);
  if (p.from) conds.push(`{ sender: { _contains: ${JSON.stringify(p.from)} } }`);
  if (p.since) conds.push(`{ dateReceived: { _greaterThan: new Date(${JSON.stringify(p.since)}) } }`);
  if (p.before) conds.push(`{ dateReceived: { _lessThan: new Date(${JSON.stringify(p.before)}) } }`);
  const filter =
    conds.length === 0 ? null : conds.length === 1 ? conds[0] : `{ _and: [${conds.join(", ")}] }`;
  return `${PRELUDE}
const boxes = resolveMailboxes(${JSON.stringify(p.account ?? null)}, ${JSON.stringify(p.mailbox ?? null)});
let rows = [];
for (const box of boxes) {
  const coll = ${filter ? `box.messages.whose(${filter})` : "box.messages"};
  rows = rows.concat(collectHeaders(coll, boxLabel(box)));
}
rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
JSON.stringify({ total: rows.length, returned: Math.min(rows.length, ${p.limit}), messages: rows.slice(0, ${p.limit}) }, null, 1);
`;
}

export function buildListAccountsScript(): string {
  return `${PRELUDE}
const rows = Mail.accounts().map(a => ({
  name: a.name(),
  emails: a.emailAddresses(),
  enabled: a.enabled(),
  mailboxes: a.mailboxes().map(b => b.name())
}));
JSON.stringify(rows, null, 1);
`;
}

export interface LocateParams {
  messageId: string;
  account?: string;
  mailbox?: string;
}

const BODY_CAP = 100_000;

export function buildReadScript(p: LocateParams): string {
  return `${PRELUDE}
const found = findMessage(${JSON.stringify(p.messageId)}, ${JSON.stringify(p.account ?? null)}, ${JSON.stringify(p.mailbox ?? null)});
const m = found.msg;
const body = (m.content() || "").toString();
JSON.stringify({
  messageId: m.messageId(),
  subject: m.subject(),
  from: m.sender(),
  to: m.toRecipients().map(r => r.address()),
  cc: m.ccRecipients().map(r => r.address()),
  date: m.dateReceived() ? m.dateReceived().toISOString() : null,
  read: m.readStatus(),
  flagged: m.flaggedStatus(),
  mailbox: boxLabel(found.box),
  truncated: body.length > ${BODY_CAP},
  body: body.slice(0, ${BODY_CAP})
}, null, 1);
`;
}

export function buildThreadScript(p: LocateParams): string {
  return `${PRELUDE}
function normSubject(s) {
  s = (s || "");
  while (/^\\s*(re|fw|fwd)\\s*:/i.test(s)) s = s.replace(/^\\s*(re|fw|fwd)\\s*:/i, "");
  return s.trim().toLowerCase();
}
const found = findMessage(${JSON.stringify(p.messageId)}, ${JSON.stringify(p.account ?? null)}, ${JSON.stringify(p.mailbox ?? null)});
const norm = normSubject(found.msg.subject());
if (!norm) throw new Error("Cannot thread a message with an empty subject");
// The index-backed contains query narrows candidates cheaply; exact normalized
// equality then rejects unrelated subjects that merely contain the phrase.
let rows = [];
for (const box of [Mail.inbox, Mail.sentMailbox]) {
  const coll = box.messages.whose({ subject: { _contains: norm } });
  rows = rows.concat(collectHeaders(coll, boxLabel(box)));
}
rows = rows.filter(r => normSubject(r.subject) === norm);
const seen = {};
rows = rows.filter(r => (seen[r.messageId] ? false : (seen[r.messageId] = true)));
rows.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
JSON.stringify({ normalizedSubject: norm, count: rows.length, messages: rows }, null, 1);
`;
}

export interface DraftParams {
  account: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  /** When set, the draft is a reply to this message (subject and recipient come from it). */
  replyToMessageId?: string;
}

export function buildDraftScript(p: DraftParams): string {
  const accountCheck = `
const matches = Mail.accounts.whose({ name: ${JSON.stringify(p.account)} })();
if (matches.length === 0) throw new Error("No account named: " + ${JSON.stringify(p.account)});
const senderAddress = matches[0].emailAddresses()[0];
if (!senderAddress) {
  throw new Error("Account " + ${JSON.stringify(p.account)} + " exposes no email addresses to scripting (common for iCloud accounts) — draft from a different account, or add the address in Mail's account settings.");
}`;
  const recipients = `
${JSON.stringify(p.to ?? [])}.forEach(a => msg.toRecipients.push(Mail.ToRecipient({ address: a })));
${JSON.stringify(p.cc ?? [])}.forEach(a => msg.ccRecipients.push(Mail.CcRecipient({ address: a })));
${JSON.stringify(p.bcc ?? [])}.forEach(a => msg.bccRecipients.push(Mail.BccRecipient({ address: a })));`;

  if (p.replyToMessageId) {
    return `${PRELUDE}${accountCheck}
const found = findMessage(${JSON.stringify(p.replyToMessageId)}, null, null);
const msg = Mail.reply(found.msg, { openingWindow: false, replyToAll: false });
msg.sender = senderAddress;
msg.content = ${JSON.stringify(p.body)};
msg.visible = false;${recipients}
msg.save();
JSON.stringify({ saved: true, reply: true, sender: senderAddress, subject: msg.subject() });
`;
  }
  return `${PRELUDE}${accountCheck}
const msg = Mail.OutgoingMessage({
  subject: ${JSON.stringify(p.subject ?? "")},
  content: ${JSON.stringify(p.body)},
  visible: false,
  sender: senderAddress
});
Mail.outgoingMessages.push(msg);${recipients}
msg.save();
JSON.stringify({ saved: true, reply: false, sender: senderAddress, subject: ${JSON.stringify(p.subject ?? "")} });
`;
}

export function buildSendScript(p: DraftParams): string {
  if (!p.to || p.to.length === 0) {
    throw new Error("buildSendScript requires to");
  }
  if (!p.subject) {
    throw new Error("buildSendScript requires subject");
  }
  const accountCheck = `
const matches = Mail.accounts.whose({ name: ${JSON.stringify(p.account)} })();
if (matches.length === 0) throw new Error("No account named: " + ${JSON.stringify(p.account)});
const senderAddress = matches[0].emailAddresses()[0];
if (!senderAddress) {
  throw new Error("Account " + ${JSON.stringify(p.account)} + " exposes no email addresses to scripting (common for iCloud accounts) — send from a different account, or add the address in Mail's account settings.");
}`;
  const recipients = `
${JSON.stringify(p.to ?? [])}.forEach(a => msg.toRecipients.push(Mail.ToRecipient({ address: a })));
${JSON.stringify(p.cc ?? [])}.forEach(a => msg.ccRecipients.push(Mail.CcRecipient({ address: a })));
${JSON.stringify(p.bcc ?? [])}.forEach(a => msg.bccRecipients.push(Mail.BccRecipient({ address: a })));`;
  return `${PRELUDE}${accountCheck}
const msg = Mail.OutgoingMessage({
  subject: ${JSON.stringify(p.subject)},
  content: ${JSON.stringify(p.body)},
  visible: false,
  sender: senderAddress
});
Mail.outgoingMessages.push(msg);${recipients}
msg.send();
JSON.stringify({ sent: true, sender: senderAddress, subject: ${JSON.stringify(p.subject)} });
`;
}

export function buildGetFlagsScript(p: LocateParams): string {
  return `${PRELUDE}
const found = findMessage(${JSON.stringify(p.messageId)}, ${JSON.stringify(p.account ?? null)}, ${JSON.stringify(p.mailbox ?? null)});
JSON.stringify({
  messageId: ${JSON.stringify(p.messageId)},
  mailbox: boxLabel(found.box),
  read: found.msg.readStatus(),
  flagged: found.msg.flaggedStatus()
});
`;
}

export interface MarkParams extends LocateParams {
  read?: boolean;
  flagged?: boolean;
}

export function buildMarkScript(p: MarkParams): string {
  return `${PRELUDE}
const found = findMessage(${JSON.stringify(p.messageId)}, ${JSON.stringify(p.account ?? null)}, ${JSON.stringify(p.mailbox ?? null)});
${p.read !== undefined ? `found.msg.readStatus = ${JSON.stringify(p.read)};` : ""}
${p.flagged !== undefined ? `found.msg.flaggedStatus = ${JSON.stringify(p.flagged)};` : ""}
JSON.stringify({ done: true, read: found.msg.readStatus(), flagged: found.msg.flaggedStatus() });
`;
}

export interface MoveParams extends LocateParams {
  account: string;
  toMailbox: string;
}

export function buildMoveScript(p: MoveParams): string {
  return `${PRELUDE}
const found = findMessage(${JSON.stringify(p.messageId)}, ${JSON.stringify(p.account)}, ${JSON.stringify(p.mailbox ?? null)});
const target = resolveMailboxes(${JSON.stringify(p.account)}, ${JSON.stringify(p.toMailbox)})[0];
Mail.move(found.msg, { to: target });
JSON.stringify({ done: true, movedTo: target.name() });
`;
}
