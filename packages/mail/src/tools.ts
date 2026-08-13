import { z } from "zod";
import { defineTool, runJxa } from "@cortland/governed";
import { FDA_INSTRUCTIONS, hasFullDiskAccess, searchFulltext } from "./fulltext.js";
import {
  buildDraftScript,
  buildGetFlagsScript,
  buildListAccountsScript,
  buildMarkScript,
  buildMoveScript,
  buildReadScript,
  buildSearchScript,
  buildThreadScript,
} from "./scripts.js";

/**
 * The Mail tool surface, v1 (docs/02).
 *
 * There is deliberately NO mail_send tool. The outward path is
 * mail_create_draft → the human opens Mail.app → the human hits send.
 * The gate you never build cannot be bypassed.
 */

/**
 * Cold-start allowance: the first scripting call after Mail.app launches can take
 * far longer than steady state (one observed 90s+ on first contact, ~1s warm).
 * The prelude launches Mail if needed; this wrapper gives it room and turns a
 * timeout into an instruction instead of a mystery.
 */
const MAIL_TIMEOUT_MS = 120_000;
async function runMail(script: string): Promise<string> {
  try {
    return await runJxa(script, MAIL_TIMEOUT_MS);
  } catch (err) {
    if (String(err).includes("timed out")) {
      throw new Error(
        `Mail did not respond within ${MAIL_TIMEOUT_MS / 1000}s. If Mail.app was ` +
          `just launched (cold start), retry once — subsequent calls are fast.`
      );
    }
    throw err;
  }
}

const locateShape = {
  messageId: z.string().min(1).describe("RFC Message-ID (from mail_search results)"),
  account: z.string().optional().describe("Account name to narrow the lookup"),
  mailbox: z.string().optional().describe("Mailbox name to narrow the lookup"),
};

export const mailListAccounts = defineTool({
  name: "mail_list_accounts",
  description: "List Mail accounts with their addresses and mailboxes.",
  scope: "Mail",
  mode: "read",
  undo: "none",
  inputSchema: {},
  handler: async () => ({ content: await runMail(buildListAccountsScript()) }),
});

export const mailSearch = defineTool({
  name: "mail_search",
  description:
    "Header search (subject/sender/date) across a mailbox. Fast, index-backed. " +
    "Full-text body search is not available in this tier.",
  scope: "Mail",
  mode: "read",
  undo: "none",
  inputSchema: {
    subject: z.string().optional().describe("Match in subject"),
    from: z.string().optional().describe("Match in sender (name or address)"),
    account: z.string().optional().describe("Limit to one account"),
    mailbox: z.string().optional().describe("Mailbox name (default: inbox)"),
    since: z.string().datetime({ offset: true, local: true }).optional().describe("Received after, ISO 8601"),
    before: z.string().datetime({ offset: true, local: true }).optional().describe("Received before, ISO 8601"),
    limit: z.number().int().min(1).max(100).default(20),
  },
  handler: async (args: {
    subject?: string;
    from?: string;
    account?: string;
    mailbox?: string;
    since?: string;
    before?: string;
    limit?: number;
  }) => ({
    content: await runMail(buildSearchScript({ ...args, limit: args.limit ?? 20 })),
  }),
});

export const mailRead = defineTool({
  name: "mail_read",
  description: "Read one message in full by Message-ID (body arrives fenced).",
  scope: "Mail",
  mode: "read",
  undo: "none",
  inputSchema: locateShape,
  handler: async (args: { messageId: string; account?: string; mailbox?: string }) => ({
    content: await runMail(buildReadScript(args)),
  }),
});

export const mailThread = defineTool({
  name: "mail_thread",
  description:
    "Naive conversation view: messages in inbox+sent sharing the normalized subject.",
  scope: "Mail",
  mode: "read",
  undo: "none",
  inputSchema: locateShape,
  handler: async (args: { messageId: string; account?: string; mailbox?: string }) => ({
    content: await runMail(buildThreadScript(args)),
  }),
});

