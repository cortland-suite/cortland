import type { AuditStore } from "@honeycrisp/governed";
import type { ContextStore } from "./store.js";

/**
 * Retention (NOTES Q23). The store holds derived rows and pointers, so age
 * limits are about keeping the index honest and small, not about protecting
 * content (there is none). Defaults, decided 2026-07-30:
 *
 *   - messages / events / commitments older than `retentionDays` (default 365)
 *     are pruned on capture; `"retentionDays": 0` keeps everything forever.
 *   - people are NEVER pruned: they are tiny aggregates, and "who is this"
 *     stays useful long after the messages that established it.
 *   - judgments are NEVER pruned: they are human decisions. Deleting a human's
 *     recorded judgment is not the machine's call at any age.
 *   - cursors are bookkeeping, not history — exempt.
 *
 * Dangling pointers (message deleted in Mail) are a separate concern, already
 * handled at capture time.
 */

export interface PruneSummary {
  messages: number;
  events: number;
  commitments: number;
}

export function pruneExpired(
  store: ContextStore,
  retentionDays: number,
  audit: AuditStore,
  version: string
): PruneSummary | null {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
  const cutoffIso = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const summary = store.pruneOlderThan(cutoffIso);
  const total = summary.messages + summary.events + summary.commitments;
  if (total > 0) {
    audit.record({
      tool: "context_prune",
      scope: "ContextStore",
      mode: "write-safe",
      undo: "none",
      args: { retentionDays, cutoffIso, ...summary },
      dryRun: false,
      outcome: "ok",
      toolVersion: version,
    });
  }
  return summary;
}
