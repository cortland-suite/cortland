import { z } from "zod";
import { AuditStore, defaultDataDir, defineTool } from "@cortland/governed";
import type { GovernedToolDef } from "@cortland/governed";
import { loadBridgeConfig, type BridgeConfig } from "./config.js";
import { OwnerSender, type SendResult } from "./send.js";

export const VERSION = "0.2.0";

const HOUR_MS = 3_600_000;

/**
 * notify_owner — the tool that lets an agent start a conversation with you.
 *
 * Everything else in this package is reactive: you text the bridge, the
 * bridge answers. That left a real gap. An agent working unattended — a
 * watcher, an overnight job, a pipeline — had no governed way to reach the
 * human, so the only path was to import OwnerSender directly and skip the
 * framework entirely (which is exactly what the first real caller did:
 * a stock monitor that texted its owner with no audit row to show for it).
 * A guarantee nothing offers a legitimate path around is a guarantee people
 * route around.
 *
 * Why write-safe and not write-gated, when the house rule gates anything
 * outward-facing: this tool cannot face outward. There is exactly one
 * possible recipient — the owner handle from config — and no argument can
 * name a different one. A message to you is not an outward action, it IS
 * the review loop; gating it behind an approval you would receive by the
 * same channel it is asking to use is a circle, not a safeguard. The tier
 * rests entirely on the recipient being unaddressable, so `text` is the
 * only content argument and `source` is a label, not free text.
 */

export interface NotifyOwnerDeps {
  loadConfig: () => BridgeConfig;
  /** Built once per process: the sender carries law 4's in-memory bucket. */
  sender: (config: BridgeConfig) => { send: (text: string) => Promise<SendResult> };
  /** Successful notify_owner sends at or after `sinceIso`, from the audit log. */
  recentSends: (sinceIso: string) => number;
  now: () => number;
}

/** A label for the caller, not a message: it is prefixed to text you read on
 *  a phone, so it stays a slug and can never carry a sentence of its own. */
const SOURCE = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, "source must be a short lowercase slug")
  .optional();

export function composeMessage(text: string, source?: string): string {
  return source ? `[${source}] ${text}` : text;
}

export function createNotifyOwnerTool(
  overrides: Partial<NotifyOwnerDeps> = {}
): Readonly<GovernedToolDef<{ text: string; source?: string }>> {
  const deps = { ...lazyDefaults(), ...overrides };

  return defineTool<{ text: string; source?: string }>({
    name: "notify_owner",
    description:
      "Send a short iMessage to the owner of this Mac — the one person this " +
      "tool can reach. Use it to report something the human asked to be told " +
      "about: a job finished, a watcher fired, a run needs attention. The " +
      "recipient comes from local config and cannot be set by an argument, so " +
      "this cannot message anyone else.",
    scope: "Messages",
    mode: "write-safe",
    // An iMessage cannot be unsent. "compensate" would imply a correcting
    // action exists; sending a second text is not undoing the first one.
    undo: "none",
    redact: ["text"],
    inputSchema: {
      text: z.string().min(1).max(1000),
      source: SOURCE,
    },
    handler: async (args, ctx) => {
      const config = deps.loadConfig();
      const cap = config.maxPerHour;
      const since = new Date(deps.now() - HOUR_MS).toISOString();
      const used = deps.recentSends(since);
      if (used >= cap) {
        // Fail closed and loudly. Going quiet would be indistinguishable
        // from nothing having happened, which is the one failure mode a
        // notification tool must never have.
        throw new Error(
          `rate cap reached: ${used}/${cap} notifications in the last hour (law 4). ` +
            `Nothing was sent.`
        );
      }
      const result = await deps.sender(config).send(composeMessage(args.text, args.source));
      if (!result.ok) throw new Error(result.detail ?? "send failed");
      return {
        content:
          `Sent to the owner handle from config (${used + 1}/${cap} this hour).\n` +
          `${ctx.provenance}`,
      };
    },
  });
}

export const imessageTools: Array<Readonly<GovernedToolDef<any>>> = [
  createNotifyOwnerTool(),
];

/** Real wiring, built on first use so importing this module opens nothing. */
function lazyDefaults(): NotifyOwnerDeps {
  const dataDir = defaultDataDir("cortland");
  let audit: AuditStore | undefined;
  let sender: { send: (text: string) => Promise<SendResult> } | undefined;
  return {
    loadConfig: () => loadBridgeConfig(dataDir),
    sender: (config) => (sender ??= new OwnerSender(config.ownerHandles[0], config.maxPerHour)),
    recentSends: (sinceIso) => (audit ??= new AuditStore(dataDir)).countSince("notify_owner", sinceIso),
    now: () => Date.now(),
  };
}