export const mailCreateDraft = defineTool({
  name: "mail_create_draft",
  description:
    "Create a draft in Mail's Drafts mailbox. The draft is the END of this tool's " +
    "reach: sending is a human action in Mail.app. Account is required — the " +
    "writing identity is never guessed.",
  scope: "Mail",
  mode: "write-safe",
  undo: "compensate",
  redact: ["body"],
  inputSchema: {
    account: z.string().min(1).describe("Account name to draft from (required)"),
    to: z
      .array(z.string().min(3))
      .optional()
      .describe("To addresses (required unless replying)"),
    cc: z.array(z.string().min(3)).optional(),
    bcc: z.array(z.string().min(3)).optional(),
    subject: z.string().optional().describe("Required unless replying (reply keeps Re: subject)"),
    body: z.string().min(1),
    replyToMessageId: z
      .string()
      .optional()
      .describe("Draft a reply to this Message-ID; recipient and subject derive from it"),
  },
  handler: async (
    args: {
      account: string;
      to?: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      body: string;
      replyToMessageId?: string;
    },
    ctx
  ) => {
    if (!args.replyToMessageId) {
      if (!args.to || args.to.length === 0) {
        throw new Error("to is required when not replying");
      }
      if (!args.subject) {
        throw new Error("subject is required when not replying");
      }
    }
    const body = `${args.body}\n\n--\n${ctx.provenance}`;
    const result = JSON.parse(await runMail(buildDraftScript({ ...args, body })));
    return {
      content:
        `${result.reply ? "Reply draft" : "Draft"} saved to Drafts ` +
        `(${result.sender}, subject: ${JSON.stringify(result.subject)}). ` +
        `Open Mail.app to review and send.`,
    };
  },
});

export const mailMark = defineTool({
  name: "mail_mark",
  description: "Set read/flagged status on a message.",
  scope: "Mail",
  mode: "write-gated",
  undo: "native",
  inputSchema: {
    ...locateShape,
    read: z.boolean().optional().describe("Set read status"),
    flagged: z.boolean().optional().describe("Set flagged status"),
  },
  planUndo: async (args: { messageId: string; account?: string; mailbox?: string }) => {
    const current = JSON.parse(await runMail(buildGetFlagsScript(args)));
    return { restore: "mail_mark", args: current };
  },
  preview: (args: { messageId: string; read?: boolean; flagged?: boolean }) =>
    `Would set ${[
      args.read !== undefined ? `read=${args.read}` : null,
      args.flagged !== undefined ? `flagged=${args.flagged}` : null,
    ]
      .filter(Boolean)
      .join(", ")} on message ${args.messageId}.`,
  handler: async (args: {
    messageId: string;
    account?: string;
    mailbox?: string;
    read?: boolean;
    flagged?: boolean;
  }) => {
    if (args.read === undefined && args.flagged === undefined) {
      throw new Error("Provide at least one of read/flagged");
    }
    return { content: await runMail(buildMarkScript(args)) };
  },
});

export const mailMove = defineTool({
  name: "mail_move",
  description: "Move a message to another mailbox in the same account.",
  scope: "Mail",
  mode: "write-gated",
  undo: "native",
  inputSchema: {
    messageId: locateShape.messageId,
    account: z.string().min(1).describe("Account owning both mailboxes"),
    mailbox: z.string().optional().describe("Current mailbox, if known"),
    toMailbox: z.string().min(1).describe("Destination mailbox name"),
  },
  planUndo: async (args: { messageId: string; account: string; mailbox?: string }) => {
    const current = JSON.parse(await runMail(buildGetFlagsScript(args)));
    return {
      restore: "mail_move",
      args: {
        messageId: args.messageId,
        account: args.account,
        toMailbox: current.mailbox,
      },
    };
  },
  preview: (args: { messageId: string; toMailbox: string }) =>
    `Would move message ${args.messageId} to mailbox "${args.toMailbox}".`,
  handler: async (args: {
    messageId: string;
    account: string;
    mailbox?: string;
    toMailbox: string;
  }) => ({ content: await runMail(buildMoveScript(args)) }),
});

export const mailSearchFulltext = defineTool({
  name: "mail_search_fulltext",
  description:
    "Full-text search of message bodies via Spotlight (Tier 2 — requires Full " +
    "Disk Access; refuses with instructions when absent rather than returning " +
    "silently-empty results). Returns headers; fetch bodies with mail_read.",
  scope: "Mail",
  mode: "read",
  undo: "none",
  inputSchema: {
    text: z.string().min(2).describe("Text to find in message bodies"),
    limit: z.number().int().min(1).max(50).default(15),
  },
  handler: async (args: { text: string; limit?: number }) => {
    if (!hasFullDiskAccess()) {
      throw new Error(FDA_INSTRUCTIONS);
    }
    const result = await searchFulltext(args.text, args.limit ?? 15);
    return { content: JSON.stringify(result, null, 1) };
  },
});

export const mailTools = [
  mailListAccounts,
  mailSearch,
  mailSearchFulltext,
  mailRead,
  mailThread,
  mailCreateDraft,
  mailMark,
  mailMove,
];
