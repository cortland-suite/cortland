import { z } from "zod";
import { defineTool, type AuditStore } from "@honeycrisp/governed";
import { generateBriefing } from "./briefing.js";
import { captureOnce } from "./capture.js";
import type { ContextStore } from "./store.js";

/**
 * The serve layer, M1. Scope is "ContextStore", NOT "Mail": these tools read
 * the derived store only. Every answer cites messageIds — the pointers — and
 * consumers with Mail access fetch content through honeycrisp-mail. No Mail
 * permission, no content: the serve layer inherits source permissions by
 * construction.
 */
export function makeContextTools(store: ContextStore, audit: AuditStore, version: string) {
  const contextChanges = defineTool({
    name: "context_changes",
    description:
      "What changed since a point in time: new mail volume, senders, newly seen " +
      "people, active subjects. Deterministic, from the local context store. " +
      "Citations are Message-IDs — fetch content via honeycrisp-mail if permitted.",
    scope: "ContextStore",
    mode: "read",
    undo: "none",
    inputSchema: {
      hours: z.number().int().min(1).max(720).default(24).describe("Look-back window"),
      since: z.string().datetime().optional().describe("Explicit ISO start (overrides hours)"),
    },
    handler: async (args: { hours?: number; since?: string }) => {
      const since =
        args.since ?? new Date(Date.now() - (args.hours ?? 24) * 3_600_000).toISOString();
      return { content: JSON.stringify(store.changesSince(since), null, 1) };
    },
  });

  const contextPerson = defineTool({
    name: "context_person",
    description:
      "Profile a person from the context store: interaction counts, first/last " +
      "seen, recent message pointers (headers only).",
    scope: "ContextStore",
    mode: "read",
    undo: "none",
    inputSchema: {
      query: z.string().min(2).describe("Name fragment or email address"),
    },
    handler: async (args: { query: string }) => {
      const matches = store.findPeople(args.query);
      return {
        content: JSON.stringify(
          matches.length > 0
            ? { matches }
            : { matches: [], note: "No one matching that query in the store yet." },
          null,
          1
        ),
      };
    },
  });

  const contextCaptureNow = defineTool({
    name: "context_capture_now",
    description:
      "Run one incremental Mail capture sweep into the context store (headers " +
      "only — bodies are never stored). Normally the daemon's job; useful for " +
      "catching up on demand.",
    scope: "Mail→ContextStore",
    mode: "write-safe",
    undo: "none",
    inputSchema: {
      maxPerMailbox: z.number().int().min(10).max(5000).default(1000),
    },
    handler: async (args: { maxPerMailbox?: number }) => {
      const summary = await captureOnce(store, {
        audit,
        version,
        log: () => {},
        maxPerMailbox: args.maxPerMailbox,
      });
      return { content: JSON.stringify(summary, null, 1) };
    },
  });

  const contextBrief = defineTool({
    name: "context_brief",
    description:
      "Generate today's briefing from the context store: meetings with " +
      "correlated threads, changes since yesterday, first-time senders. " +
      "Deterministic; every claim cites pointers.",
    scope: "ContextStore",
    mode: "read",
    undo: "none",
    inputSchema: {},
    handler: async () => ({
      // Serve stays deterministic (no provider): a read tool must not quietly
      // spend model calls. The scheduled `brief` CLI runs Layer 1.
      content: await generateBriefing(store, { version }),
    }),
  });

  return [contextChanges, contextPerson, contextBrief, contextCaptureNow];
}
